import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SchedulerClient,
  ListSchedulesCommand,
  GetScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  type ScheduleSummary,
} from "@aws-sdk/client-scheduler";

// Mock Scheduler client
vi.mock("@aws-sdk/client-scheduler", async () => {
  const actual = await vi.importActual("@aws-sdk/client-scheduler");
  return {
    ...actual,
    SchedulerClient: vi.fn(function() {}),
  };
});

vi.mock("../lib/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("cleanup-handler", () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let handler: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSend = vi.fn(function() {});
    (SchedulerClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function() {
        return {
          send: mockSend,
        };
      }
    );

    // Set environment variables
    vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");

    const module = await import("./cleanup-handler.js");
    handler = module.handler;
  });

  const createSchedule = (
    name: string,
    hoursFromNow: number
  ): ScheduleSummary => {
    return {
      Name: name,
      State: "ENABLED",
    };
  };

  const createScheduleExpression = (hoursFromNow: number): string => {
    const scheduledTime = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
    const iso = scheduledTime.toISOString().slice(0, 19);
    return `at(${iso})`;
  };

  it("should delete schedules older than 72 hours", async () => {
    const staleSchedule = createSchedule("lease-costs-old", -73); // 73 hours ago
    const recentSchedule = createSchedule("lease-costs-recent", -71); // 71 hours ago

    mockSend
      .mockResolvedValueOnce({
        // ListSchedules
        Schedules: [staleSchedule, recentSchedule],
      })
      .mockResolvedValueOnce({
        // GetSchedule for staleSchedule
        ScheduleExpression: createScheduleExpression(-73),
      })
      .mockResolvedValueOnce({
        // GetSchedule for recentSchedule
        ScheduleExpression: createScheduleExpression(-71),
      })
      .mockResolvedValueOnce({}); // DeleteSchedule for staleSchedule

    await handler();

    expect(mockSend).toHaveBeenCalledTimes(4); // 1 list + 2 gets + 1 delete

    // Verify ListSchedules was called
    const listCommand = mockSend.mock.calls[0][0];
    expect(listCommand).toBeInstanceOf(ListSchedulesCommand);
    expect(listCommand.input.GroupName).toBe("isb-lease-costs");

    // Verify GetSchedule was called for both schedules
    const getCommand1 = mockSend.mock.calls[1][0];
    expect(getCommand1).toBeInstanceOf(GetScheduleCommand);
    expect(getCommand1.input.Name).toBe("lease-costs-old");

    const getCommand2 = mockSend.mock.calls[2][0];
    expect(getCommand2).toBeInstanceOf(GetScheduleCommand);
    expect(getCommand2.input.Name).toBe("lease-costs-recent");

    // Verify only stale schedule was deleted
    const deleteCommand = mockSend.mock.calls[3][0];
    expect(deleteCommand).toBeInstanceOf(DeleteScheduleCommand);
    expect(deleteCommand.input.Name).toBe("lease-costs-old");
    expect(deleteCommand.input.GroupName).toBe("isb-lease-costs");
  });

  it("should handle multiple stale schedules", async () => {
    const staleSchedules = [
      createSchedule("lease-costs-1", -100),
      createSchedule("lease-costs-2", -80),
      createSchedule("lease-costs-3", -75),
    ];

    mockSend
      .mockResolvedValueOnce({
        // ListSchedules
        Schedules: staleSchedules,
      })
      .mockResolvedValueOnce({
        // GetSchedule for schedule 1
        ScheduleExpression: createScheduleExpression(-100),
      })
      .mockResolvedValueOnce({
        // GetSchedule for schedule 2
        ScheduleExpression: createScheduleExpression(-80),
      })
      .mockResolvedValueOnce({
        // GetSchedule for schedule 3
        ScheduleExpression: createScheduleExpression(-75),
      })
      .mockResolvedValue({}); // DeleteSchedule calls

    await handler();

    expect(mockSend).toHaveBeenCalledTimes(7); // 1 list + 3 gets + 3 deletes

    // Verify GetSchedule was called for each
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetScheduleCommand);
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(GetScheduleCommand);
    expect(mockSend.mock.calls[3][0]).toBeInstanceOf(GetScheduleCommand);

    // Verify all three were deleted
    const deleteCommands = mockSend.mock.calls.slice(4);
    expect(deleteCommands[0][0].input.Name).toBe("lease-costs-1");
    expect(deleteCommands[1][0].input.Name).toBe("lease-costs-2");
    expect(deleteCommands[2][0].input.Name).toBe("lease-costs-3");
  });

  it("should not delete schedules within 72 hour threshold", async () => {
    const recentSchedules = [
      createSchedule("lease-costs-1", -71), // 71 hours ago
      createSchedule("lease-costs-2", -50), // 50 hours ago
      createSchedule("lease-costs-3", -24), // 24 hours ago
      createSchedule("lease-costs-4", 24), // 24 hours in future
    ];

    mockSend
      .mockResolvedValueOnce({
        Schedules: recentSchedules,
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-71),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-50),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-24),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(24),
      });

    await handler();

    // 1 list + 4 gets, no deletes
    expect(mockSend).toHaveBeenCalledTimes(5);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListSchedulesCommand);
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetScheduleCommand);
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(GetScheduleCommand);
    expect(mockSend.mock.calls[3][0]).toBeInstanceOf(GetScheduleCommand);
    expect(mockSend.mock.calls[4][0]).toBeInstanceOf(GetScheduleCommand);
  });

  it("should handle empty schedule list", async () => {
    mockSend.mockResolvedValueOnce({
      Schedules: [],
    });

    await handler();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListSchedulesCommand);
  });

  it("should handle pagination when listing schedules", async () => {
    const batch1 = [
      createSchedule("lease-costs-1", -100),
      createSchedule("lease-costs-2", -80),
    ];
    const batch2 = [createSchedule("lease-costs-3", -75)];

    mockSend
      .mockResolvedValueOnce({
        // First page
        Schedules: batch1,
        NextToken: "token-123",
      })
      .mockResolvedValueOnce({
        // Second page
        Schedules: batch2,
        NextToken: undefined,
      })
      .mockResolvedValueOnce({
        // GetSchedule for schedule 1
        ScheduleExpression: createScheduleExpression(-100),
      })
      .mockResolvedValueOnce({
        // GetSchedule for schedule 2
        ScheduleExpression: createScheduleExpression(-80),
      })
      .mockResolvedValueOnce({
        // GetSchedule for schedule 3
        ScheduleExpression: createScheduleExpression(-75),
      })
      .mockResolvedValue({}); // DeleteSchedule calls

    await handler();

    // Verify pagination
    expect(mockSend).toHaveBeenCalledTimes(8); // 2 list + 3 gets + 3 deletes
    expect(mockSend.mock.calls[0][0].input.NextToken).toBeUndefined();
    expect(mockSend.mock.calls[1][0].input.NextToken).toBe("token-123");
  });

  it("should handle ResourceNotFoundException gracefully (concurrent deletion during GetSchedule)", async () => {
    const staleSchedule = createSchedule("lease-costs-old", -100);

    const notFoundError = new Error("Schedule not found") as any;
    notFoundError.name = "ResourceNotFoundException";
    Object.setPrototypeOf(notFoundError, ResourceNotFoundException.prototype);

    mockSend
      .mockResolvedValueOnce({
        Schedules: [staleSchedule],
      })
      .mockRejectedValueOnce(notFoundError); // GetSchedule fails (concurrent deletion)

    // Should complete successfully
    await expect(handler()).resolves.toBeUndefined();

    // Should only call list and get (no delete since get failed)
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("should handle ResourceNotFoundException gracefully (concurrent deletion during DeleteSchedule)", async () => {
    const staleSchedule = createSchedule("lease-costs-old", -100);

    const notFoundError = new Error("Schedule not found") as any;
    notFoundError.name = "ResourceNotFoundException";
    Object.setPrototypeOf(notFoundError, ResourceNotFoundException.prototype);

    mockSend
      .mockResolvedValueOnce({
        Schedules: [staleSchedule],
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-100),
      })
      .mockRejectedValueOnce(notFoundError); // DeleteSchedule fails

    // Should complete successfully
    await expect(handler()).resolves.toBeUndefined();
  });

  it("should handle deletion errors gracefully without failing", async () => {
    const staleSchedules = [
      createSchedule("lease-costs-1", -100),
      createSchedule("lease-costs-2", -80),
    ];

    mockSend
      .mockResolvedValueOnce({
        Schedules: staleSchedules,
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-100),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-80),
      })
      .mockRejectedValueOnce(new Error("Internal service error")) // First delete fails
      .mockResolvedValueOnce({}); // Second delete succeeds

    // Should complete despite first deletion failing
    await expect(handler()).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(5); // 1 list + 2 gets + 2 delete attempts
  });

  it("should skip schedules with missing expressions", async () => {
    const schedules: ScheduleSummary[] = [
      {
        Name: "schedule-no-expression",
        State: "ENABLED",
      },
      createSchedule("lease-costs-valid", -100),
    ];

    mockSend
      .mockResolvedValueOnce({
        Schedules: schedules,
      })
      .mockResolvedValueOnce({
        // GetSchedule returns no expression
        Name: "schedule-no-expression",
      })
      .mockResolvedValueOnce({
        // GetSchedule for valid schedule
        ScheduleExpression: createScheduleExpression(-100),
      })
      .mockResolvedValue({});

    await handler();

    // Should call list, 2 gets, 1 delete
    expect(mockSend).toHaveBeenCalledTimes(4);
    const deleteCommand = mockSend.mock.calls[3][0];
    expect(deleteCommand.input.Name).toBe("lease-costs-valid");
  });

  it("should skip schedules with unparseable expressions", async () => {
    const schedules: ScheduleSummary[] = [
      {
        Name: "schedule-invalid-expression",
        State: "ENABLED",
      },
      createSchedule("lease-costs-valid", -100),
    ];

    mockSend
      .mockResolvedValueOnce({
        Schedules: schedules,
      })
      .mockResolvedValueOnce({
        // GetSchedule returns cron expression (unparseable)
        ScheduleExpression: "cron(0 12 * * ? *)",
      })
      .mockResolvedValueOnce({
        // GetSchedule for valid schedule
        ScheduleExpression: createScheduleExpression(-100),
      })
      .mockResolvedValue({});

    await handler();

    // Should only delete the valid schedule
    expect(mockSend).toHaveBeenCalledTimes(4); // 1 list + 2 gets + 1 delete
    const deleteCommand = mockSend.mock.calls[3][0];
    expect(deleteCommand.input.Name).toBe("lease-costs-valid");
  });

  it("should not delete future schedules even if created long ago", async () => {
    const futureSchedule = createSchedule("lease-costs-future", 48); // 48 hours in future

    mockSend
      .mockResolvedValueOnce({
        Schedules: [futureSchedule],
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(48),
      });

    await handler();

    // Should call list and get, but not delete
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("should handle boundary case at exactly 72 hours (should delete)", async () => {
    const boundarySchedule = createSchedule("lease-costs-boundary", -72);

    mockSend
      .mockResolvedValueOnce({
        Schedules: [boundarySchedule],
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-72),
      })
      .mockResolvedValue({});

    await handler();

    // Should delete schedules at exactly 72 hours (> 72 threshold)
    expect(mockSend).toHaveBeenCalledTimes(3); // 1 list + 1 get + 1 delete
    const deleteCommand = mockSend.mock.calls[2][0];
    expect(deleteCommand.input.Name).toBe("lease-costs-boundary");
  });

  it("should handle mixed stale and recent schedules correctly", async () => {
    const schedules = [
      createSchedule("stale-1", -100),
      createSchedule("recent-1", -50),
      createSchedule("stale-2", -80),
      createSchedule("future-1", 10),
      createSchedule("stale-3", -73),
    ];

    mockSend
      .mockResolvedValueOnce({
        Schedules: schedules,
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-100),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-50),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-80),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(10),
      })
      .mockResolvedValueOnce({
        ScheduleExpression: createScheduleExpression(-73),
      })
      .mockResolvedValue({});

    await handler();

    // Should call: 1 list + 5 gets + 3 deletes
    expect(mockSend).toHaveBeenCalledTimes(9);

    const deletedNames = mockSend.mock.calls
      .slice(6) // Skip list + 5 gets
      .map((call) => call[0].input.Name);
    expect(deletedNames).toEqual(["stale-1", "stale-2", "stale-3"]);
  });

  it("should throw when SCHEDULER_GROUP is missing", async () => {
    vi.resetModules();
    vi.stubEnv("SCHEDULER_GROUP", "");

    await expect(import("./cleanup-handler.js")).rejects.toThrow(
      "Cleanup Lambda requires SCHEDULER_GROUP to identify and delete stale EventBridge schedules"
    );
  });

  it("should set MaxResults to 100 when listing schedules", async () => {
    mockSend.mockResolvedValueOnce({
      Schedules: [],
    });

    await handler();

    const listCommand = mockSend.mock.calls[0][0];
    expect(listCommand.input.MaxResults).toBe(100);
  });
});
