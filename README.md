# Innovation Sandbox on AWS - Lease Cost Collection

A TypeScript service that automatically collects billing data when Innovation Sandbox leases terminate, storing cost reports in S3 and emitting events for downstream consumers.

## Architecture

```
NDX/InnovationSandboxHub Account (us-west-2):
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ISB EventBus                                                   │
│       │                                                         │
│       │ LeaseTerminated event                                   │
│       ▼                                                         │
│  EventBridge Rule ──► Scheduler Lambda                          │
│                            │                                    │
│                            │ Creates one-shot schedule          │
│                            ▼                                    │
│                    EventBridge Scheduler ──(24hr delay)──►      │
│                                                                 │
│                    Cost Collector Lambda ◄─────────────────     │
│                            │                                    │
│                            │ 1. Get lease details from ISB API  │
│                            │ 2. Assume role in orgManagement    │
│                            │ 3. Query Cost Explorer             │
│                            │ 4. Generate CSV                    │
│                            │ 5. Upload to S3                    │
│                            │ 6. Generate presigned URL          │
│                            │ 7. Emit LeaseCostsGenerated event  │
│                            ▼                                    │
│                    S3 Bucket (isb-lease-costs-...)              │
│                    └─ ${leaseId}.csv                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

NDX/orgManagement Account (us-east-1):
┌─────────────────────────────────────────────────────────────────┐
│  isb-lease-costs-explorer-role                                  │
│  └─ ce:GetCostAndUsage (assumed by Cost Collector Lambda)       │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- Event-driven: Automatically triggers on `LeaseTerminated` events
- 24-hour delay: Waits for billing data to settle before collection
- Cross-account: Assumes role in org management for Cost Explorer access
- ISB API integration: Uses JWT authentication for Lambda-to-Lambda calls
- Presigned URLs: 7-day valid download links in output events
- 3-year retention: S3 lifecycle policy for compliance
- Observability: CloudWatch alarms, X-Ray tracing, DLQs

## Event Schemas

### Input: LeaseTerminated

```json
{
  "detail-type": "LeaseTerminated",
  "source": "isb",
  "detail": {
    "leaseId": {
      "userEmail": "user@example.com",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    },
    "accountId": "123456789012",
    "reason": {
      "type": "Expired"
    }
  }
}
```

### Output: LeaseCostsGenerated

```json
{
  "detail-type": "LeaseCostsGenerated",
  "source": "isb-costs",
  "detail": {
    "leaseId": "550e8400-e29b-41d4-a716-446655440000",
    "accountId": "123456789012",
    "totalCost": 150.50,
    "currency": "USD",
    "startDate": "2026-01-15",
    "endDate": "2026-02-03",
    "csvUrl": "https://bucket.s3.amazonaws.com/lease.csv?signature=...",
    "urlExpiresAt": "2026-02-10T12:00:00.000Z"
  }
}
```

## End-to-End Integration Examples

### Example 1: EventBridge Rule Consumer (Node.js Lambda)

This example shows how to subscribe to `LeaseCostsGenerated` events and download the CSV report.

#### 1. Create EventBridge Rule

```bash
aws events put-rule \
  --name ProcessLeaseCosts \
  --event-pattern '{
    "source": ["isb-costs"],
    "detail-type": ["LeaseCostsGenerated"]
  }' \
  --region us-west-2
```

#### 2. Lambda Handler

```typescript
import { EventBridgeHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse/sync';

interface LeaseCostsGeneratedDetail {
  leaseId: string;
  accountId: string;
  totalCost: number;
  currency: string;
  startDate: string;
  endDate: string;
  csvUrl: string;
  urlExpiresAt: string;
}

export const handler: EventBridgeHandler<
  'LeaseCostsGenerated',
  LeaseCostsGeneratedDetail,
  void
> = async (event) => {
  console.log('Received LeaseCostsGenerated event', {
    leaseId: event.detail.leaseId,
    accountId: event.detail.accountId,
    totalCost: event.detail.totalCost,
  });

  // 1. Fetch CSV from presigned URL
  const response = await fetch(event.detail.csvUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch CSV: ${response.statusText}`);
  }
  const csvContent = await response.text();

  // 2. Parse CSV
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  });

  console.log(`Parsed ${records.length} service costs`);

  // 3. Process costs (example: find top 5 services)
  const topServices = records
    .sort((a, b) => parseFloat(b.Cost) - parseFloat(a.Cost))
    .slice(0, 5);

  console.log('Top 5 services by cost:', topServices);

  // 4. Store in database, send notification, etc.
  await storeInDatabase(event.detail);
  await sendNotification(event.detail, topServices);
};

async function storeInDatabase(detail: LeaseCostsGeneratedDetail) {
  // Store in DynamoDB, RDS, etc.
  console.log('Storing lease cost in database:', detail.leaseId);
}

async function sendNotification(
  detail: LeaseCostsGeneratedDetail,
  topServices: any[]
) {
  // Send email, Slack message, etc.
  console.log('Sending cost notification for lease:', detail.leaseId);
}
```

#### 3. Deploy Lambda and Add Target

```bash
# Deploy Lambda (using AWS CDK, SAM, or Serverless Framework)
npm run deploy

# Add Lambda as EventBridge target
aws events put-targets \
  --rule ProcessLeaseCosts \
  --targets "Id=1,Arn=arn:aws:lambda:us-west-2:123456789012:function:ProcessLeaseCosts"
```

### Example 2: Local Testing (Manual Event Trigger)

Test your event consumer locally by manually sending a test event:

```bash
# Create test event file
cat > test-event.json <<'EOF'
{
  "version": "0",
  "id": "test-event-123",
  "detail-type": "LeaseCostsGenerated",
  "source": "isb-costs",
  "account": "123456789012",
  "time": "2026-02-03T12:00:00Z",
  "region": "us-west-2",
  "resources": [],
  "detail": {
    "leaseId": "550e8400-e29b-41d4-a716-446655440000",
    "accountId": "123456789012",
    "totalCost": 150.50,
    "currency": "USD",
    "startDate": "2026-01-15",
    "endDate": "2026-02-03",
    "csvUrl": "https://isb-lease-costs-bucket.s3.us-west-2.amazonaws.com/550e8400.csv?X-Amz-Signature=...",
    "urlExpiresAt": "2026-02-10T12:00:00.000Z"
  }
}
EOF

# Invoke Lambda locally
aws lambda invoke \
  --function-name ProcessLeaseCosts \
  --payload file://test-event.json \
  response.json

# View response
cat response.json
```

### Example 3: SNS Notification Consumer

Forward lease costs to SNS for email/SMS notifications:

```typescript
import { EventBridgeHandler } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const snsClient = new SNSClient({});
const TOPIC_ARN = process.env.TOPIC_ARN!;

export const handler: EventBridgeHandler<
  'LeaseCostsGenerated',
  any,
  void
> = async (event) => {
  const { leaseId, accountId, totalCost, startDate, endDate, csvUrl } = event.detail;

  const message = `
Lease Cost Report Generated

Lease ID: ${leaseId}
Account: ${accountId}
Total Cost: $${totalCost.toFixed(2)}
Billing Period: ${startDate} to ${endDate}

Download CSV: ${csvUrl}

Note: URL expires in 7 days.
  `.trim();

  await snsClient.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: `Lease Cost Report: ${leaseId}`,
      Message: message,
    })
  );

  console.log(`Sent SNS notification for lease ${leaseId}`);
};
```

### Example 4: S3 Event Bridge Rule (Archive CSV)

Archive CSV files to a long-term storage bucket:

```typescript
import { EventBridgeHandler } from 'aws-lambda';
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});
const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET!;

export const handler: EventBridgeHandler<
  'LeaseCostsGenerated',
  any,
  void
> = async (event) => {
  const { leaseId, accountId, startDate, csvUrl } = event.detail;

  // Extract bucket and key from presigned URL
  const url = new URL(csvUrl);
  const sourceBucket = url.hostname.split('.')[0];
  const sourceKey = url.pathname.substring(1); // Remove leading '/'

  // Copy to archive bucket with organized structure
  const archiveKey = `lease-costs/${startDate.slice(0, 7)}/${accountId}/${leaseId}.csv`;

  await s3Client.send(
    new CopyObjectCommand({
      CopySource: `${sourceBucket}/${sourceKey}`,
      Bucket: ARCHIVE_BUCKET,
      Key: archiveKey,
      StorageClass: 'GLACIER_IR', // Immediate retrieval glacier for cost savings
      TaggingDirective: 'REPLACE',
      Tagging: `leaseId=${leaseId}&accountId=${accountId}`,
    })
  );

  console.log(`Archived CSV to s3://${ARCHIVE_BUCKET}/${archiveKey}`);
};
```

### Example 5: Manual Invocation (Testing)

Manually invoke the scheduler Lambda to test the entire flow:

```bash
# Create test LeaseTerminated event
cat > lease-terminated.json <<'EOF'
{
  "detail-type": "LeaseTerminated",
  "source": "isb",
  "detail": {
    "leaseId": {
      "userEmail": "user@example.com",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    },
    "accountId": "123456789012",
    "reason": {
      "type": "Expired"
    }
  }
}
EOF

# Invoke scheduler Lambda
aws lambda invoke \
  --function-name isb-lease-costs-scheduler \
  --payload file://lease-terminated.json \
  response.json

# Wait for scheduled collection (24 hours by default)
# OR manually trigger collector Lambda:
cat > collector-event.json <<'EOF'
{
  "leaseId": "550e8400-e29b-41d4-a716-446655440000",
  "accountId": "123456789012",
  "userEmail": "user@example.com"
}
EOF

aws lambda invoke \
  --function-name isb-lease-costs-collector \
  --payload file://collector-event.json \
  response.json
```

### Common Patterns

#### Pattern 1: Idempotent Event Processing

Use lease ID as idempotency key to prevent duplicate processing:

```typescript
const processedLeases = new Set<string>();

export const handler: EventBridgeHandler<'LeaseCostsGenerated', any, void> = async (event) => {
  const { leaseId } = event.detail;

  // Check if already processed (use DynamoDB for persistence)
  if (processedLeases.has(leaseId)) {
    console.log(`Lease ${leaseId} already processed, skipping`);
    return;
  }

  // Process event...
  await processLeaseCosts(event.detail);

  // Mark as processed
  processedLeases.add(leaseId);
};
```

#### Pattern 2: Retry with Exponential Backoff

Handle transient failures when fetching CSV:

```typescript
async function fetchWithRetry(url: string, maxRetries = 3): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
      if (response.status >= 500) {
        // Retry server errors
        throw new Error(`Server error: ${response.status}`);
      }
      // Don't retry client errors
      throw new Error(`Client error: ${response.status}`);
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.log(`Retry ${attempt}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('All retries exhausted');
}
```

#### Pattern 3: DLQ Monitoring

Monitor DLQ for failed event processing:

```typescript
// Add CloudWatch alarm for DLQ
new cloudwatch.Alarm(this, 'ConsumerDlqAlarm', {
  metric: dlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
  alarmDescription: 'Alert when lease cost events fail to process',
  actionsEnabled: true,
});
```

## CDK Stacks

The infrastructure is split into two stacks for cross-account deployment:

### IsbCostExplorerRoleStack (orgManagement account, us-east-1)

Creates the IAM role that allows the hub account Lambda to query Cost Explorer.

### IsbCostCollectionStack (hub account, us-west-2)

Contains all the main infrastructure:
- EventBridge Rule (triggers on LeaseTerminated)
- Scheduler Lambda (creates delayed schedules)
- Cost Collector Lambda (collects costs and emits events)
- S3 Bucket (stores CSV reports)
- EventBridge Scheduler Group
- DLQs and CloudWatch Alarms

## Configuration

### Context Values (cdk.json)

| Context Key | Description | Required | When to Change | Impact of Change |
|-------------|-------------|----------|----------------|------------------|
| `hubAccountId` | AWS account ID for the hub account | Yes | When deploying to different AWS account | **High**: Wrong account = deployment failure |
| `orgMgmtAccountId` | AWS account ID for the org management account | Yes | When Cost Explorer role is in different account | **High**: Wrong account = AssumeRole failures |
| `eventBusName` | Name of the ISB EventBridge bus | Yes | When ISB event bus name changes or deploying to different environment | **High**: Wrong bus = no events received |
| `costExplorerRoleArn` | ARN of the Cost Explorer role in orgManagement | Yes | When role name changes or different management account | **High**: Wrong ARN = AssumeRole failures, no cost data |
| `isbLeasesLambdaArn` | ARN of the ISB Leases API Lambda | **Yes** | When ISB API Lambda is redeployed or moved to different region | **High**: Wrong ARN = lease lookup failures |
| `costCollectorLambdaRoleArn` | Exact ARN of Cost Collector Lambda execution role | **Yes (Phase 2)** | After Phase 1 deployment, retrieve from CDK outputs | **Critical**: Must not contain wildcards - secures cross-account trust |
| `alertEmail` | Email for operational alerts | No | Add or change email for CloudWatch alarm notifications | **Low**: No email = no operational alerts, but system still works |
| `schedulerGroupName` | Name for the EventBridge Scheduler group | No | For multi-environment deployments (dev/staging/prod) or custom naming | **Low**: Only affects schedule organization in console |

### Environment Variables (Lambda)

| Variable | Description | Range | Default | When to Change | Impact of Change |
|----------|-------------|-------|---------|----------------|------------------|
| `DELAY_HOURS` | Hours to wait before collecting costs | 0-720 | 24 | Increase for slower billing systems (AWS typically updates within 24h), decrease for faster testing | **Medium**: Too short = incomplete cost data, too long = delayed reporting |
| `BILLING_PADDING_HOURS` | Hours before/after lease period to include | 0-168 | 8 | Increase if costs appear before/after lease period, decrease for strict boundaries | **Medium**: Too short = missing edge costs, too long = includes unrelated costs |
| `PRESIGNED_URL_EXPIRY_DAYS` | Presigned URL validity | 1-7 | 7 | Decrease for tighter security (shorter URL lifetime), increase to 7 for maximum access window | **High**: Must be 1-7 or Lambda fails to start. Shorter = URLs expire faster, longer = URLs valid longer |

> **⚠️ AWS Limit Warning**: `PRESIGNED_URL_EXPIRY_DAYS` has an AWS-imposed maximum of 7 days. S3 presigned URLs created with IAM credentials (used by Lambda) cannot exceed 7 days. Values outside 1-7 will cause Lambda startup failures with `InvalidParameterException`.

## Deployment

### Prerequisites

- AWS CLI configured with profiles for both accounts:
  - `NDX/orgManagement` - For deploying the Cost Explorer role
  - `NDX/InnovationSandboxHub` - For deploying the main stack
- Node.js 22+
- ISB Leases Lambda ARN (required for deployment)

### ⚠️ CRITICAL: Cross-Account Deployment Order

Due to the least-privilege trust policy requirement, deployment must happen in **THREE PHASES**:

**Phase 1: Deploy Main Stack (Hub Account)**
1. Deploy `IsbCostCollectionStack` to hub account WITHOUT the Cost Explorer role stack
2. Note the `CostCollectorLambdaRoleArn` output - this is needed for the trust policy

**Phase 2: Deploy/Update Role Stack (orgManagement Account)**
1. Deploy or update `IsbCostExplorerRoleStack` using the Lambda role ARN from Phase 1
2. This creates a least-privilege trust policy that only allows the specific Lambda role

**Phase 3: Verify and Test**
1. Verify the trust policy uses exact ARN matching (no wildcards)
2. Test cost collection with a manual Lambda invocation

**Why this three-phase approach:**
- **Security**: The trust policy requires the exact Lambda execution role ARN, not a wildcard pattern
- **Cross-account limitation**: CDK cross-stack references don't work across accounts, so we must use context variables
- **Least-privilege principle**: Only the specific Lambda role can assume the Cost Explorer role, preventing privilege escalation

**What happens with the old wildcard pattern:**
- ⚠️ Security risk: Any Lambda with a name matching `IsbCostCollectionStack-CostCollectorLambda*` could assume the role
- ⚠️ Privilege escalation: Attacker could create a Lambda with a matching name to gain Cost Explorer access
- ✅ New approach: Only the exact Lambda role ARN can assume the Cost Explorer role

### Phase 1: Deploy Main Stack (Hub Account)

```bash
# Install dependencies
npm ci

cd infra

# Deploy main stack to hub account (us-west-2)
# You MUST provide the ISB Leases Lambda ARN
npx cdk deploy IsbCostCollectionStack \
  --profile NDX/InnovationSandboxHub \
  --context isbLeasesLambdaArn=arn:aws:lambda:us-west-2:568672915267:function:isb-leases

# CRITICAL: Note the CostCollectorLambdaRoleArn output - you MUST use this in Phase 2:
# IsbCostCollectionStack.CostCollectorLambdaRoleArn = arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole...
```

### Phase 2: Deploy/Update Cost Explorer Role (orgManagement Account)

```bash
# Deploy Cost Explorer role to orgManagement account (us-east-1)
# MUST provide the exact Lambda role ARN from Phase 1 output
npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --context costCollectorLambdaRoleArn=arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole...

# IMPORTANT: The role ARN must be exact - no wildcards allowed
# The trust policy will reject any ARN containing wildcards (*)
```

### Phase 3: Verification

```bash
# Verify the trust policy uses exact ARN (not wildcards)
aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals'

# Expected output should show exact Lambda role ARN:
# {
#   "aws:PrincipalArn": "arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole...",
#   "aws:SourceAccount": "568672915267"
# }

# Verify NO wildcards in the trust policy
aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement \
  --query 'Role.AssumeRolePolicyDocument' \
  | grep -q "*" && echo "⚠️  WARNING: Trust policy contains wildcards!" || echo "✅ Trust policy is secure (no wildcards)"
```

## Troubleshooting Deployment Issues

### Consequences of Wrong Deployment Order

If you deploy the stacks in the wrong order, you'll encounter different failures depending on the scenario:

#### Scenario 1: Deploy Role Stack BEFORE Main Stack (Without Lambda Role ARN)

**What happens:**
```bash
npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement
  # Missing --context costCollectorLambdaRoleArn=...
```

**Error message:**
```
IsbCostExplorerRoleStack: deploying...
❌ IsbCostExplorerRoleStack failed: Error:
CRITICAL: costCollectorLambdaRoleArn context value is required for cross-account trust policy.
This must be the EXACT IAM role ARN of the Cost Collector Lambda (not a wildcard pattern).
```

**Why it fails:**
- The role stack requires the exact Lambda role ARN for the trust policy
- Without it, the trust policy cannot be created with least-privilege access
- CDK validation catches this at synthesis time (before AWS API calls)

**How to detect:**
- Error occurs during `cdk synth` or `cdk deploy`
- Stack never reaches AWS (fails locally)
- No CloudFormation stack is created

#### Scenario 2: Main Stack Can't Assume Non-Existent Role

**What happens:**
```bash
# Phase 1: Deploy main stack successfully
npx cdk deploy IsbCostCollectionStack --profile NDX/InnovationSandboxHub

# Phase 2: Skip role stack deployment (forgot or failed)

# Phase 3: Test Lambda invocation
aws lambda invoke --function-name isb-lease-costs-collector ...
```

**Error message in Lambda logs:**
```json
{
  "errorType": "AccessDenied",
  "errorMessage": "User: arn:aws:sts::568672915267:assumed-role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole.../isb-lease-costs-collector is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::955063685555:role/isb-lease-costs-explorer-role",
  "code": "AccessDenied",
  "time": "2026-02-03T12:34:56.789Z",
  "requestId": "abc123",
  "statusCode": 403,
  "retryable": false
}
```

**Why it fails:**
- The Cost Explorer role doesn't exist in orgManagement account
- STS AssumeRole fails with `AccessDenied` (role not found)
- Lambda execution fails when trying to query Cost Explorer

**How to detect:**
```bash
# Check if role exists
aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement

# If role missing, you'll see:
# An error occurred (NoSuchEntity) when calling the GetRole operation:
# The role with name isb-lease-costs-explorer-role cannot be found.
```

**CloudWatch indicators:**
- Lambda function fails with `AccessDenied` errors
- CloudWatch alarm `CostCollectorLambdaErrors` triggers
- DLQ receives failed events
- No CSV files appear in S3 bucket

#### Scenario 3: Role Exists But Trust Policy Is Wrong

**What happens:**
```bash
# Phase 1: Deploy main stack
npx cdk deploy IsbCostCollectionStack --profile NDX/InnovationSandboxHub

# Phase 2: Deploy role stack with WRONG Lambda role ARN
npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --context costCollectorLambdaRoleArn=arn:aws:iam::568672915267:role/WRONG-ROLE-NAME
```

**Error message in Lambda logs:**
```json
{
  "errorType": "AccessDenied",
  "errorMessage": "User: arn:aws:sts::568672915267:assumed-role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole.../isb-lease-costs-collector is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::955063685555:role/isb-lease-costs-explorer-role because no identity-based policy allows the sts:AssumeRole action",
  "code": "AccessDenied",
  "statusCode": 403
}
```

**Why it fails:**
- Role exists but trust policy references a different Lambda role
- STS AssumeRole fails because principal doesn't match trust policy condition
- Lambda can't authenticate to assume the role

**How to detect:**
```bash
# Check trust policy
aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals'

# Compare with actual Lambda role
aws lambda get-function \
  --function-name isb-lease-costs-collector \
  --profile NDX/InnovationSandboxHub \
  --query 'Configuration.Role'

# If they don't match, trust policy is wrong
```

#### Scenario 4: Deploy with Wildcard Pattern (Security Risk)

**What happens:**
```bash
# Deploy role stack with wildcard pattern (OLD insecure approach)
npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --context costCollectorLambdaRoleArn="arn:aws:iam::568672915267:role/IsbCostCollectionStack-CostCollectorLambda*"
```

**Validation error:**
```
IsbCostExplorerRoleStack: deploying...
❌ IsbCostExplorerRoleStack failed: Error:
SECURITY ERROR: costCollectorLambdaRoleArn must be an exact role ARN (no wildcards).
Found wildcard pattern: arn:aws:iam::568672915267:role/IsbCostCollectionStack-CostCollectorLambda*

Why this matters:
- Wildcard patterns allow privilege escalation attacks
- Attacker could create Lambda with matching name to gain Cost Explorer access
- Trust policy must use exact ARN with StringEquals condition

Get the exact Lambda role ARN from:
  aws cloudformation describe-stacks \
    --stack-name IsbCostCollectionStack \
    --query 'Stacks[0].Outputs[?OutputKey==`CostCollectorLambdaRoleArn`].OutputValue' \
    --output text
```

**Why it's rejected:**
- CDK validation detects `*` character in role ARN
- Prevents security vulnerability from being deployed
- Forces use of exact ARN for least-privilege access

### Recovery Procedures

#### Recovery 1: Fix Missing Role Stack Deployment

**Problem**: Main stack deployed successfully, but role stack was never deployed or failed.

**Detection**:
```bash
# Lambda logs show AccessDenied for STS AssumeRole
# OR role doesn't exist
aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement
# Error: NoSuchEntity
```

**Recovery steps**:

1. **Get Lambda role ARN from main stack output**:
```bash
aws cloudformation describe-stacks \
  --stack-name IsbCostCollectionStack \
  --profile NDX/InnovationSandboxHub \
  --query 'Stacks[0].Outputs[?OutputKey==`CostCollectorLambdaRoleArn`].OutputValue' \
  --output text

# Copy the output, e.g.:
# arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole-abc123
```

2. **Deploy role stack with correct ARN**:
```bash
cd infra

npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --context costCollectorLambdaRoleArn=arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole-abc123
```

3. **Verify trust policy**:
```bash
aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals'

# Should show:
# {
#   "aws:PrincipalArn": "arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole-abc123",
#   "aws:SourceAccount": "568672915267"
# }
```

4. **Test Lambda invocation**:
```bash
# Create test payload
cat > test-payload.json << 'EOF'
{
  "leaseId": "test-recovery-123",
  "accountId": "123456789012",
  "startDate": "2026-01-01",
  "endDate": "2026-01-31",
  "userEmail": "test@example.com"
}
EOF

aws lambda invoke \
  --function-name isb-lease-costs-collector \
  --profile NDX/InnovationSandboxHub \
  --payload file://test-payload.json \
  response.json

# Check response
cat response.json

# Should succeed without AccessDenied errors
```

5. **Verify S3 file creation**:
```bash
aws s3 ls s3://isb-lease-costs-568672915267-us-west-2/ \
  --profile NDX/InnovationSandboxHub

# Should show: test-recovery-123.csv
```

#### Recovery 2: Fix Wrong Lambda Role ARN in Trust Policy

**Problem**: Role stack deployed with wrong Lambda role ARN (trust policy doesn't match actual Lambda role).

**Detection**:
```bash
# Compare trust policy with actual Lambda role
TRUST_POLICY_ARN=$(aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."aws:PrincipalArn"' \
  --output text)

ACTUAL_LAMBDA_ROLE=$(aws lambda get-function \
  --function-name isb-lease-costs-collector \
  --profile NDX/InnovationSandboxHub \
  --query 'Configuration.Role' \
  --output text)

echo "Trust policy expects: $TRUST_POLICY_ARN"
echo "Lambda role is:       $ACTUAL_LAMBDA_ROLE"

# If they don't match, trust policy is wrong
```

**Recovery steps**:

1. **Get correct Lambda role ARN**:
```bash
CORRECT_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name IsbCostCollectionStack \
  --profile NDX/InnovationSandboxHub \
  --query 'Stacks[0].Outputs[?OutputKey==`CostCollectorLambdaRoleArn`].OutputValue' \
  --output text)

echo "Correct Lambda role ARN: $CORRECT_ROLE_ARN"
```

2. **Update role stack with correct ARN**:
```bash
cd infra

npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --context costCollectorLambdaRoleArn=$CORRECT_ROLE_ARN
```

3. **Verify trust policy updated**:
```bash
aws iam get-role \
  --role-name isb-lease-costs-explorer-role \
  --profile NDX/orgManagement \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."aws:PrincipalArn"' \
  --output text

# Should match $CORRECT_ROLE_ARN
```

4. **Test Lambda invocation** (same as Recovery 1, step 4-5)

#### Recovery 3: Fix Lambda Role Changed After Role Stack Deployment

**Problem**: Main stack was redeployed and Lambda role ARN changed (CDK generated new role name), but role stack trust policy still references old ARN.

**Detection**:
```bash
# Lambda fails with AccessDenied after main stack update
# Check if Lambda role name changed
aws lambda get-function \
  --function-name isb-lease-costs-collector \
  --profile NDX/InnovationSandboxHub \
  --query 'Configuration.Role'

# Compare with trust policy (if different, role was recreated)
```

**Recovery steps**:

1. **Identify why Lambda role changed**:
```bash
# Common causes:
# - Changed stack name or logical ID
# - Changed Lambda function name
# - CDK resource recreation (rare)

# Get CloudFormation change history
aws cloudformation describe-stack-events \
  --stack-name IsbCostCollectionStack \
  --profile NDX/InnovationSandboxHub \
  --query 'StackEvents[?LogicalResourceId==`CostCollectorLambdaRole`]' \
  --max-items 10
```

2. **Get new Lambda role ARN**:
```bash
NEW_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name IsbCostCollectionStack \
  --profile NDX/InnovationSandboxHub \
  --query 'Stacks[0].Outputs[?OutputKey==`CostCollectorLambdaRoleArn`].OutputValue' \
  --output text)

echo "New Lambda role ARN: $NEW_ROLE_ARN"
```

3. **Update role stack trust policy**:
```bash
cd infra

npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --context costCollectorLambdaRoleArn=$NEW_ROLE_ARN
```

4. **Verify and test** (same as Recovery 1, steps 3-5)

**Prevention**:
- Avoid changing stack names or Lambda function names after initial deployment
- Use stack parameters instead of context values for stable resource names
- Document Lambda role ARN in deployment runbook for quick reference

### Post-Recovery Verification Checklist

After any recovery procedure, verify the following:

- [ ] **Trust policy is correct**:
  ```bash
  aws iam get-role \
    --role-name isb-lease-costs-explorer-role \
    --profile NDX/orgManagement \
    --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals'
  ```
  - Should show exact Lambda role ARN (no wildcards)
  - Should include `aws:PrincipalArn` and `aws:SourceAccount` conditions

- [ ] **Trust policy matches Lambda role**:
  ```bash
  # Get trust policy ARN
  TRUST_ARN=$(aws iam get-role \
    --role-name isb-lease-costs-explorer-role \
    --profile NDX/orgManagement \
    --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."aws:PrincipalArn"' \
    --output text)

  # Get Lambda role ARN
  LAMBDA_ARN=$(aws lambda get-function \
    --function-name isb-lease-costs-collector \
    --profile NDX/InnovationSandboxHub \
    --query 'Configuration.Role' \
    --output text)

  # Compare
  if [ "$TRUST_ARN" = "$LAMBDA_ARN" ]; then
    echo "✅ Trust policy matches Lambda role"
  else
    echo "❌ MISMATCH: Trust policy and Lambda role don't match"
    echo "   Trust policy: $TRUST_ARN"
    echo "   Lambda role:  $LAMBDA_ARN"
  fi
  ```

- [ ] **Lambda can assume Cost Explorer role**:
  ```bash
  # Test with manual Lambda invocation (see Recovery 1, step 4)
  # Should succeed without AccessDenied errors
  ```

- [ ] **S3 bucket is accessible**:
  ```bash
  aws s3 ls s3://isb-lease-costs-568672915267-us-west-2/ \
    --profile NDX/InnovationSandboxHub
  # Should list files (if any exist)
  ```

- [ ] **CloudWatch alarms are healthy**:
  ```bash
  aws cloudwatch describe-alarms \
    --alarm-name-prefix IsbCostCollectionStack \
    --profile NDX/InnovationSandboxHub \
    --query 'MetricAlarms[?StateValue==`ALARM`]'
  # Should return empty array
  ```

- [ ] **DLQ is empty**:
  ```bash
  aws sqs get-queue-attributes \
    --queue-url https://sqs.us-west-2.amazonaws.com/568672915267/IsbCostCollectionStack-SchedulerDLQ... \
    --attribute-names ApproximateNumberOfMessages \
    --profile NDX/InnovationSandboxHub
  # ApproximateNumberOfMessages should be 0
  ```

### Understanding CDK Cross-Stack Reference Limitations

#### Why We Can't Use CDK Cross-Stack References

CDK provides automatic cross-stack references for resources in the same account and region:

```typescript
// This works ONLY in same account/region
const roleStack = new IsbCostExplorerRoleStack(app, 'RoleStack', {
  env: { account: '123456789012', region: 'us-east-1' }
});

const mainStack = new IsbCostCollectionStack(app, 'MainStack', {
  env: { account: '123456789012', region: 'us-east-1' },
  costExplorerRole: roleStack.role  // ✅ Works - same account
});
```

**How it works (same account)**:
- CDK generates CloudFormation exports in role stack (`Export: RoleArn`)
- Main stack imports via `Fn::ImportValue`
- CloudFormation manages the dependency automatically

**Why it fails (cross-account)**:
```typescript
// This DOES NOT work across accounts
const roleStack = new IsbCostExplorerRoleStack(app, 'RoleStack', {
  env: { account: '955063685555', region: 'us-east-1' }  // orgManagement
});

const mainStack = new IsbCostCollectionStack(app, 'MainStack', {
  env: { account: '568672915267', region: 'us-west-2' },  // hub
  costExplorerRole: roleStack.role  // ❌ Error: Cannot reference cross-account resources
});
```

**CloudFormation limitation**:
- `Fn::ImportValue` only works within the same account
- Exports are account-scoped (hub account can't import from orgManagement)
- No built-in mechanism for cross-account CloudFormation references

**CDK error message**:
```
Error: Cannot reference cross-account resource
  Resource: arn:aws:iam::955063685555:role/isb-lease-costs-explorer-role
  Current stack: arn:aws:cloudformation:us-west-2:568672915267:stack/IsbCostCollectionStack
```

#### Alternative Approaches for Cross-Account References

Since CDK cross-stack references don't work, we need manual parameter passing:

##### Approach 1: Context Variables (Current Implementation)

**How it works**:
```bash
# Pass role ARN as context variable
npx cdk deploy IsbCostCollectionStack \
  --context costExplorerRoleArn=arn:aws:iam::955063685555:role/isb-lease-costs-explorer-role
```

**In CDK code**:
```typescript
const roleArn = this.node.tryGetContext('costExplorerRoleArn') ||
  `arn:aws:iam::${orgMgmtAccountId}:role/isb-lease-costs-explorer-role`;

const costExplorerRole = iam.Role.fromRoleArn(this, 'CostExplorerRole', roleArn);
```

**Pros**:
- ✅ Simple implementation (no external services)
- ✅ Works across accounts and regions
- ✅ No additional infrastructure required
- ✅ Can be stored in `cdk.json` for defaults

**Cons**:
- ❌ Manual parameter passing (easy to get wrong)
- ❌ No validation that role exists until runtime
- ❌ ARN must be updated if role name changes
- ❌ Three-phase deployment process (role depends on Lambda, Lambda depends on role)

**Best for**: Cross-account deployments where resources are deployed infrequently and manually.

##### Approach 2: SSM Parameters (Alternative)

**How it works**:
```typescript
// In role stack (orgManagement account)
new ssm.StringParameter(this, 'RoleArnParam', {
  parameterName: '/isb/cost-collection/role-arn',
  stringValue: this.role.roleArn,
});

// In main stack (hub account)
const roleArn = ssm.StringParameter.valueForStringParameter(
  this,
  '/isb/cost-collection/role-arn'
);
```

**Pros**:
- ✅ Automated parameter sharing (no manual copying)
- ✅ Single source of truth (SSM stores the ARN)
- ✅ CDK handles SSM lookups automatically

**Cons**:
- ❌ Doesn't work cross-account (SSM parameters are account-scoped)
- ❌ Would require SSM parameter replication to hub account
- ❌ Additional AWS API calls during deployment (slower)
- ❌ SSM permissions required for CDK deployment role

**Best for**: Same-account cross-stack references (not applicable for our use case).

##### Approach 3: Cross-Account SSM Parameters

**How it works**:
```typescript
// 1. In role stack, create SSM parameter with cross-account read policy
const roleArnParam = new ssm.StringParameter(this, 'RoleArnParam', {
  parameterName: '/isb/cost-collection/role-arn',
  stringValue: this.role.roleArn,
});

// Add resource policy allowing hub account to read
roleArnParam.grantRead(
  new iam.AccountPrincipal('568672915267')  // hub account
);

// 2. In main stack, fetch via AWS SDK (not CDK)
// Requires Lambda or custom resource to fetch at deploy time
```

**Pros**:
- ✅ Automated parameter sharing across accounts
- ✅ Single source of truth
- ✅ Role ARN automatically updates if role changes

**Cons**:
- ❌ Complex setup (requires resource policies + cross-account IAM)
- ❌ CDK doesn't natively support cross-account SSM lookups
- ❌ Requires custom resource (Lambda) to fetch during deployment
- ❌ Additional infrastructure and API calls

**Best for**: Large-scale cross-account deployments with frequent updates and automation requirements.

##### Approach 4: CloudFormation Stack Outputs (Manual Lookup)

**How it works**:
```bash
# 1. Get role ARN from role stack output
ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --query 'Stacks[0].Outputs[?OutputKey==`RoleArn`].OutputValue' \
  --output text)

# 2. Pass to main stack deployment
npx cdk deploy IsbCostCollectionStack \
  --profile NDX/InnovationSandboxHub \
  --context costExplorerRoleArn=$ROLE_ARN
```

**Pros**:
- ✅ Simple (just bash commands)
- ✅ No additional AWS infrastructure
- ✅ Works for any cross-account scenario

**Cons**:
- ❌ Fully manual (requires bash scripting)
- ❌ No validation until deployment
- ❌ Easy to forget or run wrong commands

**Best for**: One-time deployments or CI/CD pipelines where scripting is acceptable.

#### Trade-offs Summary

| Approach | Complexity | Automation | Cross-Account | Runtime Overhead | CDK Native |
|----------|-----------|------------|---------------|------------------|------------|
| **Context Variables** (current) | Low | Manual | ✅ Yes | None | ✅ Yes |
| **SSM Parameters** | Medium | Automatic | ❌ No | Low (deploy time) | ✅ Yes |
| **Cross-Account SSM** | High | Automatic | ✅ Yes | Low (deploy time) | ⚠️ Partial (needs custom resource) |
| **Stack Outputs + Bash** | Low | Manual | ✅ Yes | None | ✅ Yes |

**Why we chose Context Variables**:
1. **Simplicity**: No additional AWS infrastructure (SSM, custom resources)
2. **Least-privilege**: Trust policy requires exact Lambda role ARN anyway (three-phase deployment unavoidable)
3. **Explicitness**: Operators explicitly provide ARN, reducing accidental misconfiguration
4. **No runtime overhead**: ARN is hard-coded at deploy time (no SSM API calls)
5. **Auditable**: Deployment commands show exact ARN used (easy to verify in CI/CD logs)

**When to consider alternatives**:
- **SSM approach**: If deploying multiple environments (dev/staging/prod) frequently
- **Cross-account SSM**: If role ARN changes often and you need automatic updates
- **Stack outputs + bash**: For CI/CD pipelines where scripting is acceptable

### Deploy with All Context Overrides

**Phase 1 - Main Stack:**
```bash
npx cdk deploy IsbCostCollectionStack \
  --profile NDX/InnovationSandboxHub \
  --context eventBusName=MyEventBus \
  --context costExplorerRoleArn=arn:aws:iam::955063685555:role/isb-lease-costs-explorer-role \
  --context isbLeasesLambdaArn=arn:aws:lambda:us-west-2:568672915267:function:isb-leases \
  --context alertEmail=alerts@example.com
```

For multi-environment deployments (dev, staging, prod), use custom scheduler group names:
```bash
# Development environment
npx cdk deploy IsbCostCollectionStack-Dev \
  --profile NDX/InnovationSandboxHub \
  --context schedulerGroupName=isb-lease-costs-dev \
  --context isbLeasesLambdaArn=arn:aws:lambda:us-west-2:568672915267:function:isb-leases-dev

# Production environment
npx cdk deploy IsbCostCollectionStack-Prod \
  --profile NDX/InnovationSandboxHub \
  --context schedulerGroupName=isb-lease-costs-prod \
  --context isbLeasesLambdaArn=arn:aws:lambda:us-west-2:568672915267:function:isb-leases-prod
```

**Phase 2 - Role Stack (using Lambda role ARN from Phase 1):**
```bash
npx cdk deploy IsbCostExplorerRoleStack \
  --profile NDX/orgManagement \
  --context costCollectorLambdaRoleArn=arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole...

# IMPORTANT: The Lambda role ARN must be exact - no wildcards
# Get it from: IsbCostCollectionStack.CostCollectorLambdaRoleArn output
```

### Additional Validation

After Phase 3 verification, test the complete flow:

```bash
# 1. Verify the Cost Collector Lambda has the correct Cost Explorer role configured
aws lambda get-function-configuration \
  --function-name isb-lease-costs-collector \
  --profile NDX/InnovationSandboxHub \
  --query 'Environment.Variables.COST_EXPLORER_ROLE_ARN'

# 2. Test AssumeRole permissions (dry run - doesn't query Cost Explorer)
aws sts assume-role \
  --role-arn arn:aws:iam::955063685555:role/isb-lease-costs-explorer-role \
  --role-session-name test-session \
  --profile NDX/InnovationSandboxHub

# Expected: Should fail with "AccessDenied" because you're not the Lambda role
# This confirms the trust policy is restrictive

# 3. Test a manual Lambda invocation (integration test)
# Create a test payload file first
cat > test-payload.json << 'EOF'
{
  "leaseId": "test-lease-123",
  "accountId": "123456789012",
  "startDate": "2026-01-01",
  "endDate": "2026-01-31",
  "userEmail": "test@example.com"
}
EOF

aws lambda invoke \
  --function-name isb-lease-costs-collector \
  --profile NDX/InnovationSandboxHub \
  --payload file://test-payload.json \
  response.json

cat response.json
```

**Expected validation results:**
- Trust policy should use `StringEquals` with exact Lambda role ARN (no `StringLike` or wildcards)
- Trust policy should include both `aws:PrincipalArn` and `aws:SourceAccount` conditions
- Manual AssumeRole should fail (only Lambda can assume the role)
- Lambda invocation should succeed and generate a CSV file in S3

### Stack Outputs

After deployment, the stack exports these values:

| Output | Description | Usage |
|--------|-------------|-------|
| `CostsBucketName` | S3 bucket name (`isb-lease-costs-{account}-{region}`) | Access CSV files directly, configure bucket notifications |
| `SchedulerLambdaArn` | Scheduler Lambda ARN | Reference in other stacks, IAM policies |
| `CostCollectorLambdaArn` | Cost Collector Lambda ARN | Reference in other stacks, manual testing |
| `AlertTopicArn` | SNS topic for operational alerts | Subscribe additional endpoints (Slack, PagerDuty) |

Retrieve outputs via CLI:

```bash
aws cloudformation describe-stacks \
  --stack-name IsbCostCollectionStack \
  --query 'Stacks[0].Outputs' \
  --profile NDX/InnovationSandboxHub
```

## Development

### Local Setup

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run lint

# Build
npm run build
```

### CLI Tool

The CLI tool provides manual cost queries for ad-hoc billing analysis. It queries AWS Cost Explorer for a specific account and time range, then outputs a markdown-formatted report to stdout.

#### Purpose

Use the CLI tool when you need to:
- Query costs for accounts not yet enrolled in automated collection
- Generate one-off cost reports for analysis or auditing
- Test Cost Explorer queries before automating them
- Debug cost data issues or validate automated reports

#### Prerequisites

1. **AWS SSO**: Configured and authenticated with Cost Explorer permissions
2. **AWS Profile**: `NDX/orgManagement` profile configured with SSO
3. **Node.js**: Version 18+ with dependencies installed (`npm install`)

#### Usage

```bash
# Login to AWS SSO (expires after session timeout)
aws sso login --profile NDX/orgManagement

# Run cost report with required parameters
npm start -- \
  --accountId <12-digit-account-id> \
  --startTime <YYYY-MM-DD> \
  --endTime <YYYY-MM-DD>
```

#### Parameters

| Parameter | Required | Format | Description |
|-----------|----------|--------|-------------|
| `--accountId` | ✅ | 12 digits | AWS Account ID to query costs for |
| `--startTime` | ✅ | YYYY-MM-DD | Start date (inclusive) for cost data |
| `--endTime` | ✅ | YYYY-MM-DD | End date (exclusive) for cost data |

**Date Range Notes:**
- `startTime` is inclusive: costs from this date are included
- `endTime` is exclusive: costs stop before this date (not included)
- Example: `--startTime 2026-01-01 --endTime 2026-02-01` queries all of January 2026

#### Output Format

The tool outputs a markdown report to stdout with:
- Account ID and date range header
- Total cost for the period (USD)
- Service-by-service breakdown table sorted by cost (highest first)

**Example Output:**
```markdown
# AWS Cost Report
Account: 123456789012
Period: 2026-01-01 to 2026-02-01
Total Cost: $1,234.56

## Costs by Service
| Service | Cost (USD) |
|---------|------------|
| Amazon EC2 | $567.89 |
| Amazon S3 | $234.56 |
| AWS Lambda | $123.45 |
| ... | ... |
```

#### Example Commands

```bash
# Query January 2026 costs
npm start -- --accountId 123456789012 --startTime 2026-01-01 --endTime 2026-02-01

# Save report to file
npm start -- \
  --accountId 123456789012 \
  --startTime 2026-01-01 \
  --endTime 2026-02-01 \
  > cost-report-jan-2026.md

# Query single day costs
npm start -- --accountId 123456789012 --startTime 2026-01-15 --endTime 2026-01-16
```

#### Error Handling

**Authentication Errors:**
```bash
Error: Could not load credentials from any providers
```
**Fix:** Run `aws sso login --profile NDX/orgManagement`

**Invalid Account ID:**
```bash
Error: Invalid accountId: 12345. Must be 12 digits
```
**Fix:** Provide full 12-digit account ID (e.g., `012345678901` not `12345`)

**Invalid Date Format:**
```bash
Error: Invalid startTime format: 01-15-2026. Use YYYY-MM-DD
```
**Fix:** Use YYYY-MM-DD format (e.g., `2026-01-15` not `01-15-2026`)

**No Permission:**
```bash
Error: User: arn:aws:sts::xxx:assumed-role/... is not authorized to perform: ce:GetCostAndUsage
```
**Fix:** Ensure your AWS SSO role has Cost Explorer read permissions

#### Troubleshooting

**Problem: "No cost data found"**
- AWS Cost Explorer has 24-48 hour delay for billing data
- Try querying dates at least 2 days in the past
- Verify the account ID is correct and has actual AWS usage

**Problem: "Session expired" error**
- AWS SSO sessions expire (typically after 8-12 hours)
- Re-run: `aws sso login --profile NDX/orgManagement`
- Consider using `--no-browser` flag for headless environments

**Problem: Report shows $0.00 for services you know have costs**
- Cost Explorer groups costs by billing date, not usage date
- Some services (like S3) may have delayed billing
- Check the previous month's report for delayed charges

#### Advanced Usage

**Pipe to other tools:**
```bash
# Convert markdown to PDF
npm start -- --accountId 123456789012 --startTime 2026-01-01 --endTime 2026-02-01 \
  | pandoc -f markdown -t pdf -o report.pdf

# Extract just the cost table
npm start -- --accountId 123456789012 --startTime 2026-01-01 --endTime 2026-02-01 \
  | sed -n '/## Costs by Service/,/^$/p'

# Search for specific service
npm start -- --accountId 123456789012 --startTime 2026-01-01 --endTime 2026-02-01 \
  | grep "Amazon EC2"
```

## ISB API Authentication

The Cost Collector Lambda authenticates with the ISB Leases API using a service JWT for direct Lambda invocation. This pattern is used because the ISB Leases Lambda is designed to be invoked via API Gateway with Cognito JWT authentication, but internal services need to call it directly.

### JWT Structure

**Implementation**: See `src/lib/isb-api-client.ts:createServiceJwt()`

The JWT uses base64url encoding (RFC 4648 §5: no padding, `-` instead of `+`, `_` instead of `/`):

```
Header:    {"alg": "HS256", "typ": "JWT"}     (base64url, no padding)
Payload:   {"user": {"email": "...", "roles": ["Admin"]}}  (base64url, no padding)
Signature: directinvoke                       (literal string, not cryptographic)
```

### Security Model

This "directinvoke" pattern provides security through IAM rather than cryptographic signatures:

| Layer | Protection |
|-------|------------|
| **Lambda Invocation** | Only the Cost Collector Lambda can invoke the ISB Leases Lambda (IAM policy: `lambda:InvokeFunction` on specific ARN) |
| **JWT Signature** | Not verified - the literal `directinvoke` string marks requests from direct Lambda invocation |
| **Request Authenticity** | Guaranteed by IAM - only authorized Lambdas can invoke, making cryptographic signatures redundant |
| **User Context** | The `email` in the JWT is used for audit logging, taken from the original LeaseTerminated event (not verified) |

### Why This Pattern?

1. **API Gateway bypass**: Direct Lambda invocation is more efficient and avoids API Gateway costs/limits
2. **IAM-first security**: Lambda-to-Lambda calls are secured by IAM policies, making cryptographic signatures redundant
3. **Middleware compatibility**: The ISB Leases Lambda middleware expects a JWT, even if the signature isn't verified
4. **Audit trail**: The user email from the original lease event is preserved for logging

### Related Services

This pattern is also used by:
- NDX Notifications service (for lease lifecycle alerts)
- Other ISB internal services requiring lease data

## Security Considerations

### Threat Model

This service operates in a **trusted internal service-to-service** environment within the AWS account. Understanding what threats we protect against and what we don't is critical for security assessment.

#### Attacks This DOES Protect Against

| Attack Vector | Protection Mechanism | How It Works |
|---------------|---------------------|--------------|
| **Unauthorized Lambda invocation** | IAM policy with specific ARN | Only the Cost Collector Lambda's execution role has `lambda:InvokeFunction` permission on the ISB Leases Lambda ARN |
| **Cross-account access** | IAM trust policy boundaries | Lambda execution roles are account-scoped; cross-account access requires explicit trust relationships |
| **Privilege escalation via role assumption** | Least-privilege IAM policies | Cost Explorer role in orgManagement only allows `ce:GetCostAndUsage`, cannot escalate to other permissions |
| **Unauthorized Cost Explorer access** | Cross-account STS AssumeRole with exact role ARN | orgManagement trust policy uses `StringEquals` condition on `aws:PrincipalArn` (no wildcards) - only the specific Lambda role can assume it |
| **Event injection** | EventBridge source validation | EventBridge rules filter by `source: isb` and `detail-type: LeaseTerminated` - prevents spoofed events from other sources |
| **Data exfiltration via S3** | Bucket policy + VPC endpoints | S3 bucket blocks public access; presigned URLs expire after 7 days; network isolation via VPC if configured |

#### Attacks This DOES NOT Protect Against

| Attack Vector | Why Not Protected | Mitigation Strategy |
|---------------|-------------------|---------------------|
| **Compromised Lambda execution role** | If the Cost Collector Lambda role is compromised, attacker has full service access | **Monitor**: CloudTrail logs for unusual API calls (e.g., `lambda:UpdateFunctionCode`, `iam:AttachRolePolicy`). Enable AWS GuardDuty for anomaly detection. |
| **JWT signature forgery** | `directinvoke` signature is not cryptographically verified by ISB Leases Lambda | **Not a vulnerability**: IAM prevents unauthorized invocation. JWT is for middleware compatibility only. If ISB Leases Lambda is ever exposed via API Gateway, use real HMAC-SHA256 signatures. |
| **Replay attacks on Lambda invocations** | Lambda doesn't validate request uniqueness or timestamps | **By design**: Cost collection is idempotent - replaying a request for the same leaseId produces the same CSV (S3 overwrites). No side effects beyond S3 writes. |
| **User email spoofing in JWT payload** | Email is taken from LeaseTerminated event without cryptographic verification | **Trust model**: Events come from ISB EventBridge bus (internal source). Email is for audit logs only, not authorization. If email authenticity is required, validate against ISB API response (`leaseDetails.user.email`). |
| **Man-in-the-middle on Lambda-to-Lambda calls** | Lambda invocations use AWS internal network, but no TLS verification | **AWS responsibility**: Lambda service-to-service communication uses AWS internal network with encryption in transit. Cannot be intercepted by customers. |
| **S3 presigned URL sharing** | URLs are valid for 7 days and can be shared by anyone with the URL | **By design**: URLs are intended for downstream consumers (e.g., billing dashboard). If stricter access control is needed, use S3 bucket policies with IAM-based access instead of presigned URLs. |

### When to Use Real JWT Signatures

The current `directinvoke` pattern is **sufficient** for Lambda-to-Lambda service invocation because IAM provides authentication. However, you should use **real HMAC-SHA256 JWT signatures** in these scenarios:

| Scenario | Why Real Signatures Are Needed | Implementation |
|----------|-------------------------------|----------------|
| **API Gateway invocation** | API Gateway doesn't enforce IAM policies on Lambda invocations - anyone with the endpoint URL can call it | Use Cognito authorizer or custom Lambda authorizer with HMAC-SHA256 signature verification |
| **External service integration** | Third-party services outside AWS account cannot use IAM authentication | Generate JWT with shared secret, verify signature using `crypto.createHmac('sha256', secret)` |
| **Multi-tenant environments** | Need to verify JWT claims (e.g., `tenantId`) before processing request | Sign JWT with tenant-specific secret, verify signature + claims in middleware |
| **Public endpoints** | Service is exposed to the internet (e.g., webhooks, public APIs) | Use asymmetric signing (RS256) with public key verification to prevent secret leakage |

### Lambda-to-Lambda Invocation Security

#### How IAM-Based Authentication Works

```
┌─────────────────────────────────────────────────────────────────┐
│ Cost Collector Lambda                                           │
│   Execution Role: CostCollectorLambdaRole                       │
│   ├─ sts:AssumeRole (orgManagement Cost Explorer role)          │
│   ├─ lambda:InvokeFunction (ISB Leases Lambda)  ← IAM AUTH      │
│   ├─ s3:PutObject (costs bucket)                                │
│   └─ events:PutEvents (ISB EventBridge)                         │
└─────────────────────────────────────────────────────────────────┘
                │
                │ InvokeCommand (with IAM signature)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ ISB Leases Lambda                                               │
│   Resource Policy: Trust CostCollectorLambdaRole                │
│   ├─ Verifies AWS SigV4 signature on InvokeCommand              │
│   └─ Checks IAM policy: CostCollectorLambdaRole has permission  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Security Properties:**

1. **AWS SigV4 Signature**: Every Lambda invocation is signed using the caller's IAM credentials (AWS Signature Version 4). This signature is cryptographically verified by AWS Lambda service before invocation.

2. **IAM Policy Enforcement**: Even if an attacker forges a request, Lambda service checks:
   - Caller's IAM role has `lambda:InvokeFunction` permission
   - Target Lambda resource policy (if any) allows the invocation
   - Request signature matches the IAM credentials

3. **No Shared Secrets**: Unlike JWT HMAC-SHA256, IAM uses asymmetric cryptography (AWS manages private keys). Credentials cannot be leaked through environment variables or logs.

4. **Automatic Key Rotation**: IAM temporary credentials (from Lambda execution role) expire after 6 hours and are automatically rotated by AWS.

### Why `directinvoke` is Acceptable

The `directinvoke` JWT signature is a **marker**, not a security control. Security is provided by:

1. **Network-level isolation**: Lambda-to-Lambda invocations use AWS internal network (cannot be reached from internet)
2. **IAM policy enforcement**: Only authorized roles can invoke (enforced by AWS Lambda service, not application code)
3. **VPC isolation (optional)**: If configured, Lambda functions run in VPC with no internet access except via NAT gateway

**The JWT signature is only checked if**:
- ISB Leases Lambda is invoked via API Gateway (public endpoint)
- API Gateway doesn't use IAM authorizer (uses Cognito or custom authorizer)

For direct Lambda invocation, **the middleware may check the signature, but it's redundant** because IAM has already authenticated the request.

### When `directinvoke` is NOT Sufficient

| Scenario | Risk | Solution |
|----------|------|----------|
| **ISB Leases Lambda has public API Gateway endpoint** | Anyone with endpoint URL can call it (API Gateway doesn't enforce IAM by default) | Use Cognito authorizer + real HMAC-SHA256 JWT signatures |
| **Need to verify user claims before processing** | JWT payload contains untrusted data (e.g., `email`, `roles`) | Verify signature with shared secret, then validate claims |
| **Compliance requires non-repudiation** | Need cryptographic proof of who made the request | Use asymmetric JWT (RS256) with private key signing + audit logs |
| **Lambda resource policy is too permissive** | Resource policy allows `lambda:InvokeFunction` from entire account | Tighten resource policy to specific role ARNs + use real JWT signatures as defense-in-depth |

### Network Isolation Considerations

#### Current Architecture (No VPC)

- **Lambda network**: Uses AWS internal network (not internet-routable)
- **Egress**: Lambda can make outbound calls to AWS services (S3, EventBridge, STS, Cost Explorer) and ISB Leases Lambda
- **Ingress**: Lambda is invoked by EventBridge Scheduler (internal AWS service)
- **Risk**: If Lambda code is compromised, attacker can exfiltrate data via any outbound HTTPS connection

#### VPC Deployment (Enhanced Isolation)

To deploy Lambdas in VPC with no internet access:

```typescript
// In CDK stack
const lambdaVpc = ec2.Vpc.fromLookup(this, 'VPC', { ... });

const costCollectorLambda = new nodejs.NodejsFunction(this, 'CostCollector', {
  vpc: lambdaVpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  allowPublicSubnet: false,  // Force private subnets only
  securityGroups: [lambdaSecurityGroup],
});

// Create VPC endpoints for AWS services (no internet needed)
vpc.addInterfaceEndpoint('S3Endpoint', { service: ec2.InterfaceVpcEndpointAwsService.S3 });
vpc.addInterfaceEndpoint('EventBridgeEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE });
vpc.addInterfaceEndpoint('STSEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.STS });
```

**Benefits:**
- No outbound internet access (even if Lambda code is compromised)
- All AWS service calls go through VPC endpoints (private network)
- VPC Flow Logs for network traffic monitoring

**Trade-offs:**
- Increased complexity (VPC management, ENI limits, subnet planning)
- Additional cost (VPC endpoints: $0.01/hour + $0.01/GB data transfer)
- Cold start latency (ENI creation takes 10-30 seconds on first invocation)

### Defense-in-Depth Recommendations

For production deployments, consider these additional security layers:

1. **CloudTrail Monitoring**: Alert on suspicious API calls (e.g., `lambda:UpdateFunctionCode`, `iam:PutRolePolicy`, `sts:AssumeRole` to unexpected roles)

2. **VPC Deployment**: Deploy Lambdas in VPC with VPC endpoints (no internet egress)

3. **Least-Privilege IAM**: Audit IAM policies quarterly, remove unused permissions

4. **EventBridge Rule Validation**: Ensure `source: isb` filter prevents spoofed events from other sources

5. **S3 Bucket Policies**: Add condition keys to restrict presigned URL generation (e.g., `s3:x-amz-server-side-encryption: AES256`)

6. **Secrets Rotation**: If implementing real JWT signatures, use AWS Secrets Manager with automatic rotation

7. **GuardDuty**: Enable for anomaly detection (e.g., unusual API call patterns, credential exfiltration attempts)

8. **Cost Anomaly Alarms**: Alert on unexpected Cost Explorer query volumes (may indicate compromised Lambda making excessive queries)

### Related Documentation

- **IAM Best Practices**: https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
- **Lambda Security**: https://docs.aws.amazon.com/lambda/latest/dg/lambda-security.html
- **VPC Endpoints**: https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints.html
- **JWT Security**: https://tools.ietf.org/html/rfc8725 (JSON Web Token Best Current Practices)

## Failure Modes

| Scenario | Behavior | Downstream Impact |
|----------|----------|-------------------|
| Cost Explorer returns empty | CSV with headers only, `totalCost: 0` | Event still emitted |
| ISB API fails | Lambda throws, retries, then DLQ + alarm | No event emitted |
| STS AssumeRole fails | Lambda throws, retries, then DLQ + alarm | No event emitted |
| S3 upload fails | Lambda throws, retries, then DLQ + alarm | No event emitted |
| EventBridge emit fails | Lambda throws, retries, then DLQ + alarm | CSV exists but no notification |
| Schedule creation fails | Scheduler Lambda retries via EventBridge | Delayed collection never triggers |
| Schedule already exists | Handled idempotently (ConflictException caught) | Original schedule executes |

## Testing

The project uses a comprehensive testing strategy with unit tests, integration tests, and infrastructure tests.

### Quick Start

```bash
# Run all tests
npm test

# Run with coverage
npm run test:ci

# Watch mode (development)
npm run test:watch

# Run specific test file
npm test -- src/lib/cost-explorer.test.ts
```

### Test Types

- **Unit Tests** (`*.test.ts`): Fast tests with mocked AWS SDK (413 tests)
- **Integration Tests** (`*.integration.test.ts`): Tests with real AWS SDK responses via VCR pattern
- **CDK Tests** (`infra/**/*.test.ts`): Infrastructure snapshot and assertion tests

### Integration Tests with VCR Pattern

Integration tests use recorded AWS API responses (fixtures) to test pagination without AWS credentials:

```bash
# Run integration tests (uses fixtures, no AWS credentials needed)
npm test -- cost-explorer.integration.test.ts

# Record new fixtures (requires AWS credentials)
RECORD_FIXTURES=true npm test -- cost-explorer.integration.test.ts

# Or with AWS profile
AWS_PROFILE=my-profile RECORD_FIXTURES=true npm test
```

**CI/CD**: Integration tests automatically skip in CI environments. Fixtures are committed to the repository.

### Test Coverage

✅ All 413 tests passing with >80% coverage across statements, branches, functions, and lines.

For detailed testing documentation, see [docs/TESTING.md](./docs/TESTING.md).

## CSV Output Format

> **Breaking Change (v2.0.0)**: The CSV format changed from 2 columns (`Service,Cost`) to 4 columns (`Resource Name,Service,Region,Cost`) with full decimal precision. See [Migration Guide](#csv-format-migration) below.

The generated CSV files follow **[RFC 4180](https://datatracker.ietf.org/doc/html/rfc4180)** (Common Format and MIME Type for Comma-Separated Values) with these characteristics:

- **Header row**: `Resource Name,Service,Region,Cost`
- **Data rows**: One row per AWS resource, sorted by service total cost (descending), then resource cost within service (descending)
- **Cost format**: Full precision from AWS Cost Explorer (e.g., `0.0000005793` - not rounded)
- **Escaping**: Values containing commas, quotes, or newlines are wrapped in double quotes
- **Quote escaping**: Internal quotes are doubled (e.g., `"Service ""Pro""",100.00`)
- **Line endings**: LF (`\n`) for Unix compatibility
- **Character encoding**: UTF-8
- **CSV injection protection**: Formula trigger characters (`=`, `+`, `-`, `@`, `|`, `%`) are prefixed with single quote

### Example Output

```csv
Resource Name,Service,Region,Cost
i-1234567890abcdef0,Amazon Elastic Compute Cloud - Compute,us-east-1,1234.5600000000
my-bucket,Amazon Simple Storage Service,us-west-2,567.8900000000
No resource breakdown available for this service type,AWS Lambda,global,12.3400000000
```

### Special Resource Name Values

| Resource Name | Meaning |
|---------------|---------|
| ARN or resource ID | Standard resource with cost data |
| `No resource breakdown available for this service type` | Service doesn't support resource-level granularity (e.g., GuardDuty) |
| `No resource breakdown available for this time window` | Costs from period beyond 14-day lookback limit |

### CSV Format Migration

If you're migrating from the previous 2-column format:

**Old Format (v1.x):**
```csv
Service,Cost
Amazon EC2,1234.56
Amazon S3,567.89
```

**New Format (v2.0.0+):**
```csv
Resource Name,Service,Region,Cost
i-1234567890abcdef0,Amazon EC2,us-east-1,1234.5600000000
my-bucket,Amazon S3,us-west-2,567.8900000000
```

**TypeScript Migration:**
```typescript
// OLD (v1.x)
interface OldCostRecord {
  Service: string;
  Cost: string;
}

// NEW (v2.0.0+)
interface CostRecord {
  'Resource Name': string;
  Service: string;
  Region: string;
  Cost: string;
}

// Parse new format
const records = parse(csvContent, { columns: true }) as CostRecord[];

// Aggregate by service (for backward compatibility)
const byService = records.reduce((acc, r) => {
  acc[r.Service] = (acc[r.Service] || 0) + parseFloat(r.Cost);
  return acc;
}, {} as Record<string, number>);
```

### Edge Cases

The CSV generator handles these edge cases per RFC 4180:

| Scenario | Example Input | CSV Output | Explanation |
|----------|---------------|------------|-------------|
| **Empty resource name** | `resourceName: ""` | `,Service,us-east-1,123.45` | Empty string is valid |
| **Commas in name** | `resourceName: "EC2, Compute"` | `"EC2, Compute",Service,...` | Wrapped in quotes |
| **Quotes in name** | `resourceName: 'Res "Pro"'` | `"Res ""Pro""",Service,...` | Internal quotes doubled |
| **Newlines in name** | `resourceName: "L1\nL2"` | `"L1\nL2",Service,...` | Wrapped in quotes |
| **Formula injection** | `resourceName: "=cmd\|calc"` | `'=cmd\|calc,Service,...` | Prefixed with single quote |
| **Zero cost** | `cost: "0"` | `resource,S3,us-east-1,0` | Zero is valid |
| **Full precision** | `cost: "0.0000005793"` | `resource,Lambda,global,0.0000005793` | All decimals preserved |
| **Large cost** | `cost: "999999.99"` | `resource,EC2,us-east-1,999999.99` | No thousands separator |
| **Global region** | `region: "global"` | `resource,CloudFront,global,10.00` | For region-less services |

### RFC 4180 Conformance Testing

To verify CSV output conforms to RFC 4180:

#### Using csv-parse (Node.js)

```bash
npm install csv-parse
```

```javascript
import { parse } from 'csv-parse/sync';
import fs from 'fs';

// Read CSV from S3 presigned URL (or local file for testing)
const csvContent = fs.readFileSync('lease-costs.csv', 'utf-8');

try {
  // Parse with RFC 4180 strict mode
  const records = parse(csvContent, {
    columns: true,        // First row is header
    skip_empty_lines: true,
    trim: false,          // Don't trim whitespace (preserve original data)
    relax_quotes: false,  // Strict quote handling
    relax_column_count: false  // Strict column count
  });

  console.log(`✓ RFC 4180 compliant: ${records.length} records parsed`);
  console.log('Sample record:', records[0]);
} catch (error) {
  console.error('✗ RFC 4180 violation:', error.message);
}
```

#### Using csvlint (Ruby)

```bash
gem install csvlint
csvlint lease-costs.csv
```

Expected output:
```
✓ CSV is valid
✓ Header row present
✓ 15 data rows
✓ No encoding errors
```

#### Manual Validation Checklist

- [ ] Header row is `Resource Name,Service,Region,Cost`
- [ ] All rows have exactly 4 fields
- [ ] Cost values preserve full precision from AWS (not rounded)
- [ ] Values with commas/quotes/newlines are quoted
- [ ] Internal quotes are doubled (e.g., `""`)
- [ ] Formula characters (`=+@-|%`) at start of values are prefixed with `'`
- [ ] File is UTF-8 encoded
- [ ] No trailing comma on any line
- [ ] Region values are AWS region codes (e.g., `us-east-1`) or `global`

### Testing CSV Generation

Run the test suite to verify edge case handling:

```bash
npm test -- src/lib/csv-generator.test.ts
```

Key test cases:
- Empty service name
- Service name with comma
- Service name with quotes
- Service name with newline
- Zero cost
- Large cost values
- Multiple services with same name (rare but valid)

## Configuration Validation

Environment variables are validated at Lambda cold start (module load time), not at runtime. This means:

- **Invalid values**: Lambda fails immediately on first invocation
- **Missing required values**: Error message names the missing variable
- **Out-of-bounds values**: Validation includes min/max constraints (e.g., `PRESIGNED_URL_EXPIRY_DAYS` must be 1-7)

This fail-fast approach prevents partial execution with invalid configuration.

## CI/CD Configuration

The GitHub Actions workflow (`.github/workflows/deploy.yml`) requires these secrets and variables:

### Required Secrets

| Secret | Description |
|--------|-------------|
| `AWS_ROLE_ARN` | OIDC role ARN for GitHub Actions to assume |
| `COST_EXPLORER_ROLE_ARN` | ARN of the Cost Explorer role in orgManagement account |
| `ISB_LEASES_LAMBDA_ARN` | ARN of the ISB Leases API Lambda function |

### Repository Variables

| Variable | Description |
|----------|-------------|
| `EVENT_BUS_NAME` | Name of the ISB EventBridge bus |
| `ALERT_EMAIL` | Email address for operational alerts (optional) |

### OIDC Setup

The deployment uses OIDC (OpenID Connect) for secure, keyless authentication:

1. Create an IAM role with trust policy for GitHub Actions
2. Grant the role permission to deploy CDK stacks
3. Set `AWS_ROLE_ARN` secret to the role ARN

## Event Schema Evolution Strategy

This service emits EventBridge events that downstream consumers depend on. To ensure backward compatibility and safe evolution of these contracts, we follow strict versioning and migration guidelines.

### Schema Categories

Our schemas fall into four categories, each with different evolution requirements:

| Schema Type | Example | Compatibility Rule | Reason |
|-------------|---------|-------------------|--------|
| **Incoming Events** | `LeaseTerminated` | Best-effort - coordinate with ISB team | External producer we don't control |
| **Internal Payloads** | `SchedulerPayload` | Strict coordination required | We control both ends |
| **Outgoing Events** | `LeaseCostsGenerated` | Always backward compatible | External consumers we don't control |
| **External API Responses** | `LeaseDetails` | Permissive with `.passthrough()` | ISB API evolves independently |

### Versioning Approach

**Current State**: Implicit versioning (no explicit version field)
- All schemas default to version 1.0
- Backward compatibility maintained through careful field additions
- Breaking changes avoided by design

**Future State**: Explicit versioning (if needed)
- Add `schemaVersion` field when breaking changes become necessary
- Use discriminated unions to support multiple versions simultaneously
- Maintain parsers for all supported versions (6-month overlap period)

### Breaking vs Non-Breaking Changes

#### Non-Breaking Changes (Safe)

These changes can be made without coordination with consumers:

| Change Type | Example | Impact |
|-------------|---------|--------|
| **Add optional field** | Add `billingRegion?: string` | Old consumers ignore it, new consumers can use it |
| **Widen validation** | Change `z.literal("active")` to `z.enum(["active", "pending"])` | Old consumers already handle "active" |
| **Add enum value** | Add "AutoScaled" to termination reasons | Old consumers treat as unknown reason type |
| **Document existing behavior** | Clarify that `totalCost` includes taxes | No schema change, just documentation |

#### Breaking Changes (Dangerous)

These changes require coordination and migration:

| Change Type | Example | Why It Breaks | Migration Strategy |
|-------------|---------|---------------|-------------------|
| **Remove field** | Delete `currency` field | Consumers expect it to exist | Add replacement field first, deprecate old field (6 months), then remove |
| **Rename field** | Rename `leaseId` to `resourceId` | Consumers use old field name | Treat as remove + add (6-month overlap) |
| **Change type** | Change `totalCost` from `number` to `string` | Type mismatch in consumer code | Add new field `totalCostFormatted: string`, deprecate old field |
| **Make field required** | Remove `.optional()` from `newField` | Old events without field fail validation | Ensure all producers set field for 7+ days first |
| **Narrow validation** | Change `z.string()` to `z.string().uuid()` | Old values may not match new constraint | Add new field with stricter validation, deprecate old field |

### Safe Schema Evolution Process

#### Adding Optional Fields to Outgoing Events

When adding a new optional field to `LeaseCostsGenerated`:

```typescript
// Step 1: Add to schema with .optional()
export const LeaseCostsGeneratedDetailSchema = z.object({
  leaseId: uuidV4Schema(),
  accountId: z.string().regex(/^\d{12}$/),
  totalCost: z.number().nonnegative(),
  currency: z.literal("USD"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  csvUrl: z.string().url(),
  urlExpiresAt: z.string().datetime(),

  // NEW: Optional field for AWS region
  billingRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional(),
});
```

**Step 2**: Update event emitter to include the new field:

```typescript
// In event-emitter.ts
await eventBridge.putEvents({
  Entries: [{
    DetailType: "LeaseCostsGenerated",
    Source: "isb-costs",
    Detail: JSON.stringify({
      leaseId,
      accountId,
      totalCost,
      currency: "USD",
      startDate,
      endDate,
      csvUrl,
      urlExpiresAt,
      billingRegion: "us-east-1", // New field
    }),
  }],
});
```

**Step 3**: Deploy and notify consumers:

```bash
# Deploy updated service
npx cdk deploy IsbCostCollectionStack

# Document change in CHANGELOG.md
## [1.1.0] - 2026-02-03
### Added
- `billingRegion` field to `LeaseCostsGenerated` event (optional)
  - Format: AWS region code (e.g., "us-east-1")
  - Indicates which region Cost Explorer was queried from
  - Old consumers can safely ignore this field

# Notify downstream teams
Subject: New optional field in LeaseCostsGenerated events
Body: Starting 2026-02-03, LeaseCostsGenerated events will include an optional
      billingRegion field. This is backward compatible - existing consumers
      will continue to work without changes.
```

**Step 4**: Wait 30 days before considering making it required (if needed).

#### Adding Required Fields Safely (Internal Payloads)

When adding a new required field to `SchedulerPayload` (internal Lambda-to-Lambda):

```typescript
// Step 1: Add as optional with sensible default
export const SchedulerPayloadSchema = z.object({
  leaseId: uuidV4Schema(),
  userEmail: strictEmailSchema(),
  accountId: z.string().regex(/^\d{12}$/),
  leaseEndTimestamp: z.string().datetime(),
  scheduleName: z.string(),

  // NEW: Optional field that will become required
  leaseDurationDays: z.number().int().positive().optional(),
});
```

**Step 2**: Update consumer (Cost Collector Lambda) to handle both cases:

```typescript
// In cost-collector-handler.ts
const leaseDuration = payload.leaseDurationDays ??
  Math.ceil((new Date(payload.leaseEndTimestamp).getTime() - Date.now()) / (24 * 60 * 60 * 1000));

console.log(`Lease duration: ${leaseDuration} days`);
```

**Step 3**: Deploy consumer first (can handle old and new payloads).

**Step 4**: Update producer (Scheduler Lambda) to include field:

```typescript
// In scheduler-handler.ts
const leaseDurationDays = Math.ceil(
  (new Date(leaseEndTimestamp).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
);

const payload: SchedulerPayload = {
  leaseId,
  userEmail,
  accountId,
  leaseEndTimestamp,
  scheduleName,
  leaseDurationDays, // Now included
};
```

**Step 5**: Deploy producer.

**Step 6**: Monitor CloudWatch Logs for 7 days to ensure:
- No events without the new field are still being processed
- No validation errors in consumer Lambda

**Step 7**: Make field required (remove `.optional()`):

```typescript
leaseDurationDays: z.number().int().positive(), // Now required
```

**Step 8**: Deploy both Lambdas again with updated schema.

### Deprecating Fields

When a field is no longer needed but consumers may still depend on it:

**Step 1**: Mark field as deprecated in schema comments:

```typescript
export const LeaseCostsGeneratedDetailSchema = z.object({
  leaseId: uuidV4Schema(),
  accountId: z.string().regex(/^\d{12}$/),
  totalCost: z.number().nonnegative(),

  /**
   * @deprecated Use `currencyCode` instead. This field will be removed in v2.0 (2026-08-01).
   * Reason: Adding support for multiple currencies.
   */
  currency: z.literal("USD"),

  // Replacement field
  currencyCode: z.enum(["USD", "GBP", "EUR"]).default("USD"),

  // ... other fields
});
```

**Step 2**: Document deprecation in CHANGELOG:

```markdown
## [1.2.0] - 2026-02-03
### Deprecated
- `currency` field will be removed in v2.0 (scheduled for 2026-08-01)
  - Use `currencyCode` instead (same values, more explicit name)
  - Both fields will return the same value during deprecation period

### Added
- `currencyCode` field as replacement for `currency`
```

**Step 3**: Emit both fields during deprecation period (6 months):

```typescript
Detail: JSON.stringify({
  leaseId,
  accountId,
  totalCost,
  currency: "USD", // Deprecated but still included
  currencyCode: "USD", // New field
  // ... other fields
}),
```

**Step 4**: Notify all consumers with 6-month timeline:

```
Subject: DEPRECATION NOTICE - LeaseCostsGenerated.currency field

The `currency` field in LeaseCostsGenerated events is deprecated and will be
removed on 2026-08-01.

Action Required:
- Update your code to use `currencyCode` instead of `currency`
- Both fields currently return the same value ("USD")
- After 2026-08-01, only `currencyCode` will be present

Migration example:
  Before:  const currency = event.detail.currency;
  After:   const currency = event.detail.currencyCode;
```

**Step 5**: After 6 months, remove deprecated field in major version bump:

```typescript
// v2.0.0 - Breaking change
export const LeaseCostsGeneratedDetailSchemaV2 = z.object({
  schemaVersion: z.literal("2.0"), // Now explicit
  leaseId: uuidV4Schema(),
  accountId: z.string().regex(/^\d{12}$/),
  totalCost: z.number().nonnegative(),
  currencyCode: z.enum(["USD", "GBP", "EUR"]), // currency field removed
  // ... other fields
});
```

### Testing Schema Changes

Before deploying schema changes, run these tests:

```bash
# 1. Run schema validation tests
npm test -- schemas.test.ts

# 2. Test backward compatibility with old payloads
# Create test files with old event format
cat > test-old-event.json << 'EOF'
{
  "detail-type": "LeaseCostsGenerated",
  "source": "isb-costs",
  "detail": {
    "leaseId": "550e8400-e29b-41d4-a716-446655440000",
    "accountId": "123456789012",
    "totalCost": 125.45,
    "currency": "USD",
    "startDate": "2026-01-15",
    "endDate": "2026-02-03",
    "csvUrl": "https://s3.amazonaws.com/bucket/lease.csv",
    "urlExpiresAt": "2026-02-10T12:00:00.000Z"
  }
}
EOF

# 3. Test new schema accepts old events
npm test -- -t "backward compatibility"

# 4. Test migration path with optional fields
npm test -- -t "migration path"
```

### Rollback Procedures

If a schema change causes issues in production:

#### Immediate Rollback (< 1 hour)

```bash
# 1. Identify problematic stack version
aws cloudformation describe-stacks \
  --stack-name IsbCostCollectionStack \
  --query 'Stacks[0].StackStatus'

# 2. Rollback to previous version
aws cloudformation rollback-stack --stack-name IsbCostCollectionStack

# 3. Monitor rollback progress
aws cloudformation describe-stack-events \
  --stack-name IsbCostCollectionStack \
  --max-items 10

# 4. Verify rollback completed
aws cloudformation wait stack-rollback-complete \
  --stack-name IsbCostCollectionStack
```

#### Schema Hotfix (1-4 hours)

If rollback isn't possible (e.g., new field already relied upon):

```bash
# 1. Revert schema change in code
git revert HEAD  # Revert the commit that changed schema

# 2. Add .optional() to new required field (make it backward compatible)
# Edit schemas.ts:
-  newField: z.string(),
+  newField: z.string().optional(),

# 3. Deploy hotfix
npx cdk deploy IsbCostCollectionStack

# 4. Update consumers to handle missing field gracefully
```

#### Communication Plan for Failed Deployments

```markdown
Subject: INCIDENT - LeaseCostsGenerated schema change rolled back

Summary:
- Deployment of schema change (added required field) caused validation errors
- Rolled back to previous version at 2026-02-03 14:30 UTC
- Root cause: Field was made required before all producers updated
- No data loss - events stored in DLQ for reprocessing

Impact:
- LeaseCostsGenerated events failed validation for 15 minutes
- Affected consumers: [list consumers]
- Events stored in DLQ: 23 events

Resolution:
- Schema change reverted
- Field made optional instead of required
- DLQ events will be reprocessed automatically
- Estimated time to full recovery: 30 minutes

Action Items:
- [ ] Update deployment process to enforce consumer-first updates
- [ ] Add pre-deployment schema validation tests
- [ ] Document rollback procedures in runbook
```

### Communication with Consumers

When making schema changes that affect downstream consumers:

#### Email Template for New Optional Fields

```
Subject: [Low Impact] New optional field in LeaseCostsGenerated events

Hi Team,

We're adding a new optional field to LeaseCostsGenerated events:

Field: billingRegion
Type: string (AWS region code, e.g., "us-east-1")
Deployment: 2026-02-03
Impact: None - your existing code will continue to work

Example:
{
  "leaseId": "550e8400-e29b-41d4-a716-446655440000",
  "accountId": "123456789012",
  "totalCost": 125.45,
  "currency": "USD",
  "startDate": "2026-01-15",
  "endDate": "2026-02-03",
  "csvUrl": "https://s3.amazonaws.com/...",
  "urlExpiresAt": "2026-02-10T12:00:00.000Z",
  "billingRegion": "us-east-1"  <-- NEW
}

No action required, but you may find this field useful for:
- Regional cost analysis
- Multi-region compliance reporting

Questions? Contact the ISB Costs team.
```

#### Email Template for Deprecation

```
Subject: [Action Required] Deprecation of LeaseCostsGenerated.currency field

Hi Team,

We're deprecating the `currency` field in LeaseCostsGenerated events:

Deprecation Date: 2026-02-03
Removal Date: 2026-08-01 (6 months)
Replacement: Use `currencyCode` field instead

Current event structure (both fields present):
{
  "currency": "USD",      <-- DEPRECATED (remove by 2026-08-01)
  "currencyCode": "USD",  <-- USE THIS INSTEAD
}

Action Required:
1. Update your code to use `currencyCode` instead of `currency`
2. Test changes in development environment
3. Deploy before 2026-08-01

Migration example:
  Before:  const curr = event.detail.currency;
  After:   const curr = event.detail.currencyCode;

Timeline:
- 2026-02-03: Both fields present (6-month overlap)
- 2026-08-01: `currency` field removed (only `currencyCode` remains)

Need help? Contact the ISB Costs team.
```

### Related Documentation

- **Schema definitions**: `/Users/cns/httpdocs/cddo/innovation-sandbox-on-aws-costs/src/lib/schemas.ts`
- **Schema tests**: `/Users/cns/httpdocs/cddo/innovation-sandbox-on-aws-costs/src/lib/schemas.test.ts`
- **Event emitter**: `/Users/cns/httpdocs/cddo/innovation-sandbox-on-aws-costs/src/lib/event-emitter.ts`
- **Zod documentation**: https://zod.dev

## Operations & Monitoring

### CloudWatch Dashboard

The system provides comprehensive monitoring through CloudWatch metrics, alarms, and X-Ray tracing. Create a custom dashboard to visualize key operational metrics:

#### Dashboard JSON Template

Save this template to `cloudwatch-dashboard.json`:

```json
{
  "widgets": [
    {
      "type": "metric",
      "properties": {
        "metrics": [
          [ "AWS/Lambda", "Invocations", { "stat": "Sum", "label": "Scheduler Invocations" } ],
          [ ".", "Errors", { "stat": "Sum", "label": "Scheduler Errors" } ],
          [ ".", "Duration", { "stat": "Average", "label": "Scheduler Duration (avg)" } ]
        ],
        "view": "timeSeries",
        "region": "us-west-2",
        "title": "Scheduler Lambda Metrics",
        "period": 300,
        "yAxis": {
          "left": {
            "label": "Count",
            "showUnits": false
          }
        }
      }
    },
    {
      "type": "metric",
      "properties": {
        "metrics": [
          [ "AWS/Lambda", "Invocations", { "stat": "Sum", "label": "Collector Invocations" } ],
          [ ".", "Errors", { "stat": "Sum", "label": "Collector Errors" } ],
          [ ".", "Duration", { "stat": "Average", "label": "Collector Duration (avg)" } ],
          [ ".", "Duration", { "stat": "Maximum", "label": "Collector Duration (max)" } ]
        ],
        "view": "timeSeries",
        "region": "us-west-2",
        "title": "Cost Collector Lambda Metrics",
        "period": 300,
        "yAxis": {
          "left": {
            "label": "Count / Milliseconds",
            "showUnits": false
          }
        }
      }
    },
    {
      "type": "metric",
      "properties": {
        "metrics": [
          [ "AWS/SQS", "ApproximateNumberOfMessagesVisible", { "stat": "Maximum", "label": "Collector DLQ Messages" } ],
          [ ".", "NumberOfMessagesSent", { "stat": "Sum", "label": "Collector DLQ Sent" } ]
        ],
        "view": "timeSeries",
        "region": "us-west-2",
        "title": "Dead Letter Queue Metrics",
        "period": 300,
        "yAxis": {
          "left": {
            "label": "Messages",
            "showUnits": false
          }
        }
      }
    },
    {
      "type": "metric",
      "properties": {
        "metrics": [
          [ "AWS/Events", "Invocations", { "stat": "Sum", "label": "EventBridge Rule Invocations" } ],
          [ ".", "FailedInvocations", { "stat": "Sum", "label": "EventBridge Failed Invocations" } ]
        ],
        "view": "timeSeries",
        "region": "us-west-2",
        "title": "EventBridge Rule Metrics",
        "period": 300
      }
    },
    {
      "type": "log",
      "properties": {
        "query": "SOURCE '/aws/lambda/isb-lease-costs-scheduler' | SOURCE '/aws/lambda/isb-lease-costs-collector' | fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 20",
        "region": "us-west-2",
        "title": "Recent Errors (Last 20)",
        "stacked": false,
        "view": "table"
      }
    }
  ]
}
```

#### Deploy Dashboard

```bash
aws cloudwatch put-dashboard \
  --dashboard-name ISBLeaseCosts \
  --dashboard-body file://cloudwatch-dashboard.json \
  --region us-west-2
```

#### Key Metrics to Monitor

| Metric | Normal Range | Alert Threshold | Troubleshooting |
|--------|--------------|-----------------|-----------------|
| **Scheduler Lambda Duration** | 500-2000ms | >5000ms | Check ISB Leases API latency, review logs for retry delays |
| **Collector Lambda Duration** | 5-30s (typical), up to 900s (large accounts) | >720s (12 min) | Check Cost Explorer pagination, verify account size, review rate limiting |
| **Scheduler Lambda Errors** | 0 | ≥3 in 5 min | Check LeaseTerminated event schema, verify ISB Leases API availability |
| **Collector Lambda Errors** | 0 | ≥1 | Check AssumeRole permissions, verify Cost Explorer access, review S3 permissions |
| **DLQ Message Count** | 0 | ≥1 | Investigate failed invocations, check alarm SNS notifications |
| **EventBridge Failed Invocations** | 0 | ≥1 | Verify Lambda permissions, check Lambda throttling, review target configuration |

### X-Ray Integration

X-Ray tracing is **enabled by default** on all Lambda functions. Use X-Ray to:

1. **Trace end-to-end request flow**:
   - LeaseTerminated event → Scheduler Lambda → EventBridge Scheduler → Cost Collector Lambda
   - View exact latency breakdown for each step

2. **Identify performance bottlenecks**:
   - Cost Explorer API pagination delays
   - ISB Leases API response times
   - S3 upload latency
   - STS AssumeRole overhead

3. **Debug cross-account issues**:
   - Trace AssumeRole calls to org management account
   - Verify Cost Explorer API permissions
   - Monitor credential expiration timing

#### View X-Ray Traces

**Console**:
```
https://console.aws.amazon.com/xray/home?region=us-west-2#/traces
```

**Filter by lease ID**:
```
annotation.leaseId = "550e8400-e29b-41d4-a716-446655440000"
```

**Find slow requests**:
```
responsetime > 30
```

**Find errors**:
```
error = true OR fault = true
```

#### X-Ray Service Map

The service map shows dependencies:

```
LeaseTerminated Event
    ↓
Scheduler Lambda
    ├─→ ISB Leases Lambda (invoke)
    └─→ EventBridge Scheduler (create schedule)
        ↓
Cost Collector Lambda
    ├─→ STS (AssumeRole)
    ├─→ Cost Explorer API (paginated queries)
    ├─→ S3 (PutObject + presigned URL)
    └─→ EventBridge (emit LeaseCostsGenerated)
```

#### Add Custom X-Ray Annotations

To add custom annotations for filtering (already implemented in code):

```typescript
import * as AWSXRay from 'aws-xray-sdk-core';

const segment = AWSXRay.getSegment();
segment?.addAnnotation('leaseId', leaseId);
segment?.addAnnotation('accountId', accountId);
segment?.addAnnotation('totalCost', totalCost);
```

### CloudWatch Business Metrics

> **Breaking Change (v2.0.0)**: The `ServiceCount` metric was renamed to `ResourceCount`. Update your dashboards and alarms accordingly.

The Cost Collector Lambda emits custom business metrics to the `ISB/Costs` namespace:

| Metric | Unit | Description |
|--------|------|-------------|
| `TotalCost` | None (USD) | Total cost for the billing period |
| `ResourceCount` | Count | Number of resources (rows in CSV) |
| `ProcessingDuration` | Seconds | Lambda execution time |

**Query metrics via CLI:**
```bash
aws cloudwatch get-metric-statistics \
  --namespace "ISB/Costs" \
  --metric-name "ResourceCount" \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 3600 \
  --statistics Average Maximum
```

**Migration from ServiceCount to ResourceCount:**
```bash
# Update CloudWatch alarms
aws cloudwatch put-metric-alarm \
  --alarm-name "HighResourceCount" \
  --namespace "ISB/Costs" \
  --metric-name "ResourceCount" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 1000 \
  --comparison-operator GreaterThanThreshold

# Note: ResourceCount values will be higher than ServiceCount
# (individual resources vs service aggregates)
```

### CloudWatch Alarms

The system includes 5 pre-configured CloudWatch alarms:

1. **Collector DLQ Alarm** (`isb-lease-costs-collector-dlq`)
   - Triggers when: ≥1 message in DLQ
   - Action: Sends email to `alertEmail`
   - Investigation: Check Lambda errors, review failed event payloads

2. **Scheduler Errors Alarm** (`isb-lease-costs-scheduler-errors`)
   - Triggers when: ≥3 errors in 5 minutes
   - Action: Sends email to `alertEmail`
   - Investigation: Check ISB Leases API availability, verify event schema

3. **Collector Errors Alarm** (`isb-lease-costs-collector-errors`)
   - Triggers when: ≥1 error
   - Action: Sends email to `alertEmail`
   - Investigation: Check AssumeRole permissions, Cost Explorer access

4. **Rule DLQ Alarm** (`isb-lease-costs-rule-dlq`)
   - Triggers when: ≥1 message in EventBridge rule DLQ
   - Action: Sends email to `alertEmail`
   - Investigation: Check Lambda target permissions, review event routing

5. **Collector Duration Alarm** (`isb-lease-costs-collector-duration`)
   - Triggers when: Duration >720s (12 min) for 2 consecutive periods
   - Action: Sends email to `alertEmail`
   - Investigation: Review account size (200+ services?), check Cost Explorer throttling

### Troubleshooting with Logs

**View Scheduler Lambda logs**:
```bash
aws logs tail /aws/lambda/isb-lease-costs-scheduler --follow
```

**View Collector Lambda logs**:
```bash
aws logs tail /aws/lambda/isb-lease-costs-collector --follow
```

**Search for specific lease**:
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/isb-lease-costs-collector \
  --filter-pattern "550e8400-e29b-41d4-a716-446655440000" \
  --start-time $(date -u -d '1 hour ago' +%s)000
```

**Count errors in last hour**:
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/isb-lease-costs-scheduler \
  --filter-pattern "ERROR" \
  --start-time $(date -u -d '1 hour ago' +%s)000 | \
  jq '.events | length'
```

## License

MIT
