import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Mock S3 client and presigner
vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: vi.fn(function() {}),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

describe("s3-uploader", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockSend = vi.fn(function() {});
    (S3Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function() {
        return {
          send: mockSend,
        };
      }
    );
    vi.mocked(getSignedUrl).mockReset();
  });

  describe("uploadCsv", () => {
    it("should call PutObjectCommand with correct parameters for valid UUID.csv", async () => {
      mockSend.mockResolvedValue({ ETag: '"abc123"' });

      const { uploadCsv } = await import("./s3-uploader.js");
      const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
      const result = await uploadCsv("test-bucket", validKey, "Service,Cost\nEC2,100.00");

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input.Bucket).toBe("test-bucket");
      expect(command.input.Key).toBe(validKey);
      expect(command.input.Body).toBe("Service,Cost\nEC2,100.00");
      expect(command.input.ContentType).toBe("text/csv");

      // Verify return value includes ETag and checksum
      expect(result.eTag).toBe('"abc123"');
      expect(result.checksum).toBeTruthy();
      expect(typeof result.checksum).toBe("string");
    });

    it("should accept valid UUID.csv formats", async () => {
      mockSend.mockResolvedValue({ ETag: '"test-etag"' });
      const { uploadCsv } = await import("./s3-uploader.js");

      const validKeys = [
        "550e8400-e29b-41d4-a716-446655440000.csv",
        "123e4567-e89b-12d3-a456-426614174000.csv",
        "00000000-0000-0000-0000-000000000000.csv",
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF.csv", // uppercase
        "aBcDeF12-3456-7890-AbCd-Ef1234567890.csv", // mixed case
      ];

      for (const key of validKeys) {
        const result = await uploadCsv("bucket", key, "data");
        expect(result.eTag).toBe('"test-etag"');
        expect(result.checksum).toBeTruthy();
      }
    });

    describe("integrity verification", () => {
      it("should calculate SHA-256 checksum and include in upload request", async () => {
        mockSend.mockResolvedValue({ ETag: '"abc123"' });
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const csvContent = "Service,Cost\nAmazon S3,12.34\nAWS Lambda,5.67";

        const result = await uploadCsv("test-bucket", validKey, csvContent);

        // Verify checksum was included in PutObjectCommand
        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command.input.ChecksumSHA256).toBeTruthy();
        expect(typeof command.input.ChecksumSHA256).toBe("string");

        // Verify checksum is returned
        expect(result.checksum).toBe(command.input.ChecksumSHA256);
      });

      it("should calculate consistent checksums for identical content", async () => {
        mockSend.mockResolvedValue({ ETag: '"abc123"' });
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const csvContent = "Service,Cost\nEC2,100.00";

        const result1 = await uploadCsv("test-bucket", validKey, csvContent);
        const result2 = await uploadCsv("test-bucket", validKey, csvContent);

        expect(result1.checksum).toBe(result2.checksum);
      });

      it("should calculate different checksums for different content", async () => {
        mockSend.mockResolvedValue({ ETag: '"abc123"' });
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

        const result1 = await uploadCsv("test-bucket", validKey, "Service,Cost\nEC2,100.00");
        const result2 = await uploadCsv("test-bucket", validKey, "Service,Cost\nS3,50.00");

        expect(result1.checksum).not.toBe(result2.checksum);
      });

      it("should return ETag from S3 response", async () => {
        const expectedETag = '"1234567890abcdef1234567890abcdef"';
        mockSend.mockResolvedValue({ ETag: expectedETag });
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

        const result = await uploadCsv("test-bucket", validKey, "data");

        expect(result.eTag).toBe(expectedETag);
      });

      it("should throw if S3 response is missing ETag", async () => {
        mockSend.mockResolvedValue({}); // No ETag in response
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

        await expect(uploadCsv("test-bucket", validKey, "data")).rejects.toThrow(
          /S3 upload succeeded but no ETag returned/
        );
      });

      it("should include checksum in error message when ETag is missing", async () => {
        mockSend.mockResolvedValue({}); // No ETag in response
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

        await expect(uploadCsv("test-bucket", validKey, "data")).rejects.toThrow(
          /Checksum:/
        );
      });

      it("should calculate checksum for empty CSV content", async () => {
        mockSend.mockResolvedValue({ ETag: '"empty-etag"' });
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

        const result = await uploadCsv("test-bucket", validKey, "");

        expect(result.checksum).toBeTruthy();
        expect(result.eTag).toBe('"empty-etag"');
      });

      it("should calculate checksum for large CSV content", async () => {
        mockSend.mockResolvedValue({ ETag: '"large-etag"' });
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

        // Create large CSV (1MB)
        const largeCsv = "Service,Cost\n" + "AWS Lambda,1.23\n".repeat(50000);

        const result = await uploadCsv("test-bucket", validKey, largeCsv);

        expect(result.checksum).toBeTruthy();
        expect(result.eTag).toBe('"large-etag"');
      });

      it("should calculate checksum for CSV with special characters", async () => {
        mockSend.mockResolvedValue({ ETag: '"special-etag"' });
        const { uploadCsv } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const csvWithSpecialChars = 'Service,Cost\n"Quoted, Service",12.34\n"Service with ""quotes""",56.78';

        const result = await uploadCsv("test-bucket", validKey, csvWithSpecialChars);

        expect(result.checksum).toBeTruthy();
        expect(result.eTag).toBe('"special-etag"');
      });
    });

    it("should throw on S3 upload failure", async () => {
      mockSend.mockRejectedValue(new Error("S3 upload failed"));

      const { uploadCsv } = await import("./s3-uploader.js");
      const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

      await expect(
        uploadCsv("test-bucket", validKey, "data")
      ).rejects.toThrow("S3 upload failed");
    });

    it("should reject empty key", async () => {
      const { uploadCsv } = await import("./s3-uploader.js");

      await expect(uploadCsv("bucket", "", "data")).rejects.toThrow(
        "S3 key cannot be empty"
      );
      await expect(uploadCsv("bucket", "  ", "data")).rejects.toThrow(
        "S3 key cannot be empty"
      );
    });

    describe("security: path traversal protection", () => {
      it("should reject path traversal attempts", async () => {
        const { uploadCsv } = await import("./s3-uploader.js");

        const maliciousKeys = [
          "../../../etc/passwd.csv",
          "550e8400-e29b-41d4-a716-446655440000/../../secret.csv",
          "../550e8400-e29b-41d4-a716-446655440000.csv",
          "foo/../550e8400-e29b-41d4-a716-446655440000.csv",
        ];

        for (const key of maliciousKeys) {
          await expect(uploadCsv("bucket", key, "data")).rejects.toThrow(
            /Invalid S3 key/
          );
        }
      });

      it("should reject forward slash in key", async () => {
        const { uploadCsv } = await import("./s3-uploader.js");

        const maliciousKeys = [
          "/absolute/path.csv",
          "subdir/550e8400-e29b-41d4-a716-446655440000.csv",
          "550e8400-e29b-41d4-a716-446655440000.csv/extra",
        ];

        for (const key of maliciousKeys) {
          await expect(uploadCsv("bucket", key, "data")).rejects.toThrow(
            /Invalid S3 key/
          );
        }
      });

      it("should reject backslash in key", async () => {
        const { uploadCsv } = await import("./s3-uploader.js");

        const maliciousKeys = [
          "subdir\\550e8400-e29b-41d4-a716-446655440000.csv",
          "550e8400-e29b-41d4-a716-446655440000\\..\\secret.csv",
        ];

        for (const key of maliciousKeys) {
          await expect(uploadCsv("bucket", key, "data")).rejects.toThrow(
            /Invalid S3 key/
          );
        }
      });

      it("should reject null byte in key", async () => {
        const { uploadCsv } = await import("./s3-uploader.js");

        const maliciousKey = "550e8400-e29b-41d4-a716-446655440000\x00.csv";

        await expect(uploadCsv("bucket", maliciousKey, "data")).rejects.toThrow(
          /Invalid S3 key/
        );
      });
    });

    describe("security: UUID format validation", () => {
      it("should reject non-UUID filenames", async () => {
        const { uploadCsv } = await import("./s3-uploader.js");

        const invalidKeys = [
          "not-a-uuid.csv",
          "test-key.csv",
          "random-name.csv",
          "12345.csv",
        ];

        for (const key of invalidKeys) {
          await expect(uploadCsv("bucket", key, "data")).rejects.toThrow(
            /Invalid S3 key format.*Expected format: \{uuid\}\.csv/
          );
        }
      });

      it("should reject invalid UUID formats", async () => {
        const { uploadCsv } = await import("./s3-uploader.js");

        const invalidKeys = [
          // Wrong segment lengths
          "550e8400-e29b-41d4-a716-4466554400.csv", // last segment too short
          "550e8400-e29b-41d4-a716-446655440000000.csv", // last segment too long
          "550e8400-e29b-41d4-a716.csv", // missing segments
          // Invalid characters
          "550e8400-e29b-41d4-a716-44665544000g.csv", // 'g' is not hex
          "550e8400-e29b-41d4-a716-44665544000!.csv", // special character
          // Missing extension
          "550e8400-e29b-41d4-a716-446655440000",
          // Wrong extension
          "550e8400-e29b-41d4-a716-446655440000.txt",
          "550e8400-e29b-41d4-a716-446655440000.json",
          // Extra content
          "prefix-550e8400-e29b-41d4-a716-446655440000.csv",
          "550e8400-e29b-41d4-a716-446655440000-suffix.csv",
          "550e8400-e29b-41d4-a716-446655440000.csv.backup",
        ];

        for (const key of invalidKeys) {
          await expect(uploadCsv("bucket", key, "data")).rejects.toThrow(
            /Invalid S3 key/
          );
        }
      });
    });
  });

  describe("getPresignedUrl", () => {
    it("should return URL and expiration date for valid UUID.csv", async () => {
      vi.mocked(getSignedUrl).mockResolvedValue(
        "https://test-bucket.s3.amazonaws.com/550e8400-e29b-41d4-a716-446655440000.csv?signature=abc"
      );

      const { getPresignedUrl } = await import("./s3-uploader.js");
      const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
      const result = await getPresignedUrl("test-bucket", validKey, 7);

      expect(result.url).toBe(
        "https://test-bucket.s3.amazonaws.com/550e8400-e29b-41d4-a716-446655440000.csv?signature=abc"
      );
      // Check expiration is approximately 7 days from now minus 5-minute clock skew buffer
      const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000;
      const expectedExpiration = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS);
      const diffMs = Math.abs(
        result.expiresAt.getTime() - expectedExpiration.getTime()
      );
      expect(diffMs).toBeLessThan(1000); // Within 1 second
    });

    it("should calculate correct expiration for custom expiry days", async () => {
      vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

      const { getPresignedUrl } = await import("./s3-uploader.js");
      const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
      const result = await getPresignedUrl("bucket", validKey, 14);

      // Expected expiration includes the 5-minute clock skew buffer
      const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000;
      const expectedExpiration = new Date(
        Date.now() + 14 * 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS
      );
      const diffMs = Math.abs(
        result.expiresAt.getTime() - expectedExpiration.getTime()
      );
      expect(diffMs).toBeLessThan(1000);
    });

    it("should apply 5-minute clock skew buffer to expiration time", async () => {
      vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

      const { getPresignedUrl } = await import("./s3-uploader.js");
      const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
      const expiryDays = 7;

      const beforeCall = Date.now();
      const result = await getPresignedUrl("bucket", validKey, expiryDays);
      const afterCall = Date.now();

      // Calculate expected expiration with 5-minute buffer subtracted
      const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
      const expectedExpiryMs = expiryDays * 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS;

      // Expected expiration should be approximately (expiryDays * 24 * 60 - 5) minutes from now
      const expectedMinutesFromNow = expiryDays * 24 * 60 - 5;
      const expectedExpirationMin = new Date(beforeCall + expectedExpiryMs);
      const expectedExpirationMax = new Date(afterCall + expectedExpiryMs);

      // Verify the expiration falls within expected range
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedExpirationMin.getTime());
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedExpirationMax.getTime());

      // Verify it's approximately the expected minutes from now (within 1 second tolerance)
      const actualMinutesFromNow = (result.expiresAt.getTime() - beforeCall) / (60 * 1000);
      expect(Math.abs(actualMinutesFromNow - expectedMinutesFromNow)).toBeLessThan(1 / 60); // < 1 second
    });

    it("should throw on presigner failure", async () => {
      vi.mocked(getSignedUrl).mockRejectedValue(
        new Error("Failed to generate presigned URL")
      );

      const { getPresignedUrl } = await import("./s3-uploader.js");
      const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";

      await expect(
        getPresignedUrl("test-bucket", validKey, 7)
      ).rejects.toThrow("Failed to generate presigned URL");
    });

    it("should reject empty key", async () => {
      const { getPresignedUrl } = await import("./s3-uploader.js");

      await expect(getPresignedUrl("bucket", "", 7)).rejects.toThrow(
        "S3 key cannot be empty"
      );
    });

    describe("security: path traversal protection", () => {
      it("should reject path traversal attempts", async () => {
        const { getPresignedUrl } = await import("./s3-uploader.js");

        const maliciousKeys = [
          "../../../etc/passwd.csv",
          "550e8400-e29b-41d4-a716-446655440000/../../secret.csv",
          "../escape",
        ];

        for (const key of maliciousKeys) {
          await expect(getPresignedUrl("bucket", key, 7)).rejects.toThrow(
            /Invalid S3 key/
          );
        }
      });

      it("should reject non-UUID filenames", async () => {
        const { getPresignedUrl } = await import("./s3-uploader.js");

        await expect(getPresignedUrl("bucket", "not-a-uuid.csv", 7)).rejects.toThrow(
          /Invalid S3 key format/
        );
        await expect(getPresignedUrl("bucket", "test.csv", 7)).rejects.toThrow(
          /Invalid S3 key format/
        );
      });
    });

    it("should include ResponseContentType in GetObjectCommand", async () => {
      vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

      const { getPresignedUrl } = await import("./s3-uploader.js");
      const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
      await getPresignedUrl("bucket", validKey, 7);

      expect(getSignedUrl).toHaveBeenCalledTimes(1);
      const command = vi.mocked(getSignedUrl).mock.calls[0][1] as GetObjectCommand;
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input.ResponseContentType).toBe("text/csv");
    });

    describe("expiry validation with fake timers", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("should calculate exact expiry with fake timers (7 days)", async () => {
        const fixedTime = new Date("2026-01-15T12:00:00Z").getTime();
        vi.setSystemTime(fixedTime);
        vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

        const { getPresignedUrl } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const result = await getPresignedUrl("bucket", validKey, 7);

        // Expected: 7 days - 5 minutes (clock skew buffer)
        const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000;
        const expectedExpiryMs = 7 * 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS;
        const expectedExpiry = new Date(fixedTime + expectedExpiryMs);

        expect(result.expiresAt.getTime()).toBe(expectedExpiry.getTime());
        expect(result.expiresAt.toISOString()).toBe("2026-01-22T11:55:00.000Z");
      });

      it("should calculate exact expiry with fake timers (14 days)", async () => {
        const fixedTime = new Date("2026-02-01T00:00:00Z").getTime();
        vi.setSystemTime(fixedTime);
        vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

        const { getPresignedUrl } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const result = await getPresignedUrl("bucket", validKey, 14);

        // Expected: 14 days - 5 minutes
        const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000;
        const expectedExpiryMs = 14 * 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS;
        const expectedExpiry = new Date(fixedTime + expectedExpiryMs);

        expect(result.expiresAt.getTime()).toBe(expectedExpiry.getTime());
        expect(result.expiresAt.toISOString()).toBe("2026-02-14T23:55:00.000Z");
      });

      it("should ensure expiry is always in the future", async () => {
        const fixedTime = new Date("2026-01-15T12:00:00Z").getTime();
        vi.setSystemTime(fixedTime);
        vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

        const { getPresignedUrl } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const result = await getPresignedUrl("bucket", validKey, 7);

        // Expiry must be in the future (after current time)
        expect(result.expiresAt.getTime()).toBeGreaterThan(fixedTime);

        // Even with clock skew buffer, should still be at least 6 days 23 hours in the future
        const minFutureMs = 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000;
        expect(result.expiresAt.getTime() - fixedTime).toBeGreaterThanOrEqual(minFutureMs);
      });

      it("should validate expiry for minimum duration (1 day)", async () => {
        const fixedTime = new Date("2026-01-15T12:00:00Z").getTime();
        vi.setSystemTime(fixedTime);
        vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

        const { getPresignedUrl } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const result = await getPresignedUrl("bucket", validKey, 1);

        // Expected: 1 day - 5 minutes
        const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000;
        const expectedExpiryMs = 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS;
        const expectedExpiry = new Date(fixedTime + expectedExpiryMs);

        expect(result.expiresAt.getTime()).toBe(expectedExpiry.getTime());
        expect(result.expiresAt.toISOString()).toBe("2026-01-16T11:55:00.000Z");
      });

      it("should handle leap day correctly (2024 leap year)", async () => {
        // Set time to Feb 28, 2024 (leap year)
        const fixedTime = new Date("2024-02-28T12:00:00Z").getTime();
        vi.setSystemTime(fixedTime);
        vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

        const { getPresignedUrl } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const result = await getPresignedUrl("bucket", validKey, 7);

        // Expected: 7 days from Feb 28 crosses leap day (Feb 29)
        // Should land on Mar 6, 2024 at 11:55 (12:00 - 5 min)
        expect(result.expiresAt.toISOString()).toBe("2024-03-06T11:55:00.000Z");
      });

      it("should handle non-leap year February (2025)", async () => {
        // Set time to Feb 28, 2025 (non-leap year)
        const fixedTime = new Date("2025-02-28T12:00:00Z").getTime();
        vi.setSystemTime(fixedTime);
        vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

        const { getPresignedUrl } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        const result = await getPresignedUrl("bucket", validKey, 7);

        // Expected: 7 days from Feb 28 (no Feb 29 in 2025)
        // Should land on Mar 7, 2025 at 11:55
        expect(result.expiresAt.toISOString()).toBe("2025-03-07T11:55:00.000Z");
      });

      it("should validate signed URL expiresIn parameter matches calculated duration", async () => {
        const fixedTime = new Date("2026-01-15T12:00:00Z").getTime();
        vi.setSystemTime(fixedTime);
        vi.mocked(getSignedUrl).mockResolvedValue("https://example.com/signed");

        const { getPresignedUrl } = await import("./s3-uploader.js");
        const validKey = "550e8400-e29b-41d4-a716-446655440000.csv";
        await getPresignedUrl("bucket", validKey, 7);

        // Verify getSignedUrl was called with correct expiresIn (in seconds)
        expect(getSignedUrl).toHaveBeenCalledTimes(1);
        const callArgs = vi.mocked(getSignedUrl).mock.calls[0];
        const options = callArgs[2] as { expiresIn: number };

        // Expected: (7 days - 5 minutes) in seconds
        const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000;
        const expectedExpiryMs = 7 * 24 * 60 * 60 * 1000 - CLOCK_SKEW_BUFFER_MS;
        const expectedExpirySeconds = Math.floor(expectedExpiryMs / 1000);

        expect(options.expiresIn).toBe(expectedExpirySeconds);
        expect(options.expiresIn).toBe(604500); // 7*24*60*60 - 5*60 = 604500 seconds
      });
    });
  });
});
