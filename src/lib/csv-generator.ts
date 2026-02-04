import type { CostReport } from "../types.js";

/**
 * Generates an RFC 4180 compliant CSV string from a cost report.
 * Produces a four-column CSV with header "Resource Name,Service,Region,Cost"
 * and one row per AWS resource.
 *
 * Resources are pre-sorted by cost-explorer.ts:
 * - Services ordered by total service cost (descending)
 * - Resources within each service ordered by individual cost (descending)
 * - Fallback rows appear after all resource rows for each service
 *
 * Memory optimization: Uses direct string concatenation instead of array.join() to reduce
 * memory footprint from O(3n) to O(n) for large datasets (200+ resources).
 *
 * @param report - Cost report containing resource cost breakdown
 * @param report.costsByResource - Array of resources with costs (expected pre-sorted)
 * @param report.accountId - AWS account ID (not used in CSV output)
 * @param report.totalCost - Total cost across all resources (not used in CSV output)
 *
 * @returns CSV string with header row and one row per resource, using RFC 4180 escaping
 *
 * @example
 * ```typescript
 * const report: CostReport = {
 *   accountId: "123456789012",
 *   startDate: "2024-01-01",
 *   endDate: "2024-02-01",
 *   totalCost: 45.67,
 *   costsByResource: [
 *     { resourceName: "i-1234567890abcdef0", serviceName: "Amazon EC2", region: "us-east-1", cost: "25.34" },
 *     { resourceName: "my-bucket", serviceName: "Amazon S3", region: "us-east-1", cost: "12.50" },
 *   ]
 * };
 * const csv = generateCsv(report);
 * // Returns:
 * // Resource Name,Service,Region,Cost
 * // i-1234567890abcdef0,Amazon EC2,us-east-1,25.34
 * // my-bucket,Amazon S3,us-east-1,12.50
 * ```
 */
export function generateCsv(report: CostReport): string {
  let csv = "Resource Name,Service,Region,Cost";

  for (const resource of report.costsByResource) {
    const escapedName = escapeCsvValue(resource.resourceName);
    const escapedService = escapeCsvValue(resource.serviceName);
    const escapedRegion = escapeCsvValue(resource.region);
    const escapedCost = escapeCsvValue(resource.cost);
    csv += `\n${escapedName},${escapedService},${escapedRegion},${escapedCost}`;
  }

  return csv;
}

/**
 * Characters that trigger formula execution in spreadsheet applications.
 * These must be neutralized to prevent CSV injection attacks.
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */
const FORMULA_TRIGGER_CHARS = ["=", "+", "-", "@", "|", "%"];

/**
 * Escapes a CSV value per RFC 4180 AND prevents CSV injection attacks.
 *
 * Security: Prefixes formula trigger characters with a single quote (')
 * to prevent Excel, LibreOffice Calc, and Google Sheets from executing
 * formulas embedded in resource names or other AWS API data.
 *
 * RFC 4180 rules:
 * - If value contains comma, quote, or newline, wrap in double quotes
 * - Double any internal quotes
 *
 * @param value - Raw string value (potentially from untrusted AWS API data)
 * @returns RFC 4180 compliant and injection-safe CSV value
 */
function escapeCsvValue(value: string): string {
  let sanitized = value;

  // Step 1: Prevent CSV injection by prefixing formula trigger characters
  // This must happen BEFORE RFC 4180 escaping
  if (FORMULA_TRIGGER_CHARS.some((char) => value.startsWith(char))) {
    sanitized = `'${value}`;
  }

  // Step 2: Apply RFC 4180 escaping (comma, quote, newline)
  if (
    sanitized.includes(",") ||
    sanitized.includes('"') ||
    sanitized.includes("\n")
  ) {
    const escaped = sanitized.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  return sanitized;
}
