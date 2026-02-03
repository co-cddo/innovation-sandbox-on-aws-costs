# Testing Patterns Guide

## Given-When-Then Pattern

The Given-When-Then (GWT) pattern structures tests to clearly express:
- **Given**: The initial context or preconditions
- **When**: The action being performed
- **Then**: The expected outcome

### Benefits

1. **Clarity**: Tests read like specifications
2. **Consistency**: Uniform structure across test suite
3. **Documentation**: Tests serve as living documentation
4. **Maintainability**: Easy to understand and modify

## Pattern Structure

```typescript
describe("given [context]", () => {
  describe("when [action]", () => {
    it("then [outcome]", () => {
      // Test implementation
    });
  });
});
```

## Examples

### Before: Flat Structure

```typescript
describe("requireEnv", () => {
  it("should return value when environment variable exists", () => {
    process.env.TEST_VAR = "test-value";
    expect(requireEnv("TEST_VAR")).toBe("test-value");
  });

  it("should throw when environment variable is not set", () => {
    delete process.env.MISSING_VAR;
    expect(() => requireEnv("MISSING_VAR")).toThrow(
      "MISSING_VAR environment variable is required"
    );
  });
});
```

### After: Given-When-Then Structure

```typescript
describe("requireEnv", () => {
  describe("given environment variable is set", () => {
    describe("when retrieving the variable", () => {
      it("then returns the value", () => {
        process.env.TEST_VAR = "test-value";
        expect(requireEnv("TEST_VAR")).toBe("test-value");
      });
    });
  });

  describe("given environment variable is not set", () => {
    describe("when retrieving the variable", () => {
      it("then throws an error with the variable name", () => {
        delete process.env.MISSING_VAR;
        expect(() => requireEnv("MISSING_VAR")).toThrow(
          "MISSING_VAR environment variable is required"
        );
      });
    });
  });

  describe("given environment variable is empty string", () => {
    describe("when retrieving the variable", () => {
      it("then throws an error requiring non-empty value", () => {
        process.env.EMPTY_VAR = "";
        expect(() => requireEnv("EMPTY_VAR")).toThrow(
          "EMPTY_VAR environment variable is required"
        );
      });
    });
  });
});
```

## Practical Examples from Our Codebase

### Example 1: Cost Explorer Tests

```typescript
describe("getCostData", () => {
  describe("given a single page response with multiple services", () => {
    describe("when fetching cost data", () => {
      it("then returns aggregated costs by service", async () => {
        mockSend.mockResolvedValue({
          ResultsByTime: [{
            Groups: [
              { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } },
              { Keys: ["Amazon S3"], Metrics: { UnblendedCost: { Amount: "50.00" } } },
            ],
          }],
        });

        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-15",
          endTime: "2026-02-03",
        });

        expect(result.totalCost).toBe(150);
        expect(result.costsByService).toHaveLength(2);
      });
    });
  });

  describe("given a paginated response with NextPageToken", () => {
    describe("when fetching all pages", () => {
      it("then aggregates costs from all pages correctly", async () => {
        mockSend
          .mockResolvedValueOnce({
            ResultsByTime: [{
              Groups: [{ Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "100.00" } } }],
            }],
            NextPageToken: "token-1",
          })
          .mockResolvedValueOnce({
            ResultsByTime: [{
              Groups: [{ Keys: ["Amazon S3"], Metrics: { UnblendedCost: { Amount: "50.00" } } }],
            }],
            NextPageToken: undefined,
          });

        const result = await getCostData({
          accountId: "123456789012",
          startTime: "2026-01-15",
          endTime: "2026-02-03",
        });

        expect(result.totalCost).toBe(150);
        expect(result.costsByService).toHaveLength(2);
        expect(mockSend).toHaveBeenCalledTimes(2);
      });
    });
  });
});
```

### Example 2: Scheduler Handler Tests

```typescript
describe("scheduler-handler", () => {
  describe("given a valid LeaseTerminated event", () => {
    describe("when creating a schedule", () => {
      it("then creates schedule with correct name format", async () => {
        mockSend.mockResolvedValue({});

        await handler(validEvent);

        const command = mockSend.mock.calls[0][0];
        expect(command.input.Name).toBe(
          "lease-costs-550e8400-e29b-41d4-a716-446655440000"
        );
      });

      it("then includes retry policy for resilience", async () => {
        mockSend.mockResolvedValue({});

        await handler(validEvent);

        const command = mockSend.mock.calls[0][0];
        expect(command.input.Target.RetryPolicy).toEqual({
          MaximumRetryAttempts: 3,
          MaximumEventAgeInSeconds: 3600,
        });
      });
    });
  });

  describe("given an invalid event with missing leaseId", () => {
    describe("when validating the event", () => {
      it("then throws validation error with schema details", async () => {
        const invalidEvent = { ...validEvent, detail: { accountId: "123456789012" } };

        await expect(handler(invalidEvent)).rejects.toThrow(
          "Invalid EventBridge event payload"
        );
      });
    });
  });
});
```

### Example 3: S3 Uploader Security Tests

```typescript
describe("validateKey", () => {
  describe("given a valid UUID.csv key", () => {
    describe("when validating the key", () => {
      it("then accepts the key without throwing", () => {
        expect(() =>
          validateKey("550e8400-e29b-41d4-a716-446655440000.csv")
        ).not.toThrow();
      });
    });
  });

  describe("given a key with path traversal attempt", () => {
    describe("when validating the key", () => {
      it("then throws security error for double dots", () => {
        expect(() => validateKey("../secret.csv")).toThrow(
          "Invalid S3 key format"
        );
      });

      it("then throws security error for forward slash", () => {
        expect(() => validateKey("folder/file.csv")).toThrow(
          "Invalid S3 key format"
        );
      });

      it("then throws security error for null bytes", () => {
        expect(() => validateKey("file\0.csv")).toThrow(
          "contains forbidden characters"
        );
      });
    });
  });

  describe("given a key without .csv extension", () => {
    describe("when validating the key", () => {
      it("then throws format error", () => {
        expect(() =>
          validateKey("550e8400-e29b-41d4-a716-446655440000.txt")
        ).toThrow("Expected format: {uuid}.csv");
      });
    });
  });
});
```

## Guidelines

### When to Use Given-When-Then

✅ **DO use for**:
- Integration tests with complex setup
- Tests with multiple scenarios
- Security-critical functionality
- Business logic with edge cases

❌ **DON'T use for**:
- Simple utility function tests (e.g., `formatDate`)
- Tests with single assertion
- Performance tests (use descriptive names instead)

### Balancing Verbosity

**Too Verbose** (avoid):
```typescript
describe("given the Cost Explorer client is initialized", () => {
  describe("and given valid credentials are provided", () => {
    describe("and given the account ID is 123456789012", () => {
      describe("when querying cost data for January 2026", () => {
        it("then returns cost report with services", () => {
          // Test implementation
        });
      });
    });
  });
});
```

**Just Right**:
```typescript
describe("given valid credentials and account ID", () => {
  describe("when querying January 2026 costs", () => {
    it("then returns cost report with services", () => {
      // Test implementation
    });
  });
});
```

### Combining Related Scenarios

Group related scenarios under shared "given" context:

```typescript
describe("given a lease with 200+ services", () => {
  describe("when generating CSV", () => {
    it("then completes within 5 seconds", () => { /* ... */ });
    it("then uses less than 400MB memory", () => { /* ... */ });
    it("then generates valid RFC 4180 CSV", () => { /* ... */ });
  });
});
```

## Migration Strategy

1. **New tests**: Use Given-When-Then from the start
2. **Existing tests**: Refactor when modifying tests
3. **Priority**: Security and business logic tests first
4. **Don't break**: Maintain test functionality during refactor

## Tools and Utilities

### Helper for Shared Setup

```typescript
// test/factories.ts already provides builders for common scenarios
import { buildLeaseLifecycle } from "../../test/factories.js";

describe("given a complete lease lifecycle", () => {
  const { event, payload, details, report } = buildLeaseLifecycle({
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    totalCost: 250.50
  });

  describe("when processing the lease", () => {
    it("then emits correct event details", () => {
      // Use pre-built test data
      expect(report.totalCost).toBe(250.50);
    });
  });
});
```

## References

- [Martin Fowler - Given When Then](https://martinfowler.com/bliki/GivenWhenThen.html)
- [Behavior-Driven Development (BDD)](https://cucumber.io/docs/bdd/)
- [Vitest Nested Describe Blocks](https://vitest.dev/api/#describe)

## Implementation Status

- ✅ Test factories available (`test/factories.ts`)
- ✅ Example patterns documented (this file)
- ⏳ Existing tests use hybrid approach (nested describes, but not strict GWT naming)
- 📝 Future: Gradually migrate existing tests during maintenance
