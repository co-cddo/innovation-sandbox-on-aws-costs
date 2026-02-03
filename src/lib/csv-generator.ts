import type { CostReport } from "../types.js";

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
