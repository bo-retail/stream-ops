import { redirect } from "next/navigation";
import { INVENTORY_SIMPLE } from "@/lib/domain/features";

/** Switched off while inventory is kept simple — see `INVENTORY_SIMPLE`. Its data stays. */
export default function SwitchedOff({ children }: { children: React.ReactNode }) {
  if (INVENTORY_SIMPLE) redirect("/inventory");
  return children;
}
