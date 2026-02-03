/**
 * Calculates the billing window for a lease with padding and day boundary rounding.
 * Expands the time range by the specified padding hours and rounds to UTC day boundaries
 * (start rounded down to 00:00:00, end rounded up to next 00:00:00).
 *
 * This ensures complete cost data capture for leases that may span partial days
 * and accounts for potential delays in AWS cost data availability.
 *
 * @param leaseStartDate - ISO 8601 timestamp when the lease started (from ISB API)
 * @param leaseEndTimestamp - ISO 8601 timestamp when the lease ended (event receipt time)
 * @param paddingHours - Hours to expand the window in both directions (typically 8 hours)
 *
 * @returns Object containing start and end dates in YYYY-MM-DD format for Cost Explorer API
 * @returns {string} startDate - Start of billing window (rounded down to day boundary)
 * @returns {string} endDate - End of billing window (rounded up to next day boundary)
 *
 * @throws {Error} If leaseStartDate is not a valid ISO 8601 timestamp
 * @throws {Error} If leaseEndTimestamp is not a valid ISO 8601 timestamp
 *
 * @example
 * ```typescript
 * // Lease ran from Jan 15 14:30 to Jan 20 09:45
 * const window = calculateBillingWindow(
 *   "2024-01-15T14:30:00Z",
 *   "2024-01-20T09:45:00Z",
 *   8 // 8 hours padding
 * );
 * // Result: { startDate: "2024-01-15", endDate: "2024-01-21" }
 * // Captures full days: Jan 15 (padded start at 06:30) through Jan 21 (padded end at 17:45)
 * ```
 */
export function calculateBillingWindow(
  leaseStartDate: string,
  leaseEndTimestamp: string,
  paddingHours: number
): { startDate: string; endDate: string } {
  const startMs = Date.parse(leaseStartDate);
  const endMs = Date.parse(leaseEndTimestamp);

  if (isNaN(startMs)) {
    throw new Error(`Invalid leaseStartDate: ${leaseStartDate}`);
  }
  if (isNaN(endMs)) {
    throw new Error(`Invalid leaseEndTimestamp: ${leaseEndTimestamp}`);
  }

  const paddingMs = paddingHours * 60 * 60 * 1000;

  // Apply padding: expand start earlier, expand end later
  const paddedStartMs = startMs - paddingMs;
  const paddedEndMs = endMs + paddingMs;

  // Round start down to day boundary (00:00:00 UTC)
  const startDate = new Date(paddedStartMs);
  startDate.setUTCHours(0, 0, 0, 0);

  // Round end up to next day boundary (00:00:00 UTC of next day)
  // Use Math.ceil to elegantly round up to next day boundary:
  // 1. Divide by milliseconds per day to get fractional days
  // 2. Math.ceil rounds up to next integer day
  // 3. Multiply back to get milliseconds at midnight
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const endDays = Math.ceil(paddedEndMs / MS_PER_DAY);
  const endDate = new Date(endDays * MS_PER_DAY);

  return {
    startDate: formatDateString(startDate),
    endDate: formatDateString(endDate),
  };
}

/**
 * Formats a Date object to YYYY-MM-DD string in UTC.
 * This is the format required by the Cost Explorer API.
 *
 * @param date - Date to format
 * @returns Date string in YYYY-MM-DD format
 */
export function formatDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
