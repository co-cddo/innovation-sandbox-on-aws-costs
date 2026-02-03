import { timingSafeEqual as nodeTimingSafeEqual } from "crypto";

/**
 * Crypto Utilities for Security-Critical Operations
 * ==================================================
 *
 * This module provides cryptographic utilities for operations that require
 * protection against timing attacks and other side-channel attacks.
 *
 * When to Use These Utilities
 * ----------------------------
 * Use timing-safe comparison when comparing:
 * - Authentication tokens or passwords
 * - API keys or secrets
 * - HMAC signatures
 * - Any value where knowledge of partial correctness could aid an attacker
 *
 * When NOT to Use These Utilities
 * --------------------------------
 * Standard string comparison (===) is appropriate for:
 * - Public identifiers (UUIDs, account IDs, resource names)
 * - Values that are not secrets
 * - Cases where the attacker already has the value
 * - Values validated after authentication/authorization checks
 *
 * Example: UUID Validation in This Project
 * -----------------------------------------
 * The lease UUIDs in this project are PUBLIC IDENTIFIERS, not secrets:
 * - They appear in logs, events, and URLs
 * - They are not used for authentication (userEmail + ISB Lambda provide auth)
 * - An attacker would need EventBridge publish permissions to exploit timing
 * - Knowledge of valid UUIDs does not grant access to resources
 *
 * Therefore, standard validation (regex) is sufficient. Timing-safe comparison
 * would add complexity without meaningful security benefit.
 *
 * Timing Attack Overview
 * ----------------------
 * Timing attacks exploit variations in execution time to infer secret information.
 * Example vulnerable code:
 * ```typescript
 * function isValidToken(provided: string, expected: string): boolean {
 *   if (provided.length !== expected.length) return false;
 *   for (let i = 0; i < provided.length; i++) {
 *     if (provided[i] !== expected[i]) return false; // Early return leaks position!
 *   }
 *   return true;
 * }
 * ```
 *
 * An attacker can measure response times:
 * - "A000..." takes 1ms → first char wrong
 * - "S000..." takes 1.5ms → first char correct, second wrong
 * - "SE00..." takes 2ms → first two correct, third wrong
 * - etc.
 *
 * By making thousands of requests and measuring timing, the attacker can
 * reconstruct the secret one character at a time.
 *
 * Constant-Time Comparison
 * ------------------------
 * Constant-time comparison always checks every character, regardless of whether
 * a mismatch is found:
 * ```typescript
 * function timingSafeEqual(a: string, b: string): boolean {
 *   if (a.length !== b.length) return false;
 *   let result = 0;
 *   for (let i = 0; i < a.length; i++) {
 *     result |= a.charCodeAt(i) ^ b.charCodeAt(i); // Bitwise OR accumulates differences
 *   }
 *   return result === 0; // Single comparison at the end
 * }
 * ```
 *
 * This takes the same time whether the strings match or differ at the first character.
 *
 * Limitations
 * -----------
 * - Length comparison is NOT timing-safe (but length leakage is often acceptable)
 * - JavaScript JIT optimization may introduce timing variations
 * - Network jitter, server load, and GC pauses add noise (but don't eliminate risk)
 * - For maximum security, use Node.js crypto.timingSafeEqual() on Buffers
 *
 * References
 * ----------
 * - OWASP: Timing Attack (https://owasp.org/www-community/attacks/Timing_attack)
 * - CWE-208: Observable Timing Discrepancy
 * - Node.js crypto.timingSafeEqual documentation
 */

/**
 * Compares two strings in constant time to prevent timing attacks.
 *
 * This function compares every character of both strings using bitwise operations
 * to accumulate differences without early termination. The comparison takes the
 * same amount of time regardless of where (or if) the strings differ.
 *
 * **Security Notes:**
 * - Length comparison is NOT timing-safe (length leakage is accepted)
 * - Strings must be normalized to same encoding (UTF-8) before comparison
 * - For maximum security with binary data, use Node.js crypto.timingSafeEqual()
 *
 * **Performance:**
 * - O(n) where n is the length of the strings
 * - Approximately 2-3x slower than standard string comparison
 * - Use ONLY for security-critical comparisons (tokens, secrets, signatures)
 *
 * **When to Use:**
 * - Comparing authentication tokens or passwords
 * - Validating HMAC signatures
 * - Comparing API keys
 * - Any case where partial knowledge helps an attacker
 *
 * **When NOT to Use:**
 * - Public identifiers (UUIDs, account IDs)
 * - Non-sensitive data
 * - Values already behind authentication
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal, false otherwise
 *
 * @example
 * ```typescript
 * // GOOD: Comparing sensitive values
 * const isValid = timingSafeStringEqual(providedToken, expectedToken);
 *
 * // BAD: Comparing public identifiers (unnecessary overhead)
 * const isMatch = timingSafeStringEqual(leaseId, "expected-lease-id");
 * // Should use: leaseId === "expected-lease-id"
 * ```
 *
 * @see timingSafeBufferEqual for binary data comparison
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  // Length comparison is not timing-safe, but length leakage is acceptable
  // in most scenarios (length is often public information)
  if (a.length !== b.length) {
    return false;
  }

  // Accumulate differences using bitwise OR
  // This ensures we always process every character, regardless of mismatches
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    // XOR returns 0 if chars match, non-zero if different
    // OR accumulates all differences into result
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  // Single comparison at the end (no early termination)
  return result === 0;
}

/**
 * Compares two Buffers in constant time using Node.js crypto.timingSafeEqual.
 *
 * This is the most secure option for comparing binary data (tokens, signatures,
 * encrypted values) as it uses Node.js's built-in constant-time comparison.
 *
 * **Requirements:**
 * - Buffers must have the same byte length
 * - Throws TypeError if lengths differ (use try-catch for graceful handling)
 *
 * **Performance:**
 * - O(n) where n is buffer length
 * - Native implementation (faster than JavaScript loop)
 *
 * @param a - First buffer to compare
 * @param b - Second buffer to compare
 * @returns true if buffers are equal, false if lengths differ or content differs
 *
 * @example
 * ```typescript
 * const token1 = Buffer.from("secret-token-abc123", "utf-8");
 * const token2 = Buffer.from("secret-token-abc123", "utf-8");
 * const isEqual = timingSafeBufferEqual(token1, token2); // true
 *
 * const token3 = Buffer.from("secret-token-xyz789", "utf-8");
 * const isDifferent = timingSafeBufferEqual(token1, token3); // false
 *
 * // Graceful handling of length mismatch
 * const shortToken = Buffer.from("short", "utf-8");
 * const longToken = Buffer.from("much-longer-token", "utf-8");
 * const result = timingSafeBufferEqual(shortToken, longToken); // false (different lengths)
 * ```
 *
 * @see timingSafeStringEqual for string comparison
 */
export function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  // Node.js crypto.timingSafeEqual throws TypeError if lengths differ
  // Return false for graceful handling
  if (a.length !== b.length) {
    return false;
  }

  try {
    return nodeTimingSafeEqual(a, b);
  } catch (error) {
    // Should never reach here due to length check above
    // But handle gracefully in case of unexpected errors
    return false;
  }
}

/**
 * Converts a string to a Buffer for use with timingSafeBufferEqual.
 *
 * **Important:** Only use this for security-critical string comparisons.
 * For public identifiers, use standard string comparison (===).
 *
 * @param str - String to convert
 * @param encoding - Character encoding (default: "utf-8")
 * @returns Buffer representation of the string
 *
 * @example
 * ```typescript
 * const providedToken = stringToBuffer(request.headers["x-api-token"]);
 * const expectedToken = stringToBuffer(process.env.API_TOKEN);
 * const isValid = timingSafeBufferEqual(providedToken, expectedToken);
 * ```
 */
export function stringToBuffer(
  str: string,
  encoding: BufferEncoding = "utf-8"
): Buffer {
  return Buffer.from(str, encoding);
}
