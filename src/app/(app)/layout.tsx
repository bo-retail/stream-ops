import { AppShell } from "@/components/app-shell";
import type { NavItem } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/guards";
import { fieldsToPosition } from "./admin/team/position";

const STREAMER_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/availability", label: "My availability", icon: "availability" },
  { href: "/schedule", label: "My schedule", icon: "schedule" },
  { href: "/timeclock", label: "Time clock", icon: "payroll" },
];

// A packer sees the box in front of her and nothing else. No day totals, no
// other people's numbers, no upload — those belong to the director.
const PACKER_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/shipping", label: "Packing", icon: "shipping" },
  { href: "/timeclock", label: "Time clock", icon: "payroll" },
];

// Packing sits below the log: she can pack, but it is not what she is here for.
const SHIPPING_DIRECTOR_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/sales-reports", label: "Sales report entry", icon: "reports" },
  { href: "/shipping/log", label: "Shipping log", icon: "analytics" },
  { href: "/shipping", label: "Packing", icon: "shipping" },
  { href: "/timeclock", label: "Time clock", icon: "payroll" },
];

const BOSS_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/admin/releases", label: "Releases", icon: "availability" },
  { href: "/admin/requests", label: "Requests", icon: "team" },
  { href: "/admin/schedule", label: "Build schedule", icon: "schedule" },
  { href: "/sales-reports", label: "Sales report entry", icon: "reports" },
  { href: "/shipping/log", label: "Shipping log", icon: "analytics" },
  { href: "/shipping", label: "Packing", icon: "shipping" },
  { href: "/admin/timesheets", label: "Timesheets", icon: "payroll" },
  { href: "/admin/team", label: "Team", icon: "team" },
  { href: "/admin/activity", label: "Activity log", icon: "analytics" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
];

const NAV: Record<ReturnType<typeof fieldsToPosition>, NavItem[]> = {
  ADMIN: BOSS_NAV,
  SHIPPING_DIRECTOR: SHIPPING_DIRECTOR_NAV,
  SHIPPING: PACKER_NAV,
  STREAMER: STREAMER_NAV,
};

const ROLE_LABEL: Record<ReturnType<typeof fieldsToPosition>, string> = {
  ADMIN: "Admin",
  SHIPPING_DIRECTOR: "Shipping director",
  SHIPPING: "Shipping & packer",
  STREAMER: "Streamer",
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const position = fieldsToPosition(user.role, user.team);

  return (
    <AppShell items={NAV[position]} name={user.name} roleLabel={ROLE_LABEL[position]}>
      {children}
    </AppShell>
  );
}
