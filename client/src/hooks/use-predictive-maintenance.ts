import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiError } from "@/lib/api-error";
import { retryWhileWaking, wakeRetryDelay } from "@/lib/wake-retry";

// Per-horizon binary metrics as trained/evaluated — each model is a binary
// failure classifier for a 10/30/60-day window, so metrics are reported per
// horizon under their real names (no 3-class re-labeling, ML-9).
export interface HorizonHoldoutMetrics {
  rocAuc?: number;
  prAuc?: number;
  accuracy?: number;
  trainAccuracy?: number;
  cvRocAucMean?: number;
  cvRocAucStd?: number;
  precisionFailure?: number;
  recallFailure?: number;
  f1Failure?: number;
  precisionNoFailure?: number;
  recallNoFailure?: number;
  positiveRateDev?: number;
  positiveRateTest?: number;
  samplesTrain?: number;
  samplesTest?: number;
  // Operator metrics (ML-3), evaluated at the HIGH-band operating threshold
  recallFailureOperating?: number;
  precisionAtBudget?: number;
  leadTimeMedianDays?: number;
  leadTimeFailuresFlaggedPct?: number;
  // Calibration quality (ML-5)
  brier?: number;
  ece?: number;
  confusion: { tn: number; fp: number; fn: number; tp: number };
}

// by_asset split: GroupKFold over equipment — "new fleet, day one" question.
// No confusion matrix (pooled out-of-fold predictions, no single threshold split).
export interface HorizonByAssetMetrics {
  rocAuc?: number;
  prAuc?: number;
  positiveRate?: number;
  recallFailureOperating?: number;
  precisionAtBudget?: number;
  leadTimeMedianDays?: number;
  leadTimeFailuresFlaggedPct?: number;
}

export interface ModelMetrics {
  available: boolean;
  dataSource: string; // 'simulated' until real fleet labels exist
  version?: string;
  trainedAt?: string;
  datasetSize?: number | null;
  horizons?: Record<string, HorizonHoldoutMetrics>;
  horizonsByAsset?: Record<string, HorizonByAssetMetrics>;
  featureImportance?: Array<{
    feature: string;
    importance: number;
    description: string;
  }>;
  predictionHistory?: Array<{
    date: string;
    total: number;
    high: number;
    medium: number;
    low: number;
  }>;
  // null when the ML service is unreachable — never defaulted
  hyperparameters?: {
    algorithm: string;
    nEstimators: number | null;
    maxDepth: number | null;
    minSamplesSplit: number | null;
    classWeight: string | null;
  } | null;
}


export interface RiskPrediction {
  equipmentId: number;
  failureProbability: number;
  riskBand: "LOW" | "MEDIUM" | "HIGH";
  topDrivers: Array<{
    feature: string;
    impact: number;
    description: string;
  }>;
  snapshotTs: Date;
  modelVersion: string;
  recommendation: string;
}

export interface FleetRiskDistribution {
  low: number;
  medium: number;
  high: number;
  total: number;
}

export interface EquipmentWithRisk {
  id: number;
  equipmentId: string;
  name: string;
  category: string;
  status: string;
  risk: {
    riskBand: "LOW" | "MEDIUM" | "HIGH";
    failureProbability: number;
    recommendation: string;
    predictedAt: Date;
    topDrivers: Array<{
      feature: string;
      impact: number;
      description: string;
    }>;
  } | null;
}

export interface ProjectionPoint {
  day: number;
  "10d": number;
  "30d": number;
  "60d": number;
}

export interface ProjectionResult {
  equipment_id: number;
  step_days: number;
  max_days: number;
  curve: ProjectionPoint[];
  threshold_crossings: {
    "10d": number | null;
    "30d": number | null;
    "60d": number | null;
  };
  days_until_high: number | null;
}

export function useEquipmentProjection(equipmentId: number | null) {
  return useQuery<ProjectionResult>({
    queryKey: ["/api/equipment/:id/projection", equipmentId],
    queryFn: async () => {
      const res = await fetch(`/api/equipment/${equipmentId}/projection`, {
        credentials: "include",
      });
      if (!res.ok) throw await apiError(res, "Failed to fetch projection");
      return res.json();
    },
    enabled: !!equipmentId,
    staleTime: 5 * 60 * 1000,
  });
}

// Get risk prediction for single equipment
export function useEquipmentRisk(equipmentId: number) {
  return useQuery<RiskPrediction>({
    queryKey: ['/api/equipment/:id/risk', equipmentId],
    queryFn: async () => {
      const res = await fetch(`/api/equipment/${equipmentId}/risk`, { 
        credentials: "include" 
      });
      if (!res.ok) throw await apiError(res, "Failed to fetch risk prediction");
      return res.json();
    },
    enabled: !!equipmentId,
  });
}

// Get fleet risk distribution
export function useFleetRisk() {
  return useQuery<FleetRiskDistribution>({
    queryKey: ['/api/predictive-maintenance/fleet-risk'],
    queryFn: async () => {
      const res = await fetch('/api/predictive-maintenance/fleet-risk', { 
        credentials: "include" 
      });
      if (!res.ok) throw await apiError(res, "Failed to fetch fleet risk");
      return res.json();
    },
  });
}

// Get equipment list with risk scores
export function useEquipmentWithRisk() {
  return useQuery<EquipmentWithRisk[]>({
    queryKey: ['/api/predictive-maintenance/equipment-with-risk'],
    queryFn: async () => {
      const res = await fetch('/api/predictive-maintenance/equipment-with-risk', { 
        credentials: "include" 
      });
      if (!res.ok) throw await apiError(res, "Failed to fetch equipment with risk");
      return res.json();
    },
  });
}

// Run batch predictions (admin only)
/**
 * Scores every asset and refreshes the 30-day risk queue (POST predict-all).
 *
 * Named useRunPredictions until the name cost three misdiagnoses in one
 * session: it backs the button labelled "Score Fleet", while the button
 * labelled "Run Predictions" is the multi-horizon one below. Each name
 * described the other's button.
 */
export function useScoreRiskQueue() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/predictive-maintenance/predict-all', {
        method: "POST",
        credentials: "include",
      });
      // The server distinguishes "service asleep" from "scored 0 of 10" and
      // says what to do about each; discarding that for a fixed string left
      // an empty risk queue with no explanation.
      if (!res.ok) throw await apiError(res, "Failed to run predictions");
      return res.json().catch(() => null);
    },
    // A suspended ML service is a wait, not a failure. See lib/wake-retry.ts.
    retry: retryWhileWaking,
    retryDelay: wakeRetryDelay,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/predictive-maintenance/fleet-risk'] });
      queryClient.invalidateQueries({ queryKey: ['/api/predictive-maintenance/equipment-with-risk'] });
      toast({
        title: "Predictions Complete",
        description: data?.message ?? `Generated ${data?.count ?? 0} risk predictions`,
      });
    },
    onError: (err: unknown) => {
      // Only reached once the wake retries are exhausted; a service that is
      // still booting is not reported as a failure.
      toast({
        title: "Prediction Failed",
        description: err instanceof Error ? err.message : "Failed to run predictions",
        variant: "destructive",
      });
    },
  });
}

// Generate feature snapshots (admin only)
export function useGenerateSnapshots() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (snapshotDate?: Date) => {
      const res = await fetch('/api/predictive-maintenance/generate-snapshots', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          snapshotDate: snapshotDate?.toISOString() 
        }),
        credentials: "include",
      });
      if (!res.ok) throw await apiError(res, "Failed to generate snapshots");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ 
        title: "Snapshots Generated", 
        description: `Created ${data.count} feature snapshots` 
      });
    },
    onError: (err) => {
      toast({ 
        title: "Snapshot Generation Failed", 
        description: err.message, 
        variant: "destructive" 
      });
    },
  });
}

// Label historical snapshots (admin only)
export function useLabelSnapshots() {
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/predictive-maintenance/label-snapshots', {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw await apiError(res, "Failed to label snapshots");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ 
        title: "Snapshots Labeled", 
        description: `Labeled ${data.count} historical snapshots for training` 
      });
    },
    onError: (err) => {
      toast({ 
        title: "Labeling Failed", 
        description: err.message, 
        variant: "destructive" 
      });
    },
  });
}

export function useModelMetrics() {
  return useQuery<ModelMetrics>({
    queryKey: ['/api/ml/model-metrics'],
    queryFn: async () => {
      const response = await fetch('/api/ml/model-metrics', {
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch model metrics');
      }
      
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

export function useFeatureImportance() {
  return useQuery({
    queryKey: ['/api/ml/feature-importance'],
    queryFn: async () => {
      const response = await fetch('/api/ml/feature-importance', {
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch feature importance');
      }
      
      return response.json();
    },
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
}

export function usePipelineStatus() {
  return useQuery({
    queryKey: ['/api/ml/pipeline-status'],
    queryFn: async () => {
      const res = await fetch('/api/ml/pipeline-status', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch pipeline status');
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });
}

export function useSimulationState() {
  return useQuery({
    queryKey: ["/api/simulate/state"],
    queryFn: async () => {
      const res = await fetch("/api/simulate/state", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch simulation state");
      return res.json();
    },
    refetchInterval: false,
  });
}

export function useSimulateDay() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (days: number) => {
      const res = await fetch("/api/simulate/day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Simulation complete",
        description: `${data.daysSimulated} days simulated — ${data.sensorReadings} sensor readings, ${data.maintenanceEvents} maintenance events generated.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/simulate/state"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ml/pipeline-status"] });
    },
    onError: (e: any) => {
      toast({ title: "Simulation failed", description: e.message, variant: "destructive" });
    },
  });
}

// ── Model retraining ──────────────────────────────────────────────────────────

export function useTrainModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ml/train", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ml/pipeline-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ml/model-metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-score/multi-horizon/latest"] });
    },
  });
}

// ── Drift monitoring ──────────────────────────────────────────────────────────

export interface DriftFeature {
  feature: string;
  psi: number;
  status: "STABLE" | "WARNING" | "ALERT";
  checked_at: string;
  model_version: string;
}

export interface DriftStatus {
  overall: "STABLE" | "WARNING" | "ALERT" | "NO_DATA";
  features: DriftFeature[];
}

export function useDriftStatus() {
  return useQuery<DriftStatus>({
    queryKey: ["/api/ml/drift/latest"],
    queryFn: async () => {
      const res = await fetch("/api/ml/drift/latest", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch drift status");
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useComputeDriftReference() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ml/drift/compute-reference", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ml/drift/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ml/drift/prediction"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ml/drift/bias"] });
      toast({ title: "Reference updated", description: "All drift baselines recomputed from current training data." });
    },
    onError: (e: any) => {
      toast({ title: "Failed to update reference", description: e.message, variant: "destructive" });
    },
  });
}

// ── Prediction drift ──────────────────────────────────────────────────────────

export interface PredictionDriftHorizon {
  horizon: number;
  score_psi: number;
  score_status: "STABLE" | "WARNING" | "ALERT";
  high_pct: number;
  medium_pct: number;
  low_pct: number;
  ref_high_pct: number;
  ref_medium_pct: number;
  ref_low_pct: number;
  checked_at: string;
}

export interface PredictionDriftStatus {
  overall: "STABLE" | "WARNING" | "ALERT" | "NO_DATA";
  horizons: PredictionDriftHorizon[];
}

export function usePredictionDrift() {
  return useQuery<PredictionDriftStatus>({
    queryKey: ["/api/ml/drift/prediction"],
    queryFn: async () => {
      const res = await fetch("/api/ml/drift/prediction", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch prediction drift");
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

// ── Bias drift ────────────────────────────────────────────────────────────────

export interface BiasDriftCategory {
  category: string;
  mean_score: number;
  high_pct: number;
  ref_high_pct: number;
  deviation: number;
  alert: number | boolean;
  checked_at: string;
}

export interface BiasDriftStatus {
  overall: "STABLE" | "ALERT" | "NO_DATA";
  categories: BiasDriftCategory[];
}

export function useBiasDrift() {
  return useQuery<BiasDriftStatus>({
    queryKey: ["/api/ml/drift/bias"],
    queryFn: async () => {
      const res = await fetch("/api/ml/drift/bias", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch bias drift");
      return res.json();
    },
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

// ── Champion-Challenger ──────────────────────────────────────────────────────

export interface HorizonMetrics {
  roc_auc:        number | null;
  pr_auc:         number | null;
  recall_fail:    number | null;
  precision_fail: number | null;
  f1_fail:        number | null;
  samples_test:   number | null;
  positive_rate:  number | null;
  trained_at:     string | null;
}

export interface ModelEntry {
  version:  string | null;
  metrics:  Record<string, HorizonMetrics>;
}

export interface ChampionChallengerStatus {
  champion:    ModelEntry;
  challenger:  ModelEntry | null;
  shadow_mode: boolean;
  note:        string;
}

export interface RegistryState {
  champion:          string | null;
  challenger:        string | null;
  retired:           string[];
  history:           Array<{ event: string; version?: string; role?: string; timestamp: string }>;
  champion_loaded:   boolean;
  challenger_loaded: boolean;
}

export function useModelRegistry() {
  return useQuery({
    queryKey: ["/api/ml/models/registry"],
    queryFn: async () => {
      const res = await fetch("/api/ml/models/registry", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch model registry");
      return res.json() as Promise<RegistryState>;
    },
    staleTime: 10_000,
  });
}

export function useChampionChallengerCompare() {
  return useQuery({
    queryKey: ["/api/ml/models/compare"],
    queryFn: async () => {
      const res = await fetch("/api/ml/models/compare", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch comparison");
      return res.json() as Promise<ChampionChallengerStatus>;
    },
    staleTime: 10_000,
  });
}

export function usePromoteChallenger() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ml/models/promote", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).detail || "Promotion failed");
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ml/models/registry"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ml/models/compare"] });
      toast({ title: "Challenger promoted", description: `${data.new_champion} is now serving production traffic.` });
    },
    onError: (err: Error) => {
      toast({ title: "Promotion failed", description: err.message, variant: "destructive" });
    },
  });
}

// ── Data Quality ─────────────────────────────────────────────────────────────

export interface DQCheck {
  check:   string;
  status:  "PASS" | "WARN" | "FAIL";
  message: string;
  detail:  Record<string, any>;
}

export interface DataQualityReport {
  overall:    "PASS" | "WARN" | "FAIL";
  fail_count: number;
  warn_count: number;
  pass_count: number;
  total_rows: number;
  checked_at: string;
  checks:     DQCheck[];
  can_train:  boolean;
  summary:    string;
}

export function useDataQualityReport() {
  return useQuery({
    queryKey: ["/api/ml/data-quality/report"],
    queryFn: async () => {
      const res = await fetch("/api/ml/data-quality/report", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch data quality report");
      return res.json() as Promise<DataQualityReport>;
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useTrainingStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["/api/ml/train/status"],
    queryFn: async () => {
      const res = await fetch("/api/ml/train/status", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch training status");
      return res.json() as Promise<{
        running: boolean;
        log: string[];
        last_result: { success: boolean; version?: string; return_code?: number } | null;
      }>;
    },
    enabled,
    refetchInterval: enabled ? 3000 : false, // poll every 3s while training
  });
}