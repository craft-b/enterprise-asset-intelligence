import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { buildCommit } from "./scripts/build-commit";

/**
 * Stamp the built page with the commit that produced it.
 *
 * Injected into <head> rather than rendered in the UI, so that checking which
 * build is live is one unauthenticated request against the deployed host and
 * does not require signing in to the demo:
 *
 *   curl -s https://<host>/ | grep build-commit
 *
 * This exists because a push to main once failed to trigger a Vercel build at
 * all. The SPA kept serving the previous bundle, which loads and looks
 * correct, so nothing surfaced -- identifying the live commit meant grepping
 * the bundle for prose and knowing which commit had introduced it.
 */
function buildStamp() {
  const commit = buildCommit();
  const builtAt = new Date().toISOString();
  return {
    name: "eai-build-stamp",
    transformIndexHtml(html: string) {
      return html.replace(
        "</head>",
        `  <meta name="build-commit" content="${commit}" />
` +
        `    <meta name="build-time" content="${builtAt}" />
  </head>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    buildStamp(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "client", "src", "assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
