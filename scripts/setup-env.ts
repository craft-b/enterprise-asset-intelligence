/**
 * setup-env.ts — writes a working .env.
 *
 * Usage:
 *   npm run setup:env            # for the docker-compose stack
 *   npm run setup:env -- --local # for `npm run dev` against a local MySQL
 *   npm run setup:env -- --force # overwrite an existing .env
 *
 * Why this exists: `cp .env.example .env && docker-compose up` did not work,
 * and failed in a way that looked like a bug in the app. The compose stack
 * sets NODE_ENV=production, and resolveSessionSecret rejects the example
 * file's SESSION_SECRET placeholder outright under production -- correctly,
 * since that is the check stopping a real deployment from booting with a
 * known signing key. The result was that the documented first run exited 1 on
 * a placeholder it had just been told to copy.
 *
 * So the secrets are generated rather than defaulted. Nothing fake is
 * committed to the repository and nothing has to be pasted by hand: the three
 * random values below are the three the app refuses to start without.
 */
import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");

/** 64 hex characters. SESSION_SECRET requires at least 32. */
const secret = () => randomBytes(32).toString("hex");

export interface EnvOptions {
  /** Hostname the database answers on: the compose service, or localhost. */
  dbHost: string;
  /** Generated per call, passed in so the renderer stays testable. */
  secrets: { sessionSecret: string; agentApiKey: string; mlServiceToken: string };
}

/**
 * Fill the example file in, line by line.
 *
 * Line-wise rather than regenerated from scratch so that every comment in
 * .env.example survives into the .env someone then reads and edits. That file
 * is the only documentation of these variables that a self-hoster is
 * guaranteed to open.
 */
export function renderEnv(example: string, opts: EnvOptions): string {
  const { dbHost, secrets } = opts;
  const user = "eai";
  const password = "eai";
  const name = "enterprise_assets";

  const values: Record<string, string> = {
    DATABASE_URL: `mysql://${user}:${password}@${dbHost}:3306/${name}`,
    DB_HOST: dbHost,
    DB_PORT: "3306",
    DB_USER: user,
    DB_PASSWORD: password,
    DB_NAME: name,
    SESSION_SECRET: secrets.sessionSecret,
    AGENT_API_KEY: secrets.agentApiKey,
    ML_SERVICE_TOKEN: secrets.mlServiceToken,
    // Commented out in the example file. Uncommented here: this .env
    // describes a stack on the local machine, where the login page naming its
    // own credentials is the whole point.
    SEED_DEMO_USERS: "true",
  };

  const seen = new Set<string>();

  // Split on either ending and rejoin with a single one. .env.example is
  // itself mixed -- 68 CRLF lines and 31 LF, courtesy of core.autocrlf --
  // and rewriting only the lines this script touches would hand back a file
  // whose endings alternate by whether a value happened to be generated.
  // dotenv parses both, so this is about the file being readable and
  // diffable by the person who opens it, not about it working.
  const out = example.split(/\r?\n/).map(line => {
    // Matches `KEY=...` and the commented `# KEY=...` form, but not prose in
    // a comment that happens to contain an equals sign.
    const match = /^(#\s*)?([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (!match) return line;
    const key = match[2];
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });

  // A key that vanished from .env.example would otherwise be dropped silently
  // and the app would fail later complaining about something unset.
  const missing = Object.keys(values).filter(k => !seen.has(k));
  if (missing.length > 0) {
    throw new Error(
      `.env.example no longer mentions ${missing.join(", ")} — ` +
        `update scripts/setup-env.ts alongside it`
    );
  }

  return out.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const local = args.includes("--local");

  const target = join(ROOT, ".env");
  if (existsSync(target) && !force) {
    console.error(
      ".env already exists — refusing to overwrite it.\n" +
        "Pass --force if that is what you want:  npm run setup:env -- --force"
    );
    process.exit(1);
  }

  const example = readFileSync(join(ROOT, ".env.example"), "utf-8");
  const rendered = renderEnv(example, {
    // `db` is the compose service name, resolved by Docker DNS. localhost is
    // for `npm run dev`, where the database is a MySQL you are running
    // yourself.
    dbHost: local ? "localhost" : "db",
    secrets: {
      sessionSecret: secret(),
      agentApiKey: secret(),
      mlServiceToken: secret(),
    },
  });

  writeFileSync(target, rendered, "utf-8");

  console.log(`Wrote .env for ${local ? "local development" : "docker-compose"}.`);
  console.log("  SESSION_SECRET, AGENT_API_KEY and ML_SERVICE_TOKEN were generated.");
  console.log("  Demo accounts (admin / viewer) will be created on first boot.");
  console.log();
  if (local) {
    console.log("Next:  create the database, then  npm run db:migrate  &&  npm run dev");
  } else {
    console.log("Next:  docker-compose up --build");
  }
  console.log();
  console.log("GROQ_API_KEY is left as a placeholder. It is only read when");
  console.log("GENAI_RECOMMENDATIONS=on; the default is off and uses the");
  console.log("deterministic recommendation template, so the stack runs without it.");
}

// Importable for tests without writing anything.
if (process.argv[1] && process.argv[1].endsWith("setup-env.ts")) main();
