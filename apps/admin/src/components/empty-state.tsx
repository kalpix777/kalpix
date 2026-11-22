import { Icon } from "./icon";

export function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  icon: string;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
      <div className="mb-4 grid h-11 w-11 place-items-center rounded-lg bg-brand-50 text-brand-700">
        <Icon name={icon} className="h-5 w-5" />
      </div>
      <h3 className="font-display text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-slate-500">{body}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}
