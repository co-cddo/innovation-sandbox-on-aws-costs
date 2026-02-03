import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, type LogContext } from "./logger.js";

describe("logger", () => {
  // Mock console.log to capture log output
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe("createLogger", () => {
    it("should create a logger with context fields", () => {
      const context: LogContext = {
        component: "TestComponent",
        leaseId: "test-lease-id",
        accountId: "123456789012",
      };

      const logger = createLogger(context);

      expect(logger).toHaveProperty("info");
      expect(logger).toHaveProperty("warn");
      expect(logger).toHaveProperty("error");
    });
  });

  describe("info", () => {
    it("should log INFO level with message and context", () => {
      const context: LogContext = {
        component: "TestComponent",
        leaseId: "test-lease-id",
      };

      const logger = createLogger(context);
      logger.info("Test message");

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "INFO",
        message: "Test message",
        component: "TestComponent",
        leaseId: "test-lease-id",
      });
      expect(logEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("should include additional fields in log entry", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info("Test message", { customField: "customValue", count: 42 });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "INFO",
        message: "Test message",
        customField: "customValue",
        count: 42,
      });
    });

    it("should skip undefined fields", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info("Test message", { defined: "value", undefined: undefined });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toHaveProperty("defined", "value");
      expect(logEntry).not.toHaveProperty("undefined");
    });

    it("should handle null fields", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info("Test message", { nullField: null });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toHaveProperty("nullField", null);
    });
  });

  describe("warn", () => {
    it("should log WARN level with message and context", () => {
      const context: LogContext = {
        component: "TestComponent",
        accountId: "123456789012",
      };

      const logger = createLogger(context);
      logger.warn("Warning message");

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "WARN",
        message: "Warning message",
        component: "TestComponent",
        accountId: "123456789012",
      });
      expect(logEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("should include additional fields in warning", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.warn("Warning message", { remainingMs: 5000 });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "WARN",
        message: "Warning message",
        remainingMs: 5000,
      });
    });
  });

  describe("error", () => {
    it("should log ERROR level with message and context", () => {
      const context: LogContext = {
        component: "TestComponent",
        leaseId: "test-lease-id",
      };

      const logger = createLogger(context);
      logger.error("Error message");

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "ERROR",
        message: "Error message",
        component: "TestComponent",
        leaseId: "test-lease-id",
      });
      expect(logEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("should include Error object details", () => {
      const logger = createLogger({ component: "TestComponent" });
      const error = new Error("Something went wrong");

      logger.error("Operation failed", error);

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "ERROR",
        message: "Operation failed",
        error: "Something went wrong",
      });
      expect(logEntry.errorStack).toContain("Error: Something went wrong");
    });

    it("should include additional fields with error", () => {
      const logger = createLogger({ component: "TestComponent" });
      const error = new Error("Test error");

      logger.error("Operation failed", error, { operationId: "123", retryCount: 3 });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "ERROR",
        message: "Operation failed",
        error: "Test error",
        operationId: "123",
        retryCount: 3,
      });
    });

    it("should handle Error without stack trace", () => {
      const logger = createLogger({ component: "TestComponent" });
      const error = new Error("Test error");
      delete error.stack;

      logger.error("Operation failed", error);

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "ERROR",
        message: "Operation failed",
        error: "Test error",
      });
      expect(logEntry).not.toHaveProperty("errorStack");
    });

    it("should convert Error objects in fields to strings", () => {
      const logger = createLogger({ component: "TestComponent" });
      const error = new Error("Field error");

      logger.error("Operation failed", undefined, { fieldError: error });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        level: "ERROR",
        message: "Operation failed",
        fieldError: "Field error",
      });
    });
  });

  describe("context propagation", () => {
    it("should include all context fields in every log entry", () => {
      const context: LogContext = {
        component: "TestComponent",
        leaseId: "test-lease-id",
        accountId: "123456789012",
        scheduleName: "test-schedule",
      };

      const logger = createLogger(context);

      logger.info("Info message");
      logger.warn("Warning message");
      logger.error("Error message");

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);

      for (let i = 0; i < 3; i++) {
        const logEntry = JSON.parse(consoleLogSpy.mock.calls[i][0] as string);
        expect(logEntry).toMatchObject(context);
      }
    });

    it("should support custom context fields", () => {
      const context: LogContext = {
        component: "TestComponent",
        customField1: "value1",
        customField2: 42,
        customField3: true,
      };

      const logger = createLogger(context);
      logger.info("Test message");

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);

      expect(logEntry).toMatchObject({
        component: "TestComponent",
        customField1: "value1",
        customField2: 42,
        customField3: true,
      });
    });
  });

  describe("JSON format", () => {
    it("should output valid JSON on a single line", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info("Test message", { field: "value" });

      const output = consoleLogSpy.mock.calls[0][0] as string;

      // Should be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();

      // Should be single-line (no newlines in JSON output)
      expect(output).not.toContain("\n");
    });

    it("should handle special characters in messages", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info('Message with "quotes" and newlines\nand tabs\t');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const logEntry = JSON.parse(output);

      expect(logEntry.message).toBe('Message with "quotes" and newlines\nand tabs\t');
    });
  });

  describe("field types", () => {
    it("should handle string fields", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info("Test", { strField: "string value" });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logEntry.strField).toBe("string value");
    });

    it("should handle number fields", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info("Test", { numField: 42, floatField: 3.14 });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logEntry.numField).toBe(42);
      expect(logEntry.floatField).toBe(3.14);
    });

    it("should handle boolean fields", () => {
      const logger = createLogger({ component: "TestComponent" });
      logger.info("Test", { boolTrue: true, boolFalse: false });

      const logEntry = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logEntry.boolTrue).toBe(true);
      expect(logEntry.boolFalse).toBe(false);
    });
  });
});
