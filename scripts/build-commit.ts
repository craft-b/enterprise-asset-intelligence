// scripts/build-commit.ts
//
// Which commit built the client bundle.
//
// The API has answered this since it started reporting RENDER_GIT_COMMIT from
// /api/health. The client answered nothing, and the gap cost a diagnosis: a
// push to main never triggered a Vercel build, the SPA kept serving the
// previous bundle, and because a stale page loads and looks correct there was
// no symptom. Working out which commit was live meant fetching the bundle and
// grepping it for sentences whose commit of origin I happened to remember --
// which only worked because I had written them.
//
// A deploy that silently builds the wrong commit is the same failure as a
// deploy that does not happen, and neither is visible from outside without a
// stamp. This is the stamp, and it is deliberately in the <head> of index.html
// rather than behind a login, so checking is one unauthenticated request:
//
//   curl -s https://<host>/ | grep build-commit
//
// Precedence mirrors server/routes.ts so both planes answer in the same
// vocabulary and a reader can compare the two without converting anything.

import { execFileSync } from "child_process";

/**
 * Resolve the stamp from the build environment, falling back to the checkout.
 *
 * Pure, so the precedence can be tested without a build. `gitShort` is
 * injected for the same reason: a CI runner with no .git directory is a real
 * case, and it must produce "unknown" rather than throwing and failing a
 * build over a cosmetic field.
 */
export function resolveBuildCommit(
  env: Record<string, string | undefined>,
  gitShort: () => string | null,
): string {
  // Vercel first: it builds the client, so on the deploy this exists for, it
  // is the authoritative answer. Render and the generic name follow so a
  // container build or a CI runner can stamp too.
  //
  // First non-empty rather than `a ?? b ?? c`: a variable that is *set but
  // empty* is a real state on a CI runner, and `??` only skips null and
  // undefined, so an empty VERCEL_GIT_COMMIT_SHA would win against a
  // perfectly good RENDER_GIT_COMMIT and stamp nothing. server/routes.ts
  // resolves the API's stamp with `??` and has this edge; it has never been
  // hit because Render sets its variable or leaves it unset.
  const fromEnv =
    [env.VERCEL_GIT_COMMIT_SHA, env.RENDER_GIT_COMMIT, env.GIT_COMMIT]
      .map(v => (v ?? "").trim())
      .find(v => v !== "") ?? "";

  const stamped = fromEnv.slice(0, 7);
  if (stamped) return stamped;

  const local = (gitShort() ?? "").trim().slice(0, 7);
  return local || "unknown";
}

/** `git rev-parse` against the checkout, or null when there isn't one. */
export function gitShortHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No git, no .git directory, or a detached worktree the runner cannot
    // read. None of these should fail a build.
    return null;
  }
}

/** The stamp for this build. */
export function buildCommit(): string {
  return resolveBuildCommit(process.env, gitShortHead);
}
