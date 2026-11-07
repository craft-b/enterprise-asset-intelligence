import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RiskBadge } from "@/components/risk-badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MaintenanceForm } from "@/components/maintenance-form";
import {
  Activity,
  ShieldAlert,
  DollarSign,
  Wrench,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Minus,
  Calendar,
  AlignJustify,
  List,
} from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useEquipment } from "@/hooks/use-equipment";
import { useMaintenanceDueSoon } from "@/hooks/use-maintenance";
import { useLatestMultiHorizonPredictions } from "@/hooks/use-risk-score";
import { useSimulationState } from "@/hooks/use-predictive-maintenance";
import { fmtMoneyCompact } from "@/lib/chart-theme";
import { FAILURE_DOWNTIME_DAYS } from "@/lib/cost-model";
import {
  RiskLevel,
  RISK_FILL,
  RISK_HOVER,
  humanizeDriver,
} from "@/lib/risk-format";
import { format } from "date-fns";
import { calendarDate } from "@/lib/calendar-date";

type Horizon = "10d" | "30d" | "60d";
type Density = "comfortable" | "compact";

interface FleetRow {
  id: number;
  name: string;
  code: string;
  category: string;
  status: string;
  site: string | null;
  dailyRate: number;
  modelVersion: string;
  trend: "INCREASING" | "DECREASING" | "STABLE";
  driver: string | null;
  probs: Record<Horizon, number>;
  levels: Record<Horizon, RiskLevel>;
}

/** Lead-time estimate: the earliest horizon already at HIGH risk. */
function highRiskWindow(levels: Record<Horizon, RiskLevel>): Horizon | null {
  if (levels["10d"] === "HIGH") return "10d";
  if (levels["30d"] === "HIGH") return "30d";
  if (levels["60d"] === "HIGH") return "60d";
  return null;
}

function safeDrivers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const d = JSON.parse(raw || "[]");
      return Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  }
  return [];
}

function TrendIcon({ trend }: { trend: FleetRow["trend"] }) {
  if (trend === "INCREASING") return <TrendingUp className="h-4 w-4 text-risk-high" />;
  if (trend === "DECREASING") return <TrendingDown className="h-4 w-4 text-risk-low" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <Icon className={cn("h-4 w-4", accent ?? "text-muted-foreground/60")} />
        </div>
        <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-foreground">
          {value}
        </p>
        {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export default function CommandCenter() {
  const { user } = useAuth();
  const { data: equipment } = useEquipment();
  const { data: predictions } = useLatestMultiHorizonPredictions();
  const { data: dueSoon } = useMaintenanceDueSoon();
  const sim = useSimulationState();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === "ADMINISTRATOR";

  // Queue controls — filters narrow the queue only; the KPI strip stays fleet-wide.
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [siteFilter, setSiteFilter] = useState<string>("all");
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem("cc-density") as Density) || "comfortable",
  );
  const [scheduleFor, setScheduleFor] = useState<FleetRow | null>(null);

  const toggleDensity = () => {
    const next: Density = density === "comfortable" ? "compact" : "comfortable";
    setDensity(next);
    localStorage.setItem("cc-density", next);
  };

  // The simulated "today". Shown only once loaded, so the real date never flashes in its place.
  const asOf = sim.data?.cursor_date ? calendarDate(sim.data.cursor_date) : null;

  const rows: FleetRow[] = (predictions ?? []).map((p: any) => {
    const id = p.equipmentId ?? p.equipment_id;
    const equip = equipment?.find((e) => e.id === id);
    return {
      id,
      name: equip?.name ?? p.name ?? `Equipment ${id}`,
      code: equip?.equipmentId ?? p.equipment_code ?? "",
      category: equip?.category ?? p.category ?? "",
      status: equip?.status ?? p.status ?? "",
      site: equip?.location ?? null,
      dailyRate: Number(equip?.dailyRate ?? 0),
      modelVersion: p.model_version ?? p.modelVersion ?? "",
      trend: (p.risk_trend ?? p.riskTrend ?? "STABLE") as FleetRow["trend"],
      driver: (() => {
        const d = safeDrivers(p.top_drivers_30d);
        return d.length ? humanizeDriver(d[0]) : null;
      })(),
      probs: {
        "10d": Number(p.prob_10d ?? 0),
        "30d": Number(p.prob_30d ?? 0),
        "60d": Number(p.prob_60d ?? 0),
      },
      levels: {
        "10d": (p.risk_level_10d ?? "LOW") as RiskLevel,
        "30d": (p.risk_level_30d ?? "LOW") as RiskLevel,
        "60d": (p.risk_level_60d ?? "LOW") as RiskLevel,
      },
    };
  });

  const total = rows.length;
  const high = rows.filter((r) => r.levels["30d"] === "HIGH").length;
  const medium = rows.filter((r) => r.levels["30d"] === "MEDIUM").length;
  const low = rows.filter((r) => r.levels["30d"] === "LOW").length;

  // Fleet Health Index — share of the fleet not carrying elevated 30-day risk,
  // with MEDIUM counted at half weight. Honest, bounded 0–100.
  const fleetHealth = total > 0 ? Math.round((100 * (low + 0.5 * medium)) / total) : 100;

  // Expected downtime dollars at risk = Σ over elevated units of
  // P(failure, 30d) × daily rate × typical unplanned-downtime days.
  const downtimeAtRisk = rows
    .filter((r) => r.levels["30d"] !== "LOW")
    .reduce((sum, r) => sum + r.probs["30d"] * r.dailyRate * FAILURE_DOWNTIME_DAYS, 0);

  const overdue = (dueSoon ?? []).filter((d) => Number(d.daysUntilDue) < 0).length;
  const dueNext = (dueSoon ?? []).filter((d) => Number(d.daysUntilDue) >= 0).length;

  const categories = Array.from(new Set(rows.map((r) => r.category).filter(Boolean))).sort();
  const sites = Array.from(new Set(rows.map((r) => r.site).filter((s): s is string => !!s))).sort();

  const filtered = rows.filter(
    (r) =>
      (categoryFilter === "all" || r.category === categoryFilter) &&
      (statusFilter === "all" || r.status === statusFilter) &&
      (siteFilter === "all" || r.site === siteFilter),
  );

  const queue = [...filtered]
    .sort((a, b) => b.probs["30d"] - a.probs["30d"])
    .slice(0, 12);

  const isFiltered = categoryFilter !== "all" || statusFilter !== "all" || siteFilter !== "all";

  const healthAccent =
    fleetHealth >= 75 ? "text-risk-low" : fleetHealth >= 50 ? "text-risk-medium" : "text-risk-high";

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Fleet Command Center</h1>
          <p className="text-muted-foreground">
            Fleet health, predicted failures, and this week&apos;s maintenance priorities
          </p>
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 text-sm text-muted-foreground cursor-default">
                <Calendar className="h-4 w-4" />
                <span className="tabular-nums">Simulated date: {asOf ? format(asOf, "MMM d, yyyy") : "…"}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
              This demo runs on a simulated clock that advances one day at a time, so its dates can run ahead of today's.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Fleet Health Index"
          value={<span className={healthAccent}>{fleetHealth}</span>}
          sub={
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-risk-low" />
                {low} low
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-risk-medium" />
                {medium} med
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-risk-high" />
                {high} high
              </span>
            </span>
          }
          icon={Activity}
          accent={healthAccent}
        />
        <KpiCard
          label="High-Risk Assets · 30d"
          value={high}
          sub={`of ${total} scored units need attention`}
          icon={ShieldAlert}
          accent={high > 0 ? "text-risk-high" : "text-risk-low"}
        />
        <KpiCard
          label="Downtime $ at Risk · 30d"
          value={fmtMoneyCompact(downtimeAtRisk)}
          sub="Expected cost of unplanned failures"
          icon={DollarSign}
          accent="text-risk-medium"
        />
        <KpiCard
          label="PM Backlog"
          value={overdue + dueNext}
          sub={
            <span>
              <span className={overdue > 0 ? "text-risk-high font-medium" : ""}>{overdue} overdue</span>
              {" · "}
              {dueNext} due soon
            </span>
          }
          icon={Wrench}
          accent={overdue > 0 ? "text-risk-high" : "text-muted-foreground/60"}
        />
      </div>

      {/* Risk queue */}
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Priority Risk Queue</CardTitle>
              <CardDescription>
                Highest 30-day failure probability first · click a unit for full multi-horizon breakdown
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href="/predictive-maintenance">
                View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          {/* Filters + density */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-8 w-[150px] text-xs">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="AVAILABLE">Available</SelectItem>
                <SelectItem value="RENTED">Rented</SelectItem>
                <SelectItem value="MAINTENANCE">In maintenance</SelectItem>
              </SelectContent>
            </Select>
            <Select value={siteFilter} onValueChange={setSiteFilter}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue placeholder="Site" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sites</SelectItem>
                {sites.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isFiltered && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {filtered.length} of {total} units
              </span>
            )}
            <div className="ml-auto">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={toggleDensity}>
                      {density === "comfortable" ? <AlignJustify className="h-4 w-4" /> : <List className="h-4 w-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{density === "comfortable" ? "Compact rows" : "Comfortable rows"}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {queue.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              {isFiltered ? (
                <>No units match the current filters.</>
              ) : (
                <>
                  No predictions yet. Open{" "}
                  <Link href="/predictive-maintenance" className="text-primary underline underline-offset-2">
                    Predictive Maintenance
                  </Link>{" "}
                  and run the model to populate the queue.
                </>
              )}
            </div>
          ) : (
            <div>
              {/* Column header */}
              <div className="hidden xl:flex items-center gap-4 px-3 pb-2 mb-1 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <div className="w-[220px] shrink-0">Asset</div>
                <div className="flex-1 min-w-0 hidden lg:block">Primary risk driver</div>
                <div className="w-[210px] shrink-0 text-center">Failure probability · 10 / 30 / 60d</div>
                <div className="w-[64px] shrink-0 text-center">High by</div>
                <div className="w-[118px] shrink-0 text-right">Status</div>
                {isAdmin && <div className="w-9 shrink-0" />}
              </div>

              <div className="space-y-0.5">
                {queue.map((r) => {
                  const win = highRiskWindow(r.levels);
                  const ruleScored = r.modelVersion.startsWith("rule:");
                  return (
                    <Link
                      key={r.id}
                      href={`/assets/${r.id}`}
                      className={cn(
                        "flex items-center gap-4 px-3 rounded-md cursor-pointer transition-colors group border border-transparent",
                        density === "compact" ? "py-1" : "py-2.5",
                        RISK_HOVER[r.levels["30d"]],
                      )}
                    >
                      {/* Asset */}
                      <div className="min-w-0 flex-1 xl:w-[220px] xl:flex-none xl:shrink-0">
                        <p className="text-sm font-medium truncate text-foreground">
                          {r.name}
                          {ruleScored && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground align-middle">
                                    rule
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Cold-start unit — rule-scored, not model output. Confidence is lower.</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </p>
                        {density === "comfortable" && (
                          <p className="text-xs text-muted-foreground font-mono">
                            {r.category}
                            {r.code ? ` · ${r.code}` : ""}
                          </p>
                        )}
                      </div>

                      {/* Primary driver */}
                      <div className="hidden xl:flex flex-1 min-w-0 items-center gap-2">
                        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", RISK_FILL[r.levels["30d"]])} />
                        <span className="truncate text-sm text-muted-foreground">
                          {r.driver ?? <span className="italic opacity-70">No dominant driver</span>}
                        </span>
                      </div>

                      {/* Tri-horizon bars */}
                      <div className="hidden xl:flex items-center gap-3 shrink-0 w-[210px] justify-center">
                        {(["10d", "30d", "60d"] as Horizon[]).map((h) => (
                          <TooltipProvider key={h}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex flex-col items-center gap-1 w-14">
                                  {density === "comfortable" && (
                                    <div className="text-[10px] font-medium text-muted-foreground">{h}</div>
                                  )}
                                  <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className={cn("h-full rounded-full", RISK_FILL[r.levels[h]])}
                                      style={{ width: `${Math.round(r.probs[h] * 100)}%` }}
                                    />
                                  </div>
                                  <div className="text-xs font-semibold font-mono tabular-nums text-foreground">
                                    {Math.round(r.probs[h] * 100)}%
                                  </div>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>
                                  {h}: {r.levels[h]} ({Math.round(r.probs[h] * 100)}% failure probability)
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ))}
                      </div>

                      {/* Lead-time estimate: earliest horizon at HIGH */}
                      <div className="hidden xl:block w-[64px] shrink-0 text-center">
                        {win ? (
                          <span className="font-mono text-xs font-semibold tabular-nums text-risk-high">
                            ≤ {win}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">—</span>
                        )}
                      </div>

                      {/* Status */}
                      <div className="flex items-center justify-end gap-2 shrink-0 xl:w-[118px]">
                        <TrendIcon trend={r.trend} />
                        <RiskBadge
                          level={r.levels["30d"]}
                          score={Math.round(r.probs["30d"] * 100)}
                          size="sm"
                          showIcon={false}
                        />
                      </div>

                      {/* Action: log PM straight from the queue */}
                      {isAdmin && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setScheduleFor(r);
                                }}
                              >
                                <Wrench className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Log maintenance for {r.name}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Schedule PM dialog — closes the label loop from the command center */}
      {scheduleFor && (
        <Dialog open onOpenChange={(open) => !open && setScheduleFor(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                Log Maintenance — {scheduleFor.name}
              </DialogTitle>
              <DialogDescription>
                {scheduleFor.category}
                {scheduleFor.code ? ` · ${scheduleFor.code}` : ""} · 30d failure probability{" "}
                {Math.round(scheduleFor.probs["30d"] * 100)}%
              </DialogDescription>
            </DialogHeader>
            <MaintenanceForm
              equipmentId={scheduleFor.id}
              equipmentName={scheduleFor.name}
              defaultEventSource="PREDICTIVE_INTERVENTION"
              onSuccess={() => {
                setScheduleFor(null);
                queryClient.invalidateQueries({ queryKey: ["/api/risk-score/multi-horizon/latest"] });
                queryClient.invalidateQueries({ queryKey: ["/api/maintenance/due-soon"] });
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
