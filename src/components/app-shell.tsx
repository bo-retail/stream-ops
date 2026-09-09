"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  CalendarRange,
  DollarSign,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageIcon,
  Settings,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { logout } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

const ICONS = {
  dashboard: LayoutDashboard,
  availability: CalendarDays,
  schedule: CalendarRange,
  sales: DollarSign,
  analytics: BarChart3,
  sellers: Users,
  payroll: Wallet,
  team: Users,
  settings: Settings,
  shipping: PackageIcon,
  reports: FileSpreadsheet,
} as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:bg-canvas hover:text-ink",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function UserPanel({ name, roleLabel }: { name: string; roleLabel: string }) {
  return (
    <div className="border-t border-line px-3 py-3">
      <div className="mb-2 px-1">
        <p className="truncate text-sm font-medium text-ink">{name}</p>
        <p className="text-xs text-ink-subtle">{roleLabel}</p>
      </div>
      <form action={logout}>
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-ink"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </form>
    </div>
  );
}

export function AppShell({
  items,
  name,
  roleLabel,
  children,
}: {
  items: NavItem[];
  name: string;
  roleLabel: string;
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer whenever navigation happens, including via the
  // browser's back button.
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="min-h-dvh lg:flex">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 lg:hidden no-print">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="rounded-lg p-1.5 text-ink-muted hover:bg-canvas hover:text-ink"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <span className="font-semibold tracking-tight text-ink">StreamOps</span>
      </header>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden no-print">
          <button
            type="button"
            className="absolute inset-0 bg-ink/30"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface shadow-xl">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="font-semibold tracking-tight text-ink">StreamOps</span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg p-1.5 text-ink-muted hover:bg-canvas"
                aria-label="Close menu"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3">
              <NavLinks items={items} onNavigate={() => setMenuOpen(false)} />
            </div>
            <UserPanel name={name} roleLabel={roleLabel} />
          </div>
        </div>
      ) : null}

      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex no-print">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            S
          </div>
          <span className="font-semibold tracking-tight text-ink">StreamOps</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3">
          <NavLinks items={items} />
        </div>
        <UserPanel name={name} roleLabel={roleLabel} />
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
