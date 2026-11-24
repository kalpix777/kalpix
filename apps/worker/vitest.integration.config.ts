import { defineConfig } from "vitest/config";
// Runs against a real, migrated PostgreSQL (DATABASE_URL). CI runs it after `pnpm db:deploy`.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
