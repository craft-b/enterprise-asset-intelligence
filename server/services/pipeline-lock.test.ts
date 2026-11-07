import { describe, it, expect, vi } from "vitest";

const seed = { status: "idle" };
vi.mock("./seed-orchestrator", () => ({ getSeedStatus: () => seed }));

const { runExclusive, pipelineBusy } = await import("./pipeline-lock");

describe("runExclusive", () => {
  it("refuses a second job while the first runs, naming the first", async () => {
    let finish!: () => void;
    const first = runExclusive("simulation", () => new Promise<void>((r) => { finish = r; }));
    expect(await runExclusive("labeling", async () => "ran")).toEqual({ ok: false, busy: "simulation" });
    finish();
    expect(await first).toEqual({ ok: true, value: undefined });
  });

  it("frees the lock when a job throws", async () => {
    await expect(runExclusive("simulation", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(pipelineBusy()).toBeNull();
    expect(await runExclusive("labeling", async () => 1)).toEqual({ ok: true, value: 1 });
  });

  it("treats a running demo seed as busy", async () => {
    seed.status = "running";
    expect(await runExclusive("simulation", async () => 1)).toEqual({ ok: false, busy: "demo seed" });
    seed.status = "idle";
  });
});
