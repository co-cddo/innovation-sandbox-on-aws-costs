---
title: 'Event-Driven Lease Cost Collection Service'
slug: 'lease-cost-collection'
created: '2026-02-02'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack:
  - TypeScript (ESM modules)
  - AWS CDK (aws-cdk-lib)
  - AWS Lambda (NodejsFunction, Node 22, ARM_64)
  - AWS EventBridge (Rules + Scheduler)
  - AWS S3 (lifecycle policies)
  - AWS Cost Explorer
  - AWS STS (cross-account role assumption)
  - GitHub Actions (OIDC auth)
  - Vitest (testing)
files_to_modify:
  - src/cost-explorer.ts (move to src/lib/cost-explorer.ts, refactor for Lambda)
  - src/types.ts (add event types)
  - src/index.ts (update import path after cost-explorer move)
  - README.md (add event schemas)
  - package.json (add dependencies + scripts)
files_to_create:
  - src/lambdas/scheduler-handler.ts
  - src/lambdas/cost-collector-handler.ts
  - src/lib/schemas.ts
  - src/lib/csv-generator.ts
  - src/lib/event-emitter.ts
  - src/lib/s3-uploader.ts
  - src/lib/date-utils.ts
  - src/lib/assume-role.ts
  - src/lib/isb-api-client.ts
  - infra/bin/app.ts
  - infra/lib/cost-collection-stack.ts
  - infra/cdk.json
  - infra/tsconfig.json
  - .github/workflows/ci.yml
  - .github/workflows/deploy.yml
  - vitest.config.ts
code_patterns:
  - NodejsFunction with bundling (externalModules: ['@aws-sdk/*'])
  - ESM with __dirname workaround (fileURLToPath)
  - EventBridge Scheduler CfnScheduleGroup for delayed execution
  - SQS + DLQ pattern for event buffering
  - Cross-account STS AssumeRole with intermediate role
  - S3 lifecycle rules with Duration.days()
  - CloudWatch alarms with SNS actions
test_patterns:
  - Vitest with vitest-mock-extended
  - vi.stubEnv for environment variables
  - Mock AWS SDK clients with selective real implementations
  - CDK snapshot tests with Template.fromStack()
---

# Tech-Spec: Event-Driven Lease Cost Collection Service

**Created:** 2026-02-02

## Overview

### Problem Statement

When Innovation Sandbox leases terminate, there's no automated collection of billing data for that account's usage period. Costs need to be captured, stored, and made available to downstream systems for reporting/analytics.

### Solution

Event-driven service that listens for `LeaseTerminated` events, waits 24 hours (configurable) for billing data to settle, collects costs via Cost Explorer (reusing existing logic), uploads CSV to S3, and broadcasts a `LeaseCostsGenerated` event with presigned download URL.

### Scope

**In Scope:**
- EventBridge rule subscribing to `LeaseTerminated` from ISB event bus
- EventBridge Scheduler for 24hr delayed trigger (configurable)
- Lambda function for cost collection + S3 upload + event emission
- Cross-account role assumption into orgManagement for Cost Explorer access
- S3 bucket with configurable name (default: `isb-lease-costs-${account}-${region}`) and 3-year lifecycle policy
- `LeaseCostsGenerated` event with presigned URL
- CDK infrastructure (TypeScript)
- Tests for existing code + new code
- CI/CD pipeline (GitHub Actions) with OIDC+STS auth
- Deploy to `us-west-2`, deploy only from `main`
- Configurable billing window padding (default ±8 hours, operates on day boundaries)
- README documentation including event schemas

**Out of Scope:**
- Modifying existing CLI behavior (keep it working)
- Downstream consumers of `LeaseCostsGenerated`
- Multi-region deployment
- Cost anomaly detection/alerting

## Context for Development

### Architecture

```
NDX/InnovationSandboxHub Account:
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ISB EventBus                                                   │
│       │                                                         │
│       │ LeaseTerminated event                                   │
│       ▼                                                         │
│  EventBridge Rule ──► Scheduler Lambda                          │
│                            │                                    │
│                            │ Creates one-shot schedule          │
│                            ▼                                    │
│                    EventBridge Scheduler ──(24hr delay)──►      │
│                                                                 │
│                    Cost Collection Lambda ◄─────────────────    │
│                            │                                    │
│                            │ 1. Assume role in orgManagement    │
│                            │ 2. Query Cost Explorer             │
│                            │ 3. Generate CSV                    │
│                            │ 4. Upload to S3                    │
│                            │ 5. Generate presigned URL          │
│                            │ 6. Emit LeaseCostsGenerated event  │
│                            ▼                                    │
│                    S3 Bucket (isb-lease-costs-...)              │
│                    └─ ${uuid}.csv                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

NDX/orgManagement Account:
┌─────────────────────────────────────────────────────────────────┐
│  Cost Explorer Read Role (assumed by Lambda)                    │
└─────────────────────────────────────────────────────────────────┘
```

### Deployment Target

- **Region:** us-west-2
- **Account:** NDX/InnovationSandboxHub
- **Cross-account:** Role in NDX/orgManagement for Cost Explorer access

### Codebase Patterns

- Existing code uses ESM modules (`"type": "module"`)
- AWS SDK v3 pattern with `fromIni` credentials (CLI) — Lambda will use IAM role
- Commander for CLI (keep as-is)
- TypeScript with strict mode

### Proposed Code Structure

```
src/
  index.ts                    # CLI entrypoint (keep as-is)
  lambdas/
    scheduler-handler.ts      # Receives LeaseTerminated, creates schedule
    cost-collector-handler.ts # Triggered by scheduler, does the work
  lib/
    cost-explorer.ts          # Refactored: shared between CLI and Lambda
    csv-generator.ts          # New: generates CSV from CostReport
    event-emitter.ts          # New: emits LeaseCostsGenerated
    s3-uploader.ts            # New: uploads CSV, generates presigned URL
    date-utils.ts             # New: billing window calculations
    assume-role.ts            # New: cross-account STS logic
    isb-api-client.ts         # New: ISB API client for lease details
    schemas.ts                # New: Zod schemas for event validation
  types.ts                    # Extended with Lambda event types
infra/
  bin/
    app.ts                    # CDK app entrypoint
  lib/
    cost-collection-stack.ts  # Main stack (all constructs inline for simplicity)
  cdk.json                    # CDK configuration
  tsconfig.json               # TypeScript config for infra
.github/
  workflows/
    ci.yml                    # Lint + test
    deploy.yml                # Deploy from main via OIDC
```

### Files to Reference

**This Project:**

| File | Purpose |
| ---- | ------- |
| `src/cost-explorer.ts` | Cost Explorer query logic — refactor to support both CLI and Lambda |
| `src/types.ts` | Type definitions — extend for Lambda events |
| `src/report-generator.ts` | Markdown output — reference for CSV generator |
| `src/index.ts` | CLI entrypoint — keep as-is |

**Reference Projects (patterns to follow):**

| File | Purpose |
| ---- | ------- |
| `innovation-sandbox-on-aws/source/common/events/lease-terminated-event.ts` | LeaseTerminated event schema (Zod) |
| `innovation-sandbox-on-aws/source/infrastructure/lib/components/isb-lambda-function.ts` | Lambda construct pattern with Zod env validation |
| `innovation-sandbox-on-aws-billing-seperator/lib/hub-stack.ts` | Full CDK stack pattern: NodejsFunction, Scheduler, SQS, alarms |
| `innovation-sandbox-on-aws-billing-seperator/.github/workflows/deploy.yml` | GitHub Actions OIDC + CDK deploy pattern |

### Technical Decisions

1. **Delay Mechanism:** EventBridge Scheduler (one-shot schedule per event)
2. **CSV Format:** `Service,Cost` columns, one row per service, sorted by cost descending
3. **Presigned URL Expiry:** 7 days (configurable)
4. **Billing Window:** Configurable padding hours (default 8), rounded to day boundaries
5. **Auth:** Lambda execution role in InnovationSandboxHub, assumes role in orgManagement
6. **Event Bus:** Emit `LeaseCostsGenerated` to same ISB event bus
7. **Lambda Architecture:** Split into two functions:
   - **Scheduler Lambda** — Receives `LeaseTerminated`, creates one-shot EventBridge schedule (~30 lines, minimal IAM)
   - **Cost Collector Lambda** — Triggered by scheduler, does heavy lifting (assume role, query, CSV, S3, emit event)
8. **Rationale:** Isolation of concerns, different IAM profiles, cleaner failure modes, easier testing

## Implementation Plan

### Task 1: Project Setup & Dependencies

- [x] **1.1: Update package.json with new dependencies**
  - File: `package.json`
  - Action: Add dependencies:
    - `@aws-sdk/client-s3`
    - `@aws-sdk/client-eventbridge`
    - `@aws-sdk/client-scheduler`
    - `@aws-sdk/client-sts`
    - `@aws-sdk/client-lambda` (for ISB API calls)
    - `@aws-sdk/s3-request-presigner`
    - `zod` (event validation)
  - Action: Add devDependencies:
    - `vitest`
    - `vitest-mock-extended`
    - `aws-cdk-lib`
    - `constructs`
    - `@types/aws-lambda`
    - `esbuild`
  - Action: Add scripts:
    - `"test": "vitest run"`
    - `"test:ci": "vitest run --coverage"`
    - `"test:watch": "vitest"`
    - `"lint": "tsc --noEmit"`
    - `"cdk": "cdk"`

- [x] **1.2: Create vitest.config.ts**
  - File: `vitest.config.ts`
  - Action: Configure vitest with:
    - `globals: true`
    - `environment: 'node'`
    - `coverage.provider: 'v8'` (Vitest 2.x default, explicit for clarity)
    - Coverage reporters: text, html, lcov
    - Exclude node_modules and dist
  - Action: Update `tsconfig.json` compilerOptions:
    - Add `"types": ["vitest/globals"]` for TypeScript to recognize test globals (`describe`, `it`, `expect`)

- [x] **1.3: Create tsconfig for infra**
  - File: `infra/tsconfig.json`
  - Action: Extend root tsconfig, set `outDir: './cdk.out'`

### Task 2: Core Library Modules

- [x] **2.1: Create date-utils.ts**
  - File: `src/lib/date-utils.ts`
  - Action: Implement billing window calculation:
    ```typescript
    export function calculateBillingWindow(
      leaseStartDate: string,    // ISO 8601 from ISB API
      leaseEndTimestamp: string, // ISO 8601 from event receipt
      paddingHours: number
    ): { startDate: string, endDate: string }
    ```
  - Logic:
    - Parse both timestamps to Date (normalize to UTC)
    - Start: `leaseStartDate - paddingHours` → round down to day start (00:00:00 UTC)
    - End: `leaseEndTimestamp + paddingHours` → round up to next day start (00:00:00 UTC)
    - Return YYYY-MM-DD strings for Cost Explorer API
  - Example: Start `2026-01-15T10:00:00Z`, End `2026-02-02T15:30:00Z`, 8hr padding
    → start: `2026-01-15`, end: `2026-02-03`

- [x] **2.2: Create csv-generator.ts**
  - File: `src/lib/csv-generator.ts`
  - Action: Implement `generateCsv(report: CostReport): string`
  - Format: `Service,Cost\n` header + one row per service, sorted by cost descending
  - Handle empty report: return header only
  - **CSV escaping:** Wrap values containing commas/quotes in double quotes, escape internal quotes by doubling (RFC 4180). AWS service names are unlikely to need this but handle defensively.

- [x] **2.3: Create assume-role.ts**
  - File: `src/lib/assume-role.ts`
  - Action: Implement `assumeCostExplorerRole(roleArn: string): Promise<AwsCredentialIdentity>`
  - Use STSClient with AssumeRoleCommand
  - Session name: `lease-costs-${Date.now()}`
  - Return credentials object for Cost Explorer client

- [x] **2.4: Create s3-uploader.ts**
  - File: `src/lib/s3-uploader.ts`
  - Action: Implement `uploadCsv(bucket: string, key: string, csv: string): Promise<void>`
    - Set `ContentType: 'text/csv'` in PutObjectCommand
  - Action: Implement `getPresignedUrl(bucket: string, key: string, expiresInDays: number): Promise<{ url: string, expiresAt: Date }>`
  - Use PutObjectCommand and getSignedUrl from s3-request-presigner

- [x] **2.5: Create event-emitter.ts**
  - File: `src/lib/event-emitter.ts`
  - Action: Implement `emitLeaseCostsGenerated(eventBusName: string, detail: LeaseCostsGeneratedDetail): Promise<void>`
  - Use EventBridgeClient with PutEventsCommand
  - Source: `isb-costs`
  - DetailType: `LeaseCostsGenerated`

- [x] **2.6: Create isb-api-client.ts**
  - File: `src/lib/isb-api-client.ts`
  - Action: Implement ISB API client following pattern from `innovation-sandbox-on-aws-approver/src/services/isb-lambda.ts`
  - Methods:
    ```typescript
    export function encodeLeaseId(userEmail: string, uuid: string): string
    // Returns base64-encoded JSON: { userEmail, uuid }

    export async function getLeaseDetails(leaseIdB64: string, isbLeasesLambdaArn: string): Promise<LeaseDetails>
    // Invokes ISB Leases Lambda with GET /leases/{leaseIdB64}
    // Returns: { startDate, expirationDate, awsAccountId, status, ... }
    ```
  - Uses LambdaClient to invoke ISB Leases Lambda directly
  - Constructs API Gateway event payload with httpMethod, path, headers
  - **Validate response** with `LeaseDetailsSchema.parse()` from schemas.ts
  - Reference: `innovation-sandbox-on-aws-approver/src/services/isb-lambda.ts` lines 164-184

### Task 3: Extend Types & Schemas

- [x] **3.1: Add Zod schemas for runtime validation**
  - File: `src/lib/schemas.ts`
  - Action: Create Zod schemas for all event types:
    ```typescript
    import { z } from 'zod';

    // Full EventBridge event envelope for LeaseTerminated
    export const LeaseTerminatedEventSchema = z.object({
      'detail-type': z.literal('LeaseTerminated'),
      source: z.string(),
      detail: z.object({
        leaseId: z.object({ userEmail: z.string().email(), uuid: z.string().uuid() }),
        accountId: z.string().regex(/^\d{12}$/),
        reason: z.object({ type: z.string() }),
      }),
    });

    // Internal payload passed from Scheduler to Cost Collector Lambda
    export const SchedulerPayloadSchema = z.object({
      leaseId: z.string().uuid(),
      userEmail: z.string().email(),  // Needed to encode composite leaseId for ISB API
      accountId: z.string().regex(/^\d{12}$/),
      leaseEndTimestamp: z.string().datetime(),
      scheduleName: z.string(),
    });

    // Detail portion only (emitted to EventBridge via PutEvents)
    export const LeaseCostsGeneratedDetailSchema = z.object({
      leaseId: z.string().uuid(),
      accountId: z.string().regex(/^\d{12}$/),
      totalCost: z.number().nonnegative(),
      currency: z.literal('USD'),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      csvUrl: z.string().url(),
      urlExpiresAt: z.string().datetime(),
    });

    // ISB API response for GET /leases/{leaseId}
    export const LeaseDetailsSchema = z.object({
      startDate: z.string().datetime(),    // ISO 8601 lease start
      expirationDate: z.string().datetime(),
      awsAccountId: z.string().regex(/^\d{12}$/),
      status: z.string(),
      // Additional fields may exist but are not required for cost collection
    }).passthrough();  // Allow unknown fields from ISB API
    ```
  - Export inferred TypeScript types: `z.infer<typeof SchemaName>`
  - **Note on schema scope:**
    - `LeaseTerminatedEventSchema` validates full EventBridge event envelope (Lambda receives full event)
    - `LeaseCostsGeneratedDetailSchema` validates detail portion only (used with PutEvents which wraps it)
    - `LeaseDetailsSchema` validates ISB API response (partial - only fields we need)

- [x] **3.2: Add type exports to types.ts**
  - File: `src/types.ts`
  - Action: Re-export types from schemas:
    ```typescript
    export type { LeaseTerminatedEvent, SchedulerPayload, LeaseCostsGeneratedDetail, LeaseDetails } from './lib/schemas.js';
    ```

### Task 4: Refactor Cost Explorer for Lambda

- [x] **4.1: Extract credential provider and fix filter bug**
  - File: `src/lib/cost-explorer.ts` (move from `src/cost-explorer.ts`)
  - Action: Refactor `createCostExplorerClient` to accept optional credentials:
    ```typescript
    export function createCostExplorerClient(credentials?: AwsCredentialIdentity): CostExplorerClient
    ```
  - CLI uses `fromIni({ profile: AWS_PROFILE })`
  - Lambda passes credentials from assume-role
  - **BUG FIX:** Change RECORD_TYPE filter from `["Credit", "BundledDiscount"]` to `["Usage"]` to get actual costs, not credits
  - Remove `Math.abs()` since usage costs are positive
  - **Add pagination:** Handle `NextPageToken` in response, loop until all pages retrieved

- [x] **4.2: Update CLI to use refactored module**
  - File: `src/index.ts`
  - Action: Update import path to `./lib/cost-explorer.js`
  - Ensure CLI still works with no behavior change

### Task 5: Lambda Handlers

- [x] **5.1: Create scheduler-handler.ts**
  - File: `src/lambdas/scheduler-handler.ts`
  - Action: Implement handler that:
    1. Validates LeaseTerminated event using `LeaseTerminatedEventSchema.safeParse()`
    2. Extracts leaseId.uuid, leaseId.userEmail, accountId
    3. Captures current timestamp as `leaseEndTimestamp` (event receipt = lease termination time)
    4. Calculates schedule time: `now + DELAY_HOURS + random(0-30min jitter)` to prevent thundering herd
    5. Creates one-shot EventBridge schedule via SchedulerClient with:
       - Schedule name: `lease-costs-${uuid}`
       - **Schedule expression:** `at(yyyy-mm-ddThh:mm:ss)` format for one-time execution
       - **RetryPolicy:** MaximumRetryAttempts=3, MaximumEventAgeInSeconds=3600
       - FlexibleTimeWindow: 5 minutes
    6. Schedule invokes Cost Collector Lambda with payload: `{ leaseId, userEmail, accountId, leaseEndTimestamp, scheduleName }`
    7. On `ConflictException` (duplicate schedule name): log warning and return success (idempotent)
  - Env vars: `DELAY_HOURS`, `SCHEDULER_GROUP`, `SCHEDULER_ROLE_ARN`, `COST_COLLECTOR_LAMBDA_ARN`

- [x] **5.2: Create cost-collector-handler.ts**
  - File: `src/lambdas/cost-collector-handler.ts`
  - Action: Implement handler that:
    1. Validates SchedulerPayload using `SchedulerPayloadSchema.safeParse()`
    2. **Calls ISB API to get lease details** (see Task 2.6 for client)
       - Encode leaseId as base64 composite key: `{ userEmail, uuid }`
       - GET `/leases/{leaseIdB64}` → extract `startDate` from response
    3. Assumes role in orgManagement (region: us-east-1 for Cost Explorer)
    4. Calculates billing window from `startDate` to `leaseEndTimestamp` with padding
    5. Queries Cost Explorer with pagination (loop until no `NextPageToken`)
    6. Generates CSV
    7. Uploads to S3 as `${leaseId}.csv`
    8. Generates presigned URL
    9. Emits LeaseCostsGenerated event (validate with schema before emit)
    10. Deletes scheduler schedule using `scheduleName` — **idempotent:** catch `ResourceNotFoundException` and log, don't fail
  - Env vars: `COST_EXPLORER_ROLE_ARN`, `S3_BUCKET_NAME`, `BILLING_PADDING_HOURS`, `PRESIGNED_URL_EXPIRY_DAYS`, `EVENT_BUS_NAME`, `SCHEDULER_GROUP`, `ISB_LEASES_LAMBDA_ARN`
  - Note: Cost Explorer client MUST use region `us-east-1` regardless of Lambda deployment region
  - Note: Schedule deletion failure should NOT cause Lambda to fail/retry (cleanup is best-effort)

### Task 6: Unit Tests

- [x] **6.1: Test date-utils**
  - File: `src/lib/date-utils.test.ts`
  - Cases (must specify BOTH leaseStartDate and leaseEndTimestamp):
    - Start `2026-01-15T10:00Z`, End `2026-02-02T15:00Z`, 8hr padding → startDate=`2026-01-15`, endDate=`2026-02-03`
    - Start `2026-01-15T02:00Z`, End `2026-02-02T02:00Z`, 8hr padding → startDate=`2026-01-14` (02:00-8hr=18:00 prev day), endDate=`2026-02-03`
    - Zero padding → dates match input days (no expansion)
    - **Timezone-aware input** (`2026-02-02T15:30:00-08:00`) → normalizes to UTC before calculation
    - **UTC input** (`2026-02-02T15:30:00Z`) → handles correctly
    - Invalid timestamp → throws with clear message

- [x] **6.2: Test csv-generator**
  - File: `src/lib/csv-generator.test.ts`
  - Cases:
    - Normal report → correct CSV format
    - Empty costsByService → header only
    - Sorted by cost descending
    - **CSV escaping** → service name with comma/quote is properly escaped per RFC 4180

- [x] **6.3: Test assume-role**
  - File: `src/lib/assume-role.test.ts`
  - Cases:
    - Successful assume role → returns credentials
    - AccessDenied → throws with clear message
    - Network error → throws

- [x] **6.4: Test scheduler-handler**
  - File: `src/lambdas/scheduler-handler.test.ts`
  - Mock SchedulerClient
  - Cases:
    - Valid event → creates schedule with retry policy and jitter
    - Invalid event (fails Zod validation) → throws with clear message
    - Missing leaseId → throws
    - Scheduler error → propagates
    - **ConflictException (duplicate)** → logs warning, returns success (idempotent)
    - Invalid DELAY_HOURS env var → throws at startup

- [x] **6.5: Test cost-collector-handler**
  - File: `src/lambdas/cost-collector-handler.test.ts`
  - Mock all AWS clients (including LambdaClient for ISB API)
  - Cases:
    - Happy path → ISB API called, CSV uploaded, event emitted, schedule deleted
    - Empty costs → still emits event with totalCost: 0
    - Assume role fails → throws
    - S3 upload fails → throws (no event emitted)
    - **ISB API returns lease details** → extracts startDate correctly
    - **ISB API fails** → throws (no partial state)
    - **Cost Explorer pagination** → handles NextPageToken, aggregates all pages
    - **Schedule delete fails (ResourceNotFoundException)** → logs warning, completes successfully
    - **Schedule delete fails (other error)** → logs error, completes successfully (best-effort cleanup)
    - Invalid payload (fails Zod) → throws with clear message

- [x] **6.6: Test isb-api-client**
  - File: `src/lib/isb-api-client.test.ts`
  - Mock LambdaClient
  - Cases:
    - encodeLeaseId → returns valid base64 JSON
    - getLeaseDetails success → parses response with LeaseDetailsSchema, returns startDate
    - getLeaseDetails 404 → throws with clear message
    - getLeaseDetails Lambda error → throws
    - getLeaseDetails invalid response (fails schema) → throws Zod validation error

- [x] **6.7: Test cost-explorer (refactored)**
  - File: `src/lib/cost-explorer.test.ts`
  - Mock CostExplorerClient
  - Cases:
    - createCostExplorerClient with no credentials → uses default provider
    - createCostExplorerClient with credentials → uses provided credentials
    - getCosts with RECORD_TYPE filter → uses `"Usage"` (not Credit/BundledDiscount)
    - getCosts single page → returns aggregated costs
    - **getCosts pagination** → follows NextPageToken, aggregates all pages
    - getCosts empty response → returns empty costsByService array
    - getCosts API error → throws with clear message

- [x] **6.8: Test s3-uploader**
  - File: `src/lib/s3-uploader.test.ts`
  - Mock S3Client
  - Cases:
    - uploadCsv success → calls PutObjectCommand with correct bucket/key/body and `ContentType: 'text/csv'`
    - uploadCsv failure → throws with clear message
    - getPresignedUrl success → returns URL and expiresAt date
    - getPresignedUrl with custom expiry → calculates correct expiration
    - getPresignedUrl failure → throws with clear message

- [x] **6.9: Test event-emitter**
  - File: `src/lib/event-emitter.test.ts`
  - Mock EventBridgeClient
  - Cases:
    - emitLeaseCostsGenerated success → calls PutEventsCommand with correct source, detail-type, detail
    - emitLeaseCostsGenerated failure → throws with clear message
    - emitLeaseCostsGenerated with FailedEntryCount > 0 → throws with error details

### Task 7: CDK Infrastructure

- [x] **7.1: Create CDK app entrypoint and configuration**
  - File: `infra/bin/app.ts`
  - Action: Instantiate App, create CostCollectionStack
  - Pass context values: environment, hubAccountId, orgMgmtAccountId, eventBusName, costExplorerRoleArn
  - File: `infra/cdk.json`
  - Action: Create CDK configuration with:
    - `app`: `"npx tsx bin/app.ts"` (tsx handles ESM natively, unlike ts-node)
    - `context`: default values for development
    - `requireApproval`: `"never"` for CI/CD

- [x] **7.2: Create main stack**
  - File: `infra/lib/cost-collection-stack.ts`
  - Action: Create stack with:
    - S3 bucket with configurable name (default: `isb-lease-costs-${account}-${region}`):
      - 3-year lifecycle expiration (Duration.days(1095))
      - Encryption (S3 managed)
      - Block public access
      - Enforce SSL
    - EventBridge Scheduler group: `isb-lease-costs`
    - Scheduler Lambda (NodejsFunction):
      - Runtime: Node 22, ARM_64
      - Timeout: **15 seconds**
      - Memory: 256 MB
      - Tracing: **X-Ray ACTIVE**
    - Cost Collector Lambda (NodejsFunction):
      - Runtime: Node 22, ARM_64
      - Timeout: **60 seconds** (multiple network calls)
      - Memory: 512 MB
      - Tracing: **X-Ray ACTIVE**
      - SQS DLQ for failed invocations (14-day retention)
      - `onFailure` destination pointing to DLQ
    - EventBridge rule: source=isb, detail-type=LeaseTerminated → Scheduler Lambda
      - With SQS DLQ for rule delivery failures (create explicitly, pass ARN to alarm)
    - IAM roles with least privilege
    - Scheduler execution role (can invoke Cost Collector)
    - SNS topic for operational alerts
  - Reference: billing-separator hub-stack.ts

- [x] **7.3: Configure Lambda IAM permissions**
  - File: `infra/lib/cost-collection-stack.ts`
  - Scheduler Lambda:
    - `scheduler:CreateSchedule` on scheduler group
    - `iam:PassRole` for scheduler execution role
  - Cost Collector Lambda:
    - `lambda:InvokeFunction` on ISB Leases Lambda (to get lease details)
    - `sts:AssumeRole` on orgManagement role
    - `s3:PutObject` on costs bucket
    - `s3:GetObject` on costs bucket (for presigned URL)
    - `events:PutEvents` on ISB event bus
    - `scheduler:DeleteSchedule` on scheduler group
    - `sqs:SendMessage` on DLQ (for failure destination)

- [x] **7.4: Add CDK snapshot tests**
  - File: `infra/lib/cost-collection-stack.test.ts`
  - Action: Template.fromStack snapshot test
  - Verify IAM policies, Lambda configs, S3 lifecycle

- [x] **7.5: Add CloudWatch alarms**
  - File: `infra/lib/cost-collection-stack.ts`
  - Action: Create alarms with SNS actions:
    - **DLQ Alarm:** ApproximateNumberOfMessagesVisible >= 1 on Cost Collector DLQ
    - **Scheduler Lambda Errors:** Errors >= 3 in 5 minutes
    - **Cost Collector Lambda Errors:** Errors >= 3 in 5 minutes
    - **EventBridge Rule DLQ Alarm:** Messages in rule DLQ >= 1
  - All alarms publish to SNS alert topic
  - Reference: billing-separator hub-stack.ts alarm patterns

### Task 8: CI/CD Workflows

- [x] **8.1: Create ci.yml**
  - File: `.github/workflows/ci.yml`
  - Triggers: push to any branch, PR to main
  - Jobs:
    - Setup Node 22
    - `npm ci`
    - `npm run lint`
    - `npm run test:ci`
    - `npm run build`
    - `npx cdk synth` with dummy context values (validates CDK stack compiles)

- [x] **8.2: Create deploy.yml**
  - File: `.github/workflows/deploy.yml`
  - Triggers: workflow_dispatch only
  - **Branch restriction:** Add condition `if: github.ref == 'refs/heads/main'` to prevent deploys from non-main branches
  - Permissions: id-token: write, contents: read
  - Jobs:
    - Run ci.yml validation first
    - Configure AWS credentials via OIDC
    - `npx cdk deploy --require-approval never`
    - Output deployment summary

### Task 9: Documentation

- [x] **9.1: Update README.md**
  - File: `README.md`
  - Action: Add sections:
    - Architecture diagram (ASCII)
    - Event schemas (Input: LeaseTerminated, Output: LeaseCostsGenerated)
    - Configuration (environment variables table)
    - Deployment instructions
    - Failure modes table
    - Local development setup

- [x] **9.2: Document cross-account role setup**
  - File: `README.md`
  - Action: Add section explaining:
    - Required role in orgManagement account
    - Trust policy for Lambda execution role
    - Minimum permissions: `ce:GetCostAndUsage`

---

## Acceptance Criteria

### Core Functionality

- [x] **AC1:** Given a `LeaseTerminated` event is published to the ISB event bus, when the Scheduler Lambda processes it, then a one-shot EventBridge schedule is created with a 24-hour delay (configurable via `DELAY_HOURS`).

- [x] **AC2:** Given the scheduled time arrives, when the Cost Collector Lambda executes, then it assumes the cross-account role in orgManagement and queries Cost Explorer for the account's billing data.

- [x] **AC3:** Given billing data is retrieved, when the Lambda processes it, then a CSV file is generated with `Service,Cost` columns and uploaded to S3 as `${leaseId}.csv`.

- [x] **AC4:** Given the CSV is uploaded, when a presigned URL is generated, then the URL is valid for 7 days (configurable via `PRESIGNED_URL_EXPIRY_DAYS`).

- [x] **AC5:** Given the presigned URL is generated, when the Lambda emits the `LeaseCostsGenerated` event, then the event contains leaseId, accountId, totalCost, csvUrl, and urlExpiresAt.

### Billing Window

- [x] **AC6:** Given a lease starts at 10:00 UTC on Jan 15 and ends at 15:00 UTC on Feb 2, when billing window is calculated with 8-hour padding, then the start date is Jan 15 (10:00 - 8hr = 02:00 same day) and end date is Feb 3 (15:00 + 8hr = 23:00, rounded up).

- [x] **AC7:** Given a lease ends at 02:00 UTC on Feb 2, when billing window is calculated with 8-hour padding, then the end date is Feb 3 (02:00 + 8hr = 10:00 on Feb 2, rounded up to next day start = Feb 3).

### Error Handling

- [x] **AC8:** Given Cost Explorer returns zero costs, when the Lambda processes it, then a CSV with headers only is uploaded and `LeaseCostsGenerated` is emitted with `totalCost: 0`.

- [x] **AC9:** Given the STS AssumeRole call fails, when the Lambda handles the error, then it throws and the event is retried (no partial state).

- [x] **AC10:** Given S3 upload fails, when the Lambda handles the error, then it throws without emitting the `LeaseCostsGenerated` event.

### Infrastructure

- [x] **AC11:** Given the S3 bucket is created, then it has a lifecycle rule that expires objects after 3 years (1095 days).

- [x] **AC12:** Given the CDK stack is deployed, then Lambda functions use Node.js 22 runtime and ARM_64 architecture.

- [x] **AC13:** Given the Scheduler Lambda IAM role, then it only has permissions to create schedules in the designated scheduler group and pass the scheduler execution role.

### CI/CD

- [x] **AC14:** Given a push to any branch, when CI runs, then lint, test, build, and CDK synth all pass.

- [x] **AC15:** Given a manual deploy trigger on main branch, when deploy runs, then it uses OIDC to assume the deployment role and deploys the CDK stack to us-west-2.

### CLI Backward Compatibility

- [x] **AC16:** Given the CLI is invoked with `--accountId`, `--startTime`, and `--endTime`, when it executes, then it produces the same markdown output as before the refactor.

### Observability

- [x] **AC17:** Given the Cost Collector Lambda fails after retries, when the failure is processed, then the event is sent to the DLQ and the DLQ alarm fires.

- [x] **AC18:** Given CloudWatch alarms are configured, when Lambda errors exceed threshold, then SNS notification is published to the alert topic.

### Schedule Cleanup

- [x] **AC19:** Given the Cost Collector Lambda completes successfully, when it deletes the schedule, then the schedule named in the payload is removed from the scheduler group.

- [x] **AC20:** Given the schedule was already deleted, when the Cost Collector attempts cleanup, then it catches `ResourceNotFoundException` and completes successfully.

### Bug Fix & Data Integrity

- [x] **AC21:** Given the Cost Explorer query executes, when it filters by RECORD_TYPE, then it uses `"Usage"` (not Credit/BundledDiscount) to return actual costs.

- [x] **AC22:** Given Cost Explorer returns paginated results, when the Lambda processes them, then it follows `NextPageToken` until all pages are retrieved and aggregated.

### Input Validation

- [x] **AC23:** Given an invalid LeaseTerminated event, when the Scheduler Lambda validates it, then it throws with a Zod validation error message.

- [x] **AC24:** Given a duplicate LeaseTerminated event, when the Scheduler Lambda attempts to create a schedule, then it handles `ConflictException` gracefully (logs and succeeds).

### Throttling Mitigation

- [x] **AC25:** Given multiple leases terminate simultaneously, when schedules are created, then each has a random jitter (0-30min) added to the delay to prevent thundering herd.

### ISB API Integration

- [x] **AC26:** Given the Cost Collector Lambda executes, when it queries ISB API for lease details, then it encodes the leaseId as base64 composite key and retrieves the lease `startDate`.

- [x] **AC27:** Given the ISB API returns lease details, when the billing window is calculated, then it uses `startDate` (from API) to `leaseEndTimestamp` (from event) with padding applied to both ends.

- [x] **AC28:** Given the ISB API returns a response, when the Cost Collector validates it, then it uses `LeaseDetailsSchema` to ensure required fields (`startDate`, `awsAccountId`) are present and valid.

---

## Additional Context

### Input Event Schema (LeaseTerminated)

```typescript
{
  "detail-type": "LeaseTerminated",
  "source": "isb",
  "detail": {
    "leaseId": {
      "userEmail": string,
      "uuid": string
    },
    "accountId": string,
    "reason": {
      "type": "Expired" | "BudgetExceeded" | "ManuallyTerminated" | "AccountQuarantined" | "Ejected",
      // Additional fields vary by type
    }
  }
}
```

### Output Event Schema (LeaseCostsGenerated)

```typescript
{
  "detail-type": "LeaseCostsGenerated",
  "source": "isb-costs",
  "detail": {
    "leaseId": string,        // UUID only
    "accountId": string,
    "totalCost": number,
    "currency": "USD",
    "startDate": string,      // YYYY-MM-DD
    "endDate": string,        // YYYY-MM-DD
    "csvUrl": string,         // Presigned S3 URL
    "urlExpiresAt": string    // ISO 8601
  }
}
```

### Dependencies

- `@aws-sdk/client-cost-explorer` (existing)
- `@aws-sdk/client-s3`
- `@aws-sdk/client-eventbridge`
- `@aws-sdk/client-scheduler`
- `@aws-sdk/client-sts` (for role assumption)
- `@aws-sdk/client-lambda` (for ISB API calls)
- `@aws-sdk/s3-request-presigner`
- `zod` (runtime validation)
- `aws-cdk-lib`
- `vitest` (testing)
- `esbuild` (Lambda bundling)

### Testing Strategy

**Unit Tests (vitest, mocked AWS SDK):**
- Cost calculation logic
- CSV generation
- Date window calculation (padding hours → day boundaries)
- STS AssumeRole credential handling (mock `STSClient`)
- Error paths: `AccessDenied`, expired creds, network timeout, empty Cost Explorer response

**Contract Tests:**
- Role ARN format validation
- Event schema validation (input and output)
- Environment variable requirements

**Integration Tests (CI-gated, main branch only):**
- Real OIDC → assume role chain validation
- Skip in PR builds, mark as `@slow`

**Infrastructure Tests:**
- CDK snapshot tests for all constructs
- Assert IAM policy least-privilege

### Configuration (Environment Variables)

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `DELAY_HOURS` | Hours to wait before collecting costs | 24 |
| `BILLING_PADDING_HOURS` | Hours before/after lease period to include | 8 |
| `S3_BUCKET_NAME` | Bucket for CSV storage | isb-lease-costs-{account}-{region} |
| `PRESIGNED_URL_EXPIRY_DAYS` | Presigned URL validity | 7 |
| `COST_EXPLORER_ROLE_ARN` | Role ARN in orgManagement account | - |
| `EVENT_BUS_NAME` | EventBridge bus for output events | - |
| `SCHEDULER_GROUP` | EventBridge Scheduler group name | - |
| `SCHEDULER_ROLE_ARN` | IAM role ARN for Scheduler to invoke Lambda | - |
| `COST_COLLECTOR_LAMBDA_ARN` | ARN of Cost Collector Lambda (Scheduler Lambda env) | - |
| `SNS_ALERT_EMAIL` | Email for operational alerts (optional) | - |
| `ISB_LEASES_LAMBDA_ARN` | ARN of ISB Leases API Lambda | - |

### CI/CD Pattern (from billing-separator)

**ci.yml** — Runs on all pushes/PRs:
- Lint (`npm run lint`)
- Test (`npm run test:ci`)
- Build (`npm run build`)
- CDK synth validation (with dummy context values)

**deploy.yml** — Manual trigger only, main branch:
```yaml
permissions:
  id-token: write   # OIDC
  contents: read

- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
    aws-region: us-west-2

- run: npx cdk deploy --require-approval never
```

**Required GitHub Secrets:**
- `AWS_ROLE_ARN` — IAM role with OIDC trust policy

**Required GitHub Variables:**
- `AWS_REGION` — `us-west-2`

### Notes

- Leases have 72hr gap between them, so ±8hr padding is safe
- Cost Explorer data can take up to 24hrs to finalize (hence the delay)
- S3 lifecycle: 3-year retention then delete

### Failure Modes (Document in README)

| Scenario | Behavior | Downstream Impact |
|----------|----------|-------------------|
| Cost Explorer returns empty | CSV with headers only, `totalCost: 0` | Event still emitted |
| STS AssumeRole fails | Lambda throws, retries, then DLQ + alarm | No event emitted, alarm fires |
| S3 upload fails | Lambda throws, retries, then DLQ + alarm | No event emitted, alarm fires |
| EventBridge emit fails | Lambda throws, retries, then DLQ + alarm | CSV exists but no notification, alarm fires |
| Schedule creation fails | Scheduler Lambda retries via EventBridge | Delayed collection never triggers if all retries fail |
| Cost Collector Lambda timeout | Retries, then DLQ + alarm | Partial state possible, alarm fires |

---

## Review Notes

- **Adversarial review completed:** 2026-02-02
- **Findings:** 20 total, 11 fixed, 9 skipped (noise/undecided/out-of-scope)
- **Resolution approach:** Auto-fix

### Fixes Applied

1. **F1 (Critical):** Added environment variable validation with `requireEnv()` helper
2. **F2 (Critical):** Added validation for presigned URL expiry (max 7 days per AWS limits)
3. **F5 (High):** Moved STS client to module scope for connection reuse
4. **F7 (High):** Increased Cost Collector Lambda timeout from 60s to 5 minutes
5. **F8 (Medium):** Added validation for integer env vars (BILLING_PADDING_HOURS, PRESIGNED_URL_EXPIRY_DAYS)
6. **F10 (Medium):** Improved event emitter error message to include all failed entries and leaseId
7. **F11 (Medium):** Added sanity check for lease dates (startDate < endDate)
8. **F17 (Medium):** Added termination protection to CDK stack
9. **F18 (Medium):** Added `environment: production` to deploy workflow for protection rules
10. **F20 (Medium):** Enhanced billing window logging to show padding and original dates

### Skipped (Noise/Undecided/Out-of-scope)

- F3 (leaseEndTimestamp race): By design - event receipt time is the termination time
- F4 (Math.random for jitter): Low risk, acceptable for this use case
- F6 (ISB API retries): AWS SDK v3 has built-in retries
- F9 (Idempotency): Would require S3 existence check - scope expansion
- F12 (Bucket naming): Already includes account+region, collision unlikely
- F13 (CE throttling alarm): Would need custom metrics - scope expansion
- F14 (Presigned URL timestamp): Minimal drift, acceptable
- F15 (Structured logging): Scope expansion for this implementation
- F16 (ESLint): Out of scope, separate tooling decision
- F19 (Edge case tests): Scope expansion
