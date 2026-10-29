// scripts/dockerfile-parity.test.ts
//
// Two images build the same Node service, and they had silently diverged.
//
// The root Dockerfile is what runs in production. infrastructure/docker/
// Dockerfile.server is what `docker compose up --build` builds. The root one
// copies migrations/, shared/, drizzle.config.ts and tsconfig.json into the
// RUNTIME stage and runs docker-entrypoint.sh, which applies migrations before
// starting the server. Dockerfile.server copied none of them and had no
// entrypoint at all -- so the migrations docker-compose.yml promises "on boot"
// were never applied, and the stack came up against a database with no tables.
//
// Nobody noticed because nobody had run the compose stack. It is the one path
// in this repository with no deployment watching it: the production image is
// exercised by every push, and this one by a command in a README. A reader
// cloning the repo would have hit it on their first try.
//
// So the parity is derived rather than listed. Adding a fifth runtime
// dependency to the production image now fails this test until the compose
// image gets it too, which is the only version of this check that survives
// the next change.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const PROD = read("Dockerfile");
const COMPOSE_SERVER = read("infrastructure", "docker", "Dockerfile.server");
const COMPOSE = read("docker-compose.yml");

/**
 * The paths a Dockerfile's final stage copies out of the builder.
 *
 * Final stage only: the builder's own COPY lines describe the source tree, not
 * what survives into the image, and conflating the two is what let this bug
 * read as correct -- `COPY . .` in stage one looks like it covers everything.
 */
function runtimeCopies(dockerfile: string): string[] {
  const stages = dockerfile.split(/^FROM /m);
  const final = stages[stages.length - 1];
  return [...final.matchAll(/^COPY --from=builder\s+(\S+)/gm)]
    .map(m => m[1].replace("/app/", ""))
    .sort();
}

describe("the compose image carries what the production image carries", () => {
  it("copies every runtime dependency the production image does", () => {
    const prod = runtimeCopies(PROD);
    const compose = runtimeCopies(COMPOSE_SERVER);

    expect(prod.length, "parsed no runtime COPY lines from the production image").toBeGreaterThan(3);

    const missing = prod.filter(p => !compose.includes(p));
    expect(
      missing,
      `Dockerfile.server is missing runtime paths the production image copies: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("includes the four drizzle-kit needs at runtime", () => {
    // Named explicitly as well as derived, because this is the specific set
    // whose absence produced the defect and the failure was silent: the server
    // starts, answers /api/health, and only fails when something touches a
    // table. `drizzle-kit migrate` reads the config, the journal in
    // migrations/ and the schema in shared/ at run time, not build time.
    for (const path of ["migrations", "shared", "drizzle.config.ts", "tsconfig.json"]) {
      expect(runtimeCopies(COMPOSE_SERVER), `runtime image needs ${path}`).toContain(path);
    }
  });
});

describe("the migrations compose promises actually run", () => {
  it("builds a server image that uses the entrypoint", () => {
    // docker-compose.yml tells the reader "docker-entrypoint.sh applies the
    // migrations on boot". That sentence was false for the image it builds.
    expect(COMPOSE).toContain("docker-entrypoint.sh applies the");
    expect(COMPOSE_SERVER).toMatch(/ENTRYPOINT\s*\[\s*"\/usr\/local\/bin\/docker-entrypoint\.sh"\s*\]/);
    expect(COMPOSE_SERVER).toContain("COPY docker-entrypoint.sh");
  });

  it("does not leave a CMD that the entrypoint ignores", () => {
    // The old line was CMD ["node", "dist/index.cjs"]. Left in place beside an
    // ENTRYPOINT it is dead configuration that reads like the start command,
    // which is how someone would conclude migrations were not meant to run.
    expect(COMPOSE_SERVER).not.toMatch(/^CMD /m);
  });

  it("references an entrypoint script that exists", () => {
    expect(() => read("docker-entrypoint.sh")).not.toThrow();
    expect(read("docker-entrypoint.sh")).toContain("db:migrate");
  });

  it("keeps the migrate script the entrypoint calls", () => {
    // The entrypoint runs `npm run db:migrate`. A rename in package.json would
    // break every container start with an error no test otherwise covers.
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["db:migrate"]).toBeTruthy();
  });
});
