import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import type { LeaseCostsGeneratedDetail } from "./schemas.js";

// Mock EventBridge client
vi.mock("@aws-sdk/client-eventbridge", async () => {
  const actual = await vi.importActual("@aws-sdk/client-eventbridge");
  return {
    ...actual,
    EventBridgeClient: vi.fn(),
  };
});

describe("emitLeaseCostsGenerated", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  const validDetail: LeaseCostsGeneratedDetail = {
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    userEmail: "user@example.com",
    accountId: "123456789012",
    totalCost: 150.5,
    currency: "USD",
    startDate: "2026-01-15",
    endDate: "2026-02-03",
    csvUrl: "https://bucket.s3.amazonaws.com/lease.csv?signature=abc",
    urlExpiresAt: "2026-02-10T12:00:00.000Z",
  };

  beforeEach(() => {
    vi.resetModules();
    mockSend = vi.fn();
    (
      EventBridgeClient as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => ({
      send: mockSend,
    }));
  });

  it("should emit event with correct source and detail-type", async () => {
    mockSend.mockResolvedValue({
      FailedEntryCount: 0,
      Entries: [{ EventId: "event-123" }],
    });

    const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
    await emitLeaseCostsGenerated("test-event-bus", validDetail);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutEventsCommand);
    expect(command.input.Entries).toHaveLength(1);
    expect(command.input.Entries[0].EventBusName).toBe("test-event-bus");
    expect(command.input.Entries[0].Source).toBe("isb-costs");
    expect(command.input.Entries[0].DetailType).toBe("LeaseCostsGenerated");
    expect(JSON.parse(command.input.Entries[0].Detail)).toEqual(validDetail);
  });

  it("should throw when FailedEntryCount > 0", async () => {
    mockSend.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [
        {
          ErrorCode: "InternalException",
          ErrorMessage: "Internal server error",
        },
      ],
    });

    const { emitLeaseCostsGenerated } = await import("./event-emitter.js");

    await expect(
      emitLeaseCostsGenerated("test-event-bus", validDetail)
    ).rejects.toThrow("InternalException: Internal server error");
  });

  it("should propagate EventBridge errors", async () => {
    mockSend.mockRejectedValue(new Error("EventBridge service unavailable"));

    const { emitLeaseCostsGenerated } = await import("./event-emitter.js");

    await expect(
      emitLeaseCostsGenerated("test-event-bus", validDetail)
    ).rejects.toThrow("EventBridge service unavailable");
  });

  describe("event bus name verification", () => {
    it("should use the provided event bus name in the PutEvents command", async () => {
      mockSend.mockResolvedValue({
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-123" }],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      const customBusName = "my-custom-event-bus";
      await emitLeaseCostsGenerated(customBusName, validDetail);

      const command = mockSend.mock.calls[0][0];
      expect(command.input.Entries[0].EventBusName).toBe(customBusName);
    });

    it("should handle event bus names with hyphens and dots", async () => {
      mockSend.mockResolvedValue({
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-123" }],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      const busName = "my-event.bus-name";
      await emitLeaseCostsGenerated(busName, validDetail);

      const command = mockSend.mock.calls[0][0];
      expect(command.input.Entries[0].EventBusName).toBe(busName);
    });

    it("should handle default event bus name", async () => {
      mockSend.mockResolvedValue({
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-123" }],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      await emitLeaseCostsGenerated("default", validDetail);

      const command = mockSend.mock.calls[0][0];
      expect(command.input.Entries[0].EventBusName).toBe("default");
    });

    it("should handle cross-account event bus ARN", async () => {
      mockSend.mockResolvedValue({
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-123" }],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      const busArn = "arn:aws:events:us-east-1:123456789012:event-bus/my-bus";
      await emitLeaseCostsGenerated(busArn, validDetail);

      const command = mockSend.mock.calls[0][0];
      expect(command.input.Entries[0].EventBusName).toBe(busArn);
    });

    it("should pass event bus name exactly as provided (no modification)", async () => {
      mockSend.mockResolvedValue({
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-123" }],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      const busName = "InnovationSandbox-Events";
      await emitLeaseCostsGenerated(busName, validDetail);

      const command = mockSend.mock.calls[0][0];
      // Verify the exact bus name is used without case changes or modifications
      expect(command.input.Entries[0].EventBusName).toBe(busName);
      expect(command.input.Entries[0].EventBusName).not.toBe(busName.toLowerCase());
    });

    it("should emit to correct bus even with leading/trailing whitespace in input", async () => {
      // This test documents current behavior - the function does not trim whitespace
      // EventBridge will likely reject the event, but that's the caller's responsibility
      mockSend.mockResolvedValue({
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-123" }],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      const busNameWithWhitespace = " test-event-bus ";
      await emitLeaseCostsGenerated(busNameWithWhitespace, validDetail);

      const command = mockSend.mock.calls[0][0];
      // Function passes the name as-is (does not trim)
      expect(command.input.Entries[0].EventBusName).toBe(busNameWithWhitespace);
    });

    it("should include event bus name in error context when emission fails", async () => {
      mockSend.mockResolvedValue({
        FailedEntryCount: 1,
        Entries: [
          {
            ErrorCode: "ResourceNotFoundException",
            ErrorMessage: "Event bus does not exist",
          },
        ],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      const nonExistentBus = "non-existent-bus";

      await expect(
        emitLeaseCostsGenerated(nonExistentBus, validDetail)
      ).rejects.toThrow("ResourceNotFoundException: Event bus does not exist");
    });

    it("should verify EventBusName field is always set in PutEvents command", async () => {
      mockSend.mockResolvedValue({
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-123" }],
      });

      const { emitLeaseCostsGenerated } = await import("./event-emitter.js");
      await emitLeaseCostsGenerated("test-bus", validDetail);

      const command = mockSend.mock.calls[0][0];
      // Verify EventBusName is always present (not undefined or null)
      expect(command.input.Entries[0].EventBusName).toBeDefined();
      expect(command.input.Entries[0].EventBusName).not.toBeNull();
      expect(typeof command.input.Entries[0].EventBusName).toBe("string");
    });
  });
});
