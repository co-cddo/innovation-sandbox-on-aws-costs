# Testing Strategy

This document describes the testing approach for the Innovation Sandbox on AWS Costs project.

## Test Structure

```
src/
├── lib/
│   ├── __fixtures__/              # Test fixtures (VCR pattern)
│   │   ├── README.md              # Fixture documentation
│   │   └── *.json                 # Recorded AWS API responses
│   ├── *.test.ts                  # Unit tests (mocked)
│   └── *.integration.test.ts      # Integration tests (real SDK)
```

## Test Types

### 1. Unit Tests (`*.test.ts`)

Fast, isolated tests using mocked AWS SDK clients.

**Characteristics:**
- Run in <1ms per test
- No AWS credentials required
- Full control over test scenarios
- High coverage of edge cases

**Example:** `/Users/cns/httpdocs/cddo/innovation-sandbox-on-aws-costs/src/lib/cost-explorer.test.ts`

```typescript
// Mock AWS SDK
vi.mock("@aws-sdk/client-cost-explorer", async () => {
  const actual = await vi.importActual("@aws-sdk/client-cost-explorer");
  return {
    ...actual,
    CostExplorerClient: vi.fn(),
  };
});

// Fast unit test with mocked responses
it("should handle pagination with NextPageToken", async () => {
  mockSend.mockResolvedValueOnce({ /* page 1 */ });
  mockSend.mockResolvedValueOnce({ /* page 2 */ });
  const result = await getCostData(...);
  expect(result.totalCost).toBe(150);
});
```

**Use for:**
- Business logic validation
- Edge case testing
- Error handling
- Algorithmic correctness
- Rate limiting logic
- Safety features

### 2. Integration Tests (`*.integration.test.ts`)

Tests using real AWS SDK responses via the VCR (Video Cassette Recorder) pattern.

**Characteristics:**
- Uses recorded AWS API responses
- Validates real SDK behavior
- Works without AWS credentials
- Safe to run in CI/CD

**Example:** `/Users/cns/httpdocs/cddo/innovation-sandbox-on-aws-costs/src/lib/cost-explorer.integration.test.ts`

```typescript
// Automatically skipped in CI (unless recording)
describe.skipIf(process.env.CI && !RECORD_FIXTURES)("Cost Explorer Integration", () => {
  it("should handle real AWS SDK pagination", async () => {
    // Uses fixtures from __fixtures__/ directory
    const result = await getCostData(...);
    expect(result.costsByService.length).toBeGreaterThan(0);
  });
});
```

**Use for:**
- AWS SDK contract validation
- Pagination behavior verification
- Response format validation
- Breaking change detection

### 3. CDK Infrastructure Tests (`infra/**/*.test.ts`)

Snapshot and assertion tests for CloudFormation templates.

**Example:** `/Users/cns/httpdocs/cddo/innovation-sandbox-on-aws-costs/infra/lib/cost-collection-stack.test.ts`

```typescript
it("should match snapshot", () => {
  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});
```

## VCR Pattern (Fixture Recording)

### What is the VCR Pattern?

The VCR pattern records real API responses once and replays them in tests:

1. **Record Mode**: Make real AWS API calls and save responses to fixtures
2. **Playback Mode**: Load fixtures and replay them without AWS credentials

### Recording Fixtures

To record new fixtures (requires AWS credentials):

```bash
# Option 1: Use default AWS credentials
RECORD_FIXTURES=true npm test -- cost-explorer.integration.test.ts

# Option 2: Use AWS profile
AWS_PROFILE=my-profile RECORD_FIXTURES=true npm test -- cost-explorer.integration.test.ts

# Option 3: Set AWS account ID
AWS_ACCOUNT_ID=123456789012 RECORD_FIXTURES=true npm test
```

### Playback Mode (Default)

Fixtures are automatically loaded and replayed:

```bash
# Run integration tests with fixtures (no AWS credentials needed)
npm test -- cost-explorer.integration.test.ts

# Works in CI/CD environments
CI=true npm test
```

### When to Record New Fixtures

Record new fixtures when:
- AWS SDK version is upgraded
- Cost Explorer API changes
- New pagination edge cases need testing
- API response format evolves

## CI/CD Integration

### Behavior in CI

```bash
# Integration tests are automatically skipped in CI
CI=true npm test
# Output: ↓ Cost Explorer Integration - Pagination (6 tests | 6 skipped)
```

### GitHub Actions

```yaml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm test  # Integration tests auto-skip
      - run: npm run test:ci  # With coverage
```

## Test Commands

```bash
# Run all tests
npm test

# Run with coverage
npm run test:ci

# Watch mode (development)
npm run test:watch

# Run specific test file
npm test -- cost-explorer.test.ts

# Run integration tests only
npm test -- cost-explorer.integration.test.ts

# Record fixtures (requires AWS credentials)
RECORD_FIXTURES=true npm test -- cost-explorer.integration.test.ts
```

## Test Coverage Goals

| Category | Target | Current |
|----------|--------|---------|
| Statements | >80% | ✅ |
| Branches | >75% | ✅ |
| Functions | >80% | ✅ |
| Lines | >80% | ✅ |

## Best Practices

### ✅ DO

- Use unit tests for business logic and edge cases
- Use integration tests for AWS SDK contract validation
- Keep tests fast (<100ms for unit tests)
- Use fixtures for integration tests
- Test error paths and edge cases
- Use descriptive test names

### ❌ DON'T

- Make real AWS API calls in unit tests
- Commit AWS credentials to fixtures
- Skip error handling tests
- Test implementation details
- Use brittle mocks (prefer fixtures)
- Test private functions directly

## Debugging Tests

### View Test Output

```bash
# Run with verbose output
npm test -- --reporter=verbose

# Run single test
npm test -- -t "should handle pagination"

# Debug test in watch mode
npm run test:watch
```

### Common Issues

**Issue:** Integration tests fail with "ENOENT: no such file or directory"

**Solution:** Check that fixtures exist in `src/lib/__fixtures__/`

---

**Issue:** Tests fail with "Access Denied" in CI

**Solution:** Integration tests should auto-skip in CI. Check `CI` environment variable.

---

**Issue:** Precision errors in cost calculations

**Solution:** Use `toBeCloseTo(value, 1)` with 1 decimal place precision.

## Testing AWS SDK Upgrades

When upgrading AWS SDK versions:

1. Run unit tests (should pass unchanged):
   ```bash
   npm test -- cost-explorer.test.ts
   ```

2. Re-record integration fixtures:
   ```bash
   RECORD_FIXTURES=true npm test -- cost-explorer.integration.test.ts
   ```

3. Review fixture diffs for breaking changes:
   ```bash
   git diff src/lib/__fixtures__/
   ```

4. Update integration tests if response format changed

5. Commit updated fixtures:
   ```bash
   git add src/lib/__fixtures__/
   git commit -m "chore: update fixtures for AWS SDK v3.x.x"
   ```

## Related Documentation

- [Vitest Configuration](../vitest.config.ts)
- [Fixture README](../src/lib/__fixtures__/README.md)
- [Cost Explorer Module](../src/lib/cost-explorer.ts)
