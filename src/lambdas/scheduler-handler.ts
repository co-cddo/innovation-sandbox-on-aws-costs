import type { EventBridgeEvent } from "aws-lambda";
import { randomInt } from "node:crypto";
import {
  SchedulerClient,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
  ActionAfterCompletion,
  ConflictException,
} from "@aws-sdk/client-scheduler";
import {
  LeaseTerminatedEventSchema,
  type LeaseTerminatedEvent,
} from "../lib/schemas.js";
import { requireEnv, parseIntEnv } from "../lib/env-utils.js";
import { createLogger } from "../lib/logger.js";

const schedulerClient = new SchedulerClient({});

// Validate required environment variables at module load
const SCHEDULER_GROUP = requireEnv("SCHEDULER_GROUP", {
  component: "Scheduler Lambda",
  purpose: "to create EventBridge schedules for cost collection",
});
const SCHEDULER_ROLE_ARN = requireEnv("SCHEDULER_ROLE_ARN", {
  component: "Scheduler Lambda",
  purpose: "to authorize EventBridge Scheduler to invoke Cost Collector Lambda",
});
const COST_COLLECTOR_LAMBDA_ARN = requireEnv("COST_COLLECTOR_LAMBDA_ARN", {
  component: "Scheduler Lambda",
  purpose: "to set as target for EventBridge schedules",
});

// Parse and validate DELAY_HOURS with default and bounds
// DELAY_HOURS: 0-720 (max 30 days) - time to wait after lease end before collecting costs
const DELAY_HOURS = parseIntEnv("DELAY_HOURS", 24, 0, 720);

/**
 * Maximum jitter in minutes to spread out schedule execution times.
 * Prevents thundering herd when multiple leases terminate simultaneously.
 */
const SCHEDULE_JITTER_MAX_MINUTES = 30;

/**
 * Flexible time window for EventBridge Scheduler execution.
 * Allows AWS to execute the schedule within this window for improved reliability.
 */
const SCHEDULER_FLEXIBLE_WINDOW_MINUTES = 5;

/**
 * Formats a Date object to EventBridge Scheduler at() expression format.
 * Format: at(yyyy-mm-ddThh:mm:ss)
 */
function formatScheduleExpression(date: Date): string {
  const iso = date.toISOString();
  // Remove milliseconds and Z suffix, wrap in at()
  return `at(${iso.slice(0, 19)})`;
}

/**
 * Generates a random jitter between 0 and maxMinutes using cryptographic randomness.
 * Uses crypto.randomInt() for better distribution at scale to prevent clustering.
 */
function getRandomJitterMs(maxMinutes: number): number {
  const maxMs = maxMinutes * 60 * 1000;
  return maxMs > 0 ? randomInt(maxMs) : 0;
}

/**
 * UUID v4 format regex.
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * where x is any hex digit [0-9a-f] and y is one of [8, 9, a, b]
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * EventBridge Scheduler name length limit.
 * https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html
 */
const SCHEDULER_NAME_MAX_LENGTH = 64;

/**
 * Sanitizes a schedule name to ensure it only contains valid characters.
 * EventBridge Scheduler names must match: [\.\-_A-Za-z0-9]+
 * Consecutive invalid characters are collapsed into a single hyphen.
 */
function sanitizeScheduleName(name: string): string {
  return name.replace(/[^.\-_A-Za-z0-9]/g, "-").replace(/-+/g, "-");
}

/**
 * Sanitizes a string for safe logging by removing ANSI escape codes and non-ASCII characters.
 * This prevents:
 * - ANSI escape code injection that could manipulate terminal output or logs
 * - Homograph attacks using look-alike characters from non-Latin scripts
 * - Control characters that could corrupt log files or monitoring systems
 *
 * @param input - The string to sanitize
 * @returns Sanitized string containing only ASCII printable characters (0x20-0x7E)
 */
function sanitizeForLog(input: string): string {
  // Remove ANSI escape codes (e.g., \x1B[31m for red text)
  const noAnsi = input.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  // Remove non-ASCII characters (keep only printable ASCII: space through tilde)
  return noAnsi.replace(/[^\x20-\x7E]/g, "");
}

/**
 * Validates UUID format and checks that the resulting schedule name will be valid.
 * Throws descriptive errors for:
 * - Invalid UUID v4 format
 * - Schedule name exceeding EventBridge Scheduler's 64 character limit
 *
 * @param uuid - The UUID string to validate
 * @throws {Error} If UUID format is invalid or schedule name would be too long
 */
function validateLeaseUuid(uuid: string): void {
  if (!UUID_V4_REGEX.test(uuid)) {
    throw new Error(
      `Invalid lease UUID format: "${sanitizeForLog(uuid)}". Expected UUID v4 format (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)`
    );
  }

  const scheduleName = `lease-costs-${uuid}`;
  if (scheduleName.length > SCHEDULER_NAME_MAX_LENGTH) {
    throw new Error(
      `Schedule name too long: "${sanitizeForLog(scheduleName)}" (${scheduleName.length} chars). ` +
        `EventBridge Scheduler names must be ≤${SCHEDULER_NAME_MAX_LENGTH} characters`
    );
  }
}

export async function handler(
  event: EventBridgeEvent<"LeaseTerminated", LeaseTerminatedEvent["detail"]>
): Promise<void> {
  // Reconstruct full event for validation
  const fullEvent = {
    "detail-type": event["detail-type"],
    source: event.source,
    detail: event.detail,
  };

  // Validate event against schema early to reject malformed events
  // This prevents denial-of-wallet attacks from malicious events triggering downstream operations
  const parseResult = LeaseTerminatedEventSchema.safeParse(fullEvent);
  if (!parseResult.success) {
    throw new Error(
      `Invalid LeaseTerminated event: ${parseResult.error.message}`
    );
  }

  const { leaseId, accountId } = parseResult.data.detail;
  const leaseEndTimestamp = new Date().toISOString();

  // Validate UUID format early to fail fast with clear error message
  // Prevents EventBridge Scheduler API errors from invalid UUIDs or name length violations
  validateLeaseUuid(leaseId.uuid);

  // Note: Email validation for injection attacks is performed by the Zod schema
  // (strictEmailSchema) which rejects ANSI escape codes and non-ASCII characters

  // Calculate schedule time: now + delay + random jitter
  const delayMs = DELAY_HOURS * 60 * 60 * 1000;
  const jitterMs = getRandomJitterMs(SCHEDULE_JITTER_MAX_MINUTES);
  const scheduleTime = new Date(Date.now() + delayMs + jitterMs);

  const scheduleName = sanitizeScheduleName(`lease-costs-${leaseId.uuid}`);

  // Create structured logger with context
  const logger = createLogger({
    component: "SchedulerLambda",
    leaseId: leaseId.uuid,
    accountId,
    scheduleName,
  });

  // Payload for Cost Collector Lambda
  const payload = {
    leaseId: leaseId.uuid,
    userEmail: leaseId.userEmail,
    accountId,
    leaseEndTimestamp,
    scheduleName,
  };

  const command = new CreateScheduleCommand({
    Name: scheduleName,
    GroupName: SCHEDULER_GROUP,
    ScheduleExpression: formatScheduleExpression(scheduleTime),
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: {
      Mode: FlexibleTimeWindowMode.FLEXIBLE,
      MaximumWindowInMinutes: SCHEDULER_FLEXIBLE_WINDOW_MINUTES,
    },
    Target: {
      Arn: COST_COLLECTOR_LAMBDA_ARN,
      RoleArn: SCHEDULER_ROLE_ARN,
      Input: JSON.stringify(payload),
      RetryPolicy: {
        MaximumRetryAttempts: 3,
        MaximumEventAgeInSeconds: 3600,
      },
    },
    ActionAfterCompletion: ActionAfterCompletion.DELETE, // Auto-delete after successful execution
  });

  try {
    await schedulerClient.send(command);
    logger.info("Created schedule", {
      scheduleTime: scheduleTime.toISOString(),
      delayHours: DELAY_HOURS,
      jitterMinutes: Math.round(jitterMs / 60000),
    });
  } catch (error) {
    if (error instanceof ConflictException) {
      // Duplicate schedule - this is idempotent, log and continue
      logger.warn("Schedule already exists (idempotent handling)");
      return;
    }
    throw error;
  }
}
