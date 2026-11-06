// A new champion has to reach a deployment that already holds an old one's
// metrics. The boot check asked whether the table had any rows, so v2.0 never
// arrived and the live page kept v1.17's 0.88 AUC under a v2.0 champion.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, mlFetch } = vi.hoisted(() => ({ execute: vi.fn(), mlFetch: vi.fn() }));

vi.mock("../db", () => ({ db: { execute } }));
vi.mock("./ml-client", () => ({ mlFetch, describeMlFailure: vi.fn() }));

import { modelToShow, registerChampionIfMissing } from "./champion-metrics";

const statement = (call: any[]) => JSON.stringify(call[0]);
const inserted = () => execute.mock.calls.some(c => statement(c).includes("INSERT INTO model_metrics"));

/** The table holds only these versions. */
function tableHolds(...versions: string[]) {
  execute.mockImplementation(async (query: any) => {
    const text = JSON.stringify(query);
    if (!text.includes("SELECT 1")) return [[]];
    return [versions.some(v => text.includes(`"${v}"`)) ? [{ 1: 1 }] : []];
  });
}

beforeEach(() => {
  execute.mockReset();
  mlFetch.mockReset();
  mlFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      metrics: { "30": { version: "v2.0", roc_auc: 0.72, trained_at: "2026-11-04T00:00:00" } },
    }),
  });
});

describe("registering the champion at boot", () => {
  it("adds a new champion beside an older model's metrics", async () => {
    tableHolds("v1.17");
    await registerChampionIfMissing();
    expect(inserted()).toBe(true);
  });

  it("leaves a champion that is already registered alone", async () => {
    tableHolds("v1.17", "v2.0");
    await registerChampionIfMissing();
    expect(inserted()).toBe(false);
  });

  it("does not fail startup when the ML service is unreachable", async () => {
    mlFetch.mockRejectedValue(new Error("down"));
    await expect(registerChampionIfMissing()).resolves.toBeUndefined();
  });
});

// A seed that passes the gate trains a challenger. Its rows are the newest, and
// the page showed its AUC while the champion kept serving.
describe("choosing the model the pages show", () => {
  const rowsFor = (champion: unknown[], newest: unknown[]) =>
    execute.mockImplementation(async (query: any) =>
      [JSON.stringify(query).includes("ORDER BY") ? newest : champion]);

  it("shows the champion over a newer challenger", async () => {
    rowsFor([{ modelVersion: "v2.0" }], [{ modelVersion: "v2.1" }]);
    expect((await modelToShow("v2.0"))?.modelVersion).toBe("v2.0");
  });

  it("falls back to the newest metrics when the champion has none", async () => {
    rowsFor([], [{ modelVersion: "v2.1" }]);
    expect((await modelToShow("v2.0"))?.modelVersion).toBe("v2.1");
  });

  it("falls back to the newest metrics when no champion is known", async () => {
    rowsFor([{ modelVersion: "v2.0" }], [{ modelVersion: "v2.1" }]);
    expect((await modelToShow(null))?.modelVersion).toBe("v2.1");
  });
});
