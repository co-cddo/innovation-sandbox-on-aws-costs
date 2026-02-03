import { describe, it, expect } from "vitest";
import {
  LeaseTerminatedEventSchema,
  SchedulerPayloadSchema,
  LeaseCostsGeneratedDetailSchema,
  LeaseDetailsSchema,
} from "./schemas.js";

/**
 * Contract Tests for Event Schemas
 * =================================
 *
 * These tests verify EventBridge event contracts and ensure backward compatibility.
 * They validate that:
 * 1. Current event payloads parse correctly
 * 2. Old events (schema v1) still work
 * 3. New events with additional fields work
 * 4. Required fields are enforced
 * 5. Field constraints (format, type) are validated
 *
 * Schema Evolution Strategy
 * -------------------------
 * INCOMING EVENTS (LeaseTerminatedEvent):
 *   - External events from ISB - we CANNOT control the producer
 *   - Breaking changes require coordination with ISB team
 *   - Add .passthrough() if ISB may add fields we don't care about
 *   - Document required fields and formats in this test suite
 *
 * INTERNAL PAYLOADS (SchedulerPayload):
 *   - We control both producer (Scheduler Lambda) and consumer (Cost Collector)
 *   - Schema changes require COORDINATED DEPLOYMENT:
 *     1. Add new optional field to schema with .optional()
 *     2. Deploy consumer first (can handle both old and new)
 *     3. Deploy producer to start sending new field
 *     4. Make field required (remove .optional())
 *   - NEVER make breaking changes without this process
 *
 * OUTGOING EVENTS (LeaseCostsGeneratedDetail):
 *   - We produce, external systems consume
 *   - ALWAYS BACKWARD COMPATIBLE: new fields must be optional
 *   - NEVER remove or rename fields
 *   - NEVER change field types or constraints
 *   - Document all changes in CHANGELOG for downstream consumers
 *
 * EXTERNAL API RESPONSES (LeaseDetails):
 *   - ISB API may evolve independently
 *   - Uses .passthrough() to allow unknown fields
 *   - Only validate fields we actually use
 *   - If ISB adds fields, our code continues to work
 *
 * Version Detection
 * -----------------
 * Currently no explicit versioning. If needed in future:
 * - Add optional `schemaVersion` field (default: "1.0")
 * - Use discriminated unions: z.discriminatedUnion("schemaVersion", [...])
 * - Maintain parsers for all supported versions
 * - Deprecate old versions with 6-month notice period
 */

describe("LeaseTerminatedEventSchema", () => {
  describe("valid payloads", () => {
    it("should validate a complete LeaseTerminated event", () => {
      const validEvent = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
          reason: {
            type: "UserRequested",
          },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(validEvent);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.detail.leaseId.uuid).toBe(
          "550e8400-e29b-41d4-a716-446655440000"
        );
        expect(result.data.detail.accountId).toBe("123456789012");
      }
    });

    it("should accept different reason types", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
          reason: {
            type: "AutoExpired",
          },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it("should accept events from different sources", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.test.leases", // Different source for testing
        detail: {
          leaseId: {
            userEmail: "test@example.gov.uk",
            uuid: "650e8400-e29b-41d4-a716-446655440001",
          },
          accountId: "987654321098",
          reason: {
            type: "AdminTerminated",
          },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    it("should accept events with extra unknown fields in detail (nested object allows extras)", () => {
      const eventWithExtraFields = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
          reason: {
            type: "UserRequested",
          },
          // Extra fields that ISB might add in future
          newField: "some-value",
          terminationMetadata: {
            timestamp: "2026-02-03T10:00:00Z",
            requestedBy: "admin@example.com",
          },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(eventWithExtraFields);
      // PASSES because detail is defined as z.object({...}) which by default
      // allows extra properties. This is good - allows ISB to add fields without breaking us.
      expect(result.success).toBe(true);
    });

    it("should accept events with extra fields in reason (nested object allows extras)", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
          reason: {
            type: "UserRequested",
            // Extra fields in reason object
            requestedAt: "2026-02-03T10:00:00Z",
            requestedBy: "user@example.com",
          },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      // Passes because reason is defined as z.object({ type: z.string() })
      // which by default allows extra properties
      expect(result.success).toBe(true);
    });
  });

  describe("required fields enforcement", () => {
    it("should reject event without detail-type", () => {
      const event = {
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("detail-type");
      }
    });

    it("should reject event with wrong detail-type", () => {
      const event = {
        "detail-type": "LeaseCreated", // Wrong type
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("LeaseTerminated");
      }
    });

    it("should reject event without leaseId", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("leaseId");
      }
    });

    it("should reject event without accountId", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("accountId");
      }
    });

    it("should reject event without reason", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("reason");
      }
    });
  });

  describe("field constraints", () => {
    it("should reject invalid email format", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "not-an-email", // Invalid email
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual([
          "detail",
          "leaseId",
          "userEmail",
        ]);
      }
    });

    it("should reject invalid UUID format", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "not-a-uuid", // Invalid UUID
          },
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["detail", "leaseId", "uuid"]);
      }
    });

    it("should reject invalid AWS account ID (too short)", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "12345", // Too short
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("accountId");
      }
    });

    it("should reject invalid AWS account ID (contains letters)", () => {
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid: "550e8400-e29b-41d4-a716-446655440000",
          },
          accountId: "12345678901A", // Contains letter
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("accountId");
      }
    });

    it("should accept valid UUID v4 formats (lowercase)", () => {
      const validUUIDs = [
        "550e8400-e29b-41d4-a716-446655440000",
        "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "a1b2c3d4-e5f6-4789-a012-3456789abcde",
      ];

      validUUIDs.forEach((uuid) => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb.leases",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid,
            },
            accountId: "123456789012",
            reason: { type: "UserRequested" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    it("should accept valid UUID v4 formats (uppercase)", () => {
      const uuid = "A1B2C3D4-E5F6-4789-A012-3456789ABCDE";
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid,
          },
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it("should accept UUID v4 with all valid variant values (8, 9, a, b)", () => {
      const validVariants = [
        "550e8400-e29b-41d4-8716-446655440000",
        "550e8400-e29b-41d4-9716-446655440000",
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-b716-446655440000",
      ];

      validVariants.forEach((uuid) => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb.leases",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid,
            },
            accountId: "123456789012",
            reason: { type: "UserRequested" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    it("should reject UUID v1 format (wrong version)", () => {
      // UUID v1 has '1' in version position instead of '4'
      const uuid = "550e8400-e29b-11d4-a716-446655440000";
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid,
          },
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["detail", "leaseId", "uuid"]);
        expect(result.error.issues[0].message).toContain("UUID v4");
      }
    });

    it("should reject UUID with invalid variant (not 8, 9, a, or b)", () => {
      // Invalid variant 'c' in position 19 (should be 8, 9, a, or b)
      const uuid = "550e8400-e29b-41d4-c716-446655440000";
      const event = {
        "detail-type": "LeaseTerminated",
        source: "isb.leases",
        detail: {
          leaseId: {
            userEmail: "user@example.com",
            uuid,
          },
          accountId: "123456789012",
          reason: { type: "UserRequested" },
        },
      };

      const result = LeaseTerminatedEventSchema.safeParse(event);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["detail", "leaseId", "uuid"]);
        expect(result.error.issues[0].message).toContain("Invalid UUID");
      }
    });
  });
});

describe("SchedulerPayloadSchema", () => {
  describe("valid payloads", () => {
    it("should validate a complete scheduler payload", () => {
      const validPayload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400-e29b-41d4-a716-446655440000",
      };

      const result = SchedulerPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.leaseId).toBe("550e8400-e29b-41d4-a716-446655440000");
        expect(result.data.accountId).toBe("123456789012");
      }
    });

    it("should accept ISO 8601 timestamp with Z suffix", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z", // With Z suffix
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("should accept sanitized schedule names", () => {
      const sanitizedNames = [
        "lease-costs-550e8400",
        "lease-costs-550e8400-e29b",
        "lease-costs.550e8400_e29b",
        "lease-costs-550e8400.e29b_41d4",
      ];

      sanitizedNames.forEach((scheduleName) => {
        const payload = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          leaseEndTimestamp: "2026-02-03T10:00:00Z",
          scheduleName,
        };

        const result = SchedulerPayloadSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });
    });
  });

  describe("backward compatibility", () => {
    it("should accept payloads with extra unknown fields (default Zod behavior)", () => {
      const payloadWithExtraFields = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
        // Extra fields that might be added in future
        newField: "value",
        metadata: { version: "2.0" },
      };

      const result = SchedulerPayloadSchema.safeParse(payloadWithExtraFields);
      // PASSES because Zod z.object() by default uses .strip() mode which silently removes unknown fields
      // This is actually safe - consumer gets only the validated fields it expects
      expect(result.success).toBe(true);
      if (result.success) {
        // Extra fields are stripped, not included in parsed data
        expect(result.data).not.toHaveProperty("newField");
        expect(result.data).not.toHaveProperty("metadata");
      }
    });
  });

  describe("required fields enforcement", () => {
    it("should reject payload without leaseId", () => {
      const payload = {
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("leaseId");
      }
    });

    it("should reject payload without userEmail", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("userEmail");
      }
    });

    it("should reject payload without accountId", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("accountId");
      }
    });

    it("should reject payload without leaseEndTimestamp", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("leaseEndTimestamp");
      }
    });

    it("should reject payload without scheduleName", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("scheduleName");
      }
    });
  });

  describe("field constraints", () => {
    it("should reject invalid UUID format", () => {
      const payload = {
        leaseId: "not-a-uuid",
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("leaseId");
      }
    });

    it("should reject invalid email format", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "not-an-email",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("userEmail");
      }
    });

    it("should reject invalid account ID format", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "invalid",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("accountId");
      }
    });

    it("should reject invalid ISO 8601 timestamp", () => {
      const payload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03", // Date only, not ISO 8601 datetime
        scheduleName: "lease-costs-550e8400",
      };

      const result = SchedulerPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("leaseEndTimestamp");
      }
    });
  });

  describe("migration path example", () => {
    /**
     * Example: Adding a new optional field for schema evolution
     *
     * Step 1: Add field as optional in schema
     *   newOptionalField: z.string().optional()
     *
     * Step 2: Deploy consumer (Cost Collector) - can handle both old and new
     *
     * Step 3: Deploy producer (Scheduler) - starts sending new field
     *
     * Step 4 (optional): Make field required after all events processed
     *   newOptionalField: z.string() // Remove .optional()
     */
    it("demonstrates handling payloads with optional fields", () => {
      // Old payload (v1) - missing new optional field
      const oldPayload = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        leaseEndTimestamp: "2026-02-03T10:00:00Z",
        scheduleName: "lease-costs-550e8400",
      };

      // New payload (v2) - includes new optional field
      const newPayload = {
        ...oldPayload,
        // Example new optional field (not currently in schema)
        // schemaVersion: "2.0"
      };

      // Both should parse successfully - Zod strips unknown fields by default
      const oldResult = SchedulerPayloadSchema.safeParse(oldPayload);
      expect(oldResult.success).toBe(true);

      // New payload with extra field also passes - extra field is stripped
      const newResult = SchedulerPayloadSchema.safeParse(newPayload);
      expect(newResult.success).toBe(true);
      if (newResult.success) {
        // Verify extra field is stripped
        expect(newResult.data).not.toHaveProperty("schemaVersion");
      }
    });
  });
});

describe("LeaseCostsGeneratedDetailSchema", () => {
  describe("valid payloads", () => {
    it("should validate a complete LeaseCostsGenerated detail", () => {
      const validDetail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(validDetail);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.leaseId).toBe("550e8400-e29b-41d4-a716-446655440000");
        expect(result.data.userEmail).toBe("user@example.com");
        expect(result.data.totalCost).toBe(125.45);
        expect(result.data.currency).toBe("USD");
      }
    });

    it("should accept zero total cost", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 0,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(true);
    });

    it("should accept very small costs (penny precision)", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 0.01,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(true);
    });

    it("should accept large costs", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 9999.99,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(true);
    });

    it("should accept presigned URLs from different S3 regions", () => {
      const urls = [
        "https://s3.us-west-2.amazonaws.com/bucket/550e8400.csv",
        "https://s3.eu-west-1.amazonaws.com/bucket/550e8400.csv",
        "https://bucket.s3.amazonaws.com/550e8400.csv",
      ];

      urls.forEach((csvUrl) => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          totalCost: 125.45,
          currency: "USD",
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl,
          urlExpiresAt: "2026-02-10T10:00:00Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(true);
      });
    });

    it("should accept various valid email formats", () => {
      const validEmails = [
        "user@example.com",
        "user.name@example.com",
        "user+tag@example.co.uk",
        "user_name@example.com",
        "user-name@example-domain.com",
        "123@example.com",
        "a@b.co",
        // Edge cases for character distribution
        "verylonglocal" + "x".repeat(50) + "@example.com", // Long local part
        "user@" + "subdomain.".repeat(10) + "example.com", // Long domain
        "a.b.c.d.e@x.y.z.com", // Multiple dots
        "user+tag1+tag2+tag3@example.com", // Multiple plus signs
      ];

      validEmails.forEach((userEmail) => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail,
          accountId: "123456789012",
          totalCost: 125.45,
          currency: "USD",
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
          urlExpiresAt: "2026-02-10T10:00:00Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(true);
      });
    });
  });

  describe("backward compatibility", () => {
    it("should REJECT events without userEmail (breaking change - no existing consumers)", () => {
      // This is a BREAKING CHANGE: userEmail is now required
      // Safe because no consumers exist yet (confirmed in tech spec)
      const detailWithoutUserEmail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        // userEmail: missing - this should FAIL
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detailWithoutUserEmail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("userEmail");
      }
    });

    it("should accept events with extra unknown fields (Zod strips them)", () => {
      const detailWithExtraFields = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
        // Extra fields we might add in future versions
        newField: "value",
        costBreakdown: {
          compute: 100.0,
          storage: 25.45,
        },
      };

      const result =
        LeaseCostsGeneratedDetailSchema.safeParse(detailWithExtraFields);
      // PASSES because Zod z.object() by default strips unknown fields
      // This is actually safe for consumers - they only see validated fields
      expect(result.success).toBe(true);
      if (result.success) {
        // Extra fields are stripped
        expect(result.data).not.toHaveProperty("newField");
        expect(result.data).not.toHaveProperty("costBreakdown");
      }
    });

    /**
     * IMPORTANT: For outgoing events (LeaseCostsGenerated), we must maintain
     * backward compatibility. If adding new fields:
     *
     * 1. Add as optional: newField: z.string().optional()
     * 2. Update all consumers to handle the new field
     * 3. NEVER remove or rename existing fields
     * 4. NEVER change field types
     * 5. Document changes in CHANGELOG with version bump
     *
     * Example migration:
     * - v1.0: Original schema (8 fields)
     * - v1.1: Add costBreakdown: z.object({...}).optional()
     * - v1.2: Add dataQuality: z.enum([...]).optional()
     *
     * Old consumers ignore new optional fields (forward compatible)
     * New consumers can use new fields (backward compatible)
     */
  });

  describe("required fields enforcement", () => {
    const requiredFields = [
      "leaseId",
      "userEmail",
      "accountId",
      "totalCost",
      "currency",
      "startDate",
      "endDate",
      "csvUrl",
      "urlExpiresAt",
    ];

    requiredFields.forEach((field) => {
      it(`should reject detail without ${field}`, () => {
        const completeDetail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          totalCost: 125.45,
          currency: "USD",
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
          urlExpiresAt: "2026-02-10T10:00:00Z",
        };

        // Remove the field being tested
        const incompleteDetail = { ...completeDetail };
        delete incompleteDetail[field as keyof typeof incompleteDetail];

        const result = LeaseCostsGeneratedDetailSchema.safeParse(incompleteDetail);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain(field);
        }
      });
    });
  });

  describe("field constraints", () => {
    it("should reject invalid UUID format", () => {
      const detail = {
        leaseId: "not-a-uuid",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("leaseId");
      }
    });

    it("should reject invalid account ID format", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "invalid",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("accountId");
      }
    });

    it("should reject negative total cost", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: -10.5, // Negative cost
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("totalCost");
      }
    });

    it("should reject non-USD currency", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "GBP", // Wrong currency
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("currency");
      }
    });

    it("should reject invalid date format for startDate", () => {
      const invalidDates = [
        "2026/01/15", // Wrong separator
        "15-01-2026", // Wrong order
        "2026-1-15", // Missing leading zero
        "2026-01-15T10:00:00Z", // ISO timestamp instead of date
      ];

      invalidDates.forEach((startDate) => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          totalCost: 125.45,
          currency: "USD",
          startDate,
          endDate: "2026-02-03",
          csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
          urlExpiresAt: "2026-02-10T10:00:00Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("startDate");
        }
      });
    });

    it("should reject invalid date format for endDate", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026/02/03", // Wrong separator
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("endDate");
      }
    });

    it("should reject invalid URL format", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "not-a-url", // Invalid URL
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("csvUrl");
      }
    });

    it("should reject invalid ISO 8601 timestamp for urlExpiresAt", () => {
      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10", // Date only, not ISO timestamp
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("urlExpiresAt");
      }
    });

    it("should reject invalid email format", () => {
      const invalidEmails = [
        "not-an-email",
        "user@",
        "@example.com",
        "user @example.com",
        "user@.com",
        "", // Empty string
        "   ", // Whitespace only
      ];

      invalidEmails.forEach((userEmail) => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail,
          accountId: "123456789012",
          totalCost: 125.45,
          currency: "USD",
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
          urlExpiresAt: "2026-02-10T10:00:00Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toContain("userEmail");
        }
      });
    });

    it("should reject email with ANSI escape codes (log injection prevention)", () => {
      const maliciousEmails = [
        "\x1B[31mtest@example.com", // Red text
        "test\x1B[0m@example.com", // Reset code
        "test@\x1B[1mexample.com", // Bold
        "test\x00@example.com", // Null byte
        "test@example.com\x1B[2J", // Clear screen
      ];

      maliciousEmails.forEach((userEmail) => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail,
          accountId: "123456789012",
          totalCost: 125.45,
          currency: "USD",
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
          urlExpiresAt: "2026-02-10T10:00:00Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(false);
        if (!result.success) {
          // Validation should fail - check for ANSI escape message or generic validation error
          const hasSecurityError = result.error.issues.some((issue) =>
            issue.message.includes("ANSI escape") || issue.path.includes("userEmail")
          );
          expect(hasSecurityError).toBe(true);
        }
      });
    });

    it("should reject email with non-ASCII characters (homograph attack prevention)", () => {
      const maliciousEmails = [
        "tеst@example.com", // Cyrillic 'е' instead of Latin 'e'
        "τest@example.com", // Greek tau (τ) looks like 't'
        "tеst@еxample.com", // Multiple Cyrillic characters
        "test@example.com\u200B", // Zero-width space
        "te\u200Cst@example.com", // Zero-width non-joiner
        "test😀@example.com", // Emoji
        "tשst@example.com", // Hebrew character
        "tعst@example.com", // Arabic character
      ];

      maliciousEmails.forEach((userEmail) => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail,
          accountId: "123456789012",
          totalCost: 125.45,
          currency: "USD",
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
          urlExpiresAt: "2026-02-10T10:00:00Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((issue) =>
            issue.message.includes("non-ASCII")
          )).toBe(true);
        }
      });
    });
  });

  describe("idempotency requirements", () => {
    /**
     * CRITICAL: The leaseId field is the primary key for deduplication.
     * Consumers MUST use this field to implement idempotent processing.
     *
     * Why duplicates occur:
     * - EventBridge's at-least-once delivery guarantee
     * - Concurrent Lambda invocations
     * - Lambda retry behavior
     *
     * Consumer implementation patterns:
     * 1. Check if leaseId already processed before taking action
     * 2. Use database unique constraints on leaseId
     * 3. Use DynamoDB conditional writes (PutItem with condition)
     *
     * Example:
     * ```typescript
     * const alreadyProcessed = await checkIfProcessed(event.detail.leaseId);
     * if (alreadyProcessed) {
     *   console.log(`Duplicate event for lease ${event.detail.leaseId}, skipping`);
     *   return;
     * }
     * await processEvent(event.detail);
     * await markAsProcessed(event.detail.leaseId);
     * ```
     */
    it("documents that leaseId is used for deduplication", () => {
      const event1 = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const event2 = {
        ...event1,
        // Even with different cost (due to timing), same leaseId = duplicate
        totalCost: 130.0,
      };

      const result1 = LeaseCostsGeneratedDetailSchema.safeParse(event1);
      const result2 = LeaseCostsGeneratedDetailSchema.safeParse(event2);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Consumers should deduplicate by leaseId
      if (result1.success && result2.success) {
        expect(result1.data.leaseId).toBe(result2.data.leaseId);
      }
    });
  });

  describe("DoS Protection - Input Size Limits", () => {
    it("should reject email longer than 254 characters (RFC 5321 limit)", () => {
      // Create email with 255 characters (exceeds RFC 5321 limit)
      // "@example.com" = 12 characters, so we need 243 'a' chars to get 255 total
      const longEmail = "a".repeat(243) + "@example.com"; // 243 + 12 = 255 chars

      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: longEmail,
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("254 characters");
      }
    });

    it("should accept email at 254 character limit", () => {
      // Create email with exactly 254 characters
      // "@example.com" = 12 characters, so we need 242 'a' chars to get 254 total
      const maxEmail = "a".repeat(242) + "@example.com"; // 242 + 12 = 254 chars

      const detail = {
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: maxEmail,
        accountId: "123456789012",
        totalCost: 125.45,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        csvUrl: "https://s3.amazonaws.com/bucket/550e8400.csv",
        urlExpiresAt: "2026-02-10T10:00:00Z",
      };

      const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
      expect(result.success).toBe(true);
    });
  });
});

describe("LeaseDetailsSchema", () => {
  describe("valid payloads", () => {
    it("should validate complete lease details from ISB API", () => {
      const validDetails = {
        startDate: "2026-01-15T10:00:00Z",
        expirationDate: "2026-02-03T10:00:00Z",
        awsAccountId: "123456789012",
        status: "active",
      };

      const result = LeaseDetailsSchema.safeParse(validDetails);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBe("2026-01-15T10:00:00Z");
        expect(result.data.awsAccountId).toBe("123456789012");
      }
    });

    it("should accept various status values", () => {
      const statuses = ["active", "terminated", "expired", "pending"];

      statuses.forEach((status) => {
        const details = {
          startDate: "2026-01-15T10:00:00Z",
          expirationDate: "2026-02-03T10:00:00Z",
          awsAccountId: "123456789012",
          status,
        };

        const result = LeaseDetailsSchema.safeParse(details);
        expect(result.success).toBe(true);
      });
    });
  });

  describe("backward compatibility (passthrough)", () => {
    it("should accept responses with extra unknown fields from ISB API", () => {
      const detailsWithExtraFields = {
        startDate: "2026-01-15T10:00:00Z",
        expirationDate: "2026-02-03T10:00:00Z",
        awsAccountId: "123456789012",
        status: "active",
        // Extra fields that ISB API might add in future
        region: "us-west-2",
        accountType: "standard",
        costCenter: "engineering",
        tags: {
          project: "innovation",
          owner: "user@example.com",
        },
        metadata: {
          createdAt: "2026-01-15T09:00:00Z",
          createdBy: "admin@example.com",
        },
      };

      const result = LeaseDetailsSchema.safeParse(detailsWithExtraFields);
      // PASSES because schema uses .passthrough()
      // This allows ISB API to evolve without breaking our code
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBe("2026-01-15T10:00:00Z");
        // Extra fields are preserved but not validated
        expect(result.data).toHaveProperty("region");
        expect(result.data).toHaveProperty("tags");
      }
    });

    it("should preserve unknown fields in parsed data", () => {
      const details = {
        startDate: "2026-01-15T10:00:00Z",
        expirationDate: "2026-02-03T10:00:00Z",
        awsAccountId: "123456789012",
        status: "active",
        newField: "new-value",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(true);
      if (result.success) {
        // Verify new field is preserved
        expect((result.data as any).newField).toBe("new-value");
      }
    });
  });

  describe("required fields enforcement", () => {
    it("should reject response without startDate", () => {
      const details = {
        expirationDate: "2026-02-03T10:00:00Z",
        awsAccountId: "123456789012",
        status: "active",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("startDate");
      }
    });

    it("should reject response without expirationDate", () => {
      const details = {
        startDate: "2026-01-15T10:00:00Z",
        awsAccountId: "123456789012",
        status: "active",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("expirationDate");
      }
    });

    it("should reject response without awsAccountId", () => {
      const details = {
        startDate: "2026-01-15T10:00:00Z",
        expirationDate: "2026-02-03T10:00:00Z",
        status: "active",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("awsAccountId");
      }
    });

    it("should reject response without status", () => {
      const details = {
        startDate: "2026-01-15T10:00:00Z",
        expirationDate: "2026-02-03T10:00:00Z",
        awsAccountId: "123456789012",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("status");
      }
    });
  });

  describe("field constraints", () => {
    it("should reject invalid ISO 8601 timestamp for startDate", () => {
      const details = {
        startDate: "2026-01-15", // Date only
        expirationDate: "2026-02-03T10:00:00Z",
        awsAccountId: "123456789012",
        status: "active",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("startDate");
      }
    });

    it("should reject invalid ISO 8601 timestamp for expirationDate", () => {
      const details = {
        startDate: "2026-01-15T10:00:00Z",
        expirationDate: "invalid-date",
        awsAccountId: "123456789012",
        status: "active",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("expirationDate");
      }
    });

    it("should reject invalid AWS account ID format", () => {
      const details = {
        startDate: "2026-01-15T10:00:00Z",
        expirationDate: "2026-02-03T10:00:00Z",
        awsAccountId: "invalid",
        status: "active",
      };

      const result = LeaseDetailsSchema.safeParse(details);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("awsAccountId");
      }
    });

    it("should accept ISO timestamps with Z suffix", () => {
      const timestamps = [
        "2026-01-15T10:00:00Z",
        "2026-01-15T10:00:00.000Z",
      ];

      timestamps.forEach((startDate) => {
        const details = {
          startDate,
          expirationDate: "2026-02-03T10:00:00Z",
          awsAccountId: "123456789012",
          status: "active",
        };

        const result = LeaseDetailsSchema.safeParse(details);
        expect(result.success).toBe(true);
      });
    });

    it("should reject ISO timestamps without Z suffix or timezone offset", () => {
      // Zod's z.string().datetime() requires timezone information
      const invalidTimestamps = [
        "2026-01-15T10:00:00", // No timezone
        "2026-01-15T10:00:00.000", // No timezone
      ];

      invalidTimestamps.forEach((startDate) => {
        const details = {
          startDate,
          expirationDate: "2026-02-03T10:00:00Z",
          awsAccountId: "123456789012",
          status: "active",
        };

        const result = LeaseDetailsSchema.safeParse(details);
        expect(result.success).toBe(false);
      });
    });
  });
});

describe("Schema Evolution Strategy", () => {
  /**
   * This test suite documents the schema evolution strategy and migration paths.
   * It serves as living documentation for future schema changes.
   */

  describe("version detection (future)", () => {
    it("documents approach for adding explicit versioning", () => {
      /**
       * If we need explicit versioning in future:
       *
       * 1. Add optional schemaVersion field to all schemas:
       *    schemaVersion: z.string().default("1.0")
       *
       * 2. For breaking changes, use discriminated unions:
       *    const EventSchemaV1 = z.object({ schemaVersion: z.literal("1.0"), ... });
       *    const EventSchemaV2 = z.object({ schemaVersion: z.literal("2.0"), ... });
       *    const EventSchema = z.discriminatedUnion("schemaVersion", [
       *      EventSchemaV1,
       *      EventSchemaV2
       *    ]);
       *
       * 3. Maintain parsers for all supported versions
       *
       * 4. Deprecate old versions with 6-month notice period
       */
      expect(true).toBe(true); // Documentation-only test
    });
  });

  describe("migration checklist", () => {
    it("documents the coordinated deployment process", () => {
      /**
       * INTERNAL PAYLOAD MIGRATION (SchedulerPayload):
       * ================================================
       * To add a new optional field:
       *
       * 1. Add field to schema with .optional():
       *    newField: z.string().optional()
       *
       * 2. Deploy consumer Lambda (Cost Collector) first:
       *    - Can handle both old payloads (missing field) and new payloads
       *    - Provide sensible defaults if field is missing
       *
       * 3. Deploy producer Lambda (Scheduler):
       *    - Starts including new field in payloads
       *
       * 4. Monitor for 7 days:
       *    - Ensure all old events have been processed
       *    - Check CloudWatch Logs for any errors
       *
       * 5. (Optional) Make field required:
       *    newField: z.string() // Remove .optional()
       *
       * OUTGOING EVENT MIGRATION (LeaseCostsGenerated):
       * ================================================
       * To add a new field for downstream consumers:
       *
       * 1. Add field to schema with .optional():
       *    newField: z.string().optional()
       *
       * 2. Update event-emitter to include new field
       *
       * 3. Deploy producer (Cost Collector)
       *
       * 4. Notify all downstream consumers:
       *    - Document new field in CHANGELOG
       *    - Provide example usage
       *    - Give 30-day notice before making required
       *
       * 5. NEVER make field required if any consumer doesn't support it
       *
       * BREAKING CHANGES (AVOID):
       * =========================
       * NEVER:
       * - Remove fields
       * - Rename fields
       * - Change field types
       * - Change field constraints (more restrictive)
       * - Make optional fields required (without coordination)
       *
       * If breaking change is absolutely necessary:
       * 1. Create new schema version (v2)
       * 2. Support both versions simultaneously (6 months)
       * 3. Migrate all consumers to v2
       * 4. Deprecate v1 with clear timeline
       * 5. Remove v1 support after deprecation period
       */
      expect(true).toBe(true); // Documentation-only test
    });
  });

  describe("sample migration scenarios", () => {
    it("scenario: adding billing region to LeaseCostsGenerated", () => {
      /**
       * Request: Add AWS region where costs were collected
       *
       * Implementation:
       * 1. Add to schema: billingRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional()
       * 2. Update event-emitter.ts to include region from Cost Explorer config
       * 3. Deploy to production
       * 4. Notify consumers: "New optional field 'billingRegion' available"
       * 5. Wait 30 days for consumer adoption
       * 6. If all consumers support it, consider making required
       */
      expect(true).toBe(true);
    });

    it("scenario: adding lease duration to SchedulerPayload", () => {
      /**
       * Request: Pass lease duration (in days) to Cost Collector
       *
       * Implementation:
       * 1. Add to schema: leaseDurationDays: z.number().int().positive().optional()
       * 2. Deploy Cost Collector Lambda (consumer):
       *    - Calculate duration if field missing: Math.ceil((endMs - startMs) / MS_PER_DAY)
       *    - Use provided value if present
       * 3. Deploy Scheduler Lambda (producer):
       *    - Calculate and include leaseDurationDays in payload
       * 4. Monitor for 7 days to ensure no errors
       * 5. (Optional) Make required: leaseDurationDays: z.number().int().positive()
       */
      expect(true).toBe(true);
    });

    it("scenario: changing currency from literal to enum (AVOID)", () => {
      /**
       * Request: Support multiple currencies (USD, GBP, EUR)
       *
       * Current: currency: z.literal("USD")
       * Proposed: currency: z.enum(["USD", "GBP", "EUR"])
       *
       * This is a BREAKING CHANGE if downstream consumers assume USD.
       *
       * Safe approach:
       * 1. Keep currency: z.literal("USD") for now
       * 2. Add currencyCode: z.enum(["USD", "GBP", "EUR"]).optional().default("USD")
       * 3. Always set currencyCode = "USD" to match currency field
       * 4. Wait for all consumers to adopt currencyCode (6 months)
       * 5. Deprecate currency field (announce removal date)
       * 6. After deprecation period, remove currency field
       * 7. Rename currencyCode to currency (MAJOR version bump)
       */
      expect(true).toBe(true);
    });
  });

  /**
   * DoS Protection Tests
   * =====================
   * Tests that input size limits prevent Denial of Service attacks through oversized payloads.
   * Validates that schemas reject inputs exceeding reasonable size limits before expensive
   * regex validation or processing.
   */
  describe("DoS Protection - Input Size Limits", () => {
    describe("UUID validation", () => {
      it("should reject UUID longer than 36 characters", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000-EXTRA-CHARS",
            },
            accountId: "123456789012",
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("36 characters");
        }
      });

      it("should accept valid 36 character UUID", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000", // Exactly 36 chars
            },
            accountId: "123456789012",
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe("Email validation", () => {
      it("should reject email longer than 254 characters (RFC 5321 limit)", () => {
        // Create email with 255 characters (exceeds RFC 5321 limit)
        // "@example.com" = 12 characters, so we need 243 'a' chars to get 255 total
        const longEmail = "a".repeat(243) + "@example.com"; // 243 + 12 = 255 chars

        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: longEmail,
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "123456789012",
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("254 characters");
        }
      });

      it("should accept email at 254 character limit", () => {
        // Create email with exactly 254 characters
        // "@example.com" = 12 characters, so we need 242 'a' chars to get 254 total
        const maxEmail = "a".repeat(242) + "@example.com"; // 242 + 12 = 254 chars

        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: maxEmail,
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "123456789012",
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe("AccountId validation", () => {
      it("should reject accountId longer than 12 characters", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "1234567890123", // 13 characters
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("12 digits");
        }
      });

      it("should accept valid 12 character accountId", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "123456789012", // Exactly 12 characters
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe("Timestamp validation", () => {
      it("should reject timestamp longer than 30 characters", () => {
        const payload = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          leaseEndTimestamp: "2026-02-03T12:00:00.000Z-EXTRA-CHARS", // Exceeds 30 chars
          scheduleName: "test-schedule",
        };

        const result = SchedulerPayloadSchema.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("30 characters");
        }
      });

      it("should accept valid ISO 8601 timestamp", () => {
        const payload = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          leaseEndTimestamp: "2026-02-03T12:00:00.000Z", // Valid ISO 8601
          scheduleName: "test-schedule",
        };

        const result = SchedulerPayloadSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });
    });

    describe("ScheduleName validation", () => {
      it("should reject scheduleName longer than 64 characters", () => {
        const payload = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          leaseEndTimestamp: "2026-02-03T12:00:00.000Z",
          scheduleName: "a".repeat(65), // 65 characters exceeds EventBridge Scheduler limit
        };

        const result = SchedulerPayloadSchema.safeParse(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("64 characters");
        }
      });

      it("should accept scheduleName at 64 character limit", () => {
        const payload = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          leaseEndTimestamp: "2026-02-03T12:00:00.000Z",
          scheduleName: "a".repeat(64), // Exactly 64 characters
        };

        const result = SchedulerPayloadSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });
    });

    describe("URL validation", () => {
      it("should reject csvUrl longer than 2048 characters", () => {
        const longUrl = "https://bucket.s3.amazonaws.com/" + "a".repeat(2020); // Exceeds 2048

        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          totalCost: 100.5,
          currency: "USD" as const,
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl: longUrl,
          urlExpiresAt: "2026-02-10T12:00:00.000Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("2048 characters");
        }
      });

      it("should accept csvUrl at 2048 character limit", () => {
        // S3 presigned URLs can be long due to signatures
        const longUrl = "https://bucket.s3.amazonaws.com/" + "a".repeat(1980); // ~2014 chars

        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          totalCost: 100.5,
          currency: "USD" as const,
          startDate: "2026-01-15",
          endDate: "2026-02-03",
          csvUrl: longUrl,
          urlExpiresAt: "2026-02-10T12:00:00.000Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(true);
      });
    });

    describe("Date string validation", () => {
      it("should reject date string longer than 10 characters", () => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          totalCost: 100.5,
          currency: "USD" as const,
          startDate: "2026-01-15-EXTRA", // Exceeds 10 chars
          endDate: "2026-02-03",
          csvUrl: "https://bucket.s3.amazonaws.com/lease.csv",
          urlExpiresAt: "2026-02-10T12:00:00.000Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("10 characters");
        }
      });

      it("should accept valid YYYY-MM-DD date (10 characters)", () => {
        const detail = {
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          userEmail: "user@example.com",
          accountId: "123456789012",
          totalCost: 100.5,
          currency: "USD" as const,
          startDate: "2026-01-15", // Exactly 10 characters
          endDate: "2026-02-03",
          csvUrl: "https://bucket.s3.amazonaws.com/lease.csv",
          urlExpiresAt: "2026-02-10T12:00:00.000Z",
        };

        const result = LeaseCostsGeneratedDetailSchema.safeParse(detail);
        expect(result.success).toBe(true);
      });
    });

    describe("Event source validation", () => {
      it("should reject event source longer than 256 characters", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "a".repeat(257), // Exceeds 256 characters
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "123456789012",
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("256 characters");
        }
      });

      it("should accept event source at 256 character limit", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "a".repeat(256), // Exactly 256 characters
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "123456789012",
            reason: { type: "Expired" },
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe("Reason type validation", () => {
      it("should reject reason type longer than 128 characters", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "123456789012",
            reason: { type: "a".repeat(129) }, // Exceeds 128 characters
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain("128 characters");
        }
      });

      it("should accept reason type at 128 character limit", () => {
        const event = {
          "detail-type": "LeaseTerminated",
          source: "isb",
          detail: {
            leaseId: {
              userEmail: "user@example.com",
              uuid: "550e8400-e29b-41d4-a716-446655440000",
            },
            accountId: "123456789012",
            reason: { type: "a".repeat(128) }, // Exactly 128 characters
          },
        };

        const result = LeaseTerminatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });
  });
});
