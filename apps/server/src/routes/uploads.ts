import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  MAX_UPLOAD_CHUNK_BYTES,
  Permission,
  TUS_PATH,
  uploadConfigSchema,
  uploadDetailSchema,
  uploadDtoSchema,
  uploadIdParamsSchema,
  uploadListQuerySchema,
  uploadListResponseSchema,
} from '@hearer/shared';
import { FileStore } from '@tus/file-store';
import { EVENTS, Server as TusServer } from '@tus/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { hasPermission } from '../auth/permissions.ts';
import { requirePermission } from '../auth/guard.ts';
import { UPLOAD_PROBE_JOB } from '../jobs/uploadProbe.ts';
import { HttpError, forbidden, notFound, unauthorized } from '../lib/http-error.ts';
import { UploadRejection } from '../services/uploads.ts';
import type { AuthUser } from '../services/users.ts';

/** The authenticated caller; the route guards make a missing user unreachable. */
const userOf = (request: FastifyRequest): AuthUser => {
  if (!request.user) throw unauthorized();
  return request.user;
};

/** Header carrying the Hearer upload id on the response that completes a tus upload. */
export const UPLOAD_ID_HEADER = 'x-hearer-upload-id';

const TUS_METHODS = ['POST', 'HEAD', 'PATCH', 'DELETE', 'OPTIONS'] as const;
/** Fastify's own body limit never applies to a stream, but keep it above one chunk regardless. */
const TUS_BODY_LIMIT = MAX_UPLOAD_CHUNK_BYTES + 1024 * 1024;

/** What tus expects thrown from its hooks: a status and a text body (ours is the JSON envelope). */
class TusError extends Error {
  readonly status_code: number;
  readonly body: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TusError';
    this.status_code = status;
    this.body = JSON.stringify({ error: { code, message } });
  }
}
const tusError = (status: number, code: string, message: string): TusError =>
  new TusError(status, code, message);
const asTusError = (err: unknown): unknown =>
  err instanceof UploadRejection ? tusError(err.statusCode, err.code, err.message) : err;

/** The tus request object is a web Request; Node's raw request hangs off `runtime.node`. */
interface TusRequest {
  method: string;
  runtime?: { node?: { req: object } | undefined } | undefined;
}

/**
 * Upload routes. The tus endpoint (`/uploads/tus`) hands raw Node requests to `@tus/server`;
 * everything else is plain JSON. Every route requires an authenticated user with UPLOAD (or, for
 * the management views, MANAGE_UPLOADS).
 */
export const uploadRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { uploads: service, jobs } = app.hearer;

  /** Who made each in-flight tus request, set by the Fastify handler after authentication. */
  const callers = new WeakMap<object, AuthUser>();
  const callerOf = (req: TusRequest): AuthUser => {
    const raw = req.runtime?.node?.req;
    const user = raw ? callers.get(raw) : undefined;
    if (!user) throw tusError(401, 'unauthorized', 'Authentication required');
    return user;
  };

  const createTus = (): TusServer => {
    // FileStore creates its directory in the background; do it first, and only when tus is used.
    mkdirSync(service.tmpDir, { recursive: true });
    const server = new TusServer({
      path: TUS_PATH,
      datastore: new FileStore({ directory: service.tmpDir }),
      // Uploads are same-origin (cookie or API key); no cross-origin access is granted.
      allowedOrigins: [],
      relativeLocation: true,
      maxSize: () => service.maxFileSizeBytes,
      namingFunction: () => randomUUID(),
      // Runs for HEAD, PATCH, DELETE (and POST with a not-yet-existing id): only the owner may touch an upload.
      onIncomingRequest: (req, id) => {
        const user = callerOf(req);
        if (req.method === 'POST') return Promise.resolve();
        const row = service.getByTusId(id);
        // 404 rather than 403: do not reveal that someone else's upload exists.
        if (row?.uploaderId !== user.id) throw tusError(404, 'not_found', 'Upload not found');
        if (req.method !== 'HEAD' && row.status !== 'RECEIVING') {
          throw tusError(404, 'not_found', 'Upload is no longer receiving data');
        }
        return Promise.resolve();
      },
      onUploadCreate: (req, upload) => {
        const user = callerOf(req);
        try {
          const metadata = service.parseMetadata(upload.metadata);
          service.createReceiving({ user, tusId: upload.id, size: upload.size, metadata });
          return Promise.resolve({
            metadata: {
              ...upload.metadata,
              filename: metadata.filename,
              ownerId: user.id,
              ...(metadata.batchId ? { batchId: metadata.batchId } : {}),
            },
          });
        } catch (err) {
          throw asTusError(err);
        }
      },
      onUploadFinish: (_req, upload) => {
        const row = service.markReceived(upload.id);
        if (!row) throw tusError(404, 'not_found', 'Upload was cancelled');
        jobs.enqueue(UPLOAD_PROBE_JOB, { uploadId: row.id }, { uniqueKey: `probe:${row.id}` });
        return Promise.resolve({ headers: { [UPLOAD_ID_HEADER]: row.id } });
      },
    });
    // A client-side DELETE (tus termination) removed the files already; record the cancellation.
    server.on(EVENTS.POST_TERMINATE, (_req, _res, id) => {
      const row = service.getByTusId(id);
      if (!row) return;
      service.cancel(row.id).catch((err: unknown) => {
        app.log.error({ err }, 'cancelling a terminated upload failed');
      });
    });
    return server;
  };
  let tusServer: TusServer | undefined;
  const tus = (): TusServer => (tusServer ??= createTus());

  // The body of a tus PATCH is a stream for @tus/server to consume: leave it unparsed.
  app.addContentTypeParser('application/offset+octet-stream', (_request, _payload, finish) => {
    finish(null);
  });

  /**
   * Chunk limit (DECISIONS rule 2). A body must announce its length, and it must be at most
   * 50 MiB; Node's HTTP parser then guarantees no more bytes are read than announced. The
   * connection is closed after refusing, so an oversized body is not drained.
   */
  const enforceChunkLimit = (request: FastifyRequest, reply: FastifyReply): void => {
    const hasBody =
      request.method === 'PATCH' ||
      (request.method === 'POST' &&
        request.headers['content-type']?.startsWith('application/offset+octet-stream') === true);
    if (!hasBody) return;
    const refuse = (error: HttpError): never => {
      void reply.header('connection', 'close');
      reply.raw.once('finish', () => {
        setImmediate(() => {
          request.raw.destroy();
        });
      });
      throw error;
    };
    const length = request.headers['content-length'];
    if (length === undefined) {
      refuse(
        new HttpError(
          411,
          'length_required',
          'Send Content-Length with every chunk (chunked transfer encoding is not accepted)',
        ),
      );
      return;
    }
    if (!/^\d{1,15}$/u.test(length)) {
      refuse(new HttpError(400, 'bad_request', 'Invalid Content-Length'));
      return;
    }
    if (Number(length) > MAX_UPLOAD_CHUNK_BYTES) {
      refuse(
        new HttpError(
          413,
          'chunk_too_large',
          `Chunks may be at most ${String(MAX_UPLOAD_CHUNK_BYTES)} bytes (50 MiB); lower the client's chunkSize`,
        ),
      );
    }
  };

  const tusHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // The auth hook guarantees a user here; the guard below is for the type.
    if (!request.user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    enforceChunkLimit(request, reply);
    callers.set(request.raw, request.user);
    void reply.hijack();
    try {
      await tus().handle(request.raw, reply.raw);
    } catch (err) {
      request.log.error({ err }, 'tus request failed');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end();
      } else {
        reply.raw.destroy();
      }
    }
  };

  const mayUpload = requirePermission(Permission.UPLOAD);
  const mayView = requirePermission([Permission.UPLOAD, Permission.MANAGE_UPLOADS], {
    type: 'or',
  });
  for (const url of ['/uploads/tus', '/uploads/tus/*']) {
    app.route({
      method: [...TUS_METHODS],
      url,
      bodyLimit: TUS_BODY_LIMIT,
      onRequest: [mayUpload],
      schema: { hide: true },
      handler: tusHandler,
    });
  }

  // --- JSON API ---------------------------------------------------------------------------

  const canManage = (user: AuthUser): boolean =>
    hasPermission(user.permissions, Permission.MANAGE_UPLOADS);

  app.get(
    '/uploads/config',
    {
      onRequest: [mayUpload],
      schema: {
        tags: ['uploads'],
        summary: 'Upload limits and the caller quota',
        response: { 200: uploadConfigSchema },
      },
    },
    (request) => service.config(userOf(request)),
  );

  app.get(
    '/uploads',
    {
      onRequest: [mayView],
      schema: {
        tags: ['uploads'],
        summary: 'List uploads (own; all with ?all=1 and MANAGE_UPLOADS)',
        querystring: uploadListQuerySchema,
        response: { 200: uploadListResponseSchema },
      },
    },
    (request) => {
      const user = userOf(request);
      if (request.query.all === true && !canManage(user)) throw forbidden();
      if (request.query.all !== true && !hasPermission(user.permissions, Permission.UPLOAD)) {
        // MANAGE_UPLOADS alone may only use the ?all view.
        throw forbidden();
      }
      return service.list(user, request.query);
    },
  );

  /** The upload when the caller owns it or manages uploads; 404 otherwise (no existence leak). */
  const visible = (user: AuthUser, id: string) => {
    const dto = service.getDto(id);
    if (!dto || (dto.uploaderId !== user.id && !canManage(user)))
      throw notFound('Upload not found');
    return dto;
  };

  app.get(
    '/uploads/:id',
    {
      onRequest: [mayView],
      schema: {
        tags: ['uploads'],
        summary: 'One upload, with its match candidates, proposed tags and album group',
        params: uploadIdParamsSchema,
        response: { 200: uploadDetailSchema },
      },
    },
    (request) => app.hearer.uploadReview.detail(userOf(request), request.params.id),
  );

  app.delete(
    '/uploads/:id',
    {
      onRequest: [mayView],
      schema: {
        tags: ['uploads'],
        summary: 'Cancel an upload that has not been imported yet',
        params: uploadIdParamsSchema,
        response: { 200: uploadDtoSchema },
      },
    },
    async (request) => {
      visible(userOf(request), request.params.id);
      const cancelled = await service.cancel(request.params.id);
      if (!cancelled) {
        throw new HttpError(409, 'not_cancellable', 'This upload can no longer be cancelled');
      }
      return visible(userOf(request), request.params.id);
    },
  );

  done();
};
