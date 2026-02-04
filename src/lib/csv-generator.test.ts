import { describe, it, expect } from "vitest";
import { parse } from "csv-parse/sync";
import { generateCsv, generateCsvWithResources } from "./csv-generator.js";
import type { CostReport, CostReportWithResources } from "../types.js";

type CsvRecord = { Service: string; Cost: string };
type ResourceCsvRecord = { "Resource Name": string; Service: string; Region: string; Cost: string };

describe("generateCsv", () => {
  it("should generate CSV with header and services in order", () => {
    // costsByService is expected to be pre-sorted by cost-explorer.ts
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 150.0,
      costsByService: [
        { serviceName: "Amazon EC2", cost: 100.0 }, // Pre-sorted: highest first
        { serviceName: "Amazon S3", cost: 50.0 },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[0]).toBe("Service,Cost");
    expect(lines[1]).toBe("Amazon EC2,100.00");
    expect(lines[2]).toBe("Amazon S3,50.00");
    expect(lines.length).toBe(3);
  });

  it("should return header only for empty costsByService", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 0,
      costsByService: [],
    };

    const csv = generateCsv(report);
    expect(csv).toBe("Service,Cost");
  });

  it("should escape service names with commas", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 25.0,
      costsByService: [
        { serviceName: "Amazon EC2, Other", cost: 25.0 },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('"Amazon EC2, Other",25.00');
  });

  it("should escape service names with quotes", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 30.0,
      costsByService: [
        { serviceName: 'Service "Pro"', cost: 30.0 },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    // Quotes are doubled and value is wrapped in quotes
    expect(lines[1]).toBe('"Service ""Pro""",30.00');
  });

  it("should escape service names with newlines", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 40.0,
      costsByService: [
        { serviceName: "Service\nLine2", cost: 40.0 },
      ],
    };

    const csv = generateCsv(report);
    // Can't split on \n since the value contains a newline
    // Instead check the full output
    expect(csv).toBe('Service,Cost\n"Service\nLine2",40.00');
  });

  it("should preserve order of pre-sorted services", () => {
    // costsByService is expected to be pre-sorted by cost-explorer.ts
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 300.0,
      costsByService: [
        { serviceName: "EC2", cost: 200.0 },   // Pre-sorted by cost descending
        { serviceName: "S3", cost: 50.0 },
        { serviceName: "RDS", cost: 40.0 },
        { serviceName: "Lambda", cost: 10.0 },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("EC2,200.00");
    expect(lines[2]).toBe("S3,50.00");
    expect(lines[3]).toBe("RDS,40.00");
    expect(lines[4]).toBe("Lambda,10.00");
  });

  it("should format costs to 2 decimal places", () => {
    const report: CostReport = {
      accountId: "123456789012",
      startDate: "2026-01-15",
      endDate: "2026-02-03",
      totalCost: 10.5,
      costsByService: [
        { serviceName: "Service1", cost: 10.5 },
      ],
    };

    const csv = generateCsv(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("Service1,10.50");
  });

  describe("CSV roundtrip validation", () => {
    it("should generate CSV that can be parsed back correctly", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 150.5,
        costsByService: [
          { serviceName: "EC2", cost: 100.0 },
          { serviceName: "Service, with comma", cost: 50.5 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(2);
      expect(records[0].Service).toBe("EC2");
      expect(records[0].Cost).toBe("100.00");
      expect(records[1].Service).toBe("Service, with comma"); // Parsed correctly
      expect(records[1].Cost).toBe("50.50");
    });

    it("should roundtrip service names with commas", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 25.0,
        costsByService: [
          { serviceName: "Amazon EC2, Other", cost: 25.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe("Amazon EC2, Other");
      expect(records[0].Cost).toBe("25.00");
    });

    it("should roundtrip service names with quotes", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 30.0,
        costsByService: [
          { serviceName: 'Service "Pro"', cost: 30.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe('Service "Pro"');
      expect(records[0].Cost).toBe("30.00");
    });

    it("should roundtrip service names with newlines", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 40.0,
        costsByService: [
          { serviceName: "Service\nLine2", cost: 40.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe("Service\nLine2");
      expect(records[0].Cost).toBe("40.00");
    });

    it("should roundtrip all special characters combined", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 45.0,
        costsByService: [
          { serviceName: 'Service "Pro", Type\nA', cost: 45.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe('Service "Pro", Type\nA');
      expect(records[0].Cost).toBe("45.00");
    });

    it("should roundtrip multiple services with various special characters", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 300.0,
        costsByService: [
          { serviceName: "Normal Service", cost: 100.0 },
          { serviceName: "Service, with comma", cost: 75.0 },
          { serviceName: 'Service "quoted"', cost: 50.0 },
          { serviceName: "Service\nwith newline", cost: 40.0 },
          { serviceName: 'Complex "Service", Line\n2', cost: 35.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(5);
      expect(records[0].Service).toBe("Normal Service");
      expect(records[0].Cost).toBe("100.00");
      expect(records[1].Service).toBe("Service, with comma");
      expect(records[1].Cost).toBe("75.00");
      expect(records[2].Service).toBe('Service "quoted"');
      expect(records[2].Cost).toBe("50.00");
      expect(records[3].Service).toBe("Service\nwith newline");
      expect(records[3].Cost).toBe("40.00");
      expect(records[4].Service).toBe('Complex "Service", Line\n2');
      expect(records[4].Cost).toBe("35.00");
    });

    it("should be RFC 4180 compliant in strict mode", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 150.0,
        costsByService: [
          { serviceName: "Amazon EC2", cost: 100.0 },
          { serviceName: "Amazon S3", cost: 50.0 },
        ],
      };

      const csv = generateCsv(report);

      // RFC 4180 strict mode parsing should succeed
      const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: false, // Strict: all rows must have same number of columns
        relax_quotes: false, // Strict: quotes must be properly formatted
      }) as CsvRecord[];

      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({ Service: "Amazon EC2", Cost: "100.00" });
      expect(records[1]).toEqual({ Service: "Amazon S3", Cost: "50.00" });
    });

    it("should handle empty costsByService (header only)", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 0,
        costsByService: [],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(0);
    });

    it("should roundtrip very long service names", () => {
      const longName = "A".repeat(1000);
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByService: [{ serviceName: longName, cost: 50.0 }],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe(longName);
      expect(records[0].Cost).toBe("50.00");
    });

    it("should roundtrip large number of services (200+)", () => {
      const costsByService = Array.from({ length: 250 }, (_, i) => ({
        serviceName: `Amazon Service ${i + 1}`,
        cost: (i + 1) * 10.5,
      }));

      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: costsByService.reduce((sum, s) => sum + s.cost, 0),
        costsByService,
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(250);
      expect(records[0].Service).toBe("Amazon Service 1");
      expect(records[0].Cost).toBe("10.50");
      expect(records[249].Service).toBe("Amazon Service 250");
      expect(records[249].Cost).toBe("2625.00");
    });

    it("should preserve exact cost formatting after roundtrip", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 123.456,
        costsByService: [
          { serviceName: "Service1", cost: 0.001 }, // Rounds to 0.00
          { serviceName: "Service2", cost: 0.005 }, // Rounds to 0.01
          { serviceName: "Service3", cost: 10.5 }, // Formats to 10.50
          { serviceName: "Service4", cost: 9999999999.99 }, // Large number
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(4);
      expect(records[0].Cost).toBe("0.00");
      expect(records[1].Cost).toBe("0.01");
      expect(records[2].Cost).toBe("10.50");
      expect(records[3].Cost).toBe("9999999999.99");
    });

    it("should handle carriage returns (CRLF) in service names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 60.0,
        costsByService: [
          { serviceName: "Service\r\nWith CRLF", cost: 60.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe("Service\r\nWith CRLF");
      expect(records[0].Cost).toBe("60.00");
    });

    it("should handle tab characters in service names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 70.0,
        costsByService: [
          { serviceName: "Service\tWith Tab", cost: 70.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe("Service\tWith Tab");
      expect(records[0].Cost).toBe("70.00");
    });

    it("should handle Unicode characters in service names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 80.0,
        costsByService: [
          { serviceName: "Service 🚀 Unicode ™", cost: 80.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe("Service 🚀 Unicode ™");
      expect(records[0].Cost).toBe("80.00");
    });

    it("should handle consecutive quotes in service names", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 90.0,
        costsByService: [
          { serviceName: 'Service ""Multiple"" Quotes', cost: 90.0 },
        ],
      };

      const csv = generateCsv(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as CsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0].Service).toBe('Service ""Multiple"" Quotes');
      expect(records[0].Cost).toBe("90.00");
    });
  });

  describe("edge cases", () => {
    it("should handle very long service names", () => {
      const longName = "A".repeat(1000);
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 50.0,
        costsByService: [{ serviceName: longName, cost: 50.0 }],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      expect(lines[1]).toBe(`${longName},50.00`);
    });

    it("should handle micro-cent costs (very small)", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 0.001,
        costsByService: [{ serviceName: "Service", cost: 0.001 }],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // toFixed(2) rounds 0.001 to 0.00
      expect(lines[1]).toBe("Service,0.00");
    });

    it("should handle very large costs (billions)", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: 9999999999.99,
        costsByService: [{ serviceName: "Service", cost: 9999999999.99 }],
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      expect(lines[1]).toBe("Service,9999999999.99");
    });

    it("should handle large number of services (200+) without excessive memory", () => {
      // Simulate an account with 250 services (typical enterprise AWS account)
      const costsByService = Array.from({ length: 250 }, (_, i) => ({
        serviceName: `Amazon Service ${i + 1}`,
        cost: Math.random() * 1000,
      }));

      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: costsByService.reduce((sum, s) => sum + s.cost, 0),
        costsByService,
      };

      // Should complete without OOM error
      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // Verify structure
      expect(lines[0]).toBe("Service,Cost");
      expect(lines.length).toBe(251); // header + 250 services

      // Verify first and last service
      expect(lines[1]).toMatch(/^Amazon Service 1,\d+\.\d{2}$/);
      expect(lines[250]).toMatch(/^Amazon Service 250,\d+\.\d{2}$/);
    });

    it("should handle services with special characters efficiently", () => {
      // Test with many services requiring escaping (worst case for memory)
      const costsByService = Array.from({ length: 100 }, (_, i) => ({
        serviceName: `Service "Premium", Type ${i + 1}`,
        cost: i * 10,
      }));

      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2026-01-15",
        endDate: "2026-02-03",
        totalCost: costsByService.reduce((sum, s) => sum + s.cost, 0),
        costsByService,
      };

      const csv = generateCsv(report);
      const lines = csv.split("\n");

      // Verify all services are properly escaped
      expect(lines[1]).toBe('"Service ""Premium"", Type 1",0.00');
      expect(lines[100]).toBe('"Service ""Premium"", Type 100",990.00');
      expect(lines.length).toBe(101); // header + 100 services
    });

    it("should handle empty service name", () => {
      const report: CostReport = {
        accountId: "123456789012",
        startDate: "2024-01-01",
        endDate: "2024-02-01",
        totalCost: 12.34,
        costsByService: [{ serviceName: "", cost: 12.34 }],
      };
      const csv = generateCsv(report);
      expect(csv).toBe("Service,Cost\n,12.34");

      // Verify it can be parsed back correctly
      const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
      }) as CsvRecord[];
      expect(records[0].Service).toBe("");
      expect(records[0].Cost).toBe("12.34");
    });
  });
});

describe("generateCsvWithResources", () => {
  it("should generate CSV with header and resources in order", () => {
    const report: CostReportWithResources = {
      accountId: "123456789012",
      startDate: "2026-01-21",
      endDate: "2026-02-04",
      totalCost: 150.0,
      costsByService: [{ serviceName: "Amazon EC2", cost: 150.0 }],
      costsByResource: [
        { resourceId: "i-abc123", resourceName: "web-server-1", serviceName: "Amazon EC2", region: "us-east-1", cost: 100.0 },
        { resourceId: "i-def456", resourceName: "db-server-1", serviceName: "Amazon EC2", region: "us-west-2", cost: 50.0 },
      ],
    };

    const csv = generateCsvWithResources(report);
    const lines = csv.split("\n");

    expect(lines[0]).toBe("Resource Name,Service,Region,Cost");
    expect(lines[1]).toBe("web-server-1,Amazon EC2,us-east-1,100");
    expect(lines[2]).toBe("db-server-1,Amazon EC2,us-west-2,50");
    expect(lines.length).toBe(3);
  });

  it("should return header only for empty costsByResource", () => {
    const report: CostReportWithResources = {
      accountId: "123456789012",
      startDate: "2026-01-21",
      endDate: "2026-02-04",
      totalCost: 0,
      costsByService: [],
      costsByResource: [],
    };

    const csv = generateCsvWithResources(report);
    expect(csv).toBe("Resource Name,Service,Region,Cost");
  });

  it("should escape resource names with commas", () => {
    const report: CostReportWithResources = {
      accountId: "123456789012",
      startDate: "2026-01-21",
      endDate: "2026-02-04",
      totalCost: 25.0,
      costsByService: [{ serviceName: "Amazon EC2", cost: 25.0 }],
      costsByResource: [
        { resourceId: "i-abc123", resourceName: "Server, Production", serviceName: "Amazon EC2", region: "us-east-1", cost: 25.0 },
      ],
    };

    const csv = generateCsvWithResources(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('"Server, Production",Amazon EC2,us-east-1,25');
  });

  it("should escape resource names with quotes", () => {
    const report: CostReportWithResources = {
      accountId: "123456789012",
      startDate: "2026-01-21",
      endDate: "2026-02-04",
      totalCost: 30.0,
      costsByService: [{ serviceName: "Amazon EC2", cost: 30.0 }],
      costsByResource: [
        { resourceId: "i-abc123", resourceName: 'Server "Pro"', serviceName: "Amazon EC2", region: "us-east-1", cost: 30.0 },
      ],
    };

    const csv = generateCsvWithResources(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe('"Server ""Pro""",Amazon EC2,us-east-1,30');
  });

  it("should preserve full precision for costs", () => {
    const report: CostReportWithResources = {
      accountId: "123456789012",
      startDate: "2026-01-21",
      endDate: "2026-02-04",
      totalCost: 0.0000000029,
      costsByService: [{ serviceName: "Amazon EC2", cost: 0.0000000029 }],
      costsByResource: [
        { resourceId: "i-abc123", resourceName: "server-1", serviceName: "Amazon EC2", region: "us-east-1", cost: 0.0000000029 },
      ],
    };

    const csv = generateCsvWithResources(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("server-1,Amazon EC2,us-east-1,0.0000000029");
  });

  it("should remove trailing zeros from costs", () => {
    const report: CostReportWithResources = {
      accountId: "123456789012",
      startDate: "2026-01-21",
      endDate: "2026-02-04",
      totalCost: 10.5,
      costsByService: [{ serviceName: "Amazon EC2", cost: 10.5 }],
      costsByResource: [
        { resourceId: "i-abc123", resourceName: "server-1", serviceName: "Amazon EC2", region: "us-east-1", cost: 10.5 },
      ],
    };

    const csv = generateCsvWithResources(report);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("server-1,Amazon EC2,us-east-1,10.5");
  });

  describe("CSV roundtrip validation", () => {
    it("should generate CSV that can be parsed back correctly", () => {
      const report: CostReportWithResources = {
        accountId: "123456789012",
        startDate: "2026-01-21",
        endDate: "2026-02-04",
        totalCost: 150.5,
        costsByService: [{ serviceName: "Amazon EC2", cost: 150.5 }],
        costsByResource: [
          { resourceId: "i-abc123", resourceName: "web-server", serviceName: "Amazon EC2", region: "us-east-1", cost: 100.0 },
          { resourceId: "i-def456", resourceName: "Server, with comma", serviceName: "Amazon EC2", region: "us-west-2", cost: 50.5 },
        ],
      };

      const csv = generateCsvWithResources(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as ResourceCsvRecord[];

      expect(records).toHaveLength(2);
      expect(records[0]["Resource Name"]).toBe("web-server");
      expect(records[0].Service).toBe("Amazon EC2");
      expect(records[0].Region).toBe("us-east-1");
      expect(records[0].Cost).toBe("100");
      expect(records[1]["Resource Name"]).toBe("Server, with comma");
      expect(records[1].Cost).toBe("50.5");
    });

    it("should roundtrip all special characters combined", () => {
      const report: CostReportWithResources = {
        accountId: "123456789012",
        startDate: "2026-01-21",
        endDate: "2026-02-04",
        totalCost: 45.0,
        costsByService: [{ serviceName: "Amazon EC2", cost: 45.0 }],
        costsByResource: [
          { resourceId: "i-abc123", resourceName: 'Server "Pro", Type\nA', serviceName: "Amazon EC2", region: "us-east-1", cost: 45.0 },
        ],
      };

      const csv = generateCsvWithResources(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as ResourceCsvRecord[];

      expect(records).toHaveLength(1);
      expect(records[0]["Resource Name"]).toBe('Server "Pro", Type\nA');
      expect(records[0].Cost).toBe("45");
    });

    it("should be RFC 4180 compliant in strict mode", () => {
      const report: CostReportWithResources = {
        accountId: "123456789012",
        startDate: "2026-01-21",
        endDate: "2026-02-04",
        totalCost: 150.0,
        costsByService: [{ serviceName: "Amazon EC2", cost: 150.0 }],
        costsByResource: [
          { resourceId: "i-abc123", resourceName: "web-server-1", serviceName: "Amazon EC2", region: "us-east-1", cost: 100.0 },
          { resourceId: "i-def456", resourceName: "web-server-2", serviceName: "Amazon EC2", region: "us-west-2", cost: 50.0 },
        ],
      };

      const csv = generateCsvWithResources(report);

      // RFC 4180 strict mode parsing should succeed
      const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: false,
        relax_quotes: false,
      }) as ResourceCsvRecord[];

      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        "Resource Name": "web-server-1",
        Service: "Amazon EC2",
        Region: "us-east-1",
        Cost: "100",
      });
    });
  });

  describe("edge cases", () => {
    it("should handle resource IDs as names (no friendly name)", () => {
      const report: CostReportWithResources = {
        accountId: "123456789012",
        startDate: "2026-01-21",
        endDate: "2026-02-04",
        totalCost: 50.0,
        costsByService: [{ serviceName: "Amazon EC2", cost: 50.0 }],
        costsByResource: [
          {
            resourceId: "arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0",
            resourceName: "arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0",
            serviceName: "Amazon EC2",
            region: "us-east-1",
            cost: 50.0,
          },
        ],
      };

      const csv = generateCsvWithResources(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as ResourceCsvRecord[];

      expect(records[0]["Resource Name"]).toBe("arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0");
    });

    it("should handle large number of resources (200+)", () => {
      const costsByResource = Array.from({ length: 250 }, (_, i) => ({
        resourceId: `i-${i.toString().padStart(8, '0')}`,
        resourceName: `server-${i + 1}`,
        serviceName: "Amazon EC2",
        region: i % 2 === 0 ? "us-east-1" : "us-west-2",
        cost: (i + 1) * 10.5,
      }));

      const report: CostReportWithResources = {
        accountId: "123456789012",
        startDate: "2026-01-21",
        endDate: "2026-02-04",
        totalCost: costsByResource.reduce((sum, r) => sum + r.cost, 0),
        costsByService: [{ serviceName: "Amazon EC2", cost: costsByResource.reduce((sum, r) => sum + r.cost, 0) }],
        costsByResource,
      };

      const csv = generateCsvWithResources(report);
      const records = parse(csv, { columns: true, skip_empty_lines: true }) as ResourceCsvRecord[];

      expect(records).toHaveLength(250);
      expect(records[0]["Resource Name"]).toBe("server-1");
      expect(records[249]["Resource Name"]).toBe("server-250");
    });

    it("should handle global region (non-ARN resources)", () => {
      const report: CostReportWithResources = {
        accountId: "123456789012",
        startDate: "2026-01-21",
        endDate: "2026-02-04",
        totalCost: 25.0,
        costsByService: [{ serviceName: "Amazon EC2", cost: 25.0 }],
        costsByResource: [
          { resourceId: "i-abc123", resourceName: "server-1", serviceName: "Amazon EC2", region: "global", cost: 25.0 },
        ],
      };

      const csv = generateCsvWithResources(report);
      const lines = csv.split("\n");

      expect(lines[1]).toBe("server-1,Amazon EC2,global,25");
    });

    it("should handle global region (IAM resources)", () => {
      const report: CostReportWithResources = {
        accountId: "123456789012",
        startDate: "2026-01-21",
        endDate: "2026-02-04",
        totalCost: 10.0,
        costsByService: [{ serviceName: "AWS IAM", cost: 10.0 }],
        costsByResource: [
          { resourceId: "arn:aws:iam::123456789012:role/MyRole", resourceName: "MyRole", serviceName: "AWS IAM", region: "global", cost: 10.0 },
        ],
      };

      const csv = generateCsvWithResources(report);
      const lines = csv.split("\n");

      expect(lines[1]).toBe("MyRole,AWS IAM,global,10");
    });
  });
});
