import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    pool: "forks",
    include: ["__tests__/**/*.test.{js,mjs}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.js"],
      exclude: ["src/config/**", "src/models/**"],
    },
  },
});
