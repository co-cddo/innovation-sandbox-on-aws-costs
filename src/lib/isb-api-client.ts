import { InvokeCommand, type InvokeCommandOutput } from "@aws-sdk/client-lambda";
import { LeaseDetailsSchema, type LeaseDetails } from "./schemas.js";
import { getLambdaClient } from "./aws-clients.js";

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

/**
 * Creates a JWT for service-to-service authentication with ISB Lambda.
 * Uses the format expected by ISB Lambda middleware:
 * - Header: {"alg": "HS256", "typ": "JWT"}
 * - Payload: {"user": {"email": "...", "roles": ["Admin"]}}
 * - Signature: "directinvoke" (not verified for direct Lambda invocation)
 */
function createServiceJwt(userEmail: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const payload = Buffer.from(
    JSON.stringify({
      user: {
        email: userEmail,
        roles: ["Admin"],
      },
    })
  )
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${header}.${payload}.directinvoke`;
}

/**
 * Determines if an error is retryable based on status code.
 * Client errors (4xx) should not be retried as they indicate validation failures.
 */
function isRetryableError(statusCode: number): boolean {
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

/**
 * Invokes the ISB Leases Lambda with the given API event.
 * This is the core invocation logic that will be wrapped with retries.
 */
async function invokeLeasesLambda(
  apiEvent: object,
  isbLeasesLambdaArn: string
): Promise<InvokeCommandOutput> {
  const command = new InvokeCommand({
    FunctionName: isbLeasesLambdaArn,
    Payload: Buffer.from(JSON.stringify(apiEvent)),
  });

  const lambdaClient = getLambdaClient();
  return await lambdaClient.send(command);
}

/**
 * Retrieves lease details from the ISB Leases API Lambda function.
 * Implements automatic retry logic with exponential backoff for transient errors (5xx, 429).
 * Client errors (4xx) are not retried as they indicate validation failures.
 *
 * @param leaseIdB64 - Base64-encoded composite lease ID (from encodeLeaseId function)
 * @param userEmail - User email for JWT authentication
 * @param isbLeasesLambdaArn - ARN of the ISB Leases Lambda function
 *
 * @returns Validated lease details including startDate, accountId, and user information
 *
 * @throws {Error} If lease is not found (404)
 * @throws {Error} If API returns client error (4xx) - not retried
 * @throws {Error} If all retry attempts are exhausted after transient errors (5xx, 429)
 * @throws {Error} If response doesn't match LeaseDetails schema
 *
 * @example
 * ```typescript
 * const leaseIdB64 = encodeLeaseId("user@example.com", "550e8400-e29b-41d4-a716-446655440000");
 * const details = await getLeaseDetails(
 *   leaseIdB64,
 *   "user@example.com",
 *   "arn:aws:lambda:us-east-1:123456789012:function:isb-leases-api"
 * );
 * console.log(`Lease started: ${details.startDate}`);
 * console.log(`AWS Account: ${details.accountId}`);
 * ```
 */
export async function getLeaseDetails(
  leaseIdB64: string,
  userEmail: string,
  isbLeasesLambdaArn: string
): Promise<LeaseDetails> {
  const jwt = createServiceJwt(userEmail);

  // Construct API Gateway-style event payload
  const apiEvent = {
    httpMethod: "GET",
    path: `/leases/${leaseIdB64}`,
    pathParameters: {
      leaseId: leaseIdB64,
    },
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    requestContext: {
      httpMethod: "GET",
      path: `/leases/${leaseIdB64}`,
    },
    resource: "/leases/{leaseId}",
    body: null,
    isBase64Encoded: false,
  };

  const maxRetries = 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt - 1);
        console.log(
          `Retrying ISB Lambda invocation (attempt ${attempt + 1}/${maxRetries}) after ${Math.round(delay)}ms for lease ${leaseIdB64}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const response: InvokeCommandOutput = await invokeLeasesLambda(
        apiEvent,
        isbLeasesLambdaArn
      );

      if (response.FunctionError) {
        throw new Error(
          `ISB Leases Lambda invocation failed: ${response.FunctionError}`
        );
      }

      if (!response.Payload) {
        throw new Error("ISB Leases Lambda returned no payload");
      }

      // Parse Lambda response
      const payloadStr = Buffer.from(response.Payload).toString("utf-8");
      const lambdaResponse = JSON.parse(payloadStr);

      // API Gateway Lambda responses have statusCode and body
      if (lambdaResponse.statusCode === 404) {
        throw new Error(`Lease not found: ${leaseIdB64}`);
      }

      if (lambdaResponse.statusCode !== 200) {
        const error = new Error(
          `ISB API error: ${lambdaResponse.statusCode} - ${lambdaResponse.body}`
        );

        // Don't retry client errors (4xx) - these are validation failures
        if (!isRetryableError(lambdaResponse.statusCode)) {
          console.log(
            `Non-retryable error (status ${lambdaResponse.statusCode}) for lease ${leaseIdB64}, skipping retries`
          );
          throw error;
        }

        lastError = error;
        continue;
      }

      // Parse the body (which is a JSON string in JSend format)
      const bodyData =
        typeof lambdaResponse.body === "string"
          ? JSON.parse(lambdaResponse.body)
          : lambdaResponse.body;

      // ISB API uses JSend format: { status: "success", data: {...} }
      const leaseData = bodyData.data || bodyData;

      // Validate against schema
      const parseResult = LeaseDetailsSchema.safeParse(leaseData);
      if (!parseResult.success) {
        throw new Error(
          `Invalid lease details response: ${parseResult.error.message}`
        );
      }

      return parseResult.data;
    } catch (error) {
      lastError = error as Error;

      // If this is a non-retryable error, throw immediately
      if (
        error instanceof Error &&
        (error.message.includes("Lease not found") ||
          error.message.includes("Invalid lease details response"))
      ) {
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
