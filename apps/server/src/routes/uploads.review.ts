import {
  Permission,
  batchApproveResponseSchema,
  batchIdParamsSchema,
  keepBodySchema,
  rejectBodySchema,
  reviewBodySchema,
  uploadDetailSchema,
  uploadIdParamsSchema,
} from '@hearer/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { requirePermission } from '../auth/guard.ts';
import { unauthorized } from '../lib/http-error.ts';
import type { AuthUser } from '../services/users.ts';

const userOf = (request: FastifyRequest): AuthUser => {
  if (!request.user) throw unauthorized();
  return request.user;
};

/**
 * Review of analysed uploads (H-14): edit the proposed tags, approve, reject, keep a duplicate,
 * re-run the analysis, approve a whole album. Every route needs UPLOAD or MANAGE_UPLOADS to get
 * in; the service then applies the finer rules (owner vs manager, AUTO_APPROVE_UPLOAD, the
 * duplicate-override setting) and answers 404 for uploads the caller may not see.
 */
export const uploadReviewRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { uploadReview: review } = app.hearer;
  const guard = requirePermission([Permission.UPLOAD, Permission.MANAGE_UPLOADS], {
    type: 'or',
  });
  const tags = ['uploads'];

  app.put(
    '/uploads/:id/review',
    {
      onRequest: [guard],
      schema: {
        tags,
        summary: 'Store the reviewed tags (and the request to fulfil)',
        params: uploadIdParamsSchema,
        body: reviewBodySchema,
        response: { 200: uploadDetailSchema },
      },
    },
    (request) => review.review(userOf(request), request.params.id, request.body),
  );

  app.post(
    '/uploads/:id/approve',
    {
      onRequest: [guard],
      schema: {
        tags,
        summary: 'Approve an upload for import',
        params: uploadIdParamsSchema,
        response: { 200: uploadDetailSchema },
      },
    },
    (request) => review.approve(userOf(request), request.params.id),
  );

  app.post(
    '/uploads/:id/reject',
    {
      onRequest: [guard],
      schema: {
        tags,
        summary: 'Reject an upload and delete its staged file',
        params: uploadIdParamsSchema,
        body: rejectBodySchema,
        response: { 200: uploadDetailSchema },
      },
    },
    (request) => review.reject(userOf(request), request.params.id, request.body.reason),
  );

  app.post(
    '/uploads/:id/keep',
    {
      onRequest: [guard],
      schema: {
        tags,
        summary: 'Keep a duplicate as an alternate version',
        params: uploadIdParamsSchema,
        body: keepBodySchema.nullish(),
        response: { 200: uploadDetailSchema },
      },
    },
    (request) => review.keep(userOf(request), request.params.id, request.body?.reason),
  );

  app.post(
    '/uploads/:id/reanalyze',
    {
      onRequest: [guard],
      schema: {
        tags,
        summary: 'Run the analysis again',
        params: uploadIdParamsSchema,
        response: { 200: uploadDetailSchema },
      },
    },
    (request) => review.reanalyze(userOf(request), request.params.id),
  );

  app.post(
    '/uploads/batch/:batchId/approve',
    {
      onRequest: [guard],
      schema: {
        tags,
        summary: 'Approve every reviewable upload of an album batch',
        params: batchIdParamsSchema,
        response: { 200: batchApproveResponseSchema },
      },
    },
    (request) => review.batchApprove(userOf(request), request.params.batchId),
  );

  done();
};
