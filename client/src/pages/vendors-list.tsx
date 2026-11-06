// client/src/pages/VendorsList.tsx

import { useState } from "react";
import { useTable } from "@/hooks/use-table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { TablePagination } from "@/components/ui/table-pagination";
import { useVendors, useDeleteVendor } from "@/hooks/use-vendors";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ReadOnlyAction } from "@/components/read-only-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  stickyActions,
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
import { Plus, Edit, Trash2, Building2, MapPin, Mail } from "lucide-react";
import { VendorForm } from "@/components/vendor-form";
import { cn } from "@/lib/utils";

export default function VendorsList() {
  const { user } = useAuth();
  const { data: vendors, isLoading } = useVendors();
  const deleteMutation = useDeleteVendor();
  const [isNewVendorOpen, setIsNewVendorOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<any>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const isAdmin = user?.role === 'ADMINISTRATOR';

  const { sort, onSort, page, setPage, rows: pagedVendors, totalPages, total } = useTable(
    vendors,
    { defaultSortKey: "name", defaultDir: "asc",
      getters: { "activeRentals": (v) => v._count?.activeRentals ?? 0 } }
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

  const handleEdit = (vendor: any) => {
    setEditingVendor(vendor);
  };

  const closeEditDialog = () => {
    setEditingVendor(null);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Vendors</h2>
          <p className="text-muted-foreground">Manage equipment vendors and supplier relationships.</p>
        </div>
        
        {isAdmin ? (
          <Dialog open={isNewVendorOpen} onOpenChange={setIsNewVendorOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New Vendor
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Vendor</DialogTitle>
                <DialogDescription>
                  Add a new equipment vendor or supplier.
                </DialogDescription>
              </DialogHeader>
              <VendorForm onSuccess={() => setIsNewVendorOpen(false)} />
            </DialogContent>
          </Dialog>
        ) : (
          <ReadOnlyAction>New Vendor</ReadOnlyAction>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <SortableTableHead sortKey="vendorId" sort={sort} onSort={onSort}>Vendor ID</SortableTableHead>
              <SortableTableHead sortKey="name" sort={sort} onSort={onSort}>Company Name</SortableTableHead>
              <SortableTableHead sortKey="address" sort={sort} onSort={onSort}>Location</SortableTableHead>
              <SortableTableHead sortKey="salesPerson" sort={sort} onSort={onSort}>Contact</SortableTableHead>
              <SortableTableHead sortKey="activeRentals" sort={sort} onSort={onSort}>Active Rentals</SortableTableHead>
              {isAdmin && <TableHead className={cn("text-right", stickyActions, "bg-slate-50")}>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
               <TableRow>
                 <TableCell colSpan={isAdmin ? 6 : 5} className="text-center py-12 text-muted-foreground">
                   Loading vendors...
                 </TableCell>
               </TableRow>
            ) : vendors?.length === 0 ? (
               <TableRow>
                 <TableCell colSpan={isAdmin ? 6 : 5} className="text-center py-12 text-muted-foreground">
                   No vendors found. {isAdmin && "Create one to get started."}
                 </TableCell>
               </TableRow>
            ) : (
              pagedVendors.map((vendor) => (
                <TableRow key={vendor.id}>
                  <TableCell>
                    <div className="font-mono text-sm font-medium text-slate-900">
                      {vendor.vendorId}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      <div className="font-medium text-slate-900">{vendor.name}</div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {vendor.address ? (
                      <div className="flex items-start gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span className="line-clamp-2">{vendor.address}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">No address</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      {vendor.salesPerson && (
                        <div className="text-sm font-medium">
                          {vendor.salesPerson}
                        </div>
                      )}
                      {vendor.contact && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Mail className="h-3.5 w-3.5" />
                          <span>{vendor.contact}</span>
                        </div>
                      )}
                      {!vendor.salesPerson && !vendor.contact && (
                        <span className="text-sm text-muted-foreground">No contact info</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                      {vendor._count?.activeRentals ?? 0} active
                    </Badge>
                  </TableCell>
                  {isAdmin && (
                    <TableCell className={cn("text-right", stickyActions)}>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-700"
                          title="Edit"
                          onClick={() => handleEdit(vendor)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-700"
                          title="Delete"
                          onClick={() => setDeleteId(vendor.id)}
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
            <DialogTitle>Delete Vendor</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this vendor? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              This vendor cannot be deleted if it has associated rentals. Please complete or cancel all rentals first.
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
              Delete Vendor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Vendor Dialog */}
      <Dialog open={!!editingVendor} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Vendor</DialogTitle>
            <DialogDescription>
              Update vendor details and contact information.
            </DialogDescription>
          </DialogHeader>
          {editingVendor && (
            <VendorForm 
              initialData={editingVendor}
              onSuccess={closeEditDialog} 
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}