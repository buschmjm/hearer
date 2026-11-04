import { useSyncExternalStore } from 'react';
import { uploadManager, type UploadItem } from '../../lib/uploadManager.ts';

export function useUploadItems(): readonly UploadItem[] {
  return useSyncExternalStore(
    uploadManager.subscribe,
    uploadManager.getSnapshot,
    uploadManager.getSnapshot,
  );
}
