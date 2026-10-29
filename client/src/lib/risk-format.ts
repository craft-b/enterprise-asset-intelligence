// ─────────────────────────────────────────────────────────────────────────────
// Shared risk formatting — one source of truth for the risk color tokens and the
// plain-language driver dictionary, used by the command center and the
// predictive-maintenance dashboard (DESIGN_SPEC §5).
//
//   • Semantic risk is the ONLY saturated color family (HIGH/MEDIUM/LOW).
//   • Driver phrases are mechanic-facing, never raw model feature keys.
// ─────────────────────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

// Badge / outline treatment (surface + text + border).
export const RISK_COLORS: Record<RiskLevel, string> = {
  HIGH:   "bg-risk-high-surface text-risk-high border-risk-high",
  MEDIUM: "bg-risk-medium-surface text-risk-medium border-risk-medium",
  LOW:    "bg-risk-low-surface text-risk-low border-risk-low",
};

// Solid fills — bars, status dots.
export const RISK_FILL: Record<RiskLevel, string> = {
  HIGH:   "bg-risk-high",
  MEDIUM: "bg-risk-medium",
  LOW:    "bg-risk-low",
};

// Subtle row hovers — token-driven so they stay AA-correct in both themes.
export const RISK_HOVER: Record<RiskLevel, string> = {
  HIGH:   "hover:bg-risk-high/[0.06]",
  MEDIUM: "hover:bg-risk-medium/[0.06]",
  LOW:    "hover:bg-risk-low/[0.06]",
};

// Plain-language names for model feature keys. Every SHAP attribution bar goes
// through this map: `shap_attribution` is keyed by the pipeline's raw column
// names, so nothing shows as "wear_rate". (`top_risk_drivers` is a different
// path — the ML service emits finished prose there, which humanizeDriver passes
// through untouched.)
//
// These name the QUANTITY, never a direction. A label like "Short time between
// failures" is a bug: MTBF is a duration where high is good, and when SHAP
// correctly reports it as protective the row reads "Short time between failures
// — 22% protective", i.e. that frequent failures protect the asset. The sign
// and the colour carry direction — that is what the card legend promises — and
// expanding a row shows the unit's value against the fleet average.
export const DRIVER_LABELS: Record<string, string> = {
  wear_rate:                   "Wear rate",
  wear_rate_velocity:          "Wear rate acceleration",
  mechanical_wear_score:       "Mechanical wear",
  days_since_last_maintenance: "Days since last service",
  // A 0/1 indicator: "overdue" is the name of the flag, not an asserted direction.
  maint_overdue:               "Maintenance overdue",
  maintenance_events_90d:      "Maintenance events (90d)",
  maint_frequency_trend:       "Maintenance frequency trend",
  maintenance_cost_180d:       "Maintenance cost (180d)",
  maint_burden:                "Maintenance burden",
  cost_per_event:              "Cost per repair",
  cost_trend:                  "Repair cost trend",
  avg_downtime_per_event:      "Downtime per repair",
  mean_time_between_failures:  "Time between failures",
  usage_intensity:             "Duty cycle intensity",
  usage_trend:                 "Usage trend",
  hours_used_30d:              "Hours used (30d)",
  hours_used_90d:              "Hours used (90d)",
  hours_velocity:              "Hours accumulation rate",
  utilization_vs_expected:     "Utilization vs. plan",
  total_hours_lifetime:        "Lifetime hours",
  asset_age_years:             "Asset age",
  aging_factor:                "Aging factor",
  abuse_score:                 "Hard-use score",
  neglect_score:               "Neglect score",
  neglect_acceleration:        "Neglect acceleration",
  // Named for a vendor and a job site, but neither reads those tables. See
  // feature-engineering-enhanced.ts:401-413 — vendor_reliability_score is this
  // unit's own failure rate, and jobsite_risk_score is a linear combination of
  // utilization_vs_expected and usage_trend, both already model inputs. The
  // labels name what is measured; the column names are a known defect.
  jobsite_risk_score:          "Utilization exposure index",
  vendor_reliability_score:    "Maintenance frequency index",
  sensor_degradation_rate:     "Sensor degradation rate",
  avg_rental_duration:         "Average rental duration",
  rental_days_30d:             "Rental days (30d)",
  rental_days_90d:             "Rental days (90d)",
};

/** Turn a driver token into a clean, mechanic-facing phrase. */
export function humanizeDriver(key: string): string {
  if (!key) return key;
  // Scrub encoding artifacts: emoji / em-dashes that were stored as "?" or the
  // Unicode replacement char, so an investor never sees "?? Maintenance overdue".
  let s = key
    .replace(/�/g, "")
    .replace(/^[\s?]*\?\s*/, "")   // leading "?? " warning glyph
    .replace(/\s\?\s/g, " — ")      // stray " ? " that was an em-dash
    .trim();
  // Already a human-readable phrase (has whitespace or a colon)? Pass through.
  if (/[\s:]/.test(s)) return s;
  // Otherwise treat as a raw model feature key. SHAP attribution keys carry the
  // pipeline's transform prefix (log_maintenance_cost_180d) — the transform is
  // irrelevant to a mechanic, so map back to the underlying feature's phrase.
  const base = s.replace(/^log_/, "");
  if (DRIVER_LABELS[base]) return DRIVER_LABELS[base];
  return base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Tolerant JSON-array parse for driver-name columns persisted as text. */
export function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== "string") return [];
  try {
    const d = JSON.parse(raw || "[]");
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

/** Tolerant JSON-object parse for SHAP-attribution columns persisted as text. */
export function parseJsonObject(raw: unknown): Record<string, number> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, number>;
  if (typeof raw !== "string") return {};
  try {
    const d = JSON.parse(raw || "{}");
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

type DriverCarrier = { top_risk_drivers?: Record<string, number> | string[] } | undefined | null;

/** The single most important driver for a prediction, as a plain phrase. */
export function topDriverLabel(pred: DriverCarrier): string | null {
  if (!pred) return null;
  const drivers = pred.top_risk_drivers ?? {};
  const keys = Array.isArray(drivers) ? drivers : Object.keys(drivers);
  return keys.length ? humanizeDriver(keys[0]) : null;
}
