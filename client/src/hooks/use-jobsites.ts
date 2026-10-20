import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import { InsertJobSite } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { apiError } from "@/lib/api-error";

export function useJobSites() {
  return useQuery({
    queryKey: [api.jobSites.list.path],
    queryFn: async () => {
      const res = await fetch(api.jobSites.list.path, { credentials: "include" });
      if (!res.ok) throw await apiError(res, "Failed to fetch job sites");
      return api.jobSites.list.responses[200].parse(await res.json());
    },
  });
}

export function useJobSite(id: number) {
  return useQuery({
    queryKey: [api.jobSites.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.jobSites.get.path, { id });
      const res = await fetch(url, { credentials: "include" });
      
      if (res.status === 404) return null;
      if (!res.ok) throw await apiError(res, "Failed to fetch job site");
      
      return api.jobSites.get.responses[200].parse(await res.json());
    },
    enabled: !!id,
  });
}

export function useCreateJobSite() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertJobSite) => {
      const res = await fetch(api.jobSites.create.path, {
        method: api.jobSites.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 400) {
          const error = api.jobSites.create.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        throw await apiError(res, "Failed to create job site");
      }
      return api.jobSites.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.jobSites.list.path] });
      toast({ title: "Job site created successfully" });
    },
    onError: (err) => {
      toast({ title: "Error creating job site", description: err.message, variant: "destructive" });
    },
  });
}

export function useUpdateJobSite() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Partial<InsertJobSite>) => {
      const url = buildUrl(api.jobSites.update.path, { id });
      const res = await fetch(url, {
        method: api.jobSites.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 404) throw new Error("Job site not found");
        throw await apiError(res, "Failed to update job site");
      }
      return api.jobSites.update.responses[200].parse(await res.json());
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [api.jobSites.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.jobSites.get.path, data.id] });
      toast({ title: "Job site updated successfully" });
    },
    onError: (err) => {
      toast({ title: "Error updating job site", description: err.message, variant: "destructive" });
    },
  });
}

export function useDeleteJobSite() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.jobSites.delete.path, { id });
      const res = await fetch(url, {
        method: api.jobSites.delete.method,
        credentials: "include",
      });

      if (!res.ok) {
        if (res.status === 404) throw new Error("Job site not found");
        if (res.status === 409) {
          const error = await res.json();
          throw new Error(error.message);
        }
        throw await apiError(res, "Failed to delete job site");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.jobSites.list.path] });
      toast({ title: "Job site deleted successfully" });
    },
    onError: (err) => {
      toast({ title: "Error deleting job site", description: err.message, variant: "destructive" });
    },
  });
}
