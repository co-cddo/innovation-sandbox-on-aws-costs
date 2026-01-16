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

export interface CliOptions {
  accountId: string;
  startTime: string;
  endTime: string;
}
