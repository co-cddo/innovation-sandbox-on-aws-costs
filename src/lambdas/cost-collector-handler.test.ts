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
  CloudWatchClient: vi.fn(function() {
    return {
      send: vi.fn().mockResolvedValue({}),
    };
  }),
  PutMetricDataCommand: vi.fn(),
}));

// Mock only external dependencies and AWS services
vi.mock("@aws-sdk/client-scheduler", async () => {
  const actual = await vi.importActual("@aws-sdk/client-scheduler");
  return {
    ...actual,
    SchedulerClient: vi.fn(function() {}),
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
      function() {
        return {
          send: mockSchedulerSend,
        };
      }
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
      costsByResource: [
        { resourceName: "i-1234567890abcdef0", serviceName: "EC2", region: "us-east-1", cost: "100.00" },
        { resourceName: "my-bucket", serviceName: "S3", region: "us-west-2", cost: "50.50" },
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
    expect(actualCsv).toContain("Resource Name,Service,Region,Cost");
    expect(actualCsv).toContain("i-1234567890abcdef0,EC2,us-east-1,100.00");
    expect(actualCsv).toContain("my-bucket,S3,us-west-2,50.50");

    expect(mockGetPresignedUrl).toHaveBeenCalledWith(
      "test-bucket",
      "550e8400-e29b-41d4-a716-446655440000.csv",
      7
    );

    // Verify billing window calculated correctly using real calculateBillingWindow
    const getCostDataCall = mockGetCostData.mock.calls[0];
    const billingParams = getCostDataCall[0];
    expect(billingParams.startTime).toBe("2026-01-15");
    expect(billingParams.endTime).toBe("2026-02-03");

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
      costsByResource: [],
    });

    await handler(validPayload);

    // Verify actual CSV content for empty costs
    const uploadCsvCall = mockUploadCsv.mock.calls[0];
    const actualCsv = uploadCsvCall[2] as string;
    expect(actualCsv).toBe("Resource Name,Service,Region,Cost"); // Only header row

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

    await expect(handler(validPayload)).resolves.toBeUndefined();
    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalled();
  });

  it("should emit duplicate events on concurrent invocations (expected behavior - consumers must be idempotent)", async () => {
    const notFoundError = new Error("Schedule not found") as any;
    notFoundError.name = "ResourceNotFoundException";
    Object.setPrototypeOf(notFoundError, ResourceNotFoundException.prototype);
    mockSchedulerSend.mockRejectedValue(notFoundError);

    const results = await Promise.all([
      handler(validPayload),
      handler(validPayload),
    ]);

    expect(results).toEqual([undefined, undefined]);
    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalledTimes(2);
  });

  it("should handle other schedule delete errors gracefully (best-effort)", async () => {
    mockSchedulerSend.mockRejectedValue(new Error("Scheduler service error"));

    await expect(handler(validPayload)).resolves.toBeUndefined();
    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalled();
  });

  it("should throw on invalid payload (fails Zod validation)", async () => {
    const invalidPayload = {
      leaseId: "not-a-uuid",
      userEmail: "invalid-email",
      accountId: "12345",
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
      accountId: "12345",
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
    expect(mockUploadCsv).not.toHaveBeenCalled();
  });

  it("should propagate Cost Explorer timeout errors", async () => {
    const timeoutError = new Error("TimeoutError: Connection timed out");
    mockGetCostData.mockRejectedValue(timeoutError);

    await expect(handler(validPayload)).rejects.toThrow("TimeoutError");
    expect(mockEmitLeaseCostsGenerated).not.toHaveBeenCalled();
  });

  it("should handle Cost Explorer returning large datasets", async () => {
    const manyResources = Array.from({ length: 200 }, (_, i) => ({
      resourceName: `resource-${i}`,
      serviceName: `Service-${Math.floor(i / 10)}`,
      region: "us-east-1",
      cost: (Math.random() * 100).toFixed(10),
    }));
    const totalCost = manyResources.reduce((sum, r) => sum + parseFloat(r.cost), 0);

    mockGetCostData.mockResolvedValue({
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost,
      costsByResource: manyResources,
    });

    await handler(validPayload);

    // Verify actual CSV contains all 200 resources using real generateCsv
    const uploadCsvCall = mockUploadCsv.mock.calls[0];
    const actualCsv = uploadCsvCall[2] as string;
    const csvLines = actualCsv.split('\n');
    expect(csvLines.length).toBe(201); // Header + 200 resources
    expect(csvLines[0]).toBe("Resource Name,Service,Region,Cost");
    expect(csvLines[1]).toContain("resource-0,");
    expect(csvLines[200]).toContain("resource-199,");

    expect(mockEmitLeaseCostsGenerated).toHaveBeenCalledWith(
      "test-event-bus",
      expect.objectContaining({
        totalCost,
      })
    );
  });

  it("should properly escape CSV special characters in resource names", async () => {
    mockGetCostData.mockResolvedValue({
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 200.25,
      costsByResource: [
        { resourceName: 'resource, with comma', serviceName: 'Service1', region: 'us-east-1', cost: '100.00' },
        { resourceName: 'resource "with quotes"', serviceName: 'Service2', region: 'us-west-2', cost: '50.15' },
        { resourceName: 'resource\nwith newline', serviceName: 'Service3', region: 'eu-west-1', cost: '30.10' },
        { resourceName: 'Normal Resource', serviceName: 'Service4', region: 'ap-southeast-1', cost: '20.00' },
      ],
    });

    await handler(validPayload);

    // Verify RFC 4180 CSV escaping using real generateCsv
    const uploadCsvCall = mockUploadCsv.mock.calls[0];
    const actualCsv = uploadCsvCall[2] as string;

    // Resource with comma should be quoted
    expect(actualCsv).toContain('"resource, with comma",Service1,us-east-1,100.00');
    // Resource with quotes should have doubled quotes and be quoted
    expect(actualCsv).toContain('"resource ""with quotes""",Service2,us-west-2,50.15');
    // Resource with newline should be quoted
    expect(actualCsv).toContain('"resource\nwith newline",Service3,eu-west-1,30.10');
    // Normal resource should not be quoted
    expect(actualCsv).toContain('Normal Resource,Service4,ap-southeast-1,20.00');
  });

  it("should emit ResourceCount metric instead of ServiceCount", async () => {
    const { PutMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");

    await handler(validPayload);

    // Verify ResourceCount metric is emitted
    expect(PutMetricDataCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        MetricData: expect.arrayContaining([
          expect.objectContaining({
            MetricName: "ResourceCount",
            Value: 2, // Two resources in mock data
          }),
        ]),
      })
    );
  });

  describe("Environment variable validation", () => {
    it("should reject invalid EVENT_BUS_NAME with special characters", async () => {
      vi.resetModules();
      vi.stubEnv(
        "COST_EXPLORER_ROLE_ARN",
        "arn:aws:iam::999999999999:role/CostExplorerRole"
      );
      vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
      vi.stubEnv("EVENT_BUS_NAME", "invalid@bus#name");
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
      vi.stubEnv("EVENT_BUS_NAME", "a".repeat(257));
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
      vi.stubEnv("EVENT_BUS_NAME", "my-event.bus_name123");
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

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
      vi.stubEnv("EVENT_BUS_NAME", "a".repeat(256));
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

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
      vi.stubEnv("EVENT_BUS_NAME", "");
      vi.stubEnv("BILLING_PADDING_HOURS", "8");
      vi.stubEnv("PRESIGNED_URL_EXPIRY_DAYS", "7");
      vi.stubEnv("SCHEDULER_GROUP", "isb-lease-costs");
      vi.stubEnv(
        "ISB_LEASES_LAMBDA_ARN",
        "arn:aws:lambda:us-west-2:123456789012:function:isb-leases"
      );

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
        info: vi.fn() as any,
        warn: vi.fn() as any,
        error: vi.fn() as any,
      };
      createLoggerMock.mockReturnValue(mockLogger as any);
    });

    it("should create logger with context fields", async () => {
      const { handler } = await import("./cost-collector-handler.js");
      const logger = await import("../lib/logger.js");

      await handler(validPayload);

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

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting cost collection",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
        })
      );
    });

    it("should log lease details with duration", async () => {
      await handler(validPayload);

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

    it("should log Cost Explorer query results with resource count", async () => {
      await handler(validPayload);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Completed Cost Explorer query",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
          totalCost: expect.any(Number),
          currency: "USD",
          resourceCount: expect.any(Number),
        })
      );
    });

    it("should log S3 upload with integrity verification details", async () => {
      await handler(validPayload);

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

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Emitted LeaseCostsGenerated event",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
        })
      );
    });

    it("should log completion with total elapsed time", async () => {
      await handler(validPayload);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Cost collection completed",
        expect.objectContaining({
          elapsedSeconds: expect.any(Number),
        })
      );
    });

    it("should log all major operations in sequence", async () => {
      await handler(validPayload);

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

      const elapsedTimes = mockLogger.info.mock.calls
        .filter((call) => call[1]?.elapsedSeconds !== undefined)
        .map((call) => call[1].elapsedSeconds as number);

      for (let i = 1; i < elapsedTimes.length; i++) {
        expect(elapsedTimes[i]).toBeGreaterThanOrEqual(elapsedTimes[i - 1]);
      }
    });

    it("should log schedule deletion (or auto-deletion confirmation)", async () => {
      await handler(validPayload);

      const scheduleLog = mockLogger.info.mock.calls.find(
        (call) =>
          call[0] === "Deleted schedule" ||
          call[0] === "Schedule already deleted (auto-deleted after execution)"
      );
      expect(scheduleLog).toBeDefined();
    });

    it("should log CloudWatch metrics with resourceCount", async () => {
      await handler(validPayload);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Emitted CloudWatch business metrics",
        expect.objectContaining({
          totalCost: expect.any(Number),
          resourceCount: expect.any(Number),
          processingDuration: expect.any(Number),
        })
      );
    });
  });
});
