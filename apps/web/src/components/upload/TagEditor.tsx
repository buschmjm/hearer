import { cx } from '../../lib/cx.ts';
import { coverUrlFor, type TagDraft, type TagField } from '../../lib/tagDraft.ts';
import { Field } from '../ui.tsx';
import { CoverImage } from './CoverImage.tsx';

export interface TagEditorProps {
  draft: TagDraft;
  onChange: (next: TagDraft) => void;
  errors: Partial<Record<keyof TagDraft, string>>;
  disabled?: boolean;
}

const MB_FIELDS: { key: TagField; label: string }[] = [
  { key: 'mbRecordingId', label: 'Recording id' },
  { key: 'mbTrackId', label: 'Track id (optional)' },
  { key: 'mbReleaseId', label: 'Release id' },
  { key: 'mbReleaseGroupId', label: 'Release group id' },
  { key: 'mbArtistId', label: 'Artist id' },
  { key: 'mbAlbumArtistId', label: 'Album artist id' },
];

export function CoverPreview({ draft }: { draft: TagDraft }) {
  const url = coverUrlFor(draft.coverSource);
  return (
    <div className="flex items-center gap-3" data-testid="cover-preview">
      <CoverImage
        src={url}
        alt="Cover art"
        className="size-24 rounded-lg border border-line"
        iconClassName="size-8"
      />
      <p className="text-xs text-muted">
        {draft.coverSource?.type === 'caa'
          ? 'Front cover from the Cover Art Archive will be embedded.'
          : draft.coverSource?.type === 'embedded'
            ? 'The cover already in the file is kept.'
            : 'No cover will be added.'}
      </p>
    </div>
  );
}

/** All the tags the import will write. Validation messages come from the shared schema. */
export function TagEditor({ draft, onChange, errors, disabled = false }: TagEditorProps) {
  const text = (
    key: TagField,
    label: string,
    extra: { hint?: string; className?: string } = {},
  ) => (
    <Field
      label={label}
      value={draft[key]}
      disabled={disabled}
      error={errors[key]}
      onChange={(event) => {
        onChange({ ...draft, [key]: event.target.value });
      }}
      {...(extra.hint ? { hint: extra.hint } : {})}
      {...(extra.className ? { className: extra.className } : {})}
    />
  );
  const mbError = MB_FIELDS.some(({ key }) => errors[key]);
  return (
    <div className="space-y-4">
      <CoverPreview draft={draft} />
      <div className="grid gap-4 sm:grid-cols-2">
        {text('title', 'Title', { className: 'sm:col-span-2' })}
        {text('artist', 'Artist')}
        {text('albumArtist', 'Album artist')}
        {text('album', 'Album', { className: 'sm:col-span-2' })}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {text('trackNumber', 'Track')}
        {text('trackTotal', 'Of')}
        {text('discNumber', 'Disc')}
        {text('discTotal', 'Of discs')}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {text('date', 'Date', { hint: 'YYYY, YYYY-MM or YYYY-MM-DD' })}
        {text('genre', 'Genre')}
        {text('isrc', 'ISRC')}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.compilation}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...draft, compilation: event.target.checked });
          }}
          className="size-4 accent-[var(--accent)]"
        />
        Part of a compilation
      </label>
      <details open={mbError} className="rounded-lg border border-line px-3 py-2">
        <summary className={cx('cursor-pointer text-sm font-medium', mbError && 'text-danger')}>
          MusicBrainz ids
        </summary>
        <p className="mt-2 text-xs text-muted">
          Pick a match above to fill these. They tie the file to the right recording and release.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {MB_FIELDS.map(({ key, label }) => (
            <div key={key}>{text(key, label)}</div>
          ))}
        </div>
      </details>
    </div>
  );
}
