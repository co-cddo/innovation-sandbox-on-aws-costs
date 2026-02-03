# API Contract Specifications

This document evaluates the benefits and trade-offs of adopting OpenAPI and AsyncAPI specifications for the ISB Lease Cost Collection system's API contracts.

## Current State

The system currently documents API contracts through:
- **TypeScript Zod schemas** (`src/lib/schemas.ts`) for runtime validation
- **TSDoc comments** inline with code for developer documentation
- **README sections** explaining integration patterns and event structures

## API Contracts in This System

### 1. EventBridge Events (Async Messaging)

**Input Events:**
- **LeaseTerminated**: Received from ISB when a lease ends
  - Source: `innovation-sandbox-on-aws`
  - Detail Type: `LeaseTerminated`
  - Schema: `LeaseTerminatedEventSchema` (Zod)

**Output Events:**
- **LeaseCostsGenerated**: Emitted after cost collection completes
  - Detail Type: `LeaseCostsGenerated`
  - Schema: `LeaseCostsGeneratedEventSchema` (Zod)

**Current Documentation:**
- Event structures in `src/lib/schemas.ts` with inline comments
- Integration patterns in `README.md` (ISB Event Flow section)
- Contract tests in `src/lib/schemas.test.ts`

### 2. ISB Leases API (Synchronous Lambda Invocation)

**Endpoint:** Direct Lambda invocation (not REST API Gateway)
- **Operation**: Get Lease Details
- **Input**: JWT token + lease UUID
- **Output**: Lease metadata (account ID, start date, etc.)
- **Authentication**: Service JWT with mock Cognito claims

**Current Documentation:**
- JWT structure in `README.md` (ISB API Authentication section)
- Implementation in `src/lib/isb-api-client.ts` with TSDoc
- Request/response types in TypeScript interfaces

## AsyncAPI Specification (EventBridge Events)

### What is AsyncAPI?

[AsyncAPI](https://www.asyncapi.com/) is an open-source specification for documenting event-driven and message-driven APIs. It's similar to OpenAPI but designed for asynchronous communication patterns like EventBridge, SNS, SQS, Kafka, etc.

### Benefits for This System

1. **Machine-Readable Event Contracts**
   - Generate TypeScript types from AsyncAPI spec (single source of truth)
   - Auto-generate Zod schemas for runtime validation
   - Validate events against spec in CI/CD pipeline

2. **Cross-Team Collaboration**
   - ISB team and Cost Collection team share a versioned event contract
   - Breaking changes are detected automatically (schema evolution)
   - Clear ownership and responsibility for each event

3. **Documentation Quality**
   - Interactive documentation with examples
   - Automatically generated docs stay in sync with code
   - API changelog tracked through spec versions

4. **Tooling Ecosystem**
   - AsyncAPI Studio for visual editing and validation
   - Code generators for multiple languages
   - Event catalog integration (centralized event registry)

### Example AsyncAPI Spec (LeaseTerminated Event)

```yaml
asyncapi: 3.0.0
info:
  title: ISB Lease Cost Collection API
  version: 1.0.0
  description: Event-driven cost collection for Innovation Sandbox leases

channels:
  LeaseTerminated:
    address: innovation-sandbox-events
    messages:
      LeaseTerminated:
        $ref: '#/components/messages/LeaseTerminated'

  LeaseCostsGenerated:
    address: innovation-sandbox-events
    messages:
      LeaseCostsGenerated:
        $ref: '#/components/messages/LeaseCostsGenerated'

operations:
  onLeaseTerminated:
    action: receive
    channel:
      $ref: '#/channels/LeaseTerminated'
    summary: Triggered when a lease ends
    description: |
      Receives LeaseTerminated events from ISB EventBridge bus.
      Schedules cost collection after 8-hour billing data delay.

  publishLeaseCostsGenerated:
    action: send
    channel:
      $ref: '#/channels/LeaseCostsGenerated'
    summary: Emits cost data after successful collection
    description: |
      Published after Cost Collector Lambda completes CSV generation.
      Contains S3 presigned URL for downloading cost report.

components:
  messages:
    LeaseTerminated:
      name: LeaseTerminated
      title: Lease Terminated Event
      summary: Published when a sandbox lease ends
      contentType: application/json
      payload:
        $ref: '#/components/schemas/LeaseTerminatedPayload'

    LeaseCostsGenerated:
      name: LeaseCostsGenerated
      title: Lease Costs Generated Event
      summary: Published after cost collection completes
      contentType: application/json
      payload:
        $ref: '#/components/schemas/LeaseCostsGeneratedPayload'

  schemas:
    LeaseTerminatedPayload:
      type: object
      required:
        - leaseId
        - leaseEndTimestamp
        - userEmail
      properties:
        leaseId:
          type: string
          format: uuid
          description: Unique identifier for the terminated lease
          example: "550e8400-e29b-41d4-a716-446655440000"

        leaseEndTimestamp:
          type: string
          format: date-time
          description: ISO 8601 timestamp when the lease ended (used for billing window)
          example: "2026-01-15T14:30:00Z"

        userEmail:
          type: string
          format: email
          description: Email of the user who owned the lease (used for ISB API authentication)
          example: "user@example.com"

    LeaseCostsGeneratedPayload:
      type: object
      required:
        - leaseId
        - accountId
        - startDate
        - endDate
        - totalCost
        - reportUrl
        - reportExpiresAt
      properties:
        leaseId:
          type: string
          format: uuid
          description: Unique identifier for the lease
          example: "550e8400-e29b-41d4-a716-446655440000"

        accountId:
          type: string
          pattern: '^\d{12}$'
          description: AWS Account ID for the lease
          example: "123456789012"

        startDate:
          type: string
          format: date
          description: Billing window start date (YYYY-MM-DD)
          example: "2026-01-01"

        endDate:
          type: string
          format: date
          description: Billing window end date (YYYY-MM-DD, exclusive)
          example: "2026-02-01"

        totalCost:
          type: number
          format: double
          minimum: 0
          description: Total cost in USD
          example: 1234.56

        reportUrl:
          type: string
          format: uri
          description: S3 presigned URL for downloading CSV cost report
          example: "https://s3.amazonaws.com/..."

        reportExpiresAt:
          type: string
          format: date-time
          description: Timestamp when the presigned URL expires
          example: "2026-01-22T14:30:00Z"
```

### Implementation Strategy

1. **Phase 1: Documentation (Low Effort, High Value)**
   - Create AsyncAPI spec file (`docs/asyncapi.yaml`)
   - Host in repo for version control
   - Generate HTML docs with `@asyncapi/cli`

2. **Phase 2: Validation (Medium Effort, Medium Value)**
   - Integrate AsyncAPI validation in CI/CD
   - Fail builds on schema breaking changes
   - Use `asyncapi validate` in pre-commit hook

3. **Phase 3: Code Generation (High Effort, High Value)**
   - Generate TypeScript types from AsyncAPI spec
   - Auto-generate Zod schemas for runtime validation
   - Single source of truth for event contracts

**Recommended Approach for This System:**
- **Start with Phase 1**: Create the spec for documentation purposes
- **Skip Phase 2/3 initially**: TypeScript + Zod provide sufficient type safety
- **Revisit when**: Multiple teams consume events or event versions proliferate

## OpenAPI Specification (ISB Leases API)

### What is OpenAPI?

[OpenAPI](https://swagger.io/specification/) (formerly Swagger) is an industry-standard specification for documenting REST APIs. It defines endpoints, request/response schemas, authentication, and error codes.

### Applicability to This System

**Current Reality:**
- ISB Leases API is not a REST API—it's a Lambda function
- Direct Lambda invocation bypasses API Gateway entirely
- No HTTP methods, status codes, or REST semantics

**Why OpenAPI Doesn't Fit:**
- OpenAPI assumes HTTP/REST communication model
- Lambda invocation uses `Invoke` API with JSON payloads
- No HTTP status codes, only success/error responses
- Authentication is custom JWT (not standard OAuth/Bearer)

**Alternative: AWS API Gateway Schema (if ISB exposes REST API later)**
If ISB eventually exposes a REST API via API Gateway for the Leases service, OpenAPI would be highly valuable:

```yaml
openapi: 3.0.0
info:
  title: ISB Leases API
  version: 1.0.0
  description: REST API for querying Innovation Sandbox lease details

paths:
  /leases/{leaseId}:
    get:
      summary: Get lease details
      operationId: getLeaseDetails
      parameters:
        - name: leaseId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Lease details retrieved successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/LeaseDetails'
        '404':
          description: Lease not found
        '401':
          description: Unauthorized (invalid JWT)

components:
  schemas:
    LeaseDetails:
      type: object
      required:
        - accountId
        - leaseStartDate
      properties:
        accountId:
          type: string
          pattern: '^\d{12}$'
          example: "123456789012"
        leaseStartDate:
          type: string
          format: date-time
          example: "2026-01-01T10:00:00Z"
```

**Recommendation:**
- **Do NOT create OpenAPI spec for Lambda invocation** (wrong abstraction)
- **DO create OpenAPI spec IF** ISB exposes REST API Gateway endpoint
- **Continue using TypeScript interfaces + TSDoc** for Lambda contracts

## Recommendations

### Immediate Actions (No Cost)

1. **Document Event Schemas More Prominently**
   - Add `docs/event-schemas.md` with copy-pasteable JSON examples
   - Link from README for easy discovery

2. **Version Event Schemas**
   - Add `schemaVersion` field to events (e.g., `"schemaVersion": "1.0.0"`)
   - Document breaking changes in CHANGELOG.md

### Future Considerations (When Valuable)

1. **Adopt AsyncAPI When:**
   - Multiple teams consume `LeaseCostsGenerated` events
   - Event schemas evolve frequently (>2 changes per quarter)
   - Cross-team coordination becomes a bottleneck
   - Need automated contract testing across services

2. **Adopt OpenAPI When:**
   - ISB exposes REST API for Leases service
   - External consumers need to integrate with Cost Collection API
   - API Gateway is introduced for public-facing endpoints

3. **Tooling to Evaluate:**
   - **AsyncAPI Generator**: Auto-generate docs, types, validators
   - **Stoplight Studio**: Visual API design tool (supports AsyncAPI + OpenAPI)
   - **AWS EventBridge Schema Registry**: Discover and version event schemas

## Trade-Offs Summary

| Aspect | Current Approach (TypeScript + Zod) | AsyncAPI/OpenAPI |
|--------|-------------------------------------|------------------|
| **Type Safety** | ✅ Excellent (compile-time) | ✅ Excellent (if codegen) |
| **Runtime Validation** | ✅ Zod schemas validate at runtime | ✅ Can generate validators |
| **Documentation** | ⚠️ Inline TSDoc (scattered) | ✅ Centralized, versioned |
| **Cross-Team Contracts** | ⚠️ Manual coordination | ✅ Machine-readable contracts |
| **Tooling Ecosystem** | ⚠️ Limited to TypeScript | ✅ Multi-language support |
| **Initial Setup Cost** | ✅ Zero (already done) | ⚠️ Medium (write specs) |
| **Maintenance Burden** | ⚠️ Keep docs in sync manually | ✅ Single source of truth |
| **Learning Curve** | ✅ Familiar (TypeScript devs) | ⚠️ New spec format to learn |

## Conclusion

**Current state is sufficient for a single-team, TypeScript-centric system.**

Adopt formal API specifications (AsyncAPI for events, OpenAPI for REST) when:
- Multiple teams depend on your events
- Cross-language integration is required
- Event versioning becomes complex
- Documentation drift becomes a problem

For now, focus on:
1. ✅ High-quality inline documentation (TSDoc)
2. ✅ Comprehensive contract tests (`schemas.test.ts`)
3. ✅ Clear event examples in README
4. ✅ Version control for event schema changes

**Re-evaluate AsyncAPI adoption in 6-12 months** if event consumers grow beyond 2-3 teams or if schema evolution causes integration breakages.
