import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { InsertEquipment } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiError } from "@/lib/api-error";

export function useEquipment(params?: { search?: string; status?: "AVAILABLE" | "RENTED" | "MAINTENANCE" }) {
  // Construct query key based on params to enable caching per filter state
  const queryKey = [api.equipment.list.path, params?.search, params?.status];

  return useQuery({
    queryKey,
    queryFn: async () => {
      const url = new URL(api.equipment.list.path, window.location.origin);
      if (params?.search) url.searchParams.set("search", params.search);
      if (params?.status) url.searchParams.set("status", params.status);

      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch equipment");
      
      return api.equipment.list.responses[200].parse(await res.json());
    },
  });
}

export function useEquipmentItem(id: number) {
  return useQuery({
    queryKey: [api.equipment.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.equipment.get.path, { id });
      const res = await fetch(url, { credentials: "include" });
      
      if (res.status === 404) return null;
      if (!res.ok) throw await apiError(res, "Failed to fetch equipment details");
      
      return api.equipment.get.responses[200].parse(await res.json());
    },
    enabled: !!id,
  });
}

export interface SensorTrendPoint {
  day: string;
  engine_temp: number | null;
  oil_pressure: number | null;
  hydraulic_pressure: number | null;
  vibration: number | null;
  warnings: number | null;
}

export interface SensorTrends {
  equipmentId: number;
  days: number;
  asOf: string;
  points: SensorTrendPoint[];
}

/** Daily sensor aggregates for the asset detail page, anchored to the sim cursor. */
export function useSensorTrends(id: number, days = 90) {
  return useQuery<SensorTrends>({
    queryKey: ["/api/equipment/:id/sensor-trends", id, days],
    queryFn: async () => {
      const res = await fetch(`/api/equipment/${id}/sensor-trends?days=${days}`, { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch sensor trends");
      return res.json();
    },
    enabled: !!id,
  });
}

export interface FeatureBaseline {
  equipmentId: number;
  asOf: string | null;
  unit: Record<string, number>;
  fleet: Record<string, number>;
}

/** Latest-snapshot feature values for one unit vs. fleet averages — backs the
 *  expandable SHAP bars ("wear score 7.9 vs fleet avg 4.1"). */
export function useFeatureBaseline(id: number) {
  return useQuery<FeatureBaseline>({
    queryKey: ["/api/equipment/:id/feature-baseline", id],
    queryFn: async () => {
      const res = await fetch(`/api/equipment/${id}/feature-baseline`, { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch feature baseline");
      return res.json();
    },
    enabled: !!id,
  });
}

export function useCreateEquipment() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertEquipment) => {
      const validated = api.equipment.create.input.parse(data);
      const res = await fetch(api.equipment.create.path, {
        method: api.equipment.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 400) {
          const error = api.equipment.create.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        throw await apiError(res, "Failed to create equipment");
      }
      return api.equipment.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] });
      toast({ title: "Equipment created successfully" });
    },
    onError: (err) => {
      toast({ title: "Error creating equipment", description: err.message, variant: "destructive" });
    },
  });
}

export function useDeleteEquipment() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.equipment.delete.path, { id });
      const res = await fetch(url, {
        method: api.equipment.delete.method,
        credentials: "include",
      });
      if (res.status === 409) {
        const err = await res.json();
        throw new Error(err.message);
      }
      if (!res.ok) throw await apiError(res, "Failed to delete equipment");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] });
      toast({ title: "Equipment deleted" });
    },
    onError: (err) => {
      toast({ title: "Cannot delete equipment", description: err.message, variant: "destructive" });
    },
  });
}

export function useUpdateEquipment() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Partial<InsertEquipment>) => {
      const validated = api.equipment.update.input.parse(updates);
      const url = buildUrl(api.equipment.update.path, { id });
      
      const res = await fetch(url, {
        method: api.equipment.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
        credentials: "include",
      });

      if (!res.ok) {
        throw await apiError(res, "Failed to update equipment");
      }
      return api.equipment.update.responses[200].parse(await res.json());
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.equipment.get.path, data.id] });
      toast({ title: "Equipment updated successfully" });
    },
    onError: (err) => {
      toast({ title: "Error updating equipment", description: err.message, variant: "destructive" });
    },
  });
}
