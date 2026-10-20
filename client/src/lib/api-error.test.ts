// client/src/lib/api-error.test.ts
//
// GET /api/rentals returned 500 for as long as the deployment has been on
// TiDB, and the only thing the UI could say was "Failed to fetch rentals".
// The server knew exactly what was wrong -- it had the parse error -- and the
// hook threw that away and substituted a fixed string. Finding it meant
// reproducing the query against the database by hand.
//
// Every hook did this: 44 call sites, each discarding the response. The cases
// below are the ones where getting it wrong would be worse than the fixed
// string, which is why the fallback survives.

import { describe, it, expect } from "vitest";
import { apiError } from "./api-error";

const json = (body: unknown, status = 500) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("apiError", () => {
  it("prefers what the server said", async () => {
    const err = await apiError(
      json({ message: "The ML service is not responding." }, 503),
      "Failed to run predictions"
    );
    expect(err.message).toBe("The ML service is not responding.");
  });

  it("accepts an `error` key as well as `message`", async () => {
    const err = await apiError(json({ error: "Invalid agent key" }, 401), "Failed");
    expect(err.message).toBe("Invalid agent key");
  });

  it("falls back when the body says nothing useful", async () => {
    expect((await apiError(json({}, 500), "Failed to fetch rentals")).message)
      .toBe("Failed to fetch rentals");
    expect((await apiError(json({ detail: "x" }, 500), "Failed to fetch rentals")).message)
      .toBe("Failed to fetch rentals");
  });

  it("falls back on an empty body", async () => {
    const empty = new Response("", { status: 502 });
    expect((await apiError(empty, "Failed to fetch")).message).toBe("Failed to fetch");
  });

  it("never quotes an HTML page into a toast", async () => {
    // A sleeping container answers with a full error page, and a proxy will
    // answer a missing route with the SPA shell. Either would put a web page
    // in the corner of the screen.
    const html = new Response("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const err = await apiError(html, "Failed to fetch rentals");
    expect(err.message).toBe("Failed to fetch rentals");
    expect(err.message).not.toContain("DOCTYPE");
  });

  it("truncates a very long message", async () => {
    const err = await apiError(json({ message: "x".repeat(5000) }, 500), "Failed");
    expect(err.message.length).toBeLessThanOrEqual(401);
    expect(err.message.endsWith("…")).toBe(true);
  });

  it("falls back rather than throwing on malformed JSON", async () => {
    const bad = new Response("{not json", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(apiError(bad, "Failed to fetch")).resolves.toBeInstanceOf(Error);
    expect((await apiError(bad, "Failed to fetch")).message).toBe("Failed to fetch");
  });

  it("falls back rather than throwing on an already-read body", async () => {
    // Some callers parse a 400 before reaching the generic branch.
    const res = json({ message: "validation failed" }, 400);
    await res.text();
    expect((await apiError(res, "Failed to create rental")).message)
      .toBe("Failed to create rental");
  });
});

describe("the hooks actually use it", () => {
  it("no hook throws a bare fixed string any more", async () => {
    const { readdirSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const dir = join(__dirname, "..", "hooks");

    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, file), "utf-8");
      for (const m of src.matchAll(/throw new Error\("(Failed to [^"]*)"\)/g)) {
        offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(
      offenders,
      "use `throw await apiError(res, \"...\")` so the server's own message " +
      "survives — a fixed string is what made a 500 on /api/rentals unreadable"
    ).toEqual([]);
  });
});
