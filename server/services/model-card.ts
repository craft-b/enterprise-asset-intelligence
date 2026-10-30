// server/services/model-card.ts
//
// A model's own description of itself, read from the registry it ships with.
//
// Feature importance and hyperparameters are properties of a pinned model
// version. They do not change between requests, between scoring runs, or at
// all until a different champion is promoted. They were nevertheless fetched
// over HTTP from the ML service on every load of the model page, which made a
// static fact depend on a service being awake — and when the host put a
// challenge between the two services, two panels went blank over values
// committed in this repository.
//
// The files are the training run's own output: registry/metadata_30d_v*.json
// carries the hyperparameters the model was fitted with, and
// registry/feature_importance_30d_v*.json the importances it learned. 30d is
// the canonical horizon, matching the ML service's own choice for this
// endpoint.
//
// The ML service remains the better source when it is reachable, because a
// promoted champion is live before anything is committed. So it stays first
// and this is the fallback — which also means the panels keep working on a
// fresh clone with no ML service running at all.

import { readFile } from "fs/promises";
import { join } from "path";

const REGISTRY = join(process.cwd(), "ml-service", "registry");

/** The canonical horizon for model-level reporting. Mirrors the ML service. */
const CANONICAL_HORIZON = "30d";

export interface ModelCard {
  feature_importance: Record<string, number>;
  hyperparameters: Record<string, any>;
}

async function readJson(name: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(join(REGISTRY, name), "utf8"));
  } catch {
    // Missing or unparseable: the caller falls back to empty, which the UI
    // already renders as "unavailable" rather than as zero importance.
    return null;
  }
}

/**
 * Feature importance and hyperparameters for a model version, from disk.
 *
 * `version` is the champion's version string as recorded in model_metrics
 * (e.g. "v1.17"). Returns null when the registry has nothing for it, so a
 * caller can tell "no file" from "a file saying zero".
 */
export async function readModelCard(version: string | null | undefined): Promise<ModelCard | null> {
  if (!version) return null;
  const suffix = `${CANONICAL_HORIZON}_${version}.json`;

  const [importance, metadata] = await Promise.all([
    readJson(`feature_importance_${suffix}`),
    readJson(`metadata_${suffix}`),
  ]);

  if (!importance && !metadata) return null;

  return {
    feature_importance: importance ?? {},
    // The metadata file nests them; algorithm sits alongside rather than
    // inside, and the UI shows it in the same block.
    hyperparameters: {
      ...(metadata?.hyperparameters ?? {}),
      ...(metadata?.algorithm ? { algorithm: metadata.algorithm } : {}),
    },
  };
}
