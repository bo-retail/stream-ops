import type { Metadata } from "next";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { getSettings } from "@/lib/server/settings";
import { DefaultsForm } from "./settings-client";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireBoss();
  const settings = await getSettings();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Almost nothing lives here on purpose."
      />

      <Alert tone="info" className="mb-5" title="Show hours and scheduling rules moved">
        <p>
          They are set on each release now — which days it covers, which shows run, what hours, and
          which rules apply that time. Nothing carries over, because a default that is wrong most
          weeks is worse than no default at all.
        </p>
        <p className="mt-2">
          <LinkButton href="/admin/releases" size="sm" variant="secondary">
            Go to releases
          </LinkButton>
        </p>
      </Alert>

      <DefaultsForm settings={settings} />
    </>
  );
}
