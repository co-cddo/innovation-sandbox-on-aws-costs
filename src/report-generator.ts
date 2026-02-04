import type { CostReport } from "./types.js";

function formatCurrency(amount: number | string): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return `$${num.toFixed(2)}`;
}

export function generateMarkdownReport(report: CostReport): string {
  const lines: string[] = [];

  // Header
  lines.push("# Cost report");
  lines.push(`accountid ${report.accountId}`);
  lines.push("");

  // Total cost
  lines.push(`## Total cost for period: ${formatCurrency(report.totalCost)}`);
  lines.push("");

  // Cost breakdown table
  lines.push("Cost by resource breakdown:");
  lines.push("| Resource Name | Service | Region | Cost |");
  lines.push("|---------------|---------|--------|------|");

  for (const resource of report.costsByResource) {
    // Only include resources with non-zero costs
    const cost = parseFloat(resource.cost);
    if (cost > 0) {
      lines.push(`| ${resource.resourceName} | ${resource.serviceName} | ${resource.region} | ${formatCurrency(resource.cost)} |`);
    }
  }

  return lines.join("\n");
}
