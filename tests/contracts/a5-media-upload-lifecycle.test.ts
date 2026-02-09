import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type UploadRecord = {
  id: string;
  agentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum: string | null;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  storageKey: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  mediaId: string | null;
};

type MediaRecord = {
  id: string;
  storageKey: string;
  url: string;
  width: number;
  height: number;
  format: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

const prismaMocks = vi.hoisted(() => ({
  apiKeyFindUnique: vi.fn(),
  uploadCreate: vi.fn(),
  uploadFindUnique: vi.fn(),
  uploadUpdate: vi.fn(),
  mediaCreate: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  prisma: {
    apiKey: {
      findUnique: prismaMocks.apiKeyFindUnique,
    },
    upload: {
      create: prismaMocks.uploadCreate,
      findUnique: prismaMocks.uploadFindUnique,
      update: prismaMocks.uploadUpdate,
    },
    media: {
      create: prismaMocks.mediaCreate,
    },
  },
}));

type ErrorEnvelope = {
  success: false;
  error: string;
  code: string;
  request_id: string;
  hint?: string;
};

function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

function signatureBytesForContentType(contentType: string): number[] {
  switch (contentType) {
    case 'image/png':
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    case 'image/jpeg':
      return [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    case 'image/webp':
      return [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
    default:
      return [];
  }
}

function selectProjection<T extends Record<string, unknown>>(
  row: T,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) {
    return { ...row };
  }

  return Object.entries(select).reduce<Record<string, unknown>>((projection, [key, enabled]) => {
    if (enabled) {
      projection[key] = row[key];
    }
    return projection;
  }, {});
}

describe('contract: A5 media upload lifecycle baseline', () => {
  let app: FastifyInstance;
  const authHeader = { authorization: 'Bearer claw_test_a5_key' };
  const uploads = new Map<string, UploadRecord>();
  const media = new Map<string, MediaRecord>();
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>();
  let authenticatedAgentId = 'agent_a5';
  let mediaCounter = 0;

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    uploads.clear();
    media.clear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = input instanceof URL ? input.toString() : input.toString();
      const matchedUpload = [...uploads.values()].find(
        (upload) => upload.storageKey !== null && url.includes(upload.storageKey),
      );
      if (!matchedUpload) {
        return new Response(new Uint8Array(), { status: 404 });
      }
      return new Response(Uint8Array.from(signatureBytesForContentType(matchedUpload.contentType)), {
        status: 206,
      });
    });
    globalThis.fetch = fetchMock;
    authenticatedAgentId = 'agent_a5';
    mediaCounter = 0;

    prismaMocks.apiKeyFindUnique.mockImplementation(({ where }: { where: { keyHash: string } }) => ({
      id: 'api_key_a5',
      agentId: authenticatedAgentId,
      keyHash: where.keyHash,
    }));

    prismaMocks.uploadCreate.mockImplementation(
      ({ data, select }: { data: Omit<UploadRecord, 'createdAt' | 'updatedAt' | 'completedAt' | 'mediaId'>; select?: Record<string, boolean> }) => {
        const now = new Date();
        const created: UploadRecord = {
          ...data,
          checksum: data.checksum ?? null,
          storageKey: data.storageKey ?? null,
          status: data.status ?? 'pending',
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          mediaId: null,
        };
        uploads.set(created.id, created);
        return selectProjection(created as unknown as Record<string, unknown>, select);
      },
    );

    prismaMocks.uploadFindUnique.mockImplementation(
      ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const found = uploads.get(where.id);
        if (!found) {
          return null;
        }
        return selectProjection(found as unknown as Record<string, unknown>, select);
      },
    );

    prismaMocks.uploadUpdate.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<Pick<UploadRecord, 'status' | 'mediaId' | 'completedAt'>>;
      }) => {
        const existing = uploads.get(where.id);
        if (!existing) {
          throw new Error('Upload not found');
        }

        const updated: UploadRecord = {
          ...existing,
          ...data,
          updatedAt: new Date(),
          completedAt: data.completedAt ?? existing.completedAt,
          mediaId: data.mediaId ?? existing.mediaId,
          status: data.status ?? existing.status,
        };
        uploads.set(where.id, updated);
        return updated;
      },
    );

    prismaMocks.mediaCreate.mockImplementation(
      ({
        data,
        select,
      }: {
        data: Omit<MediaRecord, 'createdAt'>;
        select?: Record<string, boolean>;
      }) => {
        mediaCounter += 1;
        const created: MediaRecord = {
          ...data,
          id: data.id || `med_mock_${mediaCounter}`,
          metadata: data.metadata ?? null,
          createdAt: new Date(),
        };
        media.set(created.id, created);
        return selectProjection(created as unknown as Record<string, unknown>, select);
      },
    );
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  it('implements POST /api/v1/media/uploads with upload session response', async () => {
    const start = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: authHeader,
      payload: {
        filename: 'cat portrait.png',
        content_type: 'image/png',
        size_bytes: 2048,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = parseJson<{
      success: true;
      data: {
        upload_id: string;
        upload_url: string;
        upload_headers: Record<string, string>;
        expires_at: string;
      };
    }>(response.payload);

    expect(body.success).toBe(true);
    expect(body.data.upload_id.startsWith('upl_')).toBe(true);
    expect(body.data.upload_url.includes(body.data.upload_id)).toBe(true);
    expect(body.data.upload_headers['content-type']).toBe('image/png');
    expect(Date.parse(body.data.expires_at)).toBeGreaterThan(start);

    const persistedUpload = uploads.get(body.data.upload_id);
    expect(persistedUpload?.agentId).toBe('agent_a5');
    expect(persistedUpload?.status).toBe('pending');
  });

  it('rejects unsupported upload media type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: authHeader,
      payload: {
        filename: 'clip.gif',
        content_type: 'image/gif',
        size_bytes: 4096,
      },
    });

    expect(response.statusCode).toBe(415);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('unsupported_media_type');
  });

  it('rejects oversize uploads above 10MB', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: authHeader,
      payload: {
        filename: 'too-big.webp',
        content_type: 'image/webp',
        size_bytes: 10 * 1024 * 1024 + 1,
      },
    });

    expect(response.statusCode).toBe(413);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('payload_too_large');
  });

  it('enforces ownership checks on upload complete', async () => {
    const uploadId = 'upl_cross_owner';
    uploads.set(uploadId, {
      id: uploadId,
      agentId: 'agent_other',
      filename: 'owned-by-other.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      checksum: null,
      status: 'pending',
      storageKey: 'agent_other/upl_cross_owner/owned-by-other.jpg',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      mediaId: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${uploadId}/complete`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(403);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('media_not_owned');
  });

  it('enforces expiry checks on upload complete', async () => {
    const uploadId = 'upl_expired';
    uploads.set(uploadId, {
      id: uploadId,
      agentId: authenticatedAgentId,
      filename: 'expired.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      checksum: null,
      status: 'pending',
      storageKey: 'agent_a5/upl_expired/expired.jpg',
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      mediaId: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${uploadId}/complete`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(410);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('upload_expired');
  });

  it('completes upload and returns media object id', async () => {
    const uploadId = 'upl_complete';
    uploads.set(uploadId, {
      id: uploadId,
      agentId: authenticatedAgentId,
      filename: 'complete.webp',
      contentType: 'image/webp',
      sizeBytes: 1000,
      checksum: null,
      status: 'pending',
      storageKey: 'agent_a5/upl_complete/complete.webp',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      mediaId: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${uploadId}/complete`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(201);
    const body = parseJson<{ success: true; data: { media_id: string; status: string } }>(response.payload);
    expect(body.data.media_id.startsWith('med_')).toBe(true);
    expect(body.data.status).toBe('complete');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('agent_a5/upl_complete/complete.webp'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Range: 'bytes=0-63',
        }),
      }),
    );
    expect(uploads.get(uploadId)?.status).toBe('complete');
    expect(uploads.get(uploadId)?.mediaId).toBe(body.data.media_id);

    const retryResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${uploadId}/complete`,
      headers: authHeader,
    });
    expect(retryResponse.statusCode).toBe(200);
    const retryBody = parseJson<{ success: true; data: { media_id: string; status: string } }>(
      retryResponse.payload,
    );
    expect(retryBody.data.media_id).toBe(body.data.media_id);
    expect(retryBody.data.status).toBe('complete');
  });

  it('supports idempotent retry for already completed uploads', async () => {
    const uploadId = 'upl_retry';
    const existingMediaId = 'med_existing_retry';
    uploads.set(uploadId, {
      id: uploadId,
      agentId: authenticatedAgentId,
      filename: 'retry.png',
      contentType: 'image/png',
      sizeBytes: 1200,
      checksum: null,
      status: 'complete',
      storageKey: 'agent_a5/upl_retry/retry.png',
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
      mediaId: existingMediaId,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${uploadId}/complete`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    const body = parseJson<{ success: true; data: { media_id: string; status: string } }>(response.payload);
    expect(body.data.media_id).toBe(existingMediaId);
    expect(body.data.status).toBe('complete');
    expect(prismaMocks.mediaCreate).not.toHaveBeenCalled();
  });

  it('rejects upload complete when fetched content signature mismatches declared type', async () => {
    const uploadId = 'upl_mismatch';
    uploads.set(uploadId, {
      id: uploadId,
      agentId: authenticatedAgentId,
      filename: 'looks-like-png.png',
      contentType: 'image/png',
      sizeBytes: 1200,
      checksum: null,
      status: 'pending',
      storageKey: 'agent_a5/upl_mismatch/looks-like-png.png',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      mediaId: null,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), {
        status: 206,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${uploadId}/complete`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(415);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('unsupported_media_type');
    expect(uploads.get(uploadId)?.status).toBe('pending');
    expect(uploads.get(uploadId)?.mediaId).toBeNull();
    expect(prismaMocks.mediaCreate).not.toHaveBeenCalled();
  });
});
