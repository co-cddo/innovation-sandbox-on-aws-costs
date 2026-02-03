/**
 * Unit tests for AWS Cost Explorer module.
 *
 * These tests use mocked AWS SDK clients for fast, isolated unit testing.
 * For integration tests with real AWS SDK responses, see cost-explorer.integration.test.ts
 *
 * Test Coverage:
 * - Client creation with credentials and profiles
 * - Cost data retrieval and aggregation logic
 * - Pagination handling with NextPageToken
 * - Floating-point precision protection
 * - Rate limiting delays
 * - Safety features (MAX_PAGES, Lambda timeout detection)
 * - Error handling
 *
 * @see cost-explorer.integration.test.ts - Integration tests with real AWS SDK responses
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

// Mock Cost Explorer client
vi.mock("@aws-sdk/client-cost-explorer", async () => {
  const actual = await vi.importActual("@aws-sdk/client-cost-explorer");
  return {
    ...actual,
    CostExplorerClient: vi.fn(),
  };
});

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: vi.fn().mockReturnValue({ accessKeyId: "test", secretAccessKey: "test" }),
}));

describe("cost-explorer", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockSend = vi.fn();
    (CostExplorerClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({
        send: mockSend,
      })
    );
  });

  describe("createCostExplorerClient", () => {
    it("should create client with no options", async () => {
      const { createCostExplorerClient } = await import("./cost-explorer.js");
      const client = createCostExplorerClient();
      expect(client).toBeDefined();
    });

    it("should create client with credentials", async () => {
      const { createCostExplorerClient } = await import("./cost-explorer.js");
      const credentials = {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      };
      const client = createCostExplorerClient({ credentials });
      expect(client).toBeDefined();
    });

    it("should create client with profile", async () => {
      const { createCostExplorerClient } = await import("./cost-explorer.js");
      const client = createCostExplorerClient({ profile: "test-profile" });
      expect(client).toBeDefined();
    });
  });

  describe("getCostData", () => {
    it("should return aggregated costs from single page response", async () => {
      mockSend.mockResolvedValue({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: { UnblendedCost: { Amount: "100.00" } },
              },
              {
                Keys: ["Amazon S3"],
                Metrics: { UnblendedCost: { Amount: "50.00" } },
              },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      expect(result.totalCost).toBe(150);
      expect(result.costsByService).toHaveLength(2);
      expect(result.costsByService[0].serviceName).toBe("Amazon EC2");
      expect(result.costsByService[0].cost).toBe(100);
    });

    it("should handle pagination with NextPageToken", async () => {
      // First page
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: { UnblendedCost: { Amount: "100.00" } },
              },
            ],
          },
        ],
        NextPageToken: "page-2-token",
      });

      // Second page
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon S3"],
                Metrics: { UnblendedCost: { Amount: "50.00" } },
              },
            ],
          },
        ],
        // No NextPageToken - end of pagination
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(result.totalCost).toBe(150);
      expect(result.costsByService).toHaveLength(2);

      // Verify NextPageToken was passed to second request
      const firstCallInput = mockSend.mock.calls[0][0].input;
      const secondCallInput = mockSend.mock.calls[1][0].input;
      expect(firstCallInput.NextPageToken).toBeUndefined();
      expect(secondCallInput.NextPageToken).toBe("page-2-token");
    });

    it("should aggregate same service across pages", async () => {
      // First page
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: { UnblendedCost: { Amount: "100.00" } },
              },
            ],
          },
        ],
        NextPageToken: "page-2",
      });

      // Second page - same service
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: { UnblendedCost: { Amount: "50.00" } },
              },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      expect(result.totalCost).toBe(150);
      expect(result.costsByService).toHaveLength(1);
      expect(result.costsByService[0].cost).toBe(150);
    });

    it("should return empty costsByService for no results", async () => {
      mockSend.mockResolvedValue({
        ResultsByTime: [],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      expect(result.totalCost).toBe(0);
      expect(result.costsByService).toHaveLength(0);
    });

    it("should use Usage RECORD_TYPE filter (not Credit/BundledDiscount)", async () => {
      mockSend.mockResolvedValue({ ResultsByTime: [] });

      const { getCostData } = await import("./cost-explorer.js");
      await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(GetCostAndUsageCommand);

      // Check the filter includes Usage, not Credit/BundledDiscount
      const filter = command.input.Filter;
      expect(filter.And).toBeDefined();
      const recordTypeFilter = filter.And.find(
        (f: any) => f.Dimensions?.Key === "RECORD_TYPE"
      );
      expect(recordTypeFilter.Dimensions.Values).toEqual(["Usage"]);
    });

    it("should include complete Filter.And structure with LINKED_ACCOUNT and RECORD_TYPE", async () => {
      mockSend.mockResolvedValue({ ResultsByTime: [] });

      const { getCostData } = await import("./cost-explorer.js");
      await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(GetCostAndUsageCommand);

      // Verify complete Filter structure
      const filter = command.input.Filter;
      expect(filter).toEqual({
        And: [
          {
            Dimensions: {
              Key: "LINKED_ACCOUNT",
              Values: ["123456789012"],
            },
          },
          {
            Dimensions: {
              Key: "RECORD_TYPE",
              Values: ["Usage"],
            },
          },
        ],
      });

      // Verify GroupBy is set correctly
      expect(command.input.GroupBy).toEqual([
        {
          Type: "DIMENSION",
          Key: "SERVICE",
        },
      ]);

      // Verify time period
      expect(command.input.TimePeriod).toEqual({
        Start: "2026-01-15",
        End: "2026-02-03",
      });

      // Verify granularity and metrics
      expect(command.input.Granularity).toBe("DAILY");
      expect(command.input.Metrics).toEqual(["UnblendedCost"]);
    });

    it("should pass NextPageToken to subsequent requests", async () => {
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [{ Groups: [{ Keys: ["EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] }],
        NextPageToken: "page-2-token",
      });
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [{ Groups: [{ Keys: ["S3"], Metrics: { UnblendedCost: { Amount: "50.00" } } }] }],
      });

      const { getCostData } = await import("./cost-explorer.js");
      await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      // First call should not have NextPageToken
      expect(mockSend.mock.calls[0][0].input.NextPageToken).toBeUndefined();

      // Second call should include the token from first response
      expect(mockSend.mock.calls[1][0].input.NextPageToken).toBe("page-2-token");
    });

    it("should throw on API error", async () => {
      mockSend.mockRejectedValue(new Error("Cost Explorer API unavailable"));

      const { getCostData } = await import("./cost-explorer.js");

      await expect(
        getCostData({
          accountId: "123456789012",
          startTime: "2026-01-15",
          endTime: "2026-02-03",
        })
      ).rejects.toThrow("Cost Explorer API unavailable");
    });

    it("should sort services by cost descending", async () => {
      mockSend.mockResolvedValue({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Lambda"],
                Metrics: { UnblendedCost: { Amount: "10.00" } },
              },
              {
                Keys: ["EC2"],
                Metrics: { UnblendedCost: { Amount: "200.00" } },
              },
              {
                Keys: ["S3"],
                Metrics: { UnblendedCost: { Amount: "50.00" } },
              },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      expect(result.costsByService[0].serviceName).toBe("EC2");
      expect(result.costsByService[1].serviceName).toBe("S3");
      expect(result.costsByService[2].serviceName).toBe("Lambda");
    });

    it("should maintain precision with many small amounts", async () => {
      // Simulate many pages with small costs that would accumulate precision errors
      // with floating-point arithmetic
      // This test demonstrates the classic floating-point precision issue:
      // With floats: 0.1 + 0.1 + 0.1 repeated 10 times = 0.9999999999999999 instead of 1.0
      const pages = 10;

      for (let i = 0; i < pages; i++) {
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: ["Amazon S3"],
                  Metrics: { UnblendedCost: { Amount: "0.10" } }, // 10 cents
                },
              ],
            },
          ],
          NextPageToken: i < pages - 1 ? `page-${i + 2}` : undefined,
        });
      }

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      // With integer cents arithmetic: 10 pages × 0.10 = 1.00 exactly
      // The result should be exactly 1.00, not 0.9999999999999999
      expect(result.totalCost).toBe(1.00);
      expect(result.costsByService[0].cost).toBe(1.00);
      expect(mockSend).toHaveBeenCalledTimes(pages);
    });

    it("should maintain precision with fractional cents", async () => {
      // Test amounts with fractional cents (which get rounded)
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: { UnblendedCost: { Amount: "0.0015" } }, // 0.15 cents -> rounds to 0
              },
              {
                Keys: ["Amazon S3"],
                Metrics: { UnblendedCost: { Amount: "0.0025" } }, // 0.25 cents -> rounds to 0
              },
            ],
          },
        ],
        NextPageToken: "page-2",
      });

      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: { UnblendedCost: { Amount: "0.0045" } }, // 0.45 cents -> rounds to 0
              },
              {
                Keys: ["Amazon S3"],
                Metrics: { UnblendedCost: { Amount: "0.0055" } }, // 0.55 cents -> rounds to 1
              },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-15",
        endTime: "2026-02-03",
      });

      // EC2: rounds(0.15) + rounds(0.45) = 0 + 0 = 0 cents = $0.00
      // S3: rounds(0.25) + rounds(0.55) = 0 + 1 = 1 cent = $0.01
      // Total: 1 cent = $0.01
      expect(result.totalCost).toBe(0.01);
      expect(result.costsByService[0].cost).toBe(0.01); // S3 (highest)
      expect(result.costsByService[1].cost).toBe(0.00); // EC2
    });

    it("should maintain precision across multiple pages with same service", async () => {
      // Test aggregating many small amounts for the same service
      const pages = 10; // Reduced from 100 to stay under MAX_PAGES during normal tests

      for (let i = 0; i < pages; i++) {
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: ["Amazon CloudWatch"],
                  Metrics: { UnblendedCost: { Amount: "0.10" } }, // 10 cents each
                },
              ],
            },
          ],
          NextPageToken: i < pages - 1 ? `page-${i + 2}` : undefined,
        });
      }

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-01",
        endTime: "2026-02-03",
      });

      // 10 pages × $0.10 = $1.00 exactly
      expect(result.totalCost).toBe(1.00);
      expect(result.costsByService).toHaveLength(1);
      expect(result.costsByService[0].cost).toBe(1.00);
      expect(mockSend).toHaveBeenCalledTimes(pages);
    });

    it("should handle large aggregations without precision loss", async () => {
      // Create a scenario with many services and small costs
      const dailyResults = [];

      // Simulate 30 days of costs
      for (let day = 0; day < 30; day++) {
        dailyResults.push({
          Groups: [
            {
              Keys: ["Amazon EC2"],
              Metrics: { UnblendedCost: { Amount: "0.33" } }, // 33 cents
            },
            {
              Keys: ["Amazon S3"],
              Metrics: { UnblendedCost: { Amount: "0.33" } }, // 33 cents
            },
            {
              Keys: ["Amazon Lambda"],
              Metrics: { UnblendedCost: { Amount: "0.34" } }, // 34 cents
            },
          ],
        });
      }

      mockSend.mockResolvedValue({
        ResultsByTime: dailyResults,
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-01",
        endTime: "2026-01-31",
      });

      // EC2: 30 × $0.33 = $9.90
      // S3: 30 × $0.33 = $9.90
      // Lambda: 30 × $0.34 = $10.20
      // Total: $30.00
      expect(result.totalCost).toBe(30.00);

      const ec2Cost = result.costsByService.find(s => s.serviceName === "Amazon EC2")?.cost;
      const s3Cost = result.costsByService.find(s => s.serviceName === "Amazon S3")?.cost;
      const lambdaCost = result.costsByService.find(s => s.serviceName === "Amazon Lambda")?.cost;

      expect(ec2Cost).toBe(9.90);
      expect(s3Cost).toBe(9.90);
      expect(lambdaCost).toBe(10.20);
    });

    describe("rate limiting and safety features", () => {
      it("should stop pagination at MAX_PAGES limit (50 pages)", { timeout: 15000 }, async () => {
        // Mock 60 pages to exceed the limit
        const totalPages = 60;
        const maxPages = 50;

        for (let i = 0; i < totalPages; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  {
                    Keys: [`Service-${i}`],
                    Metrics: { UnblendedCost: { Amount: "1.00" } },
                  },
                ],
              },
            ],
            NextPageToken: `page-${i + 2}`, // Always return NextPageToken
          });
        }

        // Spy on console.warn to verify warning is logged
        const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-01",
          endTime: "2026-02-03",
        });

        // Should stop at MAX_PAGES
        expect(mockSend).toHaveBeenCalledTimes(maxPages);

        // Should log warning about hitting the limit
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[SAFETY] Pagination stopped at MAX_PAGES limit")
        );

        // Should still return results for the pages that were fetched
        expect(result.totalCost).toBe(maxPages); // 50 pages × $1.00
        expect(result.costsByService).toHaveLength(maxPages);

        consoleWarnSpy.mockRestore();
      });

      it("should add rate limiting delay between paginated requests", async () => {
        // Mock 3 pages
        for (let i = 0; i < 3; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  {
                    Keys: ["Service"],
                    Metrics: { UnblendedCost: { Amount: "1.00" } },
                  },
                ],
              },
            ],
            NextPageToken: i < 2 ? `page-${i + 2}` : undefined,
          });
        }

        const startTime = Date.now();

        const { getCostData } = await import("./cost-explorer.js");
        await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-01",
          endTime: "2026-02-03",
        });

        const endTime = Date.now();
        const elapsed = endTime - startTime;

        // Should take at least 400ms (2 delays × 200ms) for 3 pages
        // The last page doesn't need a delay
        expect(elapsed).toBeGreaterThanOrEqual(400);
        expect(mockSend).toHaveBeenCalledTimes(3);
      });

      it("should stop pagination when Lambda timeout is approaching", async () => {
        // Mock context with low remaining time
        // The timeout check happens when pageCount > 0, so it checks AFTER page 1 is fetched
        const mockContext = {
          getRemainingTimeInMillis: vi.fn()
            // First page doesn't check timeout (pageCount = 0)
            .mockReturnValueOnce(50000)  // After page 1, before page 2: 50 seconds remaining (OK, > 10 seconds)
            .mockReturnValueOnce(8000)   // After page 2, before page 3: 8 seconds remaining (approaching timeout - stop)
        };

        // Mock 5 pages but should stop after 2 due to timeout before page 3
        for (let i = 0; i < 5; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  {
                    Keys: [`Service-${i}`],
                    Metrics: { UnblendedCost: { Amount: "1.00" } },
                  },
                ],
              },
            ],
            NextPageToken: `page-${i + 2}`,
          });
        }

        const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData(
          {
            accountId: "123456789012",
            startTime: "2026-01-01",
            endTime: "2026-02-03",
          },
          {
            lambdaContext: mockContext,
          }
        );

        // Should stop after 2 pages due to timeout
        expect(mockSend).toHaveBeenCalledTimes(2);

        // Should log warning about timeout
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[SAFETY] Pagination stopped")
        );
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Lambda timeout approaching")
        );

        // Should return partial results
        expect(result.totalCost).toBe(2.00);
        expect(result.costsByService).toHaveLength(2);

        consoleWarnSpy.mockRestore();
      });

      it("should continue pagination when Lambda has sufficient time remaining", async () => {
        // Mock context with plenty of remaining time
        const mockContext = {
          getRemainingTimeInMillis: vi.fn().mockReturnValue(800000) // 800 seconds remaining
        };

        // Mock 3 pages with natural termination (no NextPageToken on last page)
        for (let i = 0; i < 3; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  {
                    Keys: [`Service-${i}`],
                    Metrics: { UnblendedCost: { Amount: "1.00" } },
                  },
                ],
              },
            ],
            NextPageToken: i < 2 ? `page-${i + 2}` : undefined,
          });
        }

        const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData(
          {
            accountId: "123456789012",
            startTime: "2026-01-01",
            endTime: "2026-02-03",
          },
          {
            lambdaContext: mockContext,
          }
        );

        // Should fetch all 3 pages
        expect(mockSend).toHaveBeenCalledTimes(3);

        // Should not log any timeout warnings
        expect(consoleWarnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("Lambda timeout approaching")
        );

        // Should return complete results
        expect(result.totalCost).toBe(3.00);
        expect(result.costsByService).toHaveLength(3);

        consoleWarnSpy.mockRestore();
      });

      it("should not add delay after the final page", async () => {
        // Mock 2 pages (second has no NextPageToken)
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: ["Service"],
                  Metrics: { UnblendedCost: { Amount: "1.00" } },
                },
              ],
            },
          ],
          NextPageToken: "page-2",
        });

        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: ["Service"],
                  Metrics: { UnblendedCost: { Amount: "1.00" } },
                },
              ],
            },
          ],
          // No NextPageToken - final page
        });

        const startTime = Date.now();

        const { getCostData } = await import("./cost-explorer.js");
        await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-01",
          endTime: "2026-02-03",
        });

        const endTime = Date.now();
        const elapsed = endTime - startTime;

        // Should take at least 200ms (1 delay) but less than 400ms (2 delays)
        expect(elapsed).toBeGreaterThanOrEqual(200);
        expect(elapsed).toBeLessThan(400);
        expect(mockSend).toHaveBeenCalledTimes(2);
      });

      it("should handle MAX_PAGES boundary exactly", { timeout: 15000 }, async () => {
        // Mock exactly 50 pages (the limit) that naturally terminates
        const maxPages = 50;

        for (let i = 0; i < maxPages; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  {
                    Keys: [`Service-${i}`],
                    Metrics: { UnblendedCost: { Amount: "1.00" } },
                  },
                ],
              },
            ],
            NextPageToken: i < maxPages - 1 ? `page-${i + 2}` : undefined, // Natural termination
          });
        }

        const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-01",
          endTime: "2026-02-03",
        });

        // Should fetch all 50 pages
        expect(mockSend).toHaveBeenCalledTimes(maxPages);

        // Should NOT log warning (natural termination, not limit hit)
        expect(consoleWarnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("[SAFETY] Pagination stopped at MAX_PAGES limit")
        );

        // Should return complete results
        expect(result.totalCost).toBe(50.00);
        expect(result.costsByService).toHaveLength(50);

        consoleWarnSpy.mockRestore();
      });
    });
  });
});
