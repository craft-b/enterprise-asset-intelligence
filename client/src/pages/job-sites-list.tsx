import { useState } from "react";
import { useTable } from "@/hooks/use-table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { TablePagination } from "@/components/ui/table-pagination";
import { useJobSites, useDeleteJobSite } from "@/hooks/use-jobsites";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ReadOnlyAction } from "@/components/read-only-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Edit, Trash2, MapPin, Phone, User } from "lucide-react";
import { JobSiteForm } from "@/components/job-site-form";

export default function JobSitesList() {
  const { user } = useAuth();
  const { data: jobSites, isLoading } = useJobSites();
  const deleteMutation = useDeleteJobSite();
  const [isNewJobSiteOpen, setIsNewJobSiteOpen] = useState(false);
  const [editingJobSite, setEditingJobSite] = useState<any>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const isAdmin = user?.role === 'ADMINISTRATOR';

  const { sort, onSort, page, setPage, rows: pagedSites, totalPages, total } = useTable(
    jobSites,
    { defaultSortKey: "name", defaultDir: "asc",
      getters: { "activeRentals": (s) => s._count?.rentals ?? 0 } }
  );

  const handleDelete = () => {
    if (deleteId) {
      deleteMutation.mutate(deleteId, {
        onSuccess: () => {
          setDeleteId(null);
        }
      });
    }
  };

  const handleEdit = (jobSite: any) => {
    setEditingJobSite(jobSite);
  };

  const closeEditDialog = () => {
    setEditingJobSite(null);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Job Sites</h2>
          <p className="text-muted-foreground">Manage construction sites and project locations.</p>
        </div>
        
        {isAdmin ? (
          <Dialog open={isNewJobSiteOpen} onOpenChange={setIsNewJobSiteOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New Job Site
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Job Site</DialogTitle>
                <DialogDescription>
                  Add a new construction site or project location.
                </DialogDescription>
              </DialogHeader>
              <JobSiteForm onSuccess={() => setIsNewJobSiteOpen(false)} />
            </DialogContent>
          </Dialog>
        ) : (
          <ReadOnlyAction>New Job Site</ReadOnlyAction>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <SortableTableHead sortKey="jobId" sort={sort} onSort={onSort}>Job ID</SortableTableHead>
              <SortableTableHead sortKey="name" sort={sort} onSort={onSort}>Site Name</SortableTableHead>
              <SortableTableHead sortKey="address" sort={sort} onSort={onSort}>Location</SortableTableHead>
              <SortableTableHead sortKey="contactPerson" sort={sort} onSort={onSort}>Contact</SortableTableHead>
              <SortableTableHead sortKey="activeRentals" sort={sort} onSort={onSort}>Active Rentals</SortableTableHead>
              {isAdmin && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
               <TableRow>
                 <TableCell colSpan={isAdmin ? 6 : 5} className="text-center py-12 text-muted-foreground">
                   Loading job sites...
                 </TableCell>
               </TableRow>
            ) : jobSites?.length === 0 ? (
               <TableRow>
                 <TableCell colSpan={isAdmin ? 6 : 5} className="text-center py-12 text-muted-foreground">
                   No job sites found. {isAdmin && "Create one to get started."}
                 </TableCell>
               </TableRow>
            ) : (
              pagedSites.map((site) => (
                <TableRow key={site.id}>
                  <TableCell>
                    <div className="font-mono text-sm font-medium text-slate-900">
                      {site.jobId}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-slate-900">{site.name}</div>
                  </TableCell>
                  <TableCell>
                    {site.address ? (
                      <div className="flex items-start gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span className="line-clamp-2">{site.address}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">No address</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      {site.contactPerson && (
                        <div className="flex items-center gap-2 text-sm">
                          <User className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>{site.contactPerson}</span>
                        </div>
                      )}
                      {site.contactPhone && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Phone className="h-3.5 w-3.5" />
                          <span>{site.contactPhone}</span>
                        </div>
                      )}
                      {!site.contactPerson && !site.contactPhone && (
                        <span className="text-sm text-muted-foreground">No contact info</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                      {site._count?.rentals || 0} rentals
                    </Badge>
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-700"
                          title="Edit"
                          onClick={() => handleEdit(site)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-700"
                          title="Delete"
                          onClick={() => setDeleteId(site.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <TablePagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Job Site</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this job site? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              This job site cannot be deleted if it has associated rentals. Please complete or cancel all rentals first.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button 
              variant="destructive" 
              onClick={handleDelete} 
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Trash2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Job Site
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Job Site Dialog */}
      <Dialog open={!!editingJobSite} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Job Site</DialogTitle>
            <DialogDescription>
              Update job site details and contact information.
            </DialogDescription>
          </DialogHeader>
          {editingJobSite && (
            <JobSiteForm 
              initialData={editingJobSite}
              onSuccess={closeEditDialog} 
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}