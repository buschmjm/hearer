import { ComingSoon } from '../components/ComingSoon.tsx';

// Route stubs. Each later batch replaces its component in router.tsx with the real page.

/** H-19: upload dropzone and review. */
export function UploadPage() {
  return <ComingSoon title="Upload" />;
}

/** H-20: settings, users and jobs. */
export function AdminPage() {
  return <ComingSoon title="Admin" />;
}

/** H-20: profile and password. */
export function AccountPage() {
  return <ComingSoon title="Profile" />;
}

/** H-20: personal API keys. */
export function ApiKeysPage() {
  return <ComingSoon title="API keys" />;
}
