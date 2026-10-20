import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiError } from "@/lib/api-error";
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