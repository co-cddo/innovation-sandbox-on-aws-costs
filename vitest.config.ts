import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Test timeout: 10 seconds (default is 5s)
    // Ensures tests don't hang indefinitely while allowing reasonable time
    // for mocked AWS SDK operations and complex test scenarios
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      exclude: ["node_modules", "dist", "infra", "**/*.test.ts", "**/__fixtures__/**"],
    },
    include: ["src/**/*.test.ts", "infra/**/*.test.ts"],
  },
});
