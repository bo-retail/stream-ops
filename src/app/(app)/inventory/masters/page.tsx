import { redirect } from "next/navigation";

/** Moved to its own admin tab, Invicta master (21 October): the master carries cost. */
export default function MovedMasterUploads() {
  redirect("/admin/master");
}
