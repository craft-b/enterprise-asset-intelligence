
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Package, MapPin, Building2, Calendar, FileText, DollarSign, ArrowRightLeft } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useSwapHistory } from "@/hooks/use-rentals";
import { calendarDate } from "@/lib/calendar-date";

type RentalDetailViewProps = {
  rental: any; // The full rental object with relations
};

export function RentalDetailView({ rental }: RentalDetailViewProps) {
  const { data: swapHistory } = useSwapHistory(rental?.id ?? 0);

  if (!rental) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Rental not found
      </div>
    );
  }

  const duration = rental.receiveDate && rental.returnDate 
    ? Math.ceil((calendarDate(rental.returnDate).getTime() - calendarDate(rental.receiveDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <div className="space-y-6">
      {/* Status Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className={cn(
            "text-base px-3 py-1",
            rental.status === 'ACTIVE' ? "bg-orange-50 text-orange-700 border-orange-200" :
            rental.status === 'COMPLETED' ? "bg-green-50 text-green-700 border-green-200" :
            "bg-slate-100 text-slate-600"
          )}>
            {rental.status}
          </Badge>
          <Badge variant="outline" className={cn(
            "text-base px-3 py-1",
            rental.buyRent === 'BUY' ? "bg-blue-50 text-blue-700 border-blue-200" :
            "bg-purple-50 text-purple-700 border-purple-200"
          )}>
            {rental.buyRent}
          </Badge>
        </div>
        {rental.poNumber && (
          <div className="text-sm text-muted-foreground">
            PO: <span className="font-mono font-medium">{rental.poNumber}</span>
          </div>
        )}
      </div>

      {/* Equipment Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Equipment</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="text-lg font-semibold">{rental.equipment?.name || 'Unknown Equipment'}</div>
            <div className="text-sm text-muted-foreground">
              {rental.equipment?.category} • {rental.equipment?.make} {rental.equipment?.model}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Serial Number</div>
              <div className="font-mono font-medium">{rental.equipment?.serialNumber || rental.equipment?.equipmentId}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Daily Rate</div>
              <div className="font-semibold text-green-600">${rental.equipment?.dailyRate}/day</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Job Site Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Job Site</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {rental.jobSite ? (
            <>
              <div>
                <div className="text-lg font-semibold">{rental.jobSite.name}</div>
                <div className="text-sm text-muted-foreground font-mono">{rental.jobSite.jobId}</div>
              </div>
              {rental.jobSite.address && (
                <div className="text-sm">
                  <div className="text-muted-foreground">Address</div>
                  <div>{rental.jobSite.address}</div>
                </div>
              )}
              {(rental.jobSite.contactPerson || rental.jobSite.contactPhone) && (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {rental.jobSite.contactPerson && (
                    <div>
                      <div className="text-muted-foreground">Contact Person</div>
                      <div className="font-medium">{rental.jobSite.contactPerson}</div>
                    </div>
                  )}
                  {rental.jobSite.contactPhone && (
                    <div>
                      <div className="text-muted-foreground">Phone</div>
                      <div className="font-medium">{rental.jobSite.contactPhone}</div>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No job site information</div>
          )}
        </CardContent>
      </Card>

      {/* Vendor Details (if applicable) */}
      {rental.vendor && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Vendor</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-lg font-semibold">{rental.vendor.name}</div>
              <div className="text-sm text-muted-foreground font-mono">{rental.vendor.vendorId}</div>
            </div>
            {rental.vendor.address && (
              <div className="text-sm">
                <div className="text-muted-foreground">Address</div>
                <div>{rental.vendor.address}</div>
              </div>
            )}
            {(rental.vendor.salesPerson || rental.vendor.contact) && (
              <div className="grid grid-cols-2 gap-4 text-sm">
                {rental.vendor.salesPerson && (
                  <div>
                    <div className="text-muted-foreground">Sales Person</div>
                    <div className="font-medium">{rental.vendor.salesPerson}</div>
                  </div>
                )}
                {rental.vendor.contact && (
                  <div>
                    <div className="text-muted-foreground">Contact</div>
                    <div className="font-medium">{rental.vendor.contact}</div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Timeline</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Received</div>
              <div className="text-lg font-semibold text-green-600">
                {rental.receiveDate ? format(calendarDate(rental.receiveDate), 'MMM d, yyyy') : 'N/A'}
              </div>
              {rental.receiveHours && (
                <div className="text-sm text-muted-foreground mt-1">
                  Hours: {rental.receiveHours}
                </div>
              )}
              {rental.receiveDocument && (
                <div className="text-xs text-muted-foreground mt-1">
                  Doc: {rental.receiveDocument}
                </div>
              )}
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Returned</div>
              {rental.returnDate ? (
                <>
                  <div className="text-lg font-semibold">
                    {format(calendarDate(rental.returnDate), 'MMM d, yyyy')}
                  </div>
                  {rental.returnHours && (
                    <div className="text-sm text-muted-foreground mt-1">
                      Hours: {rental.returnHours}
                    </div>
                  )}
                  {rental.returnDocument && (
                    <div className="text-xs text-muted-foreground mt-1">
                      Doc: {rental.returnDocument}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-lg font-semibold text-orange-600">Ongoing</div>
              )}
            </div>
          </div>
          {duration && (
            <div className="pt-2 border-t">
              <div className="text-sm text-muted-foreground">Total Duration</div>
              <div className="text-lg font-semibold">{duration} days</div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {rental.notes && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Notes</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{rental.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Invoices (if any) */}
      {rental.invoices && rental.invoices.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Invoices</CardTitle>
              <Badge variant="outline" className="ml-auto">
                {rental.invoices.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {rental.invoices.map((invoice: any) => (
                <div key={invoice.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <div className="font-mono text-sm font-medium">{invoice.invoiceNumber}</div>
                    <div className="text-xs text-muted-foreground">
                      {format(calendarDate(invoice.invoiceDate), 'MMM d, yyyy')} •
                      {format(new Date(invoice.periodFrom), 'MMM d')} - {format(new Date(invoice.periodTo), 'MMM d, yyyy')}
                    </div>
                  </div>
                  <div className="text-lg font-semibold text-green-600">
                    ${Number(invoice.amount).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Swap History (if any) */}
      {swapHistory && swapHistory.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Equipment Swap History</CardTitle>
              <Badge variant="outline" className="ml-auto">
                {swapHistory.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {swapHistory.map((swap: any) => (
                <div key={swap.id} className="p-3 border rounded-lg space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                      <span className="text-slate-600">{swap.originalEquipment?.name ?? `#${swap.originalEquipmentId}`}</span>
                      <span className="mx-2 text-muted-foreground">→</span>
                      <span className="text-purple-700">{swap.replacementEquipment?.name ?? `#${swap.replacementEquipmentId}`}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {swap.swapDate ? format(calendarDate(swap.swapDate), 'MMM d, yyyy') : ''}
                    </div>
                  </div>
                  {swap.reason && (
                    <div className="text-xs text-muted-foreground">Reason: {swap.reason}</div>
                  )}
                  {swap.swappedBy && (
                    <div className="text-xs text-muted-foreground">By: {swap.swappedBy}</div>
                  )}
                  {swap.notes && (
                    <div className="text-xs text-muted-foreground">{swap.notes}</div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}