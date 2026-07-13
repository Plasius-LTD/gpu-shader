import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __PLASIUS_MODULE_URL__: JSON.stringify(
      new URL("./src/testing/runner/runtime-anchor.js", import.meta.url).href,
    ),
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    coverage: {
      all: true,
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "tests/**",
        "dist/**",
        "coverage/**",
        "scripts/**",
        "**/*.config.{js,ts}",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80
      }
    }
  }
});
