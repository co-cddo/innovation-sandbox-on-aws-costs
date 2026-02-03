/**
 * Context information for environment variable validation.
 * Provides human-readable information about where and why a variable is needed.
 */
export interface EnvContext {
  /** Component name (e.g., "Cost Collector Lambda", "Scheduler Handler") */
  component: string;
  /** Purpose description (e.g., "to assume Cost Explorer role", "for event emission") */
  purpose: string;
}

/**
 * Validates that a required environment variable exists and returns its value.
 * Used for mandatory configuration that must be present at runtime.
 *
 * @param name - Environment variable name (e.g., "AWS_REGION", "EVENT_BUS_NAME")
 * @param context - Optional context for better error messages
 *
 * @returns The environment variable value (non-empty string)
 *
 * @throws {Error} If the environment variable is not set or empty
 *
 * @example
 * ```typescript
 * // Require mandatory configuration without context
 * const eventBusName = requireEnv("EVENT_BUS_NAME");
 *
 * // Require with context for better debugging
 * const roleArn = requireEnv("COST_EXPLORER_ROLE_ARN", {
 *   component: "Cost Collector Lambda",
 *   purpose: "to assume Cost Explorer role in orgManagement account"
 * });
 *
 * // Error without context:
 * // Error: EVENT_BUS_NAME environment variable is required
 *
 * // Error with context:
 * // Error: Cost Collector Lambda requires COST_EXPLORER_ROLE_ARN to assume Cost Explorer role in orgManagement account
 * ```
 */
export function requireEnv(name: string, context?: EnvContext): string {
  const value = process.env[name];
  if (!value) {
    const errorMessage = context
      ? `${context.component} requires ${name} ${context.purpose}`
      : `${name} environment variable is required`;
    throw new Error(errorMessage);
  }
  return value;
}

/**
 * Parses and validates an integer environment variable with optional bounds checking.
 * Provides a default value if the environment variable is not set.
 *
 * @param name - Environment variable name (e.g., "PRESIGNED_URL_EXPIRY_DAYS")
 * @param defaultValue - Default value to use if environment variable is not set
 * @param min - Optional minimum allowed value (inclusive)
 * @param max - Optional maximum allowed value (inclusive)
 *
 * @returns The parsed and validated integer value
 *
 * @throws {Error} If the value is not a valid integer
 * @throws {Error} If the value is less than min (when specified)
 * @throws {Error} If the value is greater than max (when specified)
 *
 * @example
 * ```typescript
 * // Parse with default and bounds
 * const expiryDays = parseIntEnv("PRESIGNED_URL_EXPIRY_DAYS", 7, 1, 365);
 * // If env var not set: returns 7
 * // If env var = "30": returns 30
 * // If env var = "0": throws Error (below min of 1)
 * // If env var = "400": throws Error (above max of 365)
 * // If env var = "abc": throws Error (not an integer)
 * ```
 *
 * @example
 * ```typescript
 * // Parse with default only (no bounds)
 * const paddingHours = parseIntEnv("BILLING_PADDING_HOURS", 8);
 * ```
 */
export function parseIntEnv(
  name: string,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  const raw = process.env[name];
  const value = raw ? parseInt(raw, 10) : defaultValue;

  if (isNaN(value)) {
    throw new Error(`Invalid ${name}: ${raw}. Must be a valid integer.`);
  }

  if (min !== undefined && value < min) {
    throw new Error(`Invalid ${name}: ${value}. Must be at least ${min}.`);
  }

  if (max !== undefined && value > max) {
    throw new Error(`Invalid ${name}: ${value}. Must be at most ${max}.`);
  }

  return value;
}
