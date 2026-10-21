/**
 * Who sells best — fairly.
 *
 * Raw totals cannot answer it. A night TikTok show sells several times what a
 * day eBay show does, so whoever is rota'd on nights "wins" without selling any
 * better. So every show is judged against its own kind: what shows on the same
 * platform, in the same slot, usually make per hour over the same stretch. A
 * show that took $12k where its kind averages $10k is +20%, whoever was on it.
 *
 * Two readings come out of that, side by side:
 *
 *   1. Vs expected — a person's shows added up against what those shows would
 *      normally have made. Easy to explain in one sentence, which matters when
 *      it decides who is promoted. Both people on a show share its result.
 *
 *   2. Partner-adjusted — the partner taken out. Partners rotate, so over many
 *      shows a model can tell "she lifts every show she is on" from "she keeps
 *      being paired with someone who does". The same method as rating a player
 *      who never plays alone (a ridge regression on each show's result).
 *
 * Both are pulled toward average when someone has few shows: four great nights
 * must not outrank forty good ones. Each business is scored on its own, by the
 * caller, because a diamond show and a watch show are different jobs.
 *
 * Pure: the caller loads the shows. Money in cents throughout.
 */

export interface SellerShow {
  id: string;
  platform: string;
  /** "DAY", "NIGHT", or an extra show's name. */
  slot: string;
  dateISO: string;
  /** Scheduled length. A show with no length is left out — nothing to divide by. */
  minutes: number;
  revenueCents: number;
  units: number;
  /**
   * Revenue of the units that have a cost, and what those cost us — from the
   * same costing as the Profitability tab. Absent where there is no cost to be
   * had (diamonds today).
   */
  costedRevenueCents?: number;
  cogsCents?: number;
  /** Who was on it. A show nobody was on still sets what its kind normally makes. */
  people: string[];
}

export type Confidence = "early" | "fair" | "solid";

export interface KindScore {
  kind: string;
  shows: number;
  /** Ratio to expected, minus one: 0.15 is 15% above what that kind usually makes. */
  index: number;
}

export interface SellerScore {
  userId: string;
  shows: number;
  minutes: number;
  revenueCents: number;
  units: number;
  /** What those same shows would normally have made. */
  expectedCents: number;
  /** Straight vs-expected, before the pull toward average. */
  rawIndex: number;
  /** Vs expected, pulled toward average while there are few shows. */
  index: number;
  /** Partner-adjusted, on the same scale as `index`. */
  effect: number;
  confidence: Confidence;
  /** Ranked only from `CONFIDENCE_FAIR` shows: four great nights are not a record. */
  ranked: boolean;
  /**
   * The partner they worked with most, and on what share of their two-person
   * shows. Somebody nearly always with one partner cannot be told apart from
   * that partner by any method, so the page says so.
   */
  mainPartner: { userId: string; share: number } | null;
  /** Vs expected on each kind of show they worked, unpulled. */
  byKind: KindScore[];
  /** Gross profit on their shows' costed sales, shared like revenue. Null with no cost to be had. */
  grossProfitCents: number | null;
  /** Gross margin on their shows, or null with no costed sales. */
  margin: number | null;
  /**
   * Their margin against what the same kinds of show normally make, in
   * percentage points: +3 is three points better. Judged like the rest of the
   * page — a night show against night shows — so being rota'd where margins are
   * fat does not count as selling well.
   */
  marginVsTypical: number | null;
}

export interface Pairing {
  a: string;
  b: string;
  shows: number;
  /** How their shows together did against expected. */
  together: number;
  /**
   * What the two of them normally do apart, from the model fitted without
   * this pair's shows together. Null when either has too few shows without
   * the other to say — then nothing is known about them apart.
   */
  predicted: number | null;
  /** Together minus predicted: positive means they are better as a pair. */
  chemistry: number | null;
  /**
   * Whether the difference is bigger than their nights normally swing by.
   * Live selling is noisy: over a dozen shows a pair with no chemistry at all
   * reads ±20% by chance, so a difference inside two standard errors of their
   * own nights is "no clear difference", not a verdict.
   */
  chemistryClear: boolean;
}

export interface KindBaseline {
  kind: string;
  shows: number;
  perHourCents: number;
}

export interface SellerResult {
  baselines: KindBaseline[];
  sellers: SellerScore[];
  pairings: Pairing[];
  /** Shows that counted: had a length, people on them, and a kind that sells. */
  showsScored: number;
}

export interface SellerOptions {
  /** How many average shows somebody starts with, for the pull toward average. */
  priorShows?: number;
  /** The same pull for the partner-adjusted model. */
  ridge?: number;
  /** One freak show counts as at most this many times expected. */
  cap?: number;
  /** Fewest shows together before a pair is listed. */
  minPairShows?: number;
  /** Fewest shows each must have without the other before "vs their usual" is said. */
  minApartShows?: number;
  /** Fewest shows together before "vs their usual" is said. */
  minTogetherShows?: number;
}

export const CONFIDENCE_FAIR = 10;
export const CONFIDENCE_SOLID = 25;

export function confidenceFor(shows: number): Confidence {
  if (shows >= CONFIDENCE_SOLID) return "solid";
  if (shows >= CONFIDENCE_FAIR) return "fair";
  return "early";
}

/** The kind a show is judged against. Same platform, same slot. */
export function kindOf(show: { platform: string; slot: string }): string {
  return `${show.platform}|${show.slot}`;
}

/**
 * Solves A·x = b for a small symmetric positive-definite A (the model's
 * normal equations — one row per seller, so twenty-odd at most).
 * Gaussian elimination with partial pivoting.
 */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

export function scoreSellers(shows: readonly SellerShow[], opts: SellerOptions = {}): SellerResult {
  const priorShows = opts.priorShows ?? 5;
  // Tuned on simulated rotas (sellers.test.ts): stronger hid most of a real
  // star's lift; this still pulls a handful of shows firmly toward average.
  const ridge = opts.ridge ?? 1;
  const cap = opts.cap ?? 4;
  const minPairShows = opts.minPairShows ?? 3;
  const minApartShows = opts.minApartShows ?? 10;
  const minTogetherShows = opts.minTogetherShows ?? 10;

  const timed = shows.filter((s) => s.minutes > 0);

  // What each kind of show normally makes per hour, pooled: busy shows and
  // quiet ones in proportion, rather than an average of averages.
  const pool = new Map<string, { shows: number; revenue: number; hours: number }>();
  for (const s of timed) {
    const k = kindOf(s);
    const p = pool.get(k) ?? { shows: 0, revenue: 0, hours: 0 };
    p.shows += 1;
    p.revenue += s.revenueCents;
    p.hours += s.minutes / 60;
    pool.set(k, p);
  }
  const rate = new Map([...pool].map(([k, p]) => [k, p.revenue / p.hours]));
  const baselines: KindBaseline[] = [...pool]
    .map(([kind, p]) => ({ kind, shows: p.shows, perHourCents: Math.round(p.revenue / p.hours) }))
    .sort((a, b) => b.perHourCents - a.perHourCents);

  // The shows that say something about somebody. A kind that sold nothing at
  // all has no "normal" to beat.
  const scored = timed
    .map((s) => ({ ...s, people: [...new Set(s.people)], expected: (rate.get(kindOf(s)) ?? 0) * (s.minutes / 60) }))
    .filter((s) => s.people.length > 0 && s.expected > 0);

  /* ---------------------------------------------------- 1. vs expected */

  const per = new Map<
    string,
    { shows: number; minutes: number; revenue: number; units: number; expected: number; kinds: Map<string, { shows: number; revenue: number; expected: number }> }
  >();
  for (const s of scored) {
    for (const id of s.people) {
      const p = per.get(id) ?? { shows: 0, minutes: 0, revenue: 0, units: 0, expected: 0, kinds: new Map() };
      p.shows += 1;
      p.minutes += s.minutes;
      p.revenue += s.revenueCents;
      p.units += s.units;
      p.expected += s.expected;
      const k = kindOf(s);
      const kk = p.kinds.get(k) ?? { shows: 0, revenue: 0, expected: 0 };
      kk.shows += 1;
      kk.revenue += s.revenueCents;
      kk.expected += s.expected;
      p.kinds.set(k, kk);
      per.set(id, p);
    }
  }

  /* --------------------------------------------- 2. partner-adjusted model */

  // Each show's result as a ratio to expected, minus one, capped so a single
  // freak night cannot carry somebody. The show's result is modelled as the
  // average of the people on it — so a show with two people who are each "+20%
  // sellers" is expected at +20%, on the same scale as the first reading.
  // Weighted by expected, so a big show counts for more than a small one, as it
  // does in the first reading.
  const meanExpected = scored.length === 0 ? 1 : scored.reduce((t, s) => t + s.expected, 0) / scored.length;
  const capped = (s: { revenueCents: number; expected: number }) => Math.min(s.revenueCents / s.expected, cap) - 1;
  const fit = (on: typeof scored, lambda: number): Map<string, number> => {
    const ids = [...new Set(on.flatMap((s) => s.people))].sort();
    const at = new Map(ids.map((id, i) => [id, i]));
    const n = ids.length;
    const XtWX = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const XtWy = new Array<number>(n).fill(0);
    for (const s of on) {
      const y = capped(s);
      const w = s.expected / meanExpected;
      const share = 1 / s.people.length;
      for (const a of s.people) {
        const i = at.get(a)!;
        XtWy[i] += w * share * y;
        for (const b of s.people) XtWX[i][at.get(b)!] += w * share * share;
      }
    }
    for (let i = 0; i < n; i++) XtWX[i][i] += lambda;
    const beta = n === 0 ? [] : solve(XtWX, XtWy);
    return new Map(ids.map((id, i) => [id, beta[i]]));
  };
  const effects = fit(scored, ridge);
  const effectOf = (id: string) => effects.get(id) ?? 0;

  const partnersOf = new Map<string, Map<string, number>>();
  for (const s of scored) {
    if (s.people.length !== 2) continue;
    const [a, b] = s.people;
    for (const [me, them] of [[a, b], [b, a]]) {
      const m = partnersOf.get(me) ?? new Map<string, number>();
      m.set(them, (m.get(them) ?? 0) + 1);
      partnersOf.set(me, m);
    }
  }
  const mainPartnerOf = (id: string) => {
    const m = partnersOf.get(id);
    if (!m) return null;
    let best: { userId: string; count: number } | null = null;
    let total = 0;
    for (const [userId, count] of [...m].sort()) {
      total += count;
      if (!best || count > best.count) best = { userId, count };
    }
    return best ? { userId: best.userId, share: best.count / total } : null;
  };

  /*
    Margin, judged like everything else here: each kind of show's normal margin
    is pooled over all its costed sales, and a person's margin is set against
    the normal margin of the shows they worked, weighted by those shows' costed
    sales. Both people on a show share its margin, as they share its revenue.
  */
  const kindMargin = new Map<string, { revenue: number; cogs: number }>();
  for (const s of timed) {
    if (!s.costedRevenueCents) continue;
    const k = kindMargin.get(kindOf(s)) ?? { revenue: 0, cogs: 0 };
    k.revenue += s.costedRevenueCents;
    k.cogs += s.cogsCents ?? 0;
    kindMargin.set(kindOf(s), k);
  }
  const normalMargin = (kind: string) => {
    const k = kindMargin.get(kind);
    return k && k.revenue > 0 ? (k.revenue - k.cogs) / k.revenue : null;
  };
  const marginPer = new Map<string, { revenue: number; cogs: number; typical: number }>();
  for (const s of scored) {
    const normal = normalMargin(kindOf(s));
    if (!s.costedRevenueCents || normal === null) continue;
    for (const id of s.people) {
      const m = marginPer.get(id) ?? { revenue: 0, cogs: 0, typical: 0 };
      m.revenue += s.costedRevenueCents;
      m.cogs += s.cogsCents ?? 0;
      m.typical += normal * s.costedRevenueCents;
      marginPer.set(id, m);
    }
  }
  const marginOf = (id: string) => {
    const m = marginPer.get(id);
    if (!m || m.revenue <= 0) return { grossProfitCents: null, margin: null, marginVsTypical: null };
    const margin = (m.revenue - m.cogs) / m.revenue;
    return { grossProfitCents: m.revenue - m.cogs, margin, marginVsTypical: (margin - m.typical / m.revenue) * 100 };
  };

  const sellers: SellerScore[] = [...per]
    .map(([userId, p]) => {
      const avgExpected = p.expected / p.shows;
      return {
        userId,
        shows: p.shows,
        minutes: p.minutes,
        revenueCents: p.revenue,
        units: p.units,
        expectedCents: Math.round(p.expected),
        rawIndex: p.revenue / p.expected - 1,
        index: (p.revenue + priorShows * avgExpected) / (p.expected + priorShows * avgExpected) - 1,
        effect: effectOf(userId),
        confidence: confidenceFor(p.shows),
        ranked: p.shows >= CONFIDENCE_FAIR,
        mainPartner: mainPartnerOf(userId),
        ...marginOf(userId),
        byKind: [...p.kinds]
          .map(([kind, k]) => ({ kind, shows: k.shows, index: k.revenue / k.expected - 1 }))
          .sort((a, b) => b.shows - a.shows),
      };
    })
    .sort(
      (a, b) =>
        Number(b.ranked) - Number(a.ranked) || b.index - a.index || b.shows - a.shows || a.userId.localeCompare(b.userId),
    );

  /* ---------------------------------------------------------- pairings */

  const pairs = new Map<string, { a: string; b: string; shows: number; revenue: number; expected: number; cappedSum: number; ys: number[] }>();
  for (const s of scored) {
    if (s.people.length !== 2) continue;
    const [a, b] = [...s.people].sort();
    const key = `${a}|${b}`;
    const p = pairs.get(key) ?? { a, b, shows: 0, revenue: 0, expected: 0, cappedSum: 0, ys: [] };
    p.ys.push(capped(s));
    p.shows += 1;
    p.revenue += s.revenueCents;
    p.expected += s.expected;
    p.cappedSum += capped(s) * s.expected;
    pairs.set(key, p);
  }
  /*
    "Better together" is only honest against what each does without the other.
    So the model is fitted again with this pair's shows together left out —
    otherwise it has learnt the pair's result into both people and the
    comparison only measures how much it pulled toward average. And it is only
    said at all when each has enough shows apart to know their usual.
  */
  const pairings: Pairing[] = [...pairs.values()]
    .filter((p) => p.shows >= minPairShows)
    .map((p) => {
      const together = p.revenue / p.expected - 1;
      const apart = scored.filter((s) => !(s.people.includes(p.a) && s.people.includes(p.b)));
      const apartCount = (id: string) => apart.filter((s) => s.people.includes(id)).length;
      if (p.shows < minTogetherShows || apartCount(p.a) < minApartShows || apartCount(p.b) < minApartShows) {
        return { a: p.a, b: p.b, shows: p.shows, together, predicted: null, chemistry: null, chemistryClear: false };
      }
      // Barely pulled: this is a comparison, not a ranking, and the pull would
      // shrink their usual toward average while "together" is not shrunk.
      const without = fit(apart, 0.05);
      const predicted = ((without.get(p.a) ?? 0) + (without.get(p.b) ?? 0)) / 2;
      // Against the same capped figures the model saw, so one freak night does
      // not read as chemistry.
      const togetherCapped = p.cappedSum / p.expected;
      const chemistry = togetherCapped - predicted;
      // Both sides are uncertain: their nights together scatter, and so does
      // what each does apart — more than it looks, because a show tells the
      // model about half a person (two share it), so each usual carries about
      // four times a single night's scatter over their shows apart. Clear means
      // beyond two standard errors of both. Measured on 60 simulated rotas with
      // no chemistry at all: about 1 pair in 100 reads clear by chance.
      const mean = p.ys.reduce((t, y) => t + y, 0) / p.ys.length;
      const sd = Math.sqrt(p.ys.reduce((t, y) => t + (y - mean) ** 2, 0) / (p.ys.length - 1));
      const se = sd * Math.sqrt(1 / p.ys.length + 4 / apartCount(p.a) + 4 / apartCount(p.b));
      const chemistryClear = Math.abs(chemistry) > 2 * se;
      return { a: p.a, b: p.b, shows: p.shows, together, predicted, chemistry, chemistryClear };
    })
    .sort((x, y) => y.together - x.together);

  return { baselines, sellers, pairings, showsScored: scored.length };
}

/** "+14%", "−3%", "0%" — the way every score on the page is written. */
export function formatIndex(index: number): string {
  const pct = Math.round(index * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}

/**
 * Whether a show's sales file is in, from the day's checklist lines.
 *
 * `loaded` holds `platform|slot|date` for each upload, with the slot empty
 * where one file covers the whole platform's day — every eBay file, and TikTok
 * files from before each show had its own line — and `*` for an upload from
 * before the checklist, which named no platform at all. A TikTok show is otherwise
 * only covered by its own line: the day file being in says nothing about the
 * night's. A show whose file is not in has unknown sales, not zero.
 */
export function fileLoadedFor(
  loaded: ReadonlySet<string>,
  show: { platform: string; slot: string; dateISO: string },
): boolean {
  if (loaded.has(`*||${show.dateISO}`) || loaded.has(`${show.platform}||${show.dateISO}`)) return true;
  return show.platform !== "EBAY" && loaded.has(`${show.platform}|${show.slot}|${show.dateISO}`);
}
