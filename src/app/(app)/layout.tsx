import { AppShell } from "@/components/app-shell";
import type { NavItem } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/guards";

const STREAMER_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/availability", label: "My availability", icon: "availability" },
  { href: "/schedule", label: "My schedule", icon: "schedule" },
  { href: "/timeclock", label: "Time clock", icon: "payroll" },
];

// Shipping is never scheduled, so availability and a schedule are not empty for
// them — they are misleading. An availability tab implies somebody is waiting on
// an answer they are not expected to give.
const SHIPPING_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/timeclock", label: "Time clock", icon: "payroll" },
];

const BOSS_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/admin/releases", label: "Releases", icon: "availability" },
  { href: "/admin/requests", label: "Requests", icon: "team" },
  { href: "/admin/schedule", label: "Build schedule", icon: "schedule" },
  { href: "/admin/timesheets", label: "Timesheets", icon: "payroll" },
  { href: "/admin/team", label: "Team", icon: "team" },
  { href: "/admin/activity", label: "Activity log", icon: "analytics" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const isBoss = user.role === "BOSS";
  const isShipping = !isBoss && user.team === "SHIPPING";

  return (
    <AppShell
      items={isBoss ? BOSS_NAV : isShipping ? SHIPPING_NAV : STREAMER_NAV}
      name={user.name}
      roleLabel={isBoss ? "Admin" : isShipping ? "Shipping" : "Streamer"}
    >
      {children}
    </AppShell>
  );
}
