import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import { DollarSign, Wrench, TrendingUp, BarChart2 } from "lucide-react";
import { useTable } from "@/hooks/use-table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { TablePagination } from "@/components/ui/table-pagination";
import { CHART, fmtMoney, fmtMoneyCompact } from "@/lib/chart-theme";

function useMaintCostReport() {
  return useQuery({
    queryKey: ['/api/reports/maintenance-costs'],
    queryFn: async () => {
      const res = await fetch('/api/reports/maintenance-costs', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch maintenance cost report');
      return res.json() as Promise<{
        byEquipment: any[];
        byCategory: any[];
        byMonth: any[];
        summary: { totalEvents: number; totalCost: number; avgCostPerEvent: number };
      }>;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export default function MaintenanceCostReport() {
  const { data, isLoading } = useMaintCostReport();

  const { sort, onSort, page, setPage, rows: pagedEquipment, totalPages, total } = useTable(
    data?.byEquipment,
    {
      defaultSortKey: "totalCost",
      defaultDir: "desc",
      getters: {
        totalCost: (r) => Number(r.totalCost),
        avgCostPerEvent: (r) => Number(r.avgCostPerEvent),
        eventCount: (r) => Number(r.eventCount),
      },
    }
  );

  const summary = data?.summary;
  const byMonth = (data?.byMonth ?? []).map((d: any) => ({
    month: d.month,
    cost: Number(d.totalCost),
    events: Number(d.eventCount),
  }));
  // The query covers the last 12 months, but records may begin partway through.
  const firstMonth = byMonth[0]?.month as string | undefined;
  const fullYear = byMonth.length >= 12;
  const monthLabel = (m: string) =>
    new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Maintenance Cost Report</h2>
        <p className="text-muted-foreground">Fleet maintenance spend by month, category and unit</p>
      </div>

      {/* Summary — neutral stat tiles; cost is data, not danger */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Total Maintenance Spend</p>
              <DollarSign className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {fmtMoney(Number(summary?.totalCost ?? 0))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">All-time total</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Total Events</p>
              <Wrench className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {Number(summary?.totalEvents ?? 0).toLocaleString()}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">All maintenance records</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Avg Cost / Event</p>
              <TrendingUp className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              ${Number(summary?.avgCostPerEvent ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Per maintenance event</p>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Trend Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart2 className="h-5 w-5 text-muted-foreground" />
            Monthly Maintenance Spend
          </CardTitle>
          <CardDescription>
            {fullYear || !firstMonth
              ? "Cost per month over the last 12 months"
              : `Cost per month since records begin in ${monthLabel(firstMonth)}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byMonth}>
                <CartesianGrid {...CHART.grid} vertical={false} />
                <XAxis dataKey="month" stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} />
                <YAxis stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} tickFormatter={fmtMoneyCompact} />
                <Tooltip
                  formatter={(value: any, name: string) => [
                    name === 'cost' ? fmtMoney(Number(value)) : value,
                    name === 'cost' ? 'Spend' : 'Events',
                  ]}
                  {...CHART.tooltip}
                />
                <Bar dataKey="cost" fill={CHART.data} radius={CHART.barRadius} name="cost" maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* By Category + By Equipment */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cost by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={(data?.byCategory ?? []).map((d: any) => ({ ...d, totalCost: Number(d.totalCost) }))} layout="vertical">
                  <CartesianGrid {...CHART.grid} horizontal={false} />
                  <XAxis type="number" stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} tickFormatter={fmtMoneyCompact} />
                  <YAxis type="category" dataKey="category" stroke={CHART.axis.stroke} tick={CHART.axis.tick} tickLine={false} axisLine={false} width={90} />
                  <Tooltip formatter={(v: any) => [fmtMoney(Number(v)), 'Total Cost']} {...CHART.tooltip} />
                  {/* One measure, one hue — identity is the category label */}
                  <Bar dataKey="totalCost" fill={CHART.data} radius={CHART.barRadiusHorizontal} maxBarSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top Cost Equipment</CardTitle>
            <CardDescription>Highest maintenance spend units</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(data?.byEquipment ?? []).slice(0, 6).map((item: any, index: number) => (
                <div key={item.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-md bg-muted font-mono font-semibold text-xs text-muted-foreground flex items-center justify-center">
                      {index + 1}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.category} · {item.eventCount} events</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-mono font-semibold tabular-nums">{fmtMoney(Number(item.totalCost))}</p>
                    <p className="text-xs text-muted-foreground font-mono tabular-nums">${Number(item.avgCostPerEvent).toFixed(0)}/event</p>
                  </div>
                </div>
              ))}
              {(data?.byEquipment ?? []).length === 0 && !isLoading && (
                <p className="text-center text-muted-foreground py-8">No maintenance cost data available</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Full Equipment Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Equipment — Maintenance Spend</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead sortKey="name" sort={sort} onSort={onSort}>Equipment</SortableTableHead>
                <SortableTableHead sortKey="category" sort={sort} onSort={onSort}>Category</SortableTableHead>
                <SortableTableHead sortKey="eventCount" sort={sort} onSort={onSort} align="right">Events</SortableTableHead>
                <SortableTableHead sortKey="totalCost" sort={sort} onSort={onSort} align="right">Total Cost</SortableTableHead>
                <SortableTableHead sortKey="avgCostPerEvent" sort={sort} onSort={onSort} align="right">Avg / Event</SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
                </TableRow>
              ) : pagedEquipment.map((item: any) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="font-medium">{item.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{item.equipmentId}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">{item.category}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{item.eventCount}</TableCell>
                  <TableCell className="text-right font-mono font-medium tabular-nums">
                    {fmtMoney(Number(item.totalCost))}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                    ${Number(item.avgCostPerEvent).toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
        </CardContent>
      </Card>
    </div>
  );
}
