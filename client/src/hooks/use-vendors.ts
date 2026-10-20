
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { InsertVendor } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiError } from "@/lib/api-error";

export function useVendors() {
  return useQuery({
    queryKey: [api.vendors.list.path],
    queryFn: async () => {
      const res = await fetch(api.vendors.list.path, { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch vendors");
      return api.vendors.list.responses[200].parse(await res.json());
    },
  });
}

export function useVendor(id: number) {
  return useQuery({
    queryKey: [api.vendors.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.vendors.get.path, { id });
      const res = await fetch(url, { credentials: "include" });
      
      if (res.status === 404) return null;
      if (!res.ok) throw await apiError(res, "Failed to fetch vendor");
      
      return api.vendors.get.responses[200].parse(await res.json());
    },
    enabled: !!id,
  });
}

export function useCreateVendor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertVendor) => {
      const res = await fetch(api.vendors.create.path, {
        method: api.vendors.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 400) {
          const error = api.vendors.create.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        throw await apiError(res, "Failed to create vendor");
      }
      return api.vendors.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.vendors.list.path] });
      toast({ title: "Vendor created successfully" });
    },
    onError: (err) => {
      toast({ title: "Error creating vendor", description: err.message, variant: "destructive" });
    },
  });
}

export function useUpdateVendor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Partial<InsertVendor>) => {
      const url = buildUrl(api.vendors.update.path, { id });
      const res = await fetch(url, {
        method: api.vendors.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 404) throw new Error("Vendor not found");
        throw await apiError(res, "Failed to update vendor");
      }
      return api.vendors.update.responses[200].parse(await res.json());
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [api.vendors.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.vendors.get.path, data.id] });
      toast({ title: "Vendor updated successfully" });
    },
    onError: (err) => {
      toast({ title: "Error updating vendor", description: err.message, variant: "destructive" });
    },
  });
}

export function useDeleteVendor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.vendors.delete.path, { id });
      const res = await fetch(url, {
        method: api.vendors.delete.method,
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 404) throw new Error("Vendor not found");
        if (res.status === 409) {
          const error = await res.json();
          throw new Error(error.message);
        }
        throw await apiError(res, "Failed to delete vendor");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.vendors.list.path] });
      toast({ title: "Vendor deleted successfully" });
    },
    onError: (err) => {
      toast({ title: "Error deleting vendor", description: err.message, variant: "destructive" });
    },
  });
}