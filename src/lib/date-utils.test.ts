import { describe, it, expect } from "vitest";
import { calculateBillingWindow } from "./date-utils.js";

describe("calculateBillingWindow", () => {
  it("should calculate window with standard timestamps and 8hr padding", () => {
    const result = calculateBillingWindow(
      "2026-01-15T10:00:00Z",
      "2026-02-02T15:00:00Z",
      8
    );
    // Start: 10:00 - 8hr = 02:00 same day → round down to 00:00 = 2026-01-15
    // End: 15:00 + 8hr = 23:00 same day → round up to next day = 2026-02-03
    expect(result.startDate).toBe("2026-01-15");
    expect(result.endDate).toBe("2026-02-03");
  });

  it("should round start to previous day when padding crosses midnight", () => {
    const result = calculateBillingWindow(
      "2026-01-15T02:00:00Z",
      "2026-02-02T02:00:00Z",
      8
    );
    // Start: 02:00 - 8hr = 18:00 previous day (Jan 14) → round down = 2026-01-14
    // End: 02:00 + 8hr = 10:00 same day → round up to next day = 2026-02-03
    expect(result.startDate).toBe("2026-01-14");
    expect(result.endDate).toBe("2026-02-03");
  });

  it("should handle zero padding", () => {
    const result = calculateBillingWindow(
      "2026-01-15T10:00:00Z",
      "2026-02-02T15:00:00Z",
      0
    );
    // Start: 10:00 - 0hr = 10:00 → round down to 00:00 = 2026-01-15
    // End: 15:00 + 0hr = 15:00 → round up to next day = 2026-02-03
    expect(result.startDate).toBe("2026-01-15");
    expect(result.endDate).toBe("2026-02-03");
  });

  it("should handle timezone-aware input (negative offset)", () => {
    // 2026-02-02T15:30:00-08:00 = 2026-02-02T23:30:00Z
    const result = calculateBillingWindow(
      "2026-01-15T10:00:00-08:00", // = 2026-01-15T18:00:00Z
      "2026-02-02T15:30:00-08:00", // = 2026-02-02T23:30:00Z
      8
    );
    // Start UTC: 18:00 - 8hr = 10:00 → round down = 2026-01-15
    // End UTC: 23:30 + 8hr = 07:30 next day → round up = 2026-02-04
    expect(result.startDate).toBe("2026-01-15");
    expect(result.endDate).toBe("2026-02-04");
  });

  it("should handle UTC input explicitly", () => {
    const result = calculateBillingWindow(
      "2026-01-15T00:00:00Z",
      "2026-02-02T00:00:00Z",
      8
    );
    // Start: 00:00 - 8hr = 16:00 previous day → round down = 2026-01-14
    // End: 00:00 + 8hr = 08:00 same day → round up to next day = 2026-02-03
    expect(result.startDate).toBe("2026-01-14");
    expect(result.endDate).toBe("2026-02-03");
  });

  it("should handle end already at midnight", () => {
    const result = calculateBillingWindow(
      "2026-01-15T10:00:00Z",
      "2026-02-02T16:00:00Z", // +8hr = 00:00:00 on Feb 3
      8
    );
    // End: 16:00 + 8hr = 00:00 Feb 3 (already at midnight)
    expect(result.endDate).toBe("2026-02-03");
  });

  it("should throw on invalid leaseStartDate", () => {
    expect(() =>
      calculateBillingWindow("invalid-date", "2026-02-02T15:00:00Z", 8)
    ).toThrow("Invalid leaseStartDate: invalid-date");
  });

  it("should throw on invalid leaseEndTimestamp", () => {
    expect(() =>
      calculateBillingWindow("2026-01-15T10:00:00Z", "not-a-date", 8)
    ).toThrow("Invalid leaseEndTimestamp: not-a-date");
  });

  // Boundary edge cases
  describe("date boundaries", () => {
    it("should handle leap year February (2024-02-28 → 2024-02-29)", () => {
      // 2024 is a leap year
      const result = calculateBillingWindow(
        "2024-02-28T20:00:00Z",
        "2024-02-29T04:00:00Z",
        8
      );
      // Start: 20:00 - 8hr = 12:00 → round down = 2024-02-28
      // End: 04:00 + 8hr = 12:00 → round up = 2024-03-01
      expect(result.startDate).toBe("2024-02-28");
      expect(result.endDate).toBe("2024-03-01");
    });

    it("should handle non-leap year February (2025-02-28 → 2025-03-01)", () => {
      // 2025 is not a leap year, Feb has 28 days
      const result = calculateBillingWindow(
        "2025-02-28T20:00:00Z",
        "2025-03-01T04:00:00Z",
        8
      );
      // Start: 20:00 - 8hr = 12:00 → round down = 2025-02-28
      // End: 04:00 + 8hr = 12:00 → round up = 2025-03-02
      expect(result.startDate).toBe("2025-02-28");
      expect(result.endDate).toBe("2025-03-02");
    });

    it("should handle month boundary (Jan 31 → Feb 1)", () => {
      const result = calculateBillingWindow(
        "2026-01-31T20:00:00Z",
        "2026-02-01T04:00:00Z",
        8
      );
      // Start: 20:00 - 8hr = 12:00 → round down = 2026-01-31
      // End: 04:00 + 8hr = 12:00 → round up = 2026-02-02
      expect(result.startDate).toBe("2026-01-31");
      expect(result.endDate).toBe("2026-02-02");
    });

    it("should handle year boundary (Dec 31 → Jan 1)", () => {
      const result = calculateBillingWindow(
        "2025-12-31T20:00:00Z",
        "2026-01-01T04:00:00Z",
        8
      );
      // Start: 20:00 - 8hr = 12:00 → round down = 2025-12-31
      // End: 04:00 + 8hr = 12:00 → round up = 2026-01-02
      expect(result.startDate).toBe("2025-12-31");
      expect(result.endDate).toBe("2026-01-02");
    });

    it("should handle padding crossing year boundary", () => {
      const result = calculateBillingWindow(
        "2026-01-01T02:00:00Z",  // Start padding crosses to Dec 31
        "2026-01-01T20:00:00Z",
        8
      );
      // Start: 02:00 - 8hr = 18:00 Dec 31 → round down = 2025-12-31
      // End: 20:00 + 8hr = 04:00 Jan 2 → round up to next day = 2026-01-03
      expect(result.startDate).toBe("2025-12-31");
      expect(result.endDate).toBe("2026-01-03");
    });

    describe("DST transitions", () => {
      it("should handle US spring forward DST transition (March)", () => {
        // US DST 2026: Spring forward on Sunday, March 8 at 2:00 AM → 3:00 AM
        // Test a lease that crosses this transition in US Eastern Time
        // March 8, 2026 01:00 EST (UTC-5) = 06:00 UTC (before DST)
        // March 8, 2026 03:00 EDT (UTC-4) = 07:00 UTC (after DST - 2 AM never exists)

        const result = calculateBillingWindow(
          "2026-03-08T01:00:00-05:00", // 06:00 UTC, before spring forward
          "2026-03-08T03:00:00-04:00", // 07:00 UTC, after spring forward
          8
        );

        // Start UTC: 06:00 - 8hr = 22:00 March 7 → round down = 2026-03-07
        // End UTC: 07:00 + 8hr = 15:00 March 8 → round up = 2026-03-09
        expect(result.startDate).toBe("2026-03-07");
        expect(result.endDate).toBe("2026-03-09");
      });

      it("should handle US fall back DST transition (November)", () => {
        // US DST 2025: Fall back on Sunday, November 2 at 2:00 AM → 1:00 AM
        // Test a lease that crosses this transition in US Eastern Time
        // November 2, 2025 01:00 EDT (UTC-4) = 05:00 UTC (before fall back)
        // November 2, 2025 01:00 EST (UTC-5) = 06:00 UTC (after fall back - 1 AM occurs twice)

        const result = calculateBillingWindow(
          "2025-11-02T01:00:00-04:00", // 05:00 UTC, before fall back
          "2025-11-02T01:00:00-05:00", // 06:00 UTC, after fall back (1 AM second occurrence)
          8
        );

        // Start UTC: 05:00 - 8hr = 21:00 November 1 → round down = 2025-11-01
        // End UTC: 06:00 + 8hr = 14:00 November 2 → round up = 2025-11-03
        expect(result.startDate).toBe("2025-11-01");
        expect(result.endDate).toBe("2025-11-03");
      });

      it("should handle European spring forward DST transition (March)", () => {
        // European DST 2026: Spring forward on Sunday, March 29 at 1:00 AM → 2:00 AM
        // Test with Central European Time (CET/CEST)
        // March 29, 2026 00:30 CET (UTC+1) = 23:30 UTC March 28
        // March 29, 2026 02:30 CEST (UTC+2) = 00:30 UTC March 29

        const result = calculateBillingWindow(
          "2026-03-29T00:30:00+01:00", // 23:30 UTC March 28
          "2026-03-29T02:30:00+02:00", // 00:30 UTC March 29
          8
        );

        // Start UTC: 23:30 March 28 - 8hr = 15:30 March 28 → round down = 2026-03-28
        // End UTC: 00:30 March 29 + 8hr = 08:30 March 29 → round up = 2026-03-30
        expect(result.startDate).toBe("2026-03-28");
        expect(result.endDate).toBe("2026-03-30");
      });

      it("should handle European fall back DST transition (October)", () => {
        // European DST 2025: Fall back on Sunday, October 26 at 3:00 AM → 2:00 AM
        // Test with Central European Time (CET/CEST)
        // October 26, 2025 02:30 CEST (UTC+2) = 00:30 UTC (before fall back)
        // October 26, 2025 02:30 CET (UTC+1) = 01:30 UTC (after fall back - 2 AM occurs twice)

        const result = calculateBillingWindow(
          "2025-10-26T02:30:00+02:00", // 00:30 UTC
          "2025-10-26T02:30:00+01:00", // 01:30 UTC (same local time, different UTC due to DST)
          8
        );

        // Start UTC: 00:30 - 8hr = 16:30 October 25 → round down = 2025-10-25
        // End UTC: 01:30 + 8hr = 09:30 October 26 → round up = 2025-10-27
        expect(result.startDate).toBe("2025-10-25");
        expect(result.endDate).toBe("2025-10-27");
      });

      it("should handle lease spanning multiple weeks including DST transition", () => {
        // Lease starts before spring forward, ends after
        // Start: March 1, 2026 10:00 EST (UTC-5) = 15:00 UTC
        // End: March 15, 2026 10:00 EDT (UTC-4) = 14:00 UTC
        // DST transition on March 8

        const result = calculateBillingWindow(
          "2026-03-01T10:00:00-05:00", // 15:00 UTC
          "2026-03-15T10:00:00-04:00", // 14:00 UTC
          8
        );

        // Start UTC: 15:00 - 8hr = 07:00 March 1 → round down = 2026-03-01
        // End UTC: 14:00 + 8hr = 22:00 March 15 → round up = 2026-03-16
        expect(result.startDate).toBe("2026-03-01");
        expect(result.endDate).toBe("2026-03-16");
      });

      it("should handle pure UTC timestamps across DST (no timezone offset)", () => {
        // When using pure UTC timestamps, DST doesn't affect calculation
        // Even though local time zones may have DST transitions,
        // UTC remains constant and calculations are predictable

        const result = calculateBillingWindow(
          "2026-03-08T06:00:00Z", // During US spring forward (in local time)
          "2026-03-08T07:00:00Z", // After spring forward (in local time)
          8
        );

        // Start UTC: 06:00 - 8hr = 22:00 March 7 → round down = 2026-03-07
        // End UTC: 07:00 + 8hr = 15:00 March 8 → round up = 2026-03-09
        expect(result.startDate).toBe("2026-03-07");
        expect(result.endDate).toBe("2026-03-09");
      });

      it("should handle padding that crosses DST boundary in local time", () => {
        // Start time is before DST, but with padding crosses into DST
        // March 8, 2026 07:00 EST (UTC-5) = 12:00 UTC
        // Padding: 12:00 - 8hr = 04:00 UTC = 23:00 EST March 7 (before DST)

        const result = calculateBillingWindow(
          "2026-03-08T07:00:00-05:00", // 12:00 UTC
          "2026-03-08T15:00:00-04:00", // 19:00 UTC (in EDT after DST)
          8
        );

        // Start UTC: 12:00 - 8hr = 04:00 → round down = 2026-03-08
        // End UTC: 19:00 + 8hr = 03:00 March 9 → round up = 2026-03-10
        expect(result.startDate).toBe("2026-03-08");
        expect(result.endDate).toBe("2026-03-10");
      });
    });
  });
});
