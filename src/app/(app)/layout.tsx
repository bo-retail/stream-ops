import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/guards";
import { fieldsToPosition } from "./admin/team/position";
import { NAV } from "./nav";

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
