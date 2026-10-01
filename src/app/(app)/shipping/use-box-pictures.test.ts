import { describe, expect, it } from "vitest";
import type { PackingBoxView } from "@/lib/server/packing";
import { fetchPictures, pictureKeys } from "./use-box-pictures";

const item = (stockNumber: string, extra: Partial<PackingBoxView["items"][number]> = {}) => ({
  stockNumber,
  expected: 1,
  scanned: 0,
  outstanding: 1,
  placeholder: false,
  pieces: [],
  ...extra,
});
const box = (business: "WATCH" | "DIAMOND", items: PackingBoxView["items"]) => ({ business, items }) as PackingBoxView;

describe("which watches the packing screen asks pictures for", () => {
  it("no box, no pictures", () => {
    expect(pictureKeys(null)).toEqual([]);
  });
  it("each watch in a watch box, once", () => {
    expect(pictureKeys(box("WATCH", [item("49888"), item("TM-525003"), item("49888")]))).toEqual(["49888", "TM-525003"]);
  });
  it("a placeholder line only once its piece is scanned, and then the piece, not the listing", () => {
    const pulls = "#300 - Invicta Random Pulls";
    expect(pictureKeys(box("WATCH", [item(pulls, { placeholder: true })]))).toEqual([]);
    expect(pictureKeys(box("WATCH", [item(pulls, { placeholder: true, pieces: ["48912", "30023"] })]))).toEqual(["48912", "30023"]);
  });
  it("a diamond box asks for nothing, so diamond packing is exactly as before", () => {
    expect(pictureKeys(box("DIAMOND", [item("LGD-1"), item("LGD - As seen on screen", { placeholder: true, pieces: ["D123"] })]))).toEqual([]);
  });
  it("an empty or unrecognised box asks for nothing", () => {
    expect(pictureKeys(box("WATCH", []))).toEqual([]);
  });
});

describe("asking the server for pictures", () => {
  const answer = (status: number, body: string, type = "application/json") =>
    (async () => new Response(body, { status, headers: { "content-type": type } })) as unknown as typeof fetch;

  it("asks for each stock number and returns what came back", async () => {
    let asked = "";
    const get = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ "49888": "https://cdn.invictawatch.com/a.jpg", "A/B 1": "" }));
    }) as unknown as typeof fetch;
    expect(await fetchPictures(["49888", "A/B 1"], get)).toEqual({ "49888": "https://cdn.invictawatch.com/a.jpg", "A/B 1": "" });
    expect(asked).toBe("/api/shipping/pictures?s=49888&s=A%2FB+1");
  });
  it("a server error is a failure to retry, not \"no picture\"", async () => {
    await expect(fetchPictures(["49888"], answer(500, "oops", "text/plain"))).rejects.toThrow();
    await expect(fetchPictures(["49888"], answer(504, ""))).rejects.toThrow();
  });
  it("the login page, after a session ran out, is a failure too", async () => {
    await expect(fetchPictures(["49888"], answer(200, "<!doctype html><title>Sign in</title>", "text/html"))).rejects.toThrow();
  });
  it("a request that never answers gives up rather than waiting all morning", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 10);
    try {
      await expect(fetchPictures(["49888"], hang)).rejects.toThrow();
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  });
});
