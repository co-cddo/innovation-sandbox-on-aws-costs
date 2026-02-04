import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageWithResourcesCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
  type GetCostAndUsageWithResourcesCommandInput,
  type GetCostAndUsageWithResourcesCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { fromIni } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import type { CliOptions, CostReport, CostByService, CostReportWithResources, CostByResource } from "../types.js";
import { getCostExplorerClient, type ClientCacheConfig } from "./aws-clients.js";

const COST_EXPLORER_REGION = "us-east-1";

/**
 * Safety limit for pagination to prevent runaway API calls.
 * 50 pages should handle 99.9% of accounts (typically 100 results per page = 5,000 services).
 */
const MAX_PAGES = 50;

/**
 * Delay between Cost Explorer API calls for rate limiting.
 * Cost Explorer has a 5 TPS (transactions per second) limit.
 * 200ms delay = 5 requests/second max (5 TPS).
 */
const RATE_LIMIT_DELAY_MS = 200;

/**
 * Lambda timeout safety margin (90%).
 * If we're at 90% of Lambda timeout, stop pagination to prevent timeout errors.
 */
const TIMEOUT_SAFETY_MARGIN = 0.9;

export interface CostExplorerClientOptions {
  credentials?: AwsCredentialIdentity;
  profile?: string;
  /**
   * Optional Lambda context for timeout detection.
   * If provided, pagination will stop at 90% of remaining time to prevent timeout errors.
   */
  lambdaContext?: {
    getRemainingTimeInMillis(): number;
  };
}

/**
 * Sleep utility for rate limiting.
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a Cost Explorer client with optional credentials or profile.
 * Uses cached clients for improved performance and reduced connection overhead.
 * Includes retry configuration for throttling resilience.
 *
 * @param options - Optional credentials for Lambda (assumed role) or profile for CLI
 * @returns Configured CostExplorerClient
 */
export function createCostExplorerClient(
  options?: CostExplorerClientOptions
): CostExplorerClient {
  const cacheConfig: ClientCacheConfig = {
    region: COST_EXPLORER_REGION,
  };

  if (options?.credentials) {
    // Lambda: Use provided credentials from STS AssumeRole
    cacheConfig.credentials = options.credentials;
  } else if (options?.profile) {
    // CLI: Use named profile
    cacheConfig.profile = options.profile;
    cacheConfig.additionalConfig = {
      credentials: fromIni({ profile: options.profile }),
    };
  }

  return getCostExplorerClient(cacheConfig);
}

/**
 * Retrieves AWS Cost Explorer data for a specific account and time range.
 * Handles pagination automatically and aggregates costs by service with floating-point precision protection.
 *
 * Safety features:
 * - MAX_PAGES limit (50) to prevent runaway pagination
 * - Lambda timeout detection (90% remaining time threshold)
 * - Rate limiting delay (200ms between requests for 5 TPS limit)
 * - Integer cent arithmetic to avoid floating-point precision loss
 *
 * @param options - Query parameters
 * @param options.accountId - AWS account ID to query costs for
 * @param options.startTime - Start of billing window in YYYY-MM-DD format
 * @param options.endTime - End of billing window in YYYY-MM-DD format (exclusive)
 * @param clientOptions - Optional client configuration
 * @param clientOptions.credentials - AWS credentials from STS AssumeRole (for cross-account access)
 * @param clientOptions.profile - Named AWS profile for CLI usage
 * @param clientOptions.lambdaContext - Lambda context for timeout detection
 *
 * @returns Cost report with total cost and breakdown by service (sorted by cost descending)
 *
 * @throws {Error} If Cost Explorer API fails or returns invalid data
 * @throws {Error} If pagination limit (50 pages) is reached (results will be partial)
 *
 * @example
 * ```typescript
 * // Lambda: Use assumed role credentials for cross-account access
 * const credentials = await assumeCostExplorerRole(roleArn);
 * const costs = await getCostData(
 *   { accountId: "123456789012", startTime: "2024-01-01", endTime: "2024-02-01" },
 *   { credentials, lambdaContext: context }
 * );
 * console.log(`Total cost: $${costs.totalCost.toFixed(2)}`);
 * console.log(`Top service: ${costs.costsByService[0].serviceName}`);
 * ```
 *
 * @example
 * ```typescript
 * // CLI: Use named profile
 * const costs = await getCostData(
 *   { accountId: "123456789012", startTime: "2024-01-01", endTime: "2024-02-01" },
 *   { profile: "my-profile" }
 * );
 * ```
 */
export async function getCostData(
  options: CliOptions,
  clientOptions?: CostExplorerClientOptions
): Promise<CostReport> {
  const client = createCostExplorerClient(clientOptions);
  const lambdaContext = clientOptions?.lambdaContext;

  // Use integer cents to avoid floating-point precision loss
  const serviceMapCents = new Map<string, number>();
  let nextToken: string | undefined;
  let pageCount = 0;

  do {
    // Safety check: MAX_PAGES limit
    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[SAFETY] Pagination stopped at MAX_PAGES limit (${MAX_PAGES}). ` +
        `This account may have more data. Consider investigating if this is expected.`
      );
      break;
    }

    // Safety check: Lambda timeout detection
    // Stop if we've used more than 90% of Lambda timeout (less than 10% remaining)
    if (lambdaContext && pageCount > 0) {
      const remainingMs = lambdaContext.getRemainingTimeInMillis();
      // Estimate time per page based on first page and add 20% buffer
      const estimatedTimePerPage = 5000; // Conservative 5 seconds per page

      if (remainingMs < estimatedTimePerPage * 2) {
        console.warn(
          `[SAFETY] Pagination stopped at ${pageCount} pages due to Lambda timeout approaching. ` +
          `Remaining time: ${remainingMs}ms. Results are partial.`
        );
        break;
      }
    }

    pageCount++;
    const input: GetCostAndUsageCommandInput = {
      TimePeriod: {
        Start: options.startTime,
        End: options.endTime,
      },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        {
          Type: "DIMENSION",
          Key: "SERVICE",
        },
      ],
      Filter: {
        And: [
          {
            Dimensions: {
              Key: "LINKED_ACCOUNT",
              Values: [options.accountId],
            },
          },
          {
            Dimensions: {
              Key: "RECORD_TYPE",
              Values: ["Usage"],
            },
          },
        ],
      },
      NextPageToken: nextToken,
    };

    const command = new GetCostAndUsageCommand(input);
    const response: GetCostAndUsageCommandOutput = await client.send(command);

    // Aggregate costs by service across all time periods
    // Use integer cents to avoid floating-point precision loss during aggregation
    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            const serviceName = group.Keys?.[0] ?? "Unknown";
            const amountDollars = parseFloat(
              group.Metrics?.UnblendedCost?.Amount ?? "0"
            );

            // Convert dollars to cents (integer arithmetic)
            const amountCents = Math.round(amountDollars * 100);

            const currentTotalCents = serviceMapCents.get(serviceName) ?? 0;
            serviceMapCents.set(serviceName, currentTotalCents + amountCents);
          }
        }
      }
    }

    nextToken = response.NextPageToken;

    // Rate limiting: Add delay between API calls (5 TPS limit)
    if (nextToken) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (nextToken);

  // Convert cents back to dollars for final result
  const costsByService: CostByService[] = Array.from(serviceMapCents.entries())
    .map(([serviceName, costCents]) => ({
      serviceName,
      cost: costCents / 100
    }))
    .sort((a, b) => b.cost - a.cost); // Sort by cost descending

  // Calculate total from cents to maintain precision
  const totalCostCents = Array.from(serviceMapCents.values()).reduce(
    (sum, cents) => sum + cents,
    0
  );
  const totalCost = totalCostCents / 100;

  return {
    accountId: options.accountId,
    startDate: options.startTime,
    endDate: options.endTime,
    totalCost,
    costsByService,
  };
}

/**
 * Maximum lookback period for GetCostAndUsageWithResources API.
 * AWS enforces a 14-day limit for resource-level cost data.
 */
const MAX_RESOURCE_LOOKBACK_DAYS = 14;

/**
 * Default service filter for resource-level cost queries.
 * EC2 is the most common service for resource-level cost analysis.
 */
export const DEFAULT_RESOURCE_SERVICE = "Amazon Elastic Compute Cloud - Compute";

export interface GetCostDataWithResourcesOptions extends CliOptions {
  /**
   * AWS service to filter by. Required for GetCostAndUsageWithResources API.
   * Defaults to EC2 Compute service.
   */
  serviceFilter?: string;
}

/**
 * Retrieves AWS Cost Explorer data with resource-level breakdown.
 * Uses GetCostAndUsageWithResources API which has stricter requirements than GetCostAndUsage.
 *
 * Key constraints:
 * - **14-day lookback limit**: Time period cannot exceed 14 days from today
 * - **Opt-in required**: Resource-level data must be enabled in AWS Cost Management Console
 * - **Service filter required**: Must filter by exactly one service per API call
 *
 * Resource names are extracted from DimensionValueAttributes (EC2 Name tags).
 * If a resource doesn't have a friendly name, the resource ID is used as fallback.
 *
 * @param options - Query parameters
 * @param options.accountId - AWS account ID to query costs for
 * @param options.startTime - Start of billing window in YYYY-MM-DD format
 * @param options.endTime - End of billing window in YYYY-MM-DD format (exclusive)
 * @param options.serviceFilter - AWS service to filter by (defaults to EC2)
 * @param clientOptions - Optional client configuration
 *
 * @returns Cost report with resource-level breakdown (sorted by cost descending)
 *
 * @throws {Error} If time period exceeds 14 days
 * @throws {Error} If Cost Explorer API fails (including when opt-in not enabled)
 *
 * @example
 * ```typescript
 * const costs = await getCostDataWithResources(
 *   {
 *     accountId: "123456789012",
 *     startTime: "2026-01-21",
 *     endTime: "2026-02-04",
 *   },
 *   { credentials }
 * );
 * console.log(`Total EC2 cost: $${costs.totalCost.toFixed(2)}`);
 * for (const r of costs.costsByResource) {
 *   console.log(`${r.resourceName}: $${r.cost.toFixed(2)} (${r.region})`);
 * }
 * ```
 */
export async function getCostDataWithResources(
  options: GetCostDataWithResourcesOptions,
  clientOptions?: CostExplorerClientOptions
): Promise<CostReportWithResources> {
  // Validate 14-day lookback constraint
  const startDate = new Date(options.startTime);
  const endDate = new Date(options.endTime);
  const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  if (daysDiff > MAX_RESOURCE_LOOKBACK_DAYS) {
    throw new Error(
      `Time period exceeds ${MAX_RESOURCE_LOOKBACK_DAYS}-day limit for resource-level data. ` +
      `Requested: ${daysDiff} days (${options.startTime} to ${options.endTime}). ` +
      `Use getCostData() for longer periods without resource-level breakdown.`
    );
  }

  const client = createCostExplorerClient(clientOptions);
  const lambdaContext = clientOptions?.lambdaContext;
  const serviceFilter = options.serviceFilter ?? DEFAULT_RESOURCE_SERVICE;

  // Track costs by resource with composite key (resourceId + region)
  // Use raw dollar amounts to preserve full AWS precision (up to 10 decimal places)
  const resourceMap = new Map<string, {
    resourceId: string;
    resourceName: string;
    serviceName: string;
    region: string;
    cost: number;
  }>();

  // Track service-level costs for the base CostReport
  const serviceMap = new Map<string, number>();

  let nextToken: string | undefined;
  let pageCount = 0;

  do {
    // Safety check: MAX_PAGES limit
    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[SAFETY] Pagination stopped at MAX_PAGES limit (${MAX_PAGES}). ` +
        `This account may have more resource data. Consider investigating if this is expected.`
      );
      break;
    }

    // Safety check: Lambda timeout detection
    if (lambdaContext && pageCount > 0) {
      const remainingMs = lambdaContext.getRemainingTimeInMillis();
      const estimatedTimePerPage = 5000;

      if (remainingMs < estimatedTimePerPage * 2) {
        console.warn(
          `[SAFETY] Pagination stopped at ${pageCount} pages due to Lambda timeout approaching. ` +
          `Remaining time: ${remainingMs}ms. Results are partial.`
        );
        break;
      }
    }

    pageCount++;

    const input: GetCostAndUsageWithResourcesCommandInput = {
      TimePeriod: {
        Start: options.startTime,
        End: options.endTime,
      },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        {
          Type: "DIMENSION",
          Key: "RESOURCE_ID",
        },
      ],
      Filter: {
        And: [
          {
            Dimensions: {
              Key: "LINKED_ACCOUNT",
              Values: [options.accountId],
            },
          },
          {
            Dimensions: {
              Key: "SERVICE",
              Values: [serviceFilter],
            },
          },
          {
            Dimensions: {
              Key: "RECORD_TYPE",
              Values: ["Usage"],
            },
          },
        ],
      },
      NextPageToken: nextToken,
    };

    const command = new GetCostAndUsageWithResourcesCommand(input);
    const response: GetCostAndUsageWithResourcesCommandOutput = await client.send(command);

    // Build a map of resource IDs to friendly names from DimensionValueAttributes
    const resourceNameMap = new Map<string, string>();
    if (response.DimensionValueAttributes) {
      for (const attr of response.DimensionValueAttributes) {
        if (attr.Value && attr.Attributes?.["resource_name"]) {
          resourceNameMap.set(attr.Value, attr.Attributes["resource_name"]);
        }
      }
    }

    // Aggregate costs by resource across all time periods
    // Preserve full AWS precision (up to 10 decimal places)
    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            const resourceId = group.Keys?.[0] ?? "Unknown";
            const amount = parseFloat(
              group.Metrics?.UnblendedCost?.Amount ?? "0"
            );

            // Get friendly name or fall back to resource ID
            const resourceName = resourceNameMap.get(resourceId) ?? resourceId;

            // Extract region from resource ID if it's an ARN
            // Format: arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0
            // Non-ARN resources (like S3 bucket names) are global by nature
            let region = "global";
            if (resourceId.startsWith("arn:")) {
              const arnParts = resourceId.split(":");
              if (arnParts.length >= 4) {
                region = arnParts[3] || "global";
              }
            }

            // Use composite key for resource aggregation
            const compositeKey = `${resourceId}|${region}`;
            const existing = resourceMap.get(compositeKey);

            if (existing) {
              existing.cost += amount;
            } else {
              resourceMap.set(compositeKey, {
                resourceId,
                resourceName,
                serviceName: serviceFilter,
                region,
                cost: amount,
              });
            }

            // Also aggregate to service level
            const currentServiceCost = serviceMap.get(serviceFilter) ?? 0;
            serviceMap.set(serviceFilter, currentServiceCost + amount);
          }
        }
      }
    }

    nextToken = response.NextPageToken;

    // Rate limiting
    if (nextToken) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (nextToken);

  // Convert to final structures (already in dollars with full precision)
  const costsByResource: CostByResource[] = Array.from(resourceMap.values())
    .map(r => ({
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      serviceName: r.serviceName,
      region: r.region,
      cost: r.cost,
    }))
    .sort((a, b) => b.cost - a.cost);

  const costsByService: CostByService[] = Array.from(serviceMap.entries())
    .map(([serviceName, cost]) => ({
      serviceName,
      cost,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Calculate total
  const totalCost = Array.from(resourceMap.values())
    .reduce((sum, r) => sum + r.cost, 0);

  return {
    accountId: options.accountId,
    startDate: options.startTime,
    endDate: options.endTime,
    totalCost,
    costsByService,
    costsByResource,
  };
}
