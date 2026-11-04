import { useState } from "react";
import { useEquipment } from "@/hooks/use-equipment";
import { useSwapEquipment } from "@/hooks/use-rentals";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowRightLeft, Loader2 } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rental: any;
};

export function SwapEquipmentDialog({ open, onOpenChange, rental }: Props) {
  const { data: availableEquipment } = useEquipment({ status: "AVAILABLE" });
  const swapMutation = useSwapEquipment();

  const [replacementId, setReplacementId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [swappedBy, setSwappedBy] = useState("");
  const [notes, setNotes] = useState("");

  const handleSubmit = () => {
    if (!replacementId) return;
    swapMutation.mutate(
      { rentalId: rental.id, replacementEquipmentId: replacementId, reason, swappedBy, notes },
      {
        onSuccess: () => {
          onOpenChange(false);
          setReplacementId(null);
          setReason("");
          setSwappedBy("");
          setNotes("");
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            Swap Equipment
          </DialogTitle>
          <DialogDescription>
            Replace <strong>{rental?.equipment?.name}</strong> on this rental with an available unit.
            The original unit will become available again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {swapMutation.isError && (
            <Alert variant="destructive">
              <AlertDescription>{(swapMutation.error as any)?.message}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label>Replacement Equipment</Label>
            <Select onValueChange={(val) => setReplacementId(Number(val))}>
              <SelectTrigger>
                <SelectValue placeholder="Select available equipment" />
              </SelectTrigger>
              <SelectContent>
                {availableEquipment?.map((eq) => (
                  <SelectItem key={eq.id} value={eq.id.toString()}>
                    {eq.name} · {eq.equipmentId} ({eq.category}) — ${eq.dailyRate}/day
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Reason for Swap (Optional)</Label>
            <Input
              placeholder="e.g. Breakdown, scheduled maintenance, upgrade"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Swapped By (Optional)</Label>
            <Input
              placeholder="Dispatcher or technician name"
              value={swappedBy}
              onChange={(e) => setSwappedBy(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Notes (Optional)</Label>
            <Textarea
              placeholder="Additional details about this swap..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={!replacementId || swapMutation.isPending}
          >
            {swapMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm Swap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
