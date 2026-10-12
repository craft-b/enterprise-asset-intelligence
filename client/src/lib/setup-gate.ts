// client/src/lib/setup-gate.ts
//
// Whether the viewer has chosen to leave the setup screen without seeding.
//
// ProtectedRoute sends anyone to /setup while the system reports seeded:false,
// which is `equipmentCount > 0`. That is right for a first visit and wrong
// immediately afterwards: "Start Fresh" means "I will add my own equipment",
// but adding equipment requires the app, and the app is behind the guard until
// equipment exists. Both buttons on that page navigated to "/" and were
// bounced straight back. The deadlock is only escapable by seeding demo data,
// which is exactly what the viewer declined.
//
// So the choice is remembered and the guard honours it. Deliberately
// client-side: it is a per-viewer preference about navigation, carries nothing
// anyone else needs, and should not become a column.
//
// Kept in memory as well as localStorage so it still works in a private window
// or with site data blocked -- there the choice lasts the session, which is
// enough to get through, rather than failing closed back into the loop.

const STORAGE_KEY = "eai.setup-gate-dismissed";

/** Survives a blocked or unavailable localStorage, for this page load. */
let dismissedInMemory = false;

/** True once the viewer has chosen to skip seeding. */
export function isSetupGateDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private window, blocked site data, or no storage at all.
    return false;
  }
}

/** Record that the viewer wants into the app without seeding. */
export function dismissSetupGate(): void {
  dismissedInMemory = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Non-fatal: the in-memory flag carries this page load.
  }
}

/**
 * Forget the choice.
 *
 * Called when the system becomes seeded, so a later reset shows the setup
 * screen again rather than silently skipping it forever.
 */
export function resetSetupGate(): void {
  dismissedInMemory = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage was never available.
  }
}
