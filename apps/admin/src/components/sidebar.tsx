"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isBuilt, NAV } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

export function Sidebar({ allowed }: { allowed: string[] }) {
  const pathname = usePathname();
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 pb-6">
      {groups.map((g) => (
        <div key={g}>
          <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            {g}
          </p>
          <ul className="flex flex-col gap-0.5">
            {NAV.filter((n) => n.group === g && allowed.includes(n.slug)).map((n) => {
              const href = `/${n.slug}`;
              const active = n.slug === "" ? pathname === "/" : pathname.startsWith(href);
              return (
                <li key={n.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] font-medium transition-colors",
                      active
                        ? "bg-brand-50 text-brand-700"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                    )}
                  >
                    <Icon name={n.icon} className="h-4 w-4 shrink-0" />
                    <span className="truncate">{n.label}</span>
                    {!isBuilt(n) && (
                      <span className="ml-auto text-[10px] font-semibold text-slate-400">
                        P{n.phase}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
