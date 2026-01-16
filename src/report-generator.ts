import type { CostReport } from "./types.js";

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
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
  lines.push("Cost by service breakdown:");
  lines.push("| Service | Cost |");
  lines.push("|---------|------|");

  for (const service of report.costsByService) {
    // Only include services with non-zero costs
    if (service.cost > 0) {
      lines.push(`| ${service.serviceName} | ${formatCurrency(service.cost)} |`);
    }
  }

  return lines.join("\n");
}
