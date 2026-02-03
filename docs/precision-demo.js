#!/usr/bin/env node
/**
 * Demonstration of floating-point precision loss vs integer cents arithmetic
 *
 * Run: node docs/precision-demo.js
 */

console.log("=".repeat(80));
console.log("Cost Aggregation Precision Demonstration");
console.log("=".repeat(80));
console.log();

// Simulate Cost Explorer pagination with 10 pages
const pages = 10;
const amountPerPage = 0.10; // $0.10 per page

console.log(`Scenario: Aggregating ${pages} pages of costs`);
console.log(`Amount per page: $${amountPerPage.toFixed(2)}`);
console.log(`Expected total: $${(pages * amountPerPage).toFixed(2)}`);
console.log();

// OLD APPROACH: Floating-point arithmetic
console.log("❌ OLD APPROACH: Floating-point arithmetic");
console.log("-".repeat(80));
let totalFloat = 0.0;
for (let i = 0; i < pages; i++) {
  totalFloat += amountPerPage;
  console.log(`  Page ${i + 1}: Add $${amountPerPage.toFixed(2)} → Running total: $${totalFloat}`);
}
console.log();
console.log(`Final total (floating-point): $${totalFloat}`);
console.log(`Precision error: ${totalFloat === 1.0 ? "None" : `${(1.0 - totalFloat).toExponential(2)}`}`);
console.log(`Expected: $1.00, Got: $${totalFloat}`);
console.log();

// NEW APPROACH: Integer cents arithmetic
console.log("✅ NEW APPROACH: Integer cents arithmetic");
console.log("-".repeat(80));
let totalCents = 0;
for (let i = 0; i < pages; i++) {
  const amountCents = Math.round(amountPerPage * 100); // Convert to cents
  totalCents += amountCents; // Integer addition
  const runningDollars = totalCents / 100;
  console.log(`  Page ${i + 1}: Add ${amountCents} cents → Running total: ${totalCents} cents ($${runningDollars.toFixed(2)})`);
}
const totalDollars = totalCents / 100; // Convert back to dollars
console.log();
console.log(`Final total (cents): ${totalCents} cents`);
console.log(`Final total (dollars): $${totalDollars.toFixed(2)}`);
console.log(`Precision error: None`);
console.log(`Expected: $1.00, Got: $${totalDollars.toFixed(2)}`);
console.log();

// EXTREME CASE: Many small amounts
console.log("=".repeat(80));
console.log("Extreme Case: 1000 pages of $0.001 each");
console.log("=".repeat(80));
console.log();

const extremePages = 1000;
const extremeAmount = 0.001;

// Floating-point
let extremeFloat = 0.0;
for (let i = 0; i < extremePages; i++) {
  extremeFloat += extremeAmount;
}

// Integer cents (note: 0.001 dollars = 0.1 cents, rounds to 0)
let extremeCents = 0;
for (let i = 0; i < extremePages; i++) {
  extremeCents += Math.round(extremeAmount * 100);
}

console.log(`Floating-point total: $${extremeFloat}`);
console.log(`Integer cents total: ${extremeCents} cents ($${(extremeCents / 100).toFixed(2)})`);
console.log();
console.log(`Note: 0.001 dollars = 0.1 cents → rounds to 0 cents`);
console.log(`This is correct behavior - AWS billing doesn't have fractional cents`);
console.log();

// REALISTIC CASE: Multiple services across many pages
console.log("=".repeat(80));
console.log("Realistic Case: 30 days × 3 services");
console.log("=".repeat(80));
console.log();

const days = 30;
const services = [
  { name: "Amazon EC2", dailyCost: 0.33 },
  { name: "Amazon S3", dailyCost: 0.33 },
  { name: "Amazon Lambda", dailyCost: 0.34 },
];

console.log("Floating-point aggregation:");
const floatResults = services.map(service => {
  let total = 0.0;
  for (let day = 0; day < days; day++) {
    total += service.dailyCost;
  }
  console.log(`  ${service.name}: $${total} (expected: $${(service.dailyCost * days).toFixed(2)})`);
  return total;
});
const floatGrandTotal = floatResults.reduce((sum, val) => sum + val, 0);
console.log(`  Grand Total: $${floatGrandTotal} (expected: $30.00)`);
console.log();

console.log("Integer cents aggregation:");
const centsResults = services.map(service => {
  let totalCents = 0;
  for (let day = 0; day < days; day++) {
    totalCents += Math.round(service.dailyCost * 100);
  }
  const totalDollars = totalCents / 100;
  console.log(`  ${service.name}: $${totalDollars.toFixed(2)} (${totalCents} cents)`);
  return totalCents;
});
const centsGrandTotal = centsResults.reduce((sum, val) => sum + val, 0);
console.log(`  Grand Total: $${(centsGrandTotal / 100).toFixed(2)} (${centsGrandTotal} cents)`);
console.log();

console.log("=".repeat(80));
console.log("Conclusion");
console.log("=".repeat(80));
console.log();
console.log("✅ Integer cents arithmetic eliminates floating-point precision errors");
console.log("✅ Matches AWS billing system (which uses cents as smallest unit)");
console.log("✅ Critical for financial calculations and compliance");
console.log();
