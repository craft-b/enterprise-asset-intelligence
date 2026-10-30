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
import { createHash } from "crypto";
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
  // Join backslash continuations first: a COPY may list several sources
  // across lines, and reading only the first silently under-reports what the
  // image carries -- which is exactly the kind of gap this file exists to
  // close. The last token is the destination, so it is dropped.
  const joined = final.replace(/\\\r?\n\s*/g, " ");
  return [...joined.matchAll(/^COPY --from=builder\s+(.+)$/gm)]
    .flatMap(m => {
      const parts = m[1].trim().split(/\s+/);
      return parts.slice(0, -1);
    })
    .map(p => p.replace("/app/", ""))
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

const NEWLINE = /\r?\n/;

describe("the images carry two registry globs, not the registry", () => {
  // The whole directory was copied into both under the comment "needed by
  // routes.ts to read feature importance files", then removed when that
  // stopped being true -- feature importance came over HTTP instead.
  //
  // It is partly true again, and for a reason worth recording. Feature
  // importance and hyperparameters are properties of a pinned model version;
  // they do not change between requests. Fetching them over HTTP made a static
  // fact depend on a service being awake, and on 2026-10-29 the host began
  // answering this API's requests to that service with a Cloudflare challenge.
  // Two panels went blank over values committed in this repository.
  //
  // So services/model-card.ts reads them from disk as a fallback, and the
  // images ship exactly two globs. The scoping is the point: the directory
  // from a git clone is ~1.7MB of superseded JSON, and from a working tree
  // that has trained locally it is 431MB of pickles, because .dockerignore
  // does not exclude registry/*.pkl. Neither glob can match a pickle.

  const GLOBS = [
    "ml-service/registry/metadata_30d_*.json",
    "ml-service/registry/feature_importance_30d_*.json",
  ];

  for (const [label, dockerfile] of [["production", PROD], ["compose", COMPOSE_SERVER]] as const) {
    it(`${label} copies both globs and not the bare directory`, () => {
      const copies = runtimeCopies(dockerfile);
      for (const glob of GLOBS) {
        expect(copies, `${label} is missing ${glob}`).toContain(glob);
      }
      // The directory itself would drag in the pickles the globs exclude.
      expect(copies).not.toContain("ml-service/registry");
      expect(copies).not.toContain("ml-service/registry/");
    });

    it(`${label} copies nothing from the registry that could be a pickle`, () => {
      const fromRegistry = runtimeCopies(dockerfile).filter(p => p.includes("ml-service/registry"));
      expect(fromRegistry.length).toBeGreaterThan(0);
      for (const path of fromRegistry) {
        expect(path, `${path} could match a .pkl`).toMatch(/\.json$/);
      }
    });
  }

  it("the reader asks for exactly what the images ship", () => {
    // The guard that ties the COPY globs to the code. A reader that reached
    // for metadata_10d_* or a .pkl would find nothing in the container while
    // working perfectly on a developer's machine, which is the failure the
    // original COPY removal was meant to make impossible.
    const card = read("server", "services/model-card.ts");
    expect(card).toContain("feature_importance_");
    expect(card).toContain("metadata_");
    expect(card, "the reader must use the horizon the images ship").toContain("30d");
    expect(card).not.toMatch(/\.pkl/);
  });
});

// ── The two ML images ────────────────────────────────────────────────────────
//
// The compose ML image shipped with no models and no way to get any. Its
// comment claimed they were "baked into the image at build time", but nothing
// baked them: registry/*.pkl is gitignored, so a fresh clone has only JSON,
// and `docker compose up --build` produced a service reporting
// model_loaded=false with every prediction failing. The production image has
// always extracted the committed bundle.
//
// Same root cause as the server images: two Dockerfiles for one service, only
// one of them exercised by a deployment.

const ML_PROD = read("ml-service", "Dockerfile");
const ML_COMPOSE = read("infrastructure", "docker", "Dockerfile.ml-service");

const shaArg = (dockerfile: string): string | null => {
  const m = dockerfile.match(/ARG MODEL_BUNDLE_SHA256="([a-f0-9]{64})"/);
  return m ? m[1] : null;
};

describe("both ML images can obtain a model", () => {
  it("each extracts the bundle at build time", () => {
    for (const [name, df] of [["production", ML_PROD], ["compose", ML_COMPOSE]] as const) {
      expect(df, `${name} ML image does not run fetch-models.py`).toContain("fetch-models.py");
      expect(df, `${name} ML image does not look for a committed bundle`).toContain("MODEL_BUNDLE_FILE");
    }
  });

  it("each runs the shared entrypoint", () => {
    // The entrypoint repairs an empty registry before starting uvicorn, which
    // is the case the compose volume mount creates: it shadows the baked
    // registry, so the build-time bake alone is invisible at runtime.
    for (const [name, df] of [["production", ML_PROD], ["compose", ML_COMPOSE]] as const) {
      expect(df, `${name} ML image bypasses the entrypoint`)
        .toMatch(/ENTRYPOINT\s*\[\s*"\/usr\/local\/bin\/docker-entrypoint\.sh"\s*\]/);
    }
  });

  it("neither leaves a CMD the entrypoint ignores", () => {
    expect(ML_COMPOSE).not.toMatch(/^CMD /m);
    expect(ML_PROD).not.toMatch(/^CMD /m);
  });

  it("pins the same bundle checksum in both", () => {
    // Different checksums would mean the two images can ship different models
    // while every other signal says they are the same service.
    const prod = shaArg(ML_PROD);
    const compose = shaArg(ML_COMPOSE);
    expect(prod, "production ML image pins no bundle checksum").toBeTruthy();
    expect(compose).toBe(prod);
  });
});

describe("the committed bundle matches its pinned checksum", () => {
  it("hashes to the value both Dockerfiles expect", () => {
    // The check that makes the pin mean something. Replacing the bundle
    // without updating the ARG would otherwise fail inside a Docker build --
    // the slowest, least informative place to discover it, and on the compose
    // path, one nobody runs.
    const bundle = readFileSync(join(ROOT, "ml-service", "models", "eai-models-v1.17.tar.gz"));
    const actual = createHash("sha256").update(bundle).digest("hex");
    expect(actual).toBe(shaArg(ML_PROD));
  });
});
