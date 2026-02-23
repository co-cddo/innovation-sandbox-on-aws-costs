import { Agent } from "node:https";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import {
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  EventBridgeClient,
  type EventBridgeClientConfig,
} from "@aws-sdk/client-eventbridge";
import {
  SecretsManagerClient,
  type SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import {
  CostExplorerClient,
  type CostExplorerClientConfig,
} from "@aws-sdk/client-cost-explorer";
import {
  STSClient,
  type STSClientConfig,
} from "@aws-sdk/client-sts";

/**
 * Credential expiration buffer in milliseconds (5 minutes).
 * Clients will be refreshed if credentials expire within this buffer.
 */
const CREDENTIAL_EXPIRATION_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Default TTL for clients without credential expiration (1 hour).
 */
const DEFAULT_CLIENT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Connection pooling configuration for optimal performance.
 * - keepAlive: Reuse TCP connections across requests
 * - maxSockets: Allow up to 50 concurrent connections per host
 */
const CONNECTION_POOL_CONFIG = {
  connectionTimeout: 3000,
  socketTimeout: 3000,
  httpsAgent: new Agent({
    keepAlive: true,
    maxSockets: 50,
  }),
};

/**
 * Cached client entry with expiration tracking.
 */
interface CachedClient<T> {
  client: T;
  expiresAt: number;
}

/**
 * Client cache keyed by configuration hash.
 * Uses Map for O(1) lookup performance.
 */
const clientCache = new Map<string, CachedClient<any>>();

/**
 * Configuration for client caching.
 */
export interface ClientCacheConfig {
  /**
   * Optional credentials (e.g., from STS AssumeRole).
   * If provided with expiration, cache will be invalidated before credentials expire.
   */
  credentials?: AwsCredentialIdentity;

  /**
   * AWS region for the client.
   */
  region?: string;

  /**
   * Role ARN (used for cache key generation when assuming roles).
   */
  roleArn?: string;

  /**
   * Optional profile name (for CLI usage).
   */
  profile?: string;

  /**
   * Additional config to be merged with client configuration.
   */
  additionalConfig?: Record<string, any>;
}

/**
 * Generates a cache key from client configuration.
 * Key format: clientType:region:roleArn:profile:hash(additionalConfig)
 *
 * @param clientType - Type of AWS client (e.g., "S3", "Lambda")
 * @param config - Client configuration
 * @returns Cache key string
 */
export function generateCacheKey(
  clientType: string,
  config: ClientCacheConfig
): string {
  const parts = [
    clientType,
    config.region || "default",
    config.roleArn || "none",
    config.profile || "none",
  ];

  // Add hash of additional config if present
  if (config.additionalConfig) {
    const configHash = JSON.stringify(config.additionalConfig);
    parts.push(configHash);
  }

  return parts.join(":");
}

/**
 * Calculates expiration timestamp with buffer for credential refresh.
 *
 * @param credentials - Optional AWS credentials with expiration
 * @returns Expiration timestamp in milliseconds
 */
export function calculateExpirationTime(
  credentials?: AwsCredentialIdentity
): number {
  if (credentials?.expiration) {
    const expirationDate = credentials.expiration instanceof Date
      ? credentials.expiration
      : new Date(credentials.expiration);

    // Apply 5-minute buffer before actual expiration
    return expirationDate.getTime() - CREDENTIAL_EXPIRATION_BUFFER_MS;
  }

  // Default: 1 hour TTL for clients without credential expiration
  return Date.now() + DEFAULT_CLIENT_TTL_MS;
}

/**
 * Checks if a cached client is still valid (not expired).
 *
 * @param cached - Cached client entry
 * @returns True if client is still valid
 */
export function isCachedClientValid<T>(
  cached: CachedClient<T> | undefined
): cached is CachedClient<T> {
  if (!cached) {
    return false;
  }

  return Date.now() < cached.expiresAt;
}

/**
 * Gets a cached client or creates a new one if not cached or expired.
 *
 * @param key - Cache key
 * @param factory - Factory function to create new client
 * @param expiresAt - Expiration timestamp
 * @returns Cached or new client
 */
export function getCachedClient<T>(
  key: string,
  factory: () => T,
  expiresAt: number
): T {
  const cached = clientCache.get(key);

  if (isCachedClientValid(cached)) {
    return cached.client as T;
  }

  // Create new client and cache it
  const client = factory();
  clientCache.set(key, { client, expiresAt });

  return client;
}

/**
 * Clears the entire client cache.
 * Useful for testing or when you need to force client recreation.
 */
export function clearClientCache(): void {
  clientCache.clear();
}

/**
 * Gets the current size of the client cache.
 * Useful for monitoring and debugging.
 */
export function getClientCacheSize(): number {
  return clientCache.size;
}

/**
 * Common request handler configuration with connection pooling.
 */
function createRequestHandler() {
  return new NodeHttpHandler(CONNECTION_POOL_CONFIG);
}

/**
 * Gets or creates a cached S3 client with connection pooling.
 * Automatically reuses existing clients based on region, credentials, and configuration.
 * Caches are invalidated before credential expiration (5-minute buffer).
 *
 * @param config - Client cache configuration
 * @param config.credentials - Optional AWS credentials (e.g., from STS AssumeRole)
 * @param config.region - AWS region for the client (defaults to AWS SDK default region)
 * @param config.profile - Named AWS profile for CLI usage
 * @param config.roleArn - Role ARN for cache key generation
 * @param config.additionalConfig - Additional S3ClientConfig to merge
 *
 * @returns Cached or newly created S3Client with connection pooling enabled
 *
 * @example
 * ```typescript
 * // Get default S3 client
 * const s3 = getS3Client();
 *
 * // Get S3 client with assumed role credentials
 * const credentials = await assumeCostExplorerRole(roleArn);
 * const s3WithRole = getS3Client({ credentials, region: "us-east-1" });
 *
 * // Get S3 client with named profile for CLI
 * const s3WithProfile = getS3Client({ profile: "my-profile", region: "eu-west-1" });
 * ```
 */
export function getS3Client(config: ClientCacheConfig = {}): S3Client {
  const key = generateCacheKey("S3", config);
  const expiresAt = calculateExpirationTime(config.credentials);

  return getCachedClient(
    key,
    () => {
      const clientConfig: S3ClientConfig = {
        region: config.region,
        credentials: config.credentials,
        requestHandler: createRequestHandler(),
        ...config.additionalConfig,
      };

      return new S3Client(clientConfig);
    },
    expiresAt
  );
}

/**
 * Gets or creates a cached EventBridge client with connection pooling.
 * Automatically reuses existing clients based on region, credentials, and configuration.
 * Caches are invalidated before credential expiration (5-minute buffer).
 *
 * @param config - Client cache configuration
 * @param config.credentials - Optional AWS credentials (e.g., from STS AssumeRole)
 * @param config.region - AWS region for the client (defaults to AWS SDK default region)
 * @param config.profile - Named AWS profile for CLI usage
 * @param config.roleArn - Role ARN for cache key generation
 * @param config.additionalConfig - Additional EventBridgeClientConfig to merge
 *
 * @returns Cached or newly created EventBridgeClient with connection pooling enabled
 *
 * @example
 * ```typescript
 * // Get default EventBridge client
 * const eventBridge = getEventBridgeClient();
 *
 * // Get EventBridge client for specific region
 * const eventBridgeEuWest = getEventBridgeClient({ region: "eu-west-1" });
 * ```
 */
export function getEventBridgeClient(
  config: ClientCacheConfig = {}
): EventBridgeClient {
  const key = generateCacheKey("EventBridge", config);
  const expiresAt = calculateExpirationTime(config.credentials);

  return getCachedClient(
    key,
    () => {
      const clientConfig: EventBridgeClientConfig = {
        region: config.region,
        credentials: config.credentials,
        requestHandler: createRequestHandler(),
        ...config.additionalConfig,
      };

      return new EventBridgeClient(clientConfig);
    },
    expiresAt
  );
}

/**
 * Gets or creates a cached Secrets Manager client with connection pooling.
 * Automatically reuses existing clients based on region, credentials, and configuration.
 * Caches are invalidated before credential expiration (5-minute buffer).
 *
 * @param config - Client cache configuration
 * @param config.credentials - Optional AWS credentials (e.g., from STS AssumeRole)
 * @param config.region - AWS region for the client (defaults to AWS SDK default region)
 * @param config.profile - Named AWS profile for CLI usage
 * @param config.roleArn - Role ARN for cache key generation
 * @param config.additionalConfig - Additional SecretsManagerClientConfig to merge
 *
 * @returns Cached or newly created SecretsManagerClient with connection pooling enabled
 *
 * @example
 * ```typescript
 * // Get default Secrets Manager client
 * const sm = getSecretsManagerClient();
 *
 * // Get Secrets Manager client for specific region
 * const smUsEast = getSecretsManagerClient({ region: "us-east-1" });
 * ```
 */
export function getSecretsManagerClient(
  config: ClientCacheConfig = {}
): SecretsManagerClient {
  const key = generateCacheKey("SecretsManager", config);
  const expiresAt = calculateExpirationTime(config.credentials);

  return getCachedClient(
    key,
    () => {
      const clientConfig: SecretsManagerClientConfig = {
        region: config.region,
        credentials: config.credentials,
        requestHandler: createRequestHandler(),
        ...config.additionalConfig,
      };

      return new SecretsManagerClient(clientConfig);
    },
    expiresAt
  );
}

/**
 * Gets or creates a cached Cost Explorer client with connection pooling and retry configuration.
 * Automatically reuses existing clients based on region, credentials, and configuration.
 * Caches are invalidated before credential expiration (5-minute buffer).
 *
 * IMPORTANT: Cost Explorer requires us-east-1 region and will default to it if not specified.
 *
 * Default retry configuration:
 * - maxAttempts: 5
 * - retryMode: "adaptive" (adjusts to service throttling)
 *
 * @param config - Client cache configuration
 * @param config.credentials - Optional AWS credentials (e.g., from STS AssumeRole for cross-account access)
 * @param config.region - AWS region for the client (defaults to "us-east-1" for Cost Explorer)
 * @param config.profile - Named AWS profile for CLI usage
 * @param config.roleArn - Role ARN for cache key generation
 * @param config.additionalConfig - Additional CostExplorerClientConfig to merge
 *
 * @returns Cached or newly created CostExplorerClient with connection pooling and retry enabled
 *
 * @example
 * ```typescript
 * // Get default Cost Explorer client (uses us-east-1)
 * const costExplorer = getCostExplorerClient();
 *
 * // Get Cost Explorer client with assumed role credentials for cross-account
 * const credentials = await assumeCostExplorerRole(roleArn);
 * const costExplorerCrossAccount = getCostExplorerClient({
 *   credentials,
 *   region: "us-east-1" // Cost Explorer requires us-east-1
 * });
 * ```
 */
export function getCostExplorerClient(
  config: ClientCacheConfig = {}
): CostExplorerClient {
  const key = generateCacheKey("CostExplorer", config);
  const expiresAt = calculateExpirationTime(config.credentials);

  return getCachedClient(
    key,
    () => {
      const clientConfig: CostExplorerClientConfig = {
        region: config.region || "us-east-1", // Cost Explorer requires us-east-1
        credentials: config.credentials,
        requestHandler: createRequestHandler(),
        maxAttempts: 5,
        retryMode: "adaptive",
        ...config.additionalConfig,
      };

      return new CostExplorerClient(clientConfig);
    },
    expiresAt
  );
}

/**
 * Gets or creates a cached STS (Security Token Service) client with connection pooling.
 * Automatically reuses existing clients based on region, credentials, and configuration.
 * Caches are invalidated before credential expiration (5-minute buffer).
 *
 * @param config - Client cache configuration
 * @param config.credentials - Optional AWS credentials
 * @param config.region - AWS region for the client (defaults to AWS SDK default region)
 * @param config.profile - Named AWS profile for CLI usage
 * @param config.roleArn - Role ARN for cache key generation
 * @param config.additionalConfig - Additional STSClientConfig to merge
 *
 * @returns Cached or newly created STSClient with connection pooling enabled
 *
 * @example
 * ```typescript
 * // Get default STS client
 * const sts = getSTSClient();
 *
 * // Get STS client for specific region
 * const stsUsEast = getSTSClient({ region: "us-east-1" });
 * ```
 */
export function getSTSClient(config: ClientCacheConfig = {}): STSClient {
  const key = generateCacheKey("STS", config);
  const expiresAt = calculateExpirationTime(config.credentials);

  return getCachedClient(
    key,
    () => {
      const clientConfig: STSClientConfig = {
        region: config.region,
        credentials: config.credentials,
        requestHandler: createRequestHandler(),
        ...config.additionalConfig,
      };

      return new STSClient(clientConfig);
    },
    expiresAt
  );
}
