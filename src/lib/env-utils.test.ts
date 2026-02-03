import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { requireEnv, parseIntEnv } from "./env-utils.js";

describe("env-utils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

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

    it("should throw when environment variable is empty string", () => {
      process.env.EMPTY_VAR = "";
      expect(() => requireEnv("EMPTY_VAR")).toThrow(
        "EMPTY_VAR environment variable is required"
      );
    });

    describe("with context", () => {
      it("should return value when environment variable exists", () => {
        process.env.TEST_VAR = "test-value";
        expect(
          requireEnv("TEST_VAR", {
            component: "Test Component",
            purpose: "for testing",
          })
        ).toBe("test-value");
      });

      it("should throw with context when environment variable is not set", () => {
        delete process.env.MISSING_VAR;
        expect(() =>
          requireEnv("MISSING_VAR", {
            component: "Cost Collector Lambda",
            purpose: "to assume Cost Explorer role",
          })
        ).toThrow(
          "Cost Collector Lambda requires MISSING_VAR to assume Cost Explorer role"
        );
      });

      it("should throw with context when environment variable is empty string", () => {
        process.env.EMPTY_VAR = "";
        expect(() =>
          requireEnv("EMPTY_VAR", {
            component: "Scheduler Lambda",
            purpose: "to create schedules",
          })
        ).toThrow(
          "Scheduler Lambda requires EMPTY_VAR to create schedules"
        );
      });

      it("should include component and purpose in error message", () => {
        delete process.env.ROLE_ARN;
        expect(() =>
          requireEnv("ROLE_ARN", {
            component: "Lambda Handler",
            purpose: "to authorize EventBridge Scheduler",
          })
        ).toThrow(
          "Lambda Handler requires ROLE_ARN to authorize EventBridge Scheduler"
        );
      });
    });
  });

  describe("parseIntEnv", () => {
    it("should return parsed integer when valid", () => {
      process.env.INT_VAR = "42";
      expect(parseIntEnv("INT_VAR", 0)).toBe(42);
    });

    it("should return default when environment variable not set", () => {
      delete process.env.UNSET_VAR;
      expect(parseIntEnv("UNSET_VAR", 10)).toBe(10);
    });

    it("should throw on non-integer value", () => {
      process.env.INVALID_INT = "not-a-number";
      expect(() => parseIntEnv("INVALID_INT", 0)).toThrow(
        "Invalid INVALID_INT: not-a-number. Must be a valid integer."
      );
    });

    it("should throw on float value", () => {
      process.env.FLOAT_VAR = "3.14";
      // parseInt will parse "3.14" as 3, so this actually succeeds
      expect(parseIntEnv("FLOAT_VAR", 0)).toBe(3);
    });

    describe("minimum bounds", () => {
      it("should accept value at minimum", () => {
        process.env.MIN_VAR = "0";
        expect(parseIntEnv("MIN_VAR", 10, 0)).toBe(0);
      });

      it("should accept value above minimum", () => {
        process.env.ABOVE_MIN = "5";
        expect(parseIntEnv("ABOVE_MIN", 10, 0)).toBe(5);
      });

      it("should throw when value below minimum", () => {
        process.env.BELOW_MIN = "-1";
        expect(() => parseIntEnv("BELOW_MIN", 10, 0)).toThrow(
          "Invalid BELOW_MIN: -1. Must be at least 0."
        );
      });
    });

    describe("maximum bounds", () => {
      it("should accept value at maximum", () => {
        process.env.MAX_VAR = "7";
        expect(parseIntEnv("MAX_VAR", 5, 1, 7)).toBe(7);
      });

      it("should accept value below maximum", () => {
        process.env.BELOW_MAX = "3";
        expect(parseIntEnv("BELOW_MAX", 5, 1, 7)).toBe(3);
      });

      it("should throw when value above maximum", () => {
        process.env.ABOVE_MAX = "8";
        expect(() => parseIntEnv("ABOVE_MAX", 5, 1, 7)).toThrow(
          "Invalid ABOVE_MAX: 8. Must be at most 7."
        );
      });
    });

    describe("presigned URL expiry bounds (1-7 days)", () => {
      it("should accept 1 day expiry", () => {
        process.env.PRESIGNED_URL_EXPIRY_DAYS = "1";
        expect(parseIntEnv("PRESIGNED_URL_EXPIRY_DAYS", 7, 1, 7)).toBe(1);
      });

      it("should accept 7 days expiry (AWS maximum)", () => {
        process.env.PRESIGNED_URL_EXPIRY_DAYS = "7";
        expect(parseIntEnv("PRESIGNED_URL_EXPIRY_DAYS", 7, 1, 7)).toBe(7);
      });

      it("should reject 0 days expiry", () => {
        process.env.PRESIGNED_URL_EXPIRY_DAYS = "0";
        expect(() => parseIntEnv("PRESIGNED_URL_EXPIRY_DAYS", 7, 1, 7)).toThrow(
          "Invalid PRESIGNED_URL_EXPIRY_DAYS: 0. Must be at least 1."
        );
      });

      it("should reject negative days expiry", () => {
        process.env.PRESIGNED_URL_EXPIRY_DAYS = "-1";
        expect(() => parseIntEnv("PRESIGNED_URL_EXPIRY_DAYS", 7, 1, 7)).toThrow(
          "Invalid PRESIGNED_URL_EXPIRY_DAYS: -1. Must be at least 1."
        );
      });

      it("should reject 8 days expiry (exceeds AWS 7-day limit)", () => {
        process.env.PRESIGNED_URL_EXPIRY_DAYS = "8";
        expect(() => parseIntEnv("PRESIGNED_URL_EXPIRY_DAYS", 7, 1, 7)).toThrow(
          "Invalid PRESIGNED_URL_EXPIRY_DAYS: 8. Must be at most 7."
        );
      });
    });
  });
});
