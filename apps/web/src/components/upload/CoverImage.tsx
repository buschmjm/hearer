import { Disc3 } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../lib/cx.ts';

/** A cover thumbnail that falls back to a disc icon when the image is missing or blocked. */
export function CoverImage({
  src,
  alt = '',
  className,
  iconClassName = 'size-6',
}: {
  src: string | null;
  alt?: string;
  className?: string;
  iconClassName?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = src !== null && failed !== src;
  return (
    <span
      className={cx(
        'grid shrink-0 place-items-center overflow-hidden bg-surface-2 text-muted',
        className,
      )}
    >
      {show ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="size-full object-cover"
          onError={() => {
            setFailed(src);
          }}
        />
      ) : (
        <Disc3 className={iconClassName} aria-hidden />
      )}
    </span>
  );
}
