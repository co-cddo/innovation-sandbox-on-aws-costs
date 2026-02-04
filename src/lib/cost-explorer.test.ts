/**
 * Unit tests for AWS Cost Explorer module.
 *
 * These tests use mocked AWS SDK clients for fast, isolated unit testing.
 *
 * Test Coverage:
 * - Client creation with credentials and profiles
 * - Resource-level cost data retrieval with GetCostAndUsageWithResources
 * - 14-day boundary detection and fallback handling
 * - Pagination handling with NextPageToken
 * - Rate limiting delays
 * - Safety features (MAX_PAGES, Lambda timeout detection)
 * - Precision handling with Decimal.js
 * - Sort order (service total → resource cost)
 * - Error handling including opt-in errors
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageWithResourcesCommand,
} from "@aws-sdk/client-cost-explorer";

// Mock Cost Explorer client
vi.mock("@aws-sdk/client-cost-explorer", async () => {
  const actual = await vi.importActual("@aws-sdk/client-cost-explorer");
  return {
    ...actual,
    CostExplorerClient: vi.fn(function() { return {}; }),
  };
});

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: vi.fn().mockReturnValue({ accessKeyId: "test", secretAccessKey: "test" }),
}));

describe("cost-explorer", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockSend = vi.fn(function() {});
    (CostExplorerClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function() {
        return {
          send: mockSend,
        };
      }
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
    it("should return resource-level costs from single page response", async () => {
      // Mock service list query
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
              { Keys: ["Amazon S3"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
            ],
          },
        ],
      });

      // Mock resource query for EC2
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
            ],
          },
        ],
      });

      // Mock resource query for S3
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["my-bucket", "us-west-2"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-20",
        endTime: "2026-02-03",
      });

      expect(result.totalCost).toBe(150);
      expect(result.costsByResource).toHaveLength(2);
      // Sorted by cost descending
      expect(result.costsByResource[0].resourceName).toBe("i-1234567890abcdef0");
      expect(result.costsByResource[0].serviceName).toBe("Amazon EC2");
      expect(result.costsByResource[0].region).toBe("us-east-1");
      expect(result.costsByResource[0].cost).toBe("100");
      expect(result.costsByResource[1].resourceName).toBe("my-bucket");
      expect(result.costsByResource[1].serviceName).toBe("Amazon S3");
      expect(result.costsByResource[1].cost).toBe("50");
    });

    it("should handle pagination with NextPageToken for resource queries", async () => {
      // Mock service list
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "150.00" } } }] },
        ],
      });

      // First page of resources
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
            ],
          },
        ],
        NextPageToken: "page-2-token",
      });

      // Second page of resources
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["i-0987654321fedcba0", "us-west-2"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-20",
        endTime: "2026-02-03",
      });

      expect(result.totalCost).toBe(150);
      expect(result.costsByResource).toHaveLength(2);
    });

    it("should aggregate same resource across pages", async () => {
      // Mock service list
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "150.00" } } }] },
        ],
      });

      // First page
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
            ],
          },
        ],
        NextPageToken: "page-2",
      });

      // Second page - same resource
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-20",
        endTime: "2026-02-03",
      });

      expect(result.totalCost).toBe(150);
      expect(result.costsByResource).toHaveLength(1);
      expect(result.costsByResource[0].cost).toBe("150");
    });

    it("should return empty costsByResource for no results", async () => {
      mockSend.mockResolvedValue({
        ResultsByTime: [],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-20",
        endTime: "2026-02-03",
      });

      expect(result.totalCost).toBe(0);
      expect(result.costsByResource).toHaveLength(0);
    });

    it("should use fallback text for empty resource IDs", async () => {
      // Mock service list
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          { Groups: [{ Keys: ["Amazon GuardDuty"], Metrics: { UnblendedCost: { Amount: "50.00" } } }] },
        ],
      });

      // Mock resource query - empty resource ID
      mockSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              { Keys: ["", "us-east-1"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
            ],
          },
        ],
      });

      const { getCostData } = await import("./cost-explorer.js");
      const result = await getCostData({
        accountId: "123456789012",
        startTime: "2026-01-20",
        endTime: "2026-02-03",
      });

      expect(result.costsByResource[0].resourceName).toBe("No resource breakdown available for this service type");
      expect(result.costsByResource[0].serviceName).toBe("Amazon GuardDuty");
    });

    it("should throw on API error", async () => {
      mockSend.mockRejectedValue(new Error("Cost Explorer API unavailable"));

      const { getCostData } = await import("./cost-explorer.js");

      await expect(
        getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        })
      ).rejects.toThrow("Cost Explorer API unavailable");
    });

    describe("14-day boundary detection", () => {
      it("should not use fallback for lease exactly 14 days", async () => {
        // Exactly 14 days - should fit within resource window
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        // Mock resource query
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
              ],
            },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03", // Exactly 14 days
        });

        expect(result.costsByResource).toHaveLength(1);
        // No fallback text
        expect(result.costsByResource[0].resourceName).not.toContain("No resource breakdown available for this time window");
      });

      it("should use fallback for lease longer than 14 days", async () => {
        // 20 days - needs fallback for first 6 days
        // Mock service list for resource window
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "70.00" } } }] },
          ],
        });

        // Mock resource query
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "70.00" } } },
              ],
            },
          ],
        });

        // Mock fallback query (service-level for earlier period)
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "30.00" } } },
              ],
            },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-14",
          endTime: "2026-02-03", // 20 days
        });

        expect(result.totalCost).toBe(100);
        // Should have resource + fallback
        const fallbackResource = result.costsByResource.find(
          r => r.resourceName === "No resource breakdown available for this time window"
        );
        expect(fallbackResource).toBeDefined();
        expect(fallbackResource?.serviceName).toBe("Amazon EC2");
        expect(fallbackResource?.cost).toBe("30");
      });

      it("should handle 30 day lease with 16 days in fallback", async () => {
        // 30 days: 16 days fallback, 14 days resource
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "140.00" } } }] },
          ],
        });

        // Mock resource query
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "140.00" } } },
              ],
            },
          ],
        });

        // Mock fallback query
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "160.00" } } },
              ],
            },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-04",
          endTime: "2026-02-03", // 30 days
        });

        expect(result.totalCost).toBe(300);
      });
    });

    describe("sort order", () => {
      it("should sort services by total cost descending", async () => {
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["Lambda"], Metrics: { UnblendedCost: { Amount: "10.00" } } },
                { Keys: ["EC2"], Metrics: { UnblendedCost: { Amount: "200.00" } } },
                { Keys: ["S3"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
              ],
            },
          ],
        });

        // Mock resource queries in service order (Lambda, EC2, S3)
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["fn-1", "us-east-1"], Metrics: { UnblendedCost: { Amount: "10.00" } } }] },
          ],
        });
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["i-1", "us-east-1"], Metrics: { UnblendedCost: { Amount: "200.00" } } }] },
          ],
        });
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["bucket-1", "us-east-1"], Metrics: { UnblendedCost: { Amount: "50.00" } } }] },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        // EC2 (200) > S3 (50) > Lambda (10)
        expect(result.costsByResource[0].serviceName).toBe("EC2");
        expect(result.costsByResource[1].serviceName).toBe("S3");
        expect(result.costsByResource[2].serviceName).toBe("Lambda");
      });

      it("should sort resources within service by cost descending", async () => {
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "300.00" } } }] },
          ],
        });

        // Mock resource query with multiple resources
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["i-small", "us-east-1"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
                { Keys: ["i-large", "us-east-1"], Metrics: { UnblendedCost: { Amount: "200.00" } } },
                { Keys: ["i-medium", "us-east-1"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
              ],
            },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        expect(result.costsByResource[0].resourceName).toBe("i-large");
        expect(result.costsByResource[0].cost).toBe("200");
      });

      it("should place fallback rows after resource rows for each service", async () => {
        // Mock service list for resource window
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        // Mock resource query
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["i-1234567890abcdef0", "us-east-1"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        // Mock fallback query
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "50.00" } } }] },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-14",
          endTime: "2026-02-03", // 20 days
        });

        // Resource row should come before fallback row
        const ec2Resources = result.costsByResource.filter(r => r.serviceName === "Amazon EC2");
        expect(ec2Resources[0].resourceName).toBe("i-1234567890abcdef0");
        expect(ec2Resources[1].resourceName).toBe("No resource breakdown available for this time window");
      });
    });

    describe("precision handling", () => {
      it("should preserve 15 decimal place precision", async () => {
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon S3"], Metrics: { UnblendedCost: { Amount: "0.123456789012345" } } }] },
          ],
        });

        // Mock resource query
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["my-bucket", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0.123456789012345" } } },
              ],
            },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        expect(result.costsByResource[0].cost).toBe("0.123456789012345");
      });

      it("should calculate totalCost accurately with Decimal.js", async () => {
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Service"], Metrics: { UnblendedCost: { Amount: "0.30" } } }] },
          ],
        });

        // Mock resource query - classic floating point problem: 0.1 + 0.1 + 0.1
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["r1", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0.1" } } },
                { Keys: ["r2", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0.1" } } },
                { Keys: ["r3", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0.1" } } },
              ],
            },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        // With floating point: 0.1 + 0.1 + 0.1 = 0.30000000000000004
        // With Decimal.js: 0.1 + 0.1 + 0.1 = 0.3
        expect(result.totalCost).toBe(0.3);
      });

      it("should sort correctly with Decimal.js comparison", async () => {
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Service"], Metrics: { UnblendedCost: { Amount: "1.1" } } }] },
          ],
        });

        // Mock resource query - costs that might sort wrong with string comparison
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["r-9", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0.9" } } },
                { Keys: ["r-10", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0.10" } } },
                { Keys: ["r-11", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0.11" } } },
              ],
            },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        // Correct numeric order: 0.9 > 0.11 > 0.10
        expect(result.costsByResource[0].resourceName).toBe("r-9");
        expect(result.costsByResource[1].resourceName).toBe("r-11");
        expect(result.costsByResource[2].resourceName).toBe("r-10");
      });
    });

    describe("opt-in error handling (graceful degradation)", () => {
      it("should gracefully degrade to service-level data when resource API not enabled", async () => {
        const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        // Mock resource query - throws opt-in error
        const optInError = new Error("You must enable Cost Explorer resource-level data at the payer account level");
        optInError.name = "DataUnavailableException";
        mockSend.mockRejectedValueOnce(optInError);

        // Mock fallback service-level query (graceful degradation)
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");

        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        // Should return service-level data with fallback text instead of throwing
        expect(result.costsByResource).toHaveLength(1);
        expect(result.costsByResource[0].resourceName).toBe(
          "No resource breakdown available (API not enabled at organization level)"
        );
        expect(result.costsByResource[0].serviceName).toBe("Amazon EC2");
        expect(result.costsByResource[0].cost).toBe("100");
        expect(result.totalCost).toBe(100);

        // Should log a warning about degraded mode
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[DEGRADED MODE]")
        );

        consoleWarnSpy.mockRestore();
      });

      it("should gracefully degrade when AccessDeniedException mentions GetCostAndUsageWithResources", async () => {
        const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        // Mock resource query - throws AccessDeniedException for missing IAM permission
        const accessDeniedError = new Error(
          "User: arn:aws:sts::123456789012:assumed-role/some-role/session is not authorized to perform: " +
            "ce:GetCostAndUsageWithResources on resource: arn:aws:ce:us-east-1:123456789012:/GetCostAndUsageWithResources " +
            "because no identity-based policy allows the ce:GetCostAndUsageWithResources action"
        );
        accessDeniedError.name = "AccessDeniedException";
        mockSend.mockRejectedValueOnce(accessDeniedError);

        // Mock fallback service-level query (graceful degradation)
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        const { getCostData } = await import("./cost-explorer.js");

        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        // Should return service-level data with fallback text indicating the IAM permission issue
        expect(result.costsByResource).toHaveLength(1);
        expect(result.costsByResource[0].resourceName).toBe(
          "No resource breakdown available (IAM policy missing ce:GetCostAndUsageWithResources permission)"
        );
        expect(result.costsByResource[0].serviceName).toBe("Amazon EC2");
        expect(result.costsByResource[0].cost).toBe("100");
        expect(result.totalCost).toBe(100);

        // Should log a warning about degraded mode with IAM permission reason
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[DEGRADED MODE] IAM policy missing ce:GetCostAndUsageWithResources permission")
        );

        consoleWarnSpy.mockRestore();
      });

      it("should re-throw non-opt-in errors", async () => {
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }] },
          ],
        });

        // Mock resource query - throws a different error (not opt-in related)
        const otherError = new Error("Access denied");
        otherError.name = "AccessDeniedException";
        mockSend.mockRejectedValueOnce(otherError);

        const { getCostData } = await import("./cost-explorer.js");

        await expect(
          getCostData({
            accountId: "123456789012",
            startTime: "2026-01-20",
            endTime: "2026-02-03",
          })
        ).rejects.toThrow("Access denied");
      });
    });

    describe("rate limiting and safety features", () => {
      it("should stop pagination at MAX_PAGES limit (50 pages)", async () => {
        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "5100.00" } } }] },
          ],
        });

        // Mock 60 pages of resources to exceed the limit
        const totalPages = 60;
        const maxPages = 50;

        for (let i = 0; i < totalPages; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  {
                    Keys: [`resource-${i}`, "us-east-1"],
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
        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        // Service list query + MAX_PAGES resource queries
        expect(mockSend).toHaveBeenCalledTimes(1 + maxPages);

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[SAFETY]")
        );

        expect(result.costsByResource).toHaveLength(maxPages);

        consoleWarnSpy.mockRestore();
      });

      it("should add rate limiting delay between API calls", async () => {
        // Use fake timers for deterministic testing
        vi.useFakeTimers();

        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                { Keys: ["Service1"], Metrics: { UnblendedCost: { Amount: "1.00" } } },
                { Keys: ["Service2"], Metrics: { UnblendedCost: { Amount: "1.00" } } },
                { Keys: ["Service3"], Metrics: { UnblendedCost: { Amount: "1.00" } } },
              ],
            },
          ],
        });

        // Mock resource queries for each service
        for (let i = 0; i < 3; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  { Keys: [`r-${i}`, "us-east-1"], Metrics: { UnblendedCost: { Amount: "1.00" } } },
                ],
              },
            ],
          });
        }

        const { getCostData } = await import("./cost-explorer.js");
        const resultPromise = getCostData({
          accountId: "123456789012",
          startTime: "2026-01-20",
          endTime: "2026-02-03",
        });

        // Run all pending timers to completion
        await vi.runAllTimersAsync();

        await resultPromise;

        // Verify the number of API calls: 1 service list + 3 resource queries = 4 calls
        // Rate limiting sleep is called before each service query + after service list pagination
        expect(mockSend).toHaveBeenCalledTimes(4);

        vi.useRealTimers();
      });

      it("should stop pagination when Lambda timeout is approaching", async () => {
        const mockContext = {
          getRemainingTimeInMillis: vi.fn()
            .mockReturnValueOnce(50000) // After page 1
            .mockReturnValueOnce(8000)  // After page 2 - approaching timeout
        };

        // Mock service list
        mockSend.mockResolvedValueOnce({
          ResultsByTime: [
            { Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "500.00" } } }] },
          ],
        });

        // Mock 5 pages but should stop after 2 due to timeout
        for (let i = 0; i < 5; i++) {
          mockSend.mockResolvedValueOnce({
            ResultsByTime: [
              {
                Groups: [
                  { Keys: [`resource-${i}`, "us-east-1"], Metrics: { UnblendedCost: { Amount: "1.00" } } },
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
            startTime: "2026-01-20",
            endTime: "2026-02-03",
          },
          { lambdaContext: mockContext }
        );

        // Service list + 2 resource pages
        expect(mockSend).toHaveBeenCalledTimes(3);

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[SAFETY]")
        );
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Lambda timeout approaching")
        );

        expect(result.costsByResource).toHaveLength(2);

        consoleWarnSpy.mockRestore();
      });
    });
  });
});
