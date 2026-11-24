import { notFound } from "next/navigation";
import { isBuilt, NAV } from "@/lib/navigation";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/server/session";

export default async function ModulePlaceholder({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const { slug } = await params;
  const item = NAV.find((n) => n.slug === slug && !isBuilt(n));
  if (!item) notFound();
  return (
    <>
      <PageHeader
        title={item.label}
        description={item.description}
        actions={<Badge tone="brand">Phase {item.phase}</Badge>}
      />
      <EmptyState
        icon={item.icon}
        title="Not built yet"
        body={`This module arrives in Phase ${item.phase}. Nothing here is simulated: it stays empty until the real engine and its data exist.`}
      />
    </>
  );
}
