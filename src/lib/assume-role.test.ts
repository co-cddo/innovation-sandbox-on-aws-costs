import { describe, it, expect, vi, beforeEach } from "vitest";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

// Mock the STS client
vi.mock("@aws-sdk/client-sts", async () => {
  const actual = await vi.importActual("@aws-sdk/client-sts");
  class MockSTSClient {
    send = vi.fn();
  }
  return {
    ...actual,
    STSClient: vi.fn(() => new MockSTSClient()),
  };
});

describe("assumeCostExplorerRole", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockSend = vi.fn();
    (STSClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(function() {
      return {
        send: mockSend,
      };
    });
  });

  it("should return credentials on successful assume role", async () => {
    const mockCredentials = {
      AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
      SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      SessionToken: "session-token-123",
      Expiration: new Date("2026-02-03T12:00:00Z"),
    };

    mockSend.mockResolvedValue({
      Credentials: mockCredentials,
    });

    const { assumeCostExplorerRole } = await import("./assume-role.js");
    const credentials = await assumeCostExplorerRole(
      "arn:aws:iam::123456789012:role/CostExplorerReadRole"
    );

    expect(credentials.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(credentials.secretAccessKey).toBe(
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    );
    expect(credentials.sessionToken).toBe("session-token-123");
    expect(credentials.expiration).toEqual(new Date("2026-02-03T12:00:00Z"));
  });

  it("should throw when no credentials returned", async () => {
    mockSend.mockResolvedValue({
      Credentials: undefined,
    });

    const { assumeCostExplorerRole } = await import("./assume-role.js");

    await expect(
      assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole")
    ).rejects.toThrow("No credentials returned");
  });

  it("should throw when AccessKeyId missing", async () => {
    mockSend.mockResolvedValue({
      Credentials: {
        SecretAccessKey: "secret",
        SessionToken: "token",
      },
    });

    const { assumeCostExplorerRole } = await import("./assume-role.js");

    await expect(
      assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole")
    ).rejects.toThrow("Missing AccessKeyId or SecretAccessKey");
  });

  it("should throw when SecretAccessKey missing", async () => {
    mockSend.mockResolvedValue({
      Credentials: {
        AccessKeyId: "AKID",
        SessionToken: "token",
      },
    });

    const { assumeCostExplorerRole } = await import("./assume-role.js");

    await expect(
      assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole")
    ).rejects.toThrow("Missing AccessKeyId or SecretAccessKey");
  });

  it("should propagate AccessDenied errors", async () => {
    const accessDeniedError = new Error("AccessDenied");
    accessDeniedError.name = "AccessDenied";
    mockSend.mockRejectedValue(accessDeniedError);

    const { assumeCostExplorerRole } = await import("./assume-role.js");

    await expect(
      assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole")
    ).rejects.toThrow("AccessDenied");
  });

  it("should propagate network errors", async () => {
    mockSend.mockRejectedValue(new Error("Network error"));

    const { assumeCostExplorerRole } = await import("./assume-role.js");

    await expect(
      assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole")
    ).rejects.toThrow("Network error");
  });

  describe("credential duration", () => {
    it("should use default duration of 3600 seconds (1 hour)", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            DurationSeconds: 3600,
          }),
        })
      );
    });

    it("should accept custom duration within valid range", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole(
        "arn:aws:iam::123456789012:role/TestRole",
        3600 // 1 hour
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            DurationSeconds: 3600,
          }),
        })
      );
    });

    it("should accept minimum duration of 900 seconds (15 minutes)", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole(
        "arn:aws:iam::123456789012:role/TestRole",
        900
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            DurationSeconds: 900,
          }),
        })
      );
    });

    it("should accept maximum duration of 43200 seconds (12 hours)", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole(
        "arn:aws:iam::123456789012:role/TestRole",
        43200
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            DurationSeconds: 43200,
          }),
        })
      );
    });

    it("should reject duration below 900 seconds", async () => {
      const { assumeCostExplorerRole } = await import("./assume-role.js");

      await expect(
        assumeCostExplorerRole(
          "arn:aws:iam::123456789012:role/TestRole",
          899 // 1 second below minimum
        )
      ).rejects.toThrow("Invalid credential duration: 899 seconds");
      await expect(
        assumeCostExplorerRole(
          "arn:aws:iam::123456789012:role/TestRole",
          899
        )
      ).rejects.toThrow("Must be between 900 (15 min) and 43200 (12 hours)");
    });

    it("should reject duration above 43200 seconds", async () => {
      const { assumeCostExplorerRole } = await import("./assume-role.js");

      await expect(
        assumeCostExplorerRole(
          "arn:aws:iam::123456789012:role/TestRole",
          43201 // 1 second above maximum
        )
      ).rejects.toThrow("Invalid credential duration: 43201 seconds");
      await expect(
        assumeCostExplorerRole(
          "arn:aws:iam::123456789012:role/TestRole",
          43201
        )
      ).rejects.toThrow("Must be between 900 (15 min) and 43200 (12 hours)");
    });

    it("should reject zero duration", async () => {
      const { assumeCostExplorerRole } = await import("./assume-role.js");

      await expect(
        assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole", 0)
      ).rejects.toThrow("Invalid credential duration");
    });

    it("should reject negative duration", async () => {
      const { assumeCostExplorerRole } = await import("./assume-role.js");

      await expect(
        assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole", -3600)
      ).rejects.toThrow("Invalid credential duration");
    });

    it("should include AWS STS documentation link in error message", async () => {
      const { assumeCostExplorerRole } = await import("./assume-role.js");

      await expect(
        assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole", 500)
      ).rejects.toThrow(
        "AWS STS constraints: https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html"
      );
    });
  });

  describe("session name", () => {
    it("should use session name with 'lease-costs-' prefix", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            RoleSessionName: expect.stringMatching(/^lease-costs-\d+$/),
          }),
        })
      );
    });

    it("should include timestamp in session name for uniqueness", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");

      // Make two calls and verify they have different session names
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");
      const firstCall = mockSend.mock.calls[0][0];
      const firstSessionName = firstCall.input.RoleSessionName;

      // Wait 1ms to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 1));

      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");
      const secondCall = mockSend.mock.calls[1][0];
      const secondSessionName = secondCall.input.RoleSessionName;

      expect(firstSessionName).not.toBe(secondSessionName);
    });

    it("should create session name within AWS length limits (2-64 chars)", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");

      const command = mockSend.mock.calls[0][0];
      const sessionName = command.input.RoleSessionName;

      expect(sessionName.length).toBeGreaterThanOrEqual(2);
      expect(sessionName.length).toBeLessThanOrEqual(64);
    });

    it("should create session name matching AWS allowed characters pattern", async () => {
      // AWS allows: [\w+=,.@-]*
      // Which is: alphanumeric, underscore, plus, equals, comma, period, at, hyphen
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");

      const command = mockSend.mock.calls[0][0];
      const sessionName = command.input.RoleSessionName;

      // Verify matches AWS pattern: [\w+=,.@-]*
      expect(sessionName).toMatch(/^[\w+=,.@-]+$/);
    });

    it("should extract timestamp from session name and verify it is recent", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const beforeCall = Date.now();
      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");
      const afterCall = Date.now();

      const command = mockSend.mock.calls[0][0];
      const sessionName = command.input.RoleSessionName;

      // Extract timestamp from "lease-costs-1738598400000"
      const timestampMatch = sessionName.match(/lease-costs-(\d+)$/);
      expect(timestampMatch).not.toBeNull();

      const timestamp = parseInt(timestampMatch![1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(beforeCall);
      expect(timestamp).toBeLessThanOrEqual(afterCall);
    });

    it("should verify session name does not contain invalid characters", async () => {
      // Verify no spaces, slashes, special characters outside AWS allowed set
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");

      const command = mockSend.mock.calls[0][0];
      const sessionName = command.input.RoleSessionName;

      // Should not contain: spaces, slashes, brackets, etc.
      expect(sessionName).not.toMatch(/[\s/\\[\]{}()<>!?*&^%$#|]/);
    });

    it("should verify session name prefix identifies the application", async () => {
      // Session name should start with "lease-costs-" for traceability in CloudTrail
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");
      await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");

      const command = mockSend.mock.calls[0][0];
      const sessionName = command.input.RoleSessionName;

      expect(sessionName).toMatch(/^lease-costs-/);
    });

    it("should use consistent session name format across multiple invocations", async () => {
      mockSend.mockResolvedValue({
        Credentials: {
          AccessKeyId: "AKID",
          SecretAccessKey: "SECRET",
          SessionToken: "TOKEN",
        },
      });

      const { assumeCostExplorerRole } = await import("./assume-role.js");

      // Call multiple times
      for (let i = 0; i < 3; i++) {
        await assumeCostExplorerRole("arn:aws:iam::123456789012:role/TestRole");
      }

      // Verify all session names follow the same format
      for (let i = 0; i < 3; i++) {
        const command = mockSend.mock.calls[i][0];
        const sessionName = command.input.RoleSessionName;

        expect(sessionName).toMatch(/^lease-costs-\d+$/);
        expect(sessionName.length).toBeGreaterThanOrEqual(2);
        expect(sessionName.length).toBeLessThanOrEqual(64);
      }
    });
  });
});
