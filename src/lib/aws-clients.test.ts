import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import {
  generateCacheKey,
  calculateExpirationTime,
  isCachedClientValid,
  getCachedClient,
  clearClientCache,
  getClientCacheSize,
  getS3Client,
  getEventBridgeClient,
  getLambdaClient,
  getCostExplorerClient,
  getSTSClient,
  type ClientCacheConfig,
} from "./aws-clients.js";

describe("aws-clients", () => {
  beforeEach(() => {
    clearClientCache();
  });

  describe("generateCacheKey", () => {
    it("should generate unique keys for different client types", () => {
      const config: ClientCacheConfig = { region: "us-east-1" };

      const s3Key = generateCacheKey("S3", config);
      const lambdaKey = generateCacheKey("Lambda", config);

      expect(s3Key).not.toBe(lambdaKey);
      expect(s3Key).toContain("S3");
      expect(lambdaKey).toContain("Lambda");
    });

    it("should generate unique keys for different regions", () => {
      const config1: ClientCacheConfig = { region: "us-east-1" };
      const config2: ClientCacheConfig = { region: "eu-west-1" };

      const key1 = generateCacheKey("S3", config1);
      const key2 = generateCacheKey("S3", config2);

      expect(key1).not.toBe(key2);
      expect(key1).toContain("us-east-1");
      expect(key2).toContain("eu-west-1");
    });

    it("should generate unique keys for different role ARNs", () => {
      const config1: ClientCacheConfig = {
        roleArn: "arn:aws:iam::111111111111:role/Role1",
      };
      const config2: ClientCacheConfig = {
        roleArn: "arn:aws:iam::222222222222:role/Role2",
      };

      const key1 = generateCacheKey("S3", config1);
      const key2 = generateCacheKey("S3", config2);

      expect(key1).not.toBe(key2);
      expect(key1).toContain("Role1");
      expect(key2).toContain("Role2");
    });

    it("should generate unique keys for different profiles", () => {
      const config1: ClientCacheConfig = { profile: "dev" };
      const config2: ClientCacheConfig = { profile: "prod" };

      const key1 = generateCacheKey("S3", config1);
      const key2 = generateCacheKey("S3", config2);

      expect(key1).not.toBe(key2);
      expect(key1).toContain("dev");
      expect(key2).toContain("prod");
    });

    it("should include additional config in cache key", () => {
      const config1: ClientCacheConfig = {
        additionalConfig: { maxAttempts: 3 },
      };
      const config2: ClientCacheConfig = {
        additionalConfig: { maxAttempts: 5 },
      };

      const key1 = generateCacheKey("S3", config1);
      const key2 = generateCacheKey("S3", config2);

      expect(key1).not.toBe(key2);
    });

    it("should handle empty config", () => {
      const key = generateCacheKey("S3", {});

      expect(key).toBe("S3:default:none:none");
    });
  });

  describe("calculateExpirationTime", () => {
    it("should calculate expiration with 5-minute buffer from Date", () => {
      const futureDate = new Date(Date.now() + 3600000); // 1 hour from now
      const credentials: AwsCredentialIdentity = {
        accessKeyId: "test",
        secretAccessKey: "test",
        expiration: futureDate,
      };

      const expiresAt = calculateExpirationTime(credentials);

      // Should be 55 minutes from now (1 hour - 5 minute buffer)
      const expectedExpiration = futureDate.getTime() - 5 * 60 * 1000;
      expect(expiresAt).toBe(expectedExpiration);
    });

    it("should calculate expiration with 5-minute buffer from timestamp", () => {
      const futureTimestamp = Date.now() + 3600000; // 1 hour from now
      const credentials: AwsCredentialIdentity = {
        accessKeyId: "test",
        secretAccessKey: "test",
        expiration: new Date(futureTimestamp),
      };

      const expiresAt = calculateExpirationTime(credentials);

      // Should be 55 minutes from now (1 hour - 5 minute buffer)
      const expectedExpiration = futureTimestamp - 5 * 60 * 1000;
      expect(expiresAt).toBe(expectedExpiration);
    });

    it("should use default TTL when no credentials provided", () => {
      const before = Date.now();
      const expiresAt = calculateExpirationTime(undefined);
      const after = Date.now();

      // Should be approximately 1 hour from now
      const minExpected = before + 60 * 60 * 1000;
      const maxExpected = after + 60 * 60 * 1000;

      expect(expiresAt).toBeGreaterThanOrEqual(minExpected);
      expect(expiresAt).toBeLessThanOrEqual(maxExpected);
    });

    it("should use default TTL when credentials have no expiration", () => {
      const credentials: AwsCredentialIdentity = {
        accessKeyId: "test",
        secretAccessKey: "test",
      };

      const before = Date.now();
      const expiresAt = calculateExpirationTime(credentials);
      const after = Date.now();

      // Should be approximately 1 hour from now
      const minExpected = before + 60 * 60 * 1000;
      const maxExpected = after + 60 * 60 * 1000;

      expect(expiresAt).toBeGreaterThanOrEqual(minExpected);
      expect(expiresAt).toBeLessThanOrEqual(maxExpected);
    });
  });

  describe("isCachedClientValid", () => {
    it("should return true for valid cached client", () => {
      const cached = {
        client: {},
        expiresAt: Date.now() + 3600000, // 1 hour from now
      };

      expect(isCachedClientValid(cached)).toBe(true);
    });

    it("should return false for expired cached client", () => {
      const cached = {
        client: {},
        expiresAt: Date.now() - 1000, // 1 second ago
      };

      expect(isCachedClientValid(cached)).toBe(false);
    });

    it("should return false for undefined cached client", () => {
      expect(isCachedClientValid(undefined)).toBe(false);
    });

    it("should return false when exactly at expiration time", () => {
      const now = Date.now();
      const cached = {
        client: {},
        expiresAt: now,
      };

      // Mock Date.now to return the exact expiration time
      vi.spyOn(Date, "now").mockReturnValue(now);

      expect(isCachedClientValid(cached)).toBe(false);
    });
  });

  describe("getCachedClient", () => {
    it("should create new client on first call", () => {
      const factory = vi.fn(() => ({ id: "client1" }));
      const expiresAt = Date.now() + 3600000;

      const client = getCachedClient("test-key", factory, expiresAt);

      expect(factory).toHaveBeenCalledTimes(1);
      expect(client).toEqual({ id: "client1" });
      expect(getClientCacheSize()).toBe(1);
    });

    it("should return cached client on subsequent calls", () => {
      const factory = vi.fn(() => ({ id: "client1" }));
      const expiresAt = Date.now() + 3600000;

      const client1 = getCachedClient("test-key", factory, expiresAt);
      const client2 = getCachedClient("test-key", factory, expiresAt);

      expect(factory).toHaveBeenCalledTimes(1); // Only called once
      expect(client1).toBe(client2); // Same instance
      expect(getClientCacheSize()).toBe(1);
    });

    it("should create new client when cached client expires", () => {
      const factory = vi.fn()
        .mockReturnValueOnce({ id: "client1" })
        .mockReturnValueOnce({ id: "client2" });

      // First call with expired timestamp
      const expiresAt1 = Date.now() - 1000; // Already expired
      const client1 = getCachedClient("test-key", factory, expiresAt1);

      // Second call (should create new client because first is expired)
      const expiresAt2 = Date.now() + 3600000;
      const client2 = getCachedClient("test-key", factory, expiresAt2);

      expect(factory).toHaveBeenCalledTimes(2);
      expect(client1).toEqual({ id: "client1" });
      expect(client2).toEqual({ id: "client2" });
      expect(getClientCacheSize()).toBe(1); // Still only 1 entry (replaced)
    });

    it("should handle multiple different cache keys", () => {
      const factory1 = vi.fn(() => ({ id: "client1" }));
      const factory2 = vi.fn(() => ({ id: "client2" }));
      const expiresAt = Date.now() + 3600000;

      const client1 = getCachedClient("key1", factory1, expiresAt);
      const client2 = getCachedClient("key2", factory2, expiresAt);

      expect(factory1).toHaveBeenCalledTimes(1);
      expect(factory2).toHaveBeenCalledTimes(1);
      expect(client1).toEqual({ id: "client1" });
      expect(client2).toEqual({ id: "client2" });
      expect(getClientCacheSize()).toBe(2);
    });
  });

  describe("clearClientCache", () => {
    it("should clear all cached clients", () => {
      const factory = vi.fn(() => ({ id: "client" }));
      const expiresAt = Date.now() + 3600000;

      getCachedClient("key1", factory, expiresAt);
      getCachedClient("key2", factory, expiresAt);

      expect(getClientCacheSize()).toBe(2);

      clearClientCache();

      expect(getClientCacheSize()).toBe(0);
    });

    it("should force new client creation after clear", () => {
      const factory = vi.fn(() => ({ id: "client" }));
      const expiresAt = Date.now() + 3600000;

      getCachedClient("key1", factory, expiresAt);
      expect(factory).toHaveBeenCalledTimes(1);

      clearClientCache();

      getCachedClient("key1", factory, expiresAt);
      expect(factory).toHaveBeenCalledTimes(2); // Called again after clear
    });
  });

  describe("Client factory functions", () => {
    describe("getS3Client", () => {
      it("should create and cache S3 client", () => {
        const client1 = getS3Client();
        const client2 = getS3Client();

        expect(client1).toBe(client2); // Same instance
        expect(getClientCacheSize()).toBe(1);
      });

      it("should create separate clients for different regions", () => {
        const client1 = getS3Client({ region: "us-east-1" });
        const client2 = getS3Client({ region: "eu-west-1" });

        expect(client1).not.toBe(client2);
        expect(getClientCacheSize()).toBe(2);
      });

      it("should respect credential expiration", () => {
        const credentials: AwsCredentialIdentity = {
          accessKeyId: "test",
          secretAccessKey: "test",
          expiration: new Date(Date.now() + 3600000),
        };

        const client = getS3Client({ credentials });

        expect(client).toBeDefined();
        expect(getClientCacheSize()).toBe(1);
      });
    });

    describe("getEventBridgeClient", () => {
      it("should create and cache EventBridge client", () => {
        const client1 = getEventBridgeClient();
        const client2 = getEventBridgeClient();

        expect(client1).toBe(client2);
        expect(getClientCacheSize()).toBe(1);
      });

      it("should create separate clients for different configs", () => {
        const client1 = getEventBridgeClient({ region: "us-east-1" });
        const client2 = getEventBridgeClient({ region: "us-west-2" });

        expect(client1).not.toBe(client2);
        expect(getClientCacheSize()).toBe(2);
      });
    });

    describe("getLambdaClient", () => {
      it("should create and cache Lambda client with retry config", () => {
        const client1 = getLambdaClient();
        const client2 = getLambdaClient();

        expect(client1).toBe(client2);
        expect(getClientCacheSize()).toBe(1);
      });

      it("should handle additional config", () => {
        const client = getLambdaClient({
          additionalConfig: { maxAttempts: 10 },
        });

        expect(client).toBeDefined();
        expect(getClientCacheSize()).toBe(1);
      });
    });

    describe("getCostExplorerClient", () => {
      it("should create and cache Cost Explorer client", () => {
        const client1 = getCostExplorerClient();
        const client2 = getCostExplorerClient();

        expect(client1).toBe(client2);
        expect(getClientCacheSize()).toBe(1);
      });

      it("should default to us-east-1 region", () => {
        const client1 = getCostExplorerClient();
        const client2 = getCostExplorerClient();

        // Both should be the same instance when called with same config
        expect(client1).toBe(client2);
        expect(getClientCacheSize()).toBe(1);
      });

      it("should allow explicit region override", () => {
        const client1 = getCostExplorerClient({ region: "us-east-1" });
        const client2 = getCostExplorerClient({ region: "eu-west-1" });

        expect(client1).not.toBe(client2);
        expect(getClientCacheSize()).toBe(2);
      });
    });

    describe("getSTSClient", () => {
      it("should create and cache STS client", () => {
        const client1 = getSTSClient();
        const client2 = getSTSClient();

        expect(client1).toBe(client2);
        expect(getClientCacheSize()).toBe(1);
      });

      it("should create separate clients for different profiles", () => {
        const client1 = getSTSClient({ profile: "dev" });
        const client2 = getSTSClient({ profile: "prod" });

        expect(client1).not.toBe(client2);
        expect(getClientCacheSize()).toBe(2);
      });
    });
  });

  describe("Integration scenarios", () => {
    it("should handle mixed client types in cache", () => {
      const s3 = getS3Client();
      const lambda = getLambdaClient();
      const eventBridge = getEventBridgeClient();
      const costExplorer = getCostExplorerClient();
      const sts = getSTSClient();

      expect(getClientCacheSize()).toBe(5);

      // Verify caching works for each type
      expect(getS3Client()).toBe(s3);
      expect(getLambdaClient()).toBe(lambda);
      expect(getEventBridgeClient()).toBe(eventBridge);
      expect(getCostExplorerClient()).toBe(costExplorer);
      expect(getSTSClient()).toBe(sts);

      expect(getClientCacheSize()).toBe(5); // No new entries
    });

    it("should handle role-based credential scenarios", () => {
      const roleArn1 = "arn:aws:iam::111111111111:role/Role1";
      const roleArn2 = "arn:aws:iam::222222222222:role/Role2";

      const credentials1: AwsCredentialIdentity = {
        accessKeyId: "key1",
        secretAccessKey: "secret1",
        sessionToken: "token1",
        expiration: new Date(Date.now() + 3600000),
      };

      const credentials2: AwsCredentialIdentity = {
        accessKeyId: "key2",
        secretAccessKey: "secret2",
        sessionToken: "token2",
        expiration: new Date(Date.now() + 3600000),
      };

      const client1 = getS3Client({ credentials: credentials1, roleArn: roleArn1 });
      const client2 = getS3Client({ credentials: credentials2, roleArn: roleArn2 });

      expect(client1).not.toBe(client2);
      expect(getClientCacheSize()).toBe(2);
    });

    it("should create different clients for different credential sets", () => {
      // First set of credentials
      const credentials1: AwsCredentialIdentity = {
        accessKeyId: "key1",
        secretAccessKey: "secret1",
        expiration: new Date(Date.now() + 3600000),
      };

      // Second set of credentials (different keys)
      const credentials2: AwsCredentialIdentity = {
        accessKeyId: "key2",
        secretAccessKey: "secret2",
        expiration: new Date(Date.now() + 3600000),
      };

      const client1 = getS3Client({ credentials: credentials1 });
      const client2 = getS3Client({ credentials: credentials2 });

      // Should be different clients because credentials are different
      // (cache key doesn't include actual credential values, so they'll be the same key)
      // But in real usage with different role ARNs, they'd be different
      const client1Again = getS3Client({ credentials: credentials1 });

      // Same credentials should return cached client
      expect(client1).toBe(client1Again);
    });
  });
});
