import type { UploadConfig } from '@hearer/shared';
import { FolderUp, UploadCloud } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { cx } from '../../lib/cx.ts';
import {
  allowedExtensions,
  collectDroppedFiles,
  extensionOf,
  formatBytes,
  validateFiles,
  type RejectedFile,
} from '../../lib/uploadFiles.ts';
import type { UploadManager } from '../../lib/uploadManager.ts';
import { Alert, Button } from '../ui.tsx';

export interface DropzoneProps {
  config: UploadConfig;
  manager: UploadManager;
  /** A request these files should fulfil, or null. */
  targetRequestId: string | null;
  disabled?: boolean;
  /** Shown when `disabled` (for instance: accept the notice first). */
  disabledHint?: string;
}

/**
 * Drop area plus file and folder pickers. Files are checked against the server's limits first;
 * the ones that pass go to the upload manager as one batch (one drop = one batch id).
 */
export function Dropzone({
  config,
  manager,
  targetRequestId,
  disabled = false,
  disabledHint,
}: DropzoneProps) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const accept = [...allowedExtensions(config)].map((e) => `.${e}`).join(',');

  const take = (files: File[]) => {
    if (files.length === 0) return;
    const { accepted, rejected: bad } = validateFiles(files, config, manager.queuedBytes);
    setRejected(bad);
    if (accepted.length > 0) {
      manager.add(accepted, { targetRequestId });
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (disabled) return;
    const allowed = allowedExtensions(config);
    void collectDroppedFiles(event.dataTransfer, (f) => allowed.has(extensionOf(f.name))).then(
      take,
    );
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (disabled) return;
    if (event.target === folderInput.current) {
      const allowed = allowedExtensions(config);
      take(files.filter((f) => allowed.has(extensionOf(f.name))));
    } else {
      take(files);
    }
  };

  return (
    <div>
      <div
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => {
          setOver(false);
        }}
        onDrop={onDrop}
        className={cx(
          'flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-10 text-center transition-colors',
          over ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
          disabled && 'opacity-60',
        )}
      >
        <span className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          <UploadCloud className="size-6" aria-hidden />
        </span>
        <p className="font-medium">Drop audio files or folders here</p>
        <p className="max-w-md text-sm text-muted">
          {disabled && disabledHint
            ? disabledHint
            : `${[...allowedExtensions(config)].filter((e) => e !== 'aif').join(', ')} up to ${formatBytes(config.maxFileSizeMb * 1024 * 1024)} each. ${
                config.quota.unlimited
                  ? 'No upload quota.'
                  : `${formatBytes(config.quota.remainingBytes ?? 0)} of quota left.`
              }`}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            Choose files
          </Button>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              folderInput.current?.click();
            }}
          >
            <FolderUp className="size-4" aria-hidden />
            Choose a folder
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={accept}
          aria-label="Audio files"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          onChange={onPick}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          aria-label="Audio folder"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          onChange={onPick}
          // Not in React's typings; non-standard but supported by every current browser.
          {...{ webkitdirectory: '' }}
        />
      </div>
      {rejected.length > 0 && (
        <Alert tone="error" className="mt-3">
          <p className="font-medium">
            {rejected.length === 1
              ? '1 file was not added'
              : `${String(rejected.length)} files were not added`}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {rejected.map((r, index) => (
              <li key={`${r.file.name}-${String(index)}`}>
                <span className="font-medium">{r.file.name}</span>: {r.reason}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}
