import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { listAllUsers } from "@/lib/server/team";
import { fieldsToPosition } from "./position";
import { TeamManager } from "./team-manager";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  await requireBoss();
  const users = await listAllUsers();
  const rows = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    position: fieldsToPosition(u.role, u.team),
    isActive: u.isActive,
  }));

  return (
    <>
      <PageHeader
        title="Team"
        description="Who can sign in, and what they can see."
      />
      <TeamManager rows={rows} />
    </>
  );
}
