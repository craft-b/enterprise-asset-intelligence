import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { InsertRental } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { apiError } from "@/lib/api-error";

export function useNextPoNumber() {
  return useQuery({
    queryKey: ['/api/rentals/next-po'],
    queryFn: async () => {
      const res = await fetch('/api/rentals/next-po', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch next PO number');
      const data = await res.json();
      return data.poNumber as string;
    },
    staleTime: 0, // Always fresh so concurrent tabs don't collide
  });
}

export function useRentals() {
  return useQuery({
    queryKey: [api.rentals.list.path],
    queryFn: async () => {
      const res = await fetch(api.rentals.list.path, { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch rentals");
      return api.rentals.list.responses[200].parse(await res.json());
    },
  });
}

export function useCreateRental() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertRental) => {
      // Coerce date strings to Date objects for validation if necessary, but schema expects strings for dates mostly in JSON
      const res = await fetch(api.rentals.create.path, {
        method: api.rentals.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 400) {
          const error = api.rentals.create.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        throw await apiError(res, "Failed to create rental");
      }
      return api.rentals.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.rentals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] }); // Equipment status changes
      toast({ title: "Rental created successfully" });
    },
    onError: (err) => {
      toast({ title: "Error creating rental", description: err.message, variant: "destructive" });
    },
  });
}

export function useUpdateRental() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertRental> }) => {
      const url = buildUrl(api.rentals.update.path, { id });
      const res = await fetch(url, {
        method: api.rentals.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 400) {
          const error = await res.json();
          throw new Error(error.message);
        }
        if (res.status === 404) {
          throw new Error("Rental not found");
        }
        throw await apiError(res, "Failed to update rental");
      }
      return api.rentals.update.responses[200].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.rentals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] });
      toast({ title: "Rental updated successfully" });
    },
    onError: (err) => {
      toast({ title: "Error updating rental", description: err.message, variant: "destructive" });
    },
  });
}

export function useDeleteRental() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.rentals.delete.path, { id });
      const res = await fetch(url, {
        method: api.rentals.delete.method,
        credentials: "include",
      });
      if (res.status === 409) {
        const err = await res.json();
        throw new Error(err.message);
      }
      if (!res.ok) throw await apiError(res, "Failed to delete rental");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.rentals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] });
      toast({ title: "Rental deleted" });
    },
    onError: (err) => {
      toast({ title: "Cannot delete rental", description: err.message, variant: "destructive" });
    },
  });
}

export function useCompleteRental() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, endDate, notes }: { id: number; endDate: string; notes?: string }) => {
      const url = buildUrl(api.rentals.complete.path, { id });
      const res = await fetch(url, {
        method: api.rentals.complete.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endDate, notes }),
        credentials: "include",
      });

      if (!res.ok) {
        throw await apiError(res, "Failed to complete rental");
      }
      return api.rentals.complete.responses[200].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.rentals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] }); // Equipment freed up
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/daily-revenue'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/revenue-summary'] });
      toast({ title: "Rental completed successfully" });
    },
    onError: (err) => {
      toast({ title: "Error completing rental", description: err.message, variant: "destructive" });
    },
  });
}

export function useGenerateInvoice() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (payload: {
      rentalId: number;
      invoiceDate: string;
      periodFrom: string;
      periodTo: string;
      amount: number;
      invoiceNumber: string;
    }) => {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (res.status === 409) throw new Error('Invoice already exists for this rental');
      if (!res.ok) throw new Error('Failed to generate invoice');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.rentals.list.path] });
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/revenue-summary'] });
      toast({ title: 'Invoice generated', description: 'The rental has been invoiced and A/R updated.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Invoice failed', description: err.message, variant: 'destructive' });
    },
  });
}

export function useSwapEquipment() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ rentalId, replacementEquipmentId, reason, swappedBy, notes }: {
      rentalId: number;
      replacementEquipmentId: number;
      reason?: string;
      swappedBy?: string;
      notes?: string;
    }) => {
      const res = await fetch(`/api/rentals/${rentalId}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replacementEquipmentId, reason, swappedBy, notes }),
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.rentals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.equipment.list.path] });
      toast({ title: 'Equipment swapped successfully' });
    },
    onError: (err) => {
      toast({ title: 'Swap failed', description: err.message, variant: 'destructive' });
    },
  });
}

export function useSwapHistory(rentalId: number) {
  return useQuery({
    queryKey: ['/api/rentals/:id/swaps', rentalId],
    queryFn: async () => {
      const res = await fetch(`/api/rentals/${rentalId}/swaps`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch swap history');
      return res.json();
    },
    enabled: !!rentalId,
  });
}

// Add this interface at the top
interface ModelMetrics {
  version: string;
  trainedAt: string;
  datasetSize: number;
  accuracy: number;
  precision: {
    HIGH: number;
    MEDIUM: number;
    LOW: number;
  };
  recall: {
    HIGH: number;
    MEDIUM: number;
    LOW: number;
  };
  f1Score: {
    HIGH: number;
    MEDIUM: number;
    LOW: number;
  };
  confusionMatrix: {
    HIGH: { predictedHIGH: number; predictedMEDIUM: number; predictedLOW: number };
    MEDIUM: { predictedHIGH: number; predictedMEDIUM: number; predictedLOW: number };
    LOW: { predictedHIGH: number; predictedMEDIUM: number; predictedLOW: number };
  };
  featureImportance: Array<{
    feature: string;
    importance: number;
    description: string;
  }>;
  predictionHistory: Array<{
    date: string;
    total: number;
    high: number;
    medium: number;
    low: number;
  }>;
  hyperparameters: {
    algorithm: string;
    nEstimators: number;
    maxDepth: number;
    minSamplesSplit: number;
    classWeight: string;
  };
}

// Add this hook to your existing hooks
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
