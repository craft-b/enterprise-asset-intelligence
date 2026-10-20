import { useQuery } from "@tanstack/react-query";
import { apiError } from "@/lib/api-error";

export type SystemStatus = {
  seeded: boolean;
  fullyInitialized: boolean;
  equipmentCount: number;
  snapshotCount: number;
  modelTrained: boolean;
  predictionCount: number;
  cursorDate: string | null;
};

export type SeedJobStatus = {
  state: "idle" | "running" | "completed" | "failed";
  currentStep: number;
  totalSteps: number;
  stepLabel: string;
  log: string[];
  /** Steps that were skipped without failing the run — see seed-orchestrator. */
  warnings?: string[];
  error?: string;
};

export function useSystemStatus() {
  return useQuery<SystemStatus>({
    queryKey: ["/api/admin/system-status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/system-status", { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch system status");
      return res.json();
    },
    staleTime: 30_000,
  });
}

export function useSeedStatus(enabled: boolean) {
  return useQuery<SeedJobStatus>({
    queryKey: ["/api/admin/seed/status"],
    queryFn: async () => {
      // Polled on a timer: a cached body here is a frozen progress bar.
      const res = await fetch("/api/admin/seed/status", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw await apiError(res, "Failed to fetch seed status");
      return res.json();
    },
    refetchInterval: enabled ? 1500 : false,
    enabled,
  });
}
