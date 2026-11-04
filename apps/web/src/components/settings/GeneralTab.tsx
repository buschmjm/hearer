import { useAuth } from '../../api/auth.ts';
import { grantableBits } from '../../lib/permissionGroups.ts';
import { Section } from '../controls.tsx';
import { PermissionEditor } from '../PermissionEditor.tsx';
import { DraftGate, DraftNumber, DraftText, SaveBar } from './parts.tsx';
import { useSectionDraft } from './useSectionDraft.ts';

export function GeneralTab() {
  const draft = useSectionDraft('general');
  const { user } = useAuth();
  const permissions = draft.get('defaultPermissions');
  return (
    <DraftGate draft={draft}>
      <div className="space-y-5">
        <Section title="Application" description="How this server presents itself.">
          <DraftText
            draft={draft}
            path="appTitle"
            label="Title"
            hint="Shown in the sidebar, the browser tab and notifications."
          />
          <DraftText
            draft={draft}
            path="applicationUrl"
            label="Application URL"
            type="url"
            placeholder="https://hearer.example.com"
            hint="The public address people use. Needed for links in notifications and for single sign-on redirects."
          />
        </Section>

        <Section
          title="Default permissions"
          description="Given to every new account (including ones created at first sign-in)."
        >
          <PermissionEditor
            name="defaultPermissions"
            groups="basic"
            value={typeof permissions === 'number' ? permissions : 0}
            canGrant={grantableBits(user?.permissions ?? 0)}
            onChange={(next) => {
              draft.set('defaultPermissions', next);
            }}
          />
        </Section>

        <Section
          title="Default quotas"
          description="Per user, over a rolling window. 0 means unlimited. Individual users can be given their own limits."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <DraftNumber
              draft={draft}
              path="defaultRequestQuota.limit"
              label="Requests allowed"
              min={0}
            />
            <DraftNumber
              draft={draft}
              path="defaultRequestQuota.days"
              label="Request window (days)"
              min={1}
            />
            <DraftNumber
              draft={draft}
              path="defaultUploadQuota.mb"
              label="Upload allowance (MB)"
              min={0}
            />
            <DraftNumber
              draft={draft}
              path="defaultUploadQuota.days"
              label="Upload window (days)"
              min={1}
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
