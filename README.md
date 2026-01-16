# Innovation Sandbox on AWS - Cost Reporter

A TypeScript CLI tool that generates billing reports from AWS Cost Explorer for accounts in the Innovation Sandbox.

## Overview

This tool queries AWS Cost Explorer to retrieve cost data for a specific AWS account, filtered by credits and bundled discounts, and outputs a markdown-formatted report to stdout.

## Prerequisites

- Node.js 22+
- AWS CLI configured with SSO profile `NDX/orgManagement`
- Access to AWS Cost Explorer API

## Installation

```bash
npm install
```

## Usage

First, ensure you're logged into AWS SSO:

```bash
aws sso login --profile NDX/orgManagement
```

Then run the cost report:

```bash
npm start -- --accountId <12-digit-account-id> --startTime YYYY-MM-DD --endTime YYYY-MM-DD
```

### Arguments

| Argument | Description | Format |
|----------|-------------|--------|
| `--accountId` | AWS Account ID to query | 12 digits |
| `--startTime` | Start date (inclusive) | YYYY-MM-DD |
| `--endTime` | End date (exclusive) | YYYY-MM-DD |

### Example

```bash
npm start -- --accountId 404584456509 --startTime 2026-01-01 --endTime 2026-01-02
```

### Output

The tool outputs a markdown report to stdout:

```markdown
# Cost report
accountid 404584456509

## Total cost for period: $6.30

Cost by service breakdown:
| Service | Cost |
|---------|------|
| Amazon Bedrock | $3.61 |
| Amazon Relational Database Service | $2.10 |
| Amazon Elastic Container Service | $0.37 |
| AWS Data Transfer | $0.20 |
| AWS Secrets Manager | $0.01 |
```

## How It Works

- Queries AWS Cost Explorer API using the `GetCostAndUsage` command
- Filters by linked account ID and charge types (Credit, BundledDiscount)
- Groups costs by SERVICE dimension
- Converts negative credit values to positive using `Math.abs()`
- Aggregates costs across the date range
- Sorts services by cost (highest first)

## Development

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Run compiled version
node dist/index.js --accountId <id> --startTime <date> --endTime <date>
```

## License

MIT
