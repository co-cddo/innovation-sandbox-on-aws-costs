/**
 * Structured logging module with JSON output for CloudWatch Logs.
 * Provides context-aware logging with support for CloudWatch Insights queries.
 *
 * @module logger
 *
 * @example
 * ```typescript
 * // Create a logger with context
 * const logger = createLogger({
 *   component: "CostCollectorLambda",
 *   leaseId: "550e8400-e29b-41d4-a716-446655440000",
 *   accountId: "123456789012"
 * });
 *
 * // Log with automatic context
 * logger.info("Starting cost collection", { startDate: "2024-01-01" });
 * // Output: {"timestamp":"2024-01-01T12:00:00.000Z","level":"INFO","component":"CostCollectorLambda","leaseId":"550e8400...","message":"Starting cost collection","startDate":"2024-01-01"}
 *
 * // Log warnings and errors
 * logger.warn("Pagination stopped at max pages", { pageCount: 50 });
 * logger.error("Failed to assume role", error, { roleArn: "arn:aws:iam::..." });
 * ```
 *
 * CloudWatch Insights query examples:
 * ```
 * # Find all errors for a specific lease
 * fields @timestamp, message, error
 * | filter level = "ERROR" and leaseId = "550e8400-..."
 * | sort @timestamp desc
 *
 * # Analyze cost collection duration by component
 * fields @timestamp, component, duration
 * | filter message = "Cost collection completed"
 * | stats avg(duration), max(duration) by component
 * ```
 */

/**
 * Log level enumeration.
 */
export type LogLevel = "INFO" | "WARN" | "ERROR";

/**
 * Context fields that persist across all log entries for a logger instance.
 */
export interface LogContext {
  /**
   * Component or Lambda function name (e.g., "CostCollectorLambda", "SchedulerLambda").
   */
  component: string;

  /**
   * Optional lease UUID for correlation across logs.
   */
  leaseId?: string;

  /**
   * Optional AWS account ID for correlation.
   */
  accountId?: string;

  /**
   * Optional schedule name for scheduler-related logs.
   */
  scheduleName?: string;

  /**
   * Any additional context fields.
   */
  [key: string]: string | number | boolean | undefined;
}

/**
 * Additional fields to include in a specific log entry.
 */
export interface LogFields {
  [key: string]: string | number | boolean | null | undefined | Error;
}

/**
 * Structured log entry format.
 */
interface LogEntry extends LogContext {
  timestamp: string;
  level: LogLevel;
  message: string;
  error?: string;
  errorStack?: string;
}

/**
 * Logger interface with context-aware logging methods.
 */
export interface Logger {
  /**
   * Log an informational message with optional additional fields.
   *
   * @param message - Human-readable log message
   * @param fields - Optional additional fields to include in log entry
   *
   * @example
   * ```typescript
   * logger.info("Cost collection started", { startDate: "2024-01-01" });
   * ```
   */
  info(message: string, fields?: LogFields): void;

  /**
   * Log a warning message with optional additional fields.
   *
   * @param message - Human-readable warning message
   * @param fields - Optional additional fields to include in log entry
   *
   * @example
   * ```typescript
   * logger.warn("Approaching Lambda timeout", { remainingMs: 5000 });
   * ```
   */
  warn(message: string, fields?: LogFields): void;

  /**
   * Log an error message with optional Error object and additional fields.
   *
   * @param message - Human-readable error message
   * @param error - Optional Error object (stack trace will be included)
   * @param fields - Optional additional fields to include in log entry
   *
   * @example
   * ```typescript
   * try {
   *   await riskyOperation();
   * } catch (error) {
   *   logger.error("Operation failed", error as Error, { operationId: "123" });
   * }
   * ```
   */
  error(message: string, error?: Error, fields?: LogFields): void;
}

/**
 * Formats and outputs a structured JSON log entry to stdout.
 * CloudWatch Logs automatically captures stdout from Lambda functions.
 *
 * @param entry - Complete log entry with all fields
 */
function writeLogEntry(entry: LogEntry): void {
  // Use JSON.stringify for consistent formatting
  // CloudWatch Logs will parse this as structured JSON
  console.log(JSON.stringify(entry));
}

/**
 * Creates a logger instance with persistent context fields.
 * All log entries from this logger will include the provided context.
 *
 * @param context - Context fields to include in all log entries
 * @returns Logger instance with info, warn, and error methods
 *
 * @example
 * ```typescript
 * const logger = createLogger({
 *   component: "CostCollectorLambda",
 *   leaseId: "550e8400-e29b-41d4-a716-446655440000",
 *   accountId: "123456789012"
 * });
 * ```
 */
export function createLogger(context: LogContext): Logger {
  return {
    info(message: string, fields?: LogFields): void {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "INFO",
        ...context,
        message,
        ...extractFields(fields),
      };
      writeLogEntry(entry);
    },

    warn(message: string, fields?: LogFields): void {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "WARN",
        ...context,
        message,
        ...extractFields(fields),
      };
      writeLogEntry(entry);
    },

    error(message: string, error?: Error, fields?: LogFields): void {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "ERROR",
        ...context,
        message,
        ...extractFields(fields),
      };

      // Add error details if Error object provided
      if (error) {
        entry.error = error.message;
        if (error.stack) {
          entry.errorStack = error.stack;
        }
      }

      writeLogEntry(entry);
    },
  };
}

/**
 * Extracts and sanitizes fields for logging.
 * Converts Error objects to strings and filters out undefined values.
 *
 * @param fields - Optional fields to extract
 * @returns Sanitized fields object
 */
function extractFields(
  fields?: LogFields
): Record<string, string | number | boolean | null> {
  if (!fields) {
    return {};
  }

  const sanitized: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue; // Skip undefined values
    }

    if (value instanceof Error) {
      sanitized[key] = value.message;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
