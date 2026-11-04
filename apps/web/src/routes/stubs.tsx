import { ComingSoon } from '../components/ComingSoon.tsx';

// Route stubs. Each later batch replaces its component in router.tsx with the real page.

/** H-17 builds the search page (results, artist/album pages, request flow). */
export function SearchPage() {
  return (
    <ComingSoon title="Search">
      Search results and the request flow arrive in the next update.
    </ComingSoon>
  );
}

/** H-18: request queue and "my requests". */
export function RequestsPage() {
  return <ComingSoon title="Requests" />;
}

/** H-19: upload dropzone and review. */
export function UploadPage() {
  return <ComingSoon title="Upload" />;
}
