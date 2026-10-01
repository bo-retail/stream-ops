import { describe, expect, it } from "vitest";
import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import nextConfig from "../../../next.config";
import { detailsFromMasterRow, masterChanges } from "./inventory";
import { isImageHost, photoType, pictureFor, storableLink, watchImage } from "./watch-images";

describe("a picture link through a master reload", () => {
  const blank = {
    brand: "", collection: "", series: "", gender: "", description: "", imageUrl: "", ebayShippingProfile: "",
    costCents: null, tpCents: null, msrpCents: null, weightLb: null, lengthIn: null, widthIn: null, heightIn: null,
  };
  const old = "https://trade.invictawatch.com/cdn/media/201905/252660_30023-catalogshot.jpg";
  const fixed = "https://cdn.invictawatch.com/products/main/500x500-p/202601/30023.jpg";

  it("a corrected master replaces a dead link", () => {
    const row = detailsFromMasterRow({ "Invicta Model": "30023", URL: fixed })!;
    expect(masterChanges({ ...blank, imageUrl: old }, row).imageUrl).toBe(fixed);
  });
  it("a master with the link left blank keeps the picture already there", () => {
    const row = detailsFromMasterRow({ "Invicta Model": "30023", URL: "" })!;
    expect(masterChanges({ ...blank, imageUrl: old }, row).imageUrl).toBeUndefined();
  });
  it("the same master loaded twice changes nothing", () => {
    const row = detailsFromMasterRow({ "Invicta Model": "30023", URL: old })!;
    expect(masterChanges({ ...blank, imageUrl: old }, row).imageUrl).toBeUndefined();
  });
  it("a #N/A or a note in the URL column does not wipe out a good picture", () => {
    for (const junk of ["#N/A", "no image", "N/A"]) {
      const row = detailsFromMasterRow({ "Invicta Model": "30023", URL: junk })!;
      expect(row.imageUrl).toBe("");
      expect(masterChanges({ ...blank, imageUrl: old }, row).imageUrl).toBeUndefined();
    }
  });
});

describe("watchImage", () => {
  it("takes the real master's links, each through the resizer", () => {
    for (const url of [
      "https://cdn.invictawatch.com/products/main/500x500-p/202601/49888.jpg?_=1768870875",
      "https://trade.invictawatch.com/cdn/media/202410/477391_47172-catalogshot-jpg.jpg",
      "https://trade.technomarine.com/cdn/media/x.jpg",
      "https://www.technomarine.com/x.jpg",
      "https://www.invictastores.eu/x.jpg",
    ]) {
      expect(watchImage(url)).toEqual({ src: url, resize: true });
    }
  });

  it("trims spaces Excel leaves around a pasted link", () => {
    expect(watchImage("  https://cdn.invictawatch.com/a.jpg \n")?.src).toBe("https://cdn.invictawatch.com/a.jpg");
  });

  it("shows no picture for a blank or a value that is not a link", () => {
    for (const raw of ["", "   ", null, undefined, "#N/A", "N/A", "see website", "49888.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA"]) {
      expect(watchImage(raw)).toBeNull();
    }
  });

  it("still shows a link to another site, at full size, rather than refusing it", () => {
    expect(watchImage("https://example.com/w.jpg")).toEqual({ src: "https://example.com/w.jpg", resize: false });
    expect(watchImage("http://example.com/w.jpg")).toEqual({ src: "http://example.com/w.jpg", resize: false });
  });

  it("asks Invicta for an http link over https, so it is shrunk rather than loaded whole", () => {
    expect(watchImage("http://trade.invictawatch.com/a.jpg")).toEqual({ src: "https://trade.invictawatch.com/a.jpg", resize: true });
  });

  it("does not let a look-alike host through the resizer", () => {
    expect(isImageHost("invictawatch.com.evil.net")).toBe(false);
    expect(isImageHost("notinvictawatch.com")).toBe(false);
    expect(isImageHost("TRADE.InvictaWatch.com")).toBe(true);
  });

  it("decides exactly as Next's resizer does, so a picture is never refused with an error", () => {
    const patterns = nextConfig.images?.remotePatterns ?? [];
    for (const raw of [
      "https://cdn.invictawatch.com/products/main/500x500-p/202601/49888.jpg?_=1768870875",
      "https://trade.invictawatch.com/cdn/media/x.jpg",
      "https://invictawatch.com/x.jpg",
      "https://a.b.invictawatch.com/x.jpg",
      "https://www.technomarine.com/x.jpg",
      "https://www.invictastores.eu/x.jpg",
      "https://TRADE.InvictaWatch.COM/x.jpg",
      "https://trade.invictawatch.com:8443/x.jpg",
      "https://invictawatch.com.evil.net/x.jpg",
      "https://cdn.invictawatch.com./x.jpg",
      "https://example.com/x.jpg",
    ]) {
      const image = watchImage(raw)!;
      expect(image.resize, raw).toBe(hasRemoteMatch([], patterns, new URL(image.src)));
    }
  });
});

describe("which picture a model shows", () => {
  const link = "https://trade.invictawatch.com/a.jpg";
  it("its link when it has no photo", () => {
    expect(pictureFor("49888", link, null)).toBe(link);
    expect(pictureFor("49888", "", null)).toBe("");
  });
  it("its uploaded photo over the link, at an address that changes with each new photo", () => {
    const src = pictureFor("TM-525003", link, new Date(1_000));
    expect(src).toBe("/api/inventory/photo/TM-525003?v=1000");
    expect(watchImage(src)).toEqual({ src, resize: false });
    expect(pictureFor("TM-525003", link, new Date(2_000))).not.toBe(src);
  });
  it("a model number with a slash or a space still makes one safe address", () => {
    expect(pictureFor("A/B 1", "", new Date(5))).toBe("/api/inventory/photo/A%2FB%201?v=5");
  });
});

describe("a link kept as a model's picture", () => {
  it("is a real web address, trimmed", () => {
    expect(storableLink(" https://trade.invictawatch.com/a.jpg ")).toBe("https://trade.invictawatch.com/a.jpg");
  });
  it("is never the app's own photo address, from the master or typed in", () => {
    expect(storableLink("/api/inventory/photo/OTHER?v=1")).toBe("");
    expect(storableLink("/api/inventory/photo/../../x")).toBe("");
    expect(detailsFromMasterRow({ "Invicta Model": "1", URL: "/api/inventory/photo/2" })!.imageUrl).toBe("");
  });
});

describe("what an uploaded file really is", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it("reads JPEG, PNG and WebP from the bytes", () => {
    expect(photoType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(photoType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(photoType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
  });
  it("refuses anything else, whatever it is called: a page, a spreadsheet, an empty file, a WAV", () => {
    expect(photoType(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(photoType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(photoType(bytes())).toBeNull();
    expect(photoType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull();
  });
});
