import {
  SchedulerClient,
  ListSchedulesCommand,
  GetScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  type ScheduleSummary,
} from "@aws-sdk/client-scheduler";
import { requireEnv } from "../lib/env-utils.js";
import { createLogger } from "../lib/logger.js";

const schedulerClient = new SchedulerClient({});

// Validate required environment variables at module load
const SCHEDULER_GROUP = requireEnv("SCHEDULER_GROUP", {
  component: "Cleanup Lambda",
  purpose: "to identify and delete stale EventBridge schedules",
});

// Create structured logger for cleanup operations
const logger = createLogger({
  component: "CleanupLambda",
});

/**
 * Maximum age in hours for a schedule to be considered stale.
 * Schedules older than this will be deleted during cleanup.
 *
 * Default: 72 hours (3 days) - provides buffer beyond typical 24-48 hour delay
 * This catches schedules that failed to auto-delete due to:
 * - EventBridge Scheduler service issues
 * - Lambda invocation failures before deletion
 * - Race conditions during concurrent executions
 */
const MAX_SCHEDULE_AGE_HOURS = 72;

/**
 * Parses the scheduled execution time from an EventBridge Scheduler at() expression.
 *
 * @param scheduleExpression - at() expression like "at(2026-02-05T14:30:00)"
 * @returns Date object of the scheduled time, or null if parsing fails
 */
function parseScheduleTime(scheduleExpression: string): Date | null {
  const match = scheduleExpression.match(/^at\(([^)]+)\)$/);
  if (!match) return null;

  const timestamp = match[1];
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Fetches the full schedule details including the schedule expression.
 *
 * @param scheduleName - Name of the schedule to fetch
 * @returns Schedule expression or null if fetch fails
 */
async function getScheduleExpression(scheduleName: string): Promise<string | null> {
  try {
    const response = await schedulerClient.send(
      new GetScheduleCommand({
        Name: scheduleName,
        GroupName: SCHEDULER_GROUP,
      })
    );
    return response.ScheduleExpression || null;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      // Schedule was deleted between list and get
      logger.info("Schedule no longer exists (concurrent deletion)", { scheduleName });
      return null;
    }
    // Log error and skip this schedule
    logger.error("Failed to get schedule", error as Error, { scheduleName });
    return null;
  }
}

/**
 * Determines if a schedule is stale and should be cleaned up.
 *
 * A schedule is considered stale if:
 * 1. It has a scheduled time (can be parsed from expression)
 * 2. The scheduled time is more than MAX_SCHEDULE_AGE_HOURS in the past
 *
 * @param scheduleSummary - EventBridge Scheduler schedule summary
 * @returns true if the schedule should be deleted
 */
async function isStaleSchedule(scheduleSummary: ScheduleSummary): Promise<boolean> {
  const scheduleName = scheduleSummary.Name;
  if (!scheduleName) {
    logger.warn("Schedule has no name, skipping");
    return false;
  }

  // Fetch full schedule details to get the expression
  const scheduleExpression = await getScheduleExpression(scheduleName);
  if (!scheduleExpression) {
    logger.warn("Schedule has no expression or could not be fetched, skipping", {
      scheduleName,
    });
    return false;
  }

  const scheduledTime = parseScheduleTime(scheduleExpression);
  if (!scheduledTime) {
    logger.warn("Could not parse schedule time", {
      scheduleName,
      scheduleExpression,
    });
    return false;
  }

  const now = Date.now();
  const ageMs = now - scheduledTime.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Only consider schedules that are in the past and exceed the age threshold
  return ageHours > MAX_SCHEDULE_AGE_HOURS;
}

/**
 * Lists all schedules in the group with pagination.
 *
 * @returns Array of all schedule summaries
 */
async function listAllSchedules(): Promise<ScheduleSummary[]> {
  const schedules: ScheduleSummary[] = [];
  let nextToken: string | undefined;

  do {
    const response = await schedulerClient.send(
      new ListSchedulesCommand({
        GroupName: SCHEDULER_GROUP,
        NextToken: nextToken,
        MaxResults: 100, // Max allowed by API
      })
    );

    if (response.Schedules) {
      schedules.push(...response.Schedules);
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return schedules;
}

/**
 * Deletes a schedule with error handling.
 *
 * @param scheduleName - Name of the schedule to delete
 * @returns true if deleted successfully, false if already deleted or error
 */
async function deleteSchedule(scheduleName: string): Promise<boolean> {
  try {
    await schedulerClient.send(
      new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: SCHEDULER_GROUP,
      })
    );
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      // Already deleted - concurrent cleanup or auto-delete
      logger.info("Schedule already deleted (concurrent cleanup)", { scheduleName });
      return false;
    }
    // Log error but continue with other schedules
    logger.error("Failed to delete schedule", error as Error, { scheduleName });
    return false;
  }
}

/**
 * Lambda handler for cleaning up stale schedules.
 *
 * This function runs daily to remove orphaned schedules that failed to auto-delete.
 * Schedules are configured with ActionAfterCompletion=DELETE, but this provides
 * a safety net for edge cases like:
 * - EventBridge Scheduler service issues
 * - Lambda failures before completion
 * - Race conditions during concurrent processing
 *
 * Cleanup Strategy:
 * 1. List all schedules in the group
 * 2. Identify stale schedules (scheduled time > MAX_SCHEDULE_AGE_HOURS ago)
 * 3. Delete stale schedules with best-effort error handling
 * 4. Log metrics for observability
 *
 * @returns void - Logs results, throws only on catastrophic failures
 */
export async function handler(): Promise<void> {
  logger.info("Starting cleanup of stale schedules", {
    schedulerGroup: SCHEDULER_GROUP,
    maxAgeHours: MAX_SCHEDULE_AGE_HOURS,
  });

  // List all schedules
  const startTime = Date.now();
  const schedules = await listAllSchedules();
  const listDuration = Date.now() - startTime;

  logger.info("Found schedules", {
    totalCount: schedules.length,
    listDurationMs: listDuration,
  });

  if (schedules.length === 0) {
    logger.info("No schedules to clean up");
    return;
  }

  // Identify stale schedules (must be done sequentially due to API calls)
  const staleSchedules: ScheduleSummary[] = [];
  for (const schedule of schedules) {
    if (await isStaleSchedule(schedule)) {
      staleSchedules.push(schedule);
    }
  }

  if (staleSchedules.length === 0) {
    logger.info("No stale schedules found");
    return;
  }

  const stalePercentage = ((staleSchedules.length / schedules.length) * 100).toFixed(1);
  logger.info("Found stale schedules to clean up", {
    staleCount: staleSchedules.length,
    totalCount: schedules.length,
    stalePercentage: parseFloat(stalePercentage),
  });

  // Delete stale schedules
  const deleteStartTime = Date.now();
  const deleteResults = await Promise.allSettled(
    staleSchedules.map((schedule) => deleteSchedule(schedule.Name!))
  );
  const deleteDuration = Date.now() - deleteStartTime;

  // Calculate metrics
  const deletedCount = deleteResults.filter(
    (result) => result.status === "fulfilled" && result.value === true
  ).length;
  const alreadyDeletedCount = deleteResults.filter(
    (result) => result.status === "fulfilled" && result.value === false
  ).length;
  const failedCount = deleteResults.filter(
    (result) => result.status === "rejected"
  ).length;

  // Log summary
  logger.info("Cleanup completed", {
    durationMs: deleteDuration,
    deleted: deletedCount,
    alreadyDeleted: alreadyDeletedCount,
    failed: failedCount,
    totalProcessed: staleSchedules.length,
  });

  // Log details of failed deletions
  if (failedCount > 0) {
    const failedSchedules = staleSchedules.filter(
      (_, index) => deleteResults[index].status === "rejected"
    );
    logger.error("Failed to delete schedules", undefined, {
      failedCount,
      scheduleNames: failedSchedules.map((s) => s.Name).join(", "),
    });
  }

  // Log sample of cleaned schedules for audit trail
  if (deletedCount > 0) {
    const sampleSize = Math.min(5, deletedCount);
    const deletedSchedules = staleSchedules
      .filter((_, index) => {
        const result = deleteResults[index];
        return result.status === "fulfilled" && result.value === true;
      })
      .slice(0, sampleSize);

    logger.info("Sample of deleted schedules", {
      sampleSize,
      totalDeleted: deletedCount,
      scheduleNames: deletedSchedules.map((s) => s.Name).join(", "),
    });
  }
}
