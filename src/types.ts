export interface CostByService {
  serviceName: string;
  cost: number;
}

export interface CostReport {
  accountId: string;
  startDate: string;
  endDate: string;
  totalCost: number;
  costsByService: CostByService[];
}

/**
 * Resource-level cost breakdown for a single AWS resource.
 * Used with GetCostAndUsageWithResources API (14-day lookback limit).
 */
export interface CostByResource {
  /** AWS resource ID (e.g., i-1234567890abcdef0) */
  resourceId: string;
  /** Friendly resource name from EC2 Name tag, or resourceId if unavailable */
  resourceName: string;
  /** AWS service name (e.g., Amazon Elastic Compute Cloud - Compute) */
  serviceName: string;
  /** AWS region (e.g., us-east-1) */
  region: string;
  /** Cost in USD */
  cost: number;
}

/**
 * Cost report with resource-level breakdown.
 * Extends CostReport with resource-level data from GetCostAndUsageWithResources API.
 *
 * Note: Resource-level data requires:
 * - Opt-in enabled in AWS Cost Management Console (org-level setting)
 * - Maximum 14-day lookback period
 * - Service filter required (one service per API call)
 */
export interface CostReportWithResources extends CostReport {
  /** Resource-level cost breakdown, sorted by cost descending */
  costsByResource: CostByResource[];
}

export interface CliOptions {
  accountId: string;
  startTime: string;
  endTime: string;
}

// Re-export Lambda event types from schemas
export type {
  LeaseTerminatedEvent,
  SchedulerPayload,
  LeaseCostsGeneratedDetail,
  LeaseDetails,
} from "./lib/schemas.js";
