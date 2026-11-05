import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Package, DollarSign, MapPin, Calendar, AlertTriangle,
  CheckCircle, TrendingUp, Wrench, Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// prediction is a raw row from /api/risk-score/multi-horizon/latest
function RiskCard({ equipmentId, prediction }: { equipmentId: number; prediction: any }) {
  const [isScheduling, setIsScheduling] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');

  // Use simulation cursor as default date, not wall clock
  useEffect(() => {
    fetch('/api/simulate/state', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(state => {
        const d = state?.cursor_date ?? null;
        setScheduledDate(d ? String(d).substring(0, 10) : format(new Date(), 'yyyy-MM-dd'));
      })
      .catch(() => setScheduledDate(format(new Date(), 'yyyy-MM-dd')));
  }, []);
  const [maintenanceType, setMaintenanceType] = useState<
    "INSPECTION" | "MINOR_SERVICE" | "MAJOR_SERVICE"
  >("INSPECTION");
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const riskBand = prediction?.risk_level_30d as "LOW" | "MEDIUM" | "HIGH" | undefined;
  const failureProbability = prediction ? parseFloat(prediction.prob_30d) : null;
  const topDrivers: string[] = prediction?.top_drivers_30d
    ? JSON.parse(prediction.top_drivers_30d)
    : [];

  const suggestedType = riskBand === 'HIGH'
    ? 'MAJOR_SERVICE'
    : riskBand === 'MEDIUM'
    ? 'MINOR_SERVICE'
    : 'INSPECTION';

  const handleOpenSchedule = () => {
    setMaintenanceType(suggestedType);
    setDescription(
      prediction?.recommendation
        ? prediction.recommendation.slice(0, 200)
        : `Scheduled based on ${riskBand ?? 'current'} risk assessment`
    );
    setCost("");
    setIsScheduling(true);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      // 1. Create maintenance log entry
      const maintRes = await fetch('/api/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          equipmentId,
          maintenanceDate: scheduledDate,
          maintenanceType,
          description,
          performedBy: 'Scheduled via Risk Assessment',
          eventSource: 'PREDICTIVE_INTERVENTION',
          cost: cost || null,
        }),
      });
      if (!maintRes.ok) throw new Error('Failed to create maintenance entry');

      // 2. Update equipment status to MAINTENANCE
      const equipRes = await fetch(`/api/equipment/${equipmentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'MAINTENANCE' }),
      });
      if (!equipRes.ok) throw new Error('Failed to update equipment status');

      // 3. POST /api/maintenance has already rescored this unit by the time it
      //    answers. Rescoring here through batch would replace that row with
      //    template text, because batch never calls the LLM.
      await queryClient.invalidateQueries({ queryKey: ['/api/equipment'] });
      await queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      await queryClient.invalidateQueries({ queryKey: ['/api/risk-score/multi-horizon/latest'] });
      await queryClient.invalidateQueries({ queryKey: ['/api/predictive-maintenance/equipment-with-risk'] });
      await queryClient.invalidateQueries({ queryKey: ['/api/maintenance/due-soon'] });

      toast({
        title: 'Maintenance Scheduled',
        description: `${maintenanceType.replace(/_/g, ' ')} logged for ${format(new Date(scheduledDate + 'T00:00:00'), 'MMM d, yyyy')}. Risk score recalculated.`,
      });
      setIsScheduling(false);
    } catch (err: any) {
      toast({
        title: 'Failed to schedule maintenance',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Risk Assessment</CardTitle>
            </div>
            {prediction && (
              <Button
                size="sm"
                variant={riskBand === 'HIGH' ? 'destructive' : 'outline'}
                onClick={handleOpenSchedule}
              >
                <Wrench className="h-4 w-4 mr-2" />
                Schedule Maintenance
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!prediction ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              No risk prediction available. Run predictions from the Predictive Maintenance dashboard.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg border-2 border-dashed">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Failure Probability (30d)</div>
                  <div className="text-3xl font-bold">
                    {((failureProbability ?? 0) * 100).toFixed(1)}%
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Model {prediction.model_version} • {format(new Date(prediction.predicted_at), 'MMM d, yyyy')}
                  </div>
                </div>
                <Badge
                  className={cn(
                    "text-base px-4 py-2",
                    riskBand === 'HIGH' && "bg-red-100 text-red-800 border-red-300",
                    riskBand === 'MEDIUM' && "bg-orange-100 text-orange-800 border-orange-300",
                    riskBand === 'LOW' && "bg-green-100 text-green-800 border-green-300"
                  )}
                >
                  {riskBand} RISK
                </Badge>
              </div>

              {prediction.recommendation && (
                <Alert className={cn(
                  riskBand === 'HIGH' && "border-red-200 bg-red-50",
                  riskBand === 'MEDIUM' && "border-orange-200 bg-orange-50",
                  riskBand === 'LOW' && "border-green-200 bg-green-50",
                )}>
                  {riskBand === 'HIGH' ? (
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                  ) : riskBand === 'MEDIUM' ? (
                    <AlertTriangle className="h-4 w-4 text-orange-600" />
                  ) : (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  )}
                  <AlertDescription className="text-sm">
                    {prediction.recommendation}
                  </AlertDescription>
                </Alert>
              )}

              {topDrivers.length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">Top Risk Drivers</div>
                  <div className="flex flex-wrap gap-2">
                    {topDrivers.map((feature: string, idx: number) => (
                      <Badge key={idx} variant="outline" className="text-xs text-muted-foreground">
                        {feature.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Schedule Maintenance Dialog */}
      <Dialog open={isScheduling} onOpenChange={setIsScheduling}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="h-5 w-5" />
              Schedule Maintenance
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {prediction && (
              <Alert className={cn(
                riskBand === 'HIGH' && "border-red-200 bg-red-50",
                riskBand === 'MEDIUM' && "border-orange-200 bg-orange-50",
                riskBand === 'LOW' && "border-green-200 bg-green-50",
              )}>
                <AlertTriangle className={cn(
                  "h-4 w-4",
                  riskBand === 'HIGH' ? "text-red-600" :
                  riskBand === 'MEDIUM' ? "text-orange-600" : "text-green-600"
                )} />
                <AlertDescription className="text-sm">
                  <strong>{riskBand} RISK</strong> — {((failureProbability ?? 0) * 100).toFixed(1)}% failure probability.
                  Suggested: <strong>{suggestedType.replace(/_/g, ' ')}</strong>
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">Maintenance Type</label>
              <Select
                value={maintenanceType}
                onValueChange={(v) => setMaintenanceType(v as typeof maintenanceType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INSPECTION">Inspection</SelectItem>
                  <SelectItem value="MINOR_SERVICE">Minor Service</SelectItem>
                  <SelectItem value="MAJOR_SERVICE">Major Service</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Scheduled Date</label>
              <Input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Input
                placeholder="Maintenance notes..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                <Input
                  className="pl-6"
                  type="number"
                  step="0.01"
                  placeholder="Cost (optional)"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </div>
              {cost && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  logged to record
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Submitting will create a maintenance log entry and set equipment status to <strong>MAINTENANCE</strong>.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsScheduling(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type EquipmentDetailViewProps = {
  equipment: any;
  prediction?: any;
};

export function EquipmentDetailView({ equipment, prediction }: EquipmentDetailViewProps) {
  if (!equipment) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Equipment not found
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-2xl font-bold">{equipment.name}</h3>
          <p className="text-sm text-muted-foreground font-mono">{equipment.equipmentId}</p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "text-base px-3 py-1",
            equipment.status === 'AVAILABLE' && "bg-green-50 text-green-700 border-green-200",
            equipment.status === 'RENTED' && "bg-blue-50 text-blue-700 border-blue-200",
            equipment.status === 'MAINTENANCE' && "bg-orange-50 text-orange-700 border-orange-200"
          )}
        >
          {equipment.status}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Equipment Details</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm text-muted-foreground">Category</div>
              <div className="font-medium">{equipment.category}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Make</div>
              <div className="font-medium">{equipment.make || 'N/A'}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Model</div>
              <div className="font-medium">{equipment.model || 'N/A'}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Serial Number</div>
              <div className="font-mono font-medium">{equipment.serialNumber || 'N/A'}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Rental Rates</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-4 border rounded-lg">
              <div className="text-sm text-muted-foreground mb-1">Daily</div>
              <div className="text-2xl font-bold text-green-600">${equipment.dailyRate}</div>
            </div>
            {equipment.weeklyRate && (
              <div className="text-center p-4 border rounded-lg">
                <div className="text-sm text-muted-foreground mb-1">Weekly</div>
                <div className="text-2xl font-bold text-green-600">${equipment.weeklyRate}</div>
              </div>
            )}
            {equipment.monthlyRate && (
              <div className="text-center p-4 border rounded-lg">
                <div className="text-sm text-muted-foreground mb-1">Monthly</div>
                <div className="text-2xl font-bold text-green-600">${equipment.monthlyRate}</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {equipment.location && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Current Location</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{equipment.location}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <CardTitle>System Information</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Added to System</span>
              <span className="font-medium">
                {equipment.createdAt ? format(new Date(equipment.createdAt), 'MMM d, yyyy') : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Equipment ID</span>
              <span className="font-mono font-medium">{equipment.equipmentId}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current Mileage</span>
              <span className="font-medium">{equipment.currentMileage ? `${parseFloat(equipment.currentMileage).toLocaleString()} mi` : 'N/A'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Database ID</span>
              <span className="font-mono">{equipment.id}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <RiskCard equipmentId={equipment.id} prediction={prediction ?? null} />
    </div>
  );
}