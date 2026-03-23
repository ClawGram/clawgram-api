import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { normalizeContentType } from '../http/normalize';
import { fail } from '../response';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import { logSecurityEvent } from '../security/telemetry';
import {
  buildSupabasePublicObjectUrl,
  getSupabaseAdminClient,
  getSupabaseStorageConfig,
} from '../storage/supabase';

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const CONTENT_SIGNATURE_RANGE_BYTES = 64;
const ALLOWED_UPLOAD_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UploadPathParams = Type.Object({
  agent_id: Type.String(),
  upload_id: Type.String(),
  filename: Type.String(),
});
const UploadPutResponse = Type.Object({
  uploaded: Type.Boolean(),
  url: Type.String(),
});
const UploadSignatureBytesResponse = Type.String({ format: 'binary' });
const EmptyResponse = Type.Null();

function parseRangeHeader(value: string | undefined): { start: number; end: number } | null {
  if (!value) {
    return null;
  }

  const match = /^bytes=(\d+)-(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return null;
  }

  return { start, end };
}

function buildStorageKey(params: { agent_id: string; upload_id: string; filename: string }): string {
  return `${params.agent_id}/${params.upload_id}/${params.filename}`;
}

function isStorageObjectAlreadyExistsError(error: { message?: string; statusCode?: string | number } | null): boolean {
  if (!error) {
    return false;
  }

  const statusCode = typeof error.statusCode === 'number'
    ? String(error.statusCode)
    : typeof error.statusCode === 'string'
      ? error.statusCode.trim()
      : '';
  if (statusCode === '409') {
    return true;
  }

  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return message.includes('already exists');
}

export async function uploadRoutes(app: FastifyInstance) {
  // Accept binary bodies for the upload endpoint only.
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_SIZE_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.put<{
    Params: { agent_id: string; upload_id: string; filename: string };
    Body: unknown;
  }>(
    '/uploads/:agent_id/:upload_id/:filename',
    {
      // Override Fastify default (and keep it aligned with MAX_UPLOAD_SIZE_BYTES).
      bodyLimit: MAX_UPLOAD_SIZE_BYTES,
      schema: {
        params: UploadPathParams,
        response: {
          200: SuccessEnvelope(UploadPutResponse),
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          410: ErrorEnvelope,
          413: ErrorEnvelope,
          415: ErrorEnvelope,
          502: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const supabase = getSupabaseAdminClient();
      const supabaseConfig = getSupabaseStorageConfig();
      if (!supabase || !supabaseConfig) {
        return reply.code(500).send(fail(request, 'Upload backend not configured', 'internal_error'));
      }

      const storageKey = buildStorageKey(request.params);
      const upload = await prisma.upload.findUnique({
        where: { id: request.params.upload_id },
        select: {
          id: true,
          agentId: true,
          status: true,
          contentType: true,
          sizeBytes: true,
          storageKey: true,
          expiresAt: true,
        },
      });

      if (!upload) {
        return reply.code(404).send(fail(request, 'Upload session not found', 'not_found'));
      }

      if (upload.expiresAt.getTime() <= Date.now()) {
        return reply.code(410).send(fail(request, 'Upload session expired', 'upload_expired'));
      }

      if (upload.status === 'complete') {
        return reply
          .code(409)
          .send(fail(request, 'Upload session is already completed', 'validation_error'));
      }

      if (upload.status === 'failed') {
        return reply
          .code(409)
          .send(fail(request, 'Upload session is not writable', 'validation_error'));
      }

      if (!upload.storageKey || upload.storageKey !== storageKey) {
        logSecurityEvent(request, 'security.upload_storage_key_mismatch', {
          upload_id: upload.id,
          agent_id: upload.agentId,
          expected_storage_key: upload.storageKey,
          request_storage_key: storageKey,
        });
        return reply.code(403).send(fail(request, 'Forbidden', 'forbidden'));
      }

      const declaredContentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '';
      const normalizedDeclaredContentType = normalizeContentType(declaredContentType);
      const normalizedExpectedContentType = normalizeContentType(upload.contentType);
      if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(normalizedExpectedContentType)) {
        return reply.code(415).send(fail(request, 'Unsupported media type', 'unsupported_media_type'));
      }

      if (!normalizedDeclaredContentType || normalizedDeclaredContentType !== normalizedExpectedContentType) {
        return reply.code(415).send(fail(request, 'Unsupported media type', 'unsupported_media_type'));
      }

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      if (
        body.length === 0 ||
        body.length !== upload.sizeBytes ||
        body.length > MAX_UPLOAD_SIZE_BYTES
      ) {
        return reply.code(413).send(fail(request, 'Payload too large', 'payload_too_large'));
      }

      const { error } = await supabase.storage.from(supabaseConfig.bucket).upload(storageKey, body, {
        contentType: normalizedExpectedContentType,
        upsert: false,
      });

      if (error && !isStorageObjectAlreadyExistsError(error)) {
        logSecurityEvent(request, 'security.upload_storage_write_failed', {
          upload_id: upload.id,
          agent_id: upload.agentId,
          storage_key: storageKey,
          reason: error.message,
        });
        return reply.code(502).send(fail(request, 'Upload failed', 'internal_error'));
      }

      // Mark as processing to reflect "bytes are present" without claiming verification is complete.
      if (upload.status === 'pending') {
        await prisma.upload.update({
          where: { id: upload.id },
          data: { status: 'processing' },
        });
      }

      // Returning the eventual public object URL is useful for debugging, but not required for the contract.
      // The canonical media URL is issued on `/media/uploads/:id/complete`.
      return reply.code(200).send({
        success: true,
        data: {
          uploaded: true,
          url: buildSupabasePublicObjectUrl(supabaseConfig, storageKey),
        },
        request_id: request.id,
      });
    },
  );

  app.get<{ Params: { agent_id: string; upload_id: string; filename: string } }>(
    '/uploads/:agent_id/:upload_id/:filename',
    {
      schema: {
        params: UploadPathParams,
        response: {
          206: UploadSignatureBytesResponse,
          404: EmptyResponse,
          410: EmptyResponse,
          416: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      const supabase = getSupabaseAdminClient();
      const supabaseConfig = getSupabaseStorageConfig();
      if (!supabase || !supabaseConfig) {
        return reply.code(404).send();
      }

      const range = parseRangeHeader(typeof request.headers.range === 'string' ? request.headers.range : undefined);
      if (!range || range.start !== 0 || range.end >= CONTENT_SIGNATURE_RANGE_BYTES) {
        // Keep this endpoint narrow: it's only intended for upload verification (magic bytes).
        return reply.code(416).send();
      }

      const storageKey = buildStorageKey(request.params);
      const upload = await prisma.upload.findUnique({
        where: { id: request.params.upload_id },
        select: {
          id: true,
          agentId: true,
          contentType: true,
          storageKey: true,
          expiresAt: true,
        },
      });

      if (!upload || !upload.storageKey || upload.storageKey !== storageKey) {
        return reply.code(404).send();
      }

      if (upload.expiresAt.getTime() <= Date.now()) {
        return reply.code(410).send();
      }

      const { data, error } = await supabase.storage.from(supabaseConfig.bucket).download(storageKey);
      if (error || !data) {
        logSecurityEvent(request, 'security.upload_storage_read_failed', {
          upload_id: upload.id,
          agent_id: upload.agentId,
          storage_key: storageKey,
          reason: error?.message ?? 'missing_data',
        });
        return reply.code(404).send();
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      const slice = buffer.slice(range.start, range.end + 1);
      reply.header('Content-Type', normalizeContentType(upload.contentType));
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${buffer.length}`);
      return reply.code(206).send(slice);
    },
  );
}
