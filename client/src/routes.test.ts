// client/src/routes.test.ts
//
// Every in-app navigation target must have a route, or the visitor lands on
// NotFound.
//
// Two shipped at once, both on the dashboard's EMPTY state -- the first screen
// a new visitor sees. "Add Equipment" pointed at /equipment/new and "Explore ML
// Features" at /ml-dashboard; neither route exists (/equipment and
// /ml-performance do). Nothing in the type system connects a href string to a
// Route path, so this reads both out of the source and compares them.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(__dirname);

/** Paths registered as <Route path="..."> in App.tsx. */
function registeredRoutes(): string[] {
  const app = readFileSync(join(SRC, "App.tsx"), "utf-8");
  return [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1]);
}

/** Every .ts/.tsx file under client/src. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** In-app navigation targets: <Link href="/..."> and setLocation("/..."). */
function navigationTargets(): Array<{ target: string; file: string }> {
  const found: Array<{ target: string; file: string }> = [];
  for (const file of sourceFiles()) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const text = readFileSync(file, "utf-8");
    const patterns = [
      /href="(\/[^"]*)"/g,
      /setLocation\(\s*[`'"]([^`'"]+)/g,
    ];
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        const target = m[1].replace(/\$\{[^}]*\}/g, "X").split("?")[0];
        if (target.startsWith("/")) {
          found.push({ target, file: file.slice(SRC.length + 1).replace(/\\/g, "/") });
        }
      }
    }
  }
  return found;
}

function isServed(target: string, routes: string[]): boolean {
  return routes.some(route => {
    const pattern =
      "^" +
      route
        .split("/")
        .map(seg => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/") +
      "$";
    return new RegExp(pattern).test(target);
  });
}

describe("SPA navigation", () => {
  const routes = registeredRoutes();

  it("registers the routes the app is built around", () => {
    expect(routes).toContain("/");
    expect(routes).toContain("/equipment");
    expect(routes).toContain("/ml-performance");
    expect(routes.length).toBeGreaterThan(5);
  });

  it("finds navigation targets to check", () => {
    // Guards the test itself: a regex that matches nothing would pass silently.
    expect(navigationTargets().length).toBeGreaterThan(5);
  });

  it("every link and redirect points at a registered route", () => {
    const dead = navigationTargets().filter(({ target }) => !isServed(target, routes));

    const detail = dead.map(d => `${d.target}  (${d.file})`).join("\n  ");
    expect(dead, dead.length ? `dead navigation targets:\n  ${detail}` : "").toEqual([]);
  });

  it("the dashboard empty state does not send a new visitor to NotFound", () => {
    // The specific regression: both calls to action on the first screen a new
    // visitor sees were 404s.
    const dashboard = readFileSync(join(SRC, "pages", "dashboard.tsx"), "utf-8");
    const targets = [...dashboard.matchAll(/href="(\/[^"]*)"/g)].map(m => m[1]);

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(isServed(target, routes), `${target} has no route`).toBe(true);
    }
  });
});
