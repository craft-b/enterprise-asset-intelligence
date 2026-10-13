import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { dismissSetupGate } from "@/lib/setup-gate";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useSystemStatus, useSeedStatus } from "@/hooks/use-system-status";
import { useAuth } from "@/hooks/use-auth";
import {
  Database,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ChevronRight,
  BarChart3,
  Wrench,
  Truck,
} from "lucide-react";

export default function SetupPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [seedingStarted, setSeedingStarted] = useState(false);
  const [mode, setMode] = useState<"choose" | "active" | "seeding" | "done">("choose");
  const [confirmReset, setConfirmReset] = useState(false);

  // Set once the admin resets, so the effect below cannot bounce them back to
  // the "active" view on the stale status that is still cached while the
  // invalidated query refetches.
  const [didReset, setDidReset] = useState(false);

  const { data: systemStatus } = useSystemStatus();

  const { data: seedJob } = useSeedStatus(seedingStarted && mode === "seeding");

  // Show the "active" summary when someone navigates here directly and the
  // system already has data. Skipped after a reset: the status query serves
  // its cached seeded:true until the refetch lands, which would otherwise
  // throw the admin straight back out of the setup choices they just asked
  // for -- showing 0 units, with no way back without a reload.
  useEffect(() => {
    if (systemStatus?.seeded && mode === "choose" && !didReset) {
      setMode("active");
    }
  }, [systemStatus, mode, didReset]);

  // Detect completion/failure
  useEffect(() => {
    if (!seedJob) return;
    if (seedJob.state === "completed") {
      setMode("done");
      setSeedingStarted(false);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-status"] });
    } else if (seedJob.state === "failed") {
      setMode("done");
      setSeedingStarted(false);
    }
  }, [seedJob, queryClient]);

  const startSeedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/seed", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      setSeedingStarted(true);
      setMode("seeding");
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/reset", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      setConfirmReset(false);
      setDidReset(true);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-status"] });
      setMode("choose");
    },
  });

  const isAdmin = user?.role === "ADMINISTRATOR";

  const progressPct =
    seedJob && seedJob.totalSteps > 0
      ? Math.round((seedJob.currentStep / seedJob.totalSteps) * 100)
      : 0;

  if (mode === "active") {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="h-7 w-7 text-green-600" />
            </div>
            <CardTitle>System is Active</CardTitle>
            <CardDescription>
              {systemStatus?.equipmentCount ?? 0} equipment units · {systemStatus?.snapshotCount ?? 0} snapshots
              {systemStatus?.modelTrained ? " · ML model trained" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button className="w-full" onClick={() => setLocation("/")}>
              Go to Dashboard <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
            {isAdmin && (
              <div className="pt-2 border-t">
                {!confirmReset ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-slate-400 hover:text-red-600 w-full"
                    onClick={() => setConfirmReset(true)}
                  >
                    Reset system &amp; re-run setup
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-red-600 font-medium">
                      This will wipe all equipment, sensors, maintenance history, and predictions. Are you sure?
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => setConfirmReset(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="flex-1"
                        onClick={() => resetMutation.mutate()}
                        disabled={resetMutation.isPending}
                      >
                        {resetMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Yes, Reset"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode === "seeding") {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-blue-100 flex items-center justify-center">
              <Database className="h-6 w-6 text-primary animate-pulse" />
            </div>
            <CardTitle>Loading Demo Data</CardTitle>
            <CardDescription>
              Seeding equipment, sensors, maintenance history and training the ML model. This takes
              about 60–90 seconds.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm text-slate-600">
                <span>{seedJob?.stepLabel ?? "Initializing…"}</span>
                <span>
                  {seedJob?.currentStep ?? 0} / {seedJob?.totalSteps ?? 10}
                </span>
              </div>
              <Progress value={progressPct} className="h-2" />
            </div>

            {seedJob && seedJob.log.length > 0 && (
              <div className="rounded-md bg-slate-900 p-3 max-h-48 overflow-y-auto space-y-0.5">
                {seedJob.log.map((line, i) => (
                  <p key={i} className="text-xs font-mono text-slate-300">
                    {line}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode === "done") {
    const success = seedJob?.state === "completed";
    // Steps that were skipped rather than failed. The ML steps need a service
    // that suspends when idle, so this is the ordinary outcome on free
    // hosting, and the run is still worth keeping.
    const warnings = seedJob?.warnings ?? [];

    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <div className="mx-auto mb-3 h-12 w-12 rounded-full flex items-center justify-center">
              {success ? (
                warnings.length > 0 ? (
                  <AlertTriangle className="h-12 w-12 text-amber-500" />
                ) : (
                  <CheckCircle2 className="h-12 w-12 text-green-500" />
                )
              ) : (
                <XCircle className="h-12 w-12 text-red-500" />
              )}
            </div>
            <CardTitle>
              {!success
                ? "Seeding Failed"
                : warnings.length > 0
                  ? "Demo Data Loaded, with gaps"
                  : "Demo Data Loaded"}
            </CardTitle>
            <CardDescription>
              {/* Claiming "a trained ML model" was false whenever training was
                  skipped, which on free hosting is every run. */}
              {success
                ? "10 equipment units, 90 days of sensor data, maintenance history and failure events are loaded."
                : seedJob?.error ?? "An error occurred during setup."}
            </CardDescription>
          </CardHeader>

          {success && warnings.length > 0 && (
            <div className="px-6 pb-2 text-left">
              <ul className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                {warnings.map((w, i) => (
                  <li key={i} className="text-xs text-amber-900 leading-relaxed">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <CardContent>
            {success ? (
              <Button className="w-full" onClick={() => setLocation("/")}>
                Go to Dashboard <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            ) : (
              <Button variant="outline" className="w-full" onClick={() => setMode("choose")}>
                Try Again
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // mode === "choose"
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-primary flex items-center justify-center shadow-lg">
            <Truck className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Welcome to Enterprise Asset Intelligence</h1>
          <p className="text-slate-500 text-sm max-w-md mx-auto">
            Your system has no data yet. Choose how you'd like to get started.
          </p>
        </div>

        {/* Cards */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Load Demo Data */}
          <Card className="border-2 hover:border-blue-400 transition-colors cursor-pointer group">
            <CardHeader className="pb-3">
              <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center mb-2 group-hover:bg-blue-200 transition-colors">
                <Database className="h-5 w-5 text-primary" />
              </div>
              <CardTitle className="text-base">Load Demo Data</CardTitle>
              <CardDescription className="text-xs">
                Populate the system with realistic equipment, 6 months of sensor history, rental
                records, and a trained ML failure-prediction model.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="text-xs text-slate-600 space-y-1">
                {[
                  "10 heavy equipment units (crane, excavator, grader…)",
                  "90 days of sensor readings per asset",
                  "Automated preventive maintenance history",
                  "Trained multi-horizon ML model (10d/30d/60d)",
                  "SHAP feature attribution + MLflow tracking",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
              <Button
                className="w-full"
                onClick={() => startSeedMutation.mutate()}
                disabled={startSeedMutation.isPending || !isAdmin}
              >
                {startSeedMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                Load Demo Data
              </Button>
              {!isAdmin && (
                <p className="text-xs text-amber-600 text-center">Admin role required</p>
              )}
            </CardContent>
          </Card>

          {/* Start Fresh */}
          <Card className="border-2 hover:border-slate-300 transition-colors group">
            <CardHeader className="pb-3">
              <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center mb-2 group-hover:bg-slate-200 transition-colors">
                <Wrench className="h-5 w-5 text-slate-600" />
              </div>
              <CardTitle className="text-base">Start Fresh</CardTitle>
              <CardDescription className="text-xs">
                Skip demo data and bring your own: add equipment, import sensor
                readings from a CSV, and train on your fleet's actual history.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="text-xs text-slate-600 space-y-1">
                {[
                  "Add your own equipment inventory",
                  "Log actual maintenance events",
                  "Import sensor readings from CSV",
                  "Train once ~100 labeled snapshots exist",
                  "No demo fleet in your data",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <BarChart3 className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => { dismissSetupGate(); setLocation("/"); }}
              >
                Go to Dashboard
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Reset (admin only, shown if already visited) */}
        {isAdmin && (
          <div className="text-center">
            <p className="text-xs text-slate-400">
              Already have data?{" "}
              <button
                className="underline text-slate-500 hover:text-slate-700"
                onClick={() => { dismissSetupGate(); setLocation("/"); }}
              >
                Go to Dashboard
              </button>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
