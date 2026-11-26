"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";

interface ImportResult {
  dryRun: boolean;
  rows: number;
  valid: number;
  willCreateBusinesses: number;
  willLinkBusinesses: number;
  skipped: { line: number; reason: string }[];
  errors: { line: number; message: string; column?: string }[];
  created: { line: number; leadId: string }[];
  error?: string;
}

/** CSV import (admin+): preview with a dry run, then import. Calls POST /api/crm/leads/import. */
export function ImportPanel() {
  const router = useRouter();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/crm/leads/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, dryRun }),
      });
      const json = (await r.json()) as ImportResult;
      if (!r.ok) {
        setError(json.error ?? `Import failed (${r.status})`);
        setResult(null);
      } else {
        setResult(json);
        if (!dryRun) router.refresh();
      }
    } catch {
      setError("Import request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="crm-import">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="import-file">CSV file (max 1,000 rows, 2 MB)</Label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          className="text-sm file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-semibold"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setResult(null);
            setError(null);
            if (!f) return setCsv(null);
            if (f.size > 2_000_000) {
              setCsv(null);
              return setError("CSV is larger than 2 MB");
            }
            setFileName(f.name);
            setCsv(await f.text());
          }}
        />
      </div>
      <p className="text-xs text-slate-500">
        Columns: name, category, phone, email, website, address, city, state, postcode, lat, lon,
        contact_name, contact_role, whatsapp, priority, value_estimate_paise, tags, note,
        lawful_basis_note. Rows match an existing business by phone or name + PIN code; a new
        business needs lat and lon.
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" disabled={!csv || busy} onClick={() => run(true)}>
          Preview (dry run)
        </Button>
        <Button
          type="button"
          disabled={!csv || busy || !result?.dryRun || result.valid === 0}
          onClick={() => run(false)}
          title={!result?.dryRun ? "Preview first" : undefined}
        >
          Import {result?.dryRun ? result.valid : ""} lead
          {result?.dryRun && result.valid === 1 ? "" : "s"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
          {error}
        </p>
      )}
      {result && (
        <div className="rounded-md border border-slate-200 px-3 py-2" role="status">
          <p className="font-semibold text-slate-800">
            {result.dryRun
              ? `Preview of ${fileName}: ${result.valid} of ${result.rows} rows importable`
              : `Imported ${result.created.length} lead${result.created.length === 1 ? "" : "s"}`}
          </p>
          <p className="text-xs text-slate-500">
            {result.willLinkBusinesses} match existing businesses · {result.willCreateBusinesses}{" "}
            new businesses · {result.skipped.length} skipped · {result.errors.length} errors
          </p>
          {(result.errors.length > 0 || result.skipped.length > 0) && (
            <ul className="mt-2 max-h-48 overflow-y-auto text-xs">
              {result.errors.map((e, i) => (
                <li key={`e${i}`} className="text-red-700">
                  Line {e.line}: {e.column ? `${e.column}: ` : ""}
                  {e.message}
                </li>
              ))}
              {result.skipped.map((s, i) => (
                <li key={`s${i}`} className="text-slate-600">
                  Line {s.line}: skipped, {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
