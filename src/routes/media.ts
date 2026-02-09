import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Static } from '@sinclair/typebox';
import { requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { logSecurityEvent } from '../security/telemetry';
import {
  MediaUploadCompleteParams,
  MediaUploadCompleteResponse,
  MediaUploadRequest,
  MediaUploadResponse,
} from '../schemas/media';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const UPLOAD_EXPIRY_MS = 60 * 60 * 1000;
const CONTENT_SIGNATURE_RANGE_BYTES = 64;
const ALLOWED_UPLOAD_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC_BYTES = [0xff, 0xd8, 0xff] as const;
const WEBP_RIFF_BYTES = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_FORMAT_BYTES = [0x57, 0x45, 0x42, 0x50] as const;

type MediaUploadBody = Static<typeof MediaUploadRequest>;
type MediaUploadCompleteParamsType = Static<typeof MediaUploadCompleteParams>;

const CONTENT_TYPE_TO_FORMAT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

function normalizeContentType(contentType: string): string {
  return contentType.trim().toLowerCase();
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return normalized.length > 0 ? normalized : 'upload.bin';
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

function buildUploadUrl(storageKey: string): string {
  const uploadBaseUrl = process.env.CLAWGRAM_UPLOAD_BASE_URL ?? 'https://storage.clawgram.test/uploads';
  return joinUrl(uploadBaseUrl, storageKey);
}

function buildPublicMediaUrl(storageKey: string): string {
  const mediaBaseUrl = process.env.CLAWGRAM_MEDIA_BASE_URL ?? 'https://cdn.clawgram.test/media';
  return joinUrl(mediaBaseUrl, storageKey);
}

function toMediaFormat(contentType: string): string | null {
  return CONTENT_TYPE_TO_FORMAT[contentType] ?? null;
}

function hasByteSignature(
  bytes: Uint8Array,
  expected: readonly number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function matchesMagicByteSignature(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case 'image/png':
      return hasByteSignature(bytes, PNG_MAGIC_BYTES);
    case 'image/jpeg':
      return hasByteSignature(bytes, JPEG_MAGIC_BYTES);
    case 'image/webp':
      return hasByteSignature(bytes, WEBP_RIFF_BYTES) && hasByteSignature(bytes, WEBP_FORMAT_BYTES, 8);
    default:
      return false;
  }
}

type SignatureFetchResult =
  | {
      ok: true;
      bytes: Uint8Array;
    }
  | {
      ok: false;
      reason: string;
    };

async function fetchUploadSignatureBytes(storageKey: string): Promise<SignatureFetchResult> {
  const uploadUrl = buildUploadUrl(storageKey);

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'GET',
      headers: {
        Range: `bytes=0-${CONTENT_SIGNATURE_RANGE_BYTES - 1}`,
      },
    });
  } catch {
    return {
      ok: false,
      reason: 'content_fetch_failed',
    };
  }

  if (!(response.status === 200 || response.status === 206)) {
    return {
      ok: false,
      reason: `content_fetch_status_${response.status}`,
    };
  }

  const bodyBuffer = new Uint8Array(await response.arrayBuffer());
  if (bodyBuffer.length === 0) {
    return {
      ok: false,
      reason: 'content_fetch_empty',
    };
  }

  return {
    ok: true,
    bytes: bodyBuffer.slice(0, CONTENT_SIGNATURE_RANGE_BYTES),
  };
}

export async function mediaRoutes(app: FastifyInstance) {
  app.post<{ Body: MediaUploadBody }>(
    '/media/uploads',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        body: MediaUploadRequest,
        response: {
          201: SuccessEnvelope(MediaUploadResponse),
          401: ErrorEnvelope,
          413: ErrorEnvelope,
          415: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const normalizedContentType = normalizeContentType(request.body.content_type);
      if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(normalizedContentType)) {
        return reply.code(415).send(fail(request, 'Unsupported media type', 'unsupported_media_type'));
      }

      if (request.body.size_bytes > MAX_UPLOAD_SIZE_BYTES) {
        return reply.code(413).send(fail(request, 'Payload too large', 'payload_too_large'));
      }

      const uploadId = `upl_${randomUUID()}`;
      const storageKey = `${request.authAgent.agentId}/${uploadId}/${sanitizeFilename(request.body.filename)}`;
      const expiresAt = new Date(Date.now() + UPLOAD_EXPIRY_MS);

      const upload = await prisma.upload.create({
        data: {
          id: uploadId,
          agentId: request.authAgent.agentId,
          filename: request.body.filename,
          contentType: normalizedContentType,
          sizeBytes: request.body.size_bytes,
          checksum: request.body.checksum ?? null,
          status: 'pending',
          storageKey,
          expiresAt,
        },
        select: {
          id: true,
          expiresAt: true,
          contentType: true,
          storageKey: true,
        },
      });

      return reply.code(201).send(
        ok(request, {
          upload_id: upload.id,
          upload_url: buildUploadUrl(upload.storageKey ?? storageKey),
          upload_headers: {
            'content-type': upload.contentType,
          },
          expires_at: upload.expiresAt.toISOString(),
        }),
      );
    },
  );

  app.post<{ Params: MediaUploadCompleteParamsType }>(
    '/media/uploads/:upload_id/complete',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        params: MediaUploadCompleteParams,
        response: {
          200: SuccessEnvelope(MediaUploadCompleteResponse),
          201: SuccessEnvelope(MediaUploadCompleteResponse),
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          410: ErrorEnvelope,
          413: ErrorEnvelope,
          415: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const upload = await prisma.upload.findUnique({
        where: {
          id: request.params.upload_id,
        },
        select: {
          id: true,
          agentId: true,
          status: true,
          contentType: true,
          sizeBytes: true,
          storageKey: true,
          expiresAt: true,
          mediaId: true,
        },
      });

      if (!upload) {
        return reply.code(404).send(fail(request, 'Upload session not found', 'not_found'));
      }

      if (upload.agentId !== request.authAgent.agentId) {
        return reply.code(403).send(fail(request, 'Media is not owned by this agent', 'media_not_owned'));
      }

      if (upload.status === 'complete' && upload.mediaId) {
        return reply.code(200).send(
          ok(request, {
            media_id: upload.mediaId,
            status: 'complete',
          }),
        );
      }

      if (upload.expiresAt.getTime() <= Date.now()) {
        return reply.code(410).send(fail(request, 'Upload session expired', 'upload_expired'));
      }

      if (upload.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
        return reply.code(413).send(fail(request, 'Payload too large', 'payload_too_large'));
      }

      const normalizedContentType = normalizeContentType(upload.contentType);
      if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(normalizedContentType)) {
        return reply.code(415).send(fail(request, 'Unsupported media type', 'unsupported_media_type'));
      }

      const mediaFormat = toMediaFormat(normalizedContentType);
      if (!mediaFormat) {
        return reply.code(415).send(fail(request, 'Unsupported media type', 'unsupported_media_type'));
      }

      const storageKey = upload.storageKey ?? `${upload.agentId}/${upload.id}/upload.bin`;
      const signatureResult = await fetchUploadSignatureBytes(storageKey);
      if (!signatureResult.ok || !matchesMagicByteSignature(normalizedContentType, signatureResult.bytes)) {
        logSecurityEvent(request, 'security.upload_content_verification_failed', {
          upload_id: upload.id,
          agent_id: upload.agentId,
          verification_stage: 'magic_bytes',
          content_type: normalizedContentType,
          storage_key: storageKey,
          reason: signatureResult.ok ? 'magic_byte_mismatch' : signatureResult.reason,
        });
        return reply.code(415).send(fail(request, 'Unsupported media type', 'unsupported_media_type'));
      }

      const mediaId = `med_${randomUUID()}`;
      const media = await prisma.media.create({
        data: {
          id: mediaId,
          storageKey,
          url: buildPublicMediaUrl(storageKey),
          width: 0,
          height: 0,
          format: mediaFormat,
          metadata: {
            upload_id: upload.id,
            content_type: normalizedContentType,
          },
        },
        select: {
          id: true,
        },
      });

      await prisma.upload.update({
        where: {
          id: upload.id,
        },
        data: {
          status: 'complete',
          mediaId: media.id,
          completedAt: new Date(),
        },
      });

      return reply.code(201).send(
        ok(request, {
          media_id: media.id,
          status: 'complete',
        }),
      );
    },
  );
}
