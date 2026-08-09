import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // One physical device, so files must not compete for it.
    fileParallelism: false,
    // Snapshots and restores device state that outlives any single file.
    globalSetup: ["tests/integration/global-setup.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    teardownTimeout: 30000,
  },
})
