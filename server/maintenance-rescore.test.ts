import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// Logging maintenance rescored the unit twice: the server through the
// single-asset path, which calls the LLM, and the client through batch, which
// never does. The newest row wins, so template text replaced the LLM's on
// every service, with nothing in any log to say so.

const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf-8");

describe("logging maintenance has one rescore writer", () => {
  it("the client does not follow up with a batch rescore", () => {
    for (const file of ["client/src/hooks/use-maintenance.ts", "client/src/components/equipment-detail-view.tsx"]) {
      expect(read(file), file).not.toMatch(/fetch\(\s*['"]\/api\/risk-score\/multi-horizon\/batch/);
    }
  });

  it("the server finishes the rescore before it answers", () => {
    const routes = read("server/routes.ts");
    const start = routes.indexOf("app.post('/api/maintenance'");
    const handler = routes.slice(start, routes.indexOf("app.put('/api/maintenance/:id'", start));
    expect(handler).not.toContain("setImmediate");
    expect(handler.indexOf("mlFetch('/predict/multi-horizon'")).toBeGreaterThan(-1);
    expect(handler.indexOf("mlFetch('/predict/multi-horizon'"))
      .toBeLessThan(handler.indexOf("res.status(201)"));
  });
});
