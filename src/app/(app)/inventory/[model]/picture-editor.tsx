"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { MAX_PHOTO_BYTES } from "@/lib/domain/watch-images";
import { deletePhoto, savePictureLink, uploadPhoto } from "../actions";
import type { PictureState } from "../actions";

/** The longest side of a saved photo, in pixels: sharp on the model page, small to store. */
const LONGEST_SIDE = 800;

/**
 * The photo, read so it can be drawn. Newer browsers read it already shrunk
 * (a 48-megapixel photo read whole can run a phone out of memory) and the
 * right way up; older ones that do not know those options fall back, step by
 * step, to a plain picture element, which browsers also turn upright.
 */
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  const attempts: (ImageBitmapOptions | undefined)[] = [
    { imageOrientation: "from-image", resizeWidth: LONGEST_SIDE * 2, resizeQuality: "high" },
    { imageOrientation: "from-image" },
    undefined,
  ];
  if (typeof createImageBitmap === "function") {
    for (const options of attempts) {
      try {
        const bitmap = await createImageBitmap(file, options);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
      } catch {
        // Not known to this browser; try the next, plainer way.
      }
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** A phone photo, shrunk to a JPEG of a few dozen kilobytes before it is sent. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await decode(file);
  const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  // White behind a see-through PNG, rather than black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap.source, 0, 0, canvas.width, canvas.height);
  bitmap.done();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= MAX_PHOTO_BYTES) return blob;
  }
  throw new Error("too big");
}

/**
 * Change a model's picture: take or choose a photo, take it away again, or set
 * the link. An uploaded photo is shown instead of the link.
 */
export function PictureEditor({ model, hasPhoto, imageUrl }: { model: string; hasPhoto: boolean; imageUrl: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState(imageUrl);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function run(work: () => Promise<PictureState>) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await work();
      setMessage(r.error ? { tone: "danger", text: r.error } : { tone: "ok", text: r.ok ?? "Saved." });
      if (!r.error) router.refresh();
    } catch {
      setMessage({ tone: "danger", text: "That did not save. Check the connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || busy) return;
    // Busy from the start, so a second photo cannot be chosen while this one shrinks.
    await run(async () => {
      let small: Blob;
      try {
        small = await shrink(file);
      } catch {
        return { error: "That photo could not be read. Take it with the camera, or save it as a JPEG first." };
      }
      const form = new FormData();
      form.set("photo", small, `${model}.jpg`);
      return uploadPhoto(model, form);
    });
  }

  return (
    <div className="space-y-3 border-b border-line p-4 text-sm">
      <div className="flex flex-wrap gap-2">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} aria-label={`Photo of ${model}`} />
        <Button type="button" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Saving…" : hasPhoto ? "Replace photo" : "Take or choose a photo"}
        </Button>
        {hasPhoto ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Remove the photo of ${model}? It goes back to the picture from the master file.`)) {
                void run(() => deletePhoto(model));
              }
            }}
          >
            Remove photo
          </Button>
        ) : null}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => savePictureLink(model, link));
        }}
      >
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Or paste a picture link (https://…)"
          aria-label="Picture link"
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={busy || link.trim() === imageUrl.trim()}>
          Save link
        </Button>
      </form>
      {hasPhoto ? <p className="text-xs text-ink-subtle">The photo is shown instead of the link.</p> : null}
      {message ? (
        <p className={`font-medium ${message.tone === "ok" ? "text-ok-700" : "text-danger-600"}`}>{message.text}</p>
      ) : null}
    </div>
  );
}
