import Link from "next/link";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Audit Logs" };
export const dynamic = "force-dynamic";
const PAGE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requirePermission("audit:read");
  const { q = "", page = "1" } = await searchParams;
  const p = Math.max(1, Number(page) || 1);
  const where = q
    ? {
        OR: [
          { action: { contains: q, mode: "insensitive" as const } },
          { actorLabel: { contains: q, mode: "insensitive" as const } },
          { entityId: { contains: q } },
        ],
      }
    : {};
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE,
      skip: (p - 1) * PAGE,
    }),
    db.auditLog.count({ where }),
  ]);
  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Append-only record of sign-ins and every privileged change. Entries cannot be edited or deleted from the dashboard."
      />
      <form className="mb-4 flex max-w-md gap-2">
        <Input
          name="q"
          defaultValue={q}
          placeholder="Filter by action, user or entity"
          aria-label="Filter audit log"
        />
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState
          icon="ScrollText"
          title="No matching events"
          body="Events appear as people sign in and make changes."
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>When (IST)</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>IP</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</TD>
                  <TD>{r.actorLabel}</TD>
                  <TD>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.action}</code>
                  </TD>
                  <TD className="text-xs text-slate-500">
                    {r.entityType
                      ? `${r.entityType}${r.entityId ? ` · ${r.entityId.slice(0, 12)}` : ""}`
                      : "—"}
                  </TD>
                  <TD className="text-xs text-slate-500">{r.ipAddress ?? "—"}</TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>{total} events</span>
        <div className="flex gap-3">
          {p > 1 && (
            <Link
              className="font-semibold text-brand-700"
              href={`/audit?q=${encodeURIComponent(q)}&page=${p - 1}`}
            >
              Newer
            </Link>
          )}
          {p * PAGE < total && (
            <Link
              className="font-semibold text-brand-700"
              href={`/audit?q=${encodeURIComponent(q)}&page=${p + 1}`}
            >
              Older
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
