import type { CostReport, CostReportWithResources } from "../types.js";

/**
 * Generates an RFC 4180 compliant CSV string from a cost report.
 * Produces a two-column CSV with header "Service,Cost" and one row per AWS service.
 * Services are sorted by cost in descending order (highest cost first).
 *
 * Memory optimization: Uses direct string concatenation instead of array.join() to reduce
 * memory footprint from O(3n) to O(n) for large datasets (200+ services).
 *
 * @param report - Cost report containing service cost breakdown
 * @param report.costsByService - Array of services with costs (expected pre-sorted by cost descending)
 * @param report.accountId - AWS account ID (not used in CSV output)
 * @param report.totalCost - Total cost across all services (not used in CSV output)
 *
 * @returns CSV string with header row and one row per service, using RFC 4180 escaping
 *
 * @example
 * ```typescript
 * const report: CostReport = {
 *   accountId: "123456789012",
 *   startDate: "2024-01-01",
 *   endDate: "2024-02-01",
 *   totalCost: 45.67,
 *   costsByService: [
 *     { serviceName: "Amazon S3", cost: 25.34 },
 *     { serviceName: "AWS Lambda", cost: 12.50 },
 *     { serviceName: "Service, with comma", cost: 7.83 }
 *   ]
 * };
 * const csv = generateCsv(report);
 * // Returns:
 * // Service,Cost
 * // Amazon S3,25.34
 * // AWS Lambda,12.50
 * // "Service, with comma",7.83
 * ```
 */
export function generateCsv(report: CostReport): string {
  let csv = "Service,Cost";

  for (const service of report.costsByService) {
    const escapedName = escapeCsvValue(service.serviceName);
    const cost = service.cost.toFixed(2);
    csv += `\n${escapedName},${cost}`;
  }

  return csv;
}

/**
 * Escapes a CSV value per RFC 4180:
 * - If value contains comma, quote, or newline, wrap in double quotes
 * - Double any internal quotes
 */
function escapeCsvValue(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Formats a cost value showing full precision (up to 10 decimal places).
 * AWS Cost Explorer returns costs with up to 10 decimal places of precision.
 * This ensures users can see the complete cost breakdown.
 *
 * @param cost - Cost value in USD
 * @returns Formatted cost string with full precision, trailing zeros removed
 */
function formatCost(cost: number): string {
  // Use toFixed(10) to capture AWS's full precision, then remove trailing zeros
  return cost.toFixed(10).replace(/\.?0+$/, "") || "0";
}

/**
 * Generates an RFC 4180 compliant CSV string from a cost report with resource-level breakdown.
 * Produces a four-column CSV with header "Resource Name,Service,Region,Cost".
 * Resources are sorted by cost in descending order (highest cost first).
 *
 * Memory optimization: Uses direct string concatenation instead of array.join() to reduce
 * memory footprint from O(3n) to O(n) for large datasets.
 *
 * @param report - Cost report containing resource-level cost breakdown
 * @param report.costsByResource - Array of resources with costs (expected pre-sorted by cost descending)
 *
 * @returns CSV string with header row and one row per resource, using RFC 4180 escaping
 *
 * @example
 * ```typescript
 * const report: CostReportWithResources = {
 *   accountId: "123456789012",
 *   startDate: "2026-01-21",
 *   endDate: "2026-02-04",
 *   totalCost: 150.00,
 *   costsByService: [{ serviceName: "Amazon EC2", cost: 150.00 }],
 *   costsByResource: [
 *     { resourceId: "i-abc123", resourceName: "web-server-1", serviceName: "Amazon EC2", region: "us-east-1", cost: 100.00 },
 *     { resourceId: "i-def456", resourceName: "i-def456", serviceName: "Amazon EC2", region: "us-west-2", cost: 50.00 }
 *   ]
 * };
 * const csv = generateCsvWithResources(report);
 * // Returns:
 * // Resource Name,Service,Region,Cost
 * // web-server-1,Amazon EC2,us-east-1,100.00
 * // i-def456,Amazon EC2,us-west-2,50.00
 * ```
 */
export function generateCsvWithResources(report: CostReportWithResources): string {
  let csv = "Resource Name,Service,Region,Cost";

  for (const resource of report.costsByResource) {
    const escapedName = escapeCsvValue(resource.resourceName);
    const escapedService = escapeCsvValue(resource.serviceName);
    const escapedRegion = escapeCsvValue(resource.region);
    const cost = formatCost(resource.cost);
    csv += `\n${escapedName},${escapedService},${escapedRegion},${cost}`;
  }

  return csv;
}
