import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { useToast } from "@/hooks/use-toast";
import { apiError } from "@/lib/api-error";

export function useMaintenance(params: {
  equipmentId?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
} = {}) {
  const { equipmentId, limit = 10, offset = 0, sortBy, sortDir } = params;
  return useQuery({
    queryKey: ['maintenance', equipmentId, limit, offset, sortBy, sortDir],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (equipmentId != null) qs.set('equipmentId', String(equipmentId));
      qs.set('limit',  String(limit));
      qs.set('offset', String(offset));
      if (sortBy)  qs.set('sortBy',  sortBy);
      if (sortDir) qs.set('sortDir', sortDir);
      const res = await fetch(`${api.maintenance.list.path}?${qs}`, { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch maintenance events");
      return api.maintenance.list.responses[200].parse(await res.json());
    },
  });
}

export function useMaintenanceHistory(equipmentId: number) {
  return useQuery({
    queryKey: ['maintenance', 'history', equipmentId],
    queryFn: async () => {
      const url = buildUrl(api.maintenance.getByEquipment.path, { id: equipmentId });
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch maintenance history");
      return api.maintenance.getByEquipment.responses[200].parse(await res.json());
    },
    enabled: !!equipmentId,
  });
}

export function useMaintenanceDueSoon() {
  return useQuery({
    queryKey: ['/api/maintenance/due-soon'],
    queryFn: async () => {
      const res = await fetch('/api/maintenance/due-soon', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch due-soon maintenance');
      return res.json() as Promise<Array<{
        id: number;
        name: string;
        equipmentId: string;
        category: string;
        status: string;
        nextDueDate: string;
        daysUntilDue: number;
      }>>;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpdateMaintenance() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const res = await fetch(`/api/maintenance/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Failed to update maintenance event' }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance/due-soon'] });
      toast({ title: 'Maintenance updated' });
    },
  });
}

export function useDeleteMaintenance() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/maintenance/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: 'Failed to delete maintenance event' }));
        throw new Error(err.message);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance/due-soon'] });
      toast({ title: 'Maintenance event deleted' });
    },
  });
}

export function useCreateMaintenance() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(api.maintenance.create.path, {
        method: api.maintenance.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ message: 'Failed to create maintenance event' }));
        throw new Error(error.message);
      }
      return api.maintenance.create.responses[201].parse(await res.json());
    },
    onSuccess: (_, variables) => {
      // Immediately refresh the maintenance log, equipment list, and due-soon
      queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      queryClient.invalidateQueries({ queryKey: ['risk-scores'] });
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] });
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance/due-soon'] });

      // Trigger an explicit ML rescore for this equipment so predictions reflect
      // the new maintenance event (days_since_last_maintenance resets → lower risk).
      // Invalidate prediction caches only after the rescore is stored in DB.
      fetch('/api/risk-score/multi-horizon/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ equipmentIds: [variables.equipmentId] }),
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/risk-score/multi-horizon/latest"] });
        queryClient.invalidateQueries({
          queryKey: ["/api/equipment/:id/projection", variables.equipmentId],
        });
      }).catch(() => {
        // ML service offline — still refresh so stale predictions are cleared
        queryClient.invalidateQueries({ queryKey: ["/api/risk-score/multi-horizon/latest"] });
      });

      toast({
        title: "Maintenance logged",
        description: "Risk scores will update shortly."
      });
    }
  });
}