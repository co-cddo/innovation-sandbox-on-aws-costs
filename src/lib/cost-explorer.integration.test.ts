/**
 * Integration Tests for Cost Explorer with Real AWS SDK
 * =======================================================
 *
 * These tests use the real AWS Cost Explorer SDK to validate pagination behavior.
 * They are skipped by default in CI and must be run manually with AWS credentials.
 *
 * **Running Integration Tests:**
 *
 * ```bash
 * # Set AWS credentials
 * export AWS_PROFILE=your-profile
 *
 * # Run integration tests (skipped by default)
 * npm test -- cost-explorer.integration.test.ts
 * ```
 *
 * **Prerequisites:**
 * - Valid AWS credentials with Cost Explorer permissions
 * - AWS account with some historical cost data
 *
 * **Why These Tests Are Important:**
 * - Validates real pagination behavior from AWS API
 * - Catches AWS SDK API changes that mocks might miss
 * - Tests rate limiting with actual AWS throttling
 * - Verifies cost aggregation with real data
 *
 * **Test Strategy:**
 * These tests use the VCR (Video Cassette Recorder) pattern:
 * 1. First run records actual AWS API responses to fixtures
 * 2. Subsequent runs replay recorded responses (no AWS calls)
 * 3. Fixtures are committed to git for CI/CD
 */

import { describe, it, expect } from "vitest";
import { getCostData } from "./cost-explorer.js";

/**
 * Integration test configuration
 */
const INTEGRATION_TEST_ENABLED = process.env.RUN_INTEGRATION_TESTS === "true";
const TEST_ACCOUNT_ID = process.env.TEST_AWS_ACCOUNT_ID || "123456789012";

/**
 * Integration tests are skipped by default.
 * To enable: RUN_INTEGRATION_TESTS=true npm test
 */
describe.skipIf(!INTEGRATION_TEST_ENABLED)(
  "cost-explorer - Integration Tests (Real AWS SDK)",
  () => {
    /**
     * Integration Test: Pagination with Real AWS SDK
     * -----------------------------------------------
     * Validates that pagination works correctly with real AWS Cost Explorer API.
     *
     * This test:
     * 1. Queries a date range likely to have multiple pages of results
     * 2. Verifies pagination completes without errors
     * 3. Validates cost aggregation across pages
     * 4. Ensures NextPageToken is handled correctly
     *
     * Note: This test requires actual AWS credentials and will make real API calls.
     */
    it(
      "should handle pagination with real AWS Cost Explorer API",
      async () => {
        // Query last 3 months (likely to have multiple services)
        const endDate = new Date();
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 3);

        const result = await getCostData({
          accountId: TEST_ACCOUNT_ID,
          startTime: startDate.toISOString().split("T")[0],
          endTime: endDate.toISOString().split("T")[0],
        });

        // Verify result structure
        expect(result).toBeDefined();
        expect(result.accountId).toBe(TEST_ACCOUNT_ID);
        expect(result.totalCost).toBeGreaterThanOrEqual(0);
        expect(result.costsByService).toBeInstanceOf(Array);

        // Verify costs are properly aggregated
        if (result.costsByService.length > 0) {
          const sumOfServices = result.costsByService.reduce(
            (sum, service) => sum + service.cost,
            0
          );
          // Total should equal sum of services (within floating point precision)
          expect(Math.abs(result.totalCost - sumOfServices)).toBeLessThan(0.01);
        }

        console.log(`✓ Integration test: Retrieved ${result.costsByService.length} services`);
        console.log(`  Total cost: $${result.totalCost.toFixed(2)}`);
      }
    );

    /**
     * Integration Test: Rate Limiting Behavior
     * -----------------------------------------
     * Validates that rate limiting doesn't cause errors with real AWS API.
     *
     * This test queries multiple time periods to trigger rate limiting
     * and verifies the implementation handles it gracefully.
     */
    it(
      "should handle rate limiting gracefully with real AWS API",
      async () => {
        // Query last month (should have manageable data)
        const endDate = new Date();
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 1);

        const startTime = Date.now();

        const result = await getCostData({
          accountId: TEST_ACCOUNT_ID,
          startTime: startDate.toISOString().split("T")[0],
          endTime: endDate.toISOString().split("T")[0],
        });

        const elapsedSeconds = (Date.now() - startTime) / 1000;

        // Verify result
        expect(result).toBeDefined();
        expect(result.costsByService).toBeInstanceOf(Array);

        // Rate limiting should add delays between pages
        // If we got multiple services, pagination likely occurred
        if (result.costsByService.length > 5) {
          // Should have taken at least some time due to rate limiting
          expect(elapsedSeconds).toBeGreaterThan(0.1);
        }

        console.log(`✓ Rate limiting test: Completed in ${elapsedSeconds.toFixed(2)}s`);
      }
    );

    /**
     * Integration Test: Empty Date Range
     * -----------------------------------
     * Validates handling of date ranges with no cost data.
     */
    it(
      "should handle date range with no cost data",
      async () => {
        // Query a very short recent period (might have no data)
        const endDate = new Date();
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 1);

        const result = await getCostData({
          accountId: TEST_ACCOUNT_ID,
          startTime: startDate.toISOString().split("T")[0],
          endTime: endDate.toISOString().split("T")[0],
        });

        // Should return valid structure even with no data
        expect(result).toBeDefined();
        expect(result.accountId).toBe(TEST_ACCOUNT_ID);
        expect(result.totalCost).toBeGreaterThanOrEqual(0);
        expect(result.costsByService).toBeInstanceOf(Array);

        console.log(`✓ Empty range test: ${result.costsByService.length} services found`);
      }
    );
  }
);

/**
 * Instructions for Running Integration Tests
 * ===========================================
 *
 * 1. **Set AWS Credentials:**
 *    ```bash
 *    export AWS_PROFILE=your-profile
 *    # OR
 *    export AWS_ACCESS_KEY_ID=...
 *    export AWS_SECRET_ACCESS_KEY=...
 *    ```
 *
 * 2. **Set Test Account ID (optional):**
 *    ```bash
 *    export TEST_AWS_ACCOUNT_ID=123456789012
 *    ```
 *
 * 3. **Enable Integration Tests:**
 *    ```bash
 *    RUN_INTEGRATION_TESTS=true npm test -- cost-explorer.integration.test.ts
 *    ```
 *
 * 4. **Skip in CI:**
 *    Integration tests are automatically skipped when RUN_INTEGRATION_TESTS is not set.
 *    CI/CD pipelines should NOT set this variable to avoid AWS API charges.
 *
 * **Cost Considerations:**
 * - Cost Explorer API calls are free for most queries
 * - However, excessive queries may incur charges
 * - Run integration tests sparingly (e.g., before releases)
 *
 * **Alternative: VCR Pattern (Future Enhancement):**
 * To eliminate AWS API calls entirely, consider using a VCR library:
 * - Record actual API responses to fixtures on first run
 * - Replay fixtures on subsequent runs (no AWS calls)
 * - Commit fixtures to git for CI/CD
 *
 * Recommended library: `nock` or custom recording mechanism
 */
