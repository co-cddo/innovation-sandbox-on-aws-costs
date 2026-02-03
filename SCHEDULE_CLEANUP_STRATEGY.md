# EventBridge Scheduler Cleanup Strategy

## Overview

This document describes the three-layer cleanup strategy for EventBridge Scheduler schedules to prevent unbounded schedule growth.

## Problem

Previously, schedules were created with `ActionAfterCompletion: NONE`, requiring manual deletion by the Cost Collector Lambda. This could lead to orphaned schedules if:
- The Lambda failed before reaching the cleanup step
- Race conditions occurred during concurrent executions
- EventBridge Scheduler service issues prevented invocation

## Solution: Three-Layer Cleanup Strategy

### Layer 1: Auto-Delete (Primary)

**Location**: `src/lambdas/scheduler-handler.ts:123`

Schedules are now created with `ActionAfterCompletion: DELETE`, which automatically deletes the schedule after successful execution.

```typescript
ActionAfterCompletion: ActionAfterCompletion.DELETE, // Auto-delete after successful execution
```

**Benefits**:
- Zero maintenance overhead
- Immediate cleanup after execution
- No Lambda permissions required
- Handles the 99% case

**Limitations**:
- Only deletes after successful invocation
- Doesn't handle Lambda failures before completion
- Service issues could prevent deletion

### Layer 2: Manual Delete (Fallback)

**Location**: `src/lambdas/cost-collector-handler.ts:156-175`

The Cost Collector Lambda attempts to manually delete the schedule after completing cost collection.

```typescript
// 9. Delete the scheduler schedule (best-effort fallback)
// Note: Schedules are configured with ActionAfterCompletion=DELETE for automatic cleanup.
// This manual deletion serves as a fallback in case of race conditions or failures.
// Orphaned schedules are also cleaned up by a daily maintenance Lambda.
try {
  await schedulerClient.send(
    new DeleteScheduleCommand({
      Name: scheduleName,
      GroupName: SCHEDULER_GROUP,
    })
  );
  console.log(`Deleted schedule ${scheduleName}`);
} catch (error) {
  if (error instanceof ResourceNotFoundException) {
    // Expected case: schedule already auto-deleted by EventBridge Scheduler
    console.log(
      `Schedule ${scheduleName} already deleted (likely auto-deleted after execution)`
    );
  } else {
    // Log but don't fail - cleanup is best-effort, daily Lambda will handle orphans
    console.error(`Failed to delete schedule ${scheduleName}:`, error);
  }
}
```

**Benefits**:
- Provides redundancy
- Handles edge cases where auto-delete fails
- Logs provide visibility into cleanup behavior

**Limitations**:
- Requires IAM permissions
- May encounter ResourceNotFoundException (expected due to Layer 1)
- Best-effort only (doesn't fail the Lambda)

### Layer 3: Daily Cleanup Lambda (Safety Net)

**Location**: `src/lambdas/cleanup-handler.ts`

A dedicated Lambda runs daily at 2 AM UTC to remove any orphaned schedules.

**Configuration**:
- Triggered by EventBridge cron rule: `cron(0 2 * * ? *)`
- Timeout: 5 minutes
- Memory: 256 MB
- Max schedule age: 72 hours

**Algorithm**:
1. List all schedules in the group (with pagination)
2. Parse schedule execution time from `at()` expressions
3. Identify schedules scheduled more than 72 hours ago
4. Delete stale schedules with best-effort error handling
5. Log metrics for observability

**Benefits**:
- Catches all orphaned schedules regardless of cause
- Provides audit trail via CloudWatch Logs
- Independent of cost collection workflow
- Handles bulk cleanup efficiently

**Observability**:
```
Starting cleanup of stale schedules in group isb-lease-costs (max age: 72h)
Found 150 total schedules (list operation took 45ms)
Found 3 stale schedules to clean up (2.0% of total)
Cleanup completed in 12ms: deleted=3, already_deleted=0, failed=0, total_processed=3
Sample of deleted schedules (3/3): lease-costs-abc, lease-costs-def, lease-costs-ghi
```

## IAM Permissions

### Scheduler Lambda
- `scheduler:CreateSchedule` - Create one-time schedules
- `iam:PassRole` - Pass execution role to EventBridge Scheduler

### Cost Collector Lambda
- `scheduler:DeleteSchedule` - Delete own schedule (best-effort)
- Resource: `arn:aws:scheduler:${region}:${accountId}:schedule/${group}/lease-costs-*`

### Cleanup Lambda
- `scheduler:ListSchedules` - List all schedules in group
- `scheduler:DeleteSchedule` - Delete orphaned schedules
- Resource: `arn:aws:scheduler:${region}:${accountId}:schedule/${group}/lease-costs-*`

## Monitoring

### CloudWatch Metrics (Recommended)
Monitor the effectiveness of the cleanup strategy:

1. **Schedule Count** (from CloudWatch Logs Insights):
```
fields @timestamp, @message
| filter @message like /Found \d+ total schedules/
| parse @message /Found (?<total>\d+) total schedules/
| stats max(total) as max_schedules by bin(5m)
```

2. **Stale Schedule Rate**:
```
fields @timestamp, @message
| filter @message like /Found \d+ stale schedules/
| parse @message /Found (?<stale>\d+) stale schedules to clean up \((?<percent>[\d.]+)% of total\)/
| stats avg(percent) as avg_stale_percent by bin(1d)
```

3. **Cleanup Failures**:
```
fields @timestamp, @message
| filter @message like /Failed to delete/
| count()
```

### Alarms
Consider creating CloudWatch Alarms for:

- **High Stale Schedule Rate**: Alert if >10% of schedules are stale
- **Cleanup Failures**: Alert if cleanup Lambda fails 3+ times in 24h
- **Schedule Growth**: Alert if total schedules exceed 1000

## Testing

### Unit Tests
- `src/lambdas/cleanup-handler.test.ts` (14 tests)
  - Stale schedule detection
  - Pagination handling
  - Error scenarios (ResourceNotFoundException, service errors)
  - Boundary cases (exactly 72 hours)

- `src/lambdas/scheduler-handler.test.ts` (13 tests)
  - Verifies `ActionAfterCompletion: DELETE`

- `src/lambdas/cost-collector-handler.test.ts` (18 tests)
  - Manual deletion handling
  - ResourceNotFoundException (expected from auto-delete)

### Infrastructure Tests
- `infra/lib/constructs/cost-collector-function.test.ts` (28 tests)
  - Cleanup Lambda configuration
  - IAM permissions
  - EventBridge rule (daily at 2 AM UTC)

## Deployment

The cleanup Lambda is deployed automatically as part of the `CostCollectorFunction` construct.

**Infrastructure**: `infra/lib/constructs/cost-collector-function.ts`
- Cleanup Lambda definition
- EventBridge cron rule
- IAM policies

**Outputs**:
- `CleanupLambdaArn` - ARN of the cleanup Lambda

## Cost Impact

### Compute
- Cleanup Lambda: ~1 invocation/day × 5s × 256MB = $0.0000002/day
- Annual cost: ~$0.00007/year

### API Calls
- ListSchedules: 1 call/day (free tier: 1M/month)
- DeleteSchedule: ~0-10 calls/day (free tier: 1M/month)
- Annual cost: $0 (within free tier)

**Total Additional Cost**: ~$0.00007/year (negligible)

## Trade-offs

### Why 72 Hours?
- Typical delay: 24-48 hours
- Buffer for edge cases: 24 hours
- Total: 72 hours = 3 days
- Balance between storage cost and safety margin

### Why Daily Cleanup?
- Hourly: Unnecessary overhead, schedules are long-lived
- Weekly: Too slow, could accumulate hundreds of orphans
- Daily: Optimal balance of cleanup speed and Lambda costs

## Failure Scenarios

### Scenario 1: Lambda Fails Before Completion
- **Layer 1**: ❌ Schedule not invoked, no auto-delete
- **Layer 2**: ❌ Manual delete not reached
- **Layer 3**: ✅ Cleanup Lambda deletes after 72 hours

### Scenario 2: EventBridge Scheduler Service Issue
- **Layer 1**: ❌ Service issue prevents auto-delete
- **Layer 2**: ✅ Manual delete succeeds
- **Layer 3**: ✅ Cleanup Lambda as backup

### Scenario 3: Race Condition (Concurrent Executions)
- **Layer 1**: ✅ Auto-delete on first completion
- **Layer 2**: ⚠️ ResourceNotFoundException (expected, logged as info)
- **Layer 3**: ✅ Cleanup Lambda as backup

## Migration

No migration required. The new cleanup strategy is backward-compatible:
- Existing schedules with `NONE` will be cleaned by Layer 3
- New schedules use `DELETE` immediately
- No data loss or downtime

## Verification

After deployment, verify the cleanup strategy:

1. **Check Cleanup Lambda exists**:
```bash
aws lambda list-functions --query 'Functions[?FunctionName==`isb-lease-costs-cleanup`]'
```

2. **Check EventBridge rule**:
```bash
aws events describe-rule --name isb-lease-costs-cleanup-daily
```

3. **Manually trigger cleanup** (for testing):
```bash
aws lambda invoke \
  --function-name isb-lease-costs-cleanup \
  --payload '{}' \
  /dev/stdout
```

4. **Check schedule action**:
```bash
aws scheduler get-schedule \
  --name lease-costs-<uuid> \
  --group-name isb-lease-costs \
  --query 'ActionAfterCompletion'
# Should return: "DELETE"
```

## References

- [EventBridge Scheduler ActionAfterCompletion](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html#one-time)
- [EventBridge Scheduler Best Practices](https://docs.aws.amazon.com/scheduler/latest/UserGuide/best-practices.html)
- Task #4: Fix scheduler Lambda unbounded schedules
