import { z } from "zod";

/**
 * Event Schema Evolution Strategy
 * ================================
 *
 * This module defines Zod schemas for runtime validation of events and payloads.
 * These schemas form contracts between services and must evolve carefully to
 * maintain backward compatibility.
 *
 * Schema Categories
 * -----------------
 * 1. INCOMING EVENTS (full envelope)
 *    - Example: LeaseTerminatedEventSchema
 *    - Validates complete EventBridge envelope (detail-type, source, detail)
 *    - Validates early to catch malformed events before processing
 *    - Evolution: Coordinate with ISB team for changes (external producer)
 *
 * 2. OUTGOING EVENTS (detail-only)
 *    - Example: LeaseCostsGeneratedDetailSchema
 *    - Validates only the `detail` portion (EventBridge constructs envelope)
 *    - Evolution: ALWAYS backward compatible (external consumers depend on us)
 *    - NEVER remove/rename fields, NEVER change types
 *
 * 3. INTERNAL PAYLOADS (strict)
 *    - Example: SchedulerPayloadSchema
 *    - No .passthrough() - we control both producer and consumer
 *    - Evolution: Coordinated deployment required (consumer first, then producer)
 *
 * 4. EXTERNAL API RESPONSES (permissive)
 *    - Example: LeaseDetailsSchema
 *    - Uses .passthrough() to allow unknown fields from ISB API
 *    - Evolution: ISB API may add fields without breaking our code
 *
 * Schema Evolution Guidelines
 * ---------------------------
 * NON-BREAKING CHANGES (safe):
 * - Add optional field: newField: z.string().optional()
 * - Widen validation: z.literal("active") → z.enum(["active", "pending"])
 * - Add enum value: Add "AutoScaled" to termination reasons
 * - Add documentation: Clarify existing field behavior
 *
 * BREAKING CHANGES (requires coordination):
 * - Remove field: Add replacement first, deprecate (6 months), then remove
 * - Rename field: Treat as remove + add (6-month overlap)
 * - Change type: Add new field with new type, deprecate old field
 * - Make required: Ensure all producers set field for 7+ days first
 * - Narrow validation: Add new field with stricter rules, deprecate old field
 *
 * Adding Optional Fields (Safe Process)
 * -------------------------------------
 * 1. Add to schema with .optional():
 *    billingRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional()
 *
 * 2. Update event emitter to include field
 *
 * 3. Deploy and notify consumers (document in CHANGELOG)
 *
 * 4. Wait 30 days before considering making it required
 *
 * Adding Required Fields (Internal Payloads Only)
 * -----------------------------------------------
 * 1. Add as optional with default handling in consumer
 *
 * 2. Deploy consumer Lambda first (handles both old and new)
 *
 * 3. Deploy producer Lambda (starts sending new field)
 *
 * 4. Monitor for 7 days (ensure all old events processed)
 *
 * 5. Make field required (remove .optional())
 *
 * 6. Deploy both Lambdas again
 *
 * Deprecating Fields
 * ------------------
 * 1. Mark field as @deprecated in schema comments (include removal date)
 *
 * 2. Add replacement field alongside deprecated field
 *
 * 3. Emit both fields during 6-month deprecation period
 *
 * 4. Notify all consumers with timeline
 *
 * 5. After 6 months, remove deprecated field (major version bump)
 *
 * Version Detection (Future)
 * --------------------------
 * Currently: Implicit versioning (no explicit version field)
 * If needed: Add schemaVersion field and use discriminated unions
 *
 * Example:
 * ```typescript
 * const SchemaV1 = z.object({ schemaVersion: z.literal("1.0"), ... });
 * const SchemaV2 = z.object({ schemaVersion: z.literal("2.0"), ... });
 * const Schema = z.discriminatedUnion("schemaVersion", [SchemaV1, SchemaV2]);
 * ```
 *
 * Testing Schema Changes
 * ----------------------
 * Before deploying:
 * - Run: npm test -- schemas.test.ts
 * - Test backward compatibility with old payloads
 * - Test migration path with optional fields
 * - Verify all "backward compatibility" tests pass
 *
 * Validation Patterns
 * -------------------
 * - AWS Account IDs: /^\d{12}$/ (exactly 12 digits)
 * - UUIDs: z.string().uuid() (standard UUID format)
 * - Lease UUIDs: UUID v4 format (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
 * - Dates: /^\d{4}-\d{2}-\d{2}$/ (YYYY-MM-DD for Cost Explorer)
 * - ISO timestamps: z.string().datetime() (ISO 8601 with timezone)
 *
 * Related Documentation
 * ---------------------
 * - README.md: "Event Schema Evolution Strategy" section
 * - schemas.test.ts: "Schema Evolution Strategy" test suite
 * - event-emitter.ts: Event emission implementation
 */

/**
 * UUID v4 format validation regex.
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * where x is any hex digit [0-9a-f] and y is one of [8, 9, a, b]
 *
 * This enforces UUID v4 specifically, which is stricter than Zod's built-in
 * uuid() validator that accepts any UUID version.
 *
 * Timing Attack Considerations
 * -----------------------------
 * This regex validation is NOT timing-safe (does not use constant-time comparison).
 * However, this is acceptable for our use case because:
 *
 * 1. **UUIDs are PUBLIC IDENTIFIERS, not secrets:**
 *    - Lease UUIDs appear in logs, EventBridge events, and presigned URLs
 *    - They are not used for authentication (userEmail + ISB Lambda provide auth)
 *    - Knowledge of a valid UUID does not grant access to resources
 *
 * 2. **Significant access barrier for exploitation:**
 *    - Attacker needs EventBridge publish permissions to send test events
 *    - If they have EventBridge permissions, they already have significant access
 *    - The timing attack would only reveal UUID format, not grant authorization
 *
 * 3. **Not used for comparison against known secrets:**
 *    - We validate UUID FORMAT (is it a valid v4 UUID?)
 *    - We do NOT compare against a secret reference UUID
 *    - The regex match is pattern validation, not secret comparison
 *
 * 4. **Defense-in-depth already in place:**
 *    - IAM policies restrict EventBridge access
 *    - ISB Lambda validates user authorization before operations
 *    - Cost Explorer role requires specific trust policy
 *
 * When to Use Timing-Safe Comparison
 * -----------------------------------
 * Use constant-time comparison (see crypto-utils.ts) when:
 * - Comparing authentication tokens or passwords
 * - Validating HMAC signatures or API keys
 * - Checking values where partial knowledge helps an attacker
 * - Comparing against a known secret value
 *
 * Example where timing-safe comparison IS needed:
 * ```typescript
 * import { timingSafeStringEqual } from "./crypto-utils.js";
 *
 * // BAD: Standard comparison leaks information
 * if (providedToken === expectedToken) { ... }
 *
 * // GOOD: Constant-time comparison
 * if (timingSafeStringEqual(providedToken, expectedToken)) { ... }
 * ```
 *
 * Example where timing-safe comparison is NOT needed (this case):
 * ```typescript
 * // UUID format validation (not comparing against a secret)
 * const isValidFormat = UUID_V4_REGEX.test(uuid); // OK - pattern matching
 *
 * // Public identifier matching (not a secret)
 * if (event.detail.leaseId.uuid === storedLeaseId) { ... } // OK - public value
 * ```
 *
 * References
 * ----------
 * - OWASP Timing Attack: https://owasp.org/www-community/attacks/Timing_attack
 * - CWE-208: Observable Timing Discrepancy
 * - src/lib/crypto-utils.ts: Timing-safe comparison utilities
 *
 * @see timingSafeStringEqual in crypto-utils.ts for when to use constant-time comparison
 * @see timingSafeBufferEqual in crypto-utils.ts for comparing binary secrets
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Maximum length for UUID v4 strings (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx).
 * Standard UUID format: 8-4-4-4-12 characters + 4 hyphens = 36 characters
 */
const UUID_V4_MAX_LENGTH = 36;

/**
 * Creates a Zod schema for UUID v4 validation with a custom error message.
 * Used for lease IDs to ensure consistent UUID version across the system.
 *
 * DoS Protection: Rejects inputs exceeding 36 characters before regex validation
 * to prevent ReDoS (Regular Expression Denial of Service) attacks.
 */
const uuidV4Schema = () =>
  z
    .string()
    .max(
      UUID_V4_MAX_LENGTH,
      `UUID must not exceed ${UUID_V4_MAX_LENGTH} characters`
    )
    .uuid() // Basic UUID format check first
    .regex(
      UUID_V4_REGEX,
      "Must be a valid UUID v4 (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)"
    );

/**
 * Maximum length for email addresses per RFC 5321.
 * RFC 5321 specifies: 64 chars (local part) + 1 (@) + 255 chars (domain) = 320 max
 * However, practical limit is 254 chars to be compatible with DNS (RFC 1035) and common implementations.
 */
const EMAIL_MAX_LENGTH = 254;

/**
 * Strict email validation regex.
 * Only allows: alphanumeric, dots, hyphens, underscores, plus signs, @
 * Prevents homograph attacks by rejecting non-ASCII characters.
 *
 * Pattern breakdown:
 * - Local part: [a-zA-Z0-9._%+-]+ (standard email characters)
 * - @ symbol: required separator
 * - Domain: [a-zA-Z0-9.-]+ (alphanumeric, dots, hyphens)
 * - TLD: \.[a-zA-Z]{2,} (at least 2 letter TLD)
 */
const STRICT_EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Creates a Zod schema for strict email validation with security checks.
 * Validates beyond basic email format to prevent injection attacks:
 * - Rejects ANSI escape codes (log injection)
 * - Rejects non-ASCII characters (homograph attacks)
 * - Enforces strict ASCII-only character set
 *
 * DoS Protection: Rejects inputs exceeding 254 characters (RFC 5321 limit)
 * before performing expensive regex validation to prevent ReDoS attacks.
 */
const strictEmailSchema = () =>
  z
    .string()
    .max(
      EMAIL_MAX_LENGTH,
      `Email must not exceed ${EMAIL_MAX_LENGTH} characters (RFC 5321 limit)`
    )
    .email() // Basic email format check first
    .refine(
      (email) => !/\x1B\[[0-9;]*[a-zA-Z]/.test(email),
      "Email contains ANSI escape codes (potential log injection)"
    )
    .refine(
      (email) => !/[^\x20-\x7E]/.test(email),
      "Email contains non-ASCII characters (potential homograph attack)"
    )
    .refine(
      (email) => STRICT_EMAIL_REGEX.test(email),
      "Email format validation failed (only alphanumeric + standard email characters allowed)"
    );

/**
 * INCOMING EVENT: LeaseTerminated
 * ================================
 * Validates the complete EventBridge event envelope for lease termination events.
 *
 * Producer: ISB Leases service (external - we don't control it)
 * Consumer: Scheduler Lambda (this service)
 *
 * Schema Evolution:
 * - CANNOT make breaking changes without coordinating with ISB team
 * - If ISB adds fields we don't care about, they're automatically allowed (no .strict())
 * - If ISB adds fields we need, update schema and deploy before they start sending
 *
 * Example breaking change coordination:
 * - ISB wants to remove "reason" field
 * - Coordinate: ISB adds "terminationReason" field first
 * - We update our schema to accept both fields
 * - ISB deprecates "reason" field (6 months)
 * - We remove "reason" from schema after ISB stops sending it
 *
 * Example non-breaking addition:
 * - ISB adds "terminationMetadata" field
 * - Our schema automatically accepts it (not .strict())
 * - We can start using it by adding it to schema validation
 */
export const LeaseTerminatedEventSchema = z.object({
  "detail-type": z.literal("LeaseTerminated"),
  source: z.string().max(256, "Event source must not exceed 256 characters"),
  detail: z.object({
    leaseId: z.object({
      userEmail: strictEmailSchema(),
      uuid: uuidV4Schema(),
    }),
    accountId: z
      .string()
      .max(12, "AWS Account ID must be exactly 12 digits")
      .regex(/^\d{12}$/),
    reason: z.object({
      type: z.string().max(128, "Termination reason type must not exceed 128 characters"),
    }),
  }),
});

/**
 * INTERNAL PAYLOAD: SchedulerPayload
 * ===================================
 * Validates the payload passed from Scheduler Lambda to Cost Collector Lambda
 * via EventBridge Scheduler.
 *
 * Producer: Scheduler Lambda (this service)
 * Consumer: Cost Collector Lambda (this service)
 *
 * Schema Evolution:
 * - We control both ends, so coordinated deployment is possible
 * - STRICT schema (no .passthrough()) - unknown fields are stripped
 * - Adding required fields requires careful coordination
 *
 * Process for adding optional fields:
 * 1. Add field with .optional(): newField: z.string().optional()
 * 2. Deploy consumer Lambda first (handles old payloads without field)
 * 3. Deploy producer Lambda (starts including field)
 * 4. Monitor for 7 days to ensure no errors
 * 5. (Optional) Make required: newField: z.string()
 *
 * Process for adding required fields:
 * 1. Add as optional with default handling in consumer:
 *    const value = payload.newField ?? calculateDefault();
 * 2. Deploy consumer Lambda first
 * 3. Deploy producer Lambda (includes field)
 * 4. Wait 7 days for all old events to be processed
 * 5. Make field required in schema
 * 6. Remove default handling in consumer
 * 7. Deploy both Lambdas again
 *
 * Example safe addition:
 * ```typescript
 * export const SchedulerPayloadSchema = z.object({
 *   leaseId: uuidV4Schema(),
 *   userEmail: strictEmailSchema(),
 *   accountId: z.string().regex(/^\d{12}$/),
 *   leaseEndTimestamp: z.string().datetime(),
 *   scheduleName: z.string(),
 *
 *   // NEW: Optional field for lease duration (will become required after migration)
 *   leaseDurationDays: z.number().int().positive().optional(),
 * });
 * ```
 */
export const SchedulerPayloadSchema = z.object({
  leaseId: uuidV4Schema(),
  userEmail: strictEmailSchema(),
  accountId: z
    .string()
    .max(12, "AWS Account ID must be exactly 12 digits")
    .regex(/^\d{12}$/),
  leaseEndTimestamp: z
    .string()
    .max(30, "ISO 8601 timestamp must not exceed 30 characters")
    .datetime(),
  scheduleName: z
    .string()
    .max(64, "EventBridge Scheduler name limit is 64 characters"),
});

/**
 * OUTGOING EVENT: LeaseCostsGenerated (detail only)
 * ==================================================
 * Validates only the `detail` portion of the EventBridge event.
 * EventBridge PutEvents API constructs the envelope (source, detail-type) automatically.
 *
 * Producer: Cost Collector Lambda (this service)
 * Consumers: External services (billing dashboard, finance reports, etc.)
 *
 * CRITICAL: ALWAYS BACKWARD COMPATIBLE
 * -------------------------------------
 * This schema forms a public contract with external consumers we don't control.
 * Breaking changes will cause failures in downstream services.
 *
 * NEVER:
 * - Remove fields (consumers may depend on them)
 * - Rename fields (consumers use old names)
 * - Change field types (causes type errors in consumers)
 * - Make optional fields required (old events fail validation)
 * - Narrow validation (old values may not match new constraints)
 *
 * SAFE CHANGES:
 * - Add optional fields: newField: z.string().optional()
 * - Widen validation: z.literal("USD") → z.enum(["USD", "GBP"])
 * - Add documentation: Clarify existing field behavior
 *
 * Process for adding optional fields:
 * 1. Add to schema with .optional():
 *    billingRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional()
 *
 * 2. Update event-emitter.ts to include field:
 *    Detail: JSON.stringify({ ...existingFields, billingRegion: "us-east-1" })
 *
 * 3. Deploy producer (this service)
 *
 * 4. Notify consumers via email/Slack:
 *    - Document new field in CHANGELOG
 *    - Provide example usage
 *    - Clarify it's optional (old consumers still work)
 *
 * 5. Wait 30 days before considering making it required
 *
 * Process for deprecating fields (requires major version bump):
 * 1. Add replacement field alongside deprecated field:
 *    currency: z.literal("USD"), // @deprecated - use currencyCode (remove 2026-08-01)
 *    currencyCode: z.enum(["USD", "GBP", "EUR"]).default("USD"),
 *
 * 2. Emit both fields during 6-month deprecation period
 *
 * 3. Notify all consumers with removal date
 *
 * 4. After 6 months, remove deprecated field (major version bump: v2.0)
 *
 * Example safe addition:
 * ```typescript
 * export const LeaseCostsGeneratedDetailSchema = z.object({
 *   leaseId: uuidV4Schema(),
 *   accountId: z.string().regex(/^\d{12}$/),
 *   totalCost: z.number().nonnegative(),
 *   currency: z.literal("USD"),
 *   startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 *   endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 *   csvUrl: z.string().url(),
 *   urlExpiresAt: z.string().datetime(),
 *
 *   // NEW: Optional field for AWS region (safe to add)
 *   billingRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional(),
 * });
 * ```
 *
 * Idempotency Requirements
 * -------------------------
 * Events with this schema may be delivered multiple times for the same lease.
 * This is expected behavior due to:
 * - EventBridge's at-least-once delivery guarantee
 * - Concurrent Lambda invocations
 * - Lambda retry behavior
 *
 * CONSUMER REQUIREMENTS:
 * All consumers MUST implement idempotent processing using the `leaseId` field
 * for deduplication. Example patterns:
 * - Check if leaseId already processed before taking action
 * - Use database unique constraints on leaseId
 * - Use DynamoDB conditional writes to ensure exactly-once processing
 *
 * Example consumer implementation:
 * ```typescript
 * const alreadyProcessed = await checkIfProcessed(event.detail.leaseId);
 * if (alreadyProcessed) {
 *   console.log(`Duplicate event for lease ${event.detail.leaseId}, skipping`);
 *   return;
 * }
 * await processEvent(event.detail);
 * await markAsProcessed(event.detail.leaseId);
 * ```
 *
 * @see emitLeaseCostsGenerated in event-emitter.ts
 * @see Test case "should emit duplicate events on concurrent invocations" in cost-collector-handler.test.ts
 */
export const LeaseCostsGeneratedDetailSchema = z.object({
  leaseId: uuidV4Schema(), // PRIMARY KEY: Use for deduplication in consumers
  userEmail: strictEmailSchema(), // Recipient email for notification delivery
  accountId: z
    .string()
    .max(12, "AWS Account ID must be exactly 12 digits")
    .regex(/^\d{12}$/),
  totalCost: z.number().nonnegative(),
  currency: z.literal("USD"),
  startDate: z
    .string()
    .max(10, "Date format YYYY-MM-DD is exactly 10 characters")
    .regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z
    .string()
    .max(10, "Date format YYYY-MM-DD is exactly 10 characters")
    .regex(/^\d{4}-\d{2}-\d{2}$/),
  csvUrl: z
    .string()
    .max(2048, "S3 presigned URL must not exceed 2048 characters")
    .url(),
  urlExpiresAt: z
    .string()
    .max(30, "ISO 8601 timestamp must not exceed 30 characters")
    .datetime(),
});

/**
 * EXTERNAL API RESPONSE: LeaseDetails
 * ====================================
 * Validates the response from ISB API: GET /leases/{leaseId}
 *
 * Producer: ISB Leases API (external - we don't control it)
 * Consumer: Cost Collector Lambda (this service)
 *
 * Schema Evolution:
 * - Uses .passthrough() to allow unknown fields from ISB API
 * - ISB API may evolve independently, adding new fields
 * - We only validate fields we actually use
 * - New ISB fields automatically allowed (won't break our code)
 *
 * When to update this schema:
 * - ISB adds a new field we want to use: Add field to schema, deploy, start using it
 * - ISB deprecates a field we use: Add fallback logic, test with old and new responses
 * - ISB removes a field we use: Coordinate with ISB team before they deploy
 *
 * Example: ISB adds "region" field
 * ```typescript
 * export const LeaseDetailsSchema = z
 *   .object({
 *     startDate: z.string().datetime(),
 *     expirationDate: z.string().datetime(),
 *     awsAccountId: z.string().regex(/^\d{12}$/),
 *     status: z.string(),
 *
 *     // NEW: ISB added this field, we want to use it
 *     region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional(),
 *   })
 *   .passthrough(); // Still allow other unknown fields
 * ```
 *
 * Example: ISB deprecates "status" field
 * ```typescript
 * // Add fallback logic in code:
 * const status = leaseDetails.status ?? leaseDetails.state ?? "unknown";
 * ```
 */
export const LeaseDetailsSchema = z
  .object({
    startDate: z
      .string()
      .max(30, "ISO 8601 timestamp must not exceed 30 characters")
      .datetime(),
    expirationDate: z
      .string()
      .max(30, "ISO 8601 timestamp must not exceed 30 characters")
      .datetime(),
    awsAccountId: z
      .string()
      .max(12, "AWS Account ID must be exactly 12 digits")
      .regex(/^\d{12}$/),
    status: z
      .string()
      .max(64, "Lease status must not exceed 64 characters"),
  })
  .passthrough(); // Allow unknown fields from ISB API

// Inferred TypeScript types
export type LeaseTerminatedEvent = z.infer<typeof LeaseTerminatedEventSchema>;
export type SchedulerPayload = z.infer<typeof SchedulerPayloadSchema>;
export type LeaseCostsGeneratedDetail = z.infer<
  typeof LeaseCostsGeneratedDetailSchema
>;
export type LeaseDetails = z.infer<typeof LeaseDetailsSchema>;
