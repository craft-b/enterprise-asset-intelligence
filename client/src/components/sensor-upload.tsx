// client/src/components/sensor-upload.tsx
//
// Uploading real sensor readings as CSV.
//
// The realistic path for a yard is a spreadsheet exported from whatever system
// they already run, not an API integration, so the file is the interface.
//
// Errors are shown in full rather than summarised. The server rejects a file
// whole and lists every problem at once, and surfacing only the first would
// turn one fix into twenty round trips through a file of ten thousand rows.

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Upload, FileUp, CheckCircle2, AlertTriangle, Loader2, Download } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

interface RowError {
  row: number;
  field?: string;
  message: string;
}

interface IngestResponse {
  message: string;
  inserted?: number;
  duplicates?: number;
  errors?: RowError[];
}

/** Shown at once; the rest are counted. Enough to see the pattern. */
const ERRORS_SHOWN = 25;

export function SensorUpload() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  async function upload(file: File) {
    setBusy(true);
    setResult(null);
    setFileName(file.name);
    try {
      const res = await fetch("/api/sensor-readings", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: await file.text(),
        credentials: "include",
      });
      const body: IngestResponse = await res.json();
      setResult(body);

      if (res.ok) {
        // Readings feed every downstream view, so none of them are still right.
        queryClient.invalidateQueries();
      }
    } catch (err: any) {
      setResult({ message: err?.message ?? "Upload failed" });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const succeeded = result && (result.inserted ?? 0) > 0 && !result.errors?.length;
  const errors = result?.errors ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) { setResult(null); setFileName(null); }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="mr-2 h-4 w-4" />
          Import Sensor Data
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import sensor readings</DialogTitle>
          <DialogDescription>
            A CSV of readings for equipment already in the system. Requires{" "}
            <code className="text-xs">equipment_id</code> and{" "}
            <code className="text-xs">timestamp</code>; every other column is optional
            and unrecognised columns are ignored.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) upload(file);
              }}
            />
            <Button onClick={() => inputRef.current?.click()} disabled={busy}>
              {busy
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing…</>
                : <><FileUp className="mr-2 h-4 w-4" /> Choose CSV</>}
            </Button>

            <a href="/api/sensor-readings/template" download="sensor-template.csv">
              <Button variant="ghost" size="sm" type="button">
                <Download className="mr-2 h-4 w-4" />
                Template
              </Button>
            </a>

            {fileName && !busy && (
              <span className="text-xs text-muted-foreground truncate">{fileName}</span>
            )}
          </div>

          {succeeded && (
            <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
              <div className="text-sm text-green-900">
                <p className="font-medium">{result!.message}</p>
                {(result!.duplicates ?? 0) > 0 && (
                  <p className="text-xs mt-1 text-green-800">
                    Readings already stored for the same equipment and timestamp were
                    skipped, so re-importing a file does not double-count.
                  </p>
                )}
              </div>
            </div>
          )}

          {result && !succeeded && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">{result.message}</p>
                  {errors.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Nothing was imported. Fix these and upload again.
                    </p>
                  )}
                </div>
              </div>

              {errors.length > 0 && (
                <div className="max-h-64 overflow-auto rounded border bg-background">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="text-left font-medium px-2 py-1 w-16">Line</th>
                        <th className="text-left font-medium px-2 py-1">Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {errors.slice(0, ERRORS_SHOWN).map((e, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1 tabular-nums text-muted-foreground">{e.row}</td>
                          <td className="px-2 py-1">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {errors.length > ERRORS_SHOWN && (
                    <p className="text-xs text-muted-foreground px-2 py-1 border-t">
                      and {errors.length - ERRORS_SHOWN} more
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            A file is accepted whole or not at all. Partial imports leave you believing
            you loaded data you did not, and the gap shows up later as a feature that is
            quietly wrong.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
