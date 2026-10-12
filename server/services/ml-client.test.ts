// server/services/ml-client.test.ts
//
// The failure this prevents, observed on the deployed instance: a seed run
// reported "ML service train failed:" followed by an entire GitHub error page,
// rendered into the dialog. The model bundle's release URL had been entered
// into ML_SERVICE_URL, and `<release url>/train` is a real GitHub 404 page, so
// nothing failed until something called the service — and when it did, the
// message was a webpage.

import { describe, it, expect } from "vitest";
import { validateMlServiceUrl, describeMlFailure } from "./ml-client";

const RELEASE_URL =
  "https://github.com/craft-b/enterprise-asset-intelligence/releases/download/" +
  "models-v1.17/eai-models-v1.17.tar.gz";

describe("validateMlServiceUrl", () => {
  it("accepts the service origin", () => {
    expect(validateMlServiceUrl("https://eai-ml.onrender.com"))
      .toBe("https://eai-ml.onrender.com");
  });

  it("accepts a local service with a port", () => {
    expect(validateMlServiceUrl("http://localhost:8000")).toBe("http://localhost:8000");
  });

  it("normalises a trailing slash away", () => {
    // mlFetch appends "/train", so a trailing slash would give "//train".
    expect(validateMlServiceUrl("https://eai-ml.onrender.com/"))
      .toBe("https://eai-ml.onrender.com");
  });

  it("defaults to the local service when unset", () => {
    expect(validateMlServiceUrl(undefined)).toBe("http://localhost:8000");
    expect(validateMlServiceUrl("  ")).toBe("http://localhost:8000");
  });

  it("rejects the model bundle URL, which is what actually happened", () => {
    expect(() => validateMlServiceUrl(RELEASE_URL)).toThrow(/bare origin with no path/);
  });

  it("names the origin it would have accepted", () => {
    // So the fix is visible in the message rather than requiring a guess.
    expect(() => validateMlServiceUrl(RELEASE_URL)).toThrow(/https:\/\/github\.com/);
  });

  it("explains that a path usually means the wrong URL was pasted", () => {
    expect(() => validateMlServiceUrl(RELEASE_URL)).toThrow(/pasted into this variable/);
  });

  it("rejects any path, not only that one", () => {
    expect(() => validateMlServiceUrl("https://eai-ml.onrender.com/train"))
      .toThrow(/bare origin/);
    expect(() => validateMlServiceUrl("https://eai-ml.onrender.com/?x=1"))
      .toThrow(/bare origin/);
  });

  it("rejects something that is not a URL", () => {
    expect(() => validateMlServiceUrl("eai-ml.onrender.com")).toThrow(/not a valid URL/);
  });

  it("rejects a non-http scheme", () => {
    expect(() => validateMlServiceUrl("ftp://eai-ml.onrender.com")).toThrow(/http or https/);
  });
});

describe("describeMlFailure", () => {
  const response = (body: string, type: string, status = 404) =>
    new Response(body, { status, statusText: "Not Found", headers: { "content-type": type } });

  it("does not quote an HTML body back at the user", () => {
    const html = "<!DOCTYPE html><html><head><title>Oh no &middot; GitHub</title>" +
      "<style>".padEnd(4000, "x") + "</style></head></html>";

    return describeMlFailure(response(html, "text/html"), "/train").then(message => {
      expect(message).not.toContain("<!DOCTYPE");
      expect(message).not.toContain("<style");
      expect(message.length).toBeLessThan(400);
    });
  });

  it("says a web page answered and points at the variable to check", async () => {
    const message = await describeMlFailure(
      response("<html>...</html>", "text/html"),
      "/train"
    );

    expect(message).toMatch(/that is a web page, not the ML service/);
    expect(message).toMatch(/ML_SERVICE_URL/);
  });

  it("keeps a JSON error, which is the service talking", async () => {
    const message = await describeMlFailure(
      response('{"detail":"Invalid or missing service token"}', "application/json", 401),
      "/train"
    );

    expect(message).toContain("Invalid or missing service token");
  });

  it("names the URL the request actually went to", async () => {
    const message = await describeMlFailure(response("{}", "application/json"), "/train");
    expect(message).toMatch(/\/train/);
  });

  it("survives a body that cannot be read", async () => {
    const broken = {
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers({ "content-type": "text/html" }),
      text: () => Promise.reject(new Error("stream closed")),
    } as unknown as Response;

    await expect(describeMlFailure(broken, "/train")).resolves.toMatch(/502/);
  });
});

describe("gateway errors are not blamed on the URL", () => {
  const gateway = (status: number) =>
    new Response("<html>502 Bad Gateway</html>", {
      status,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  it.each([502, 503, 504])("explains that %s means the service did not answer", async code => {
    // The deployed instance returned 502 from the CORRECT origin while the
    // container was starting. Telling someone to check ML_SERVICE_URL there
    // sends them to re-verify a setting that is already right.
    const message = await describeMlFailure(gateway(code), "/train");

    expect(message).toMatch(/did not respond/);
    expect(message).toMatch(/waking from idle|out of memory/);
    expect(message).not.toMatch(/Check ML_SERVICE_URL/);
  });

  it("still blames the URL for an HTML 404, which is the misconfiguration", async () => {
    const notFound = new Response("<html>Oh no</html>", {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "text/html" },
    });

    const message = await describeMlFailure(notFound, "/train");
    expect(message).toMatch(/Check ML_SERVICE_URL/);
  });
});
