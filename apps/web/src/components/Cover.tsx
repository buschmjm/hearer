import { Disc3, Mic2, Music2 } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../lib/cx.ts';

export type CoverKind = 'artist' | 'album' | 'track';

const ICONS = { artist: Mic2, album: Disc3, track: Music2 } as const;

interface CoverProps {
  src: string | null | undefined;
  /** Accessible name. Decorative covers (next to the title) pass an empty string. */
  alt: string;
  kind: CoverKind;
  className?: string;
}

/**
 * Cover Art Archive art with a graceful fallback: many releases have none (404), so a failed
 * load swaps in a placeholder instead of a broken-image icon. Sizing comes from `className`.
 */
export function Cover({ src, alt, kind, className }: CoverProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const Icon = ICONS[kind];
  const failed = !src || failedSrc === src;
  return (
    <div
      className={cx(
        'relative aspect-square shrink-0 overflow-hidden bg-surface-2',
        kind === 'artist' ? 'rounded-full' : 'rounded-lg',
        className,
      )}
    >
      {failed ? (
        <div
          data-testid="cover-fallback"
          role={alt ? 'img' : undefined}
          aria-label={alt || undefined}
          className="grid size-full place-items-center bg-linear-to-br from-accent-soft to-surface-2 text-muted"
        >
          <Icon className="size-1/3" aria-hidden />
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => {
            setFailedSrc(src);
          }}
          className="size-full object-cover"
        />
      )}
    </div>
  );
}
