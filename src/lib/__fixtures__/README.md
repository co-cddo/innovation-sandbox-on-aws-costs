# Test Fixtures for AWS SDK Integration Tests

This directory contains recorded AWS API responses for integration testing.

## Purpose

These fixtures capture real AWS SDK pagination behavior to:
- Test pagination logic with actual API response structures
- Verify Cost Explorer API response handling without AWS credentials
- Ensure tests work reliably in CI/CD environments
- Catch breaking changes in AWS SDK response formats

## Recording Fixtures

To record new fixtures (requires AWS credentials):

```bash
# Set environment variable to enable recording
RECORD_FIXTURES=true npm test -- cost-explorer.integration.test.ts

# Or use your AWS profile
AWS_PROFILE=my-profile RECORD_FIXTURES=true npm test -- cost-explorer.integration.test.ts
```

## Fixture Files

- `cost-explorer-pagination-*.json` - Recorded Cost Explorer API responses showing pagination

## Security

These fixtures contain sanitized test data:
- Account IDs are replaced with test account: `123456789012`
- Service names and costs are realistic but not production data
- No sensitive information is included

## Maintenance

Fixtures should be re-recorded when:
- AWS SDK version is upgraded
- Cost Explorer API changes
- New pagination edge cases need testing
