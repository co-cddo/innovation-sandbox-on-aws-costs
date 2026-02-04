/**
 * Input validation utilities for AWS API response data.
 *
 * AWS Cost Explorer API responses contain user-controlled data (resource names,
 * tags, etc.) that should be treated as untrusted input. These utilities sanitize
 * values to prevent:
 * - Log injection via control characters
 * - Memory exhaustion via extremely long strings
 * - Data corruption via non-printable characters
 */

/**
 * Maximum length for AWS resource names and ARNs.
 * ARNs can be up to 2048 characters per AWS documentation.
 */
const MAX_RESOURCE_NAME_LENGTH = 2048;

/**
 * Maximum length for AWS service names.
 * Service names are typically under 100 characters.
 */
const MAX_SERVICE_NAME_LENGTH = 256;

/**
 * Maximum length for cost amount strings.
 * Reasonable for costs up to trillions with full precision.
 */
const MAX_COST_STRING_LENGTH = 50;

/**
 * Valid AWS region pattern.
 * Matches standard regions (us-east-1) and "global" for region-less services.
 */
const AWS_REGION_REGEX = /^([a-z]{2}-[a-z]+-\d+|global)$/;

/**
 * Valid cost amount pattern.
 * Matches optional negative, digits, optional decimal, digits.
 */
const VALID_COST_REGEX = /^-?\d+(\.\d+)?$/;

/**
 * Control character regex - matches characters that could be used for log injection.
 * Excludes tab (0x09) and newline (0x0A) which are handled by CSV escaping.
 */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F-\x9F]/g;

/**
 * ANSI escape sequence regex - matches terminal control sequences.
 * Covers SGR (colors), cursor movement, and other VT100/ANSI sequences.
 * Must be applied separately from control char regex to handle multi-byte sequences.
 */
const ANSI_ESCAPE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Sanitizes resource names from AWS Cost Explorer API responses.
 *
 * Security Protections:
 * - Length limits (prevents memory exhaustion DoS)
 * - Control character removal (prevents log injection)
 * - Preserves ARN format and common AWS resource name patterns
 *
 * @param rawName - Resource name from AWS API (untrusted)
 * @returns Sanitized resource name safe for CSV/logs/events
 */
export function sanitizeResourceName(rawName: string): string {
  const TRUNCATION_SUFFIX = "...[truncated]";

  if (rawName.length > MAX_RESOURCE_NAME_LENGTH) {
    console.warn(
      `[VALIDATION] Resource name exceeds max length (${rawName.length}), truncating`
    );
    return (
      rawName.substring(0, MAX_RESOURCE_NAME_LENGTH - TRUNCATION_SUFFIX.length) +
      TRUNCATION_SUFFIX
    );
  }

  // Remove ANSI escape sequences first (multi-byte), then individual control characters
  let sanitized = rawName.replace(ANSI_ESCAPE_REGEX, "");
  sanitized = sanitized.replace(CONTROL_CHAR_REGEX, "");

  if (sanitized !== rawName) {
    console.warn(
      `[VALIDATION] Removed ${rawName.length - sanitized.length} control characters from resource name`
    );
  }

  return sanitized;
}

/**
 * Sanitizes service names from AWS Cost Explorer API responses.
 *
 * @param rawName - Service name from AWS API (untrusted)
 * @returns Sanitized service name
 */
export function sanitizeServiceName(rawName: string): string {
  if (rawName.length > MAX_SERVICE_NAME_LENGTH) {
    console.warn(
      `[VALIDATION] Service name exceeds max length (${rawName.length}), truncating`
    );
    return rawName.substring(0, MAX_SERVICE_NAME_LENGTH);
  }

  // Remove control characters
  return rawName.replace(CONTROL_CHAR_REGEX, "");
}

/**
 * Validates and sanitizes region values from AWS Cost Explorer API.
 *
 * @param rawRegion - Region from AWS API (untrusted)
 * @returns Valid AWS region code or "global"
 */
export function sanitizeRegion(rawRegion: string): string {
  const trimmed = rawRegion.trim();

  if (AWS_REGION_REGEX.test(trimmed)) {
    return trimmed;
  }

  // Check for empty/whitespace
  if (!trimmed) {
    return "global";
  }

  console.warn(
    `[VALIDATION] Invalid region format: "${rawRegion}", defaulting to "global"`
  );
  return "global";
}

/**
 * Validates cost amount strings from AWS Cost Explorer API.
 *
 * @param rawAmount - Cost amount from AWS API (untrusted)
 * @returns Validated cost string
 * @throws {Error} If cost format is invalid
 */
export function validateCostAmount(rawAmount: string): string {
  // Check length
  if (rawAmount.length > MAX_COST_STRING_LENGTH) {
    throw new Error(
      `Invalid cost amount: exceeds maximum length of ${MAX_COST_STRING_LENGTH}`
    );
  }

  // Check format
  if (!VALID_COST_REGEX.test(rawAmount)) {
    throw new Error(`Invalid cost amount format: "${rawAmount}"`);
  }

  // Check numeric validity
  const numericValue = parseFloat(rawAmount);
  if (!isFinite(numericValue)) {
    throw new Error(`Cost amount is not finite: "${rawAmount}"`);
  }

  return rawAmount;
}
