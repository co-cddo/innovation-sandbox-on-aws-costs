/**
 * Test Data Factories
 * ====================
 * Reusable builders for test data to reduce duplication and improve maintainability.
 *
 * Usage Patterns
 * --------------
 * 1. Use defaults for simple tests:
 *    ```typescript
 *    const event = buildLeaseTerminatedEvent();
 *    ```
 *
 * 2. Override specific fields:
 *    ```typescript
 *    const event = buildLeaseTerminatedEvent({
 *      detail: { accountId: "999999999999" }
 *    });
 *    ```
 *
 * 3. Build related data:
 *    ```typescript
 *    const leaseId = "550e8400-e29b-41d4-a716-446655440000";
 *    const event = buildLeaseTerminatedEvent({ detail: { leaseId: { uuid: leaseId } } });
 *    const payload = buildSchedulerPayload({ leaseId });
 *    ```
 *
 * 4. Create multiple variations:
 *    ```typescript
 *    const accounts = ["111111111111", "222222222222", "333333333333"];
 *    const events = accounts.map(accountId =>
 *      buildLeaseTerminatedEvent({ detail: { accountId } })
 *    );
 *    ```
 *
 * Design Principles
 * -----------------
 * - All defaults are VALID data that passes schema validation
 * - Deterministic values for reproducible tests (no random data)
 * - Deep merge support for nested overrides
 * - TypeScript type safety with proper type inference
 * - Self-documenting with realistic example data
 */

import type { EventBridgeEvent } from "aws-lambda";
import type {
  LeaseTerminatedEvent,
  SchedulerPayload,
  LeaseCostsGeneratedDetail,
  LeaseDetails,
} from "../src/lib/schemas.js";

/**
 * Deep merge utility for nested object overrides.
 * Recursively merges source into target, preserving nested structures.
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object"
    ) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }
  return result;
}

/**
 * Builds a LeaseTerminated EventBridge event.
 *
 * Default: Valid event with terminated lease in account 123456789012
 *
 * @example
 * // Use defaults
 * const event = buildLeaseTerminatedEvent();
 *
 * @example
 * // Override nested fields
 * const event = buildLeaseTerminatedEvent({
 *   detail: {
 *     accountId: "999999999999",
 *     leaseId: { uuid: "custom-uuid-here" }
 *   }
 * });
 */
export function buildLeaseTerminatedEvent(
  overrides: Partial<LeaseTerminatedEvent> = {}
): EventBridgeEvent<"LeaseTerminated", LeaseTerminatedEvent["detail"]> {
  const defaults: EventBridgeEvent<
    "LeaseTerminated",
    LeaseTerminatedEvent["detail"]
  > = {
    version: "0",
    id: "12345678-1234-1234-1234-123456789012",
    "detail-type": "LeaseTerminated",
    source: "isb",
    account: "123456789012",
    time: "2026-02-03T12:00:00Z",
    region: "us-west-2",
    resources: [],
    detail: {
      leaseId: {
        userEmail: "user@example.com",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
      },
      accountId: "123456789012",
      reason: {
        type: "Expired",
      },
    },
  };

  return deepMerge(defaults, overrides);
}

/**
 * Builds a SchedulerPayload for Cost Collector Lambda invocation.
 *
 * Default: Valid payload for collecting costs after lease termination
 *
 * @example
 * // Use defaults
 * const payload = buildSchedulerPayload();
 *
 * @example
 * // Override specific fields
 * const payload = buildSchedulerPayload({
 *   leaseId: "custom-uuid",
 *   accountId: "999999999999"
 * });
 *
 * @example
 * // Build matching event and payload
 * const leaseId = "550e8400-e29b-41d4-a716-446655440000";
 * const event = buildLeaseTerminatedEvent({ detail: { leaseId: { uuid: leaseId } } });
 * const payload = buildSchedulerPayload({ leaseId });
 */
export function buildSchedulerPayload(
  overrides: Partial<SchedulerPayload> = {}
): SchedulerPayload {
  const defaults: SchedulerPayload = {
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    userEmail: "user@example.com",
    accountId: "123456789012",
    leaseEndTimestamp: "2026-02-03T12:00:00.000Z",
    scheduleName: "lease-costs-550e8400-e29b-41d4-a716-446655440000",
  };

  return { ...defaults, ...overrides };
}

/**
 * Builds a LeaseCostsGenerated event detail.
 *
 * Default: Valid event detail with $150 total cost and 7-day presigned URL expiry
 *
 * @example
 * // Use defaults
 * const detail = buildLeaseCostsGeneratedDetail();
 *
 * @example
 * // Override total cost
 * const detail = buildLeaseCostsGeneratedDetail({ totalCost: 250.50 });
 *
 * @example
 * // Build with custom dates
 * const detail = buildLeaseCostsGeneratedDetail({
 *   startDate: "2026-01-01",
 *   endDate: "2026-01-31"
 * });
 */
export function buildLeaseCostsGeneratedDetail(
  overrides: Partial<LeaseCostsGeneratedDetail> = {}
): LeaseCostsGeneratedDetail {
  const defaults: LeaseCostsGeneratedDetail = {
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    userEmail: "user@example.com",
    accountId: "123456789012",
    totalCost: 150.0,
    currency: "USD",
    startDate: "2026-01-15",
    endDate: "2026-02-03",
    csvUrl:
      "https://isb-lease-costs.s3.amazonaws.com/550e8400-e29b-41d4-a716-446655440000.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256",
    urlExpiresAt: "2026-02-10T12:00:00.000Z",
  };

  return { ...defaults, ...overrides };
}

/**
 * Builds a LeaseDetails response from ISB API.
 *
 * Default: Active lease that started Jan 15, expires Feb 15
 *
 * @example
 * // Use defaults
 * const details = buildLeaseDetails();
 *
 * @example
 * // Build expired lease
 * const details = buildLeaseDetails({
 *   status: "Terminated",
 *   expirationDate: "2026-01-01T00:00:00.000Z"
 * });
 *
 * @example
 * // ISB API may include extra fields (passthrough schema)
 * const details = buildLeaseDetails({
 *   region: "us-west-2",  // Extra field not in schema
 *   metadata: { foo: "bar" }  // Extra nested object
 * });
 */
export function buildLeaseDetails(
  overrides: Partial<LeaseDetails> = {}
): LeaseDetails {
  const defaults: LeaseDetails = {
    startDate: "2026-01-15T10:00:00.000Z",
    expirationDate: "2026-02-15T10:00:00.000Z",
    awsAccountId: "123456789012",
    status: "Active",
  };

  return { ...defaults, ...overrides };
}

/**
 * Builds AWS temporary credentials from STS AssumeRole.
 *
 * Default: Valid credentials with 1-hour expiry
 *
 * @example
 * // Use defaults
 * const creds = buildCredentials();
 *
 * @example
 * // Build expired credentials
 * const creds = buildCredentials({
 *   expiration: new Date(Date.now() - 60000) // Expired 1 minute ago
 * });
 */
export function buildCredentials(
  overrides: Partial<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: Date;
  }> = {}
): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
} {
  const defaults = {
    accessKeyId: "ASIATESTACCESSKEY123",
    secretAccessKey: "TestSecretAccessKeyABCDEFGHIJKLMNOPQRSTUVWXYZ",
    sessionToken:
      "TestSessionTokenVeryLongStringWithLotsOfCharactersToSimulateRealSTSToken123456789012345678901234567890",
    expiration: new Date(Date.now() + 3600000), // 1 hour from now
  };

  return { ...defaults, ...overrides };
}

/**
 * Builds a Cost Explorer GetCostAndUsage response (single page).
 *
 * Default: 3 services (EC2, S3, Lambda) with $150 total cost
 *
 * @example
 * // Use defaults
 * const response = buildCostExplorerResponse();
 *
 * @example
 * // Build with custom services
 * const response = buildCostExplorerResponse({
 *   ResultsByTime: [{
 *     Groups: [
 *       { Keys: ["Amazon RDS"], Metrics: { UnblendedCost: { Amount: "200.00" } } }
 *     ]
 *   }]
 * });
 *
 * @example
 * // Build paginated response
 * const page1 = buildCostExplorerResponse({ NextPageToken: "token-123" });
 * const page2 = buildCostExplorerResponse({ NextPageToken: undefined });
 */
export function buildCostExplorerResponse(
  overrides: Partial<{
    ResultsByTime: Array<{
      Groups?: Array<{
        Keys?: string[];
        Metrics?: { UnblendedCost?: { Amount?: string } };
      }>;
    }>;
    NextPageToken?: string;
  }> = {}
): {
  ResultsByTime: Array<{
    Groups?: Array<{
      Keys?: string[];
      Metrics?: { UnblendedCost?: { Amount?: string } };
    }>;
  }>;
  NextPageToken?: string;
} {
  const defaults = {
    ResultsByTime: [
      {
        Groups: [
          {
            Keys: ["Amazon EC2"],
            Metrics: { UnblendedCost: { Amount: "100.00" } },
          },
          {
            Keys: ["Amazon S3"],
            Metrics: { UnblendedCost: { Amount: "30.00" } },
          },
          {
            Keys: ["AWS Lambda"],
            Metrics: { UnblendedCost: { Amount: "20.00" } },
          },
        ],
      },
    ],
    NextPageToken: undefined,
  };

  return deepMerge(defaults, overrides);
}

/**
 * Builds a CostReport (internal cost aggregation format).
 *
 * Default: 3 services with $150 total cost
 *
 * @example
 * // Use defaults
 * const report = buildCostReport();
 *
 * @example
 * // Build zero-cost report
 * const report = buildCostReport({
 *   totalCost: 0,
 *   costsByService: []
 * });
 *
 * @example
 * // Build large account report (200+ services)
 * const services = Array.from({ length: 200 }, (_, i) => ({
 *   serviceName: `Service-${i}`,
 *   cost: 1.0
 * }));
 * const report = buildCostReport({
 *   totalCost: 200,
 *   costsByService: services
 * });
 */
export function buildCostReport(
  overrides: Partial<{
    totalCost: number;
    costsByService: Array<{ serviceName: string; cost: number }>;
  }> = {}
): {
  totalCost: number;
  costsByService: Array<{ serviceName: string; cost: number }>;
} {
  const defaults = {
    totalCost: 150.0,
    costsByService: [
      { serviceName: "Amazon EC2", cost: 100.0 },
      { serviceName: "Amazon S3", cost: 30.0 },
      { serviceName: "AWS Lambda", cost: 20.0 },
    ],
  };

  return deepMerge(defaults, overrides);
}

/**
 * Builds a Lambda InvokeCommand response from ISB API.
 *
 * Default: Successful 200 response with lease details
 *
 * @example
 * // Use defaults
 * const response = buildLambdaInvokeResponse();
 *
 * @example
 * // Build error response
 * const response = buildLambdaInvokeResponse({
 *   statusCode: 404,
 *   body: JSON.stringify({ error: "Lease not found" })
 * });
 *
 * @example
 * // Build response with custom lease
 * const response = buildLambdaInvokeResponse({
 *   body: JSON.stringify(buildLeaseDetails({ status: "Terminated" }))
 * });
 */
export function buildLambdaInvokeResponse(
  overrides: Partial<{
    statusCode: number;
    body: string;
  }> = {}
): {
  Payload: Uint8Array;
} {
  const responseBody = {
    statusCode: 200,
    body: JSON.stringify(buildLeaseDetails()),
    ...overrides,
  };

  return {
    Payload: Buffer.from(JSON.stringify(responseBody)),
  };
}

/**
 * Builds an S3 PutObject response.
 *
 * Default: Successful upload with ETag and checksum
 *
 * @example
 * // Use defaults
 * const response = buildS3PutResponse();
 *
 * @example
 * // Build with custom ETag
 * const response = buildS3PutResponse({
 *   ETag: '"custom-etag-value"'
 * });
 */
export function buildS3PutResponse(
  overrides: Partial<{
    ETag?: string;
    ChecksumSHA256?: string;
  }> = {}
): {
  ETag?: string;
  ChecksumSHA256?: string;
} {
  const defaults = {
    ETag: '"abc123def456"',
    ChecksumSHA256: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  };

  return { ...defaults, ...overrides };
}

/**
 * Builds an EventBridge PutEvents response.
 *
 * Default: Successful event publish (no failed entries)
 *
 * @example
 * // Use defaults
 * const response = buildEventBridgePutResponse();
 *
 * @example
 * // Build failed response
 * const response = buildEventBridgePutResponse({
 *   FailedEntryCount: 1,
 *   Entries: [{
 *     ErrorCode: "InternalFailure",
 *     ErrorMessage: "Event bus throttled"
 *   }]
 * });
 */
export function buildEventBridgePutResponse(
  overrides: Partial<{
    FailedEntryCount?: number;
    Entries?: Array<{ ErrorCode?: string; ErrorMessage?: string }>;
  }> = {}
): {
  FailedEntryCount: number;
  Entries: Array<{ ErrorCode?: string; ErrorMessage?: string }>;
} {
  const defaults = {
    FailedEntryCount: 0,
    Entries: [],
  };

  return { ...defaults, ...overrides };
}

/**
 * Builds a Scheduler CreateSchedule response.
 *
 * Default: Successful schedule creation
 *
 * @example
 * // Use defaults
 * const response = buildSchedulerCreateResponse();
 *
 * @example
 * // Build with custom ARN
 * const response = buildSchedulerCreateResponse({
 *   ScheduleArn: "arn:aws:scheduler:us-west-2:123456789012:schedule/custom-group/custom-name"
 * });
 */
export function buildSchedulerCreateResponse(
  overrides: Partial<{
    ScheduleArn: string;
  }> = {}
): {
  ScheduleArn: string;
} {
  const defaults = {
    ScheduleArn:
      "arn:aws:scheduler:us-west-2:123456789012:schedule/isb-lease-costs/lease-costs-550e8400-e29b-41d4-a716-446655440000",
  };

  return { ...defaults, ...overrides };
}

/**
 * Builder for multiple related test objects (e.g., event → payload → details).
 * Ensures consistency across related test data.
 *
 * @example
 * // Build complete lease lifecycle data
 * const { event, payload, details, report, eventDetail } = buildLeaseLifecycle({
 *   leaseId: "550e8400-e29b-41d4-a716-446655440000",
 *   accountId: "123456789012",
 *   userEmail: "user@example.com",
 *   totalCost: 250.50
 * });
 *
 * @example
 * // Use in tests
 * await schedulerHandler(lifecycle.event);
 * await costCollectorHandler(lifecycle.payload);
 * expect(emittedEvent.detail).toEqual(lifecycle.eventDetail);
 */
export function buildLeaseLifecycle(
  options: {
    leaseId?: string;
    accountId?: string;
    userEmail?: string;
    leaseStartDate?: string;
    leaseEndDate?: string;
    totalCost?: number;
  } = {}
): {
  event: EventBridgeEvent<"LeaseTerminated", LeaseTerminatedEvent["detail"]>;
  payload: SchedulerPayload;
  details: LeaseDetails;
  report: ReturnType<typeof buildCostReport>;
  eventDetail: LeaseCostsGeneratedDetail;
} {
  const leaseId = options.leaseId || "550e8400-e29b-41d4-a716-446655440000";
  const accountId = options.accountId || "123456789012";
  const userEmail = options.userEmail || "user@example.com";
  const leaseStartDate =
    options.leaseStartDate || "2026-01-15T10:00:00.000Z";
  const leaseEndDate = options.leaseEndDate || "2026-02-03T12:00:00.000Z";
  const totalCost = options.totalCost || 150.0;

  return {
    event: buildLeaseTerminatedEvent({
      detail: {
        leaseId: { uuid: leaseId, userEmail },
        accountId,
      },
    }),
    payload: buildSchedulerPayload({
      leaseId,
      userEmail,
      accountId,
      leaseEndTimestamp: leaseEndDate,
      scheduleName: `lease-costs-${leaseId}`,
    }),
    details: buildLeaseDetails({
      startDate: leaseStartDate,
      awsAccountId: accountId,
    }),
    report: buildCostReport({
      totalCost,
    }),
    eventDetail: buildLeaseCostsGeneratedDetail({
      leaseId,
      userEmail,
      accountId,
      totalCost,
      startDate: leaseStartDate.split("T")[0],
      endDate: leaseEndDate.split("T")[0],
    }),
  };
}
