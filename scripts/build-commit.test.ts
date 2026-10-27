// scripts/build-commit.test.ts
//
// The stamp exists because a push to main did not trigger a Vercel build and
// nothing said so: the SPA served the previous bundle, which loads and renders
// correctly, so the only symptom was a sentence on one card being a version
// behind. Finding that out meant fetching the bundle and grepping it for prose
// whose commit of origin I happened to know.
//
// A stamp that is wrong, or that quietly reads "unknown" on the one deploy
// that matters, puts you back there while looking like it does not -- so the
// precedence is tested rather than assumed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveBuildCommit } from "./build-commit";

const never = () => null;
const git = (sha: string) => () => sha;

describe("resolveBuildCommit", () => {
  it("prefers Vercel, which is what builds the client", () => {
    expect(resolveBuildCommit({
      VERCEL_GIT_COMMIT_SHA: "986e20e1234567890",
      RENDER_GIT_COMMIT: "aaaaaaa",
      GIT_COMMIT: "bbbbbbb",
    }, never)).toBe("986e20e");
  });

  it("falls through the env chain in order", () => {
    expect(resolveBuildCommit(
      { RENDER_GIT_COMMIT: "aaaaaaa0000", GIT_COMMIT: "bbbbbbb" }, never
    )).toBe("aaaaaaa");
    expect(resolveBuildCommit({ GIT_COMMIT: "bbbbbbb0000" }, never)).toBe("bbbbbbb");
  });

  it("treats a set-but-empty variable as absent", () => {
    // The case `??` gets wrong. A CI runner that exports the name without a
    // value would otherwise win the chain and stamp nothing, which is worse
    // than no stamp because it looks like an answer.
    expect(resolveBuildCommit({
      VERCEL_GIT_COMMIT_SHA: "",
      RENDER_GIT_COMMIT: "aaaaaaa",
    }, never)).toBe("aaaaaaa");

    expect(resolveBuildCommit({
      VERCEL_GIT_COMMIT_SHA: "   ",
      RENDER_GIT_COMMIT: "aaaaaaa",
    }, never)).toBe("aaaaaaa");
  });

  it("uses the checkout when the build environment says nothing", () => {
    expect(resolveBuildCommit({}, git("c0ffee1"))).toBe("c0ffee1");
  });

  it("prefers the build environment over the checkout", () => {
    // On a deploy these disagree whenever the runner checks out a merge
    // commit, and the environment is the one that describes what shipped.
    expect(resolveBuildCommit({ VERCEL_GIT_COMMIT_SHA: "aaaaaaa" }, git("bbbbbbb")))
      .toBe("aaaaaaa");
  });

  it("says unknown rather than lying or throwing", () => {
    // No git directory is a real state on a runner, and a cosmetic field must
    // not fail a build.
    expect(resolveBuildCommit({}, never)).toBe("unknown");
    expect(resolveBuildCommit({}, git(""))).toBe("unknown");
  });

  it("shortens to seven, matching what /api/health reports", () => {
    // Both planes have to answer in the same vocabulary or comparing them
    // means converting one, which is the sort of step that gets skipped.
    const full = "986e20e9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6";
    expect(resolveBuildCommit({ VERCEL_GIT_COMMIT_SHA: full }, never)).toHaveLength(7);
    const health = readFileSync(
      join(__dirname, "..", "server", "routes.ts"), "utf-8"
    );
    expect(health).toMatch(/\.slice\(0,\s*7\)/);
  });
});

describe("the stamp reaches the served page", () => {
  const CONFIG = readFileSync(join(__dirname, "..", "vite.config.ts"), "utf-8");

  it("is installed as a plugin", () => {
    // Defined and never registered is the failure that would leave the page
    // unstamped while this file still passed.
    expect(CONFIG).toMatch(/plugins:\s*\[[\s\S]*buildStamp\(\)/);
  });

  it("writes the meta into the head, not into the app", () => {
    // Behind the login it would be useless for the thing it is for: checking
    // a deployed host without signing in to it.
    expect(CONFIG).toContain('transformIndexHtml');
    expect(CONFIG).toContain('name="build-commit"');
    expect(CONFIG).toContain("</head>");
  });

  it("records when the build ran as well as from what", () => {
    // Two deploys of one commit are a real case -- a manual redeploy of an
    // older deployment rebuilds that commit -- so the commit alone cannot
    // distinguish a fresh build from a replayed one.
    expect(CONFIG).toContain('name="build-time"');
  });
});
