import { AssumeRoleCommand, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { getSTSClient } from "./aws-clients.js";

/**
 * AWS STS credential duration constraints.
 * Minimum and maximum values for AssumeRole DurationSeconds parameter.
 *
 * Reference: https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
 */
const MIN_CREDENTIAL_DURATION_SECONDS = 900; // 15 minutes (AWS minimum)
const MAX_CREDENTIAL_DURATION_SECONDS = 43200; // 12 hours (AWS maximum for standard roles)
const DEFAULT_CREDENTIAL_DURATION_SECONDS = 3600; // 1 hour (maximum for role chaining from Lambda)

/**
 * Assumes an IAM role in another AWS account and returns temporary credentials.
 * Uses AWS STS (Security Token Service) to obtain time-limited credentials for cross-account access.
 *
 * Credential Duration Strategy
 * ----------------------------
 * Default: 7200 seconds (2 hours)
 * - Provides safety margin for Cost Explorer operations that may take 5-10 minutes
 * - Prevents credential expiration during Lambda execution (max 15 min timeout)
 * - Allows for retries and error handling without re-authentication
 *
 * Why 2 hours (not 1 hour)?
 * - Lambda max timeout: 15 minutes
 * - Typical cost collection: 2-5 minutes
 * - Cost Explorer API rate limits may require backoff/retry (adds 1-2 minutes)
 * - Clock skew between services: up to 5 minutes
 * - Safety buffer: 30+ minutes to handle edge cases
 * - Total margin: ~45 minutes buffer (prevents "CredentialsExpired" errors)
 *
 * AWS Constraints
 * ---------------
 * - Minimum: 900 seconds (15 minutes) - AWS STS limit
 * - Maximum: 43200 seconds (12 hours) - AWS STS limit for standard roles
 * - Federated users: 129600 seconds (36 hours) max
 *
 * Security Considerations
 * -----------------------
 * - Shorter durations reduce credential exposure window if leaked
 * - Longer durations reduce API calls to STS (cost and rate limit)
 * - Balance: 2 hours provides operational safety without excessive exposure
 * - Credentials should never be logged or stored persistently
 *
 * @param roleArn - ARN of the IAM role to assume (e.g., "arn:aws:iam::123456789012:role/CostExplorerReadRole")
 * @param durationSeconds - Duration for temporary credentials (900-43200 seconds, default: 7200)
 *
 * @returns Temporary AWS credentials with access key, secret key, session token, and expiration
 *
 * @throws {Error} If durationSeconds is outside valid range (900-43200)
 * @throws {Error} If STS AssumeRole operation fails
 * @throws {Error} If response is missing credentials
 * @throws {Error} If response is missing AccessKeyId or SecretAccessKey
 *
 * @example
 * ```typescript
 * // Use default duration (2 hours)
 * const credentials = await assumeCostExplorerRole(
 *   "arn:aws:iam::123456789012:role/CostExplorerReadRole"
 * );
 *
 * // Specify custom duration (1 hour for quick operations)
 * const quickCredentials = await assumeCostExplorerRole(
 *   "arn:aws:iam::123456789012:role/CostExplorerReadRole",
 *   3600
 * );
 *
 * // Use maximum duration (12 hours for long-running batch jobs)
 * const longCredentials = await assumeCostExplorerRole(
 *   "arn:aws:iam::123456789012:role/CostExplorerReadRole",
 *   43200
 * );
 *
 * // Use credentials with Cost Explorer client
 * const costs = await getCostData(
 *   { accountId: "123456789012", startTime: "2024-01-01", endTime: "2024-02-01" },
 *   { credentials }
 * );
 * ```
 */
export async function assumeCostExplorerRole(
  roleArn: string,
  durationSeconds: number = DEFAULT_CREDENTIAL_DURATION_SECONDS
): Promise<AwsCredentialIdentity> {
  // Validate credential duration against AWS STS constraints
  if (
    durationSeconds < MIN_CREDENTIAL_DURATION_SECONDS ||
    durationSeconds > MAX_CREDENTIAL_DURATION_SECONDS
  ) {
    throw new Error(
      `Invalid credential duration: ${durationSeconds} seconds. ` +
        `Must be between ${MIN_CREDENTIAL_DURATION_SECONDS} (15 min) and ${MAX_CREDENTIAL_DURATION_SECONDS} (12 hours). ` +
        `AWS STS constraints: https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html`
    );
  }

  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    // Session name format: "lease-costs-{millisecond-timestamp}"
    // - Prefix identifies source application in CloudTrail logs
    // - Timestamp ensures uniqueness for concurrent AssumeRole calls
    // - Required by AWS: must be 2-64 chars, alphanumeric + =,.@-_
    // - Example: "lease-costs-1738598400000" (26 chars, well within limit)
    RoleSessionName: `lease-costs-${Date.now()}`,
    DurationSeconds: durationSeconds,
  });

  const stsClient = getSTSClient();
  const response: AssumeRoleCommandOutput = await stsClient.send(command);

  if (!response.Credentials) {
    throw new Error(`Failed to assume role ${roleArn}: No credentials returned`);
  }

  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } =
    response.Credentials;

  if (!AccessKeyId || !SecretAccessKey) {
    throw new Error(
      `Failed to assume role ${roleArn}: Missing AccessKeyId or SecretAccessKey`
    );
  }

  return {
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
    sessionToken: SessionToken,
    expiration: Expiration,
  };
}
