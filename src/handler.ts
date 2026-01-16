import {
  SchedulerClient,
  CreateScheduleCommand,
  FlexibleTimeWindowMode,
} from "@aws-sdk/client-scheduler";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { getCostData } from "./cost-explorer.js";
import { generateMarkdownReport } from "./report-generator.js";
import { sendCostReportEmail } from "./notify.js";
import type { CostReport } from "./types.js";

// Environment variables
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;
const SCHEDULER_GROUP_NAME = process.env.SCHEDULER_GROUP_NAME!;
const COST_REPORT_DELAY_HOURS = parseInt(
  process.env.COST_REPORT_DELAY_HOURS || "24",
  10
);
const GOVUK_NOTIFY_SECRET_ARN = process.env.GOVUK_NOTIFY_SECRET_ARN!;
const GOVUK_NOTIFY_TEMPLATE_ID = process.env.GOVUK_NOTIFY_TEMPLATE_ID!;

// Clients
const schedulerClient = new SchedulerClient({});
const secretsClient = new SecretsManagerClient({});

// Event types
interface ScheduleCostReportEvent {
  action: "SCHEDULE_COST_REPORT";
  accountId: string;
  leaseId: string;
  userEmail: string;
  leaseStartTime: string;
  leaseEndTime: string;
  eventType: string;
}

interface SendCostReportEvent {
  action: "SEND_COST_REPORT";
  accountId: string;
  leaseId: string;
  userEmail: string;
  leaseStartTime: string;
  leaseEndTime: string;
}

type LambdaEvent = ScheduleCostReportEvent | SendCostReportEvent;

interface LambdaResponse {
  statusCode: number;
  body: string;
}

/**
 * Main Lambda handler
 */
export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  console.log("Received event:", JSON.stringify(event, null, 2));

  try {
    switch (event.action) {
      case "SCHEDULE_COST_REPORT":
        return await handleScheduleCostReport(event);
      case "SEND_COST_REPORT":
        return await handleSendCostReport(event);
      default:
        throw new Error(`Unknown action: ${(event as { action: string }).action}`);
    }
  } catch (error) {
    console.error("Error processing event:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
}

/**
 * Handles the SCHEDULE_COST_REPORT action
 * Creates a delayed EventBridge schedule to send the cost report after billing reconciles
 */
async function handleScheduleCostReport(
  event: ScheduleCostReportEvent
): Promise<LambdaResponse> {
  const { accountId, leaseId, userEmail, leaseStartTime, leaseEndTime } = event;

  // Calculate when to send the cost report (24 hours after lease end)
  const leaseEnd = new Date(leaseEndTime);
  const scheduledTime = new Date(
    leaseEnd.getTime() + COST_REPORT_DELAY_HOURS * 60 * 60 * 1000
  );

  // Create a unique schedule name
  const scheduleName = `cost-report-${leaseId}-${Date.now()}`;

  // Get the Lambda ARN from environment (we need to invoke ourselves)
  const lambdaArn = process.env.AWS_LAMBDA_FUNCTION_NAME
    ? `arn:aws:lambda:${process.env.AWS_REGION}:${await getAccountId()}:function:${process.env.AWS_LAMBDA_FUNCTION_NAME}`
    : "";

  const payload: SendCostReportEvent = {
    action: "SEND_COST_REPORT",
    accountId,
    leaseId,
    userEmail,
    leaseStartTime,
    leaseEndTime,
  };

  const command = new CreateScheduleCommand({
    Name: scheduleName,
    GroupName: SCHEDULER_GROUP_NAME,
    ScheduleExpression: `at(${scheduledTime.toISOString().slice(0, 19)})`,
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: {
      Mode: FlexibleTimeWindowMode.OFF,
    },
    Target: {
      Arn: lambdaArn,
      RoleArn: SCHEDULER_ROLE_ARN,
      Input: JSON.stringify(payload),
    },
    // Auto-delete after execution
    ActionAfterCompletion: "DELETE",
  });

  await schedulerClient.send(command);

  console.log(
    `Scheduled cost report for lease ${leaseId} at ${scheduledTime.toISOString()}`
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Cost report scheduled",
      scheduleName,
      scheduledTime: scheduledTime.toISOString(),
      leaseId,
    }),
  };
}

/**
 * Handles the SEND_COST_REPORT action
 * Retrieves costs from Cost Explorer and sends email via GOV.UK Notify
 */
async function handleSendCostReport(
  event: SendCostReportEvent
): Promise<LambdaResponse> {
  const { accountId, leaseId, userEmail, leaseStartTime, leaseEndTime } = event;

  // Parse dates and adjust for Cost Explorer (uses YYYY-MM-DD format)
  const startDate = new Date(leaseStartTime);
  const endDate = new Date(leaseEndTime);

  // Cost Explorer end date is exclusive, so add 1 day to include the full lease period
  endDate.setDate(endDate.getDate() + 1);

  const startDateStr = startDate.toISOString().split("T")[0];
  const endDateStr = endDate.toISOString().split("T")[0];

  console.log(
    `Fetching costs for account ${accountId} from ${startDateStr} to ${endDateStr}`
  );

  // Get cost data
  const costReport: CostReport = await getCostData({
    accountId,
    startTime: startDateStr,
    endTime: endDateStr,
  });

  console.log(`Total cost: $${costReport.totalCost.toFixed(2)}`);

  // Generate markdown report for logging/debugging
  const markdownReport = generateMarkdownReport(costReport);
  console.log("Cost report:\n", markdownReport);

  // Get GOV.UK Notify API key from Secrets Manager
  const apiKey = await getNotifyApiKey();

  // Send email via GOV.UK Notify
  await sendCostReportEmail({
    apiKey,
    templateId: GOVUK_NOTIFY_TEMPLATE_ID,
    emailAddress: userEmail,
    personalisation: {
      account_id: accountId,
      lease_id: leaseId,
      total_cost: `$${costReport.totalCost.toFixed(2)}`,
      start_date: startDateStr,
      end_date: leaseEndTime.split("T")[0],
      cost_breakdown: formatCostBreakdownForEmail(costReport),
    },
  });

  console.log(`Cost report email sent to ${userEmail}`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Cost report sent",
      leaseId,
      userEmail,
      totalCost: costReport.totalCost,
    }),
  };
}

/**
 * Formats cost breakdown for email (plain text format)
 */
function formatCostBreakdownForEmail(report: CostReport): string {
  if (report.costsByService.length === 0) {
    return "No costs recorded for this period.";
  }

  const lines = report.costsByService
    .filter((s) => s.cost > 0)
    .map((s) => `- ${s.serviceName}: $${s.cost.toFixed(2)}`);

  return lines.join("\n");
}

/**
 * Retrieves GOV.UK Notify API key from Secrets Manager
 */
async function getNotifyApiKey(): Promise<string> {
  const command = new GetSecretValueCommand({
    SecretId: GOVUK_NOTIFY_SECRET_ARN,
  });

  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error("GOV.UK Notify API key not found in secret");
  }

  // Secret might be JSON with an 'apiKey' field or plain string
  try {
    const parsed = JSON.parse(response.SecretString);
    return parsed.apiKey || parsed.api_key || response.SecretString;
  } catch {
    return response.SecretString;
  }
}

/**
 * Gets the current AWS account ID
 */
async function getAccountId(): Promise<string> {
  // In Lambda, we can get this from the ARN in the context
  // For simplicity, extract from Lambda function ARN environment variable
  const functionArn = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionArn) {
    throw new Error("Cannot determine account ID");
  }
  // Account ID is in the Lambda's invoked function ARN from context
  // This is a simplification - in production you'd use STS GetCallerIdentity
  return process.env.AWS_ACCOUNT_ID || "unknown";
}
