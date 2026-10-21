import { describe, expect, it } from "vitest";
import { canSeeCost } from "./cost";

describe("who may see cost", () => {
  it("an admin may", () => expect(canSeeCost({ role: "BOSS" })).toBe(true));
  it("the shipping director may not", () => expect(canSeeCost({ role: "MANAGER" })).toBe(false));
  it("a packer or a streamer may not", () => expect(canSeeCost({ role: "EMPLOYEE" })).toBe(false));
});
