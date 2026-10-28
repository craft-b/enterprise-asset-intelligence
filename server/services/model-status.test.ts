// server/services/model-status.test.ts
//
// The deployed dashboard said "rule-based" while the champion model was
// loaded, serving, and producing the very predictions displayed beside the
// label.
//
// The old implementation read the filesystem for ml-service/registry/*.pkl
// from inside the API container. The API and the ML service are separate
// Docker images; that directory has only ever existed in the ML one. So
// readdirSync threw ENOENT, a bare `catch { return 'rule-based' }` swallowed
// it, and the answer was always the same.
//
// It was correct in development, where the monorepo has the folder on disk.
// That is the whole reason it lasted: the only environment where it lied was
// the only environment anyone else would see.

import { describe, it, expect, vi } from "vitest";

vi.mock("../db", () => ({ db: { execute: async () => [[]] } }));
vi.mock("./ml-health-cache", () => ({ getMlHealth: async () => ({ reachable: false }) }));

const { getModelStatus, labelFor } = await import("./model-status");
const { COLD_START } = await import("./imputation");

const health = (value: any) => () => Promise.resolve(value);
const stored = (value: string | null) => () => Promise.resolve(value);

describe("labelFor", () => {
  it("names a model version", () => {
    expect(labelFor("v1.17")).toBe("ml-v1.17");
  });

  it("recognises the cold-start rule by its own tag", () => {
    // The tag is the one the rule actually writes, imported rather than
    // retyped, so renaming it cannot leave this check matching nothing.
    expect(labelFor(COLD_START.modelTag)).toBe("rule-based");
    expect(COLD_START.modelTag.startsWith("rule:")).toBe(true);
  });

  it("says unknown rather than guessing", () => {
    expect(labelFor(null)).toBe("unknown");
  });
});

describe("when the ML service answers", () => {
  it("reports the model it has loaded", async () => {
    await expect(getModelStatus({
      health: health({ reachable: true, modelLoaded: true, modelVersion: "v1.17" }),
      latestModelVersion: stored("v0.1"),
    })).resolves.toBe("ml-v1.17");
  });

  it("does not trust a reachable service with no model loaded", async () => {
    // Reachable and useless are different states; a service that is up but
    // has not loaded a model must not be reported as scoring with one.
    await expect(getModelStatus({
      health: health({ reachable: true, modelLoaded: false, modelVersion: null }),
      latestModelVersion: stored("v1.17"),
    })).resolves.toBe("ml-v1.17");
  });
});

describe("when the ML service is asleep", () => {
  it("falls back to whatever produced the newest stored prediction", async () => {
    // On free hosting the service sleeps constantly, so this is the common
    // path, not the edge case. The database knows what the numbers on screen
    // actually came from.
    await expect(getModelStatus({
      health: health({ reachable: false, reason: "unreachable" }),
      latestModelVersion: stored("v1.17"),
    })).resolves.toBe("ml-v1.17");
  });

  it("reports rule-based only when the rule really scored", async () => {
    await expect(getModelStatus({
      health: health({ reachable: false }),
      latestModelVersion: stored(COLD_START.modelTag),
    })).resolves.toBe("rule-based");
  });

  it("says unknown on an empty predictions table", async () => {
    // A fresh system that has not scored anything has no model status, and
    // "rule-based" would be a claim about work that has not happened.
    await expect(getModelStatus({
      health: health({ reachable: false }),
      latestModelVersion: stored(null),
    })).resolves.toBe("unknown");
  });
});

describe("it never throws", () => {
  it("survives a health check that rejects", async () => {
    await expect(getModelStatus({
      health: () => Promise.reject(new Error("boom")),
      latestModelVersion: stored("v1.17"),
    })).resolves.toBe("ml-v1.17");
  });

  it("survives both sources failing", async () => {
    // One field of a status payload. A status endpoint that 500s because it
    // could not name a model is worse than one that says it does not know.
    await expect(getModelStatus({
      health: () => Promise.reject(new Error("boom")),
      latestModelVersion: () => Promise.reject(new Error("no database")),
    })).resolves.toBe("unknown");
  });
});

describe("the filesystem is not consulted", () => {
  it("does not read a registry directory", async () => {
    // The regression would be invisible in development, where the folder
    // exists and the old code returned the right answer.
    const src = await import("fs").then(fs =>
      fs.readFileSync(new URL("./model-status.ts", import.meta.url), "utf-8"));
    const code = src.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/readdirSync|readFileSync|existsSync/);
    expect(code).not.toContain("registry");
  });
});
