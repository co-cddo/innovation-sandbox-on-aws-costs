import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageWithResourcesCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageWithResourcesCommandInput,
} from "@aws-sdk/client-cost-explorer";
import { fromIni } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { Decimal } from "decimal.js";
import type { CliOptions, CostReport, CostByResource } from "../types.js";

// Configure Decimal.js to avoid scientific notation for small numbers
// This ensures cost values like 0.0000000007 are output as-is, not as 7e-10
Decimal.set({ toExpNeg: -20, toExpPos: 20 });
import { getCostExplorerClient, type ClientCacheConfig } from "./aws-clients.js";
import {
  sanitizeResourceName,
  sanitizeServiceName,
  sanitizeRegion,
  validateCostAmount,
} from "./validation-utils.js";

const COST_EXPLORER_REGION = "us-east-1";

/**
 * Safety limit for pagination to prevent runaway API calls.
 * 50 pages should handle 99.9% of accounts (typically 100 results per page = 5,000 resources).
 */
const MAX_PAGES = 50;

/**
 * Delay between Cost Explorer API calls for rate limiting.
 * Cost Explorer has a 5 TPS (transactions per second) limit.
 * 200ms delay = 5 requests/second max (5 TPS).
 */
const RATE_LIMIT_DELAY_MS = 200;

/**
 * Maximum number of days for GetCostAndUsageWithResources API.
 * AWS limits resource-level data to 14 days.
 */
const RESOURCE_API_MAX_DAYS = 14;

/**
 * Fallback text for services that don't support resource-level granularity.
 */
const FALLBACK_NO_RESOURCE_GRANULARITY = "No resource breakdown available for this service type";

/**
 * Fallback text for periods beyond the 14-day resource API window.
 */
const FALLBACK_TIME_WINDOW = "No resource breakdown available for this time window";

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
 * Splits a date range into resource API window (last 14 days) and fallback window (earlier period).
 * @param startDate - Start date in YYYY-MM-DD format
 * @param endDate - End date in YYYY-MM-DD format
 * @returns Object with resourceWindow and fallbackWindow (null if not applicable)
 */
function splitDateRange(startDate: string, endDate: string): {
  resourceWindow: { start: string; end: string } | null;
  fallbackWindow: { start: string; end: string } | null;
} {
  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  const maxResourceMs = RESOURCE_API_MAX_DAYS * 24 * 60 * 60 * 1000;
  const durationMs = endMs - startMs;

  if (durationMs <= maxResourceMs) {
    // Entire range fits within 14 days
    return {
      resourceWindow: { start: startDate, end: endDate },
      fallbackWindow: null,
    };
  }

  // Need to split: resource window is last 14 days, fallback is earlier
  const resourceStartMs = endMs - maxResourceMs;
  const resourceStart = new Date(resourceStartMs).toISOString().split("T")[0];

  return {
    resourceWindow: { start: resourceStart, end: endDate },
    fallbackWindow: { start: startDate, end: resourceStart },
  };
}

/**
 * Gets the list of services that had costs in the given period.
 */
async function getServiceList(
  client: CostExplorerClient,
  accountId: string,
  startDate: string,
  endDate: string,
  lambdaContext?: { getRemainingTimeInMillis(): number }
): Promise<string[]> {
  const services: string[] = [];
  let nextToken: string | undefined;
  let pageCount = 0;

  do {
    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[SAFETY] Service list pagination stopped at MAX_PAGES limit (${MAX_PAGES}).`
      );
      break;
    }

    if (lambdaContext && pageCount > 0) {
      const remainingMs = lambdaContext.getRemainingTimeInMillis();
      const estimatedTimePerPage = 3000;
      if (remainingMs < estimatedTimePerPage * 2) {
        console.warn(
          `[SAFETY] Service list pagination stopped at ${pageCount} pages due to Lambda timeout approaching. ` +
            `Remaining time: ${remainingMs}ms. Results are partial.`
        );
        break;
      }
    }

    pageCount++;
    const input: GetCostAndUsageCommandInput = {
      TimePeriod: { Start: startDate, End: endDate },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      Filter: {
        And: [
          { Dimensions: { Key: "LINKED_ACCOUNT", Values: [accountId] } },
          { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } },
        ],
      },
      NextPageToken: nextToken,
    };

    const response = await client.send(new GetCostAndUsageCommand(input));

    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            const rawServiceName = group.Keys?.[0];
            if (rawServiceName) {
              const serviceName = sanitizeServiceName(rawServiceName);
              if (!services.includes(serviceName)) {
                services.push(serviceName);
              }
            }
          }
        }
      }
    }

    nextToken = response.NextPageToken;
    if (nextToken) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (nextToken);

  return services;
}

/**
 * Gets resource-level costs for a single service.
 */
async function getResourceCostsForService(
  client: CostExplorerClient,
  accountId: string,
  serviceName: string,
  startDate: string,
  endDate: string,
  lambdaContext?: { getRemainingTimeInMillis(): number }
): Promise<CostByResource[]> {
  const resourceMap = new Map<string, { cost: Decimal; region: string }>();
  let nextToken: string | undefined;
  let pageCount = 0;

  do {
    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[SAFETY] Resource pagination for ${serviceName} stopped at MAX_PAGES limit (${MAX_PAGES}).`
      );
      break;
    }

    if (lambdaContext && pageCount > 0) {
      const remainingMs = lambdaContext.getRemainingTimeInMillis();
      const estimatedTimePerPage = 5000;
      if (remainingMs < estimatedTimePerPage * 2) {
        console.warn(
          `[SAFETY] Resource pagination for ${serviceName} stopped at ${pageCount} pages due to Lambda timeout approaching. ` +
          `Remaining time: ${remainingMs}ms. Results are partial.`
        );
        break;
      }
    }

    pageCount++;
    const input: GetCostAndUsageWithResourcesCommandInput = {
      TimePeriod: { Start: startDate, End: endDate },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        { Type: "DIMENSION", Key: "RESOURCE_ID" },
        { Type: "DIMENSION", Key: "REGION" },
      ],
      Filter: {
        And: [
          { Dimensions: { Key: "LINKED_ACCOUNT", Values: [accountId] } },
          { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } },
          { Dimensions: { Key: "SERVICE", Values: [serviceName] } },
        ],
      },
      NextPageToken: nextToken,
    };

    const response = await client.send(new GetCostAndUsageWithResourcesCommand(input));

    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            const rawResourceId = group.Keys?.[0] ?? "";
            const rawRegion = group.Keys?.[1] ?? "global";
            const rawAmount = group.Metrics?.UnblendedCost?.Amount ?? "0";

            // Sanitize and validate AWS API response data
            const resourceName = rawResourceId
              ? sanitizeResourceName(rawResourceId)
              : FALLBACK_NO_RESOURCE_GRANULARITY;
            const region = sanitizeRegion(rawRegion);
            const amount = validateCostAmount(rawAmount);

            const key = `${resourceName}|${region}`;

            const existing = resourceMap.get(key);
            if (existing) {
              existing.cost = existing.cost.plus(amount);
            } else {
              resourceMap.set(key, { cost: new Decimal(amount), region });
            }
          }
        }
      }
    }

    nextToken = response.NextPageToken;
    if (nextToken) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (nextToken);

  // Convert map to array
  const results: CostByResource[] = [];
  for (const [key, data] of resourceMap.entries()) {
    const [resourceName] = key.split("|");
    results.push({
      resourceName,
      serviceName,
      region: data.region,
      cost: data.cost.toString(),
    });
  }

  return results;
}

/**
 * Gets fallback costs (service-level) for the period before the 14-day window.
 */
async function getFallbackCosts(
  client: CostExplorerClient,
  accountId: string,
  startDate: string,
  endDate: string,
  lambdaContext?: { getRemainingTimeInMillis(): number }
): Promise<CostByResource[]> {
  const serviceMap = new Map<string, Decimal>();
  let nextToken: string | undefined;
  let pageCount = 0;

  do {
    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[SAFETY] Fallback pagination stopped at MAX_PAGES limit (${MAX_PAGES}).`
      );
      break;
    }

    if (lambdaContext && pageCount > 0) {
      const remainingMs = lambdaContext.getRemainingTimeInMillis();
      const estimatedTimePerPage = 3000;
      if (remainingMs < estimatedTimePerPage * 2) {
        console.warn(
          `[SAFETY] Fallback pagination stopped at ${pageCount} pages due to Lambda timeout approaching. ` +
            `Remaining time: ${remainingMs}ms. Results are partial.`
        );
        break;
      }
    }

    pageCount++;
    const input: GetCostAndUsageCommandInput = {
      TimePeriod: { Start: startDate, End: endDate },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      Filter: {
        And: [
          { Dimensions: { Key: "LINKED_ACCOUNT", Values: [accountId] } },
          { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } },
        ],
      },
      NextPageToken: nextToken,
    };

    const response = await client.send(new GetCostAndUsageCommand(input));

    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            const rawServiceName = group.Keys?.[0] ?? "Unknown";
            const rawAmount = group.Metrics?.UnblendedCost?.Amount ?? "0";

            // Sanitize and validate AWS API response data
            const serviceName = sanitizeServiceName(rawServiceName);
            const amount = validateCostAmount(rawAmount);

            const existing = serviceMap.get(serviceName);
            if (existing) {
              serviceMap.set(serviceName, existing.plus(amount));
            } else {
              serviceMap.set(serviceName, new Decimal(amount));
            }
          }
        }
      }
    }

    nextToken = response.NextPageToken;
    if (nextToken) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } while (nextToken);

  // Convert to CostByResource with fallback text
  return Array.from(serviceMap.entries()).map(([serviceName, cost]) => ({
    resourceName: FALLBACK_TIME_WINDOW,
    serviceName,
    region: "global",
    cost: cost.toString(),
  }));
}

/**
 * Sorts resources by service total (descending), then by resource cost within service (descending).
 * Fallback rows are placed at the end of each service's group.
 *
 * Performance optimization: Pre-computes numeric values during grouping to avoid
 * creating new Decimal objects during sort comparisons.
 */
function sortResources(resources: CostByResource[]): CostByResource[] {
  // Group by service and calculate totals, pre-computing numeric costs
  const serviceGroups = new Map<
    string,
    {
      resources: Array<{ resource: CostByResource; costNum: number }>;
      total: Decimal;
      totalNum: number;
    }
  >();

  for (const resource of resources) {
    const costDecimal = new Decimal(resource.cost);
    const costNum = costDecimal.toNumber();

    const existing = serviceGroups.get(resource.serviceName);
    if (existing) {
      existing.resources.push({ resource, costNum });
      existing.total = existing.total.plus(costDecimal);
      existing.totalNum = existing.total.toNumber();
    } else {
      serviceGroups.set(resource.serviceName, {
        resources: [{ resource, costNum }],
        total: costDecimal,
        totalNum: costNum,
      });
    }
  }

  // Sort services by total cost descending (using pre-computed numbers)
  const sortedServices = Array.from(serviceGroups.entries()).sort(
    (a, b) => b[1].totalNum - a[1].totalNum
  );

  // Build sorted result
  const sorted: CostByResource[] = [];

  for (const [, group] of sortedServices) {
    // Separate regular resources and fallbacks
    // Fallbacks include: service-type fallback, time-window fallback, and degraded mode fallback
    const isFallback = (name: string) =>
      name === FALLBACK_NO_RESOURCE_GRANULARITY ||
      name === FALLBACK_TIME_WINDOW ||
      name.startsWith("No resource breakdown available (");

    const regular = group.resources.filter((r) => !isFallback(r.resource.resourceName));
    const fallbacks = group.resources.filter((r) => isFallback(r.resource.resourceName));

    // Sort using pre-computed numbers (native number comparison is fast)
    regular.sort((a, b) => b.costNum - a.costNum);
    fallbacks.sort((a, b) => b.costNum - a.costNum);

    // Extract resources back out
    sorted.push(
      ...regular.map((r) => r.resource),
      ...fallbacks.map((r) => r.resource)
    );
  }

  return sorted;
}

/**
 * Retrieves AWS Cost Explorer data for a specific account and time range.
 * Uses GetCostAndUsageWithResources API for resource-level granularity.
 *
 * Safety features:
 * - MAX_PAGES limit (50) to prevent runaway pagination
 * - Lambda timeout detection (90% remaining time threshold)
 * - Rate limiting delay (200ms between requests for 5 TPS limit)
 * - 14-day window handling with fallback for earlier periods
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
 * @returns Cost report with total cost and breakdown by resource (sorted by service total, then resource cost)
 *
 * @throws {Error} If Cost Explorer API fails or returns invalid data
 * @throws {Error} If GetCostAndUsageWithResources API is not enabled at org level
 */
export async function getCostData(
  options: CliOptions,
  clientOptions?: CostExplorerClientOptions
): Promise<CostReport> {
  const client = createCostExplorerClient(clientOptions);
  const lambdaContext = clientOptions?.lambdaContext;

  const { resourceWindow, fallbackWindow } = splitDateRange(options.startTime, options.endTime);
  const allResources: CostByResource[] = [];
  let resourceApiEnabled = true;
  let degradedModeReason = "";

  // Get resource-level costs for the recent 14-day window
  if (resourceWindow) {
    // First get list of services
    const services = await getServiceList(
      client,
      options.accountId,
      resourceWindow.start,
      resourceWindow.end,
      lambdaContext
    );

    // Then query resource-level data for each service
    for (const serviceName of services) {
      await sleep(RATE_LIMIT_DELAY_MS);

      try {
        const resources = await getResourceCostsForService(
          client,
          options.accountId,
          serviceName,
          resourceWindow.start,
          resourceWindow.end,
          lambdaContext
        );
        allResources.push(...resources);
      } catch (error) {
        // Check for opt-in error or permission error - gracefully degrade to service-level data
        // This handles two scenarios:
        // 1. Resource-level data not enabled at org level (DataUnavailableException, OptInRequired)
        // 2. IAM policy missing ce:GetCostAndUsageWithResources permission (AccessDeniedException)
        if (
          error instanceof Error &&
          (error.message.includes("not enabled") ||
            error.message.includes("OptInRequired") ||
            error.name === "DataUnavailableException" ||
            (error.name === "AccessDeniedException" &&
              error.message.includes("GetCostAndUsageWithResources")))
        ) {
          resourceApiEnabled = false;
          degradedModeReason =
            error.name === "AccessDeniedException"
              ? "IAM policy missing ce:GetCostAndUsageWithResources permission"
              : "API not enabled at organization level";
          console.warn(
            `[DEGRADED MODE] ${degradedModeReason}. ` +
              "Falling back to service-level data. " +
              "To enable resource-level data: AWS Console > Billing > Cost Explorer > Settings > Enable resource-level data. " +
              "To enable IAM permission: Add ce:GetCostAndUsageWithResources to the Cost Explorer role."
          );
          break; // Exit service loop, use fallback for entire resource window
        }
        throw error;
      }
    }

    // If resource API not enabled, get service-level data for the resource window
    if (!resourceApiEnabled) {
      await sleep(RATE_LIMIT_DELAY_MS);
      const serviceLevelResources = await getFallbackCosts(
        client,
        options.accountId,
        resourceWindow.start,
        resourceWindow.end,
        lambdaContext
      );
      // Mark as degraded mode with specific fallback text indicating the actual reason
      for (const resource of serviceLevelResources) {
        resource.resourceName = `No resource breakdown available (${degradedModeReason})`;
      }
      allResources.push(...serviceLevelResources);
    }
  }

  // Get fallback costs for earlier period (beyond 14 days)
  if (fallbackWindow) {
    await sleep(RATE_LIMIT_DELAY_MS);
    const fallbackResources = await getFallbackCosts(
      client,
      options.accountId,
      fallbackWindow.start,
      fallbackWindow.end,
      lambdaContext
    );
    allResources.push(...fallbackResources);
  }

  // Sort resources
  const sortedResources = sortResources(allResources);

  // Calculate total cost with Decimal.js
  const totalCost = allResources
    .reduce((sum, r) => sum.plus(r.cost), new Decimal(0))
    .toNumber();

  return {
    accountId: options.accountId,
    startDate: options.startTime,
    endDate: options.endTime,
    totalCost,
    costsByResource: sortedResources,
  };
}
