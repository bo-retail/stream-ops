import type { Metadata } from "next";
import { Badge, Card, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Activity log" };

/**
 * Everything that has happened, in one place.
 *
 * The individual screens each show the slice of history that belongs to them —
 * timesheet corrections on the timesheet, schedule changes on the schedule. This
 * is the whole thing, for when the question is "what changed, and who did it?"
 * rather than "what happened to this one entry?".
 *
 * Read-only by construction: there is no action anywhere that edits or deletes
 * an audit row, so the log cannot be tidied up after the fact.
 */

const PAGE_SIZE = 100;

/** Which screen a log entry came from, so the list can be filtered. */
const AREAS = {
  all: { label: "Everything", types: null },
  schedule: {
    label: "Schedule",
    types: ["Release", "Show", "Assignment"],
  },
  availability: { label: "Availability", types: ["AvailabilitySubmission"] },
  timesheets: { label: "Timesheets", types: ["TimeEntry"] },
  people: { label: "People", types: ["User"] },
  settings: { label: "Settings", types: ["Settings"] },
  other: { label: "Other", types: ["System", "TimeOff"] },
} as const;

type AreaKey = keyof typeof AREAS;

/** A plain-English name for an entity type, for the badge on each row. */
const TYPE_LABEL: Record<string, string> = {
  Release: "Release",
  AvailabilitySubmission: "Availability",
  Show: "Show",
  Assignment: "Assignment",
  TimeEntry: "Timesheet",
  User: "Person",
  Settings: "Settings",
  TimeOff: "Time off",
  System: "System",
};

function toneFor(action: string): "danger" | "warn" | "ok" | "neutral" {
  if (/DELETE|REMOVE|CLEAR|CANCEL|UNASSIGN/.test(action)) return "danger";
  if (/EDIT|UPDATE|REPLACE|CLOSE|SET_/.test(action)) return "warn";
  if (/CREATE|ASSIGN|PUBLISH|OPEN|ADD|GO_LIVE|REINSTATE/.test(action)) return "ok";
  return "neutral";
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; page?: string }>;
}) {
  await requireBoss();
  const { area: areaParam, page: pageParam } = await searchParams;

  const area: AreaKey = areaParam && areaParam in AREAS ? (areaParam as AreaKey) : "all";
  const page = Math.max(1, Number(pageParam) || 1);
  const types = AREAS[area].types;
  const where = types ? { entityType: { in: [...types] } } : {};

  const [rows, total, counts] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        entityType: true,
        action: true,
        summary: true,
        createdAt: true,
        actor: { select: { name: true } },
      },
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({ by: ["entityType"], _count: { _all: true } }),
  ]);

  const byType = new Map(counts.map((c) => [c.entityType, c._count._all]));
  const countFor = (key: AreaKey) => {
    const t = AREAS[key].types;
    if (!t) return [...byType.values()].reduce((n, v) => n + v, 0);
    return t.reduce((n, type) => n + (byType.get(type) ?? 0), 0);
  };

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showing = rows.length;

  return (
    <>
      <PageHeader
        title="Activity log"
        description="Every change anyone has made, newest first. Nothing here can be edited or deleted."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Entries" value={total.toLocaleString("en-US")} sub={AREAS[area].label} />
        <Stat
          label="Showing"
          value={showing}
          sub={`Page ${page} of ${lastPage}`}
        />
        <Stat
          label="Most recent"
          value={rows[0] ? rows[0].createdAt.toLocaleDateString("en-US") : "—"}
          sub={rows[0] ? rows[0].createdAt.toLocaleTimeString("en-US") : "Nothing logged yet"}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(Object.keys(AREAS) as AreaKey[]).map((key) => (
          <LinkButton
            key={key}
            href={`/admin/activity?area=${key}`}
            size="sm"
            variant={key === area ? "primary" : "ghost"}
          >
            {AREAS[key].label} ({countFor(key)})
          </LinkButton>
        ))}
      </div>

      <Card className="mt-4">
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Area</Th>
              <Th>Who</Th>
              <Th>What</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap text-xs text-ink-muted">
                  {row.createdAt.toLocaleDateString("en-US")}{" "}
                  {row.createdAt.toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Td>
                <Td className="whitespace-nowrap">
                  <Badge tone={toneFor(row.action)}>
                    {TYPE_LABEL[row.entityType] ?? row.entityType}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap text-sm">{row.actor?.name ?? "System"}</Td>
                <Td className="text-sm">{row.summary ?? row.action}</Td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={4} className="text-sm text-ink-muted">
                  Nothing logged in this area yet.
                </Td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>

      {lastPage > 1 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {page > 1 ? (
            <LinkButton
              href={`/admin/activity?area=${area}&page=${page - 1}`}
              size="sm"
              variant="secondary"
            >
              ← Newer
            </LinkButton>
          ) : null}
          {page < lastPage ? (
            <LinkButton
              href={`/admin/activity?area=${area}&page=${page + 1}`}
              size="sm"
              variant="secondary"
            >
              Older →
            </LinkButton>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
