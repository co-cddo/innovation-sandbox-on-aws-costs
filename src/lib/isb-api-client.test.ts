import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @co-cddo/isb-client
const mockFetchLeaseByKey = vi.fn();
const mockResetTokenCache = vi.fn();

vi.mock("@co-cddo/isb-client", () => ({
  createISBClient: vi.fn(() => ({
    fetchLeaseByKey: mockFetchLeaseByKey,
    fetchLease: vi.fn(),
    fetchAccount: vi.fn(),
    fetchTemplate: vi.fn(),
    reviewLease: vi.fn(),
    fetchAllAccounts: vi.fn(),
    registerAccount: vi.fn(),
    resetTokenCache: mockResetTokenCache,
  })),
}));

describe("isb-api-client", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetchLeaseByKey.mockReset();
    mockResetTokenCache.mockReset();
  });

  describe("getLeaseDetails", () => {
    it("should return validated lease details on success", async () => {
      mockFetchLeaseByKey.mockResolvedValue({
        startDate: "2026-01-15T10:00:00.000Z",
        expirationDate: "2026-02-15T10:00:00.000Z",
        awsAccountId: "123456789012",
        status: "Active",
        userEmail: "user@example.com",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
      });

      const { getLeaseDetails } = await import("./isb-api-client.js");
      const result = await getLeaseDetails(
        "user@example.com",
        "550e8400-e29b-41d4-a716-446655440000",
        "test-correlation-id",
      );

      expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
      expect(result.awsAccountId).toBe("123456789012");
      expect(result.status).toBe("Active");
    });

    it("should call fetchLeaseByKey with correct parameters", async () => {
      mockFetchLeaseByKey.mockResolvedValue({
        startDate: "2026-01-15T10:00:00.000Z",
        expirationDate: "2026-02-15T10:00:00.000Z",
        awsAccountId: "123456789012",
        status: "Active",
      });

      const { getLeaseDetails } = await import("./isb-api-client.js");
      await getLeaseDetails(
        "user@example.com",
        "550e8400-e29b-41d4-a716-446655440000",
        "test-correlation-id",
      );

      expect(mockFetchLeaseByKey).toHaveBeenCalledWith(
        "user@example.com",
        "550e8400-e29b-41d4-a716-446655440000",
        "test-correlation-id",
      );
    });

    it("should throw when lease is not found (null result)", async () => {
      mockFetchLeaseByKey.mockResolvedValue(null);

      const { getLeaseDetails } = await import("./isb-api-client.js");

      await expect(
        getLeaseDetails(
          "user@example.com",
          "unknown-uuid",
          "test-correlation-id",
        ),
      ).rejects.toThrow("Lease not found or ISB API error");
    });

    it("should throw on invalid response schema (missing startDate)", async () => {
      mockFetchLeaseByKey.mockResolvedValue({
        status: "Active",
        // Missing startDate, expirationDate, awsAccountId
      });

      const { getLeaseDetails } = await import("./isb-api-client.js");

      await expect(
        getLeaseDetails(
          "user@example.com",
          "some-uuid",
          "test-correlation-id",
        ),
      ).rejects.toThrow("Invalid lease details response");
    });

    it("should throw on invalid awsAccountId format in response", async () => {
      mockFetchLeaseByKey.mockResolvedValue({
        startDate: "2026-01-15T10:00:00.000Z",
        expirationDate: "2026-02-15T10:00:00.000Z",
        awsAccountId: "12345", // Not 12 digits
        status: "Active",
      });

      const { getLeaseDetails } = await import("./isb-api-client.js");

      await expect(
        getLeaseDetails(
          "user@example.com",
          "some-uuid",
          "test-correlation-id",
        ),
      ).rejects.toThrow("Invalid lease details response");
    });

    it("should throw on invalid date format in response", async () => {
      mockFetchLeaseByKey.mockResolvedValue({
        startDate: "not-a-valid-date",
        expirationDate: "2026-02-15T10:00:00.000Z",
        awsAccountId: "123456789012",
        status: "Active",
      });

      const { getLeaseDetails } = await import("./isb-api-client.js");

      await expect(
        getLeaseDetails(
          "user@example.com",
          "some-uuid",
          "test-correlation-id",
        ),
      ).rejects.toThrow("Invalid lease details response");
    });

    it("should pass through extra fields from ISB API", async () => {
      mockFetchLeaseByKey.mockResolvedValue({
        startDate: "2026-01-15T10:00:00.000Z",
        expirationDate: "2026-02-15T10:00:00.000Z",
        awsAccountId: "123456789012",
        status: "Active",
        templateName: "empty-sandbox",
        maxSpend: 100,
      });

      const { getLeaseDetails } = await import("./isb-api-client.js");
      const result = await getLeaseDetails(
        "user@example.com",
        "some-uuid",
        "test-correlation-id",
      );

      // passthrough() in schema allows extra fields
      expect(result).toHaveProperty("templateName", "empty-sandbox");
      expect(result).toHaveProperty("maxSpend", 100);
    });
  });
});
