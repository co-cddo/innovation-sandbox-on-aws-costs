import { createISBClient, type ISBClient } from "@co-cddo/isb-client";
import { LeaseDetailsSchema, type LeaseDetails } from "./schemas.js";

let isbClient: ISBClient | null = null;

/**
 * Gets or creates the shared ISB client instance.
 * Exported for testing purposes.
 */
export function getISBClient(): ISBClient {
  if (!isbClient) {
    isbClient = createISBClient({
      serviceIdentity: {
        email: "cost-collector@innovation-sandbox.local",
        roles: ["Admin"],
      },
    });
  }
  return isbClient;
}

/**
 * Resets the ISB client singleton (for testing).
 */
export function resetISBClient(): void {
  isbClient = null;
}

/**
 * Retrieves lease details from the ISB API via the shared client library.
 *
 * @param userEmail - User email address associated with the lease
 * @param uuid - Unique identifier (UUID) of the lease
 * @param correlationId - Correlation ID for request tracing
 *
 * @returns Validated lease details including startDate, accountId, and user information
 *
 * @throws {Error} If lease is not found
 * @throws {Error} If ISB API is not configured
 * @throws {Error} If response doesn't match LeaseDetails schema
 */
export async function getLeaseDetails(
  userEmail: string,
  uuid: string,
  correlationId: string,
): Promise<LeaseDetails> {
  const client = getISBClient();
  const result = await client.fetchLeaseByKey(userEmail, uuid, correlationId);

  if (!result) {
    throw new Error(`Lease not found or ISB API error for user ${userEmail}, uuid ${uuid}`);
  }

  // Validate against schema (ISB client returns permissive types; we need strict validation)
  const parseResult = LeaseDetailsSchema.safeParse(result);
  if (!parseResult.success) {
    throw new Error(`Invalid lease details response: ${parseResult.error.message}`);
  }

  return parseResult.data;
}
