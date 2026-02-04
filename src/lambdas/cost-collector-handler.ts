import {
  SchedulerClient,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-scheduler";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  SchedulerPayloadSchema,
  LeaseCostsGeneratedDetailSchema,
  type SchedulerPayload,
} from "../lib/schemas.js";
import { encodeLeaseId, getLeaseDetails } from "../lib/isb-api-client.js";
import { assumeCostExplorerRole } from "../lib/assume-role.js";
import { calculateBillingWindow } from "../lib/date-utils.js";
import { getCostData } from "../lib/cost-explorer.js";
import { generateCsv } from "../lib/csv-generator.js";
import { uploadCsv, getPresignedUrl } from "../lib/s3-uploader.js";
import { emitLeaseCostsGenerated } from "../lib/event-emitter.js";
import { requireEnv, parseIntEnv } from "../lib/env-utils.js";
import { createLogger } from "../lib/logger.js";
import * as AWSXRay from "aws-xray-sdk-core";

// Configure X-Ray to not throw errors when no segment is available (e.g., in tests)
AWSXRay.setContextMissingStrategy("LOG_ERROR");

const schedulerClient = new SchedulerClient({});
const cloudWatchClient = new CloudWatchClient({});

/**
 * Emits custom CloudWatch metrics for business observability.
 * Tracks total cost, service count, and processing duration for each lease.
 *
 * Metrics are published to the "ISBLeaseCosts" namespace for easy filtering
 * and dashboard creation in CloudWatch.
 *
 * @param totalCost - Total AWS cost for the lease (in USD)
 * @param serviceCount - Number of AWS services used during the lease
 * @param processingDurationSeconds - Time taken to collect and process costs
 * @param accountId - AWS account ID (used as dimension for filtering)
 */
async function emitBusinessMetrics(
  totalCost: number,
  resourceCount: number,
  processingDurationSeconds: number,
  accountId: string
): Promise<void> {
  try {
    await cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: "ISBLeaseCosts",
        MetricData: [
          {
            MetricName: "TotalCost",
            Value: totalCost,
            Unit: "None", // USD is not a standard CloudWatch unit, use "None"
            Timestamp: new Date(),
            Dimensions: [
              { Name: "AccountId", Value: accountId },
              { Name: "Service", Value: "LeaseCostCollection" },
            ],
          },
          {
            MetricName: "ResourceCount",
            Value: resourceCount,
            Unit: "Count",
            Timestamp: new Date(),
            Dimensions: [
              { Name: "AccountId", Value: accountId },
              { Name: "Service", Value: "LeaseCostCollection" },
            ],
          },
          {
            MetricName: "ProcessingDuration",
            Value: processingDurationSeconds,
            Unit: "Seconds",
            Timestamp: new Date(),
            Dimensions: [
              { Name: "AccountId", Value: accountId },
              { Name: "Service", Value: "LeaseCostCollection" },
            ],
          },
        ],
      })
    );
  } catch (error) {
    // Log but don't fail - metrics are best-effort
    console.error("Failed to emit CloudWatch metrics:", error);
  }
}

// Validate required environment variables at module load
const COST_EXPLORER_ROLE_ARN = requireEnv("COST_EXPLORER_ROLE_ARN", {
  component: "Cost Collector Lambda",
  purpose: "to assume Cost Explorer role in orgManagement account",
});
const S3_BUCKET_NAME = requireEnv("S3_BUCKET_NAME", {
  component: "Cost Collector Lambda",
  purpose: "to upload cost report CSVs",
});
const EVENT_BUS_NAME = requireEnv("EVENT_BUS_NAME", {
  component: "Cost Collector Lambda",
  purpose: "to emit LeaseCostsGenerated events",
});
const SCHEDULER_GROUP = requireEnv("SCHEDULER_GROUP", {
  component: "Cost Collector Lambda",
  purpose: "to delete completed schedules",
});
const ISB_LEASES_LAMBDA_ARN = requireEnv("ISB_LEASES_LAMBDA_ARN", {
  component: "Cost Collector Lambda",
  purpose: "to retrieve lease start date from ISB API",
});

// Validate ARN formats at module load to fail fast
// This catches deployment order issues where the role stack wasn't deployed first
const ROLE_ARN_REGEX = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
if (!ROLE_ARN_REGEX.test(COST_EXPLORER_ROLE_ARN)) {
  throw new Error(
    `Invalid COST_EXPLORER_ROLE_ARN format: ${COST_EXPLORER_ROLE_ARN}. ` +
    `Expected format: arn:aws:iam::<account-id>:role/<role-name>. ` +
    `Common cause: IsbCostExplorerRoleStack not deployed to orgManagement account first.`
  );
}

const LAMBDA_ARN_REGEX = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[\w-]+$/;
if (!LAMBDA_ARN_REGEX.test(ISB_LEASES_LAMBDA_ARN)) {
  throw new Error(
    `Invalid ISB_LEASES_LAMBDA_ARN format: ${ISB_LEASES_LAMBDA_ARN}. ` +
    `Expected format: arn:aws:lambda:<region>:<account-id>:function:<function-name>`
  );
}

// Validate EventBridge event bus name format
// EventBridge bus names must contain only alphanumeric characters, dots, hyphens, and underscores
// Max length: 256 characters (AWS limit)
const EVENT_BUS_NAME_REGEX = /^[.\-_A-Za-z0-9]{1,256}$/;
if (!EVENT_BUS_NAME_REGEX.test(EVENT_BUS_NAME)) {
  throw new Error(
    `Invalid EVENT_BUS_NAME format: ${EVENT_BUS_NAME}. ` +
    `Event bus names must contain only alphanumeric characters, dots (.), hyphens (-), and underscores (_), ` +
    `and must be between 1 and 256 characters long. ` +
    `Common cause: Typo in CDK stack configuration or manual misconfiguration.`
  );
}

// Parse and validate integer environment variables with bounds
// BILLING_PADDING_HOURS: 0-168 (max 7 days) - accounts for cost data delay
const BILLING_PADDING_HOURS = parseIntEnv("BILLING_PADDING_HOURS", 8, 0, 168);
// AWS S3 presigned URLs have a maximum expiry of 7 days
const PRESIGNED_URL_EXPIRY_DAYS = parseIntEnv("PRESIGNED_URL_EXPIRY_DAYS", 7, 1, 7);

export async function handler(event: unknown): Promise<void> {
  const startTime = Date.now();

  // Validate payload against schema
  const parseResult = SchedulerPayloadSchema.safeParse(event);
  if (!parseResult.success) {
    throw new Error(`Invalid scheduler payload: ${parseResult.error.message}`);
  }

  const payload: SchedulerPayload = parseResult.data;
  const { leaseId, userEmail, accountId, leaseEndTimestamp, scheduleName } =
    payload;

  // Create structured logger with context
  const logger = createLogger({
    component: "CostCollectorLambda",
    leaseId,
    accountId,
    scheduleName,
  });

  logger.info("Starting cost collection", { elapsedSeconds: 0 });

  // 1. Get lease details from ISB API to get the start date
  const segment = AWSXRay.getSegment();
  const isbApiSubsegment = segment?.addNewSubsegment("ISB API");
  let leaseDetails;
  try {
    const leaseIdB64 = encodeLeaseId(userEmail, leaseId);
    isbApiSubsegment?.addAnnotation("leaseId", leaseId);
    isbApiSubsegment?.addAnnotation("accountId", accountId);
    leaseDetails = await getLeaseDetails(leaseIdB64, userEmail, ISB_LEASES_LAMBDA_ARN);
    const elapsedAfterApi = Math.round((Date.now() - startTime) / 1000);
    logger.info("Retrieved lease details from ISB API", { elapsedSeconds: elapsedAfterApi });
    isbApiSubsegment?.close();
  } catch (error) {
    isbApiSubsegment?.close(error as Error);
    throw error;
  }

  // Parse and validate dates immediately to fail fast on invalid data
  const startMs = Date.parse(leaseDetails.startDate);
  const endMs = Date.parse(leaseEndTimestamp);

  if (isNaN(startMs)) {
    throw new Error(`Invalid startDate from ISB API: ${leaseDetails.startDate}`);
  }
  if (isNaN(endMs)) {
    throw new Error(`Invalid leaseEndTimestamp: ${leaseEndTimestamp}`);
  }
  if (startMs >= endMs) {
    throw new Error(
      `Invalid lease dates: startDate (${leaseDetails.startDate}) must be before leaseEndTimestamp (${leaseEndTimestamp})`
    );
  }

  // Log lease details for observability
  const leaseDurationDays = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24));
  logger.info("Lease details", {
    startDate: leaseDetails.startDate,
    endDate: leaseEndTimestamp,
    durationDays: leaseDurationDays,
  });

  // 2. Assume role in orgManagement for Cost Explorer access
  const credentials = await assumeCostExplorerRole(COST_EXPLORER_ROLE_ARN);
  const elapsedAfterAssumeRole = Math.round((Date.now() - startTime) / 1000);
  logger.info("Assumed Cost Explorer role", { elapsedSeconds: elapsedAfterAssumeRole });

  // 3. Calculate billing window
  const { startDate, endDate } = calculateBillingWindow(
    leaseDetails.startDate,
    leaseEndTimestamp,
    BILLING_PADDING_HOURS
  );
  logger.info("Calculated billing window", {
    billingStartDate: startDate,
    billingEndDate: endDate,
    paddingHours: BILLING_PADDING_HOURS,
    leaseStartDate: leaseDetails.startDate,
    leaseEndDate: leaseEndTimestamp,
  });

  // 4. Query Cost Explorer (with pagination handled internally)
  const costExplorerSubsegment = segment?.addNewSubsegment("Cost Explorer");
  let costReport;
  try {
    costExplorerSubsegment?.addAnnotation("accountId", accountId);
    costExplorerSubsegment?.addAnnotation("startDate", startDate);
    costExplorerSubsegment?.addAnnotation("endDate", endDate);
    costReport = await getCostData(
      {
        accountId,
        startTime: startDate,
        endTime: endDate,
      },
      { credentials }
    );
    const elapsedAfterCostExplorer = Math.round((Date.now() - startTime) / 1000);
    costExplorerSubsegment?.addMetadata("totalCost", costReport.totalCost);
    costExplorerSubsegment?.addMetadata("resourceCount", costReport.costsByResource.length);
    logger.info("Completed Cost Explorer query", {
      elapsedSeconds: elapsedAfterCostExplorer,
      totalCost: costReport.totalCost,
      currency: "USD",
      resourceCount: costReport.costsByResource.length,
    });
    costExplorerSubsegment?.close();
  } catch (error) {
    costExplorerSubsegment?.close(error as Error);
    throw error;
  }

  // 5. Generate CSV
  const csvSubsegment = segment?.addNewSubsegment("CSV Generation");
  let csv;
  try {
    csvSubsegment?.addMetadata("resourceCount", costReport.costsByResource.length);
    csv = generateCsv(costReport);
    csvSubsegment?.addMetadata("csvSizeBytes", csv.length);
    csvSubsegment?.close();
  } catch (error) {
    csvSubsegment?.close(error as Error);
    throw error;
  }
  const s3Key = `${leaseId}.csv`;

  // 6. Upload to S3 with integrity verification
  const s3Subsegment = segment?.addNewSubsegment("S3 Upload");
  let eTag, checksum;
  try {
    s3Subsegment?.addAnnotation("bucket", S3_BUCKET_NAME);
    s3Subsegment?.addAnnotation("key", s3Key);
    s3Subsegment?.addMetadata("csvSizeBytes", csv.length);
    const uploadResult = await uploadCsv(S3_BUCKET_NAME, s3Key, csv);
    eTag = uploadResult.eTag;
    checksum = uploadResult.checksum;
    const elapsedAfterS3 = Math.round((Date.now() - startTime) / 1000);
    s3Subsegment?.addMetadata("eTag", eTag);
    s3Subsegment?.addMetadata("checksum", checksum);
    logger.info("Uploaded CSV to S3", {
      elapsedSeconds: elapsedAfterS3,
      bucket: S3_BUCKET_NAME,
      key: s3Key,
      eTag,
      checksum,
    });
    s3Subsegment?.close();
  } catch (error) {
    s3Subsegment?.close(error as Error);
    throw error;
  }

  // 7. Generate presigned URL
  const { url: csvUrl, expiresAt } = await getPresignedUrl(
    S3_BUCKET_NAME,
    s3Key,
    PRESIGNED_URL_EXPIRY_DAYS
  );

  // 8. Emit LeaseCostsGenerated event
  const eventDetail = {
    leaseId,
    userEmail,
    accountId,
    totalCost: costReport.totalCost,
    currency: "USD" as const,
    startDate,
    endDate,
    csvUrl,
    urlExpiresAt: expiresAt.toISOString(),
  };

  // Validate event detail before emitting
  const eventParseResult = LeaseCostsGeneratedDetailSchema.safeParse(eventDetail);
  if (!eventParseResult.success) {
    throw new Error(
      `Invalid LeaseCostsGenerated event detail: ${eventParseResult.error.message}`
    );
  }

  await emitLeaseCostsGenerated(EVENT_BUS_NAME, eventParseResult.data);
  const elapsedAfterEvent = Math.round((Date.now() - startTime) / 1000);
  logger.info("Emitted LeaseCostsGenerated event", { elapsedSeconds: elapsedAfterEvent });

  // 9. Emit custom CloudWatch metrics for business observability
  await emitBusinessMetrics(
    costReport.totalCost,
    costReport.costsByResource.length,
    elapsedAfterEvent,
    accountId
  );
  logger.info("Emitted CloudWatch business metrics", {
    totalCost: costReport.totalCost,
    resourceCount: costReport.costsByResource.length,
    processingDuration: elapsedAfterEvent,
  });

  // 10. Delete the scheduler schedule (best-effort fallback)
  // Note: Schedules are configured with ActionAfterCompletion=DELETE for automatic cleanup.
  // This manual deletion serves as a fallback in case of race conditions or failures.
  // Orphaned schedules are also cleaned up by a daily maintenance Lambda.
  try {
    await schedulerClient.send(
      new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: SCHEDULER_GROUP,
      })
    );
    logger.info("Deleted schedule", { scheduleName });
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      // Expected case: schedule already auto-deleted by EventBridge Scheduler
      logger.info("Schedule already deleted (auto-deleted after execution)", {
        scheduleName,
      });
    } else {
      // Log but don't fail - cleanup is best-effort, daily Lambda will handle orphans
      logger.error(
        "Failed to delete schedule",
        error as Error,
        { scheduleName }
      );
    }
  }

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  logger.info("Cost collection completed", { elapsedSeconds: totalElapsed });
}
