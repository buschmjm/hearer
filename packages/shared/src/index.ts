export const APP_NAME = 'Hearer';

/** Public repository URL, used in the MusicBrainz User-Agent and in docs. */
export const REPO_URL = 'https://github.com/buschmjm/hearer';

/**
 * Current application version. release-please rewrites it (the marker comment on its line
 * is how it finds it) together with every package.json version in the release pull request.
 */
export const APP_VERSION = '0.0.0'; // x-release-please-version

/** Build the descriptive User-Agent string required by MusicBrainz. */
export function userAgent(version: string = APP_VERSION): string {
  return `${APP_NAME}/${version} ( ${REPO_URL} )`;
}

export * from './enums.ts';
export * from './permissions.ts';
export * from './settings.ts';
export * from './template.ts';
export * from './dto/auth.ts';
export * from './dto/users.ts';
export * from './dto/mediaserver.ts';
export * from './dto/catalog.ts';
export * from './dto/uploads.ts';
export * from './dto/requests.ts';
export * from './dto/notifications.ts';
export * from './dto/jobs.ts';
