// A new champion has to reach a deployment that already holds an old one's
// metrics. The boot check asked whether the table had any rows, so v2.0 never
// arrived and the live page kept v1.17's 0.88 AUC under a v2.0 champion.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, mlFetch } = vi.hoisted(() => ({ execute: vi.fn(), mlFetch: vi.fn() }));

vi.mock("../db", () => ({ db: { execute } }));
vi.mock("./ml-client", () => ({ mlFetch, describeMlFailure: vi.fn() }));

import { registerChampionIfMissing } from "./champion-metrics";

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
