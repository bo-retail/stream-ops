"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Alert, Badge, Button } from "@/components/ui";
import { reopenForPerson } from "../releases/actions";
import type { ReleaseState } from "../releases/actions";

export interface PersonAnswer {
  userId: string;
  name: string;
  submitted: boolean;
  offered: number;
  submittedAt: Date | null;
}

/**
 * Who has answered, and the way back for somebody who needs to change theirs.
 *
 * Reopening keeps their taps and only lifts the "I have finished" mark, so they
 * correct an answer rather than starting from a blank fortnight.
 */
export function AnswerList({
  releaseId,
  people,
  canReopen,
}: {
  releaseId: string;
  people: PersonAnswer[];
  canReopen: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ReleaseState>({});

  function reopen(userId: string) {
    startTransition(async () => {
      const result = await reopenForPerson(releaseId, userId);
      setState(result);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="ok">{state.ok}</Alert> : null}

      <ul className="divide-y divide-line">
        {people.map((person) => (
          <li key={person.userId} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{person.name}</p>
              <p className="text-xs text-ink-subtle">
                {person.submitted
                  ? `${person.offered} show${person.offered === 1 ? "" : "s"} offered`
                  : person.offered > 0
                    ? `started — ${person.offered} tapped so far, not sent`
                    : "nothing yet"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {person.submitted ? (
                <Badge tone="ok">Sent in</Badge>
              ) : (
                <Badge tone="warn">Waiting</Badge>
              )}
              {person.submitted && canReopen ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => reopen(person.userId)}
                  title="Let them change their answer"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Hand back
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
