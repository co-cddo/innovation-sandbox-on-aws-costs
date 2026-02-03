import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SchedulerClient,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-scheduler";

// Mock AWS X-Ray SDK
vi.mock("aws-xray-sdk-core", () => ({
  setContextMissingStrategy: vi.fn(),
  getSegment: vi.fn().mockReturnValue({
    addNewSubsegment: vi.fn().mockReturnValue({
      addAnnotation: vi.fn(),
      addMetadata: vi.fn(),
      close: vi.fn(),
    }),
  }),
}));

// Mock CloudWatch client
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  PutMetricDataCommand: vi.fn(),
}));

// Mock only external dependencies and AWS services
vi.mock("@aws-sdk/client-scheduler", async () => {
  const actual = await vi.importActual("@aws-sdk/client-scheduler");
  return {
    ...actual,
    SchedulerClient: vi.fn(),
  };
});

vi.mock("../lib/isb-api-client.js", () => ({
  encodeLeaseId: vi.fn().mockReturnValue("encoded-lease-id"),
  getLeaseDetails: vi.fn(),
}));

vi.mock("../lib/assume-role.js", () => ({
  assumeCostExplorerRole: vi.fn(),
}));

vi.mock("../lib/cost-explorer.js", () => ({
  getCostData: vi.fn(),
}));

vi.mock("../lib/s3-uploader.js", () => ({
  uploadCsv: vi.fn(),
  getPresignedUrl: vi.fn(),
}));

vi.mock("../lib/event-emitter.js", () => ({
  emitLeaseCostsGenerated: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Use real implementations for pure functions
import { calculateBillingWindow } from "../lib/date-utils.js";
import { generateCsv } from "../lib/csv-generator.js";

describe("cost-collector-handler", () => {
  let mockSchedulerSend: ReturnType<typeof vi.fn>;
  let handler: (event: unknown) => Promise<void>;
  let mockGetLeaseDetails: ReturnType<typeof vi.fn>;
  let mockAssumeCostExplorerRole: ReturnType<typeof vi.fn>;
  let mockGetCostData: ReturnType<typeof vi.fn>;
  let mockUploadCsv: ReturnType<typeof vi.fn>;
  let mockGetPresignedUrl: ReturnType<typeof vi.fn>;
  let mockEmitLeaseCostsGenerated: ReturnType<typeof vi.fn>;

  const validPayload = {
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    userEmail: "user@example.com",
    accountId: "123456789012",
    leaseEndTimestamp: "2026-02-02T15:00:00.000Z",
    scheduleName: "lease-costs-550e8400-e29b-41d4-a716-446655440000",
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSchedulerSend = vi.fn().mockResolvedValue({});
    (SchedulerClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({
        send: mockSchedulerSend,
      })
    );

    // Set environment variables
    vi.stubEnv(
      "COST_EXPLORER_ROLE_ARN",
      "arn:aws:iam::999999999999:role/CostExplorerRole"
    );
    vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
    vi.stubEnv("BILLING_PADDING_HOURS", "8");
    vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
    vi.stubEnv("EVENT_BUS_NAME", "test-event-bus");
    vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
    vi.stubEnv(
      "ISB_LEASES_LAMBDA_ARN",
      "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
    );

    // Import mocks
    const isbClient = await import("../lib/isb-api-client.js");
    mockGetLeaseDetails = vi.mocked(isbClient.getLeaseDetails);
    mockGetLeaseDetails.mockResolvedValue({
      startDate: "2026-01-15T10:00:00.000Z",
      expirationDate: "2026-02-15T10:00:00.000Z",
      awsAccountId: "123456789012",
      status: "Terminated",
    });

    const assumeRole = await import("../lib/assume-role.js");
    mockAssumeCostExplorerRole = vi.mocked(assumeRole.assumeCostExplorerRole);
    mockAssumeCostExplorerRole.mockResolvedValue({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
    });

    const costExplorer = await import("../lib/cost-explorer.js");
    mockGetCostData = vi.mocked(costExplorer.getCostData);
    mockGetCostData.mockResolvedValue({
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 150.5,
      costsByService: [
        { serviceName: "EC2", cost: 100.0 },
        { serviceName: "S3", cost: 50.5 },
      ],
    });

    const s3Uploader = await import("../lib/s3-uploader.js");
    mockUploadCsv = vi.mocked(s3Uploader.uploadCsv);
    mockUploadCsv.mockResolvedValue({
      eTag: '"test-etag-abc123"',
      checksum: "test-checksum-sha256-base64",
    });
    mockGetPresignedUrl = vi.mocked(s3Uploader.getPresignedUrl);
    mockGetPresignedUrl.mockResolvedValue({
      url: "https://test-bucket.s3.amazonaws.com/lease.csv?signature=abc",
      expiresAt: new Date("2026-02-10T12:00:00.000Z"),
    });

    const eventEmitter = await import("../lib/event-emitter.js");
    mockEmitLeaseCostsGenerated = vi.mocked(
      eventEmitter.emitLeaseCostsGenerated
    );
    mockEmitLeaseCostsGenerated.mockResolvedValue(undefined);

    const module = await import("./cost-collector-handler.js");
    handler = module.handler;
  });

  it("should complete happy path: ISB API → Cost Explorer → S3 → Event → Delete Schedule", async () => {
    await handler(validPayload);

    expect(mockGetLeaseDetails).toHaveBeenCalledWith(
      "encoded-lease-id",
      "user@example.com",
      "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
    );
    expect(mockAssumeCostExplorerRole).toHaveBeenCalledWith(
      "arn:aws:iam::999999999999:role/CostExplorerRole"
    );
    expect(mockGetCostData).toHaveBeenCalled();

    // Verify actual CSV content using real generateCsv implementation
    const uploadCsvCall = mockUploadCsv.mock.calls[0];
    expect(uploadCsvCall[0]).toBe("test-bucket");
    expect(uploadCsvCall[1]).toBe("550e8400-e29b-41d4-a716-446655440000.csv");

    const actualCsv = uploadCsvCall[2] as string;
    expect(actualCsv).toContain("Service,Cost");
    expect(actualCsv).toContain("EC2,100.00");
    expect(actualCsv).toContain("S3,50.50");

    expect(mockGetPresignedUrl).toHaveBeenCalledWith(
      "test-bucket",
      "550e8400-e29b-41d4-a716-446655440000.csv",
      7
    );

    // Verify billing window calculated correctly using real calculateBillingWindow
    const getCostDataCall = mockGetCostData.mock.calls[0];
    const billingParams = getCostDataCall[0];
    expect(billingParams.startTime).toBe("2026-01-15"); // Lease start 2026-01-15T10:00:00Z with 8h padding rounds to 2026-01-15
    expect(billingParams.endTime).toBe("2026-02-03"); // Event time 2026-02-02T15:00:00Z with 8h padding rounds to 2026-02-03

    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalledWith(
      "test-event-bus",
      expect.objectContaining({
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        accountId: "123456789012",
        totalCost: 150.5,
        currency: "USD",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
      })
    );
    expect(mockSchedulerSend).toHaveBeenCalledTimes(1);
  });

  it("should emit event with totalCost: 0 for empty costs", async () => {
    mockGetCostData.mockResolvedValue({
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 0,
      costsByService: [],
    });

    await handler(validPayload);

    // Verify actual CSV content for empty costs
    const uploadCsvCall = mockUploadCsv.mock.calls[0];
    const actualCsv = uploadCsvCall[2] as string;
    expect(actualCsv).toBe("Service,Cost"); // Only header row

    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalledWith(
      "test-event-bus",
      expect.objectContaining({
        totalCost: 0,
      })
    );
  });

  it("should throw on ISB API failure (no partial state)", async () => {
    mockGetLeaseDetails.mockReset();
    mockGetLeaseDetails.mockRejectedValue(new Error("Lease not found"));
    mockAssumeCostExplorerRole.mockClear();

    await expect(handler(validPayload)).rejects.toThrow("Lease not found");
    expect(mockAssumeCostExplorerRole).not.toHaveBeenCalled();
  });

  it("should throw on assume role failure", async () => {
    mockAssumeCostExplorerRole.mockReset();
    mockAssumeCostExplorerRole.mockRejectedValue(new Error("AccessDenied"));
    mockGetCostData.mockClear();

    await expect(handler(validPayload)).rejects.toThrow("AccessDenied");
    expect(mockGetCostData).not.toHaveBeenCalled();
  });

  it("should throw on S3 upload failure (no event emitted)", async () => {
    mockUploadCsv.mockReset();
    mockUploadCsv.mockRejectedValue(new Error("S3 upload failed"));
    mockEmitLeaseCostsGenerated.mockClear();

    await expect(handler(validPayload)).rejects.toThrow("S3 upload failed");
    expect(mockEmitLeaseCostsGenerated).not.toHaveBeenCalled();
  });

  it("should handle schedule delete ResourceNotFoundException gracefully (expected due to auto-delete)", async () => {
    const notFoundError = new Error("Schedule not found") as any;
    notFoundError.name = "ResourceNotFoundException";
    Object.setPrototypeOf(notFoundError, ResourceNotFoundException.prototype);
    mockSchedulerSend.mockRejectedValue(notFoundError);

    // Should complete successfully - ResourceNotFoundException is expected when schedule auto-deleted
    await expect(handler(validPayload)).resolves.toBeUndefined();
    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalled();
  });

  /**
   * DUPLICATE EVENTS ARE EXPECTED BEHAVIOR
   * =======================================
   *
   * This test demonstrates that duplicate LeaseCostsGenerated events are expected and intentional.
   * Consumers MUST be idempotent to handle duplicates correctly.
   *
   * WHY DUPLICATES OCCUR:
   *
   * 1. EventBridge At-Least-Once Delivery Guarantee
   *    - EventBridge guarantees at-least-once delivery, not exactly-once
   *    - The same event may be delivered to consumers multiple times
   *    - This is standard EventBridge behavior, not a bug in our system
   *
   * 2. Concurrent Lambda Invocations
   *    - EventBridge Scheduler may trigger multiple Lambda invocations for the same schedule
   *    - Both invocations process the same lease and emit separate events
   *    - Race conditions between concurrent invocations are unavoidable
   *
   * 3. Retry Behavior
   *    - If a Lambda invocation fails after emitting the event but before completion,
   *      the retry will emit another event for the same lease
   *
   * CONSUMER REQUIREMENTS:
   *
   * All consumers of LeaseCostsGenerated events MUST implement idempotent processing:
   *
   * - Use the `leaseId` field to deduplicate events
   * - Check if costs for this leaseId have already been processed
   * - Use database constraints (e.g., unique constraint on leaseId) to prevent duplicates
   * - Or use DynamoDB conditional writes to ensure exactly-once processing
   *
   * Example idempotent consumer pattern:
   *
   * ```typescript
   * async function handleLeaseCostsGenerated(event: LeaseCostsGeneratedDetail) {
   *   // Check if already processed (idempotency)
   *   const existing = await db.query("SELECT 1 FROM processed_leases WHERE lease_id = ?", [event.leaseId]);
   *   if (existing.length > 0) {
   *     console.log(`Lease ${event.leaseId} already processed, skipping duplicate event`);
   *     return; // Idempotent: safe to process duplicate
   *   }
   *
   *   // Process the event
   *   await processLeaseCosts(event);
   *
   *   // Mark as processed
   *   await db.execute("INSERT INTO processed_leases (lease_id, ...) VALUES (?, ...)", [event.leaseId, ...]);
   * }
   * ```
   */
  it("should emit duplicate events on concurrent invocations (expected behavior - consumers must be idempotent)", async () => {
    // Simulates race condition: EventBridge Scheduler triggers multiple Lambda invocations
    // Both invocations process the same lease and emit separate LeaseCostsGenerated events
    const notFoundError = new Error("Schedule not found") as any;
    notFoundError.name = "ResourceNotFoundException";
    Object.setPrototypeOf(notFoundError, ResourceNotFoundException.prototype);
    mockSchedulerSend.mockRejectedValue(notFoundError);

    // Both invocations should complete successfully
    const results = await Promise.all([
      handler(validPayload),
      handler(validPayload),
    ]);

    expect(results).toEqual([undefined, undefined]);

    // CRITICAL: Event emitted twice - this is EXPECTED BEHAVIOR
    // Consumers MUST handle duplicate events using the leaseId field for deduplication
    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalledTimes(2);
  });

  it("should handle other schedule delete errors gracefully (best-effort)", async () => {
    mockSchedulerSend.mockRejectedValue(new Error("Scheduler service error"));

    // Should complete successfully (cleanup is best-effort)
    await expect(handler(validPayload)).resolves.toBeUndefined();
    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalled();
  });

  it("should throw on invalid payload (fails Zod validation)", async () => {
    const invalidPayload = {
      leaseId: "not-a-uuid",
      userEmail: "invalid-email",
      accountId: "12345", // Not 12 digits
      leaseEndTimestamp: "invalid-date",
      scheduleName: "test",
    };

    await expect(handler(invalidPayload)).rejects.toThrow(
      "Invalid scheduler payload"
    );
  });

  it("should throw on missing required fields", async () => {
    const incompletePayload = {
      leaseId: "550e8400-e29b-41d4-a716-446655440000",
      // Missing other fields
    };

    await expect(handler(incompletePayload)).rejects.toThrow(
      "Invalid scheduler payload"
    );
  });

  it("should include field name in error for invalid leaseId", async () => {
    const invalidPayload = {
      ...validPayload,
      leaseId: "not-a-uuid",
    };

    await expect(handler(invalidPayload)).rejects.toThrow(/leaseId/);
  });

  it("should include field name in error for invalid email", async () => {
    const invalidPayload = {
      ...validPayload,
      userEmail: "not-an-email",
    };

    await expect(handler(invalidPayload)).rejects.toThrow(/userEmail/);
  });

  it("should include field name in error for invalid accountId", async () => {
    const invalidPayload = {
      ...validPayload,
      accountId: "12345", // Not 12 digits
    };

    await expect(handler(invalidPayload)).rejects.toThrow(/accountId/);
  });

  it("should include field name in error for invalid timestamp", async () => {
    const invalidPayload = {
      ...validPayload,
      leaseEndTimestamp: "not-a-timestamp",
    };

    await expect(handler(invalidPayload)).rejects.toThrow(/leaseEndTimestamp/);
  });

  it("should pass credentials to getCostData", async () => {
    await handler(validPayload);

    expect(mockGetCostData).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        credentials: {
          accessKeyId: "AKID",
          secretAccessKey: "SECRET",
          sessionToken: "TOKEN",
        },
      })
    );
  });

  it("should propagate Cost Explorer throttling errors", async () => {
    const throttleError = new Error("ThrottlingException");
    throttleError.name = "ThrottlingException";
    mockGetCostData.mockRejectedValue(throttleError);

    await expect(handler(validPayload)).rejects.toThrow("ThrottlingException");
    // S3 upload should not be attempted after Cost Explorer failure
    expect(mockUploadCsv).not.toHaveBeenCalled();
  });

  it("should propagate Cost Explorer timeout errors", async () => {
    const timeoutError = new Error("TimeoutError: Connection timed out");
    mockGetCostData.mockRejectedValue(timeoutError);

    await expect(handler(validPayload)).rejects.toThrow("TimeoutError");
    expect(mockEmitLeaseCostsGenerated).not.toHaveBeenCalled();
  });

  it("should handle Cost Explorer returning large datasets", async () => {
    // Simulate large dataset with many services
    const manyServices = Array.from({ length: 200 }, (_, i) => ({
      serviceName: `Service-${i}`,
      cost: Math.random() * 100,
    }));
    const totalCost = manyServices.reduce((sum, s) => sum + s.cost, 0);

    mockGetCostData.mockResolvedValue({
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost,
      costsByService: manyServices,
    });

    await handler(validPayload);

    // Verify actual CSV contains all 200 services using real generateCsv
    const uploadCsvCall = mockUploadCsv.mock.calls[0];
    const actualCsv = uploadCsvCall[2] as string;
    const csvLines = actualCsv.split('\n');
    expect(csvLines.length).toBe(201); // Header + 200 services
    expect(csvLines[0]).toBe("Service,Cost");
    expect(csvLines[1]).toContain("Service-0,");
    expect(csvLines[200]).toContain("Service-199,");

    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalledWith(
      "test-event-bus",
      expect.objectContaining({
        totalCost,
      })
    );
  });

  it("should properly escape CSV special characters in service names", async () => {
    mockGetCostData.mockResolvedValue({
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 200.25,
      costsByService: [
        { serviceName: 'Service, with comma', cost: 100.00 },
        { serviceName: 'Service "with quotes"', cost: 50.15 },
        { serviceName: 'Service\nwith newline', cost: 30.10 },
        { serviceName: 'Normal Service', cost: 20.00 },
      ],
    });

    await handler(validPayload);

    // Verify RFC 4180 CSV escaping using real generateCsv
    const uploadCsvCall = mockUploadCsv.mock.calls[0];
    const actualCsv = uploadCsvCall[2] as string;

    // Service with comma should be quoted
    expect(actualCsv).toContain('"Service, with comma",100.00');
    // Service with quotes should have doubled quotes and be quoted
    expect(actualCsv).toContain('"Service ""with quotes""",50.15');
    // Service with newline should be quoted
    expect(actualCsv).toContain('"Service\nwith newline",30.10');
    // Normal service should not be quoted
    expect(actualCsv).toContain('Normal Service,20.00');
  });

  describe("Environment variable validation", () => {
    it("should reject invalid EVENT_BUS_NAME with special characters", async () => {
      vi.resetModules();
      vi.stubEnv(
        "COST_EXPLORER_ROLE_ARN",
        "arn:aws:iam::999999999999:role/CostExplorerRole"
      );
      vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
      vi.stubEnv("EVENT_BUS_NAME", "invalid@bus#name"); // Invalid characters @ and #
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

      await expect(async () => {
        await import("./cost-collector-handler.js");
      }).rejects.toThrow(/Invalid EVENT_BUS_NAME format/);
    });

    it("should reject EVENT_BUS_NAME exceeding 256 characters", async () => {
      vi.resetModules();
      vi.stubEnv(
        "COST_EXPLORER_ROLE_ARN",
        "arn:aws:iam::999999999999:role/CostExplorerRole"
      );
      vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
      vi.stubEnv("EVENT_BUS_NAME", "a".repeat(257)); // 257 characters exceeds AWS limit
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

      await expect(async () => {
        await import("./cost-collector-handler.js");
      }).rejects.toThrow(/Invalid EVENT_BUS_NAME format/);
    });

    it("should accept valid EVENT_BUS_NAME with dots, hyphens, and underscores", async () => {
      vi.resetModules();
      vi.stubEnv(
        "COST_EXPLORER_ROLE_ARN",
        "arn:aws:iam::999999999999:role/CostExplorerRole"
      );
      vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
      vi.stubEnv("EVENT_BUS_NAME", "my-event.bus_name123"); // Valid characters
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

      // Should not throw
      const result = await import("./cost-collector-handler.js");
      expect(result).toBeDefined();
      expect(result.handler).toBeDefined();
    });

    it("should accept EVENT_BUS_NAME at 256 character limit", async () => {
      vi.resetModules();
      vi.stubEnv(
        "COST_EXPLORER_ROLE_ARN",
        "arn:aws:iam::999999999999:role/CostExplorerRole"
      );
      vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
      vi.stubEnv("EVENT_BUS_NAME", "a".repeat(256)); // Exactly 256 characters
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

      // Should not throw
      const result = await import("./cost-collector-handler.js");
      expect(result).toBeDefined();
      expect(result.handler).toBeDefined();
    });

    it("should reject empty EVENT_BUS_NAME", async () => {
      vi.resetModules();
      vi.stubEnv(
        "COST_EXPLORER_ROLE_ARN",
        "arn:aws:iam::999999999999:role/CostExplorerRole"
      );
      vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
      vi.stubEnv("EVENT_BUS_NAME", ""); // Empty string
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

      // requireEnv will catch this first
      await expect(async () => {
        await import("./cost-collector-handler.js");
      }).rejects.toThrow();
    });
  });

  describe("Logging and Observability", () => {
    let mockLogger: {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
      const logger = await import("../lib/logger.js");
      const createLoggerMock = vi.mocked(logger.createLogger);
      mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      createLoggerMock.mockReturnValue(mockLogger);
    });

    it("should create logger with context fields", async () => {
      const { handler } = await import("./cost-collector-handler.js");
      const logger = await import("../lib/logger.js");

      await handler(validPayload);

      // Verify logger was created with structured context
      expect(logger.createLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "CostCollectorLambda",
          leaseId: "550e8400-e29b-41d4-a716-446655440000",
          accountId: "123456789012",
        })
      );
    });

    it("should log start of cost collection", async () => {
      await handler(validPayload);

      // Verify initial log entry
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting cost collection",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
        })
      );
    });

    it("should log lease details with duration", async () => {
      await handler(validPayload);

      // Verify lease details are logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Lease details",
        expect.objectContaining({
          startDate: expect.any(String),
          endDate: expect.any(String),
          durationDays: expect.any(Number),
        })
      );
    });

    it("should log billing window with padding information", async () => {
      await handler(validPayload);

      // Verify billing window is logged with all context
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Calculated billing window",
        expect.objectContaining({
          billingStartDate: expect.any(String),
          billingEndDate: expect.any(String),
          paddingHours: expect.any(Number),
          leaseStartDate: expect.any(String),
          leaseEndDate: expect.any(String),
        })
      );
    });

    it("should log Cost Explorer query results with cost summary", async () => {
      await handler(validPayload);

      // Verify Cost Explorer results are logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Completed Cost Explorer query",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
          totalCost: expect.any(Number),
          currency: "USD",
          serviceCount: expect.any(Number),
        })
      );
    });

    it("should log S3 upload with integrity verification details", async () => {
      await handler(validPayload);

      // Verify S3 upload is logged with eTag and checksum
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Uploaded CSV to S3",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
          bucket: "test-bucket",
          key: "550e8400-e29b-41d4-a716-446655440000.csv",
          eTag: expect.any(String),
          checksum: expect.any(String),
        })
      );
    });

    it("should log event emission", async () => {
      await handler(validPayload);

      // Verify event emission is logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Emitted LeaseCostsGenerated event",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
        })
      );
    });

    it("should log completion with total elapsed time", async () => {
      await handler(validPayload);

      // Verify completion log
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Cost collection completed",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
        })
      );
    });

    it("should log all major operations in sequence", async () => {
      await handler(validPayload);

      // Verify all key operations are logged in order
      const logMessages = mockLogger.info.mock.calls.map((call) => call[0]);
      expect(logMessages).toEqual([
        "Starting cost collection",
        "Retrieved lease details from ISB API",
        "Lease details",
        "Assumed Cost Explorer role",
        "Calculated billing window",
        "Completed Cost Explorer query",
        "Uploaded CSV to S3",
        "Emitted LeaseCostsGenerated event",
        "Emitted CloudWatch business metrics",
        expect.stringMatching(/Deleted schedule|Schedule already deleted/),
        "Cost collection completed",
      ]);
    });

    it("should include elapsed time in progress logs", async () => {
      await handler(validPayload);

      // Verify that logs tracking operation completion include elapsedSeconds
      const logsWithElapsedTime = [
        "Starting cost collection",
        "Retrieved lease details from ISB API",
        "Assumed Cost Explorer role",
        "Completed Cost Explorer query",
        "Uploaded CSV to S3",
        "Emitted LeaseCostsGenerated event",
        "Cost collection completed",
      ];

      logsWithElapsedTime.forEach((logMessage) => {
        const logCall = mockLogger.info.mock.calls.find(
          (call) => call[0] === logMessage
        );
        expect(logCall).toBeDefined();
        expect(logCall![1]).toHaveProperty("elapsedSeconds");
        expect(typeof logCall![1].elapsedSeconds).toBe("number");
        expect(logCall![1].elapsedSeconds).toBeGreaterThanOrEqual(0);
      });
    });

    it("should track elapsed time progression across operations", async () => {
      await handler(validPayload);

      // Extract elapsed times from progress logs
      const elapsedTimes = mockLogger.info.mock.calls
        .filter((call) => call[1]?.elapsedSeconds !== undefined)
        .map((call) => call[1].elapsedSeconds as number);

      // Verify elapsed times are non-decreasing (time moves forward)
      for (let i = 1; i < elapsedTimes.length; i++) {
        expect(elapsedTimes[i]).toBeGreaterThanOrEqual(elapsedTimes[i - 1]);
      }
    });

    it("should log schedule deletion (or auto-deletion confirmation)", async () => {
      await handler(validPayload);

      // Verify schedule deletion is logged (could be deleted or already deleted)
      const scheduleLog = mockLogger.info.mock.calls.find(
        (call) =>
          call[0] === "Deleted schedule" ||
          call[0] === "Schedule already deleted (auto-deleted after execution)"
      );
      expect(scheduleLog).toBeDefined();
    });
  });
});
