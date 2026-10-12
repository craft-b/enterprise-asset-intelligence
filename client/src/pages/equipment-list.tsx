// client/src/pages/EquipmentList.tsx - Complete with Detail View

import { useState, useMemo } from "react";
import { useTable } from "@/hooks/use-table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { TablePagination } from "@/components/ui/table-pagination";
import { useEquipment, useCreateEquipment, useUpdateEquipment, useDeleteEquipment } from "@/hooks/use-equipment";
import { useLatestMultiHorizonPredictions } from "@/hooks/use-risk-score";
import { useMaintenanceDueSoon } from "@/hooks/use-maintenance";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Search, AlertTriangle, Edit, Trash2 } from "lucide-react";
import { EquipmentForm } from "@/components/equipment-form";
import { EquipmentDetailView } from "@/components/equipment-detail-view";
import { cn } from "@/lib/utils";
import { SensorUpload } from "@/components/sensor-upload";

// Risk Badge Component — receives pre-fetched prediction row, no per-unit fetch
function RiskBadge({ prediction }: { prediction: any }) {
  if (!prediction) {
    return <Badge variant="outline" className="bg-slate-100 text-slate-400">No Data</Badge>;
  }

  const level = prediction.risk_level_30d as "LOW" | "MEDIUM" | "HIGH";
  const prob = parseFloat(prediction.prob_30d);

  return (
    <div className="flex items-center gap-2">
      <Badge
        variant="outline"
        className={cn(
          "font-medium",
          level === 'HIGH' && "bg-red-100 text-red-800 border-red-300",
          level === 'MEDIUM' && "bg-orange-100 text-orange-800 border-orange-300",
          level === 'LOW' && "bg-green-100 text-green-800 border-green-300"
        )}
      >
        {level === 'HIGH' && <AlertTriangle className="h-3 w-3 mr-1" />}
        {level}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {(prob * 100).toFixed(0)}%
      </span>
    </div>
  );
}

export default function EquipmentList() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"AVAILABLE" | "RENTED" | "MAINTENANCE" | "">("");
  const [isNewEquipmentOpen, setIsNewEquipmentOpen] = useState(false);
  const [editingEquipment, setEditingEquipment] = useState<any>(null);
  const [viewingEquipment, setViewingEquipment] = useState<any>(null);
  const [deletingEquipment, setDeletingEquipment] = useState<any>(null);
  const deleteMutation = useDeleteEquipment();

  const { data: equipment, isLoading } = useEquipment({
    search,
    status: statusFilter || undefined
  });

  const { data: latestPredictions } = useLatestMultiHorizonPredictions();
  const predMap = useMemo(() => {
    const m = new Map<number, any>();
    for (const p of latestPredictions ?? []) {
      m.set(Number(p.equipment_id), p);
    }
    return m;
  }, [latestPredictions]);

  const { data: dueSoonList } = useMaintenanceDueSoon();
  const dueSoonMap = useMemo(() => {
    const m = new Map<number, any>();
    for (const item of dueSoonList ?? []) m.set(item.id, item);
    return m;
  }, [dueSoonList]);

  const isAdmin = user?.role === 'ADMINISTRATOR';

  const { sort, onSort, page, setPage, rows: pagedEquipment, totalPages, total } = useTable(
    equipment,
    {
      defaultSortKey: "createdAt",
      defaultDir: "desc",
      getters: {
        "risk": (e) => {
          const p = predMap.get(e.id);
          return p ? parseFloat(p.prob_30d) : -1;
        },
        "nextService": (e) => {
          const d = dueSoonMap.get(e.id);
          return d ? Number(d.daysUntilDue) : 9999;
        },
        "dailyRate": (e) => parseFloat(e.dailyRate ?? "0"),
      }
    }
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Equipment Fleet</h2>
          <p className="text-muted-foreground">Manage your equipment inventory with ML-powered risk insights</p>
        </div>
        
        {isAdmin && (
          <div className="flex items-center gap-2">
          <SensorUpload />
          <Dialog open={isNewEquipmentOpen} onOpenChange={setIsNewEquipmentOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New Equipment
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add Equipment</DialogTitle>
                <DialogDescription>
                  Add new equipment to your fleet
                </DialogDescription>
              </DialogHeader>
              <EquipmentForm onSuccess={() => setIsNewEquipmentOpen(false)} />
            </DialogContent>
          </Dialog>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search equipment..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select 
          value={statusFilter || "all"} 
          onValueChange={(val) => setStatusFilter(val === "all" ? "" : val as "AVAILABLE" | "RENTED" | "MAINTENANCE")}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="AVAILABLE">Available</SelectItem>
            <SelectItem value="RENTED">Rented</SelectItem>
            <SelectItem value="MAINTENANCE">Maintenance</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Equipment Table */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <SortableTableHead sortKey="name" sort={sort} onSort={onSort}>Equipment</SortableTableHead>
              <SortableTableHead sortKey="category" sort={sort} onSort={onSort}>Category</SortableTableHead>
              <SortableTableHead sortKey="status" sort={sort} onSort={onSort}>Status</SortableTableHead>
              <SortableTableHead sortKey="risk" sort={sort} onSort={onSort}>Risk Level</SortableTableHead>
              <SortableTableHead sortKey="nextService" sort={sort} onSort={onSort}>Next Service</SortableTableHead>
              <SortableTableHead sortKey="dailyRate" sort={sort} onSort={onSort} align="right">Daily Rate</SortableTableHead>
              {isAdmin && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={isAdmin ? 7 : 6} className="text-center py-12 text-muted-foreground">
                  Loading equipment...
                </TableCell>
              </TableRow>
            ) : equipment?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isAdmin ? 7 : 6} className="text-center py-12 text-muted-foreground">
                  No equipment found.
                </TableCell>
              </TableRow>
            ) : (
              pagedEquipment.map((equip) => (
                <TableRow 
                  key={equip.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => setViewingEquipment(equip)}
                >
                  <TableCell>
                    <div className="font-medium">{equip.name}</div>
                    <div className="text-sm text-muted-foreground font-mono">
                      {equip.equipmentId}
                    </div>
                  </TableCell>
                  <TableCell>{equip.category}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        equip.status === 'AVAILABLE' && "bg-green-50 text-green-700 border-green-200",
                        equip.status === 'RENTED' && "bg-blue-50 text-blue-700 border-blue-200",
                        equip.status === 'MAINTENANCE' && "bg-orange-50 text-orange-700 border-orange-200"
                      )}
                    >
                      {equip.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <RiskBadge prediction={predMap.get(equip.id)} />
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const due = dueSoonMap.get(equip.id);
                      if (!due) return <span className="text-xs text-muted-foreground">—</span>;
                      const days = Number(due.daysUntilDue);
                      if (days < 0) return (
                        <Badge variant="outline" className="bg-red-100 text-red-800 border-red-300 text-xs">
                          Overdue {Math.abs(days)}d
                        </Badge>
                      );
                      if (days === 0) return (
                        <Badge variant="outline" className="bg-red-100 text-red-800 border-red-300 text-xs">
                          Due Today
                        </Badge>
                      );
                      return (
                        <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-300 text-xs">
                          Due in {days}d
                        </Badge>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="font-semibold">${equip.dailyRate}/day</TableCell>
                  {isAdmin && (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-700"
                          title="Edit"
                          onClick={() => setEditingEquipment(equip)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-700"
                          title="Delete"
                          onClick={() => setDeletingEquipment(equip)}
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

      {/* Edit Dialog */}
      {editingEquipment && (
        <Dialog open={!!editingEquipment} onOpenChange={() => setEditingEquipment(null)}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Equipment</DialogTitle>
              <DialogDescription>
                Update equipment details
              </DialogDescription>
            </DialogHeader>
            <EquipmentForm
              initialData={editingEquipment}
              onSuccess={() => setEditingEquipment(null)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deletingEquipment} onOpenChange={(open) => !open && setDeletingEquipment(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Equipment</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deletingEquipment?.name}</strong> ({deletingEquipment?.equipmentId})? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingEquipment(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deletingEquipment) {
                  deleteMutation.mutate(deletingEquipment.id, {
                    onSuccess: () => setDeletingEquipment(null),
                  });
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail View Dialog */}
      {viewingEquipment && (
        <Dialog open={!!viewingEquipment} onOpenChange={() => setViewingEquipment(null)}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Equipment Details</DialogTitle>
              <DialogDescription>
                View complete equipment information
              </DialogDescription>
            </DialogHeader>
            <EquipmentDetailView equipment={viewingEquipment} prediction={predMap.get(viewingEquipment.id)} />
            {isAdmin && (
              <div className="flex justify-end pt-4 border-t">
                <Button
                  onClick={() => {
                    setEditingEquipment(viewingEquipment);
                    setViewingEquipment(null);
                  }}
                >
                  Edit Equipment
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}