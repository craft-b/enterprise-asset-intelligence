import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiError, type ApiError } from "@/lib/api-error";
import { useToast } from "@/hooks/use-toast";
import { retryWhileWaking, wakeRetryDelay } from "@/lib/wake-retry";

// ─── Types ────────────────────────────────────────────────────────────────────

type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
type Horizon = "10d" | "30d" | "60d";
type RiskTrend = "INCREASING" | "DECREASING" | "STABLE";

interface HorizonPrediction {
  failure_probability: number;
  risk_level: RiskLevel;
  risk_score: number;
  model_confidence: string;
  top_risk_drivers: Record<string, number>;
}

export interface MultiHorizonResult {
  equipmentId: number;
  modelVersion: string;
  riskTrend: RiskTrend;
  predictions: Record<Horizon, HorizonPrediction>;
  recommendation: string;
}

// ─── Multi-horizon batch scoring ──────────────────────────────────────────────

export function useMultiHorizonRiskScores() {
  const [scores, setScores] = useState<MultiHorizonResult[]>([]);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  /**
   * Refresh everything the batch writes.
   *
   * Called from both outcomes rather than only from success, because a run
   * that ends in a waking error can still have stored the rule-scored assets.
   */
  function refreshDependentViews(): void {
    for (const key of [
      ["/api/risk-score/multi-horizon/latest"],
      ["/api/ml/drift/latest"],
      ["/api/ml/drift/prediction"],
      ["/api/ml/drift/bias"],
    ]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  }

  const mutation = useMutation({
    mutationFn: async (equipmentIds: number[]) => {
      const res = await fetch("/api/risk-score/multi-horizon/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ equipmentIds }),
        credentials: "include",
      });
      if (!res.ok) throw await apiError(res, "Failed to calculate multi-horizon risk scores");
      return res.json() as Promise<MultiHorizonResult[]>;
    },
    // A suspended ML service is a wait, not a failure. See lib/wake-retry.ts.
    retry: retryWhileWaking,
    retryDelay: wakeRetryDelay,
    onSuccess: (data) => {
      setScores(data);

      // This used to be the whole handler, and the run looked like it had done
      // nothing. The batch writes stored predictions and all three drift
      // layers, but every view of them is a cached query: the drift hooks hold
      // results for two minutes and the client sets refetchOnWindowFocus and
      // refetchInterval to false globally. So the scoring happened, the rows
      // landed, and the dashboard kept rendering the state from before the
      // click until someone reloaded the page.
      //
      // The sibling that fills the risk queue, useScoreRiskQueue, has always
      // invalidated its two queries, and use-maintenance.ts invalidates
      // multi-horizon/latest around the same endpoint. This call site was the
      // one that did not.
      refreshDependentViews();

      // And say so. A long-running action that completes in silence is
      // indistinguishable from one that failed quietly, which is the thing
      // this dashboard keeps being caught doing.
      toast({
        title: "Multi-horizon forecast complete",
        description: `Scored ${data.length} asset${data.length === 1 ? "" : "s"} at 10, 30 and 60 days.`,
      });
    },
    onError: (err: unknown) => {
      // Only reached once the wake retries are exhausted; a service still
      // booting is a wait, not a failure.
      //
      // Even then the run is not necessarily empty. Assets a rule scores need
      // no ML service and are stored regardless, so a fleet that gave up
      // waiting can still have left a dozen forecasts in the database. Those
      // have to be shown, or the failure toast is telling the user there is
      // nothing to see while there is.
      const stored = (err as ApiError)?.stored ?? 0;
      if (stored > 0) refreshDependentViews();

      toast({
        title: stored > 0 ? "Multi-horizon forecast incomplete" : "Multi-horizon forecast failed",
        description:
          (err instanceof Error ? err.message : "Failed to score the fleet") +
          (stored > 0
            ? ` ${stored} asset${stored === 1 ? "" : "s"} scored without the model and were saved.`
            : ""),
        variant: "destructive",
      });
    },
  });

  return { scores, mutation };
}

// ─── Latest stored multi-horizon predictions ──────────────────────────────────

export function useLatestMultiHorizonPredictions() {
  return useQuery({
    queryKey: ["/api/risk-score/multi-horizon/latest"],
    queryFn: async () => {
      const res = await fetch("/api/risk-score/multi-horizon/latest", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw await apiError(res, "Failed to fetch latest predictions");
      return res.json();
    },
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
}

// ─── Risk score history for a single unit ────────────────────────────────────

export function useRiskScoreHistory(equipmentId: number) {
  return useQuery({
    queryKey: [api.riskScore.history.path, equipmentId],
    queryFn: async () => {
      const res = await fetch(`/api/risk-score/equipment/${equipmentId}/history`, {
        credentials: "include",
      });
      if (!res.ok) throw await apiError(res, "Failed to fetch risk score history");
      return api.riskScore.history.responses[200].parse(await res.json());
    },
    enabled: !!equipmentId,
  });
}