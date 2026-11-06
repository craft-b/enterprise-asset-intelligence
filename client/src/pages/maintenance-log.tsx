import { useState } from "react";
import { useMaintenance, useUpdateMaintenance, useDeleteMaintenance } from "@/hooks/use-maintenance";
import { useEquipment } from "@/hooks/use-equipment";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ReadOnlyAction } from "@/components/read-only-action";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MaintenanceForm } from "@/components/maintenance-form";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Plus, Wrench, Calendar, DollarSign, User, ChevronUp, ChevronDown, ChevronsUpDown, Pencil, Trash2, Loader2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { calendarDate } from "@/lib/calendar-date";

const PAGE_SIZE = 10;

type SortKey = "maintenanceDate" | "maintenanceType" | "cost" | "nextDueDate" | "eventSource" | "performedBy";

function MaintSortHead({ col, active, dir, onSort, children, align, className }: {
  col: SortKey; active: SortKey; dir: "asc" | "desc";
  onSort: (k: SortKey) => void; children: React.ReactNode; align?: "right"; className?: string;
}) {
  const isActive = active === col;
  return (
    <TableHead
      className={cn("cursor-pointer select-none whitespace-nowrap", align === "right" && "text-right", className)}
      onClick={() => onSort(col)}
    >
      <div className={cn("flex items-center gap-1", align === "right" && "justify-end")}>
        <span>{children}</span>
        {isActive
          ? (dir === "asc" ? <ChevronUp className="h-3.5 w-3.5 text-foreground/70 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 text-foreground/70 shrink-0" />)
          : <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />}
      </div>
    </TableHead>
  );
}

export default function MaintenanceLog() {
  const { user } = useAuth();
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<number | undefined>();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [equipmentForMaintenance, setEquipmentForMaintenance] = useState<any>(null);

  // Server-side pagination + sort
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState<SortKey>("maintenanceDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const onSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortBy(key);
      setSortDir("asc");
    }
    setPage(0);
  };

  // Edit state
  const [editingEvent, setEditingEvent] = useState<any>(null);
  const [editForm, setEditForm] = useState<any>({});
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const updateMutation = useUpdateMaintenance();
  const deleteMutation = useDeleteMaintenance();

  const openEdit = (event: any) => {
    setEditingEvent(event);
    setEditForm({
      maintenanceDate: event.maintenanceDate?.substring(0, 10) ?? '',
      maintenanceType: event.maintenanceType ?? 'INSPECTION',
      eventSource: event.eventSource ?? 'SCHEDULED_PM',
      description: event.description ?? '',
      performedBy: event.performedBy ?? '',
      cost: event.cost ?? '',
      nextDueDate: event.nextDueDate?.substring(0, 10) ?? '',
    });
  };

  const handleEditSave = () => {
    if (!editingEvent) return;
    const payload = {
      ...editForm,
      cost: editForm.cost || null,
      nextDueDate: editForm.nextDueDate || null,
    };
    updateMutation.mutate({ id: editingEvent.id, data: payload }, {
      onSuccess: () => setEditingEvent(null),
    });
  };

  const handleDelete = () => {
    if (deletingId === null) return;
    deleteMutation.mutate(deletingId, {
      onSuccess: () => setDeletingId(null),
    });
  };

  const { data, isLoading, isFetching } = useMaintenance({
    equipmentId: selectedEquipmentId,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    sortBy,
    sortDir,
  });
  const { data: equipment } = useEquipment();

  // Events are read directly from the query — no separate derived state needed.
  const displayedEvents = data?.events ?? [];

  const handleEquipmentFilter = (val: string) => {
    setSelectedEquipmentId(val === "all" ? undefined : parseInt(val));
    setPage(0);
  };

  const isAdmin = user?.role === 'ADMINISTRATOR';

  const handleAddMaintenance = (equip?: any) => {
    setEquipmentForMaintenance(equip || null);
    setIsDialogOpen(true);
  };

  const getMaintenanceTypeColor = (type: string) => {
    switch (type) {
      case 'MAJOR_SERVICE':
        return 'bg-green-50 text-green-700 border-green-200';
      case 'MINOR_SERVICE':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'INSPECTION':
        return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      default:
        return 'bg-gray-50 text-gray-700 border-gray-200';
    }
  };

  const formatMaintenanceType = (type: string) => {
    return type.replace('_', ' ').toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  // Stats come from the server: this page holds only one page of events
  const totalEvents = data?.total ?? 0;
  const totalCost = data?.totalCost ?? 0;
  const recentEvents = data?.recentEvents ?? 0;

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Maintenance Log</h2>
          <p className="text-muted-foreground">
            {totalEvents > 0
              ? `${totalEvents.toLocaleString()} total events`
              : 'Track maintenance events and service history'}
          </p>
        </div>

        {isAdmin ? (
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={() => handleAddMaintenance()}>
                <Plus className="mr-2 h-4 w-4" />
                Log Maintenance
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Log Maintenance Event</DialogTitle>
                <DialogDescription>
                  Record maintenance performed on equipment
                </DialogDescription>
              </DialogHeader>
              {equipmentForMaintenance ? (
                <MaintenanceForm
                  equipmentId={equipmentForMaintenance.id}
                  equipmentName={equipmentForMaintenance.name}
                  onSuccess={() => setIsDialogOpen(false)}
                />
              ) : (
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    Select equipment to log maintenance:
                  </div>
                  <Select onValueChange={(val) => {
                    const equip = equipment?.find(e => e.id === parseInt(val));
                    if (equip) setEquipmentForMaintenance(equip);
                  }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select equipment" />
                    </SelectTrigger>
                    <SelectContent>
                      {equipment?.map((eq) => (
                        <SelectItem key={eq.id} value={eq.id.toString()}>
                          {eq.name} ({eq.equipmentId})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {equipmentForMaintenance && (
                    <MaintenanceForm
                      equipmentId={equipmentForMaintenance.id}
                      equipmentName={equipmentForMaintenance.name}
                      onSuccess={() => {
                        setIsDialogOpen(false);
                        setEquipmentForMaintenance(null);
                      }}
                    />
                  )}
                </div>
              )}
            </DialogContent>
          </Dialog>
        ) : (
          <ReadOnlyAction>Log Maintenance</ReadOnlyAction>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <Wrench className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalEvents.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              All maintenance records
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Recent Events</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{recentEvents}</div>
            <p className="text-xs text-muted-foreground">
              Last 30 days
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <p className="text-xs text-muted-foreground">
              Maintenance expenses
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filter */}
      <Card>
        <CardHeader>
          <CardTitle>Filter Events</CardTitle>
          <CardDescription>Filter by equipment</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={selectedEquipmentId?.toString() || "all"}
            onValueChange={handleEquipmentFilter}
          >
            <SelectTrigger className="w-[300px]">
              <SelectValue placeholder="All Equipment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Equipment</SelectItem>
              {equipment?.map((eq) => (
                <SelectItem key={eq.id} value={eq.id.toString()}>
                  {eq.name} ({eq.equipmentId})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Maintenance Events Table */}
      <Card>
        <CardHeader>
          <CardTitle>Maintenance History</CardTitle>
          <CardDescription>
            Complete log of all maintenance events
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <MaintSortHead col="maintenanceDate" active={sortBy} dir={sortDir} onSort={onSort}>Date</MaintSortHead>
                <TableHead>Equipment</TableHead>
                <MaintSortHead col="maintenanceType" active={sortBy} dir={sortDir} onSort={onSort}>Type</MaintSortHead>
                <MaintSortHead col="eventSource" active={sortBy} dir={sortDir} onSort={onSort} className="hidden xl:table-cell">Source</MaintSortHead>
                <TableHead className="hidden xl:table-cell">Description</TableHead>
                <MaintSortHead col="performedBy" active={sortBy} dir={sortDir} onSort={onSort} className="hidden 2xl:table-cell">Performed By</MaintSortHead>
                <MaintSortHead col="cost" active={sortBy} dir={sortDir} onSort={onSort} align="right">Cost</MaintSortHead>
                <MaintSortHead col="nextDueDate" active={sortBy} dir={sortDir} onSort={onSort}>Next Due</MaintSortHead>
                {isAdmin && <TableHead className={cn("w-24", stickyActions)} />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 9 : 8} className="text-center py-12 text-muted-foreground">
                    Loading maintenance events...
                  </TableCell>
                </TableRow>
              ) : displayedEvents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 9 : 8} className="text-center py-12 text-muted-foreground">
                    No maintenance events found
                  </TableCell>
                </TableRow>
              ) : (
                displayedEvents.map((event: any) => {
                  const equip = equipment?.find(e => e.id === event.equipmentId);
                  return (
                    <TableRow key={event.id}>
                      <TableCell>
                        <div className="font-medium">
                          {format(calendarDate(event.maintenanceDate), 'MMM d, yyyy')}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{equip?.name || 'Unknown'}</div>
                        <div className="text-xs text-muted-foreground">{equip?.equipmentId}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("text-xs", getMaintenanceTypeColor(event.maintenanceType))}>
                          {formatMaintenanceType(event.maintenanceType)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <span className="text-xs text-muted-foreground">
                          {event.eventSource
                            ? event.eventSource.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase())
                            : '-'}
                        </span>
                      </TableCell>
                      <TableCell className="hidden max-w-[140px] xl:table-cell 2xl:max-w-[200px]">
                        {event.description ? (
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block truncate text-sm text-muted-foreground cursor-default">
                                  {event.description}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent
                                side="top"
                                className="max-w-sm whitespace-normal text-xs leading-relaxed"
                              >
                                {event.description}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <span className="text-sm text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden 2xl:table-cell">
                        <div className="flex items-center gap-1 text-sm">
                          {event.performedBy ? (
                            <>
                              <User className="h-3 w-3 text-muted-foreground" />
                              {event.performedBy}
                            </>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {event.cost ? (
                          <span className="font-medium">${parseFloat(event.cost).toFixed(2)}</span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {event.nextDueDate ? (
                          <div className="text-sm">
                            {format(calendarDate(event.nextDueDate), 'MMM d, yyyy')}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )}
                      </TableCell>
                      {isAdmin && (
                        <TableCell className={cn("whitespace-nowrap", stickyActions)}>
                          <div className="flex items-center justify-end gap-0.5">
                            <TooltipProvider delayDuration={300}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-accent"
                                    onClick={() => openEdit(event)}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">Edit</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider delayDuration={300}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => setDeletingId(event.id)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">Delete</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {/* Pagination */}
          <div className="flex items-center justify-between px-2 py-3 border-t text-sm">
            <span className="text-muted-foreground text-xs">
              {totalEvents === 0
                ? "No results"
                : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalEvents)} of ${totalEvents.toLocaleString()}`}
              {isFetching && <span className="ml-2 text-muted-foreground/60">Updating…</span>}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-0.5">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage(0)}>
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="px-2 text-xs text-muted-foreground tabular-nums">{page + 1} / {totalPages}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>
                  <ChevronsRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {/* Edit Dialog */}
      <Dialog open={!!editingEvent} onOpenChange={(open) => !open && setEditingEvent(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Maintenance Event</DialogTitle>
            <DialogDescription>Update the details for this maintenance record.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Date</label>
                <Input type="date" value={editForm.maintenanceDate} onChange={e => setEditForm((f: any) => ({ ...f, maintenanceDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Type</label>
                <Select value={editForm.maintenanceType} onValueChange={v => setEditForm((f: any) => ({ ...f, maintenanceType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INSPECTION">Inspection</SelectItem>
                    <SelectItem value="MINOR_SERVICE">Minor Service</SelectItem>
                    <SelectItem value="MAJOR_SERVICE">Major Service</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Event Source</label>
                <Select value={editForm.eventSource} onValueChange={v => setEditForm((f: any) => ({ ...f, eventSource: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SCHEDULED_PM">Scheduled PM</SelectItem>
                    <SelectItem value="PREDICTIVE_INTERVENTION">Predictive Intervention</SelectItem>
                    <SelectItem value="REACTIVE_REPAIR">Reactive Repair</SelectItem>
                    <SelectItem value="PRE_DISPATCH_INSPECTION">Pre-Dispatch Inspection</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Performed By</label>
                <Input placeholder="Technician name" value={editForm.performedBy} onChange={e => setEditForm((f: any) => ({ ...f, performedBy: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description</label>
              <Textarea rows={2} value={editForm.description} onChange={e => setEditForm((f: any) => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Cost</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                  <Input className="pl-6" type="number" step="0.01" placeholder="0.00" value={editForm.cost} onChange={e => setEditForm((f: any) => ({ ...f, cost: e.target.value }))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Next Due Date</label>
                <Input type="date" value={editForm.nextDueDate} onChange={e => setEditForm((f: any) => ({ ...f, nextDueDate: e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingEvent(null)}>Cancel</Button>
            <Button onClick={handleEditSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete maintenance event?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. The record will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}