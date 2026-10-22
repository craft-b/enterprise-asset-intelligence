// server/services/cors.test.ts
//
// CORS failures are invisible server-side: the request succeeds, the browser
// discards the response, and the only symptom is a console message in someone
// else's devtools. So the policy is exercised here against a real Express app
// over a real socket, rather than asserted on the config object.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import { applyCors, parseAllowedOrigins } from "./cors";

const FRONTEND = "https://enterprise-asset-intelligence.vercel.app";
const LOCAL = "http://localhost:5173";
const HOSTILE = "https://not-mine.example";

describe("parseAllowedOrigins", () => {
  it("parses a comma-separated list", () => {
    expect(parseAllowedOrigins(`${FRONTEND}, ${LOCAL}`)).toEqual([FRONTEND, LOCAL]);
  });

  it("treats unset and blank as no cross-origin access", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("   ")).toEqual([]);
    expect(parseAllowedOrigins(",,")).toEqual([]);
  });

  it("de-duplicates", () => {
    expect(parseAllowedOrigins(`${FRONTEND},${FRONTEND}`)).toEqual([FRONTEND]);
  });

  it("refuses a wildcard, naming why", () => {
    // '*' plus Allow-Credentials is rejected by browsers, so the permissive
    // looking setting is the broken one. Failing at boot beats debugging it live.
    expect(() => parseAllowedOrigins("*")).toThrow(/cannot be '\*'/);
    expect(() => parseAllowedOrigins(`${FRONTEND},*`)).toThrow(/cannot be '\*'/);
  });

  it("refuses an entry with a path, which would never match an Origin header", () => {
    expect(() => parseAllowedOrigins(`${FRONTEND}/app`)).toThrow(/bare origin/);
  });

  it("refuses something that is not a URL", () => {
    expect(() => parseAllowedOrigins("enterprise-asset-intelligence.vercel.app")).toThrow(/not a valid origin/);
  });

  it("normalises away a bare trailing slash", () => {
    expect(parseAllowedOrigins(`${FRONTEND}/`)).toEqual([FRONTEND]);
  });
});

describe("CORS policy over HTTP", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = express();
    applyCors(app, `${FRONTEND},${LOCAL}`);
    app.get("/api/health", (_req, res) => res.json({ status: "healthy" }));
    app.post("/api/login", (_req, res) => res.json({ ok: true }));

    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("answers an allowed origin with that exact origin, never a wildcard", async () => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: FRONTEND } });

    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("allows credentials, without which the session cookie is dropped", async () => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: FRONTEND } });
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("varies on Origin so a cache cannot cross-serve the header", async () => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: FRONTEND } });
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("answers a preflight 204 with methods and headers", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "OPTIONS",
      headers: {
        Origin: FRONTEND,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("serves a second allowed origin its own value", async () => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: LOCAL } });
    expect(res.headers.get("access-control-allow-origin")).toBe(LOCAL);
  });

  it("sends no CORS headers to an origin that is not listed", async () => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: HOSTILE } });

    // The handler still runs — omitting the header is what makes the browser
    // discard the response.
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("rejects a preflight from an unlisted origin outright", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "OPTIONS",
      headers: { Origin: HOSTILE, "Access-Control-Request-Method": "POST" },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("leaves same-origin requests untouched", async () => {
    // No Origin header: a health check, curl, or the Docker stack behind nginx.
    const res = await fetch(`${base}/api/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "healthy" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS with no allowlist", () => {
  it("installs nothing and still serves same-origin traffic", async () => {
    const app = express();
    const allowed = applyCors(app, undefined);
    expect(allowed).toEqual([]);

    app.get("/api/health", (_req, res) => res.json({ status: "healthy" }));

    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: FRONTEND },
    });
    // Nothing is granted, so a browser would block it — correct when no
    // frontend origin has been declared.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});
