import { Section } from '../controls.tsx';
import { DraftGate, DraftNumber, DraftSecret, DraftText, SaveBar } from './parts.tsx';
import { useSectionDraft } from './useSectionDraft.ts';

export function MetadataTab() {
  const draft = useSectionDraft('metadata');
  return (
    <DraftGate draft={draft}>
      <div className="space-y-5">
        <Section
          title="Music catalog"
          description="Where artists, albums and tracks come from. Requests are limited to one per second for MusicBrainz."
        >
          <DraftText
            draft={draft}
            path="musicBrainzBaseUrl"
            label="MusicBrainz API URL"
            type="url"
            hint="Change this only to use a mirror."
          />
          <DraftText
            draft={draft}
            path="coverArtBaseUrl"
            label="Cover Art Archive URL"
            type="url"
          />
        </Section>
        <Section
          title="Audio fingerprinting"
          description="AcoustID identifies uploaded files by sound."
        >
          <DraftSecret
            draft={draft}
            path="acoustIdApiKey"
            label="AcoustID application API key"
            hint="Free at acoustid.org. Without it, uploads are matched by tags only."
          />
          <DraftText draft={draft} path="acoustIdBaseUrl" label="AcoustID API URL" type="url" />
        </Section>
        <Section
          title="Caching"
          description="How long answers stay fresh before they are fetched again."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <DraftNumber
              draft={draft}
              path="cacheTtl.entityDays"
              label="Artists, albums and tracks (days)"
              min={1}
              max={365}
            />
            <DraftNumber
              draft={draft}
              path="cacheTtl.searchDays"
              label="Search results (days)"
              min={1}
              max={365}
            />
          </div>
        </Section>
        <SaveBar
          dirty={draft.dirty}
          saving={draft.saving}
          error={draft.formError}
          onSave={() => void draft.save()}
          onCancel={draft.reset}
        />
      </div>
    </DraftGate>
  );
}
