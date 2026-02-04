export interface CostByResource {
  resourceName: string;  // ARN, name, or fallback text
  serviceName: string;
  region: string;        // "global" for region-less costs
  cost: string;          // Full precision string from AWS
}

export interface CostReport {
  accountId: string;
  startDate: string;
  endDate: string;
  totalCost: number;
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
