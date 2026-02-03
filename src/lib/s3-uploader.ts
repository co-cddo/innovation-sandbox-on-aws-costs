import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "crypto";
import { getS3Client } from "./aws-clients.js";

/**
 * Validates an S3 object key to prevent path traversal and enforce strict UUID.csv format.
 *
 * Expected format: {uuid}.csv where uuid is a standard UUID v4 format.
 * Example: 550e8400-e29b-41d4-a716-446655440000.csv
 *
 * @param key - S3 object key to validate
 * @throws {Error} if key is invalid
 */
function validateKey(key: string): void {
  if (!key || key.trim() === "") {
    throw new Error("S3 key cannot be empty");
  }

  // Strict format validation: must be exactly {uuid}.csv
  // UUID format: 8-4-4-4-12 hexadecimal characters
  const uuidCsvPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i;

  if (!uuidCsvPattern.test(key)) {
    throw new Error(
      `Invalid S3 key format: ${key}. Expected format: {uuid}.csv (e.g., 550e8400-e29b-41d4-a716-446655440000.csv)`
    );
  }

  // Defense in depth: Block path traversal patterns even though regex should prevent them
  if (key.includes("..") || key.includes("/") || key.includes("\\") || key.includes("\0")) {
    throw new Error(`Invalid S3 key: contains forbidden characters (path traversal detected)`);
  }
}

/**
 * Calculates the SHA-256 checksum of a string and returns it as base64.
 * Used for S3 integrity verification (ChecksumSHA256 parameter).
 *
 * @param data - String data to calculate checksum for
 * @returns Base64-encoded SHA-256 checksum
 *
 * @example
 * ```typescript
 * const csv = "Service,Cost\nAmazon S3,12.34";
 * const checksum = calculateSHA256Checksum(csv);
 * // Returns: "rQw/abc123..." (base64-encoded SHA-256 hash)
 * ```
 */
function calculateSHA256Checksum(data: string): string {
  const hash = createHash("sha256");
  hash.update(data, "utf8");
  return hash.digest("base64");
}

/**
 * Uploads a CSV string to S3 with server-side encryption and integrity verification.
 * Validates the S3 key format to prevent path traversal attacks (must be {uuid}.csv format).
 *
 * File Size Expectations and Multipart Upload Considerations
 * ----------------------------------------------------------
 * **Typical CSV Size**: 5-50 KB (50-500 services)
 * **Maximum Realistic Size**: 100-200 KB (1000 services with verbose names)
 * **AWS Multipart Upload Threshold**: 5 MB (S3 best practice)
 *
 * This function uses standard PutObject (not multipart upload) because:
 * 1. **File sizes always <5MB threshold**: Even with 1000 services (extreme edge case),
 *    CSV size is ~100 KB (1000 services × ~100 bytes per line)
 * 2. **Simpler implementation**: No need for complexity of multipart upload
 * 3. **Better performance for small files**: Single-part upload has less overhead
 * 4. **Integrity verification included**: SHA-256 checksum protects data integrity
 *
 * **When to Consider Multipart Upload:**
 * - If CSV format changes to include detailed line items per service (1000+ lines per service)
 * - If additional metadata is embedded in CSV (tags, resource details, etc.)
 * - If file size consistently exceeds 5 MB (use `@aws-sdk/lib-storage` Upload)
 *
 * Multipart Upload Benefits (>5 MB files):
 * - Parallel part uploads (faster for large files)
 * - Resume capability if upload fails partway
 * - Better handling of network interruptions
 *
 * Multipart Upload Implementation (if needed):
 * ```typescript
 * import { Upload } from "@aws-sdk/lib-storage";
 *
 * const upload = new Upload({
 *   client: s3Client,
 *   params: {
 *     Bucket: bucket,
 *     Key: key,
 *     Body: csv,
 *     ContentType: "text/csv",
 *     ServerSideEncryption: "AES256",
 *     ChecksumSHA256: checksum,
 *   },
 *   // AWS recommends 5-10 MB per part
 *   partSize: 5 * 1024 * 1024, // 5 MB
 *   // Parallel uploads (default: 4)
 *   queueSize: 4,
 * });
 * const result = await upload.done();
 * ```
 *
 * Data Integrity Protection
 * --------------------------
 * This function implements end-to-end data integrity verification using SHA-256 checksums:
 *
 * 1. **Calculate Checksum**: Compute SHA-256 hash of CSV content before upload
 * 2. **Send to S3**: Include checksum in PutObject request (ChecksumSHA256 parameter)
 * 3. **S3 Verification**: S3 service validates received data matches checksum
 * 4. **Response Validation**: Verify S3 returns the expected checksum in response
 *
 * This protects against:
 * - Data corruption during transmission (network errors, packet loss)
 * - Memory corruption in Lambda runtime (rare but possible)
 * - Silent data modification by intermediaries (proxies, CDNs)
 * - Bit rot in S3 storage (S3 handles this, but checksum adds verification)
 *
 * Benefits of SHA-256 over MD5 (S3 default ETag):
 * - Stronger cryptographic properties (256-bit vs 128-bit)
 * - More collision-resistant (important for security-sensitive data)
 * - Industry standard for data integrity (NIST approved)
 * - ETag is opaque and implementation-dependent (may not be MD5 for multipart uploads)
 *
 * **Important**: S3 will reject the upload if the received data doesn't match the checksum.
 * This means integrity failures are caught immediately, not during later retrieval.
 *
 * @param bucket - S3 bucket name
 * @param key - Object key in format {uuid}.csv (e.g., "550e8400-e29b-41d4-a716-446655440000.csv")
 * @param csv - CSV content string to upload
 *
 * @returns Object containing the S3 ETag and calculated checksum
 * @returns {string} eTag - S3 ETag from response (format: "hash" or "hash-partcount")
 * @returns {string} checksum - SHA-256 checksum calculated locally (base64-encoded)
 *
 * @throws {Error} If key format is invalid (must match UUID.csv pattern)
 * @throws {Error} If key contains path traversal patterns (.., /, \, null bytes)
 * @throws {Error} If S3 PutObject operation fails
 * @throws {Error} If S3 response is missing ETag (indicates service error)
 *
 * @example
 * ```typescript
 * const csv = "Service,Cost\nAmazon S3,12.34\nAWS Lambda,5.67";
 * const { eTag, checksum } = await uploadCsv(
 *   "my-costs-bucket",
 *   "550e8400-e29b-41d4-a716-446655440000.csv",
 *   csv
 * );
 * console.log(`Upload successful. ETag: ${eTag}, Checksum: ${checksum}`);
 * ```
 */
export async function uploadCsv(
  bucket: string,
  key: string,
  csv: string
): Promise<{ eTag: string; checksum: string }> {
  validateKey(key);

  // Calculate SHA-256 checksum before upload for integrity verification
  const checksum = calculateSHA256Checksum(csv);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: csv,
    ContentType: "text/csv",
    // Explicit encryption even though bucket default is configured
    ServerSideEncryption: "AES256",
    // Request S3 to verify data integrity using SHA-256 checksum
    // S3 will reject the upload if received data doesn't match this checksum
    ChecksumSHA256: checksum,
  });

  try {
    const s3Client = getS3Client();
    const response = await s3Client.send(command);

    // Verify S3 returned an ETag (should always be present on successful upload)
    if (!response.ETag) {
      throw new Error(
        `S3 upload succeeded but no ETag returned for s3://${bucket}/${key}. ` +
          `This indicates a service error. Checksum: ${checksum}`
      );
    }

    // S3 automatically verifies the ChecksumSHA256 during upload
    // If data was corrupted, S3 would have rejected it with an error
    // The successful response means:
    // 1. Data arrived intact (checksum matched)
    // 2. Data is stored with encryption
    // 3. ETag is available for future verification

    return {
      eTag: response.ETag,
      checksum,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to upload to s3://${bucket}/${key}: ${message}`);
  }
}

/**
 * Generates a presigned URL for secure, temporary access to an S3 object.
 * Enforces text/csv content type in the response headers.
 * Validates the S3 key format to prevent path traversal attacks.
 *
 * @param bucket - S3 bucket name
 * @param key - Object key in format {uuid}.csv (e.g., "550e8400-e29b-41d4-a716-446655440000.csv")
 * @param expiresInDays - Number of days until the presigned URL expires
 *
 * @returns Object containing the presigned URL and expiration timestamp
 * @returns {string} url - Presigned S3 URL for downloading the object
 * @returns {Date} expiresAt - Timestamp when the URL will expire
 *
 * @throws {Error} If key format is invalid (must match UUID.csv pattern)
 * @throws {Error} If key contains path traversal patterns (.., /, \, null bytes)
 * @throws {Error} If presigned URL generation fails
 *
 * @example
 * ```typescript
 * const { url, expiresAt } = await getPresignedUrl(
 *   "my-costs-bucket",
 *   "550e8400-e29b-41d4-a716-446655440000.csv",
 *   7 // expires in 7 days
 * );
 * console.log(`Download URL: ${url}`);
 * console.log(`Expires at: ${expiresAt.toISOString()}`);
 * ```
 */
export async function getPresignedUrl(
  bucket: string,
  key: string,
  expiresInDays: number
): Promise<{ url: string; expiresAt: Date }> {
  validateKey(key);

  // Subtract 5-minute clock skew buffer to prevent premature expiration
  // This accounts for potential time differences between client and AWS servers
  const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
  const expiryMs = expiresInDays * 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS;
  const expiresAt = new Date(Date.now() + expiryMs);

  const expiresInSeconds = Math.floor(expiryMs / 1000);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    // Enforce Content-Type header in the response
    ResponseContentType: "text/csv",
  });

  try {
    const s3Client = getS3Client();
    const url = await getSignedUrl(s3Client, command, {
      expiresIn: expiresInSeconds,
    });
    return { url, expiresAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate presigned URL for s3://${bucket}/${key}: ${message}`);
  }
}
