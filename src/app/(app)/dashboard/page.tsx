import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/guards";
import { BossDashboard } from "./boss-dashboard";
import { EmployeeDashboard } from "./employee-dashboard";
import { ShippingDashboard } from "./shipping-dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireUser();
  if (user.role === "BOSS") return <BossDashboard />;
  // Shipping gets their own, not the streamer one with the schedule blanked out.
  if (user.team === "SHIPPING") return <ShippingDashboard user={user} />;
  return <EmployeeDashboard user={user} />;
}
