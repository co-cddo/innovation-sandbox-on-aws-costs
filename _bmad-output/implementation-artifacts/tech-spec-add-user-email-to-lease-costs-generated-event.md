---
title: 'Add userEmail to LeaseCostsGenerated Event'
slug: 'add-user-email-to-lease-costs-generated-event'
created: '2026-02-03'
status: 'completed'
stepsCompleted: [1, 2, 3, 4, 5, 6]
tech_stack: ['TypeScript', 'Zod', 'Vitest', 'AWS Lambda', 'AWS EventBridge', 'AWS SDK v3']
files_to_modify: ['src/lib/schemas.ts', 'src/lib/event-emitter.ts', 'src/lambdas/cost-collector-handler.ts', 'src/lib/schemas.test.ts', 'test/factories.ts']
code_patterns: ['Zod .safeParse() validation', 'z.infer type inference', 'strictEmailSchema() with DoS protection', 'JSDoc documentation', 'EventBridge event emission with validation']
test_patterns: ['Vitest describe/it blocks', 'Test factories with deepMerge', 'Valid/invalid/required/constraints test structure', 'DoS protection tests']
---

# Tech-Spec: Add userEmail to LeaseCostsGenerated Event

**Created:** 2026-02-03

## Overview

### Problem Statement

The NDX notification system needs to send users an email when their billing CSV is ready for download. Currently, the `LeaseCostsGenerated` event contains all personalisation data (cost, dates, download link) but not the recipient email address. Without `userEmail`, the NDX system cannot send notifications, blocking the billing notification feature from going live.

### Solution

Add `userEmail` as a required field to `LeaseCostsGeneratedDetailSchema` (positioned after `leaseId`). Update the event emitter function and cost collector handler to pass the email through from the scheduler payload to the emitted event. The `userEmail` is already available in the `SchedulerPayload` - it just needs to be included in the outgoing event detail.

### Scope

**In Scope:**
- Add `userEmail: strictEmailSchema()` to `LeaseCostsGeneratedDetailSchema` (src/lib/schemas.ts, line ~476)
- Update `emitLeaseCostsGenerated()` function signature and JSDoc in src/lib/event-emitter.ts
- Update src/lambdas/cost-collector-handler.ts to pass `userEmail` to the event emitter
- Add test cases in src/lib/schemas.test.ts for:
  - Valid email formats
  - Invalid emails (ANSI escape codes, non-ASCII characters, format violations)

**Out of Scope:**
- Changes to NDX notification consumer (different codebase)
- Changes to `SchedulerPayload` schema (userEmail already exists)
- Backward compatibility tests (no existing consumers)
- Changes to ISB API or upstream systems

## Context for Development

### Codebase Patterns

**Schema Evolution Strategy:**
- Extensively documented schema evolution strategy (src/lib/schemas.ts:4-120)
- Schemas categorized: INCOMING EVENTS (external), OUTGOING EVENTS (backward compatible), INTERNAL PAYLOADS (coordinated), EXTERNAL API RESPONSES (permissive)
- `strictEmailSchema()` already exists (line 251) with comprehensive security checks:
  - Max length 254 chars (RFC 5321) - DoS protection
  - ANSI escape code rejection - log injection prevention
  - Non-ASCII character rejection - homograph attack prevention
  - Strict alphanumeric + standard email character validation
- No existing consumers of `LeaseCostsGenerated` event, so breaking changes are acceptable

**Type System Patterns:**
- Types inferred from Zod schemas: `type LeaseCostsGeneratedDetail = z.infer<typeof LeaseCostsGeneratedDetailSchema>`
- Types exported from schemas.ts and re-exported in types.ts for centralized access
- Schema validation and TypeScript types stay in sync automatically

**Event Emission Pattern:**
- EventBridge events use typed schemas validated at runtime with Zod
- Event emitter functions accept detail-only payloads (EventBridge constructs the envelope)
- All events validated before emission using `.safeParse()` with error handling
- JSDoc documentation includes @param tags with field descriptions and @example blocks

**Data Flow:**
- `userEmail` originates from LeaseTerminated event (ISB Leases service)
- Passed through SchedulerPayload to Cost Collector Lambda (available at line 164)
- Currently available in handler but not included in LeaseCostsGenerated event detail (line 315-324)

**Testing Architecture:**
- Vitest framework with describe/it block structure
- Test factories in test/factories.ts with deepMerge utility for nested overrides
- Comprehensive test coverage pattern per schema:
  - valid payloads (various formats and edge cases)
  - backward compatibility (extra fields, schema evolution)
  - required fields enforcement (one test per field)
  - field constraints (format, type, length validation)
  - DoS protection (max length checks before regex)
- Email validation test patterns already established (see LeaseTerminatedEventSchema tests, lines 285-308)

### Files to Reference

| File | Purpose |
| ---- | ------- |
| src/lib/schemas.ts | Zod schema definitions (line 251: strictEmailSchema, lines 475-499: LeaseCostsGeneratedDetailSchema) |
| src/lib/event-emitter.ts | Event emission logic (lines 51-86: emitLeaseCostsGenerated function with JSDoc) |
| src/lambdas/cost-collector-handler.ts | Cost collection handler (line 164: userEmail from payload, lines 315-324: event detail construction) |
| src/lib/schemas.test.ts | Comprehensive schema validation tests (line 764+: LeaseCostsGeneratedDetailSchema suite) |
| test/factories.ts | Test data factories with deepMerge utility (buildLeaseCostsGeneratedDetail factory needs update) |
| src/types.ts | Type exports and re-exports (line 21-26: schema type re-exports) |

### Technical Decisions

**Why required instead of optional:**
- No existing consumers deployed yet
- NDX notification system cannot function without userEmail
- Simplifies consumer logic (no null checks needed)

**Why strictEmailSchema():**
- Reuses existing validation with security checks
- Consistent with other email validations in the codebase (LeaseTerminatedEvent, SchedulerPayload)
- Includes DoS protection and injection attack prevention

**Placement after leaseId:**
- Groups identity fields together (leaseId + userEmail)
- Logical ordering: who + contact before what + when + where

## Implementation Plan

### Tasks

- [x] **Task 1: Update LeaseCostsGeneratedDetailSchema**
  - File: `src/lib/schemas.ts`
  - Action: Add `userEmail: strictEmailSchema()` field after `leaseId` field (line ~476)
  - Notes:
    - Position: Insert after line 476 (`leaseId: uuidV4Schema(),`)
    - Use existing `strictEmailSchema()` helper (defined at line 251)
    - Add inline comment: `// Recipient email for notification delivery`
    - No changes to JSDoc needed (schema documentation is at top of file)

- [x] **Task 2: Update emitLeaseCostsGenerated function signature**
  - File: `src/lib/event-emitter.ts`
  - Action: Update function signature and JSDoc to include userEmail parameter
  - Notes:
    - Update JSDoc `@param` section (lines 22-28) to include:
      ```typescript
      * @param detail.userEmail - User email address for notification delivery
      ```
    - Update example in JSDoc (lines 33-45) to include userEmail field
    - Function signature automatically updated via `LeaseCostsGeneratedDetail` type (inferred from schema)

- [x] **Task 3: Pass userEmail in cost-collector-handler**
  - File: `src/lambdas/cost-collector-handler.ts`
  - Action: Add userEmail to eventDetail object passed to emitLeaseCostsGenerated
  - Notes:
    - Locate event detail construction (lines 315-324)
    - Add `userEmail` field after `leaseId` field:
      ```typescript
      const eventDetail = {
        leaseId,
        userEmail, // Available from payload destructuring at line 164
        accountId,
        // ... rest of fields
      };
      ```
    - The `userEmail` variable is already available from payload destructuring at line 164

- [x] **Task 4: Add schema validation tests**
  - File: `src/lib/schemas.test.ts`
  - Action: Add test cases for userEmail field in LeaseCostsGeneratedDetailSchema test suite
  - Notes:
    - Add tests in the `describe("LeaseCostsGeneratedDetailSchema")` block (starts at line 764)
    - Required test cases:
      1. **In "valid payloads" section**: Update existing valid detail to include userEmail
      2. **In "required fields enforcement" section**: Add test for missing userEmail
      3. **In "field constraints" section**: Add tests for:
         - Invalid email format (not-an-email)
         - Email with ANSI escape codes (security test)
         - Email with non-ASCII characters (homograph attack test)
         - Valid email formats (various valid examples)
    - Follow existing email validation test patterns from LeaseTerminatedEventSchema (lines 285-308)
    - Add to "DoS Protection" section: Test email exceeding 254 characters

- [x] **Task 5: Update test factory**
  - File: `test/factories.ts`
  - Action: Add userEmail field to buildLeaseCostsGeneratedDetail factory function
  - Notes:
    - Locate the factory function (likely around line 150-200 based on file structure)
    - Add `userEmail: "user@example.com"` to the default object
    - Position after leaseId field for consistency
    - Ensure it's a valid email that passes strictEmailSchema() validation

### Acceptance Criteria

- [x] **AC1: Schema validation for valid userEmail**
  - Given a LeaseCostsGenerated event detail with a valid userEmail (e.g., "user@example.com")
  - When the schema validates the detail using LeaseCostsGeneratedDetailSchema.safeParse()
  - Then the validation succeeds and userEmail is included in the parsed data

- [x] **AC2: Schema validation for various valid email formats**
  - Given event details with valid email formats (standard email, plus sign, dots, hyphens, underscores)
  - When the schema validates each detail
  - Then all valid formats pass validation successfully

- [x] **AC3: Schema rejects missing userEmail**
  - Given a LeaseCostsGenerated event detail without userEmail field
  - When the schema validates the detail
  - Then validation fails with error indicating userEmail is required

- [x] **AC4: Schema rejects invalid email format**
  - Given event details with invalid emails (e.g., "not-an-email", "user@", "@example.com")
  - When the schema validates the detail
  - Then validation fails with error indicating invalid email format

- [x] **AC5: Schema rejects email with ANSI escape codes**
  - Given an event detail with userEmail containing ANSI escape codes (e.g., "\x1B[31mtest@example.com")
  - When the schema validates the detail
  - Then validation fails with error indicating ANSI escape codes detected (log injection prevention)

- [x] **AC6: Schema rejects email with non-ASCII characters**
  - Given an event detail with userEmail containing non-ASCII characters (e.g., "tеst@example.com" with Cyrillic 'e')
  - When the schema validates the detail
  - Then validation fails with error indicating non-ASCII characters detected (homograph attack prevention)

- [x] **AC7: Schema rejects overly long email (DoS protection)**
  - Given an event detail with userEmail exceeding 254 characters (RFC 5321 limit)
  - When the schema validates the detail
  - Then validation fails with error indicating email exceeds maximum length

- [x] **AC8: Event emitter includes userEmail in emitted event**
  - Given cost-collector-handler constructs an event detail with userEmail
  - When emitLeaseCostsGenerated() is called with the detail
  - Then the EventBridge event includes userEmail in the detail payload

- [x] **AC9: TypeScript type includes userEmail**
  - Given the LeaseCostsGeneratedDetail type is inferred from the schema
  - When TypeScript compiles the code
  - Then the type includes userEmail: string field and TypeScript enforces it at compile time

- [x] **AC10: Test factory includes userEmail**
  - Given buildLeaseCostsGeneratedDetail() factory is called with no overrides
  - When the factory returns the default detail object
  - Then the object includes a valid userEmail field ("user@example.com")

## Additional Context

### Dependencies

**No external dependencies required:**
- `strictEmailSchema()` helper already exists in schemas.ts (line 251)
- `userEmail` already available in SchedulerPayload (line 164 of cost-collector-handler.ts)
- Zod, Vitest, and AWS SDK dependencies already in package.json

**No deployment coordination needed:**
- No existing consumers of LeaseCostsGenerated event
- Breaking schema change is safe (no downstream impact)
- Single-service change (no cross-service deployment order required)

### Testing Strategy

**Unit Tests (Required):**
- Schema validation tests in src/lib/schemas.test.ts
  - Valid email formats (standard, with special chars)
  - Invalid email formats (malformed addresses)
  - Security tests (ANSI escape codes, non-ASCII characters)
  - DoS protection test (254+ character email)
  - Required field enforcement (missing userEmail)
- Test all patterns follow existing email validation test structure (LeaseTerminatedEventSchema tests, lines 285-308)

**Integration Tests (Not Required):**
- No Lambda integration tests needed (simple data pass-through)
- No EventBridge integration tests needed (existing emission logic unchanged)
- Event emitter tests may need minor updates if they validate exact field counts

**Manual Testing (Post-Deployment):**
- Deploy to staging environment
- Trigger a lease termination event
- Verify LeaseCostsGenerated event includes userEmail field
- Notify NDX team for integration testing with their notification consumer

**Test Execution:**
```bash
npm test -- schemas.test.ts  # Run schema tests
npm test                      # Run full test suite
```

### Notes

**Change Request Reference:**
- Original change request: ../ndx/costs_repo_change_request.md
- Requestor: NDX Notifications Team
- Priority: Required before NDX billing notification feature can go live

**BREAKING CHANGE NOTICE:**
- **Schema Version:** LeaseCostsGeneratedDetailSchema v1.1 (informal)
- **Change Type:** BREAKING - Added required field `userEmail`
- **Impact:** Any existing consumers would fail validation if they attempted to parse old events
- **Mitigation:** No existing consumers deployed (confirmed during implementation planning)
- **Future Compatibility:** New consumers MUST include userEmail in all LeaseCostsGenerated events
- **Rollback Consideration:** Rolling back this change after deployment will break NDX notification consumer

**Deployment & Rollout:**
- No deployment risks (no existing consumers)
- Deploy to staging first for NDX integration testing
- Notify NDX team when staging is ready (they have notification handler ready)
- Once validated on staging, deploy to production
- **Post-Deployment:** Monitor EventBridge metrics for failed event deliveries (should be zero)

**Future Considerations (Out of Scope):**
- If additional consumer metadata is needed (e.g., user name, notification preferences), add as optional fields
- If email delivery failures occur, consider adding retry logic in NDX consumer (not in this service)
- Schema versioning not needed now, but documented strategy exists if required later (schemas.ts:88-97)

**Known Limitations:**
- userEmail validation is strict (ASCII-only) - intentional for security
- If users have internationalized email addresses (per RFC 6531), current validation will reject them
  - This is acceptable: GOV.UK systems typically use ASCII-only email addresses
  - If IDN email support needed in future, would require new email validation schema

**High-Risk Items (Pre-Mortem Analysis):**
- ✅ MITIGATED: Schema type mismatch - Using z.infer ensures TypeScript types match runtime validation
- ✅ MITIGATED: Forgot to pass userEmail in handler - Acceptance criteria AC8 specifically tests this
- ✅ MITIGATED: Test factory not updated - Task 5 and AC10 ensure factory includes userEmail
- ⚠️ LOW RISK: NDX consumer may not be ready - Resolved via staging deployment and NDX team notification

---

## Review Notes

**Adversarial Review Completed:** 2026-02-03

**Findings Summary:**
- Total findings identified: 10
- Findings addressed: 6 (all "real" findings)
- Findings skipped: 4 (noise/uncertain findings)
- Resolution approach: Auto-fix

**Fixes Applied:**
1. **F1 - Backward Compatibility Test:** Added test verifying old events without userEmail correctly fail validation
2. **F3 - Varied Email Test Data:** Enhanced email tests with character distribution edge cases (long local-part, long domain, multiple dots/plus signs)
3. **F4 - Comprehensive ANSI Tests:** Expanded ANSI escape code tests to include reset, bold, null bytes, and clear screen codes
4. **F5 - Comprehensive Non-ASCII Tests:** Added tests for Greek, Hebrew, Arabic, emoji, and zero-width characters beyond Cyrillic
5. **F6 - Empty String Validation:** Added tests for empty string and whitespace-only email addresses
6. **F10 - Breaking Change Documentation:** Added comprehensive breaking change notice to deployment notes including version, impact, mitigation, and rollback considerations

**Findings Skipped (Low Priority/Noise):**
- F2: JSDoc parameter ordering (cosmetic)
- F7: Integration test for full flow (covered by existing integration tests)
- F8: Snapshot hash concerns (expected behavior for code changes)
- F9: Factory placement inconsistency (both patterns are valid and intentional)

**Final Test Status:** 100/100 tests passing (1 new test added during auto-fix)
