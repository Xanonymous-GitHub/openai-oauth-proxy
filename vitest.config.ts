import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/admin/ui", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
