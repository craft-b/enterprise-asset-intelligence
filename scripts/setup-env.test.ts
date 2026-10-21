// scripts/setup-env.test.ts
//
// The documented first run was `cp .env.example .env && docker-compose up`,
// and it could not work. session-store.ts lists the example file's own
// placeholder in REJECTED_SECRETS:
//
//   const REJECTED_SECRETS = new Set([
//     "dev_secret_key",
//     "replace-with-64-char-random-hex",   <-- .env.example's SESSION_SECRET
//     ...
//
// and the compose stack sets NODE_ENV=production, where that rejection is a
// thrown error rather than a warning. So the instructions produced a
// container that exited on the value the instructions had just supplied.
//
// The last test here is the one that matters: it feeds the generated secret
// to the real resolveSessionSecret under NODE_ENV=production, so the claim
// "this .env boots" is checked against the code that decides it rather than
// against a regex.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderEnv } from "./setup-env";
import { resolveSessionSecret } from "../server/services/session-store";

const EXAMPLE = readFileSync(join(import.meta.dirname, "..", ".env.example"), "utf-8");

const SECRETS = {
  sessionSecret: "a".repeat(64),
  agentApiKey: "b".repeat(64),
  mlServiceToken: "c".repeat(64),
};

const render = (dbHost = "db") => renderEnv(EXAMPLE, { dbHost, secrets: SECRETS });

/** Read one key out of a rendered env file. */
function value(rendered: string, key: string): string | undefined {
  for (const line of rendered.split("\n")) {
    const match = new RegExp(`^${key}=(.*)$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

describe("the generated .env points at the compose database", () => {
  it("uses the db service name", () => {
    const out = render();
    expect(value(out, "DB_HOST")).toBe("db");
    expect(value(out, "DATABASE_URL")).toBe("mysql://eai:eai@db:3306/enterprise_assets");
  });

  it("keeps DATABASE_URL and the DB_* vars describing one database", () => {
    // The Node server reads DATABASE_URL, the Python service reads DB_*. They
    // disagreeing is the failure where Node writes rows the ML service cannot
    // see, which looks like an empty dashboard rather than a config error.
    const out = render();
    const url = value(out, "DATABASE_URL")!;
    expect(url).toContain(`@${value(out, "DB_HOST")}:${value(out, "DB_PORT")}/`);
    expect(url).toContain(`${value(out, "DB_USER")}:${value(out, "DB_PASSWORD")}@`);
    expect(url.endsWith(`/${value(out, "DB_NAME")}`)).toBe(true);
  });

  it("switches to localhost for npm run dev", () => {
    const out = render("localhost");
    expect(value(out, "DB_HOST")).toBe("localhost");
    expect(value(out, "DATABASE_URL")).toContain("@localhost:3306/");
  });
});

describe("the generated .env can actually boot", () => {
  it("writes a session secret the production check accepts", () => {
    const secret = value(render(), "SESSION_SECRET")!;
    expect(resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: secret })).toBe(secret);
  });

  it("does not leave the placeholder the example file ships", () => {
    const out = render();
    expect(out).not.toContain("SESSION_SECRET=replace-with-64-char-random-hex");
    expect(value(out, "AGENT_API_KEY")).not.toBe("replace-with-64-char-random-hex");
    expect(value(out, "ML_SERVICE_TOKEN")).not.toBe("replace-with-64-char-random-hex");
  });

  it("gives the three secrets distinct values", () => {
    // One generated value reused for all three would pass every other test
    // here and make the ML service token guessable from the agent key.
    const out = render();
    const used = [
      value(out, "SESSION_SECRET"),
      value(out, "AGENT_API_KEY"),
      value(out, "ML_SERVICE_TOKEN"),
    ];
    expect(new Set(used).size).toBe(3);
  });

  it("enables the demo accounts, uncommenting the example's line", () => {
    const out = render();
    expect(value(out, "SEED_DEMO_USERS")).toBe("true");
    expect(out).not.toContain("# SEED_DEMO_USERS=true");
  });
});

describe("it stays honest about the example file", () => {
  it("preserves the explanatory comments", () => {
    // The .env someone opens and edits is the only documentation of these
    // variables they are guaranteed to read.
    const out = render();
    expect(out).toContain("# \u2500\u2500 Database");
    expect(out).toContain("NEVER commit .env to git");
  });

  it("leaves variables it has no business inventing alone", () => {
    const out = render();
    expect(value(out, "GROQ_API_KEY")).toBe("gsk_...");
    expect(value(out, "LLM_PROVIDER")).toBe("groq");
  });

  it("fails loudly if a variable disappears from .env.example", () => {
    // Silently dropping it would move the error to boot time, where it reads
    // as a bug in the app rather than a drift between two files.
    const stripped = EXAMPLE.split("\n")
      .filter(l => !/^(#\s*)?SESSION_SECRET=/.test(l))
      .join("\n");
    expect(() => renderEnv(stripped, { dbHost: "db", secrets: SECRETS })).toThrow(/SESSION_SECRET/);
  });
});
