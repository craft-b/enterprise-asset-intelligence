import { useState } from "react";
import { useTable } from "@/hooks/use-table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { TablePagination } from "@/components/ui/table-pagination";
import { useRentals, useCompleteRental, useDeleteRental, useGenerateInvoice } from "@/hooks/use-rentals";
import { useAuth } from "@/hooks/use-auth";
import { SwapEquipmentDialog } from "@/components/swap-equipment-dialog";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Plus, CheckSquare, CalendarDays, Edit, Eye, Trash2, ArrowRightLeft, FileText } from "lucide-react";
import { format } from "date-fns";
import { RentalForm } from "@/components/rental-form";
import { RentalDetailView } from "@/components/rental-detail-view";
import { cn } from "@/lib/utils";

export default function RentalsList() {
  const { user } = useAuth();
  const { data: rentals, isLoading } = useRentals();
  const completeMutation = useCompleteRental();
  const deleteMutation = useDeleteRental();
  const [isNewRentalOpen, setIsNewRentalOpen] = useState(false);
  const [completeId, setCompleteId] = useState<number | null>(null);
  const [editingRental, setEditingRental] = useState<any>(null);
  const [viewingRentalId, setViewingRentalId] = useState<number | null>(null);
  const [deletingRental, setDeletingRental] = useState<any>(null);
  const [swappingRental, setSwappingRental] = useState<any>(null);

  const isAdmin = user?.role === 'ADMINISTRATOR';
  const invoiceMutation = useGenerateInvoice();

  const { sort, onSort, page, setPage, rows: pagedRentals, totalPages, total } = useTable(
    rentals,
    {
      defaultSortKey: "createdAt",
      defaultDir: "desc",
      getters: {
        "jobSite": (r) => r.jobSite?.name ?? "",
        "equipment": (r) => r.equipment?.name ?? "",
        "receiveDate": (r) => r.receiveDate ? String(r.receiveDate) : "",
      }
    }
  );

  const handleGenerateInvoice = (rental: any, e: React.MouseEvent) => {
    e.stopPropagation();
    const receiveDate = rental.receiveDate instanceof Date
      ? rental.receiveDate.toISOString().split('T')[0]
      : String(rental.receiveDate).split('T')[0];
    const returnDate = rental.returnDate instanceof Date
      ? rental.returnDate.toISOString().split('T')[0]
      : String(rental.returnDate).split('T')[0];
    const days = Math.max(1, Math.round((new Date(returnDate).getTime() - new Date(receiveDate).getTime()) / 86400000) + 1);
    const dailyRate = Number(rental.equipment?.dailyRate || 0);
    const amount = days * dailyRate;
    invoiceMutation.mutate({
      rentalId: rental.id,
      invoiceDate: new Date().toISOString().split('T')[0],
      periodFrom: receiveDate,
      periodTo: returnDate,
      amount,
      invoiceNumber: `INV-${rental.id}-${Date.now()}`,
    });
  };

  const handleComplete = () => {
    if (completeId) {
      completeMutation.mutate({
        id: completeId,
        endDate: new Date().toISOString().split('T')[0],
      }, {
        onSuccess: () => {
          setCompleteId(null);
        }
      });
    }
  };

  const handleEdit = (rental: any, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row click
    setEditingRental(rental);
  };

  const handleViewDetails = (rentalId: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setViewingRentalId(rentalId);
  };

  const handleRowClick = (rentalId: number) => {
    setViewingRentalId(rentalId);
  };

  const closeEditDialog = () => {
    setEditingRental(null);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Active Rentals</h2>
          <p className="text-muted-foreground">Track ongoing rentals and equipment assignments.</p>
        </div>
        
        {isAdmin ? (
          <Dialog open={isNewRentalOpen} onOpenChange={setIsNewRentalOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New Rental
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Rental Agreement</DialogTitle>
                <DialogDescription>
                  Assign equipment to a job site.
                </DialogDescription>
              </DialogHeader>
              <RentalForm onSuccess={() => setIsNewRentalOpen(false)} />
            </DialogContent>
          </Dialog>
        ) : (
          <ReadOnlyAction>New Rental</ReadOnlyAction>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <SortableTableHead sortKey="jobSite" sort={sort} onSort={onSort}>Job Site / Vendor</SortableTableHead>
              <SortableTableHead sortKey="equipment" sort={sort} onSort={onSort}>Equipment</SortableTableHead>
              <SortableTableHead sortKey="receiveDate" sort={sort} onSort={onSort}>Duration</SortableTableHead>
              <SortableTableHead sortKey="poNumber" sort={sort} onSort={onSort}>PO #</SortableTableHead>
              <SortableTableHead sortKey="buyRent" sort={sort} onSort={onSort}>Type</SortableTableHead>
              <SortableTableHead sortKey="status" sort={sort} onSort={onSort}>Status</SortableTableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
               <TableRow>
                 <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                   Loading rentals...
                 </TableCell>
               </TableRow>
            ) : rentals?.length === 0 ? (
               <TableRow>
                 <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                   No active rentals found.
                 </TableCell>
               </TableRow>
            ) : (
              pagedRentals.map((rental) => (
                <TableRow 
                  key={rental.id}
                  className="cursor-pointer hover:bg-slate-50 transition-colors"
                  onClick={() => handleRowClick(rental.id)}
                >
                  <TableCell>
                    <div className="font-medium text-slate-900">
                      {rental.jobSite?.name || rental.jobSite?.jobId || 'Unknown Job Site'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rental.vendor?.name || 'No vendor'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{rental.equipment?.name || 'Unknown Equipment'}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {rental.equipment?.serialNumber || rental.equipment?.equipmentId}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col text-sm">
                      <span className="text-green-600 font-medium">
                        {rental.receiveDate ? format(new Date(rental.receiveDate), 'MMM d, yyyy') : 'N/A'}
                      </span>
                      {rental.returnDate && (
                        <>
                          <span className="text-slate-400 text-xs">to</span>
                          <span className="text-slate-600 font-medium">
                            {format(new Date(rental.returnDate), 'MMM d, yyyy')}
                          </span>
                        </>
                      )}
                      {!rental.returnDate && rental.status === 'ACTIVE' && (
                        <span className="text-xs text-muted-foreground">Ongoing</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs font-mono text-muted-foreground">
                      {rental.poNumber || <span className="text-slate-400">—</span>}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(
                      rental.buyRent === 'BUY' ? "bg-blue-50 text-blue-700 border-blue-200" :
                      "bg-purple-50 text-purple-700 border-purple-200"
                    )}>
                      {rental.buyRent}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(
                      rental.status === 'ACTIVE' ? "bg-orange-50 text-orange-700 border-orange-200" :
                      rental.status === 'COMPLETED' ? "bg-green-50 text-green-700 border-green-200" :
                      "bg-slate-100 text-slate-600"
                    )}>
                      {rental.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        className="h-8 w-8 p-0"
                        onClick={(e) => handleViewDetails(rental.id, e)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {isAdmin && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-700"
                            title="Edit"
                            onClick={(e) => handleEdit(rental, e)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          {rental.status === 'ACTIVE' && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-2 hover:bg-green-50 hover:text-green-700 hover:border-green-200"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCompleteId(rental.id);
                                }}
                              >
                                <CheckSquare className="h-4 w-4" />
                                Complete
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1 hover:bg-purple-50 hover:text-purple-700 hover:border-purple-200"
                                onClick={(e) => { e.stopPropagation(); setSwappingRental(rental); }}
                              >
                                <ArrowRightLeft className="h-4 w-4" />
                                Swap
                              </Button>
                            </>
                          )}
                          {rental.status === 'COMPLETED' && (
                            // NOTE: rentals list query doesn't join the invoices relation today,
                            // so this is always undefined at runtime — pre-existing gap, not
                            // part of the ML portfolio pass. Cast avoids a hard type error.
                            (rental as any).invoices?.length > 0 ? (
                              <Badge className="h-8 px-2 bg-green-50 text-green-700 border border-green-200 font-normal">
                                <FileText className="h-3 w-3 mr-1" />
                                Invoiced
                              </Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200"
                                disabled={invoiceMutation.isPending}
                                onClick={(e) => handleGenerateInvoice(rental, e)}
                              >
                                <FileText className="h-4 w-4" />
                                Invoice
                              </Button>
                            )
                          )}
                          {rental.status !== 'ACTIVE' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-700"
                              title="Delete"
                              onClick={(e) => { e.stopPropagation(); setDeletingRental(rental); }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <TablePagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </div>

      {/* Rental Detail Sheet */}
      <Sheet open={!!viewingRentalId} onOpenChange={(open) => !open && setViewingRentalId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Rental Details</SheetTitle>
            <SheetDescription>
              Complete information about this rental agreement
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            {viewingRentalId && (() => {
              const rental = rentals?.find(r => r.id === viewingRentalId);
              return rental ? <RentalDetailView rental={rental} /> : <div>Loading...</div>;
            })()}
          </div>
        </SheetContent>
      </Sheet>

      {/* Completion Dialog */}
      <Dialog open={!!completeId} onOpenChange={(open) => !open && setCompleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete Rental</DialogTitle>
            <DialogDescription>
              Mark this rental as returned. This will set the return date to today and make the equipment available again.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to mark this rental as completed? The equipment will become available for rent again.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteId(null)}>Cancel</Button>
            <Button onClick={handleComplete} disabled={completeMutation.isPending}>
              {completeMutation.isPending && <CalendarDays className="mr-2 h-4 w-4 animate-spin" />}
              Confirm Return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Rental Dialog */}
      <Dialog open={!!deletingRental} onOpenChange={(open) => !open && setDeletingRental(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Rental</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this rental for <strong>{deletingRental?.equipment?.name}</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingRental(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deletingRental) {
                  deleteMutation.mutate(deletingRental.id, {
                    onSuccess: () => setDeletingRental(null),
                  });
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Rental Dialog */}
      <Dialog open={!!editingRental} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Rental</DialogTitle>
            <DialogDescription>
              Update rental details and status.
            </DialogDescription>
          </DialogHeader>
          {editingRental && (
            <RentalForm
              initialData={editingRental}
              onSuccess={closeEditDialog}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Swap Equipment Dialog */}
      {swappingRental && (
        <SwapEquipmentDialog
          open={!!swappingRental}
          onOpenChange={(open) => !open && setSwappingRental(null)}
          rental={swappingRental}
        />
      )}
    </div>
  );
}