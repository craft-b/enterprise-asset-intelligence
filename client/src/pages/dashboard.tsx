import { useState } from "react";
import { useEquipment } from "@/hooks/use-equipment";
import { useRentals } from "@/hooks/use-rentals";
import { useMaintenanceDueSoon } from "@/hooks/use-maintenance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MaintenanceForm } from "@/components/maintenance-form";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import { DollarSign, TrendingUp, Percent, AlertCircle, Calendar, AlertTriangle, Truck, Wrench, BarChart3, ChevronRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { format, startOfWeek, addDays, isSameDay, startOfMonth, subMonths, differenceInDays } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { useSimulationState } from "@/hooks/use-predictive-maintenance";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { CHART, fmtMoney, fmtMoneyCompact } from "@/lib/chart-theme";

export default function Dashboard() {
  const { data: equipment } = useEquipment();
  const { data: rentals } = useRentals();
  const { data: dueSoonList } = useMaintenanceDueSoon();
  const overdueItems  = dueSoonList?.filter(d => Number(d.daysUntilDue) < 0)  ?? [];
  const dueSoonItems  = dueSoonList?.filter(d => Number(d.daysUntilDue) >= 0) ?? [];
  const overdueCount  = overdueItems.length;
  const dueSoonCount  = dueSoonItems.length;

  const [schedulingEquip, setSchedulingEquip] = useState<{ id: number; name: string } | null>(null);

  const simState = useSimulationState();
  const today = simState.data?.cursor_date
    ? new Date(String(simState.data.cursor_date).substring(0, 10))
    : new Date();
  const weekStart = startOfWeek(today, { weekStartsOn: 0 });
  
  const { data: revenueSummary } = useQuery({
    queryKey: ['/api/dashboard/revenue-summary'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard/revenue-summary', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
  });

  const { data: monthlyTrendData } = useQuery({
    queryKey: ['/api/dashboard/monthly-trend'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard/monthly-trend', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
  });

  const { data: dailyRevenueData } = useQuery({
    queryKey: ['/api/dashboard/daily-revenue'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard/daily-revenue', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      return res.json() as Promise<Array<{ day: string; revenue: number }>>;
    },
  });

  const weekToDateRevenue    = revenueSummary?.revenueWtd       ?? 0;
  const monthlyRevenue       = revenueSummary?.revenue30d       ?? 0;
  const utilizationRate      = revenueSummary?.utilizationRate  ?? 0;
  const avgUtilization30d    = revenueSummary?.avgUtilization30d ?? 0;
  const outstandingAR        = revenueSummary?.outstandingAr    ?? 0;
  const uninvoicedCount      = revenueSummary?.uninvoicedCount  ?? 0;
  const totalEquipment       = revenueSummary?.totalEquipment   ?? 0;
  const rentedEquipment      = revenueSummary?.rentedEquipment  ?? 0;
  const monthlyTrend         = (monthlyTrendData ?? []) as Array<{ month: string; revenue: number }>;
  const dailyRevenue         = (dailyRevenueData ?? []) as Array<{ day: string; revenue: number }>;
  const hasAnyDailyRevenue   = dailyRevenue.some(d => d.revenue > 0);

  // Top 5 Revenue-Generating Job Sites
  const siteRevenueMap: Record<string, { name: string; revenue: number; equipmentCount: number }> = {};
  rentals?.forEach(rental => {
    const siteName = rental.jobSite?.name || rental.jobSite?.jobId || 'Unknown';
    if (!siteRevenueMap[siteName]) {
      siteRevenueMap[siteName] = { name: siteName, revenue: 0, equipmentCount: 0 };
    }
    
    if (rental.receiveDate) {
      const startDate = new Date(rental.receiveDate);
      const endDate = rental.returnDate ? new Date(rental.returnDate) : today;
      const days = differenceInDays(endDate, startDate) + 1;
      const dailyRate = Number(rental.equipment?.dailyRate || 0);
      siteRevenueMap[siteName].revenue += dailyRate * days;
      siteRevenueMap[siteName].equipmentCount += 1;
    }
  });

  const topJobSites = Object.values(siteRevenueMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Equipment count by job site (active rentals only)
  const siteCounts: Record<string, number> = {};
  rentals?.filter(r => r.status === 'ACTIVE').forEach(r => {
    const site = r.jobSite?.name || r.jobSite?.jobId || 'Unknown';
    siteCounts[site] = (siteCounts[site] || 0) + 1;
  });
  const equipmentBySite = Object.entries(siteCounts)
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Financial Dashboard</h2>
          <p className="text-muted-foreground">Real-time revenue analytics and fleet performance</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-4 w-4" />
          <span>Week of {format(weekStart, 'MMM d, yyyy')}</span>
        </div>
      </div>

      {/* Empty-state banner — shown when no equipment has been added yet */}
      {equipment !== undefined && equipment.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/30 p-8 text-center space-y-4">
          <div className="flex justify-center gap-4 text-muted-foreground/40">
            <Truck className="h-12 w-12" />
            <BarChart3 className="h-12 w-12" />
            <Wrench className="h-12 w-12" />
          </div>
          <div>
            <h3 className="text-xl font-semibold">No equipment yet</h3>
            <p className="text-muted-foreground mt-1">
              Add your first piece of equipment to start tracking revenue, utilization, and maintenance.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Link href="/equipment">
              <a className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                <Truck className="h-4 w-4" />
                Add Equipment
                <ChevronRight className="h-4 w-4" />
              </a>
            </Link>
            <Link href="/ml-performance">
              <a className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
                <BarChart3 className="h-4 w-4" />
                Explore ML Features
                <ChevronRight className="h-4 w-4" />
              </a>
            </Link>
            <Link href="/maintenance">
              <a className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
                <Wrench className="h-4 w-4" />
                Maintenance Planner
                <ChevronRight className="h-4 w-4" />
              </a>
            </Link>
          </div>
        </div>
      )}

      {/* Key Financial Metrics — neutral stat tiles; color is reserved for semantics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Week-to-Date Revenue</p>
              <DollarSign className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {fmtMoney(weekToDateRevenue)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {differenceInDays(today, weekStart) + 1} days elapsed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">30-Day Revenue</p>
              <TrendingUp className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {fmtMoney(monthlyRevenue)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Accrued revenue, rolling 30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Fleet Utilization</p>
              <Percent className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {utilizationRate.toFixed(1)}%
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {rentedEquipment} of {totalEquipment} assets rented · {avgUtilization30d.toFixed(1)}% 30-day avg
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Outstanding A/R</p>
              <AlertCircle className="h-4 w-4 text-muted-foreground/60" />
            </div>
            <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight">
              {fmtMoney(outstandingAR)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Unpaid completed rentals
              {uninvoicedCount > 0 && ` · ${uninvoicedCount} awaiting invoice`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Daily Revenue (Last 30 Days)</CardTitle>
            <p className="text-sm text-muted-foreground">Accrued daily rate for all active &amp; completed rentals</p>
          </CardHeader>
          <CardContent className="pl-2">
            <div className="h-[350px] w-full">
              {!hasAnyDailyRevenue ? (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  No rental revenue in the last 30 days
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyRevenue} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
                    <CartesianGrid {...CHART.grid} vertical={false} />
                    <XAxis
                      dataKey="day"
                      stroke={CHART.axis.stroke}
                      tick={CHART.axis.tick}
                      tickLine={false}
                      axisLine={false}
                      interval={4}
                      tickFormatter={(v) => {
                        try { return format(new Date(v + 'T00:00:00'), 'MMM d'); } catch { return v; }
                      }}
                    />
                    <YAxis
                      stroke={CHART.axis.stroke}
                      tick={CHART.axis.tick}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={fmtMoneyCompact}
                    />
                    <Tooltip
                      formatter={(value: number) => [fmtMoney(value), 'Revenue']}
                      labelFormatter={(label) => {
                        try { return format(new Date(label + 'T00:00:00'), 'MMM d, yyyy'); } catch { return label; }
                      }}
                      {...CHART.tooltip}
                    />
                    <Bar dataKey="revenue" fill={CHART.data} radius={CHART.barRadius} name="Revenue" maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Revenue Trend (12 Months)</CardTitle>
            <p className="text-sm text-muted-foreground">Monthly completed rental revenue</p>
          </CardHeader>
          <CardContent>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyTrend}>
                  <CartesianGrid {...CHART.grid} vertical={false} />
                  <XAxis
                    dataKey="month"
                    stroke={CHART.axis.stroke}
                    tick={CHART.axis.tick}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: string) => {
                      try {
                        const [y, m] = v.split('-').map(Number);
                        return format(new Date(y, m - 1, 1), "MMM ''yy");
                      } catch { return v; }
                    }}
                  />
                  <YAxis
                    stroke={CHART.axis.stroke}
                    tick={CHART.axis.tick}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={fmtMoneyCompact}
                  />
                  <Tooltip
                    {...CHART.tooltip}
                    formatter={(value) => [fmtMoney(Number(value)), 'Revenue']}
                    labelFormatter={(label: string) => {
                      try {
                        const [y, m] = label.split('-').map(Number);
                        return format(new Date(y, m - 1, 1), 'MMMM yyyy');
                      } catch { return label; }
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke={CHART.data}
                    strokeWidth={CHART.line.strokeWidth}
                    dot={CHART.line.dot}
                    activeDot={CHART.line.activeDot}
                    name="Revenue"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Equipment by Job Site */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Active Equipment by Job Site</CardTitle>
          <p className="text-sm text-muted-foreground">Units currently deployed per site</p>
        </CardHeader>
        <CardContent>
          {equipmentBySite.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
              No active rentals
            </div>
          ) : (
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={equipmentBySite}
                  layout="vertical"
                  margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
                >
                  <CartesianGrid {...CHART.grid} horizontal={false} />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    stroke={CHART.axis.stroke}
                    tick={CHART.axis.tick}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="site"
                    stroke={CHART.axis.stroke}
                    tick={CHART.axis.tick}
                    tickLine={false}
                    axisLine={false}
                    width={140}
                  />
                  <Tooltip
                    formatter={(value: number) => [value, 'Units deployed']}
                    {...CHART.tooltip}
                  />
                  {/* One measure, one hue — identity lives in the y-axis labels */}
                  <Bar dataKey="count" fill={CHART.data} radius={CHART.barRadiusHorizontal} maxBarSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Maintenance Alerts */}
      {(overdueCount > 0 || dueSoonCount > 0) && (
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-risk-medium" />
              Maintenance Alerts
            </CardTitle>
            <Link href="/equipment">
              <span className="text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
                View equipment →
              </span>
            </Link>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* Overdue section — semantic HIGH */}
            {overdueCount > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-risk-high">
                    <span className="inline-block w-2 h-2 rounded-full bg-risk-high" />
                    Overdue
                    <span className="ml-1 tabular-nums">({overdueCount})</span>
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>
                <div className="space-y-0.5">
                  {overdueItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSchedulingEquip({ id: item.id, name: item.name })}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-md text-left hover:bg-muted transition-colors group"
                    >
                      <div className="min-w-0 mr-3">
                        <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{item.equipmentId}</p>
                      </div>
                      <Badge variant="outline" className="shrink-0 bg-risk-high-surface text-risk-high border-risk-high text-xs font-medium tabular-nums">
                        {Math.abs(Number(item.daysUntilDue))}d overdue
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Due Soon section — semantic MEDIUM */}
            {dueSoonCount > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-risk-medium">
                    <span className="inline-block w-2 h-2 rounded-full bg-risk-medium" />
                    Due Soon
                    <span className="ml-1 tabular-nums">({dueSoonCount})</span>
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>
                <div className="space-y-0.5">
                  {dueSoonItems.map((item) => {
                    const days = Number(item.daysUntilDue);
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSchedulingEquip({ id: item.id, name: item.name })}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-md text-left hover:bg-muted transition-colors group"
                      >
                        <div className="min-w-0 mr-3">
                          <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{item.equipmentId}</p>
                        </div>
                        <Badge variant="outline" className="shrink-0 bg-risk-medium-surface text-risk-medium border-risk-medium text-xs font-medium tabular-nums">
                          {days === 0 ? 'Today' : `${days}d`}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

          </CardContent>
        </Card>
      )}

      {/* Top Job Sites & Equipment ROI */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top 5 Revenue-Generating Job Sites</CardTitle>
            <p className="text-sm text-muted-foreground">Lifetime revenue by customer</p>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {topJobSites.map((site, index) => (
                <div key={site.name} className="flex items-center justify-between border-b pb-3 last:border-0">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center justify-center w-7 h-7 rounded-md bg-muted font-mono font-semibold text-xs text-muted-foreground">
                      {index + 1}
                    </div>
                    <div>
                      <p className="font-medium">{site.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {site.equipmentCount} rental{site.equipmentCount !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-semibold tabular-nums">
                      {fmtMoney(site.revenue)}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono tabular-nums">
                      ${(site.revenue / site.equipmentCount).toFixed(0)}/rental
                    </p>
                  </div>
                </div>
              ))}
              {topJobSites.length === 0 && (
                <p className="text-center text-muted-foreground py-8">No job site data available</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Equipment ROI Analysis</CardTitle>
            <p className="text-sm text-muted-foreground">Top performing assets by revenue</p>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {equipment
                ?.sort((a, b) => {
                  const aRentals = rentals?.filter(r => r.equipmentId === a.id) || [];
                  const bRentals = rentals?.filter(r => r.equipmentId === b.id) || [];
                  const aRevenue = aRentals.reduce((sum, r) => {
                    if (!r.receiveDate) return sum;
                    const days = r.returnDate 
                      ? differenceInDays(new Date(r.returnDate), new Date(r.receiveDate)) + 1
                      : differenceInDays(today, new Date(r.receiveDate)) + 1;
                    return sum + (Number(a.dailyRate || 0) * days);
                  }, 0);
                  const bRevenue = bRentals.reduce((sum, r) => {
                    if (!r.receiveDate) return sum;
                    const days = r.returnDate 
                      ? differenceInDays(new Date(r.returnDate), new Date(r.receiveDate)) + 1
                      : differenceInDays(today, new Date(r.receiveDate)) + 1;
                    return sum + (Number(b.dailyRate || 0) * days);
                  }, 0);
                  return bRevenue - aRevenue;
                })
                .slice(0, 5)
                .map((equip, index) => {
                  const equipmentRentals = rentals?.filter(r => r.equipmentId === equip.id) || [];
                  const totalRevenue = equipmentRentals.reduce((sum, r) => {
                    if (!r.receiveDate) return sum;
                    const days = r.returnDate 
                      ? differenceInDays(new Date(r.returnDate), new Date(r.receiveDate)) + 1
                      : differenceInDays(today, new Date(r.receiveDate)) + 1;
                    return sum + (Number(equip.dailyRate || 0) * days);
                  }, 0);

                  return (
                    <div key={equip.id} className="flex items-center justify-between border-b pb-3 last:border-0">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-muted font-mono font-semibold text-xs text-muted-foreground">
                          {index + 1}
                        </div>
                        <div>
                          <p className="font-medium">{equip.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">
                            {equip.equipmentId}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-mono font-semibold tabular-nums">
                          {fmtMoney(totalRevenue)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {equipmentRentals.length} rental{equipmentRentals.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      </div>
      {/* Schedule Maintenance Dialog (triggered from Maintenance Alerts card) */}
      <Dialog open={!!schedulingEquip} onOpenChange={(open) => !open && setSchedulingEquip(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Log Maintenance Event</DialogTitle>
            <DialogDescription>
              {schedulingEquip ? `Schedule maintenance for ${schedulingEquip.name}` : 'Schedule maintenance'}
            </DialogDescription>
          </DialogHeader>
          {schedulingEquip && (
            <MaintenanceForm
              equipmentId={schedulingEquip.id}
              equipmentName={schedulingEquip.name}
              defaultEventSource="SCHEDULED_PM"
              onSuccess={() => setSchedulingEquip(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}