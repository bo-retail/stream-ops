"use client";

import { useRouter } from "next/navigation";
import { Input } from "@/components/ui";

export function DayPicker({ date }: { date: string }) {
  const router = useRouter();
  return (
    <Input
      type="date"
      value={date}
      onChange={(e) => e.target.value && router.push(`/inventory/morning?date=${e.target.value}`)}
      className="w-44"
      aria-label="Show day"
    />
  );
}
