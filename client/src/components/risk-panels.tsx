// ─────────────────────────────────────────────────────────────────────────────
// Shared risk panels — SHAP attribution bars and the 60-day projection
// sparkline, used by the predictive-maintenance dashboard and the asset
// detail page (DESIGN_SPEC §5 items 2–3).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { RISK_BANDS } from "@shared/risk-bands";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import { CHART } from "@/lib/chart-theme";
import { humanizeDriver } from "@/lib/risk-format";
import { useEquipmentProjection } from "@/hooks/use-predictive-maintenance";

// Display formatting for raw feature values in the expanded bar panel.
const FEATURE_UNITS: Record<string, string> = {
  asset_age_years: "yrs",
  total_hours_lifetime: "hrs",
  hours_used_30d: "hrs",
  hours_used_90d: "hrs",
  rental_days_30d: "days",
  rental_days_90d: "days",
  avg_rental_duration: "days",
  avg_downtime_per_event: "days",
  days_since_last_maintenance: "days",
  mean_time_between_failures: "days",
  maintenance_events_90d: "events",
  mechanical_wear_score: "/10",
  abuse_score: "/10",
  neglect_score: "/10",
};
const MONEY_FEATURES = new Set(["maintenance_cost_180d", "cost_per_event"]);

function fmtFeatureValue(feature: string, v: number): string {
  if (MONEY_FEATURES.has(feature)) return `$${Math.round(v).toLocaleString()}`;
  const unit = FEATURE_UNITS[feature];
  const num = Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2).replace(/\.?0+$/, "");
  return unit ? (unit.startsWith("/") ? `${num}${unit}` : `${num} ${unit}`) : num;
}

export interface FeatureBaselineData {
  unit: Record<string, number>;
  fleet: Record<string, number>;
}

// ─── SHAP attribution bars (DESIGN_SPEC §5 item 3) ───────────────────────────
// One attribution source: per-prediction SHAP from the ML service. Values are
// signed log-odds contributions — sign and rank are trustworthy, magnitudes are
// not probabilities, so bars show each feature's SHARE of total |attribution|.
// With `baseline`, each bar expands to the unit's raw feature value vs. the
// fleet average (latest persisted snapshots).
//
// On the bundled simulator these attributions recover the generator rather than
// discover anything: failures are drawn from a function of asset age, lifetime
// hours and maintenance recency, and the model receives all three. Age and wear
// ranking highly is arithmetic. `simulated` renders that caveat inline so a
// reader does not mistake verification for insight — the machinery itself is
// real and would be informative on field data.
export function ShapDriverBars({
  attribution,
  baseline,
  simulated = false,
}: {
  attribution: Record<string, number>;
  baseline?: FeatureBaselineData;
  /** Renders the synthetic-data caveat. See the note above this component. */
  simulated?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const entries = Object.entries(attribution)
    .filter(([, v]) => Number.isFinite(v) && v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (entries.length === 0) return null;
  const totalAbs = entries.reduce((s, [, v]) => s + Math.abs(v), 0);
  const maxAbs = Math.abs(entries[0][1]);
  return (
    <div className="space-y-1.5">
      {simulated && (
        <p className="text-[11px] leading-snug text-muted-foreground pb-1">
          Simulated data: these drivers recover the simulator's own hazard
          (age, hours, maintenance recency) rather than reveal anything new.
        </p>
      )}
      {entries.map(([feat, val]) => {
        const share = Math.round((Math.abs(val) / totalAbs) * 100);
        const width = Math.max(4, Math.round((Math.abs(val) / maxAbs) * 100));
        const pushesTowardFailure = val > 0;
        // SHAP keys carry the pipeline's transform prefix; raw values are keyed
        // by the underlying feature.
        const rawKey = feat.replace(/^log_/, "");
        const unitVal = baseline?.unit[rawKey];
        const fleetVal = baseline?.fleet[rawKey];
        const expandable = baseline !== undefined;
        const isOpen = expanded === feat;
        const row = (
          <>
            {expandable && (
              isOpen
                ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
            )}
            <span className="w-[46%] min-w-0 truncate text-left" title={humanizeDriver(feat)}>
              {humanizeDriver(feat)}
            </span>
            <span
              className={cn(
                "w-10 shrink-0 text-right font-mono text-xs tabular-nums font-medium",
                pushesTowardFailure ? "text-risk-high" : "text-risk-low",
              )}
            >
              {pushesTowardFailure ? "+" : "−"}{share}%
            </span>
            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full", pushesTowardFailure ? "bg-risk-high" : "bg-risk-low")}
                style={{ width: `${width}%` }}
              />
            </div>
          </>
        );
        return (
          <div key={feat}>
            {expandable ? (
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : feat)}
                className="flex w-full items-center gap-2 text-sm rounded px-1 -mx-1 py-0.5 hover:bg-muted/60 transition-colors"
              >
                {row}
              </button>
            ) : (
              <div className="flex items-center gap-2 text-sm">{row}</div>
            )}
            {isOpen && (
              <div className="ml-5 mt-1 mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {unitVal !== undefined ? (
                  <span>
                    This unit:{" "}
                    <span className="font-mono font-medium text-foreground tabular-nums">
                      {fmtFeatureValue(rawKey, unitVal)}
                    </span>
                    {fleetVal !== undefined && (
                      <>
                        {" "}· Fleet average:{" "}
                        <span className="font-mono font-medium tabular-nums">
                          {fmtFeatureValue(rawKey, fleetVal)}
                        </span>
                      </>
                    )}
                    <span className="ml-1 opacity-70">(latest snapshot)</span>
                  </span>
                ) : (
                  <span className="italic">Raw value not available for this feature.</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── 60-day projection sparkline with HIGH-crossing marker ───────────────────
export function ProjectionSparkline({ equipmentId }: { equipmentId: number }) {
  const { data, isLoading, isError } = useEquipmentProjection(equipmentId);

  if (isLoading) return (
    <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
      <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading trajectory...
    </div>
  );

  if (isError || !data) return null;

  const crossingDay = data.days_until_high;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">60-Day Failure Trajectory</span>
        {crossingDay !== null ? (
          crossingDay === 0 ? (
            <span className="text-xs font-medium text-risk-high bg-risk-high-surface border border-risk-high px-2 py-0.5 rounded-full">
              Already HIGH risk
            </span>
          ) : (
            <span className="text-xs font-medium text-risk-medium bg-risk-medium-surface border border-risk-medium px-2 py-0.5 rounded-full">
              Crosses HIGH in {crossingDay}d
            </span>
          )
        ) : (
          <span className="text-xs font-medium text-risk-low bg-risk-low-surface border border-risk-low px-2 py-0.5 rounded-full">
            Stays below HIGH threshold
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={data.curve} margin={{ top: 4, right: 4, bottom: 4, left: -20 }}>
          <XAxis dataKey="day" tickLine={false} axisLine={false} tick={CHART.axis.tick} tickFormatter={(v) => `${v}d`} />
          <YAxis domain={[0, 1]} tickLine={false} axisLine={false} tick={CHART.axis.tick} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
          <RechartsTooltip
            formatter={(value: number, name: string) => [`${Math.round(value * 100)}%`, name]}
            labelFormatter={(label) => `Day ${label}`}
            {...CHART.tooltip}
          />
          {/* HIGH band threshold — the only semantic color on this plot */}
          {/* The bands are per horizon; this is 60d's, the bold line. */}
          <ReferenceLine y={RISK_BANDS[60].HIGH} stroke={CHART.risk.high} strokeDasharray="3 3" strokeWidth={1} />
          {/* Horizons are identities → fixed categorical order */}
          <Line type="monotone" dataKey="10d" stroke={CHART.categorical[0]} strokeWidth={1.5} dot={false} name="10d" />
          <Line type="monotone" dataKey="30d" stroke={CHART.categorical[1]} strokeWidth={1.5} dot={false} name="30d" />
          <Line type="monotone" dataKey="60d" stroke={CHART.categorical[2]} strokeWidth={2} dot={false} name="60d" />
        </LineChart>
      </ResponsiveContainer>

      <div className="flex gap-4 text-xs text-muted-foreground justify-center">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block" style={{ backgroundColor: CHART.categorical[0] }}/>10d</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block" style={{ backgroundColor: CHART.categorical[1] }}/>30d</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block" style={{ backgroundColor: CHART.categorical[2] }}/>60d</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 border-t border-dashed inline-block" style={{ borderColor: CHART.risk.high }}/>HIGH threshold</span>
      </div>
    </div>
  );
}
