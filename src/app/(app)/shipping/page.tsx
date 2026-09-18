import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { requireShipping } from "@/lib/auth/guards";
import { ScanClient } from "./scan-client";

export const metadata: Metadata = { title: "Packing" };

/**
 * The packing screen: scan the label, scan each watch in, close the box.
 *
 * Open to the shipping team, the director and the boss. A streamer has no boxes
 * and is sent back to their dashboard.
 *
 * Nothing is loaded here. The screen holds one box at a time and every box
 * arrives through a scan, so a page that fetched a day's worth of boxes would
 * be loading 220 of them for a packer who will look at one.
 */
export default async function PackingPage() {
  await requireShipping();

  return (
    <>
      <PageHeader
        title="Packing"
        description="Scan a shipping label to open its box, then scan everything in it as it goes in."
      />
      <ScanClient />
    </>
  );
}
