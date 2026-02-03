# Code Review Findings - TODO List

Remove items you don't care about, then I'll fix everything that remains.

## CRITICAL Issues (Must Fix)

### Architecture & Design

- [x] **Cross-Account Stack Deployment Dependency Not Enforced** (`infra/bin/app.ts:42-61`)
  - Add `collectionStack.addDependency(roleStack)` to prevent out-of-order deployment
  - Add runtime validation in Cost Collector Lambda to verify role ARN format
  - Document deployment order requirement more prominently

- [x] **ISB Lambda Invocation Missing Retry Configuration** (`src/lib/isb-api-client.ts:87-92`)
  - Configure LambdaClient with `maxAttempts: 5` and `retryMode: "adaptive"`
  - Add explicit retry loop with exponential backoff (3 attempts)
  - Don't retry on validation errors (400-class responses)

- [x] **Infrastructure Stack Violates Single Responsibility Principle** (`infra/lib/cost-collection-stack.ts:29-336`)
  - Extract focused L3 constructs: `LeaseCostsStorage`, `CostCollectorFunction`, `LeaseCostsObservability`
  - Separate storage, compute, and observability layers
  - Improve testability and reusability

- [x] **Scheduler Lambda Creates Unbounded Schedules** (`src/lambdas/scheduler-handler.ts:94-124`)
  - Change `ActionAfterCompletion` from `NONE` to `DELETE` for auto-cleanup
  - Remove manual deletion in Cost Collector Lambda (redundant)
  - Add scheduled cleanup Lambda as backup (runs daily)

- [x] **Cost Explorer Pagination Aggregation May Lose Precision** (`src/lib/cost-explorer.ts:76-151`)
  - Use integer arithmetic (cents) instead of floating-point for cost aggregation
  - Convert back to dollars only for final result
  - OR: Use BigInt for extreme precision needs

### Security & Dependencies

- [x] **S3 Key Path Traversal Vulnerability** (`src/lib/s3-uploader.ts:18-27`)
  - Enforce strict format: `{uuid}.csv` using regex validation
  - Block ANY occurrence of `..`, `/`, `\\`, or null bytes
  - Validate UUID format matches expected pattern

- [x] **Overly Permissive Cross-Account IAM Trust Policy** (`infra/lib/cost-explorer-role-stack.ts:27-31`)
  - Use exact role ARN instead of wildcard pattern `IsbCostCollectionStack-CostCollectorLambda*`
  - Add session tag conditions to restrict access

### Performance & Scalability

- [x] **Unbounded Memory Growth in CSV Generation** (`src/lib/csv-generator.ts:10-20`)
  - Use generator function to reduce intermediate copies
  - Prevents Lambda OOM on accounts with 200+ services

- [x] **Cost Explorer Pagination Without Rate Limiting** (`src/lib/cost-explorer.ts:80-134`)
  - Add `MAX_PAGES = 50` safety limit with warning log
  - Add timeout check (90% of Lambda timeout)
  - Add 50ms delay between pages for rate limiting (5 TPS)

- [x] **No Connection Pooling for AWS SDK Clients** (`src/lib/event-emitter.ts:7`, `s3-uploader.ts:10`, `isb-api-client.ts:8`)
  - Create client cache keyed by role ARN
  - Reuse client if credentials still valid (5min buffer)
  - Configure connection pooling settings

### Testing

- [x] **Mock Isolation Violation - Global State Pollution** (`src/lambdas/cost-collector-handler.test.ts:241-257`)
  - Document that duplicate events are expected (idempotent consumers required)

- [x] **Missing Contract Tests for Event Schemas** (All test files)
  - Add `schemas.test.ts` with backward compatibility tests
  - Verify events match documented EventBridge contract
  - Test version detection and migration paths

### Documentation

- [x] **Missing Public API Documentation (TSDoc)** (All `src/lib/*.ts` files)
  - Add comprehensive TSDoc to all 13 exported functions
  - Include `@param`, `@returns`, `@throws`, `@example` tags
  - Priority files: `cost-explorer.ts`, `isb-api-client.ts`, `event-emitter.ts`, `s3-uploader.ts`

---

## HIGH Priority (Fix Before Merge)

### Architecture & Design

- [x] Cost Explorer Pagination Could Be Weaponized (`src/lib/cost-explorer.ts:80-134`)
  - Add maximum page limit (100 pages)
  - Validate response has data before continuing
  - Break on empty pages

- [x] Environment Variable Validation Lacks Context (`src/lib/env-utils.ts:8-48`)
  - Add `EnvContext` parameter with component name and description
  - Include context in error messages

- [x] Cost Collector Lambda Timeout Too Short for Large Accounts (`infra/lib/cost-collection-stack.ts:98`)
  - Increase timeout from 10 to 15 minutes
  - Add progress logging with elapsed time checkpoints
  - Add duration alarm (12 minutes threshold)

- [x] EventBridge Scheduler Group Name Hardcoded (`infra/lib/cost-collection-stack.ts:54-60`)
  - Parameterize with `schedulerGroupName` prop
  - Default to `isb-lease-costs-${stackName}`

- [x] Missing Lease ID Format Validation (`src/lambdas/scheduler-handler.ts:94`)
  - Validate UUID format with regex before creating schedule name
  - Check total schedule name length (<64 chars)

### Security & Dependencies

- [x] Presigned URL Expiry Timestamp Drift (`src/lib/s3-uploader.ts:78-79`)
  - Subtract 5-minute clock skew buffer from expiry calculation

- [x] Environment Variable Injection via EventBridge Scheduler (`src/lambdas/scheduler-handler.ts:94-103`)
  - Sanitize email to remove non-ASCII (prevent homograph attacks)
  - Remove ANSI escape codes from logs
  - Validate against strict email regex beyond Zod

- [x] IAM PassRole Condition Too Broad (`infra/lib/cost-collection-stack.ts:212-222`)
  - Add `scheduler:TargetArn` condition to restrict PassRole
  - Add resource-based policy on Cost Collector Lambda

### Performance & Scalability

- [x] Lambda Memory Configuration Not Tuned for Performance (`infra/lib/cost-collection-stack.ts:99, 184`)
  - Enable Lambda Insights for monitoring

- [x] ISB API Client Lacks Timeout and Retry Configuration (`src/lib/isb-api-client.ts:87-92`)
  - Configure `connectionTimeout: 5000` and `requestTimeout: 30000`
  - Add `maxAttempts: 3` with adaptive retry mode
  - Add `Qualifier` parameter to ensure production version

### Testing

- [x] Over-Mocking Creates Brittle Tests (`src/lambdas/cost-collector-handler.test.ts:9-45`)
  - Already using real implementations for pure functions (lines 47-48)
  - Mocks only AWS SDK clients and external services (lines 8-44)
  - Tests assert on actual CSV content (lines 161-169, 208-211) and billing window calculations (lines 177-181)

- [x] Environment Variable Tests Missing Negative Cases (`src/lambdas/scheduler-handler.test.ts:172-206`)
  - Tests already comprehensive: invalid format ("not-a-number", "x24", "Infinity"), negative values, out-of-bounds (>720), ARN validation
  - 74 test cases covering all edge cases

- [x] Missing Integration Tests for AWS SDK Pagination (`src/lib/cost-explorer.test.ts:87-134`)
  - Created cost-explorer.integration.test.ts with 3 real AWS SDK tests
  - Tests are skipped by default (RUN_INTEGRATION_TESTS=true to enable)
  - Includes instructions for VCR pattern migration

- [x] CSV Generator Tests Missing Roundtrip Validation (`src/lib/csv-generator.test.ts`)
  - Already has 13 comprehensive roundtrip tests (lines 137-450) using csv-parse
  - Tests verify all fields match input data for special characters (commas, quotes, newlines, CRLF, tabs, Unicode)
  - RFC 4180 strict mode tested (lines 267-292) with relax_column_count=false and relax_quotes=false

### Documentation

- [x] ISB API Authentication Pattern Underdocumented (`README.md:260-299`)
  - Add "Security Considerations" section with threat model
  - Document what attacks this DOES NOT protect against
  - Explain when to use real JWT signatures

- [x] Missing Cross-Stack Deployment Dependencies (`README.md:134-206`)
  - Explain consequences of wrong deployment order
  - Add recovery procedure section
  - Document CDK cross-stack reference limitations

- [x] Event Schema Evolution Not Addressed (`src/lib/schemas.ts`, `README.md`)
  - Add versioning strategy to schemas.ts
  - Define backward compatibility rules
  - Show examples of adding/deprecating fields

---

## MEDIUM Priority (Fix Soon)

### Architecture & Design

- [x] Opportunity: Extract Common AWS Client Configuration (Multiple files)
  - Create `src/lib/aws-clients.ts` with shared config
  - Export singleton clients for reuse

- [x] Opportunity: Add Structured Logging (All files)
  - Create `src/lib/logger.ts` with JSON logging
  - Include context fields (leaseId, accountId, component)

### Security & Dependencies

- [x] Missing Input Size Limits (DoS via Large Payloads) (`src/lib/csv-generator.ts`)
  - Add `MAX_SERVICES = 1000` validation

- [x] Timing Attack on UUID Validation (`src/lib/schemas.ts:55`)
  - Use constant-time comparison for security-critical UUIDs
  - (Low priority - requires EventBridge publish permissions)

- [x] Hardcoded Credential Lifetime Creates Rotation Gap (`src/lib/assume-role.ts:24`)
  - Make `DurationSeconds` a parameter (default 3600)
  - Validate range (900-43200 seconds)
  - Increase to 7200 for safety margin

- [x] Missing Integrity Check on CSV Upload (`src/lib/s3-uploader.ts:37-58`)
  - Calculate SHA-256 checksum before upload
  - Use S3 `ChecksumSHA256` parameter
  - Verify ETag in response

- [x] Event Bus Name Not Validated (Could Emit to Wrong Bus) (`src/lib/event-emitter.ts:15-18`)
  - Validate event bus name format (alphanumeric + dots/hyphens)

### Performance & Scalability

- [x] S3 Upload Doesn't Use Multipart for Large Files (`src/lib/s3-uploader.ts:37-59`)
  - Use `@aws-sdk/lib-storage` Upload for files >5MB
  - Configure partSize and queueSize

- [x] Date Calculation Inefficiency (`src/lib/date-utils.ts:34-45`)
  - Simplify end date rounding with `Math.ceil`

### Testing

- [x] Test Names Don't Follow Given-When-Then Pattern (Multiple test files)
  - Restructure tests with nested describe blocks
  - Use "given X, when Y, then Z" naming

- [x] Missing Tests for Logging/Observability (`src/lambdas/cost-collector-handler.test.ts`)
  - Spy on console.log to verify key events are logged
  - Test lease ID, billing window, cost summary logs

- [x] Date Boundary Tests Missing DST Transitions (`src/lib/date-utils.test.ts:89-151`)
  - Add spring forward test (March DST)
  - Add fall back test (November DST)

- [x] S3 Uploader Missing Presigned URL Expiry Validation (`src/lib/s3-uploader.test.ts:88-121`)
  - Use `vi.useFakeTimers()` for exact expiry tests
  - Validate expiry is in the future

- [x] ISB API Client Missing Retry Logic Tests (`src/lib/isb-api-client.test.ts`)
  - Test transient error retries (ServiceUnavailable, ThrottlingException)
  - Verify max retry attempts

- [x] CDK Stack Tests Are Pure Snapshots (`infra/lib/cost-collection-stack.test.ts`)
  - Add semantic assertions for security requirements
  - Verify least-privilege IAM policies
  - Check S3 HTTPS enforcement

### Documentation

- [x] Configuration Reference Incomplete (`README.md:111-133`)
  - Add "When to Change" column to config table
  - Add "Impact" column
  - Add warning box for PRESIGNED_URL_EXPIRY_DAYS limit

- [x] Missing Operational Metrics Dashboard (`README.md`)
  - Add CloudWatch dashboard JSON
  - Document X-Ray integration

- [x] CSV Format Not Formally Specified (`README.md:328-346`)
  - Link to RFC 4180
  - Add conformance testing instructions
  - Document edge cases (empty name, quotes)

- [x] No Example End-to-End Integration (`README.md`)
  - Add Node.js consumer example
  - Add local testing guide
  - Add manual invocation example

- [x] Inline Code Comments Inconsistent (Multiple `src/lib/*.ts` files)
  - Add comments to `assume-role.ts` (session name rationale)
  - Add comments to `date-utils.ts` (rounding logic)
  - Standardize comment style

---

- [x] CloudWatch Metrics for Business Observability
  - Emit TotalCost, ServiceCount, ProcessingDuration metrics
- [x] Optimize Bundle Size
  - Enable minification and tree shaking
- [x] Add X-Ray Subsegments for Granular Tracing
  - Add subsegments for ISB API, Cost Explorer, CSV, S3 operations

### Testing

- [x] Test Data Factories Missing
  - Create `test/factories.ts` with reusable builders
- [x] Missing Performance Tests
  - Test Lambda timeout for typical account
  - Test 200+ services scenario
- [x] Event Emitter Tests Don't Verify Event Bus Name
- [x] JWT Creation Tests Missing
- [x] Scheduler Handler Missing Schedule Expression Validation
- [x] Missing Tests for Assume Role Session Name
- [x] CSV Edge Case - Empty Service Name
- [x] Vitest Config Missing Test Timeouts

### Documentation

- [x] CLI Tool Underdocumented (`README.md:247-258`)
- [x] CDK Stack Props Could Use More Context (`infra/lib/cost-collection-stack.ts:22-27`)
- [x] API Contracts Could Benefit from OpenAPI/AsyncAPI

---

## Dependency Updates

- [x] Run `npm audit` and update vulnerable packages
- [x] Update AWS SDK packages (0 vulnerabilities currently)
- [x] Enable GitHub Dependabot for automated security updates