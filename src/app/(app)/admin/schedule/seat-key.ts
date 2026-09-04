/**
 * Identifies one seat on one show: `showId|1` or `showId|2`.
 *
 * Deliberately in its own module rather than in the builder. The page computes
 * candidate lists on the server and the builder reads them on the client, so
 * both sides need this key — and a function exported from a `"use client"` file
 * cannot be called from the server.
 */
export const seatKey = (showId: string, seat: number) => `${showId}|${seat}`;
