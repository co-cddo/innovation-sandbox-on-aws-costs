import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sanitizeResourceName,
  sanitizeServiceName,
  sanitizeRegion,
  validateCostAmount,
} from "./validation-utils.js";

describe("sanitizeResourceName", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("should preserve valid ARNs", () => {
    const arn =
      "arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0";
    expect(sanitizeResourceName(arn)).toBe(arn);
  });

  it("should preserve simple resource names", () => {
    expect(sanitizeResourceName("my-bucket")).toBe("my-bucket");
    expect(sanitizeResourceName("i-1234567890abcdef0")).toBe(
      "i-1234567890abcdef0"
    );
  });

  it("should remove ANSI escape codes", () => {
    const malicious = "\x1B[31marn:aws:s3:::my-bucket\x1B[0m";
    expect(sanitizeResourceName(malicious)).toBe("arn:aws:s3:::my-bucket");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("should truncate extremely long resource names", () => {
    const longName = "a".repeat(3000);
    const result = sanitizeResourceName(longName);
    expect(result.length).toBeLessThanOrEqual(2048);
    expect(result).toContain("[truncated]");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("should remove null bytes", () => {
    const withNull = "resource\x00name";
    expect(sanitizeResourceName(withNull)).toBe("resourcename");
  });

  it("should preserve tabs and newlines (handled by CSV escaping)", () => {
    const withWhitespace = "resource\tname\nline2";
    expect(sanitizeResourceName(withWhitespace)).toBe("resource\tname\nline2");
  });

  it("should handle empty string", () => {
    expect(sanitizeResourceName("")).toBe("");
  });

  it("should preserve Unicode characters", () => {
    const unicode = "resource-\u2665-name";
    expect(sanitizeResourceName(unicode)).toBe(unicode);
  });
});

describe("sanitizeServiceName", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("should preserve valid service names", () => {
    expect(sanitizeServiceName("Amazon EC2")).toBe("Amazon EC2");
    expect(sanitizeServiceName("AWS Lambda")).toBe("AWS Lambda");
    expect(sanitizeServiceName("Amazon Simple Storage Service")).toBe(
      "Amazon Simple Storage Service"
    );
  });

  it("should truncate long service names", () => {
    const longName = "A".repeat(300);
    const result = sanitizeServiceName(longName);
    expect(result.length).toBe(256);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("should remove control characters", () => {
    const withControl = "Amazon\x00EC2";
    expect(sanitizeServiceName(withControl)).toBe("AmazonEC2");
  });
});

describe("sanitizeRegion", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("should accept valid AWS regions", () => {
    expect(sanitizeRegion("us-east-1")).toBe("us-east-1");
    expect(sanitizeRegion("eu-west-1")).toBe("eu-west-1");
    expect(sanitizeRegion("ap-southeast-2")).toBe("ap-southeast-2");
    expect(sanitizeRegion("sa-east-1")).toBe("sa-east-1");
  });

  it("should accept global region", () => {
    expect(sanitizeRegion("global")).toBe("global");
  });

  it("should trim whitespace", () => {
    expect(sanitizeRegion("  us-east-1  ")).toBe("us-east-1");
  });

  it("should default invalid regions to global", () => {
    expect(sanitizeRegion("invalid")).toBe("global");
    expect(sanitizeRegion("US-EAST-1")).toBe("global"); // uppercase
    expect(sanitizeRegion("us_east_1")).toBe("global"); // underscores
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("should default empty string to global", () => {
    expect(sanitizeRegion("")).toBe("global");
    expect(sanitizeRegion("   ")).toBe("global");
  });
});

describe("validateCostAmount", () => {
  it("should accept valid cost strings", () => {
    expect(validateCostAmount("0")).toBe("0");
    expect(validateCostAmount("123.45")).toBe("123.45");
    expect(validateCostAmount("0.0000005793")).toBe("0.0000005793");
    expect(validateCostAmount("9999999999.99")).toBe("9999999999.99");
  });

  it("should accept negative costs (credits/refunds)", () => {
    expect(validateCostAmount("-10.50")).toBe("-10.50");
  });

  it("should accept integer costs", () => {
    expect(validateCostAmount("100")).toBe("100");
  });

  it("should reject costs exceeding max length", () => {
    const longCost = "1".repeat(60);
    expect(() => validateCostAmount(longCost)).toThrow(
      "exceeds maximum length"
    );
  });

  it("should reject invalid cost formats", () => {
    expect(() => validateCostAmount("abc")).toThrow("Invalid cost amount format");
    expect(() => validateCostAmount("12.34.56")).toThrow(
      "Invalid cost amount format"
    );
    expect(() => validateCostAmount("$123.45")).toThrow(
      "Invalid cost amount format"
    );
    expect(() => validateCostAmount("123,456.78")).toThrow(
      "Invalid cost amount format"
    );
  });

  it("should reject Infinity", () => {
    expect(() => validateCostAmount("Infinity")).toThrow(
      "Invalid cost amount format"
    );
  });

  it("should reject NaN", () => {
    expect(() => validateCostAmount("NaN")).toThrow("Invalid cost amount format");
  });
});
