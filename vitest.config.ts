import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    environment: "node",
    // Client-side units that are pure logic (no DOM) run in the node
    // environment alongside the server tests -- jsdom is not installed, and
    // these deliberately need no document.
    include: ["server/**/*.test.ts", "client/src/**/*.test.ts"],
  },
});
