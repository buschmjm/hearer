export const APP_NAME = 'Hearer';

/** Public repository URL, used in the MusicBrainz User-Agent and in docs. */
export const REPO_URL = 'https://github.com/buschmjm/hearer';

/** Current application version. Kept in sync with the root release tag. */
export const APP_VERSION = '0.0.0';

/** Build the descriptive User-Agent string required by MusicBrainz. */
export function userAgent(version: string = APP_VERSION): string {
  return `${APP_NAME}/${version} ( ${REPO_URL} )`;
}

export * from './enums.ts';
export * from './permissions.ts';
export * from './settings.ts';
export * from './dto/auth.ts';
export * from './dto/users.ts';
export * from './dto/mediaserver.ts';
