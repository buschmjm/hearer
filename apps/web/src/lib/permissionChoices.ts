import { Permission } from '@hearer/shared';

/** Permissions a new user may be given by default (management bits are never defaults). */
export const DEFAULT_PERMISSION_CHOICES = [
  { bit: Permission.REQUEST, label: 'Request songs', hint: 'Ask for individual tracks' },
  { bit: Permission.REQUEST_ALBUM, label: 'Request albums', hint: 'Ask for whole releases' },
  { bit: Permission.REQUEST_ARTIST, label: 'Request artists', hint: 'Ask for an artist catalog' },
  { bit: Permission.UPLOAD, label: 'Upload music', hint: 'Add files they own' },
  {
    bit: Permission.VIEW_ALL_REQUESTS,
    label: 'See everyone’s requests',
    hint: 'Not just their own',
  },
  { bit: Permission.AUTO_APPROVE, label: 'Auto-approve requests', hint: 'Skip the approval queue' },
  {
    bit: Permission.AUTO_APPROVE_UPLOAD,
    label: 'Auto-approve uploads',
    hint: 'Skip the upload review',
  },
] as const;
