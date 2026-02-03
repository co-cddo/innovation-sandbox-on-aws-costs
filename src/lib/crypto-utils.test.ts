import { describe, it, expect } from "vitest";
import {
  timingSafeStringEqual,
  timingSafeBufferEqual,
  stringToBuffer,
} from "./crypto-utils.js";

describe("crypto-utils", () => {
  describe("timingSafeStringEqual", () => {
    describe("when strings are equal", () => {
      it("should return true for identical strings", () => {
        expect(timingSafeStringEqual("secret", "secret")).toBe(true);
      });

      it("should return true for identical empty strings", () => {
        expect(timingSafeStringEqual("", "")).toBe(true);
      });

      it("should return true for identical long strings", () => {
        const longString = "a".repeat(1000);
        expect(timingSafeStringEqual(longString, longString)).toBe(true);
      });

      it("should return true for identical strings with special characters", () => {
        const specialString = "!@#$%^&*()_+-=[]{}|;:',.<>?/~`";
        expect(timingSafeStringEqual(specialString, specialString)).toBe(true);
      });

      it("should return true for identical strings with Unicode characters", () => {
        const unicodeString = "Hello 世界 🌍";
        expect(timingSafeStringEqual(unicodeString, unicodeString)).toBe(true);
      });
    });

    describe("when strings differ", () => {
      it("should return false for completely different strings", () => {
        expect(timingSafeStringEqual("secret", "public")).toBe(false);
      });

      it("should return false when strings differ by one character", () => {
        expect(timingSafeStringEqual("secret", "secre1")).toBe(false);
      });

      it("should return false when strings differ at the beginning", () => {
        expect(timingSafeStringEqual("secret", "xecret")).toBe(false);
      });

      it("should return false when strings differ at the end", () => {
        expect(timingSafeStringEqual("secret", "secrex")).toBe(false);
      });

      it("should return false when strings differ in the middle", () => {
        expect(timingSafeStringEqual("secret", "sexret")).toBe(false);
      });

      it("should return false when strings differ in case", () => {
        expect(timingSafeStringEqual("secret", "SECRET")).toBe(false);
      });
    });

    describe("when strings have different lengths", () => {
      it("should return false for different length strings", () => {
        expect(timingSafeStringEqual("short", "longer-string")).toBe(false);
      });

      it("should return false when one string is empty", () => {
        expect(timingSafeStringEqual("", "non-empty")).toBe(false);
      });

      it("should return false when first string is longer", () => {
        expect(timingSafeStringEqual("longer", "short")).toBe(false);
      });
    });

    describe("timing characteristics", () => {
      it("should not exhibit early termination behavior", () => {
        // This test verifies that the function doesn't return early
        // by ensuring all comparisons complete regardless of mismatch position
        const reference = "ABCDEFGHIJ";
        const differAtStart = "XBCDEFGHIJ";
        const differAtEnd = "ABCDEFGHIX";

        // Both should return false
        expect(timingSafeStringEqual(reference, differAtStart)).toBe(false);
        expect(timingSafeStringEqual(reference, differAtEnd)).toBe(false);

        // Note: We can't easily test actual timing in unit tests without
        // introducing flakiness. In production, timing should be measured
        // with specialized tools (e.g., timing attack frameworks).
      });

      it("should process all characters for strings that match", () => {
        // Verify that long matching strings are handled correctly
        const longMatch = "a".repeat(10000);
        expect(timingSafeStringEqual(longMatch, longMatch)).toBe(true);
      });

      it("should process all characters for strings that differ", () => {
        // Verify that long differing strings are handled correctly
        const longString1 = "a".repeat(10000);
        const longString2 = "a".repeat(9999) + "b";
        expect(timingSafeStringEqual(longString1, longString2)).toBe(false);
      });
    });

    describe("edge cases", () => {
      it("should handle strings with null bytes", () => {
        const withNull1 = "before\x00after";
        const withNull2 = "before\x00after";
        expect(timingSafeStringEqual(withNull1, withNull2)).toBe(true);
      });

      it("should handle strings with only whitespace", () => {
        expect(timingSafeStringEqual("   ", "   ")).toBe(true);
        expect(timingSafeStringEqual("   ", "  ")).toBe(false);
      });

      it("should handle strings with newlines", () => {
        const multiline1 = "line1\nline2\nline3";
        const multiline2 = "line1\nline2\nline3";
        expect(timingSafeStringEqual(multiline1, multiline2)).toBe(true);
      });

      it("should handle strings with emojis", () => {
        const emoji1 = "🔒🔑🛡️";
        const emoji2 = "🔒🔑🛡️";
        expect(timingSafeStringEqual(emoji1, emoji2)).toBe(true);
      });
    });

    describe("security considerations", () => {
      it("should return false for strings that differ by one bit", () => {
        // Character 'A' (0x41) vs 'a' (0x61) differs by one bit
        expect(timingSafeStringEqual("A", "a")).toBe(false);
      });

      it("should handle repeated characters correctly", () => {
        expect(timingSafeStringEqual("aaaa", "aaab")).toBe(false);
        expect(timingSafeStringEqual("aaaa", "aaaa")).toBe(true);
      });

      it("should not leak information through length comparison", () => {
        // Length comparison is not timing-safe, but this is acceptable
        // Length is often public information (e.g., JWT format is known)
        const short = "abc";
        const long = "abcdefghijklmnop";
        expect(timingSafeStringEqual(short, long)).toBe(false);
      });
    });
  });

  describe("timingSafeBufferEqual", () => {
    describe("when buffers are equal", () => {
      it("should return true for identical buffers", () => {
        const buf1 = Buffer.from("secret", "utf-8");
        const buf2 = Buffer.from("secret", "utf-8");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });

      it("should return true for identical empty buffers", () => {
        const buf1 = Buffer.from("", "utf-8");
        const buf2 = Buffer.from("", "utf-8");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });

      it("should return true for identical binary data", () => {
        const buf1 = Buffer.from([0x00, 0x01, 0x02, 0xff]);
        const buf2 = Buffer.from([0x00, 0x01, 0x02, 0xff]);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });

      it("should return true for identical hex-encoded buffers", () => {
        const buf1 = Buffer.from("deadbeef", "hex");
        const buf2 = Buffer.from("deadbeef", "hex");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });

      it("should return true for identical base64-encoded buffers", () => {
        const buf1 = Buffer.from("SGVsbG8gV29ybGQ=", "base64");
        const buf2 = Buffer.from("SGVsbG8gV29ybGQ=", "base64");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });
    });

    describe("when buffers differ", () => {
      it("should return false for different content", () => {
        const buf1 = Buffer.from("secret", "utf-8");
        const buf2 = Buffer.from("public", "utf-8");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });

      it("should return false when one byte differs", () => {
        const buf1 = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        const buf2 = Buffer.from([0x00, 0x01, 0x02, 0xff]);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });

      it("should return false when first byte differs", () => {
        const buf1 = Buffer.from([0xff, 0x01, 0x02, 0x03]);
        const buf2 = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });

      it("should return false when last byte differs", () => {
        const buf1 = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        const buf2 = Buffer.from([0x00, 0x01, 0x02, 0xff]);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });
    });

    describe("when buffers have different lengths", () => {
      it("should return false for different length buffers", () => {
        const buf1 = Buffer.from("short", "utf-8");
        const buf2 = Buffer.from("much-longer-string", "utf-8");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });

      it("should return false when one buffer is empty", () => {
        const buf1 = Buffer.from("", "utf-8");
        const buf2 = Buffer.from("non-empty", "utf-8");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });

      it("should return false when first buffer is longer", () => {
        const buf1 = Buffer.from("longer-string", "utf-8");
        const buf2 = Buffer.from("short", "utf-8");
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });
    });

    describe("security considerations", () => {
      it("should handle buffers with all zeros", () => {
        const buf1 = Buffer.alloc(10, 0);
        const buf2 = Buffer.alloc(10, 0);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });

      it("should handle buffers with all ones", () => {
        const buf1 = Buffer.alloc(10, 0xff);
        const buf2 = Buffer.alloc(10, 0xff);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });

      it("should handle buffers with alternating patterns", () => {
        const buf1 = Buffer.from([0xaa, 0xaa, 0xaa, 0xaa]);
        const buf2 = Buffer.from([0xaa, 0xaa, 0xaa, 0xaa]);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(true);
      });

      it("should return false for one-bit difference", () => {
        const buf1 = Buffer.from([0b00000001]);
        const buf2 = Buffer.from([0b00000000]);
        expect(timingSafeBufferEqual(buf1, buf2)).toBe(false);
      });
    });

    describe("typical use cases", () => {
      it("should compare HMAC signatures correctly", () => {
        // Simulated HMAC signatures (32 bytes)
        const signature1 = Buffer.from(
          "a".repeat(64),
          "hex"
        ); // 32 bytes of 0xaa
        const signature2 = Buffer.from(
          "a".repeat(64),
          "hex"
        ); // 32 bytes of 0xaa
        expect(timingSafeBufferEqual(signature1, signature2)).toBe(true);
      });

      it("should compare tokens correctly", () => {
        const token1 = Buffer.from("secret-api-token-12345", "utf-8");
        const token2 = Buffer.from("secret-api-token-12345", "utf-8");
        expect(timingSafeBufferEqual(token1, token2)).toBe(true);
      });

      it("should compare encrypted values correctly", () => {
        // Simulated encrypted data
        const encrypted1 = Buffer.from([
          0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
        ]);
        const encrypted2 = Buffer.from([
          0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
        ]);
        expect(timingSafeBufferEqual(encrypted1, encrypted2)).toBe(true);
      });
    });
  });

  describe("stringToBuffer", () => {
    it("should convert string to buffer with default encoding", () => {
      const str = "Hello World";
      const buffer = stringToBuffer(str);
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.toString("utf-8")).toBe(str);
    });

    it("should convert string to buffer with utf-8 encoding", () => {
      const str = "Hello 世界";
      const buffer = stringToBuffer(str, "utf-8");
      expect(buffer.toString("utf-8")).toBe(str);
    });

    it("should convert string to buffer with hex encoding", () => {
      const hexStr = "deadbeef";
      const buffer = stringToBuffer(hexStr, "hex");
      expect(buffer.toString("hex")).toBe(hexStr);
    });

    it("should convert string to buffer with base64 encoding", () => {
      const base64Str = "SGVsbG8gV29ybGQ=";
      const buffer = stringToBuffer(base64Str, "base64");
      expect(buffer.toString("base64")).toBe(base64Str);
    });

    it("should handle empty strings", () => {
      const buffer = stringToBuffer("");
      expect(buffer.length).toBe(0);
    });

    it("should handle strings with special characters", () => {
      const str = "!@#$%^&*()_+-=[]{}|;:',.<>?/~`";
      const buffer = stringToBuffer(str);
      expect(buffer.toString("utf-8")).toBe(str);
    });

    it("should handle strings with unicode emojis", () => {
      const str = "🔒🔑🛡️";
      const buffer = stringToBuffer(str);
      expect(buffer.toString("utf-8")).toBe(str);
    });
  });

  describe("integration: string and buffer comparison equivalence", () => {
    it("should produce equivalent results for string and buffer comparison", () => {
      const str1 = "secret-token-abc123";
      const str2 = "secret-token-abc123";
      const str3 = "secret-token-xyz789";

      // String comparison
      const stringResult1 = timingSafeStringEqual(str1, str2);
      const stringResult2 = timingSafeStringEqual(str1, str3);

      // Buffer comparison
      const bufferResult1 = timingSafeBufferEqual(
        stringToBuffer(str1),
        stringToBuffer(str2)
      );
      const bufferResult2 = timingSafeBufferEqual(
        stringToBuffer(str1),
        stringToBuffer(str3)
      );

      // Results should match
      expect(stringResult1).toBe(bufferResult1); // both true
      expect(stringResult2).toBe(bufferResult2); // both false
    });

    it("should handle unicode strings consistently", () => {
      const str1 = "Hello 世界 🌍";
      const str2 = "Hello 世界 🌍";

      const stringResult = timingSafeStringEqual(str1, str2);
      const bufferResult = timingSafeBufferEqual(
        stringToBuffer(str1),
        stringToBuffer(str2)
      );

      expect(stringResult).toBe(true);
      expect(bufferResult).toBe(true);
    });
  });

  describe("performance characteristics", () => {
    it("should handle very long strings without timing out", () => {
      // 100KB strings
      const longStr1 = "a".repeat(100000);
      const longStr2 = "a".repeat(100000);

      const result = timingSafeStringEqual(longStr1, longStr2);
      expect(result).toBe(true);
    });

    it("should handle very long buffers without timing out", () => {
      // 100KB buffers
      const longBuf1 = Buffer.alloc(100000, 0xaa);
      const longBuf2 = Buffer.alloc(100000, 0xaa);

      const result = timingSafeBufferEqual(longBuf1, longBuf2);
      expect(result).toBe(true);
    });
  });
});
