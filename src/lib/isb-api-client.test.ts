import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// Mock SecretsManager client via aws-clients
vi.mock("./aws-clients.js", () => ({
  getSecretsManagerClient: vi.fn(),
}));

describe("isb-api-client", () => {
  let mockSmSend: ReturnType<typeof vi.fn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  const TEST_SECRET = "test-jwt-secret-key-for-hmac-signing";
  const TEST_BASE_URL = "https://api.example.com";
  const TEST_SECRET_PATH = "/isb/jwt-secret";

  const validLeaseData = {
    startDate: "2026-01-15T10:00:00.000Z",
    expirationDate: "2026-02-15T10:00:00.000Z",
    awsAccountId: "123456789012",
    status: "Active",
  };

  const validJSendResponse = {
    status: "success",
    data: validLeaseData,
  };

  beforeEach(async () => {
    vi.resetModules();

    // Mock SecretsManager client
    mockSmSend = vi.fn().mockResolvedValue({
      SecretString: TEST_SECRET,
    });

    const awsClients = await import("./aws-clients.js");
    vi.mocked(awsClients.getSecretsManagerClient).mockReturnValue({
      send: mockSmSend,
    } as unknown as SecretsManagerClient);

    // Mock global fetch
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("encodeLeaseId", () => {
    it("should return valid base64 encoded JSON", async () => {
      const { encodeLeaseId } = await import("./isb-api-client.js");

      const result = encodeLeaseId(
        "user@example.com",
        "550e8400-e29b-41d4-a716-446655440000"
      );

      // Decode and verify
      const decoded = JSON.parse(Buffer.from(result, "base64").toString());
      expect(decoded.userEmail).toBe("user@example.com");
      expect(decoded.uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    });
  });

  describe("signJwt", () => {
    it("should create JWT with correct three-part structure (header.payload.signature)", async () => {
      const { signJwt } = await import("./isb-api-client.js");
      const jwt = signJwt({ user: "test" }, TEST_SECRET);
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
    });

    it("should create JWT header with correct algorithm and type", async () => {
      const { signJwt } = await import("./isb-api-client.js");
      const jwt = signJwt({ user: "test" }, TEST_SECRET);
      const [headerB64] = jwt.split(".");

      const header = JSON.parse(
        Buffer.from(headerB64, "base64url").toString()
      );
      expect(header.alg).toBe("HS256");
      expect(header.typ).toBe("JWT");
    });

    it("should include iat and exp claims in payload", async () => {
      const { signJwt } = await import("./isb-api-client.js");
      const now = Math.floor(Date.now() / 1000);
      const jwt = signJwt({ user: "test" }, TEST_SECRET, 3600);
      const [, payloadB64] = jwt.split(".");

      const payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString()
      );
      expect(payload.iat).toBeGreaterThanOrEqual(now - 1);
      expect(payload.iat).toBeLessThanOrEqual(now + 1);
      expect(payload.exp).toBe(payload.iat + 3600);
    });

    it("should create HS256 HMAC signature (not directinvoke)", async () => {
      const { signJwt } = await import("./isb-api-client.js");
      const jwt = signJwt({ user: "test" }, TEST_SECRET);
      const [, , signature] = jwt.split(".");

      // Signature should be base64url encoded, not a literal string
      expect(signature).not.toBe("directinvoke");
      expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should produce different signatures for different secrets", async () => {
      const { signJwt } = await import("./isb-api-client.js");

      // Use fixed time to ensure same iat/exp
      vi.spyOn(Date, "now").mockReturnValue(1700000000000);

      const jwt1 = signJwt({ user: "test" }, "secret1");
      const jwt2 = signJwt({ user: "test" }, "secret2");

      const sig1 = jwt1.split(".")[2];
      const sig2 = jwt2.split(".")[2];
      expect(sig1).not.toBe(sig2);
    });

    it("should produce same JWT for same inputs at same time", async () => {
      const { signJwt } = await import("./isb-api-client.js");

      vi.spyOn(Date, "now").mockReturnValue(1700000000000);

      const jwt1 = signJwt({ user: "test" }, TEST_SECRET);
      const jwt2 = signJwt({ user: "test" }, TEST_SECRET);
      expect(jwt1).toBe(jwt2);
    });

    it("should use base64url encoding (no padding, URL-safe characters)", async () => {
      const { signJwt } = await import("./isb-api-client.js");
      const jwt = signJwt({ user: "test" }, TEST_SECRET);
      const [headerB64, payloadB64, signature] = jwt.split(".");

      for (const part of [headerB64, payloadB64, signature]) {
        expect(part).not.toContain("=");
        expect(part).not.toContain("+");
        expect(part).not.toContain("/");
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });
  });

  describe("getLeaseDetails", () => {
    it("should fetch from correct URL with Authorization header", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
        text: () => Promise.resolve(JSON.stringify(validJSendResponse)),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(`${TEST_BASE_URL}/leases/base64-lease-id`);
      expect(options.method).toBe("GET");
      expect(options.headers.Authorization).toMatch(/^Bearer .+/);
      expect(options.headers["Content-Type"]).toBe("application/json");
    });

    it("should parse JSend response and return validated lease details", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      const result = await getLeaseDetails(
        "base64-lease-id",
        TEST_BASE_URL,
        TEST_SECRET_PATH
      );

      expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
      expect(result.awsAccountId).toBe("123456789012");
      expect(result.status).toBe("Active");
    });

    it("should use AbortSignal.timeout for request timeout", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.signal).toBeDefined();
    });

    it("should fetch JWT secret from Secrets Manager", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH);

      expect(mockSmSend).toHaveBeenCalledTimes(1);
      const command = mockSmSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      expect(command.input.SecretId).toBe(TEST_SECRET_PATH);
    });

    it("should cache the JWT secret across calls", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH);
      await getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH);

      // Secret should only be fetched once
      expect(mockSmSend).toHaveBeenCalledTimes(1);
    });

    it("should use JWT with HS256 signature (not directinvoke)", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH);

      const [, options] = mockFetch.mock.calls[0];
      const jwt = options.headers.Authorization.replace("Bearer ", "");
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
      expect(parts[2]).not.toBe("directinvoke");
      expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should include service identity in JWT payload", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH);

      const [, options] = mockFetch.mock.calls[0];
      const jwt = options.headers.Authorization.replace("Bearer ", "");
      const [, payloadB64] = jwt.split(".");
      const payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString()
      );

      expect(payload.user.email).toBe("ndx+costs@dsit.gov.uk");
      expect(payload.user.roles).toEqual(["Admin"]);
    });

    it("should throw on 404 response", async () => {
      mockFetch.mockResolvedValue({
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await expect(
        getLeaseDetails("unknown-lease", TEST_BASE_URL, TEST_SECRET_PATH)
      ).rejects.toThrow("Lease not found");
    });

    it("should throw on invalid response schema", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () =>
          Promise.resolve({
            status: "success",
            data: {
              // Missing required fields
              status: "Active",
            },
          }),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await expect(
        getLeaseDetails("lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
      ).rejects.toThrow("Invalid lease details response");
    });

    it("should throw on invalid date format in response", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () =>
          Promise.resolve({
            status: "success",
            data: {
              startDate: "not-a-valid-date",
              expirationDate: "2026-02-15T10:00:00.000Z",
              awsAccountId: "123456789012",
              status: "Active",
            },
          }),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await expect(
        getLeaseDetails("lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
      ).rejects.toThrow("Invalid lease details response");
    });

    it("should throw on invalid awsAccountId format in response", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () =>
          Promise.resolve({
            status: "success",
            data: {
              startDate: "2026-01-15T10:00:00.000Z",
              expirationDate: "2026-02-15T10:00:00.000Z",
              awsAccountId: "12345",
              status: "Active",
            },
          }),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await expect(
        getLeaseDetails("lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
      ).rejects.toThrow("Invalid lease details response");
    });

    it("should throw on empty JWT secret", async () => {
      mockSmSend.mockResolvedValue({
        SecretString: undefined,
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      await expect(
        getLeaseDetails("lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
      ).rejects.toThrow("JWT secret is empty");
    });

    describe("secret cache invalidation on 401/403", () => {
      it("should invalidate secret cache on 401 response", async () => {
        // First call succeeds
        mockFetch.mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(validJSendResponse),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await getLeaseDetails(
          "base64-lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );
        expect(mockSmSend).toHaveBeenCalledTimes(1);

        // Second call returns 401
        mockFetch.mockResolvedValueOnce({
          status: 401,
          statusText: "Unauthorized",
          text: () => Promise.resolve("Unauthorized"),
        });

        await expect(
          getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
        ).rejects.toThrow("ISB API error: 401");

        // Third call should re-fetch the secret (cache was invalidated)
        mockFetch.mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(validJSendResponse),
        });

        await getLeaseDetails(
          "base64-lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );
        expect(mockSmSend).toHaveBeenCalledTimes(2);
      });

      it("should invalidate secret cache on 403 response", async () => {
        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        mockFetch.mockResolvedValueOnce({
          status: 403,
          statusText: "Forbidden",
          text: () => Promise.resolve("Forbidden"),
        });

        await expect(
          getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
        ).rejects.toThrow("ISB API error: 403");

        // Next call should re-fetch the secret
        mockFetch.mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(validJSendResponse),
        });

        await getLeaseDetails(
          "base64-lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );
        expect(mockSmSend).toHaveBeenCalledTimes(2);
      });

      it("should NOT retry on 401 response", async () => {
        mockFetch.mockResolvedValue({
          status: 401,
          statusText: "Unauthorized",
          text: () => Promise.resolve("Unauthorized"),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await expect(
          getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
        ).rejects.toThrow("ISB API error: 401");

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it("should NOT retry on 403 response", async () => {
        mockFetch.mockResolvedValue({
          status: 403,
          statusText: "Forbidden",
          text: () => Promise.resolve("Forbidden"),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await expect(
          getLeaseDetails("base64-lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
        ).rejects.toThrow("ISB API error: 403");

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    describe("retry logic", () => {
      it("should retry on 500 Internal Server Error (transient error)", async () => {
        mockFetch
          .mockResolvedValueOnce({
            status: 500,
            text: () => Promise.resolve("Internal Server Error"),
          })
          .mockResolvedValueOnce({
            status: 500,
            text: () => Promise.resolve("Internal Server Error"),
          })
          .mockResolvedValueOnce({
            status: 200,
            json: () => Promise.resolve(validJSendResponse),
          });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it("should retry on 503 Service Unavailable (transient error)", async () => {
        mockFetch
          .mockResolvedValueOnce({
            status: 503,
            text: () => Promise.resolve("Service Unavailable"),
          })
          .mockResolvedValueOnce({
            status: 200,
            json: () => Promise.resolve(validJSendResponse),
          });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("should retry on 502 Bad Gateway (transient error)", async () => {
        mockFetch
          .mockResolvedValueOnce({
            status: 502,
            text: () => Promise.resolve("Bad Gateway"),
          })
          .mockResolvedValueOnce({
            status: 200,
            json: () => Promise.resolve(validJSendResponse),
          });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("should retry on 429 Too Many Requests (rate limiting)", async () => {
        mockFetch
          .mockResolvedValueOnce({
            status: 429,
            text: () => Promise.resolve("Too Many Requests"),
          })
          .mockResolvedValueOnce({
            status: 200,
            json: () => Promise.resolve(validJSendResponse),
          });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("should NOT retry on 404 Not Found (client error)", async () => {
        mockFetch.mockResolvedValueOnce({
          status: 404,
          text: () => Promise.resolve("Not Found"),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await expect(
          getLeaseDetails("unknown-lease", TEST_BASE_URL, TEST_SECRET_PATH)
        ).rejects.toThrow("Lease not found");

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it("should NOT retry on 400 Bad Request (client error)", async () => {
        mockFetch.mockResolvedValue({
          status: 400,
          text: () => Promise.resolve("Bad Request"),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await expect(
          getLeaseDetails("invalid-lease", TEST_BASE_URL, TEST_SECRET_PATH)
        ).rejects.toThrow("ISB API error: 400");

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it("should exhaust max retry attempts (3 attempts) and throw", async () => {
        mockFetch.mockResolvedValue({
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await expect(
          getLeaseDetails("lease-id", TEST_BASE_URL, TEST_SECRET_PATH)
        ).rejects.toThrow("ISB API error: 500");

        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it("should retry on network error (fetch rejection)", async () => {
        mockFetch
          .mockRejectedValueOnce(new Error("Network error"))
          .mockResolvedValueOnce({
            status: 200,
            json: () => Promise.resolve(validJSendResponse),
          });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("should retry on timeout error", async () => {
        const timeoutError = new DOMException(
          "The operation was aborted",
          "TimeoutError"
        );
        mockFetch
          .mockRejectedValueOnce(timeoutError)
          .mockResolvedValueOnce({
            status: 200,
            json: () => Promise.resolve(validJSendResponse),
          });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });

    describe("JSend response parsing", () => {
      it("should parse JSend response with data wrapper", async () => {
        mockFetch.mockResolvedValue({
          status: 200,
          json: () =>
            Promise.resolve({
              status: "success",
              data: validLeaseData,
            }),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
        expect(result.awsAccountId).toBe("123456789012");
      });

      it("should handle response without JSend data wrapper (fallback)", async () => {
        mockFetch.mockResolvedValue({
          status: 200,
          json: () => Promise.resolve(validLeaseData),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
      });

      it("should allow extra fields from ISB API (passthrough schema)", async () => {
        mockFetch.mockResolvedValue({
          status: 200,
          json: () =>
            Promise.resolve({
              status: "success",
              data: {
                ...validLeaseData,
                extraField: "should-not-cause-error",
                anotherField: 42,
              },
            }),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        const result = await getLeaseDetails(
          "lease-id",
          TEST_BASE_URL,
          TEST_SECRET_PATH
        );

        expect(result.startDate).toBe("2026-01-15T10:00:00.000Z");
      });
    });

    describe("token caching", () => {
      it("should reuse cached token for subsequent calls", async () => {
        mockFetch.mockResolvedValue({
          status: 200,
          json: () => Promise.resolve(validJSendResponse),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await getLeaseDetails("lease-1", TEST_BASE_URL, TEST_SECRET_PATH);
        await getLeaseDetails("lease-2", TEST_BASE_URL, TEST_SECRET_PATH);

        // Both calls should use the same token
        const token1 =
          mockFetch.mock.calls[0][1].headers.Authorization;
        const token2 =
          mockFetch.mock.calls[1][1].headers.Authorization;
        expect(token1).toBe(token2);
      });

      it("should reset token cache with resetTokenCache", async () => {
        mockFetch.mockResolvedValue({
          status: 200,
          json: () => Promise.resolve(validJSendResponse),
        });

        const { getLeaseDetails, resetTokenCache } = await import(
          "./isb-api-client.js"
        );
        resetTokenCache();

        await getLeaseDetails("lease-1", TEST_BASE_URL, TEST_SECRET_PATH);
        expect(mockSmSend).toHaveBeenCalledTimes(1);

        resetTokenCache();

        await getLeaseDetails("lease-2", TEST_BASE_URL, TEST_SECRET_PATH);
        // Secret should be re-fetched after reset
        expect(mockSmSend).toHaveBeenCalledTimes(2);
      });
    });

    it("should URL-encode the lease ID in the request path", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: () => Promise.resolve(validJSendResponse),
      });

      const { getLeaseDetails, resetTokenCache } = await import(
        "./isb-api-client.js"
      );
      resetTokenCache();

      const leaseIdWithSpecialChars = "abc+def/ghi=";
      await getLeaseDetails(
        leaseIdWithSpecialChars,
        TEST_BASE_URL,
        TEST_SECRET_PATH
      );

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `${TEST_BASE_URL}/leases/${encodeURIComponent(leaseIdWithSpecialChars)}`
      );
    });
  });
});
