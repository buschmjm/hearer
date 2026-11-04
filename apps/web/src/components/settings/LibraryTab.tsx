import { toast } from '../../lib/toast.ts';
import {
  SAMPLE_ALBUM_TRACK,
  TEMPLATE_VARIABLES,
  renderTemplate,
  validateTemplate,
} from '../../lib/template.ts';
import { Section } from '../controls.tsx';
import { DraftGate, DraftNumber, DraftSwitch, DraftText, SaveBar } from './parts.tsx';
import { useSectionDraft, type SectionDraft } from './useSectionDraft.ts';

const KNOWN_FORMATS = ['flac', 'mp3', 'm4a', 'ogg', 'opus', 'wav', 'aiff'];

function TemplateField({
  draft,
  path,
  label,
  hint,
  previewId,
}: {
  draft: SectionDraft;
  path: string;
  label: string;
  hint?: string;
  previewId: string;
}) {
  const value = typeof draft.get(path) === 'string' ? (draft.get(path) as string) : '';
  return (
    <div>
      <DraftText draft={draft} path={path} label={label} hint={hint} />
      <div
        className="mt-2 rounded-lg border border-dashed border-line px-3 py-2"
        aria-live="polite"
      >
        <p className="text-xs text-muted">Preview</p>
        <p data-testid={previewId} className="font-mono text-sm break-all">
          {renderTemplate(value, SAMPLE_ALBUM_TRACK)}
        </p>
      </div>
    </div>
  );
}

function FormatPicker({ draft }: { draft: SectionDraft }) {
  const raw = draft.get('allowedFormats');
  const selected = Array.isArray(raw) ? raw.map(String) : [];
  const options = [...KNOWN_FORMATS, ...selected.filter((f) => !KNOWN_FORMATS.includes(f))];
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">Allowed formats</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((format) => (
          <label
            key={format}
            className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm has-checked:border-accent"
          >
            <input
              type="checkbox"
              className="size-4 accent-(--accent)"
              checked={selected.includes(format)}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...selected, format]
                  : selected.filter((f) => f !== format);
                draft.set('allowedFormats', next);
              }}
            />
            {format}
          </label>
        ))}
      </div>
      {draft.errors.allowedFormats && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {draft.errors.allowedFormats}
        </p>
      )}
    </fieldset>
  );
}

export function LibraryTab() {
  const library = useSectionDraft('library', { quietSuccess: true });
  const uploads = useSectionDraft('uploads', { quietSuccess: true });
  const threshold = uploads.get('autoApproveThreshold');
  const percent = typeof threshold === 'number' ? Math.round(threshold * 100) : 0;

  const save = async () => {
    const problems: Record<string, string> = {};
    for (const path of ['namingTemplate', 'singlesTemplate']) {
      const value = library.get(path);
      const first = validateTemplate(typeof value === 'string' ? value : '')[0];
      if (first) problems[path] = first;
    }
    if (Object.keys(problems).length > 0) {
      library.addErrors(problems);
      return;
    }
    const libraryOk = !library.dirty || (await library.save());
    const uploadsOk = libraryOk && (!uploads.dirty || (await uploads.save()));
    if (libraryOk && uploadsOk) toast.success('Settings saved.');
  };

  return (
    <DraftGate draft={library}>
      <DraftGate draft={uploads}>
        <div className="space-y-5">
          <Section
            title="Naming"
            description="Where uploaded files are filed under the library folder."
          >
            <TemplateField
              draft={library}
              path="namingTemplate"
              label="Naming template"
              previewId="naming-preview"
            />
            <TemplateField
              draft={library}
              path="singlesTemplate"
              label="Template for singles"
              hint="Used for tracks that match no album."
              previewId="singles-preview"
            />
            <details className="text-xs text-muted">
              <summary className="cursor-pointer text-sm">Template variables</summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                {Object.entries(TEMPLATE_VARIABLES).map(([name, what]) => (
                  <div key={name} className="contents">
                    <dt className="font-mono text-fg">{`{${name}}`}</dt>
                    <dd>{what}</dd>
                  </div>
                ))}
                <dt className="font-mono text-fg">{'{track:02}'}</dt>
                <dd>Zero-padded to 2 digits</dd>
                <dt className="font-mono text-fg">{'{disc:?}'}</dt>
                <dd>Disc number and a dash, only on multi-disc releases</dd>
              </dl>
            </details>
          </Section>

          <Section title="Uploads" description="Limits and approval rules for files people upload.">
            <DraftNumber
              draft={uploads}
              path="maxFileSizeMb"
              label="Maximum file size (MB)"
              min={1}
              hint="Per file. Uploads are sent in small chunks, so proxy body limits are fine."
            />
            <FormatPicker draft={uploads} />
            <div>
              <label htmlFor="threshold" className="mb-1.5 block text-sm font-medium">
                Auto-approve confidence: {percent}%
              </label>
              <input
                id="threshold"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={typeof threshold === 'number' ? threshold : 0}
                className="w-full accent-(--accent)"
                onChange={(e) => {
                  uploads.set('autoApproveThreshold', Number(e.target.value));
                }}
              />
              <p className="mt-1 text-xs text-muted">
                Uploads from users who may auto-approve are imported without review when the match
                is at least this confident.
              </p>
              {uploads.errors.autoApproveThreshold && (
                <p role="alert" className="mt-1.5 text-xs text-danger">
                  {uploads.errors.autoApproveThreshold}
                </p>
              )}
            </div>
            <DraftNumber
              draft={uploads}
              path="coverMaxPx"
              label="Embedded cover size (px)"
              min={100}
              max={10000}
              hint="Longest edge of cover art written into files."
            />
            <DraftSwitch
              draft={uploads}
              path="allowDuplicateOverride"
              label="Let uploaders keep duplicates"
              hint="Off: only upload managers can keep a file that matches something already in the library."
            />
          </Section>

          <SaveBar
            dirty={library.dirty || uploads.dirty}
            saving={library.saving || uploads.saving}
            error={library.formError ?? uploads.formError}
            onSave={() => void save()}
            onCancel={() => {
              library.reset();
              uploads.reset();
            }}
          />
        </div>
      </DraftGate>
    </DraftGate>
  );
}
