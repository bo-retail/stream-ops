"use client";

import { useEffect, useRef, useState } from "react";
import type { PackingBoxView } from "@/lib/server/packing";

/** The stock numbers in a box that can have a picture: real lines, and the pieces scanned for placeholder lines. */
export function pictureKeys(box: PackingBoxView | null): string[] {
  if (!box || box.business !== "WATCH") return [];
  return [...new Set(box.items.flatMap((i) => (i.placeholder ? i.pieces : [i.stockNumber, ...i.pieces])))];
}

/** How long to wait for pictures before trying again with the next box. */
const PICTURES_TIMEOUT_MS = 10_000;

/**
 * Ask the server for these watches' pictures. Throws on anything but a proper
 * answer — a server error, a login page after a session ran out, a hang — so
 * the caller tries again later instead of remembering "no picture".
 */
export async function fetchPictures(list: string[], get: typeof fetch = fetch): Promise<Record<string, string>> {
  const query = new URLSearchParams(list.map((s) => ["s", s]));
  const r = await get(`/api/shipping/pictures?${query}`, { signal: AbortSignal.timeout(PICTURES_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`pictures: ${r.status}`);
  return (await r.json()) as Record<string, string>;
}

/**
 * The pictures of the watches in the open box, fetched beside the scans and
 * never in their way.
 *
 * Each stock number is asked for once and remembered for the session, so a
 * morning of boxes costs one small request per box with something new in it.
 * A request that fails is simply tried again with the next box; until then the
 * screen shows no picture, and packing carries on exactly as before.
 */
export function useBoxPictures(box: PackingBoxView | null): Map<string, string> {
  const known = useRef(new Map<string, string>());
  const asking = useRef(new Set<string>());
  const [, setVersion] = useState(0);

  const keys = pictureKeys(box);
  const missing = keys.filter((k) => !known.current.has(k) && !asking.current.has(k));
  const wanted = missing.join("\n");

  useEffect(() => {
    if (wanted === "") return;
    const list = wanted.split("\n");
    for (const k of list) asking.current.add(k);
    fetchPictures(list)
      .then((found) => {
        for (const k of list) known.current.set(k, found[k] ?? "");
        setVersion((v) => v + 1);
      })
      .catch(() => {
        // No pictures this time; they are asked for again with the next box.
        // Nothing else depends on them.
      })
      .finally(() => {
        for (const k of list) asking.current.delete(k);
      });
  }, [wanted]);

  return known.current;
}
