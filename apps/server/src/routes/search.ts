import {
  artistAlbumsQuerySchema,
  artistDetailSchema,
  mbidSchema,
  pageSchema,
  recordingDetailSchema,
  releaseGroupDetailSchema,
  releaseGroupSummarySchema,
  searchQuerySchema,
  searchResponseSchema,
  type SearchResponse,
} from '@hearer/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MetadataError, type RequestOptions } from '../adapters/metadata/types.ts';
import { requireAuth } from '../auth/guard.ts';
import { HttpError, notFound } from '../lib/http-error.ts';

export const SEARCH_RATE_LIMIT_PER_MINUTE = 60;

const mbidParams = z.object({ mbid: mbidSchema });

/** Translate metadata failures into the API error envelope. */
async function guarded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof MetadataError) {
      if (err.kind === 'not_found') throw notFound('Not found in MusicBrainz');
      throw new HttpError(
        502,
        err.kind === 'unavailable' ? 'metadata_unavailable' : 'metadata_bad_response',
        err.kind === 'unavailable'
          ? 'The metadata service is unavailable. Try again shortly.'
          : 'The metadata service returned an unexpected response.',
      );
    }
    throw err;
  }
}

/** An AbortSignal that fires when the client goes away before the response is sent. */
function clientGone(request: FastifyRequest): RequestOptions {
  const controller = new AbortController();
  request.raw.once('close', () => {
    if (!request.raw.complete || request.raw.destroyed) controller.abort();
  });
  return { signal: controller.signal };
}

/**
 * Catalog search and browse (MusicBrainz), for any signed-in user. Every item is annotated with
 * its library and request badges using one batched lookup per response.
 */
export function searchRoutes(options: { rateLimitMax?: number } = {}): FastifyPluginCallbackZod {
  const max = options.rateLimitMax ?? SEARCH_RATE_LIMIT_PER_MINUTE;
  return (app, _options, done) => {
    const { metadata, badges } = app.hearer;
    const base = {
      onRequest: [requireAuth()],
      // Per user, so one busy household member cannot lock out the rest of an IP.
      config: {
        rateLimit: {
          max,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip,
        },
      },
    };

    app.get(
      '/search',
      {
        ...base,
        schema: {
          tags: ['catalog'],
          summary: 'Search artists, albums or tracks',
          querystring: searchQuerySchema,
          response: { 200: searchResponseSchema },
        },
      },
      async (request): Promise<SearchResponse> => {
        const { q, type, offset, limit } = request.query;
        const page = { offset, limit };
        const signal = clientGone(request);
        if (type === 'artist') {
          const result = await guarded(metadata.searchArtists(q, page, signal));
          const lookup = badges.resolve({ artists: result.items.map((i) => i.mbid) });
          return {
            ...result,
            type,
            items: result.items.map((i) => ({ ...i, ...lookup.artist(i.mbid) })),
          };
        }
        if (type === 'album') {
          const result = await guarded(metadata.searchReleaseGroups(q, page, signal));
          const lookup = badges.resolve({ albums: result.items.map((i) => i.mbid) });
          return {
            ...result,
            type,
            items: result.items.map((i) => ({ ...i, ...lookup.album(i.mbid) })),
          };
        }
        const result = await guarded(metadata.searchRecordings(q, page, signal));
        const lookup = badges.resolve({ tracks: result.items.map((i) => i.mbid) });
        return {
          ...result,
          type,
          items: result.items.map((i) => ({ ...i, ...lookup.track(i.mbid) })),
        };
      },
    );

    app.get(
      '/artists/:mbid',
      {
        ...base,
        schema: {
          tags: ['catalog'],
          summary: 'An artist',
          params: mbidParams,
          response: { 200: artistDetailSchema },
        },
      },
      async (request) => {
        const { mbid } = request.params;
        const artist = await guarded(metadata.getArtist(mbid, clientGone(request)));
        return { ...artist, ...badges.resolve({ artists: [mbid] }).artist(mbid) };
      },
    );

    app.get(
      '/artists/:mbid/albums',
      {
        ...base,
        schema: {
          tags: ['catalog'],
          summary: "An artist's release groups, optionally of one primary type",
          params: mbidParams,
          querystring: artistAlbumsQuerySchema,
          response: { 200: pageSchema(releaseGroupSummarySchema) },
        },
      },
      async (request) => {
        const { offset, limit, type } = request.query;
        const result = await guarded(
          metadata.getArtistReleaseGroups(
            request.params.mbid,
            { offset, limit, type },
            clientGone(request),
          ),
        );
        const lookup = badges.resolve({ albums: result.items.map((i) => i.mbid) });
        return { ...result, items: result.items.map((i) => ({ ...i, ...lookup.album(i.mbid) })) };
      },
    );

    app.get(
      '/albums/:mbid',
      {
        ...base,
        schema: {
          tags: ['catalog'],
          summary: 'An album (release group) with the tracklist of a representative release',
          params: mbidParams,
          response: { 200: releaseGroupDetailSchema },
        },
      },
      async (request) => {
        const { mbid } = request.params;
        const album = await guarded(metadata.getReleaseGroup(mbid, clientGone(request)));
        const lookup = badges.resolve({ albums: [mbid], tracks: album.tracks.map((t) => t.mbid) });
        return {
          ...album,
          ...lookup.album(mbid),
          tracks: album.tracks.map((t) => ({ ...t, ...lookup.track(t.mbid) })),
        };
      },
    );

    app.get(
      '/tracks/:mbid',
      {
        ...base,
        schema: {
          tags: ['catalog'],
          summary: 'A track (recording)',
          params: mbidParams,
          response: { 200: recordingDetailSchema },
        },
      },
      async (request) => {
        const { mbid } = request.params;
        const track = await guarded(metadata.getRecording(mbid, clientGone(request)));
        const lookup = badges.resolve({
          tracks: [mbid],
          albums: track.releaseGroups.map((rg) => rg.mbid),
        });
        return {
          ...track,
          ...lookup.track(mbid),
          releaseGroups: track.releaseGroups.map((rg) => ({ ...rg, ...lookup.album(rg.mbid) })),
        };
      },
    );

    done();
  };
}
