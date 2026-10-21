/**
 * Who sees which pages in the menu.
 *
 * Its own module so the page walk-through (`scripts/check-pages.mts`) opens
 * exactly what each position's menu shows, rather than a copy of it.
 */
import type { NavItem } from "@/components/app-shell";
import type { Position } from "./admin/team/position";

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
  { href: "/inventory", label: "Inventory", icon: "inventory" },
  { href: "/timeclock", label: "Time clock", icon: "payroll" },
];

const BOSS_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/admin/releases", label: "Releases", icon: "availability" },
  { href: "/admin/requests", label: "Requests", icon: "team" },
  { href: "/admin/schedule", label: "Build schedule", icon: "schedule" },
  { href: "/insights", label: "Sales insights", icon: "sales" },
  { href: "/seller-insights", label: "Seller insights", icon: "sellers" },
  { href: "/profitability", label: "Profitability", icon: "sales" },
  { href: "/sales-reports", label: "Sales report entry", icon: "reports" },
  { href: "/shipping/log", label: "Shipping log", icon: "analytics" },
  { href: "/shipping", label: "Packing", icon: "shipping" },
  { href: "/inventory", label: "Inventory", icon: "inventory" },
  { href: "/admin/master", label: "Invicta master", icon: "reports" },
  { href: "/admin/timesheets", label: "Payroll", icon: "payroll" },
  { href: "/admin/team", label: "Team", icon: "team" },
  { href: "/admin/activity", label: "Activity log", icon: "analytics" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
];

export const NAV: Record<Position, NavItem[]> = {
  ADMIN: BOSS_NAV,
  SHIPPING_DIRECTOR: SHIPPING_DIRECTOR_NAV,
  SHIPPING: PACKER_NAV,
  STREAMER: STREAMER_NAV,
};
