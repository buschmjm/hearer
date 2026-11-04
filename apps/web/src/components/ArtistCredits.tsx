import type { ArtistCredit } from '@hearer/shared';
import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';

/** Artist credit as text with a link on every credited artist that has an id. */
export function ArtistCredits({
  credits,
  fallback,
  linked = true,
}: {
  credits: readonly ArtistCredit[];
  fallback?: string;
  linked?: boolean;
}) {
  if (credits.length === 0) return <>{fallback ?? ''}</>;
  return (
    <>
      {credits.map((credit, index) => (
        <Fragment key={`${credit.mbid ?? credit.name}-${String(index)}`}>
          {linked && credit.mbid ? (
            <Link
              to="/artists/$mbid"
              params={{ mbid: credit.mbid }}
              className="hover:text-fg hover:underline"
            >
              {credit.name}
            </Link>
          ) : (
            credit.name
          )}
          {credit.joinPhrase}
        </Fragment>
      ))}
    </>
  );
}
