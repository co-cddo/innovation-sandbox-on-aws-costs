import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { fromIni } from "@aws-sdk/credential-providers";
import type { CliOptions, CostReport, CostByService } from "./types.js";

const AWS_PROFILE = "NDX/orgManagement";
const COST_EXPLORER_REGION = "us-east-1";

/**
 * Creates a Cost Explorer client
 * Uses IAM role credentials when running in Lambda (no profile)
 * Uses SSO profile when running locally via CLI
 */
function createCostExplorerClient(): CostExplorerClient {
  // In Lambda, AWS_LAMBDA_FUNCTION_NAME is set - use default credential chain
  // Locally, use the SSO profile
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (isLambda) {
    return new CostExplorerClient({
      region: COST_EXPLORER_REGION,
    });
  }

  return new CostExplorerClient({
    region: COST_EXPLORER_REGION,
    credentials: fromIni({ profile: AWS_PROFILE }),
  });
}

export async function getCostData(options: CliOptions): Promise<CostReport> {
  const client = createCostExplorerClient();

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
          Not: {
            Dimensions: {
              Key: "RECORD_TYPE",
              Values: ["Credit", "Refund"],
            },
          },
        },
      ],
    },
  };

  const command = new GetCostAndUsageCommand(input);
  const response: GetCostAndUsageCommandOutput = await client.send(command);

  // Aggregate costs by service across all time periods
  const serviceMap = new Map<string, number>();

  if (response.ResultsByTime) {
    for (const result of response.ResultsByTime) {
      if (result.Groups) {
        for (const group of result.Groups) {
          const serviceName = group.Keys?.[0] ?? "Unknown";
          const amount = parseFloat(
            group.Metrics?.UnblendedCost?.Amount ?? "0"
          );
          // Use Math.abs() to ensure positive values (credits may show negative)
          const positiveAmount = Math.abs(amount);

          const currentTotal = serviceMap.get(serviceName) ?? 0;
          serviceMap.set(serviceName, currentTotal + positiveAmount);
        }
      }
    }
  }

  // Convert map to sorted array
  const costsByService: CostByService[] = Array.from(serviceMap.entries())
    .map(([serviceName, cost]) => ({ serviceName, cost }))
    .sort((a, b) => b.cost - a.cost); // Sort by cost descending

  // Calculate total
  const totalCost = costsByService.reduce((sum, item) => sum + item.cost, 0);

  return {
    accountId: options.accountId,
    startDate: options.startTime,
    endDate: options.endTime,
    totalCost,
    costsByService,
  };
}
