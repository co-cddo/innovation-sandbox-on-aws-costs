import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { createHmac } from "node:crypto";
import { LeaseDetailsSchema, type LeaseDetails } from "./schemas.js";
import { getSecretsManagerClient } from "./aws-clients.js";

/**
 * Service identity used in JWT tokens for ISB API authentication.
 * The ISB API Gateway authorizer validates this identity.
 */
const ISB_SERVICE_IDENTITY = {
  email: "ndx+costs@dsit.gov.uk",
  roles: ["Admin"],
} as const;

// =============================================================================
// JWT Signing (zero new dependencies - uses Node.js built-in crypto)
// =============================================================================

/**
 * Sign a JWT with HS256 algorithm using Node.js built-in crypto.
 *
 * Note: `iat` and `exp` claims are always set by this function and will
 * override any values present in the payload object.
 *
 * @param payload - JWT payload object
 * @param secret - HMAC-SHA256 signing secret
 * @param expiresInSeconds - Token TTL (default 3600s / 1 hour)
 * @returns Signed JWT string
 */
export function signJwt(
  payload: object,
  secret: string,
  expiresInSeconds = 3600
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url"
  );
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString(
    "base64url"
  );
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

// =============================================================================
// Token Manager - cached secret and token with rotation resilience
// =============================================================================

let cachedSecret: string | null = null;
let cachedToken: string | null = null;
let tokenExpiry = 0;

/**
 * Fetch JWT signing secret from Secrets Manager.
 */
async function fetchJwtSecret(secretPath: string): Promise<string> {
  const client = getSecretsManagerClient();
  const command = new GetSecretValueCommand({ SecretId: secretPath });
  const response = await client.send(command);
  if (!response.SecretString) {
    throw new Error("JWT secret is empty");
  }
  return response.SecretString;
}

/**
 * Get a valid signed JWT token, re-signing if expired or expiring within 60s.
 *
 * Fetches the signing secret from Secrets Manager on first call and caches it.
 * The token payload uses {@link ISB_SERVICE_IDENTITY} as the service principal.
 *
 * @param jwtSecretPath - Secrets Manager path for the JWT secret
 * @returns Signed JWT string
 */
async function getISBToken(jwtSecretPath: string): Promise<string> {
  if (!cachedSecret) {
    cachedSecret = await fetchJwtSecret(jwtSecretPath);
  }

  const now = Math.floor(Date.now() / 1000);
  if (!cachedToken || now >= tokenExpiry - 60) {
    cachedToken = signJwt({ user: ISB_SERVICE_IDENTITY }, cachedSecret, 3600);
    tokenExpiry = now + 3600;
  }

  return cachedToken;
}

/**
 * Invalidate cached secret and token, forcing re-fetch on next call.
 * Called when the API returns 401/403, indicating possible secret rotation.
 */
function invalidateSecretCache(): void {
  cachedSecret = null;
  cachedToken = null;
  tokenExpiry = 0;
}

/**
 * Reset cached token and secret state (for testing).
 */
export function resetTokenCache(): void {
  cachedSecret = null;
  cachedToken = null;
  tokenExpiry = 0;
}

// =============================================================================
// Lease ID encoding
// =============================================================================

/**
 * Encodes a lease ID as a base64 composite key for the ISB API.
 * Creates a base64-encoded JSON string containing both user email and UUID for unique lease identification.
 *
 * @param userEmail - User email address associated with the lease
 * @param uuid - Unique identifier (UUID) of the lease
 *
 * @returns Base64-encoded JSON string in format: base64({"userEmail":"...","uuid":"..."})
 *
 * @example
 * ```typescript
 * const leaseIdB64 = encodeLeaseId("user@example.com", "550e8400-e29b-41d4-a716-446655440000");
 * // Returns: "eyJ1c2VyRW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwidXVpZCI6IjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMCJ9"
 * ```
 */
export function encodeLeaseId(userEmail: string, uuid: string): string {
  const composite = JSON.stringify({ userEmail, uuid });
  return Buffer.from(composite).toString("base64");
}

// =============================================================================
// Retry helpers
// =============================================================================

/**
 * Error subclass for errors that should not be retried (e.g. 4xx, schema validation).
 */
class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Determines if an HTTP status code is retryable.
 * Server errors (5xx) and rate limiting (429) are retryable.
 * Client errors (4xx) should not be retried as they indicate validation failures.
 */
function isRetryableStatus(statusCode: number): boolean {
  return statusCode >= 500 || statusCode === 429;
}

/**
 * Calculates exponential backoff delay with jitter.
 */
function getBackoffDelay(attempt: number): number {
  const baseDelay = 1000; // 1 second
  const maxDelay = 10000; // 10 seconds
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  // Add jitter to avoid thundering herd
  return delay + Math.random() * 1000;
}

// =============================================================================
// ISB API Client
// =============================================================================

/**
 * Retrieves lease details from the ISB API Gateway.
 * Implements automatic retry logic with exponential backoff for transient errors (5xx, 429).
 * Client errors (4xx) are not retried as they indicate validation failures.
 * On 401/403, invalidates the cached JWT secret to handle secret rotation.
 *
 * @param leaseIdB64 - Base64-encoded composite lease ID (from encodeLeaseId function)
 * @param isbApiBaseUrl - Base URL of the ISB API Gateway
 * @param isbJwtSecretPath - Secrets Manager path for the JWT signing secret
 *
 * @returns Validated lease details including startDate, accountId, and user information
 *
 * @throws {Error} If lease is not found (404)
 * @throws {Error} If API returns non-retryable client error (4xx) - not retried
 * @throws {Error} If all retry attempts are exhausted after transient errors (5xx, 429)
 * @throws {Error} If response doesn't match LeaseDetails schema
 *
 * @example
 * ```typescript
 * const leaseIdB64 = encodeLeaseId("user@example.com", "550e8400-e29b-41d4-a716-446655440000");
 * const details = await getLeaseDetails(
 *   leaseIdB64,
 *   "https://api.example.com",
 *   "/isb/jwt-secret"
 * );
 * console.log(`Lease started: ${details.startDate}`);
 * console.log(`AWS Account: ${details.awsAccountId}`);
 * ```
 */
export async function getLeaseDetails(
  leaseIdB64: string,
  isbApiBaseUrl: string,
  isbJwtSecretPath: string
): Promise<LeaseDetails> {
  const url = `${isbApiBaseUrl}/leases/${encodeURIComponent(leaseIdB64)}`;

  const maxRetries = 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt - 1);
        console.log(
          `Retrying ISB API request (attempt ${attempt + 1}/${maxRetries}) after ${Math.round(delay)}ms for lease ${leaseIdB64}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const token = await getISBToken(isbJwtSecretPath);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      // Invalidate cached secret on auth failures (handles secret rotation)
      if (response.status === 401 || response.status === 403) {
        invalidateSecretCache();
        throw new NonRetryableError(
          `ISB API error: ${response.status} - ${response.statusText}`
        );
      }

      if (response.status === 404) {
        throw new NonRetryableError(`Lease not found: ${leaseIdB64}`);
      }

      if (response.status !== 200) {
        const bodyText = await response.text();
        const error = new Error(
          `ISB API error: ${response.status} - ${bodyText}`
        );

        if (!isRetryableStatus(response.status)) {
          throw new NonRetryableError(error.message);
        }

        lastError = error;
        continue;
      }

      // Parse the response body (JSend format: { status: "success", data: {...} })
      const bodyData = await response.json();
      const leaseData = bodyData.data || bodyData;

      // Validate against schema
      const parseResult = LeaseDetailsSchema.safeParse(leaseData);
      if (!parseResult.success) {
        throw new NonRetryableError(
          `Invalid lease details response: ${parseResult.error.message}`
        );
      }

      return parseResult.data;
    } catch (error) {
      lastError = error as Error;

      // Non-retryable errors are thrown immediately (auth failures, not found, schema errors)
      if (error instanceof NonRetryableError) {
        throw error;
      }

      // If we've exhausted retries, throw the last error
      if (attempt === maxRetries - 1) {
        console.error(
          `All retry attempts exhausted for lease ${leaseIdB64}:`,
          lastError
        );
        throw lastError;
      }

      // Log transient error and continue to next retry
      console.warn(
        `Transient error on attempt ${attempt + 1}/${maxRetries} for lease ${leaseIdB64}:`,
        error
      );
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error("Unknown error during retry loop");
}
