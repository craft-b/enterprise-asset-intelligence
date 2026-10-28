// client/src/pages/login-cold-start.test.ts
//
// Signing in is the first thing anyone does with this demo, and on free
// hosting the API suspends when idle, so the first attempt after a quiet
// period waits about thirty seconds for a host to start.
//
// The button said "Authenticating..." for all of it. For most of that time it
// is not authenticating anything -- the request has not reached the server.
// A spinner naming a step the system has not got to is the same defect as the
// drift cards describing a state the data was not in, and as the pipeline
// indicator that advanced on a timer: indistinguishable from the system
// working, right up until the visitor closes the tab.
//
// Asserted against the source because this page needs a DOM to render and
// jsdom is deliberately not installed (see vitest.config.ts) -- the same
// approach drift-card-copy.test.ts takes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const PAGE = readFileSync(join(__dirname, "login.tsx"), "utf-8");

/** The page with comments stripped, so prose about the fix is not the fix. */
function stripComments(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");
}

const CODE = stripComments(PAGE);

describe("the sign-in button accounts for the wait", () => {
  it("explains the cold start rather than only spinning", () => {
    expect(CODE).toContain("suspends when idle");
    expect(CODE).toContain("about 30 seconds");
  });

  it("says the request has not reached the server yet", () => {
    // The distinction that makes the message worth showing: this is not a
    // slow sign-in, and it is not a failure either.
    expect(CODE).toContain("has not reached the server yet");
  });

  it("waits before saying anything", () => {
    // A warm sign-in answers in well under this, and showing the notice every
    // time would make it furniture rather than information.
    expect(CODE).toMatch(/elapsed >= \d+/);
  });

  it("only counts while a request is in flight", () => {
    // Left running, the counter would report the age of the page rather than
    // the age of the attempt, and the notice would appear on an idle form.
    expect(CODE).toMatch(/if \(!isPending\) \{ setElapsed\(0\); return; \}/);
  });

  it("does not read the clock during render", () => {
    // React's rules: Date.now() in render is an impure call. eslint catches
    // this in the other repo; there is no such rule configured here, so it is
    // asserted instead.
    const renderBody = CODE.split("return (")[0];
    expect(renderBody).not.toContain("Date.now()");
  });

  it("still labels the button honestly while pending", () => {
    // The spinner text is not the problem and should stay; the missing
    // context was.
    expect(CODE).toContain("Authenticating...");
  });
});
