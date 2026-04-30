import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@paperclipai/scripts",
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
});
