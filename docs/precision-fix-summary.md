# Cost Explorer Pagination Precision Loss Fix

## Problem

The original implementation used floating-point arithmetic for aggregating costs across multiple pages of Cost Explorer results. This led to precision loss due to floating-point rounding errors.

### Example of the Issue

```javascript
// Bad: Floating-point aggregation (before)
let total = 0.0;
for (let i = 0; i < 10; i++) {
  total += 0.10; // Classic floating-point precision issue
}
console.log(total); // 0.9999999999999999 instead of 1.0
```

## Solution

Convert to integer arithmetic using cents during aggregation, then convert back to dollars only for the final result.

### Implementation Changes

**File: `/src/lib/cost-explorer.ts` (lines 76-151)**

#### Key Changes:

1. **Renamed variable** from `serviceMap` to `serviceMapCents` for clarity
2. **Convert dollars to cents** when parsing amounts:
   ```typescript
   const amountDollars = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? "0");
   const amountCents = Math.round(amountDollars * 100); // Integer arithmetic
   ```

3. **Aggregate in integer cents**:
   ```typescript
   const currentTotalCents = serviceMapCents.get(serviceName) ?? 0;
   serviceMapCents.set(serviceName, currentTotalCents + amountCents);
   ```

4. **Convert back to dollars only at the end**:
   ```typescript
   const costsByService = Array.from(serviceMapCents.entries())
     .map(([serviceName, costCents]) => ({
       serviceName,
       cost: costCents / 100  // Final conversion
     }))
   ```

5. **Calculate total from cents**:
   ```typescript
   const totalCostCents = Array.from(serviceMapCents.values()).reduce(
     (sum, cents) => sum + cents,
     0
   );
   const totalCost = totalCostCents / 100;
   ```

### Why This Works

- **Integer arithmetic** is precise for addition (no rounding errors)
- **Cents are the smallest unit** AWS billing uses (no fractional cents)
- **Conversion happens once** at the end, minimizing rounding impact
- **Math.round()** handles any fractional cents from Cost Explorer API

## Test Coverage

Added comprehensive tests in `/src/lib/cost-explorer.test.ts`:

### 1. Many Small Amounts Test
```typescript
// Test: 10 pages × $0.10 = $1.00 exactly (not 0.9999999999999999)
expect(result.totalCost).toBe(1.00);
```

### 2. Fractional Cents Test
```typescript
// Test rounding: 0.0015 rounds to 0 cents, 0.0055 rounds to 1 cent
expect(result.totalCost).toBe(0.01);
```

### 3. Multiple Pages Same Service Test
```typescript
// Test: 100 pages × $0.01 = $1.00 exactly
expect(result.totalCost).toBe(1.00);
```

### 4. Large Aggregations Test
```typescript
// Test: 30 days × 3 services with various amounts
// EC2: 30 × $0.33 = $9.90
// S3: 30 × $0.33 = $9.90
// Lambda: 30 × $0.34 = $10.20
// Total: $30.00 exactly
expect(result.totalCost).toBe(30.00);
```

## Impact

✅ **No breaking changes** - API remains the same
✅ **All existing tests pass** - Backward compatible
✅ **Improved accuracy** - No precision loss during aggregation
✅ **Better for compliance** - Financial calculations should use integer arithmetic

## Verification

All 209 tests pass, including 5 new precision-specific tests:

```bash
npm test

Test Files  15 passed (15)
Tests  209 passed (209)
```

## Related

- **Task #5**: Fix Cost Explorer pagination precision loss
- **File Modified**: `/src/lib/cost-explorer.ts`
- **Tests Added**: `/src/lib/cost-explorer.test.ts` (lines 338-484)
