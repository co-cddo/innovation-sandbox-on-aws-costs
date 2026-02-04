---
title: 'Resource-Level Cost Breakdown'
slug: 'resource-level-cost-breakdown'
created: '2026-02-04'
status: 'completed'
stepsCompleted: [1, 2, 3, 4, 5, 6]
review:
  completed: true
  findings: 10
  fixed: 0
  skipped: 10
  resolution: 'auto-fix'
  notes: 'All findings validated as false positives or by-design choices'
tech_stack:
  - TypeScript
  - AWS SDK v3 (@aws-sdk/client-cost-explorer)
  - Vitest + vitest-mock-extended
  - Zod schemas
  - decimal.js
  - csv-parse (for test roundtrip validation)
files_to_modify:
  - src/types.ts
  - src/lib/cost-explorer.ts
  - src/lib/csv-generator.ts
  - src/lambdas/cost-collector-handler.ts
  - src/lib/cost-explorer.test.ts
  - src/lib/csv-generator.test.ts
  - src/lambdas/cost-collector-handler.test.ts
code_patterns:
  - RFC 4180 CSV generation with escapeCsvValue()
  - AWS SDK v3 pagination with NextPageToken
  - Rate limiting (200ms delay = 5 TPS)
  - Decimal.js for precision handling
  - Lambda timeout detection (90% remaining time threshold)
  - MAX_PAGES safety limit (50 pages)
test_patterns:
  - vi.mock() for AWS SDK clients
  - vi.resetModules() with dynamic imports for isolation
  - csv-parse/sync for CSV roundtrip validation
  - Comprehensive edge case coverage (special chars, precision, large datasets)
---

# Tech-Spec: Resource-Level Cost Breakdown

**Created:** 2026-02-04

## Overview

### Problem Statement

The current CSV output only shows service-level cost aggregation with 2 decimal place precision, which doesn't give users visibility into which specific AWS resources incurred costs or the exact amounts for fractional-cent charges.

### Solution

Replace the service-level CSV with a resource-level CSV that includes `Resource Name,Service,Region,Cost` columns with full decimal precision. Use the AWS Cost Explorer `GetCostAndUsageWithResources` API to retrieve resource-level billing data.

### Scope

**In Scope:**
- New CSV format: `Resource Name,Service,Region,Cost` with full precision
- Use `GetCostAndUsageWithResources` API for resource-level data
- Fallback text for services without resource granularity: `No resource breakdown available for this service type`
- Fallback text for periods beyond 14-day lookback: `No resource breakdown available for this time window`
- Replace existing csv-generator.ts logic
- Update cost-explorer.ts for new API calls
- Update types.ts with new data structures
- Remove all unused service-level code and types
- Update all tests

**Out of Scope:**
- Backwards compatibility shims or dual formats
- Configuration options for precision or format
- Code comments explaining the migration
- Preserving unused exports or types

## Context for Development

### Codebase Patterns

**Architecture:**
- Event-driven using EventBridge (LeaseTerminated → Scheduler → CostCollector → LeaseCostsGenerated)
- Cross-account access via STS AssumeRole to org management account for Cost Explorer
- Lambda timeout: 15 minutes (already configured at `infra/lib/constructs/cost-collector-function.ts:175`)

**Cost Explorer Module (`src/lib/cost-explorer.ts`):**
- Uses `GetCostAndUsageCommand` with `GroupBy: SERVICE` dimension
- Pagination via `NextPageToken` with MAX_PAGES=50 safety limit
- Rate limiting: 200ms delay between calls (5 TPS limit)
- Lambda timeout detection: stops at 90% remaining time
- Integer cents arithmetic internally to avoid floating-point precision loss
- Returns `CostReport` with `costsByService: CostByService[]`

**CSV Generator (`src/lib/csv-generator.ts`):**
- RFC 4180 compliant with `escapeCsvValue()` helper
- Currently: 2 columns (`Service,Cost`), `toFixed(2)` precision
- Memory-optimized string concatenation

**Handler (`src/lambdas/cost-collector-handler.ts`):**
- Orchestrates: ISB API → AssumeRole → Cost Explorer → CSV → S3 → EventBridge
- X-Ray tracing with subsegments per operation
- CloudWatch business metrics (TotalCost, ServiceCount, ProcessingDuration)

### Files to Reference

| File | Purpose | Key Lines |
| ---- | ------- | --------- |
| `src/types.ts` | Type definitions | `CostByService`, `CostReport` interfaces |
| `src/lib/cost-explorer.ts` | Cost Explorer queries | L127-252: `getCostData()` function |
| `src/lib/csv-generator.ts` | CSV generation | L39-49: `generateCsv()`, L56-62: `escapeCsvValue()` |
| `src/lambdas/cost-collector-handler.ts` | Main handler | L244-251: getCostData call, L272: generateCsv call |
| `src/lib/cost-explorer.test.ts` | Cost Explorer tests | Mock patterns, pagination tests |
| `src/lib/csv-generator.test.ts` | CSV tests | Roundtrip validation with csv-parse |

### Technical Decisions

1. **Cost Precision**: Use full precision (up to 15 decimal places). Keep costs as strings from AWS API responses for CSV output. Use Decimal.js for sorting and summing.

2. **14-Day Lookback Limit**: `GetCostAndUsageWithResources` has a hard 14-day limit. For leases longer than 14 days:
   - Query resource-level for most recent 14 days
   - Query service-level (`GetCostAndUsage`) for earlier period
   - Aggregate earlier period into row: `No resource breakdown available for this time window`

3. **Services Without Resource IDs**: AWS returns empty/null resource ID for some services. Map to: `No resource breakdown available for this service type`

4. **Opt-In Requirement**: `GetCostAndUsageWithResources` requires org-level opt-in. If not enabled, fail the Lambda with a clear error message (hard error).

5. **Sort Order**:
   - Group resources by service
   - Sort services by total service cost (descending)
   - Within each service, sort resources by individual cost (descending)
   - Fallback row placed at end of each service's resource group

6. **Precision Handling**:
   - Use `decimal.js` library for all cost operations
   - CSV costs: Keep as strings from AWS (full precision)
   - Sorting: Use Decimal.js for comparison
   - `totalCost` event field: Sum with Decimal.js, `.toNumber()` for output

7. **Resource Output**:
   - One CSV row per API response row (regions create separate rows)
   - Resource naming: Pass through whatever AWS returns

8. **API Query Strategy**:
   - First: Query `GetCostAndUsage` to get list of services used
   - Then: For each service, query `GetCostAndUsageWithResources`
   - Apply rate limiting (200ms) between all calls

## Implementation Plan

### Tasks

#### Phase 1: Dependencies & Types

- [x] **Task 1: Install decimal.js**
  - File: `package.json`
  - Action: `npm install decimal.js`
  - Notes: Types are bundled with the package

- [x] **Task 2: Replace types in types.ts**
  - File: `src/types.ts`
  - Action: Replace `CostByService` and `CostReport` with new interfaces:
    ```typescript
    export interface CostByResource {
      resourceName: string;  // ARN, name, or fallback text
      serviceName: string;
      region: string;        // "global" for region-less costs
      cost: string;          // Full precision string from AWS
    }

    export interface CostReport {
      accountId: string;
      startDate: string;
      endDate: string;
      totalCost: number;
      costsByResource: CostByResource[];
    }
    ```
  - Notes: Remove old `CostByService` interface entirely

#### Phase 2: Cost Explorer Refactor

- [x] **Task 3: Add GetCostAndUsageWithResourcesCommand import**
  - File: `src/lib/cost-explorer.ts`
  - Action: Add import for `GetCostAndUsageWithResourcesCommand` and related types
  - Notes: Already available in @aws-sdk/client-cost-explorer

- [x] **Task 4: Add helper to detect 14-day boundary**
  - File: `src/lib/cost-explorer.ts`
  - Action: Create function to split date range:
    ```typescript
    function splitDateRange(startDate: string, endDate: string): {
      resourceWindow: { start: string; end: string } | null;
      fallbackWindow: { start: string; end: string } | null;
    }
    ```
  - Notes: Returns null for windows that don't apply

- [x] **Task 5: Create getServiceList helper**
  - File: `src/lib/cost-explorer.ts`
  - Action: Extract service list query into separate function that returns list of service names used in the period
  - Notes: Reuses existing `GetCostAndUsage` logic

- [x] **Task 6: Create getResourceCostsForService helper**
  - File: `src/lib/cost-explorer.ts`
  - Action: Create function that queries `GetCostAndUsageWithResources` for a single service:
    ```typescript
    async function getResourceCostsForService(
      client: CostExplorerClient,
      accountId: string,
      serviceName: string,
      startDate: string,
      endDate: string,
      lambdaContext?: LambdaContext
    ): Promise<CostByResource[]>
    ```
  - Notes: Handle pagination, rate limiting, empty resource IDs

- [x] **Task 7: Create getFallbackCosts helper**
  - File: `src/lib/cost-explorer.ts`
  - Action: Create function that queries `GetCostAndUsage` for the pre-14-day window and returns one `CostByResource` per service with fallback text
  - Notes: resourceName = "No resource breakdown available for this time window"

- [x] **Task 8: Refactor getCostData to orchestrate new flow**
  - File: `src/lib/cost-explorer.ts`
  - Action: Replace existing implementation:
    1. Split date range (14-day boundary)
    2. Get service list for resource window
    3. For each service, get resource costs (with rate limiting)
    4. If fallback window exists, get fallback costs
    5. Sort results (service total desc, then resource cost desc within service)
    6. Calculate totalCost with Decimal.js
  - Notes: Keep existing safety features (MAX_PAGES, timeout detection)

- [x] **Task 9: Handle opt-in error**
  - File: `src/lib/cost-explorer.ts`
  - Action: Catch specific error from `GetCostAndUsageWithResources` when API not enabled, throw descriptive error:
    ```
    "Resource-level cost data requires opt-in at the AWS organization level.
    Enable 'Cost Explorer access to resources' in the AWS Billing console."
    ```
  - Notes: Let error propagate to fail the Lambda

#### Phase 3: CSV Generator Refactor

- [x] **Task 10: Update generateCsv function**
  - File: `src/lib/csv-generator.ts`
  - Action: Replace implementation:
    - New header: `Resource Name,Service,Region,Cost`
    - Use `report.costsByResource` instead of `report.costsByService`
    - Output cost as-is (string), no `toFixed()`
    - Escape all four columns with `escapeCsvValue()`
  - Notes: Keep existing `escapeCsvValue()` helper

- [x] **Task 11: Remove unused code from csv-generator.ts**
  - File: `src/lib/csv-generator.ts`
  - Action: Remove any references to old format, update JSDoc
  - Notes: Keep file focused and clean

#### Phase 4: Handler Updates

- [x] **Task 12: Update cost-collector-handler imports and calls**
  - File: `src/lambdas/cost-collector-handler.ts`
  - Action: Update to use new types, ensure `generateCsv` receives correct data shape
  - Notes: Type errors will guide necessary changes

- [x] **Task 13: Update CloudWatch metric**
  - File: `src/lambdas/cost-collector-handler.ts`
  - Action: Change `ServiceCount` metric to `ResourceCount`:
    ```typescript
    {
      MetricName: "ResourceCount",
      Value: costReport.costsByResource.length,
      ...
    }
    ```
  - Notes: Update logging statements too

- [x] **Task 14: Update X-Ray metadata**
  - File: `src/lambdas/cost-collector-handler.ts`
  - Action: Change `serviceCount` to `resourceCount` in subsegment metadata
  - Notes: Consistent naming

#### Phase 5: Test Updates

- [x] **Task 15: Update csv-generator.test.ts**
  - File: `src/lib/csv-generator.test.ts`
  - Action: Replace all tests with new format:
    - Test 4-column header
    - Test full precision output (no rounding)
    - Test all escapeCsvValue scenarios with new columns
    - Test roundtrip with csv-parse for new format
  - Notes: Remove all service-level test fixtures

- [x] **Task 16: Update cost-explorer.test.ts**
  - File: `src/lib/cost-explorer.test.ts`
  - Action: Replace tests:
    - Mock `GetCostAndUsageWithResourcesCommand`
    - Test 14-day boundary detection
    - Test service iteration with rate limiting
    - Test fallback window aggregation
    - Test sort order (service total → resource)
    - Test opt-in error handling
    - Test empty resource ID → fallback text
  - Notes: Use vi.mock for new command

- [x] **Task 17: Update cost-collector-handler.test.ts**
  - File: `src/lambdas/cost-collector-handler.test.ts`
  - Action: Update mocks and assertions for new data shapes
  - Notes: Verify ResourceCount metric emitted

- [x] **Task 18: Add precision edge case tests**
  - File: `src/lib/cost-explorer.test.ts`
  - Action: Add tests for:
    - 15 decimal place preservation
    - Decimal.js sorting correctness
    - totalCost calculation accuracy
  - Notes: Verify no precision loss in chain

### Acceptance Criteria

#### Core Functionality

- [x] **AC1**: Given a lease with costs across multiple services and resources, when cost collection runs, then the CSV contains one row per resource with columns `Resource Name,Service,Region,Cost`

- [x] **AC2**: Given a resource cost of `0.0000005793`, when the CSV is generated, then the cost appears as `0.0000005793` (not rounded)

- [x] **AC3**: Given a lease duration of exactly 14 days, when cost collection runs, then all data comes from `GetCostAndUsageWithResources` with no fallback row

- [x] **AC4**: Given a lease duration of 20 days, when cost collection runs, then resources from the most recent 14 days have individual rows, and each service with earlier costs has one row with `No resource breakdown available for this time window`

- [x] **AC5**: Given a service that doesn't support resource-level granularity (e.g., GuardDuty), when cost collection runs, then the resource name is `No resource breakdown available for this service type`

#### Sort Order

- [x] **AC6**: Given multiple services with different total costs, when the CSV is generated, then services are ordered by total service cost descending (highest first)

- [x] **AC7**: Given a service with multiple resources, when the CSV is generated, then resources within that service are ordered by individual cost descending

- [x] **AC8**: Given a service with both resource-level and fallback rows, when the CSV is generated, then the fallback row appears after all resource rows for that service

#### Error Handling

- [x] **AC9**: Given `GetCostAndUsageWithResources` API is not enabled at org level, when cost collection runs, then the Lambda fails with error message: "Resource-level cost data requires opt-in at the AWS organization level"

- [x] **AC10**: Given API rate limiting (5 TPS), when querying multiple services, then requests are spaced at least 200ms apart

#### Event & Metrics

- [x] **AC11**: Given cost collection completes successfully, when the `LeaseCostsGenerated` event is emitted, then `totalCost` is the sum of all resource costs (calculated with Decimal.js, output as number)

- [x] **AC12**: Given cost collection completes successfully, when CloudWatch metrics are emitted, then `ResourceCount` reflects the number of rows in the CSV

## Additional Context

### Dependencies

- **New**: `decimal.js` - Precision handling for cost arithmetic and sorting
- **Existing**: `@aws-sdk/client-cost-explorer` - Already installed, add `GetCostAndUsageWithResourcesCommand` import
- **Existing**: `csv-parse` (dev) - For test roundtrip validation

### Testing Strategy

**Unit Tests:**
- Mock both `GetCostAndUsageCommand` and `GetCostAndUsageWithResourcesCommand`
- Test date range splitting logic in isolation
- Test sort algorithm with various cost distributions
- Verify string precision preserved through entire pipeline
- Test all fallback text scenarios

**Edge Cases to Cover:**
| Scenario | Expected Behavior |
|----------|-------------------|
| Lease exactly 14 days | No fallback window, all resource-level |
| Lease 15 days | 1 day in fallback, 14 days resource-level |
| Lease 30 days | 16 days fallback, 14 days resource-level |
| Single service, many resources | All resources sorted by cost desc |
| Many services, few resources | Services sorted by total, resources within |
| All resources have IDs | No "service type" fallback text |
| No resources have IDs | All rows use "service type" fallback |
| Empty cost report | Header only, no data rows |
| Costs with 15 decimal places | Full precision in CSV |

**Manual Testing:**
1. Deploy to dev environment
2. Trigger cost collection for a terminated lease
3. Download CSV and verify format
4. Compare row count to expected resources
5. Verify sort order visually

### Notes

**High-Risk Items:**
- API opt-in requirement may not be enabled in all environments - verify with ops team before deploying
- 14-day calculation must use UTC dates consistently with Cost Explorer API

**Known Limitations:**
- `GetCostAndUsageWithResources` has stricter rate limits than `GetCostAndUsage` - monitor for throttling
- Some services never return resource IDs - this is AWS behavior, not a bug

**Future Considerations (Out of Scope):**
- Parallel service queries (currently sequential for rate limit safety)
- Caching service list across invocations
- Configurable precision for different consumers
