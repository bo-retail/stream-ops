import type { Metadata } from "next";
import { FileSpreadsheet } from "lucide-react";
import { Alert, Card, CardHeader, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { requireBoss } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { formatMinutes, isDateISO } from "@/lib/domain/dates";
import { formatPeriod, formatPeriodShort, periodFor, recentPeriods } from "@/lib/domain/periods";
import {
  getEntriesInRange,
  materialiseScheduledHours,
  totalsByPerson,
} from "@/lib/server/timeclock";
import { getPayrollPeriod, listRatePeople } from "@/lib/server/payroll";
import { getWeekContext } from "@/lib/server/settings";
import { listAllUsers } from "@/lib/server/team";
import { AddEntryPanel, PersonTotals, Timesheet } from "./timesheet-client";
import type { SheetEntry } from "./timesheet-client";
import { PayTable, PersonRates, RatesPanel } from "./pay-client";

export const metadata: Metadata = { title: "Payroll" };

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  await requireBoss();
  const { today } = await getWeekContext();
  const { from } = await searchParams;

  const period = periodFor(from && isDateISO(from) ? from : today);

  // Print any show hours that have come due since this was last opened. Cheap,
  // idempotent, and the reason no scheduler has to be kept alive to do it.
  await materialiseScheduledHours();

  const [entries, people, payroll, ratePeople, log] = await Promise.all([
    getEntriesInRange({ from: period.start, to: period.end }),
    listAllUsers(),
    getPayrollPeriod(period.start, period.end),
    listRatePeople(),
    // Every change to a timesheet, so an audit does not mean digging in the
    // database. Scoped to time entries: the schedule has its own history.
    prisma.auditLog.findMany({
      where: { entityType: "TimeEntry" },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        id: true,
        action: true,
        summary: true,
        createdAt: true,
        actor: { select: { name: true } },
      },
    }),
  ]);

  const rows: SheetEntry[] = entries.map((e) => ({
    id: e.id,
    userId: e.userId,
    userName: e.userName,
    team: e.team,
    dateISO: e.dateISO,
    startHM: e.startHM,
    endHM: e.endHM,
    minutes: e.paidMinutes,
    clockedMinutes: e.clockedMinutes,
    shiftLabel: e.shift ? e.shift.label + ' ' + e.shift.startHM + '-' + e.shift.endHM : null,
    lateMinutes: e.lateMinutes,
    leftEarlyMinutes: e.leftEarlyMinutes,
    unpaidMinutes: e.unpaidMinutes,
    fromSchedule: e.fromSchedule,
    note: e.note,
    source: e.source,
    edited: e.edited,
    version: e.version,
  }));

  const totals = totalsByPerson(entries);
  const totalMinutes = totals.reduce((m, p) => m + p.minutes, 0);
  const openCount = entries.filter((e) => e.paidMinutes === null).length;
  const correctedCount = entries.filter((e) => e.edited && e.paidMinutes !== null).length;

  const recent = recentPeriods(today, 6);
  const activePeople = people.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name }));

  return (
    <>
      <PageHeader
        title="Payroll"
        description={`${formatPeriod(period)} · hours, what they are worth, and commission`}
        action={
          <a
            href={`/api/timesheets/export?from=${period.start}&to=${period.end}`}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            <FileSpreadsheet className="h-4 w-4" aria-hidden />
            Download payroll
          </a>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {recent.map((p) => (
          <LinkButton
            key={p.start}
            href={`/admin/timesheets?from=${p.start}`}
            size="sm"
            variant={p.start === period.start ? "primary" : "ghost"}
          >
            {formatPeriodShort(p)}
          </LinkButton>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Total pay"
          value={money(payroll.totals.totalCents)}
          sub={`${money(payroll.totals.hourlyPayCents)} hours + ${money(payroll.totals.commissionCents)} commission`}
        />
        <Stat
          label="Total hours"
          value={formatMinutes(totalMinutes)}
          sub={`${entries.length} shift${entries.length === 1 ? "" : "s"} · ${totals.length} people`}
        />
        <Stat
          label="Not clocked out"
          value={openCount}
          tone={openCount > 0 ? "danger" : "ok"}
          sub={openCount > 0 ? "Hours not counted until closed" : "Everything closed"}
        />
        <Stat
          label="Corrected"
          value={correctedCount}
          sub={correctedCount > 0 ? "Edited after recording" : "None edited"}
        />
      </div>

      {openCount > 0 ? (
        <Alert tone="warn" className="mt-4" title={`${openCount} shift${openCount === 1 ? "" : "s"} never clocked out`}>
          Their hours are not in the totals above and will not reach the export. Close them before
          sending anything to payroll.
        </Alert>
      ) : null}

      {payroll.totals.unrated > 0 ? (
        <Alert
          tone="danger"
          className="mt-4"
          title={`${payroll.totals.unrated} ${payroll.totals.unrated === 1 ? "person has" : "people have"} no rate set`}
        >
          They worked, so their pay is being worked out at $0.00 an hour — which reads exactly like
          a real answer. Set their rate below before exporting.
        </Alert>
      ) : null}

      {payroll.unattributed.length > 0 ? (
        <Alert tone="warn" className="mt-4" title="Sales nobody is being paid for">
          {money(payroll.unattributed.reduce((n, s) => n + s.netRevenueCents, 0))} of sales is
          tagged for shows that are not on any published rota, so no commission was worked out on
          it: {payroll.unattributed.map((s) => s.label).join(", ")}. Either the shift tags are
          wrong on those listings, or the shows were never put on a release.
        </Alert>
      ) : null}

      <div className="mt-5 space-y-5">
        <PayTable
          rows={payroll.people.map((p) => ({
            userId: p.userId,
            name: p.name,
            team: p.team,
            position: p.position,
            minutes: p.minutes,
            hourlyRateCents: p.hourlyRateCents,
            hourlyPayCents: p.hourlyPayCents,
            commissionBps: p.commissionBps,
            commissionCents: p.commissionCents,
            totalCents: p.totalCents,
            openShifts: p.openShifts,
            unrated: p.unrated,
            shows: p.shows.map((s) => ({
              label: s.label,
              netRevenueCents: s.netRevenueCents,
              commissionCents: s.commissionCents,
            })),
          }))}
        />

        <div className="grid gap-5 lg:grid-cols-2">
          <RatesPanel
            streamerHourlyCents={payroll.rates.streamerHourlyCents}
            shippingHourlyCents={payroll.rates.shippingHourlyCents}
            commissionBps={payroll.commissionByBusiness.WATCH}
            diamondCommissionBps={payroll.commissionByBusiness.DIAMOND}
          />
          <PersonRates
            people={ratePeople.map((p) => ({
              id: p.id,
              name: p.name,
              position: p.position,
              team: p.team,
              hourlyRateCents: p.hourlyRateCents,
              commissionBps: p.commissionBps,
            }))}
          />
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="order-2 space-y-5 lg:order-1">
          <AddEntryPanel people={activePeople} />
          <Timesheet entries={rows} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          <PersonTotals people={totals} />

          <Card>
            <CardHeader
              title="Change log"
              description="Every correction, addition and removal."
            />
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>What</Th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.id}>
                    <Td className="whitespace-nowrap text-xs text-ink-muted">
                      {entry.createdAt.toLocaleDateString("en-US")}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{entry.actor?.name ?? "System"}</Td>
                    <Td className="text-xs">{entry.summary ?? entry.action}</Td>
                  </tr>
                ))}
                {log.length === 0 ? (
                  <tr>
                    <Td colSpan={3} className="text-sm text-ink-muted">
                      Nothing has been changed yet.
                    </Td>
                  </tr>
                ) : null}
              </tbody>
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
