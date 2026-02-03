import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { LeaseCostsGeneratedDetail } from "./schemas.js";
import { getEventBridgeClient } from "./aws-clients.js";

/**
 * Emits a LeaseCostsGenerated event to EventBridge for downstream processing.
 *
 * IMPORTANT: Duplicate Events Expected
 * =====================================
 * This function may emit duplicate events for the same lease due to:
 * 1. EventBridge's at-least-once delivery guarantee
 * 2. Concurrent Lambda invocations processing the same schedule
 * 3. Lambda retries after partial failures
 *
 * CONSUMER REQUIREMENTS:
 * All event consumers MUST be idempotent and handle duplicate events.
 * Use the `detail.leaseId` field to deduplicate (e.g., check if already processed,
 * use database unique constraints, or DynamoDB conditional writes).
 *
 * @param eventBusName - Name of the EventBridge bus to publish to
 * @param detail - Event detail payload containing lease cost information
 * @param detail.leaseId - Unique lease identifier (use for deduplication)
 * @param detail.userEmail - User email address for notification delivery
 * @param detail.accountId - AWS account ID
 * @param detail.totalCost - Total cost in dollars
 * @param detail.csvUrl - Presigned S3 URL for CSV download
 * @param detail.csvExpiresAt - ISO 8601 timestamp when CSV URL expires
 * @param detail.startDate - Billing period start date (YYYY-MM-DD)
 * @param detail.endDate - Billing period end date (YYYY-MM-DD)
 *
 * @throws {Error} If EventBridge API fails to accept the event
 *
 * @example
 * ```typescript
 * await emitLeaseCostsGenerated(
 *   "isb-events",
 *   {
 *     leaseId: "550e8400-e29b-41d4-a716-446655440000",
 *     userEmail: "user@example.com",
 *     accountId: "123456789012",
 *     totalCost: 45.67,
 *     csvUrl: "https://s3.amazonaws.com/...",
 *     csvExpiresAt: "2024-02-08T00:00:00Z",
 *     startDate: "2024-01-01",
 *     endDate: "2024-02-01",
 *   }
 * );
 * ```
 *
 * @see LeaseCostsGeneratedDetail schema in schemas.ts
 * @see Test case "should emit duplicate events on concurrent invocations" in cost-collector-handler.test.ts
 */
export async function emitLeaseCostsGenerated(
  eventBusName: string,
  detail: LeaseCostsGeneratedDetail
): Promise<void> {
  const command = new PutEventsCommand({
    Entries: [
      {
        EventBusName: eventBusName,
        Source: "isb-costs",
        DetailType: "LeaseCostsGenerated",
        Detail: JSON.stringify(detail),
      },
    ],
  });

  const eventBridgeClient = getEventBridgeClient();
  const response = await eventBridgeClient.send(command);

  if (response.FailedEntryCount && response.FailedEntryCount > 0) {
    const failedEntries = response.Entries?.filter(
      (entry) => entry.ErrorCode
    );
    const errorDetails = failedEntries
      ?.map((entry) => `${entry.ErrorCode}: ${entry.ErrorMessage}`)
      .join("; ");
    // Include full context for troubleshooting: lease ID, account, cost amount, and CSV location
    throw new Error(
      `Failed to emit LeaseCostsGenerated event: ` +
      `leaseId=${detail.leaseId}, ` +
      `accountId=${detail.accountId}, ` +
      `totalCost=$${detail.totalCost.toFixed(2)}, ` +
      `csvUrl=${detail.csvUrl}. ` +
      `EventBridge error: ${errorDetails}`
    );
  }
}
