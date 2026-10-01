"use client";

import Image from "next/image";
import { useState } from "react";
import { watchImage } from "@/lib/domain/watch-images";

/**
 * A model's picture, square, or a plain placeholder when there is none.
 *
 * A link that no longer works (Invicta moved the picture) falls back to the
 * placeholder rather than a broken-image icon. Pictures load as they scroll
 * into view, so a long list costs only what is on screen.
 */
export function WatchImage({
  url,
  model,
  size,
  priority = false,
  className = "",
}: {
  url: string | null | undefined;
  model: string;
  size: number;
  priority?: boolean;
  className?: string;
}) {
  const image = watchImage(url);
  // Remembered by address, so a row that is reused for another model is not
  // left showing the previous model's failure.
  const [failed, setFailed] = useState<string | null>(null);
  const box = `shrink-0 rounded-md border border-line bg-white ${className}`;

  if (!image || failed === image.src) {
    return (
      <div
        role="img"
        aria-label={`No picture of ${model}`}
        className={`${box} flex items-center justify-center text-ink-subtle`}
        style={{ width: size, height: size }}
      >
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="12" cy="12" r="5" />
          <path d="M9 7.5 9.5 3h5l.5 4.5M9 16.5l.5 4.5h5l.5-4.5M12 10v2l1.2 1.2" />
        </svg>
      </div>
    );
  }
  return (
    <Image
      src={image.src}
      alt={model}
      width={size}
      height={size}
      unoptimized={!image.resize}
      priority={priority}
      // Invicta, or whoever hosts a pasted link, does not need to know where it was viewed from.
      referrerPolicy="no-referrer"
      onError={() => setFailed(image.src)}
      className={`${box} object-contain`}
      style={{ width: size, height: size }}
    />
  );
}
