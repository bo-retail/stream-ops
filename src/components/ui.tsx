import Link from "next/link";
import { cn } from "@/lib/utils";

/* Shared primitives. Small and local rather than a component library — the app
   needs about eight shapes, and this keeps them all visible in one file. */

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-line bg-surface shadow-[0_1px_2px_rgba(16,19,26,0.04)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-canvas",
  ghost: "text-ink-muted hover:bg-canvas hover:text-ink",
  danger: "bg-danger-600 text-white hover:bg-danger-700",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md") {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return <button className={cn(buttonClass(variant, size), className)} {...props} />;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={cn(buttonClass(variant, size), className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink",
        "placeholder:text-ink-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100",
        "disabled:bg-canvas disabled:text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-10 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink",
        "focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("mb-1.5 block text-sm font-medium text-ink", className)} {...props} />
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
      {error ? <p className="mt-1 text-xs font-medium text-danger-600">{error}</p> : null}
    </div>
  );
}

type Tone = "neutral" | "brand" | "ok" | "warn" | "danger" | "tiktok" | "ebay";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-canvas text-ink-muted ring-line-strong",
  brand: "bg-brand-50 text-brand-700 ring-brand-200",
  ok: "bg-ok-50 text-ok-700 ring-ok-200",
  warn: "bg-warn-50 text-warn-700 ring-warn-200",
  danger: "bg-danger-50 text-danger-700 ring-danger-200",
  tiktok: "bg-slate-900 text-white ring-slate-900",
  ebay: "bg-blue-50 text-blue-700 ring-blue-200",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

const ALERT_TONES: Record<"info" | "ok" | "warn" | "danger", string> = {
  info: "border-brand-200 bg-brand-50 text-brand-700",
  ok: "border-ok-200 bg-ok-50 text-ok-700",
  warn: "border-warn-200 bg-warn-50 text-warn-700",
  danger: "border-danger-200 bg-danger-50 text-danger-700",
};

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "ok" | "warn" | "danger";
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border px-4 py-3 text-sm", ALERT_TONES[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title && "mt-1")}>{children}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-4 py-10 text-center", className)}>
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{children}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p
        className={cn(
          "tabular mt-1 text-2xl font-semibold tracking-tight",
          tone === "ok" && "text-ok-700",
          tone === "warn" && "text-warn-700",
          tone === "danger" && "text-danger-600",
          !tone && "text-ink",
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-ink-muted">{sub}</p> : null}
    </Card>
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="scroll-x">
      <table className={cn("w-full min-w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-line px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-subtle",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("border-b border-line px-3 py-2.5 text-ink", className)} {...props} />
  );
}
