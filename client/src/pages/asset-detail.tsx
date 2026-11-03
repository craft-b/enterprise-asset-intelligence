// ─────────────────────────────────────────────────────────────────────────────
// Asset detail — the deep-dive page (DESIGN_SPEC §5 IA item 2):
// identity header → three-horizon risk panel with trend + projection →
// SHAP explanation panel → maintenance/rental timeline with event-source
// badges. One attribution source (SHAP), provenance line under the scores.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReadOnlyAction } from "@/components/read-only-action";
import { RiskBadge } from "@/components/risk-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MaintenanceForm } from "@/components/maintenance-form";
import { ShapDriverBars, ProjectionSparkline } from "@/components/risk-panels";
import {
  ArrowLeft,
  Wrench,
  TrendingUp,
  TrendingDown,
  Minus,
  CalendarRange,
  Truck,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import { CHART } from "@/lib/chart-theme";
import { useAuth } from "@/hooks/use-auth";
import { useEquipmentItem, useSensorTrends, useFeatureBaseline, type SensorTrendPoint } from "@/hooks/use-equipment";
import { useMaintenanceHistory } from "@/hooks/use-maintenance";
import { useRentals } from "@/hooks/use-rentals";
import { useJobSites } from "@/hooks/use-jobsites";
import { useLatestMultiHorizonPredictions } from "@/hooks/use-risk-score";
import {
  RiskLevel,
  RISK_COLORS,
  parseJsonArray,
  parseJsonObject,
  humanizeDriver,
} from "@/lib/risk-format";
import { format } from "date-fns";

type Horizon = "10d" | "30d" | "60d";

const HORIZON_LABELS: Record<Horizon, string> = {
  "10d": "Next 10 Days",
  "30d": "Next 30 Days",
  "60d": "Next 60 Days",
};

const STATUS_STYLES: Record<string, string> = {
  AVAILABLE: "bg-risk-low-surface text-risk-low border-risk-low",
  RENTED: "bg-primary/10 text-primary border-primary/40",
  MAINTENANCE: "bg-risk-medium-surface text-risk-medium border-risk-medium",
};

// Event-source badges — how a maintenance event was triggered. PREDICTIVE gets
// the interactive accent: it is the product's own feedback loop at work.
const EVENT_SOURCE_STYLES: Record<string, { label: string; className: string }> = {
  SCHEDULED_PM:            { label: "Scheduled PM",  className: "bg-muted text-muted-foreground border-border" },
  PREDICTIVE_INTERVENTION: { label: "Predictive",    className: "bg-primary/10 text-primary border-primary/40" },
  REACTIVE_REPAIR:         { label: "Reactive",      className: "bg-risk-high-surface text-risk-high border-risk-high" },
  PRE_DISPATCH_INSPECTION: { label: "Pre-dispatch",  className: "bg-muted text-muted-foreground border-border" },
};

function TrendIcon({ trend }: { trend: string }) {
  if (trend === "INCREASING") return <TrendingUp className="h-4 w-4 text-risk-high" />;
  if (trend === "DECREASING") return <TrendingDown className="h-4 w-4 text-risk-low" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

interface TimelineEntry {
  key: string;
  date: Date;
  kind: "maintenance" | "rental";
  title: string;
  badge: { label: string; className: string };
  detail: string | null;
}

const fmtDate = (d: Date) => format(d, "MMM d, yyyy");

// ─── Sensor trend small-multiples ─────────────────────────────────────────────
// Neutral categorical strokes only — semantic risk color stays reserved for
// risk surfaces (DESIGN_SPEC §5 design language).
function SensorMini({
  label,
  unit,
  data,
  dataKey,
  color,
}: {
  label: string;
  unit: string;
  data: SensorTrendPoint[];
  dataKey: keyof SensorTrendPoint;
  color: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-[10px] text-muted-foreground/60">{unit}</span>
      </div>
      <ResponsiveContainer width="100%" height={90}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -14 }}>
          <XAxis dataKey="day" hide />
          <YAxis
            domain={["auto", "auto"]}
            tickLine={false}
            axisLine={false}
            tick={CHART.axis.tick}
            width={44}
          />
          <RechartsTooltip
            formatter={(value: number) => [`${value} ${unit}`, label]}
            labelFormatter={(label_: string) => format(new Date(label_), "MMM d, yyyy")}
            {...CHART.tooltip}
          />
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function AssetDetail() {
  const [, params] = useRoute("/assets/:id");
  const id = Number(params?.id ?? 0);

  const { user } = useAuth();
  const isAdmin = user?.role === "ADMINISTRATOR";
  const queryClient = useQueryClient();
  const [showSchedule, setShowSchedule] = useState(false);

  const { data: equip, isLoading: equipLoading } = useEquipmentItem(id);
  const { data: predictions } = useLatestMultiHorizonPredictions();
  const { data: maintenance } = useMaintenanceHistory(id);
  const { data: rentals } = useRentals();
  const { data: jobSites } = useJobSites();
  const { data: sensors } = useSensorTrends(id);
  const { data: baseline } = useFeatureBaseline(id);

  const pred: any = (predictions ?? []).find(
    (p: any) => (p.equipmentId ?? p.equipment_id) === id,
  );

  if (!id || (!equipLoading && !equip)) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        Asset not found.{" "}
        <Link href="/" className="text-primary underline underline-offset-2">
          Back to Command Center
        </Link>
      </div>
    );
  }
  if (equipLoading || !equip) return null;

  const horizons: Record<Horizon, { prob: number; level: RiskLevel; shap: Record<string, number>; drivers: string[] }> = {
    "10d": { prob: Number(pred?.prob_10d ?? 0), level: (pred?.risk_level_10d ?? "LOW") as RiskLevel, shap: parseJsonObject(pred?.shap_attribution_10d), drivers: parseJsonArray(pred?.top_drivers_10d) },
    "30d": { prob: Number(pred?.prob_30d ?? 0), level: (pred?.risk_level_30d ?? "LOW") as RiskLevel, shap: parseJsonObject(pred?.shap_attribution_30d), drivers: parseJsonArray(pred?.top_drivers_30d) },
    "60d": { prob: Number(pred?.prob_60d ?? 0), level: (pred?.risk_level_60d ?? "LOW") as RiskLevel, shap: parseJsonObject(pred?.shap_attribution_60d), drivers: parseJsonArray(pred?.top_drivers_60d) },
  };
  const trend = pred?.risk_trend ?? "STABLE";
  const modelVersion = pred?.model_version ?? "";
  const ruleScored = String(modelVersion).startsWith("rule:");

  const unitRentals = (rentals ?? []).filter((r: any) => r.equipmentId === id);
  const activeRental = unitRentals.find((r: any) => r.status === "ACTIVE");
  const activeSite = activeRental
    ? jobSites?.find((j) => j.id === activeRental.jobSiteId)?.name ?? `Site #${activeRental.jobSiteId}`
    : null;

  // Merge maintenance + rentals into one reverse-chronological timeline.
  const timeline: TimelineEntry[] = [
    ...(maintenance ?? []).map((m: any): TimelineEntry => {
      const src = EVENT_SOURCE_STYLES[m.eventSource] ?? EVENT_SOURCE_STYLES.SCHEDULED_PM;
      return {
        key: `m-${m.id}`,
        date: new Date(m.maintenanceDate),
        kind: "maintenance",
        title: String(m.maintenanceType ?? "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()),
        badge: src,
        detail: [m.description, m.cost ? `$${Number(m.cost).toLocaleString()}` : null]
          .filter(Boolean)
          .join(" · ") || null,
      };
    }),
    ...unitRentals.map((r: any): TimelineEntry => ({
      key: `r-${r.id}`,
      date: new Date(r.receiveDate),
      kind: "rental",
      title: `Rental ${r.poNumber ?? `#${r.id}`}`,
      badge: {
        label: r.status === "ACTIVE" ? "Active rental" : r.status === "COMPLETED" ? "Rental" : "Cancelled",
        className: r.status === "ACTIVE"
          ? "bg-primary/10 text-primary border-primary/40"
          : "bg-muted text-muted-foreground border-border",
      },
      detail: [
        jobSites?.find((j) => j.id === r.jobSiteId)?.name,
        r.returnDate ? `${fmtDate(new Date(r.receiveDate))} → ${fmtDate(new Date(r.returnDate))}` : `since ${fmtDate(new Date(r.receiveDate))}`,
      ].filter(Boolean).join(" · ") || null,
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header — identity, status, rental state */}
      <div className="space-y-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Command Center
        </Link>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
              {equip.name}
              <Badge variant="outline" className={cn("align-middle", STATUS_STYLES[equip.status] ?? "")}>
                {equip.status}
              </Badge>
            </h1>
            <p className="mt-1 text-muted-foreground font-mono text-sm">
              {equip.equipmentId} · {equip.category}
              {equip.make ? ` · ${equip.make}${equip.model ? ` ${equip.model}` : ""}` : ""}
              {equip.location ? ` · ${equip.location}` : ""}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {activeRental ? (
                <span className="inline-flex items-center gap-1.5">
                  <Truck className="h-3.5 w-3.5" />
                  On rent at {activeSite} since {fmtDate(new Date(activeRental.receiveDate))}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <CalendarRange className="h-3.5 w-3.5" />
                  Not currently on rent · ${Number(equip.dailyRate).toLocaleString()}/day
                </span>
              )}
            </p>
          </div>
          {isAdmin ? (
            <Button onClick={() => setShowSchedule(true)} className="gap-2 shrink-0">
              <Wrench className="h-4 w-4" /> Log Maintenance
            </Button>
          ) : (
            <ReadOnlyAction className="shrink-0">Log Maintenance</ReadOnlyAction>
          )}
        </div>
      </div>

      {/* Risk panel — three horizons + trend + projection */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Failure Risk</CardTitle>
            <CardDescription>
              Calibrated probability per horizon
              {pred ? (
                <span className="ml-2 inline-flex items-center gap-1 align-middle">
                  <TrendIcon trend={trend} />
                  <span className="text-xs">
                    {/* INCREASING means p60 - p10 > 0.10, which a repair can leave
                        true, so "escalating without intervention" read wrong
                        right after one was logged. */}
                    {trend === "INCREASING" ? "climbs sharply from 10 to 60 days" : "stable across horizons"}
                  </span>
                </span>
              ) : null}
            </CardDescription>
          </div>
          {ruleScored && (
            <Badge variant="outline" className="shrink-0 text-muted-foreground">
              rule-scored (cold start)
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {!pred ? (
            <div className="py-8 text-center text-muted-foreground">
              No prediction for this unit yet. Run the model from{" "}
              <Link href="/predictive-maintenance" className="text-primary underline underline-offset-2">
                Predictive Maintenance
              </Link>.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                {(["10d", "30d", "60d"] as Horizon[]).map((h) => {
                  const hp = horizons[h];
                  return (
                    <div key={h} className={cn("p-4 rounded-lg border-2 text-center", RISK_COLORS[hp.level])}>
                      <div className="text-xs opacity-80 mb-1">{HORIZON_LABELS[h]}</div>
                      <div className="text-3xl font-semibold tabular-nums mb-1">
                        {Math.round(hp.prob * 100)}%
                      </div>
                      <RiskBadge level={hp.level} score={Math.round(hp.prob * 100)} size="sm" showIcon={false} />
                    </div>
                  );
                })}
              </div>
              <ProjectionSparkline equipmentId={id} />
            </>
          )}
        </CardContent>
      </Card>

      {/* Explanation panel — SHAP-only attribution */}
      {pred && (
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0">
            <div>
              <CardTitle>Why this risk score</CardTitle>
              <CardDescription>Per-prediction model attribution, by horizon</CardDescription>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              Share of attribution · <span className="text-risk-high">+ pushes toward failure</span> ·{" "}
              <span className="text-risk-low">− protective</span>
            </span>
          </CardHeader>
          <CardContent className="space-y-5">
            {(["10d", "30d", "60d"] as Horizon[]).map((h) => {
              const hp = horizons[h];
              const hasShap = Object.values(hp.shap).some((v) => Number.isFinite(v) && v !== 0);
              if (!hasShap && hp.drivers.length === 0) return null;
              return (
                <div key={h}>
                  <div className="text-sm font-medium text-muted-foreground mb-2">{HORIZON_LABELS[h]}</div>
                  {hasShap ? (
                    <ShapDriverBars attribution={hp.shap} baseline={baseline} simulated />
                  ) : (
                    <div className="space-y-1">
                      {hp.drivers.slice(0, 3).map((d, i) => (
                        <div key={i} className="text-sm text-muted-foreground">{humanizeDriver(d)}</div>
                      ))}
                      <p className="text-xs text-muted-foreground italic">
                        Per-prediction attribution unavailable — re-run predictions to compute SHAP values.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="pt-3 border-t text-xs text-muted-foreground">
              {modelVersion} · Multi-horizon Random Forest · calibrated · attribution: per-prediction SHAP (TreeExplainer)
            </div>
          </CardContent>
        </Card>
      )}

      {/* Maintenance / rental timeline */}
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>Maintenance events and rentals, most recent first</CardDescription>
        </CardHeader>
        <CardContent>
          {timeline.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">No recorded history for this unit.</div>
          ) : (
            <div className="space-y-0.5">
              {timeline.map((t) => (
                <div key={t.key} className="flex items-center gap-4 px-3 py-2 rounded-md border border-transparent hover:bg-muted/50 transition-colors">
                  <div className="w-[104px] shrink-0 text-xs font-mono tabular-nums text-muted-foreground">
                    {fmtDate(t.date)}
                  </div>
                  <Badge variant="outline" className={cn("w-[110px] shrink-0 justify-center text-[11px]", t.badge.className)}>
                    {t.badge.label}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-foreground">{t.title}</span>
                    {t.detail && (
                      <span className="ml-2 text-xs text-muted-foreground truncate">{t.detail}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sensor trends — daily telemetry aggregates */}
      <Card>
        <CardHeader>
          <CardTitle>Sensor Trends</CardTitle>
          <CardDescription>
            Daily averages, last {sensors?.days ?? 90} days
            {sensors?.asOf ? ` · as of ${format(new Date(sensors.asOf), "MMM d, yyyy")}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!sensors || sensors.points.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No telemetry recorded for this unit in the selected window.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <SensorMini label="Engine temperature" unit="°F" data={sensors.points} dataKey="engine_temp" color={CHART.categorical[0]} />
              <SensorMini label="Oil pressure" unit="psi" data={sensors.points} dataKey="oil_pressure" color={CHART.categorical[1]} />
              <SensorMini label="Hydraulic pressure" unit="psi" data={sensors.points} dataKey="hydraulic_pressure" color={CHART.categorical[2]} />
              <SensorMini label="Vibration (RMS)" unit="g" data={sensors.points} dataKey="vibration" color={CHART.categorical[3] ?? CHART.categorical[0]} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Log maintenance — closes the label loop */}
      {showSchedule && (
        <Dialog open onOpenChange={(open) => !open && setShowSchedule(false)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Wrench className="h-4 w-4" /> Log Maintenance — {equip.name}
              </DialogTitle>
              <DialogDescription>
                {equip.category} · {equip.equipmentId}
                {pred ? ` · 30d failure probability ${Math.round(horizons["30d"].prob * 100)}%` : ""}
              </DialogDescription>
            </DialogHeader>
            <MaintenanceForm
              equipmentId={id}
              equipmentName={equip.name}
              defaultEventSource="PREDICTIVE_INTERVENTION"
              onSuccess={() => {
                setShowSchedule(false);
                queryClient.invalidateQueries({ queryKey: ["/api/risk-score/multi-horizon/latest"] });
                queryClient.invalidateQueries({ queryKey: ["maintenance", "history", id] });
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
