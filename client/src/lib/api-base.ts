// client/src/lib/api-base.ts
//
// Where the API lives, and the single place that decides it.
//
// In development and in the Docker stack the SPA is served from the same
// origin as the API, so every call can be a relative "/api/..." path. When the
// SPA is hosted separately -- a static host for the frontend, a container for
// the API -- those paths resolve against the static host and 404.
//
// There are ~80 fetch() call sites across components and hooks, all written
// with relative paths. Rewriting each one would be a large diff that a new call
// site could silently fall out of, so instead the resolution happens once, in a
// wrapper around the global fetch. A relative /api path keeps working
// everywhere, and a component cannot forget to use it.
//
// VITE_API_URL is baked in at BUILD time (Vite inlines import.meta.env), not
// read at runtime. The static host must have it set when it builds.
//
//   unset / empty  -> same origin, the wrapper is not installed at all
//   https://host   -> /api/* is rewritten to that origin, with credentials

/** API origin, without a trailing slash. Empty means same-origin. */
export const API_BASE: string = (import.meta.env.VITE_API_URL ?? "")
  .toString()
  .trim()
  .replace(/\/+$/, "");

/** Paths that belong to the API and should be redirected to API_BASE. */
const API_PREFIX = "/api";

/**
 * True for a path this module owns: root-relative and under /api.
 *
 * Deliberately narrow. Absolute URLs are left alone (they already name their
 * host), and so is everything else the page loads -- /assets, favicon, fonts --
 * which must keep resolving against the static host.
 */
export function isApiPath(value: string): boolean {
  return value === API_PREFIX || value.startsWith(`${API_PREFIX}/`);
}

/** Rewrite one URL against `base`, or return it unchanged. */
export function resolveApiUrl(value: string, base: string = API_BASE): string {
  if (!base) return value;
  return isApiPath(value) ? base + value : value;
}

type FetchFn = (input: any, init?: RequestInit) => Promise<Response>;

/**
 * Wrap a fetch so API calls go to `base` and carry cookies.
 *
 * Cross-site cookies need credentials on every request, not just the ones that
 * remembered to ask: the session cookie is what authenticates all of them. The
 * server pairs this with an explicit CORS allowlist -- `credentials: include`
 * is incompatible with a wildcard origin, so a wildcard would fail anyway.
 */
export function createApiFetch(nativeFetch: FetchFn, base: string = API_BASE): FetchFn {
  if (!base) return nativeFetch;

  return (input: any, init?: RequestInit): Promise<Response> => {
    // Request object: URL is read-only, so rebuild it around the new URL.
    if (typeof Request !== "undefined" && input instanceof Request) {
      const url = new URL(input.url);
      if (!isApiPath(url.pathname)) return nativeFetch(input, init);
      return nativeFetch(
        new Request(base + url.pathname + url.search + url.hash, input),
        { credentials: "include", ...init }
      );
    }

    const asString = typeof input === "string" ? input : String(input);
    if (!isApiPath(asString)) return nativeFetch(input, init);

    return nativeFetch(resolveApiUrl(asString, base), {
      ...init,
      credentials: init?.credentials ?? "include",
    });
  };
}

/**
 * Install the wrapper on `scope` once. No-op when same-origin, and idempotent
 * so hot reload does not wrap a wrapper.
 */
export function installApiFetch(scope: any = globalThis, base: string = API_BASE): void {
  if (!base || !scope?.fetch || scope.__apiFetchInstalled) return;
  scope.fetch = createApiFetch(scope.fetch.bind(scope), base);
  scope.__apiFetchInstalled = true;
}
