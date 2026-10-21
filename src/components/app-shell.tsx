"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Boxes,
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
import { DialMark } from "@/components/ui";
import { navRows } from "@/components/nav-rows";
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
  inventory: Boxes,
} as const;

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-0.5">
      {navRows(items, pathname).map(({ item, active, heading }) => {
        const Icon = ICONS[item.icon];
        return (
          <div key={item.href}>
            {heading ? (
              <p className="px-3 pb-1 pt-4 text-xs font-semibold text-dial-muted">{heading}</p>
            ) : null}
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-sm font-medium transition-colors",
                active
                  ? "bg-white/[0.09] text-white"
                  : "text-dial-ink hover:bg-white/[0.05] hover:text-white",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
              {active ? (
                <span
                  className="absolute right-3 h-1.5 w-1.5 rounded-full bg-brass shadow-[0_0_0_3px_rgb(199_154_69/0.2)]"
                  aria-hidden
                />
              ) : null}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

function UserPanel({ name, roleLabel }: { name: string; roleLabel: string }) {
  return (
    <div className="border-t border-white/10 px-3 py-3">
      <div className="mb-2 px-1">
        <p className="truncate text-sm font-medium text-white">{name}</p>
        <p className="text-xs text-dial-muted">{roleLabel}</p>
      </div>
      <form action={logout}>
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-dial-ink transition-colors hover:bg-white/[0.05] hover:text-white"
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
    <div className="min-h-dvh lg:flex lg:bg-dial print:bg-white">
      <header className="sticky top-0 z-30 flex items-center gap-3 bg-dial px-4 py-2.5 lg:hidden no-print">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="rounded-lg p-1.5 text-dial-ink hover:bg-white/[0.06] hover:text-white"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <DialMark />
        <span className="font-bold tracking-[0.01em] text-white">StreamOps</span>
      </header>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden no-print">
          <button
            type="button"
            className="absolute inset-0 bg-dial/40"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-dial shadow-xl">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="flex items-center gap-2.5 font-bold tracking-[0.01em] text-white">
                <DialMark />
                StreamOps
              </span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg p-1.5 text-dial-ink hover:bg-white/[0.06] hover:text-white"
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

      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-dial lg:flex no-print">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <DialMark />
          <span className="font-bold tracking-[0.01em] text-white">StreamOps</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          <NavLinks items={items} />
        </div>
        <UserPanel name={name} roleLabel={roleLabel} />
      </aside>

      <main className="min-w-0 flex-1 bg-canvas px-4 py-6 sm:px-6 lg:mt-2.5 lg:min-h-[calc(100dvh-0.625rem)] lg:rounded-tl-[18px] lg:px-8 lg:py-8 print:m-0 print:rounded-none print:bg-white">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
