import {
  useModelMetrics,
  useDriftStatus,
  useComputeDriftReference,
  usePredictionDrift,
  useBiasDrift,
  useModelRegistry,
  useChampionChallengerCompare,
  usePromoteChallenger,
  useDataQualityReport,
  useRunPredictions,
  type HorizonMetrics,
  type DQCheck,
} from "@/hooks/use-predictive-maintenance";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
  Cell,
} from "recharts";
import { Button } from "@/components/ui/button";
import { useSystemStatus } from "@/hooks/use-system-status";
import { useAuth } from "@/hooks/use-auth";
import { MlServiceNotice } from "@/components/ml-service-notice";
import {
  Activity,
  TrendingUp,
  Target,
  AlertCircle,
  CheckCircle2,
  Brain,
  Database,
  Zap,
  Loader2,
  ShieldAlert,
  RefreshCw,
  ListChecks,
  ArrowRight,
  Trophy,
  Swords,
  Crown,
  Clock,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CHART } from "@/lib/chart-theme";
import { cn } from "@/lib/utils";

const PSI_THRESHOLDS = { WARNING: 0.1, ALERT: 0.2 };

const FEATURE_LABELS: Record<string, string> = {
  mean_time_between_failures: "Mean Time Between Failures",
  vendor_reliability_score:   "Vendor Reliability Score",
  mechanical_wear_score:      "Mechanical Wear Score",
  neglect_score:              "Neglect Score",
  hours_used_90d:             "Hours Used (90d)",
};

// Drift states are semantic status — they wear the reserved risk tokens
function statusBadgeClass(status: string) {
  return status === "ALERT"   ? "bg-risk-high-surface text-risk-high border-risk-high" :
         status === "WARNING" ? "bg-risk-medium-surface text-risk-medium border-risk-medium" :
                                "bg-risk-low-surface text-risk-low border-risk-low";
}

function statusBorderClass(status: string) {
  return status === "ALERT"   ? "border-l-risk-high" :
         status === "WARNING" ? "border-l-risk-medium" :
         status === "STABLE"  ? "border-l-risk-low" :
                                "border-l-border";
}

function statusTextClass(status: string) {
  return status === "ALERT"   ? "text-risk-high" :
         status === "WARNING" ? "text-risk-medium" :
         status === "STABLE"  ? "text-risk-low" :
                                "text-muted-foreground";
}

/**
 * Re-score the fleet on demand.
 *
 * The mutation behind this existed and nothing rendered it, so when a seed run
 * finished with no predictions -- the normal outcome when the ML service is
 * suspended, since scoring every asset is the one step that needs it awake --
 * the only way to get a risk queue was to re-seed, re-inserting 90 days of
 * sensor readings to fix a cold start.
 */
function ScoreFleetButton() {
  const run = useRunPredictions();
  const { user } = useAuth();
  if ((user as any)?.role !== "ADMINISTRATOR") return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => run.mutate()}
      disabled={run.isPending}
      title="Score every asset against the current model and refresh the risk queue"
    >
      {run.isPending
        ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
        : <RefreshCw className="h-3 w-3 mr-1" />}
      {run.isPending ? "Scoring fleet…" : "Score Fleet"}
    </Button>
  );
}

function DriftMonitorCard() {
  const { data: drift, isLoading, error } = useDriftStatus();
  const computeRef = useComputeDriftReference();
  const { user } = useAuth();
  const isAdmin = (user as any)?.role === "ADMINISTRATOR";

  const overallColor     = statusBorderClass(drift?.overall ?? "");
  const overallTextColor = statusTextClass(drift?.overall ?? "");

  return (
    <Card className={`border-l-4 ${overallColor}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className={`h-5 w-5 ${overallTextColor}`} />
          <div>
            <CardTitle>Feature Drift Monitor</CardTitle>
            <CardDescription>
              Population Stability Index vs. training distribution
            </CardDescription>
          </div>
        </div>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => computeRef.mutate()}
            disabled={computeRef.isPending}
          >
            {computeRef.isPending
              ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
              : <RefreshCw className="h-3 w-3 mr-1" />}
            Reset Baseline
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading drift metrics…
          </div>
        )}
        {(error || (drift?.overall === "NO_DATA" && !isLoading)) && (
          <div className="space-y-2">
            <Alert className="border-slate-200">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                No drift data yet. {isAdmin ? "Click \"Reset Baseline\" to compute a reference distribution from current training data." : "A baseline has not been computed yet."}
              </AlertDescription>
            </Alert>
          </div>
        )}
        {drift && drift.overall !== "NO_DATA" && (
          <div className="space-y-4">
            {/* Overall status */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Overall status:</span>
              <Badge className={statusBadgeClass(drift.overall)}>
                {drift.overall}
              </Badge>
              {drift.features[0] && (
                <span className="text-xs text-muted-foreground ml-auto">
                  Last checked {new Date(drift.features[0].checked_at).toLocaleString()}
                </span>
              )}
            </div>

            {/* Per-feature rows */}
            <div className="space-y-3">
              {drift.features.map((f) => {
                const psiPct = Math.min(f.psi / PSI_THRESHOLDS.ALERT, 1);
                const barColor =
                  f.status === "ALERT"   ? "bg-risk-high" :
                  f.status === "WARNING" ? "bg-risk-medium" :
                                          "bg-risk-low";
                return (
                  <div key={f.feature} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">
                        {FEATURE_LABELS[f.feature] ?? f.feature}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          PSI {f.psi.toFixed(4)}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            f.status === "ALERT"   ? "text-risk-high border-risk-high" :
                            f.status === "WARNING" ? "text-risk-medium border-risk-medium" :
                                                     "text-risk-low border-risk-low"
                          }
                        >
                          {f.status}
                        </Badge>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${barColor}`}
                        style={{ width: `${psiPct * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex gap-4 text-xs text-muted-foreground pt-1">
              <span><span className="font-medium text-risk-low">Stable</span> PSI &lt; 0.10</span>
              <span><span className="font-medium text-risk-medium">Warning</span> 0.10 – 0.20</span>
              <span><span className="font-medium text-risk-high">Alert</span> &gt; 0.20 → retrain recommended</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Prediction Drift Card ─────────────────────────────────────────────────────

function PredictionDriftCard() {
  const { data, isLoading } = usePredictionDrift();

  const overall     = data?.overall ?? "NO_DATA";
  const borderClass = statusBorderClass(overall);
  const textClass   = statusTextClass(overall);

  return (
    <Card className={`border-l-4 ${borderClass}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className={`h-5 w-5 ${textClass}`} />
          <div>
            <CardTitle>Prediction Drift Monitor</CardTitle>
            <CardDescription>
              Output score distribution shift per horizon — detects confidence profile changes
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading prediction drift…
          </div>
        )}
        {!isLoading && overall === "NO_DATA" && (
          <Alert className="border-slate-200">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-sm">
              No prediction drift data yet — run a batch prediction to populate.
            </AlertDescription>
          </Alert>
        )}
        {data && overall !== "NO_DATA" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Overall:</span>
              <Badge className={statusBadgeClass(overall)}>{overall}</Badge>
              {data.horizons[0] && (
                <span className="text-xs text-muted-foreground ml-auto">
                  Last checked {new Date(data.horizons[0].checked_at).toLocaleString()}
                </span>
              )}
            </div>

            <div className="space-y-3">
              {data.horizons.map((h) => {
                const psiPct   = Math.min(h.score_psi / 0.20, 1);
                const barColor = h.score_status === "ALERT"   ? "bg-risk-high" :
                                 h.score_status === "WARNING" ? "bg-risk-medium" :
                                                               "bg-risk-low";
                const highDelta  = ((h.high_pct   - h.ref_high_pct)   * 100).toFixed(1);
                const highArrow  = h.high_pct > h.ref_high_pct ? "↑" : h.high_pct < h.ref_high_pct ? "↓" : "–";
                return (
                  <div key={h.horizon} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{h.horizon}d horizon</span>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">PSI {h.score_psi.toFixed(4)}</span>
                        <Badge variant="outline" className={statusBadgeClass(h.score_status)}>
                          {h.score_status}
                        </Badge>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${barColor}`}
                           style={{ width: `${psiPct * 100}%` }} />
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground">
                      <span>HIGH: {(h.high_pct * 100).toFixed(1)}% (ref {(h.ref_high_pct * 100).toFixed(1)}%) {highArrow}{Math.abs(parseFloat(highDelta))}pp</span>
                      <span>MED: {(h.medium_pct * 100).toFixed(1)}%</span>
                      <span>LOW: {(h.low_pct * 100).toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-4 text-xs text-muted-foreground pt-1">
              <span><span className="font-medium text-risk-low">Stable</span> PSI &lt; 0.10</span>
              <span><span className="font-medium text-risk-medium">Warning</span> 0.10 – 0.20</span>
              <span><span className="font-medium text-risk-high">Alert</span> &gt; 0.20 → investigate</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Bias Drift Card ───────────────────────────────────────────────────────────

function BiasDriftCard() {
  const { data, isLoading } = useBiasDrift();

  const overall     = data?.overall ?? "NO_DATA";
  const borderClass = statusBorderClass(overall);
  const textClass   = statusTextClass(overall);

  return (
    <Card className={`border-l-4 ${borderClass}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Target className={`h-5 w-5 ${textClass}`} />
          <div>
            <CardTitle>Bias Drift Monitor</CardTitle>
            <CardDescription>
              Per-category HIGH-risk rate vs. training baseline (30d horizon)
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading bias metrics…
          </div>
        )}
        {!isLoading && overall === "NO_DATA" && (
          <Alert className="border-slate-200">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-sm">
              No bias data yet — run a batch prediction to populate.
            </AlertDescription>
          </Alert>
        )}
        {data && overall !== "NO_DATA" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Overall:</span>
              <Badge className={statusBadgeClass(overall)}>{overall}</Badge>
              <span className="text-xs text-muted-foreground ml-auto">
                Threshold: ±15pp deviation
              </span>
            </div>

            <div className="space-y-2">
              {data.categories.map((c) => {
                const isAlert   = Boolean(c.alert);
                const deviationPct = (c.deviation * 100).toFixed(1);
                const highPct      = (c.high_pct * 100).toFixed(1);
                const refPct       = (c.ref_high_pct * 100).toFixed(1);
                const direction    = c.high_pct > c.ref_high_pct ? "over-predicting" : "under-predicting";
                return (
                  <div
                    key={c.category}
                    className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                      isAlert ? "bg-red-50 border border-red-200" : "bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {isAlert
                        ? <AlertCircle className="h-4 w-4 text-risk-high shrink-0" />
                        : <CheckCircle2 className="h-4 w-4 text-risk-low shrink-0" />}
                      <span className="font-medium">{c.category}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>HIGH: {highPct}% (ref {refPct}%)</span>
                      <Badge
                        variant="outline"
                        className={isAlert ? "text-risk-high border-risk-high" : "text-risk-low border-risk-low"}
                      >
                        {isAlert ? `${direction} by ${deviationPct}pp` : `±${deviationPct}pp`}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-muted-foreground">
              Alerts when any category's HIGH% deviates &gt;15pp from its training baseline —
              indicates the model may be systematically mis-scoring a specific asset type.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Data Quality Card ─────────────────────────────────────────────────────────

function dqStatusIcon(status: DQCheck["status"]) {
  if (status === "PASS") return <CheckCircle2 className="h-4 w-4 text-risk-low shrink-0 mt-0.5" />;
  if (status === "WARN") return <AlertCircle  className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />;
  return <XCircle className="h-4 w-4 text-risk-high shrink-0 mt-0.5" />;
}

function DataQualityCard() {
  const { data: report, isLoading, error, refetch, isFetching } = useDataQualityReport();

  const overallColor =
    !report            ? "border-slate-200" :
    report.overall === "PASS" ? "border-green-200 bg-green-50/40" :
    report.overall === "WARN" ? "border-amber-200 bg-amber-50/40" :
                                "border-red-200 bg-red-50/40";

  const overallBadge =
    !report            ? null :
    report.overall === "PASS" ? "bg-green-100 text-green-800 border-green-300" :
    report.overall === "WARN" ? "bg-amber-100 text-amber-800 border-amber-300" :
                                "bg-red-100 text-red-800 border-red-300";

  return (
    <Card className={overallColor}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-slate-600" />
            <CardTitle>Training Data Quality</CardTitle>
            {report && (
              <Badge className={`text-xs border ${overallBadge}`}>{report.overall}</Badge>
            )}
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        <CardDescription>
          Runs before every training job — blocks on FAIL, warns on WARN.
          {report && (
            <span className="ml-1">
              {report.pass_count}✓ {report.warn_count > 0 && `${report.warn_count}⚠ `}{report.fail_count > 0 && `${report.fail_count}✗ `}
              · {report.total_rows.toLocaleString()} labeled rows
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Running checks…
          </div>
        )}
        {error && (
          <p className="text-sm text-muted-foreground">
            Could not run quality checks — ML service may be offline or no training data exists yet.
          </p>
        )}
        {report && (
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground mb-3">{report.summary}</p>
            {report.checks.map((c) => (
              <div key={c.check} className="flex items-start gap-2 text-sm">
                {dqStatusIcon(c.status)}
                <div className="min-w-0">
                  <span className="font-mono text-xs text-muted-foreground mr-2">{c.check}</span>
                  <span className={
                    c.status === "FAIL" ? "text-risk-high" :
                    c.status === "WARN" ? "text-amber-700" : "text-slate-700"
                  }>{c.message}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Champion-Challenger Card ──────────────────────────────────────────────────

function MetricCell({ label, value }: { label: string; value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground text-xs">—</span>;
  const pct = value <= 1 ? (value * 100).toFixed(1) + "%" : value.toFixed(3);
  return (
    <div className="text-center">
      <div className="text-sm font-semibold">{pct}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function HorizonRow({
  horizon,
  champ,
  chal,
}: {
  horizon: string;
  champ: HorizonMetrics | undefined;
  chal:  HorizonMetrics | undefined;
}) {
  const delta = (champ?.roc_auc != null && chal?.roc_auc != null)
    ? chal.roc_auc - champ.roc_auc
    : null;

  return (
    <div className="grid grid-cols-[5rem_1fr_1fr_6rem] gap-2 items-center py-2 border-b last:border-0">
      <span className="text-sm font-medium text-center">{horizon}</span>
      <div className="flex justify-around">
        <MetricCell label="ROC-AUC"  value={champ?.roc_auc} />
        <MetricCell label="Recall"   value={champ?.recall_fail} />
        <MetricCell label="PR-AUC"   value={champ?.pr_auc} />
      </div>
      <div className="flex justify-around">
        <MetricCell label="ROC-AUC"  value={chal?.roc_auc} />
        <MetricCell label="Recall"   value={chal?.recall_fail} />
        <MetricCell label="PR-AUC"   value={chal?.pr_auc} />
      </div>
      <div className="text-center text-xs font-mono">
        {delta != null ? (
          <span className={delta > 0.005 ? "text-risk-low font-semibold" : delta < -0.005 ? "text-risk-high font-semibold" : "text-muted-foreground"}>
            {delta > 0 ? "+" : ""}{(delta * 100).toFixed(1)}pp
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}

function ChampionChallengerCard() {
  const { data: compare, isLoading } = useChampionChallengerCompare();
  const { data: registry }           = useModelRegistry();
  const promote                      = usePromoteChallenger();
  const { data: authData }           = useQuery({ queryKey: ["/api/auth/me"] } as any) as any;
  const isAdmin = authData?.role === "ADMINISTRATOR";

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Swords className="h-5 w-5" />Champion vs Challenger</CardTitle></CardHeader>
        <CardContent><Loader2 className="h-5 w-5 animate-spin" /></CardContent>
      </Card>
    );
  }

  if (!compare) return null;

  const horizons = ["10d", "30d", "60d"];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Swords className="h-5 w-5 text-muted-foreground" />
              Champion vs Challenger
            </CardTitle>
            <CardDescription className="mt-1">
              Challenger runs in{" "}
              <span className="font-medium text-amber-600">shadow mode</span>{" "}
              — scores every batch but predictions are not persisted until promoted.
            </CardDescription>
          </div>
          {compare.challenger && isAdmin && (
            <button
              onClick={() => promote.mutate()}
              disabled={promote.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
            >
              {promote.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Crown className="h-4 w-4" />
              )}
              Promote Challenger
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Version badges */}
        <div className="grid grid-cols-[5rem_1fr_1fr_6rem] gap-2 items-center">
          <span />
          <div className="flex items-center gap-2 justify-center">
            <Trophy className="h-4 w-4 text-risk-medium" />
            <span className="font-semibold text-sm">{compare.champion.version ?? "—"}</span>
            <Badge className="bg-yellow-100 text-yellow-800 border-yellow-300 text-xs">champion</Badge>
          </div>
          <div className="flex items-center gap-2 justify-center">
            <Swords className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold text-sm">{compare.challenger?.version ?? "—"}</span>
            {compare.challenger ? (
              <Badge className="bg-purple-100 text-purple-800 border-purple-300 text-xs">challenger</Badge>
            ) : (
              <span className="text-xs text-muted-foreground italic">no challenger</span>
            )}
          </div>
          <div className="text-center text-xs text-muted-foreground font-medium">Δ ROC-AUC</div>
        </div>

        {/* Per-horizon rows */}
        <div>
          {horizons.map((h) => (
            <HorizonRow
              key={h}
              horizon={h}
              champ={compare.champion.metrics?.[h]}
              chal={compare.challenger?.metrics?.[h]}
            />
          ))}
        </div>

        {/* History */}
        {registry && registry.history.length > 0 && (
          <div className="space-y-1 pt-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Promotion history</p>
            {registry.history.slice(-4).reverse().map((ev, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3 shrink-0" />
                <span className="font-mono">{ev.version ?? (ev as any).new_champion ?? "—"}</span>
                <span className="capitalize">{ev.event.replace(/_/g, " ")}</span>
                {ev.role && <Badge variant="outline" className="text-[10px] px-1 py-0">{ev.role}</Badge>}
                <span className="ml-auto">{new Date(ev.timestamp).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MLPerformanceDashboard() {
  const { data: modelMetrics, isLoading, error } = useModelMetrics();
  // The setup checklist below reports real progress, so it needs the same
  // counts the rest of the app uses rather than hardcoded flags.
  const { data: systemStatus } = useSystemStatus();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading model metrics...</p>
        </div>
      </div>
    );
  }

  // Honest empty state: API says no trained model exists (available:false) —
  // show the setup path instead of fabricated numbers (ML-9).
  if (error || !modelMetrics || !modelMetrics.available) {
    // Each step reports whether it is actually satisfied. These were
    // hardcoded -- step one always complete, the rest never -- so following
    // a step's link did the work but the checklist never acknowledged it,
    // leaving no way to tell what still needed doing.
    const equipmentCount = systemStatus?.equipmentCount ?? 0;
    const snapshotCount  = systemStatus?.snapshotCount ?? 0;
    const modelTrained   = systemStatus?.modelTrained ?? false;

    // The ML service's own gate: engine/data_quality.py FAILs below 500
    // labeled rows. This said 100, which matched nothing -- not the 40 a demo
    // seed produces, and not the floor the service actually enforces, so the
    // checklist implied training was close to possible when it was not.
    const MIN_SNAPSHOTS_TO_TRAIN = 500;

    const steps = [
      {
        done: !!systemStatus,
        label: "System initialized",
        detail: systemStatus
          ? "Database ready and schema applied"
          : "Waiting for the API",
      },
      {
        done: equipmentCount > 0,
        label: "Add equipment",
        detail: equipmentCount > 0
          ? `${equipmentCount} asset${equipmentCount === 1 ? "" : "s"} registered`
          : "At least one asset is required to generate sensor data",
        href: "/equipment",
        action: "Add Equipment",
      },
      {
        done: snapshotCount > 0,
        label: "Run demo seed (or accumulate live data)",
        detail: snapshotCount > 0
          ? `${snapshotCount} feature snapshot${snapshotCount === 1 ? "" : "s"} recorded`
          : "Load Demo Data on the Setup page to populate historical snapshots and failure events",
        href: "/setup",
        action: "Go to Setup",
      },
      {
        done: modelTrained,
        label: "Register or train a model",
        detail: modelTrained
          ? "A model is registered"
          : snapshotCount >= MIN_SNAPSHOTS_TO_TRAIN
            ? `${snapshotCount} snapshots available — training can run now`
            : `${snapshotCount} of ${MIN_SNAPSHOTS_TO_TRAIN} labeled snapshots needed to train a new model. ` +
              `The service ships an evaluated model; it registers itself on restart or when a seed runs.`,
        href: "/predictive-maintenance",
        action: "Predictive Maintenance",
      },
    ];

    return (
      <div className="space-y-8 animate-in fade-in duration-500 max-w-2xl mx-auto py-16 px-4">
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <div className="rounded-full bg-blue-100 p-4">
              <Brain className="h-10 w-10 text-primary" />
            </div>
          </div>
          {/* Named for the sidebar entry that leads here. Calling itself the
              "ML Dashboard" sent someone looking for a page by that name. */}
          <h2 className="text-2xl font-bold">Model Performance isn't ready yet</h2>
          <p className="text-muted-foreground">
            No model is registered yet, so there are no metrics to show.
          </p>
          {/* Reachable from the empty state, which is the state it exists to
              get you out of. It was previously in the header below, which
              renders only once metrics are available. */}
          <div className="flex justify-center pt-1">
            <ScoreFleetButton />
          </div>
        </div>

        <div className="space-y-3">
          {steps.map((step, i) => (
            <div
              key={i}
              className={`flex items-start gap-4 rounded-lg border p-4 ${
                step.done ? "bg-green-50 border-green-200" : "bg-card"
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {step.done ? (
                  <CheckCircle2 className="h-5 w-5 text-risk-low" />
                ) : (
                  <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/40 flex items-center justify-center text-xs font-bold text-muted-foreground">
                    {i + 1}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`font-medium ${step.done ? "text-green-800" : ""}`}>{step.label}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{step.detail}</p>
              </div>
              {!step.done && step.href && (
                <Link href={step.href}>
                  <a className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                    {step.action}
                    <ArrowRight className="h-3 w-3" />
                  </a>
                </Link>
              )}
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Once training completes this page will populate automatically.
        </p>
      </div>
    );
  }

  // Each horizon (10d/30d/60d) is an independent binary failure classifier —
  // metrics are shown per horizon under their real names (ML-9).
  const horizonKeys = ["10", "30", "60"].filter(h => modelMetrics.horizons?.[h]);
  const horizonRows = horizonKeys.map(h => ({
    key: h,
    label: `${h}d`,
    ...modelMetrics.horizons![h],
  }));
  const m30 = modelMetrics.horizons?.["30"];

  const featureImportance = modelMetrics.featureImportance ?? [];
  const predictionHistory = modelMetrics.predictionHistory ?? [];
  const hyperparameters = modelMetrics.hyperparameters ?? null;

  // Failure-class performance per horizon (the class that matters operationally)
  const failureClassPerformance = horizonRows.map(r => ({
    horizon: r.label,
    precision: r.precisionFailure ?? 0,
    recall: r.recallFailure ?? 0,
    f1: r.f1Failure ?? 0,
  }));

  // Insight inputs
  const topFeature    = featureImportance[0]?.feature;
  const secondFeature = featureImportance[1]?.feature;
  const topTwo        = (
    (featureImportance[0]?.importance ?? 0) +
    (featureImportance[1]?.importance ?? 0)
  ) * 100;
  const pct = (v: number | undefined, digits = 1) =>
    v === undefined ? "n/a" : `${(v * 100).toFixed(digits)}%`;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">ML Model Performance</h2>
          <p className="text-muted-foreground">
            Predictive maintenance model evaluation and monitoring
          </p>
        </div>
        <ScoreFleetButton />
      </div>

      {/* The drift and governance cards below come from the ML service; the
          metrics above come from the database and are fine either way. */}
      <MlServiceNotice />

      {/* Model provenance strip — version, training date, data source up front */}
      <Alert className="border-border bg-card">
        <CheckCircle2 className="h-4 w-4 text-primary" />
        <AlertDescription className="text-foreground">
          <span className="font-mono font-semibold">{modelMetrics.version}</span>
          <span className="text-muted-foreground"> · trained {modelMetrics.trainedAt ? new Date(modelMetrics.trainedAt).toLocaleDateString() : "—"} · 30d holdout ROC-AUC </span>
          <span className="font-mono font-semibold tabular-nums">{m30?.rocAuc?.toFixed(3) ?? "n/a"}</span>
          {"  "}
          <Badge variant="outline" className="ml-2 align-middle bg-risk-medium-surface text-risk-medium border-risk-medium">
            {modelMetrics.dataSource === "simulated" ? "Simulated data" : modelMetrics.dataSource}
          </Badge>
          {modelMetrics.dataSource === "simulated" && (
            <span className="block text-xs text-muted-foreground mt-1">
              Metrics verify the training pipeline on simulator-generated labels — they are not field performance.
            </span>
          )}
        </AlertDescription>
      </Alert>

      {/* Key Metrics Cards — 30d horizon (primary operational window), temporal holdout.
          Neutral stat tiles: the numbers carry the weight, not decoration. */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">ROC-AUC (30d)</p>
              <Target className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {m30?.rocAuc?.toFixed(3) ?? "n/a"}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Temporal holdout, 30-day horizon
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Failure Recall (30d)</p>
              <Activity className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {pct(m30?.recallFailure)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Share of actual failures caught — the costly error is missing one
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Failure Precision (30d)</p>
              <TrendingUp className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {pct(m30?.precisionFailure)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              How often a flagged unit actually fails
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">PR-AUC (30d)</p>
              <Zap className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {m30?.prAuc?.toFixed(3) ?? "n/a"}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Precision-recall trade-off; baseline = positive rate ({pct(m30?.positiveRateTest, 0)})
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Per-horizon summary table — all metrics under their real names */}
      <Card>
        <CardHeader>
          <CardTitle>Per-Horizon Holdout Metrics</CardTitle>
          <CardDescription>
            Each horizon is an independent binary classifier evaluated on a time-based holdout
            (most recent ~20% of snapshots). CV = TimeSeriesSplit on the training window.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left font-medium">Horizon</th>
                  <th className="p-3 text-right font-medium">ROC-AUC</th>
                  <th className="p-3 text-right font-medium">CV ROC-AUC</th>
                  <th className="p-3 text-right font-medium">PR-AUC</th>
                  <th className="p-3 text-right font-medium">Recall (failure)</th>
                  <th className="p-3 text-right font-medium">Precision (failure)</th>
                  <th className="p-3 text-right font-medium" title="Brier score — lower is better">Brier</th>
                  <th className="p-3 text-right font-medium" title="Expected calibration error — gate < 0.05">ECE</th>
                  <th className="p-3 text-right font-medium">Positive rate</th>
                  <th className="p-3 text-right font-medium">Test n</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {horizonRows.map((r) => (
                  <tr key={r.key}>
                    <td className="p-3 font-medium">{r.label}</td>
                    <td className="p-3 text-right font-mono">{r.rocAuc?.toFixed(4) ?? "n/a"}</td>
                    <td className="p-3 text-right font-mono">
                      {r.cvRocAucMean !== undefined
                        ? `${r.cvRocAucMean.toFixed(3)} ± ${(r.cvRocAucStd ?? 0).toFixed(3)}`
                        : "n/a"}
                    </td>
                    <td className="p-3 text-right font-mono">{r.prAuc?.toFixed(4) ?? "n/a"}</td>
                    <td className="p-3 text-right font-mono">{pct(r.recallFailure)}</td>
                    <td className="p-3 text-right font-mono">{pct(r.precisionFailure)}</td>
                    <td className="p-3 text-right font-mono">{r.brier?.toFixed(4) ?? "n/a"}</td>
                    <td className={cn("p-3 text-right font-mono", r.ece !== undefined && (r.ece < 0.05 ? "text-risk-low" : "text-risk-medium"))}>
                      {r.ece?.toFixed(4) ?? "n/a"}
                    </td>
                    <td className="p-3 text-right font-mono">{pct(r.positiveRateTest, 0)}</td>
                    <td className="p-3 text-right font-mono">{r.samplesTest?.toLocaleString() ?? "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Operator metrics (ML-3) — evaluated where the business acts */}
      <Card>
        <CardHeader>
          <CardTitle>Operator Metrics</CardTitle>
          <CardDescription>
            Evaluated at the HIGH operating threshold. Temporal split answers "same fleet, next
            quarter"; the by-asset split (GroupKFold over equipment) answers "a new fleet, day one" —
            the honest deployment question for a customer whose units the model has never seen.
            Precision@budget = precision inside the weekly top-10%-of-fleet work queue.
            Lead time = median days from first HIGH flag to the actual failure (must exceed ~7d PM
            scheduling latency to be actionable).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left font-medium">Horizon</th>
                  <th className="p-3 text-left font-medium">Split</th>
                  <th className="p-3 text-right font-medium">ROC-AUC</th>
                  <th className="p-3 text-right font-medium">Recall @ HIGH</th>
                  <th className="p-3 text-right font-medium">Precision @ budget</th>
                  <th className="p-3 text-right font-medium">Lead time (median)</th>
                  <th className="p-3 text-right font-medium">Failures flagged</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {horizonKeys.flatMap((h) => {
                  const t = modelMetrics.horizons?.[h];
                  const a = modelMetrics.horizonsByAsset?.[h];
                  const fmtDays = (v?: number) => v === undefined ? "n/a" : `${v.toFixed(0)}d`;
                  const rows = [
                    { split: "Temporal", rocAuc: t?.rocAuc, rec: t?.recallFailureOperating, pab: t?.precisionAtBudget, lead: t?.leadTimeMedianDays, flag: t?.leadTimeFailuresFlaggedPct },
                    ...(a ? [{ split: "By-asset", rocAuc: a.rocAuc, rec: a.recallFailureOperating, pab: a.precisionAtBudget, lead: a.leadTimeMedianDays, flag: a.leadTimeFailuresFlaggedPct }] : []),
                  ];
                  return rows.map((r) => (
                    <tr key={`${h}-${r.split}`}>
                      <td className="p-3 font-medium">{r.split === "Temporal" ? `${h}d` : ""}</td>
                      <td className="p-3">{r.split}</td>
                      <td className="p-3 text-right font-mono">{r.rocAuc?.toFixed(4) ?? "n/a"}</td>
                      <td className="p-3 text-right font-mono">{pct(r.rec)}</td>
                      <td className="p-3 text-right font-mono">{pct(r.pab)}</td>
                      <td className="p-3 text-right font-mono">{fmtDays(r.lead)}</td>
                      <td className="p-3 text-right font-mono">{pct(r.flag, 0)}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            "n/a" means the metric had nothing to measure on that split (e.g. no evaluable failure
            events) — never a fabricated default.
          </p>
        </CardContent>
      </Card>

      {/* Charts Row 1: Feature Importance & Class Performance */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Feature Importance</CardTitle>
            <CardDescription>
              Which features drive failure predictions (higher = more influential)
            </CardDescription>
            {modelMetrics.dataSource === "simulated" && (
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                On simulated data these recover the generator rather than discover
                anything. The simulator draws failures from a function of asset age,
                lifetime hours and maintenance recency, and the model is given all
                three — so age and wear ranking highly is arithmetic, not a finding.
                The attribution machinery is real and would be informative on field
                data.
              </p>
            )}
          </CardHeader>
          <CardContent>
            {featureImportance.length === 0 ? (
              <div className="h-[350px] flex items-center justify-center text-sm text-muted-foreground text-center px-8">
                Feature importance unavailable — the ML service is not reachable.
                Live values appear here when it's running.
              </div>
            ) : (
              <>
                <div className="h-[350px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={featureImportance} layout="vertical">
                      <CartesianGrid {...CHART.grid} horizontal={true} vertical={false} />
                      <XAxis
                        type="number"
                        domain={[0, 0.3]}
                        tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
                        stroke={CHART.axis.stroke}
                        tick={CHART.axis.tick}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="feature"
                        width={150}
                        stroke={CHART.axis.stroke}
                        tick={CHART.axis.tick}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        formatter={(value: number) => `${(value * 100).toFixed(1)}%`}
                        {...CHART.tooltip}
                      />
                      {/* One measure (importance) — one hue; magnitude is the bar length */}
                      <Bar dataKey="importance" fill={CHART.data} radius={CHART.barRadiusHorizontal} maxBarSize={16} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                  {featureImportance.slice(0, 3).map((feat, idx) => (
                    <div key={idx}>
                      <strong>{feat.feature}:</strong> {feat.description}
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Failure-Class Performance by Horizon</CardTitle>
            <CardDescription>
              Precision, recall, and F1 on the failure class — per prediction window (temporal holdout)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={failureClassPerformance} barGap={2}>
                  <CartesianGrid {...CHART.grid} vertical={false} />
                  <XAxis dataKey="horizon" stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                  <YAxis domain={[0, 1]} tickFormatter={(value) => `${(value * 100).toFixed(0)}%`} stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                  <Tooltip
                    formatter={(value: number) => `${(value * 100).toFixed(1)}%`}
                    {...CHART.tooltip}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
                  {/* Three measures — fixed categorical order, never cycled */}
                  <Bar dataKey="precision" fill={CHART.categorical[0]} name="Precision (failure)" radius={CHART.barRadius} maxBarSize={28} />
                  <Bar dataKey="recall" fill={CHART.categorical[1]} name="Recall (failure)" radius={CHART.barRadius} maxBarSize={28} />
                  <Bar dataKey="f1" fill={CHART.categorical[2]} name="F1 (failure)" radius={CHART.barRadius} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-4 text-center text-xs">
              <div>
                <div className="font-medium">Precision</div>
                <div className="text-muted-foreground">Flagged units that actually fail</div>
              </div>
              <div>
                <div className="font-medium">Recall</div>
                <div className="text-muted-foreground">Actual failures caught</div>
              </div>
              <div>
                <div className="font-medium">F1</div>
                <div className="text-muted-foreground">Balance of the two</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row 2: Confusion Matrix & Prediction History */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Confusion Matrices (binary, per horizon)</CardTitle>
            <CardDescription>
              Actual vs predicted failure on each horizon's temporal holdout set
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {horizonRows.map((r) => (
                <div key={r.key} className="rounded-lg border overflow-hidden">
                  <div className="bg-slate-50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {r.label} horizon · {r.samplesTest?.toLocaleString() ?? "?"} holdout samples
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="p-2 text-left font-medium">Actual \ Predicted</th>
                        <th className="p-2 text-center font-medium text-risk-high">Failure</th>
                        <th className="p-2 text-center font-medium text-risk-low">No failure</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y text-sm">
                      <tr>
                        <td className="p-2 font-medium text-risk-high">Failure</td>
                        <td className="p-2 text-center font-bold bg-green-50">{r.confusion.tp.toLocaleString()}</td>
                        <td className="p-2 text-center font-bold text-risk-high">{r.confusion.fn.toLocaleString()}</td>
                      </tr>
                      <tr>
                        <td className="p-2 font-medium text-risk-low">No failure</td>
                        <td className="p-2 text-center font-bold">{r.confusion.fp.toLocaleString()}</td>
                        <td className="p-2 text-center font-bold bg-green-50">{r.confusion.tn.toLocaleString()}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
              <div className="space-y-2 text-xs">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-risk-high mt-0.5" />
                  <div>
                    <strong>False negatives</strong> (top-right, red) are missed failures — the operationally
                    expensive error in maintenance scheduling.
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-risk-low mt-0.5" />
                  <div><strong>Diagonal cells</strong> (highlighted) are correct predictions.</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prediction Distribution Over Time</CardTitle>
            <CardDescription>
              Monthly breakdown of risk classifications
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={predictionHistory}>
                  <CartesianGrid {...CHART.grid} vertical={false} />
                  <XAxis dataKey="date" stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                  <YAxis stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                  <Tooltip {...CHART.tooltip} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
                  {/* Risk bands wear the reserved semantic colors; the total is a recessive dashed neutral */}
                  <Line type="monotone" dataKey="high" stroke={CHART.risk.high} strokeWidth={CHART.line.strokeWidth} dot={CHART.line.dot} activeDot={CHART.line.activeDot} name="High Risk" />
                  <Line type="monotone" dataKey="medium" stroke={CHART.risk.medium} strokeWidth={CHART.line.strokeWidth} dot={CHART.line.dot} activeDot={CHART.line.activeDot} name="Medium Risk" />
                  <Line type="monotone" dataKey="low" stroke={CHART.risk.low} strokeWidth={CHART.line.strokeWidth} dot={CHART.line.dot} activeDot={CHART.line.activeDot} name="Low Risk" />
                  <Line type="monotone" dataKey="total" stroke={CHART.neutral} strokeWidth={1.5} strokeDasharray="5 5" dot={false} name="Total" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 text-xs text-muted-foreground">
              Shows the distribution of risk predictions across the fleet over time. 
              Trends can indicate seasonal patterns or fleet aging effects.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Model Metadata */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              <CardTitle>Model Information</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center pb-3 border-b">
                <span className="text-sm text-muted-foreground">Model Version</span>
                <Badge variant="outline" className="bg-blue-50 text-blue-700">
                  {modelMetrics.version}
                </Badge>
              </div>
              <div className="flex justify-between items-center pb-3 border-b">
                <span className="text-sm text-muted-foreground">Algorithm</span>
                <span className="text-sm font-medium">{hyperparameters?.algorithm ?? "—"}</span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b">
                <span className="text-sm text-muted-foreground">Training Date</span>
                <span className="text-sm font-medium">
                  {modelMetrics.trainedAt ? new Date(modelMetrics.trainedAt).toLocaleDateString() : "—"}
                </span>
              </div>
              <div className="flex justify-between items-center pb-3 border-b">
                <span className="text-sm text-muted-foreground">Training Dataset Size</span>
                <span className="text-sm font-medium">
                  {modelMetrics.datasetSize != null ? `${modelMetrics.datasetSize.toLocaleString()} samples` : "—"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Data Source</span>
                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                  {modelMetrics.dataSource === "simulated" ? "Simulated (fleet simulator)" : modelMetrics.dataSource}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Hyperparameters</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {!hyperparameters ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Hyperparameters unavailable — the ML service is not reachable.
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  <div className="flex justify-between items-center pb-3 border-b">
                    <span className="text-sm text-muted-foreground">Number of Estimators</span>
                    <span className="text-sm font-mono font-medium">{hyperparameters.nEstimators ?? "—"}</span>
                  </div>
                  <div className="flex justify-between items-center pb-3 border-b">
                    <span className="text-sm text-muted-foreground">Max Depth</span>
                    <span className="text-sm font-mono font-medium">{hyperparameters.maxDepth ?? "—"}</span>
                  </div>
                  <div className="flex justify-between items-center pb-3 border-b">
                    <span className="text-sm text-muted-foreground">Min Samples Split</span>
                    <span className="text-sm font-mono font-medium">{hyperparameters.minSamplesSplit ?? "—"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Class Weight</span>
                    <span className="text-sm font-mono font-medium">{hyperparameters.classWeight ?? "—"}</span>
                  </div>
                </div>
                <div className="mt-4 p-3 bg-slate-50 rounded-lg text-xs text-muted-foreground">
                  <strong>Note:</strong> Class weights are balanced to handle imbalanced training data and
                  prevent bias toward majority classes.
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Drift Monitoring — three layers */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-800">Drift Monitoring</h2>
        <DriftMonitorCard />
        <PredictionDriftCard />
        <BiasDriftCard />
      </div>

      {/* Model Governance */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-800">Model Governance</h2>
        <DataQualityCard />
        <ChampionChallengerCard />
      </div>

      {/* Key Insights — derived from real per-horizon holdout metrics only */}
      <Card className="border-blue-200 bg-blue-50">
        <CardHeader>
          <CardTitle className="text-blue-900">Key Model Insights</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-blue-900">
          {/* Failure recall per horizon */}
          {horizonRows.map((r) => {
            const recall = r.recallFailure;
            const ok = recall !== undefined && recall >= 0.7;
            return (
              <div key={r.key} className="flex items-start gap-2">
                {ok
                  ? <CheckCircle2 className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  : <AlertCircle className="h-5 w-5 text-orange-600 mt-0.5 flex-shrink-0" />
                }
                <div>
                  <strong>{r.label} failure recall ({pct(recall, 0)}):</strong>{" "}
                  {recall === undefined
                    ? "No holdout metrics recorded for this horizon."
                    : ok
                      ? `Catches most failures in the ${r.label} window at the current threshold; ${r.confusion.fn.toLocaleString()} missed on the holdout set.`
                      : `Below the 70% operating target — ${r.confusion.fn.toLocaleString()} failures missed on the holdout set. Longer horizons are inherently harder; review threshold choice before acting on ${r.label} scores.`
                  }
                </div>
              </div>
            );
          })}
          {/* Accuracy vs naive baseline — honest framing for imbalanced data */}
          {m30?.accuracy !== undefined && m30?.positiveRateTest !== undefined && (
            <div className="flex items-start gap-2">
              <Target className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <strong>Accuracy in context:</strong> 30d accuracy is {pct(m30.accuracy)}, vs{" "}
                {pct(1 - m30.positiveRateTest)} for a naive "never fails" baseline that catches zero
                failures — recall on the failure class is the number that matters operationally.
              </div>
            </div>
          )}
          {/* Top features */}
          {topFeature && secondFeature && (
            <div className="flex items-start gap-2">
              <TrendingUp className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <strong>Top predictive features:</strong> {topFeature} and {secondFeature} contribute{" "}
                {topTwo.toFixed(0)}% of prediction power.
              </div>
            </div>
          )}
          {/* Provenance */}
          {modelMetrics.dataSource === "simulated" && (
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Data provenance:</strong> all training labels come from the fleet simulator.
                These metrics validate the pipeline end-to-end; they are not evidence of field
                performance until real fleet maintenance outcomes are used for training.
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}