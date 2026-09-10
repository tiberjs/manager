import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tiberjs/manager",
    environment: "node",
    pool: "forks",
    restoreMocks: true,
    include: ["tests/**/*.test.ts"],
  },
});
