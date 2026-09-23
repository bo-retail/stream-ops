# Working on StreamOps

## Nothing is pushed without an independent review

Before telling Samuel a change is ready to push, run a **separate reviewer** over
the diff — a subagent with the code in front of it and no stake in having
written it. Reviewing your own work in the same breath as writing it does not
count: on 2026-09-23 a reviewer found, in code that had already passed
typecheck, lint and the whole suite, a path where putting a box down would send
a watch scan nowhere and ship the parcel short with no record of it.

The routine, every time:

1. Finish the change, and run the checks below.
2. Hand the diff to a reviewer subagent: what the change is for, what it must
   not break, and where to look. Ask for real defects and failure scenarios,
   not style notes.
3. Fix what it finds, or say plainly why not.
4. Tell Samuel what it found and what you did about it, then give the push
   steps.

For something large or risky, `/code-review ultra` runs a deeper multi-agent
review — but he has to start that one himself; suggest it, do not try to run it.

## Checks before a push

```
npx tsc --noEmit
npx next lint --max-warnings=0
npx vitest run
```

Plus whichever `scripts/check-*.mts` covers what was touched. They need a
**development** database, and refuse to run against production:

```
NODE_OPTIONS=--conditions=react-server npx tsx scripts/check-<thing>.mts
```

## How the code goes out

Samuel pushes from GitHub Desktop, signed in as the boss — see the memory note
on deploy accounts. Prepare the commits on `main` so there is one button to
press, tell him which deployment title to watch for in Vercel, and say whether
the floor needs to refresh.

Never handle passwords or connection strings. When a script needs the live
database, give him the commands and let him paste the string into his own
PowerShell window.

## The floor is working while you do this

Shipping scans parcels all day and the shows run most evenings. A change that
touches packing, imports or the schedule lands on people mid-task: say what
they will see, and whether anything must be paused. A deploy changes the server
action ids, so anyone with the page already open must refresh before their next
click.
