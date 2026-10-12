// client/src/lib/setup-gate.test.ts
//
// The deadlock this escapes: ProtectedRoute redirects to /setup while
// seeded is false, seeded is equipmentCount > 0, and "Start Fresh" means the
// viewer intends to add that equipment themselves. Without a remembered
// choice, the only way out of /setup is to seed demo data -- which is what
// they just declined.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dismissSetupGate, isSetupGateDismissed, resetSetupGate } from "./setup-gate";

/** A minimal localStorage, or one that throws, installed on globalThis. */
function installStorage(mode: "working" | "throwing" | "absent") {
  const store = new Map<string, string>();
  const g = globalThis as any;

  if (mode === "absent") {
    g.window = {};
    return store;
  }

  const thrower = () => {
    throw new DOMException("denied", "SecurityError");
  };

  g.window = {
    localStorage: mode === "throwing"
      ? { getItem: thrower, setItem: thrower, removeItem: thrower }
      : {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        },
  };
  return store;
}

describe("setup gate", () => {
  beforeEach(() => {
    installStorage("working");
    resetSetupGate();
  });

  afterEach(() => {
    delete (globalThis as any).window;
    vi.restoreAllMocks();
  });

  it("is not dismissed initially, so first-time visitors still see setup", () => {
    expect(isSetupGateDismissed()).toBe(false);
  });

  it("is dismissed after the viewer chooses Start Fresh", () => {
    dismissSetupGate();
    expect(isSetupGateDismissed()).toBe(true);
  });

  it("persists across a reload", async () => {
    dismissSetupGate();

    // A reload keeps localStorage but loses module state, so re-import the
    // module rather than trusting the in-memory flag that is still set.
    vi.resetModules();
    const fresh = await import("./setup-gate");

    expect(fresh.isSetupGateDismissed()).toBe(true);
  });

  it("does not leak the choice to a viewer who never made it", async () => {
    // Same reload, but nothing was dismissed first.
    vi.resetModules();
    const fresh = await import("./setup-gate");

    expect(fresh.isSetupGateDismissed()).toBe(false);
  });

  it("can be cleared, so a reset shows setup again", () => {
    dismissSetupGate();
    resetSetupGate();
    expect(isSetupGateDismissed()).toBe(false);
  });

  describe("when storage is unavailable", () => {
    it("still works for the session when localStorage throws", () => {
      // Private windows and blocked site data raise on access. Failing closed
      // here would drop the viewer back into the loop.
      installStorage("throwing");
      resetSetupGate();

      expect(isSetupGateDismissed()).toBe(false);
      dismissSetupGate();
      expect(isSetupGateDismissed()).toBe(true);
    });

    it("still works when there is no localStorage at all", () => {
      installStorage("absent");
      resetSetupGate();

      dismissSetupGate();
      expect(isSetupGateDismissed()).toBe(true);
    });

    it("never throws out of any entry point", () => {
      installStorage("throwing");
      expect(() => isSetupGateDismissed()).not.toThrow();
      expect(() => dismissSetupGate()).not.toThrow();
      expect(() => resetSetupGate()).not.toThrow();
    });
  });

  it("treats an unrelated stored value as not dismissed", async () => {
    const store = installStorage("working");
    store.set("eai.setup-gate-dismissed", "maybe");

    vi.resetModules();
    const fresh = await import("./setup-gate");

    expect(fresh.isSetupGateDismissed()).toBe(false);
  });
});
