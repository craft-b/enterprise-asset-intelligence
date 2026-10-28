// server/services/model-status.ts
//
// Which model is actually scoring.
//
// This was answered by reading the filesystem:
//
//     const registryPath = path.join(process.cwd(), 'ml-service', 'registry');
//     const files = fs.readdirSync(registryPath).filter(...)
//     ...
//     } catch { return 'rule-based'; }
//
// The API and the ML service are separate Docker images. ml-service/registry
// exists in the ML image; the API container has never had it. So in
// production readdirSync throws ENOENT, the catch swallows it, and the answer
// is "rule-based" -- every time, no matter what is loaded.
//
// It worked perfectly in development, where the monorepo has the folder on
// disk, which is why it survived. The deployed dashboard has been telling
// visitors that this platform scores with rules while the champion model is
// loaded and serving, and the stored predictions it displays alongside that
// label came from the model.
//
// So ask the service. It is the only thing that knows what it loaded, and it
// already says so on /health. When it is asleep, the database is the next
// best witness: whatever model produced the newest stored prediction is what
// the numbers on screen actually came from, which is arguably the more
// honest answer of the two.

import { sql } from "drizzle-orm";
import { db } from "../db";
import { getMlHealth } from "./ml-health-cache";
import { COLD_START } from "./imputation";

/** What the rule writes into model_version, so a stored row is self-describing. */
const RULE_PREFIX = "rule:";

export interface ModelStatusDeps {
  health?: typeof getMlHealth;
  latestModelVersion?: () => Promise<string | null>;
}

async function latestStoredModelVersion(): Promise<string | null> {
  const [rows] = (await db.execute(sql`
    SELECT model_version FROM equipment_failure_predictions
    ORDER BY id DESC LIMIT 1
  `)) as any;
  return rows?.[0]?.model_version ?? null;
}

/** Turn a stored model_version into the dashboard's label. */
export function labelFor(version: string | null): string {
  if (!version) return "unknown";
  if (version.startsWith(RULE_PREFIX) || version === COLD_START.modelTag) return "rule-based";
  return `ml-${version}`;
}

/**
 * The model behind the numbers, as a short label.
 *
 * Never throws: this is one field of a status payload, and a status endpoint
 * that 500s because it could not name a model is worse than one that says
 * "unknown".
 */
export async function getModelStatus(deps: ModelStatusDeps = {}): Promise<string> {
  const health = deps.health ?? getMlHealth;
  const latest = deps.latestModelVersion ?? latestStoredModelVersion;

  try {
    const h = await health();
    if (h.reachable && h.modelLoaded && h.modelVersion) {
      return labelFor(h.modelVersion);
    }
  } catch {
    // Fall through to the database.
  }

  try {
    return labelFor(await latest());
  } catch {
    return "unknown";
  }
}
