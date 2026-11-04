/** The upload notice is acknowledged once per user; the answer lives in this browser only. */
const key = (userId: string): string => `hearer.uploadTos.${userId}`;

export function readTosAccepted(userId: string): boolean {
  try {
    return localStorage.getItem(key(userId)) === '1';
  } catch {
    return false;
  }
}

export function writeTosAccepted(userId: string, accepted: boolean): void {
  try {
    if (accepted) localStorage.setItem(key(userId), '1');
    else localStorage.removeItem(key(userId));
  } catch {
    // Storage blocked: the checkbox still works for this page view.
  }
}
