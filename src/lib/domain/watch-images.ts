/**
 * The watch pictures.
 *
 * A model's picture is either a photo somebody uploaded in the app, or the
 * link from the master file's `URL` column. An uploaded photo always wins, so
 * loading the master again never replaces one.
 *
 * Invicta's pictures live on their own servers and some are several megabytes,
 * so the app shows them through Next's image resizer (a 48-pixel thumbnail is
 * a few kilobytes). The resizer only fetches from hosts listed here — this list
 * is read by `next.config.ts` too, so the two cannot disagree. A link to any
 * other host is still shown, just at full size.
 */
export const IMAGE_HOSTS = ["invictawatch.com", "technomarine.com", "invictastores.eu"] as const;

/** Where the app serves an uploaded photo. Already small, so never resized. */
export const PHOTO_PATH = "/api/inventory/photo/";

/** Whether the resizer may fetch from this host: one of the hosts above, or a subdomain of one. */
export function isImageHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return IMAGE_HOSTS.some((host) => h === host || h.endsWith(`.${host}`));
}

/**
 * The picture to show for a link, or null for none.
 *
 * The column is typed and pasted by hand in Excel, so anything that is not a
 * web address — blank, `#N/A`, "see website" — means no picture rather than a
 * broken one.
 */
export function watchImage(raw: string | null | undefined): { src: string; resize: boolean } | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  if (text.startsWith(PHOTO_PATH)) return { src: text, resize: false };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Invicta serves the same picture over https; asking for it that way lets it
  // be resized instead of loading megabytes into a thumbnail.
  if (url.protocol === "http:" && isImageHost(url.hostname)) url.protocol = "https:";
  return { src: url.href, resize: url.protocol === "https:" && isImageHost(url.hostname) };
}

/**
 * A link that may be stored as a model's picture: a real web address. The
 * app's own photo address is only ever made by {@link pictureFor}, never stored.
 * Anything else becomes "".
 */
export function storableLink(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (text.startsWith("/")) return "";
  return watchImage(text) ? text : "";
}

/** The picture a model shows: its uploaded photo if it has one, otherwise its link. */
export function pictureFor(model: string, imageUrl: string, photoAt: Date | null | undefined): string {
  if (photoAt) return `${PHOTO_PATH}${encodeURIComponent(model)}?v=${photoAt.getTime()}`;
  return imageUrl;
}

/** The largest uploaded photo kept. The page shrinks a phone photo to well under this first. */
export const MAX_PHOTO_BYTES = 1024 * 1024;

/**
 * What kind of picture these bytes are, read from the bytes themselves rather
 * than the file name, or null if they are not a JPEG, PNG or WebP.
 */
export function photoType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  const at = (i: number, ...want: number[]) => want.every((b, j) => bytes[i + j] === b);
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}
