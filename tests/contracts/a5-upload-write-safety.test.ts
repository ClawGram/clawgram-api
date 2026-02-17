import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJson } from './helpers/contract-test-helpers';

type UploadStatus = 'pending' | 'processing' | 'complete' | 'failed';

type UploadRecord = {
  id: string;
  agentId: string;
  status: UploadStatus;
  contentType: string;
  sizeBytes: number;
  storageKey: string | null;
  expiresAt: Date;
};

type SupabaseUploadError = {
  message?: string;
  statusCode?: string | number;
};

const prismaMocks = vi.hoisted(() => ({
  uploadFindUnique: vi.fn(),
  uploadUpdate: vi.fn(),
}));

const supabaseMocks = vi.hoisted(() => ({
  storageUpload: vi.fn(),
  storageFrom: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getSupabaseStorageConfig: vi.fn(),
}));

vi.mock('../../src/db', async () => {
  const { createPrismaDbMock } = await import('./helpers/contract-test-helpers');
  return createPrismaDbMock(prismaMocks, {
    upload: ['findUnique', 'update'],
  });
});

vi.mock('../../src/storage/supabase', () => ({
  getSupabaseAdminClient: supabaseMocks.getSupabaseAdminClient,
  getSupabaseStorageConfig: supabaseMocks.getSupabaseStorageConfig,
  buildSupabasePublicObjectUrl: (_config: { bucket: string; url: string }, objectPath: string) =>
    `https://example.supabase.co/storage/v1/object/public/public-images/${objectPath}`,
}));

type ErrorEnvelope = {
  success: false;
  error: string;
  code: string;
  request_id: string;
};

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

describe('contract: A5 upload write safety', () => {
  let app: FastifyInstance;
  const uploads = new Map<string, UploadRecord>();

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    uploads.clear();

    supabaseMocks.storageUpload.mockResolvedValue({ error: null as SupabaseUploadError | null });
    supabaseMocks.storageFrom.mockReturnValue({
      upload: supabaseMocks.storageUpload,
      download: vi.fn(),
    });
    supabaseMocks.getSupabaseAdminClient.mockReturnValue({
      storage: {
        from: supabaseMocks.storageFrom,
      },
    });
    supabaseMocks.getSupabaseStorageConfig.mockReturnValue({
      bucket: 'public-images',
      serviceRoleKey: 'secret',
      url: 'https://example.supabase.co',
    });

    prismaMocks.uploadFindUnique.mockImplementation(
      ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const upload = uploads.get(where.id);
        if (!upload) {
          return null;
        }
        return selectProjection(upload as unknown as Record<string, unknown>, select);
      },
    );

    prismaMocks.uploadUpdate.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<Pick<UploadRecord, 'status'>>;
      }) => {
        const upload = uploads.get(where.id);
        if (!upload) {
          throw new Error('Upload not found');
        }

        const updated: UploadRecord = {
          ...upload,
          ...(data.status ? { status: data.status } : {}),
        };
        uploads.set(where.id, updated);
        return updated;
      },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects writes to completed upload sessions', async () => {
    uploads.set('upl_complete', {
      id: 'upl_complete',
      agentId: 'agent_1',
      status: 'complete',
      contentType: 'image/png',
      sizeBytes: 8,
      storageKey: 'agent_1/upl_complete/file.png',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/uploads/agent_1/upl_complete/file.png',
      headers: {
        'content-type': 'image/png',
      },
      payload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    });

    expect(response.statusCode).toBe(409);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('validation_error');
    expect(supabaseMocks.storageUpload).not.toHaveBeenCalled();
  });

  it('rejects payload size mismatches for upload session writes', async () => {
    uploads.set('upl_size_mismatch', {
      id: 'upl_size_mismatch',
      agentId: 'agent_2',
      status: 'pending',
      contentType: 'image/png',
      sizeBytes: 8,
      storageKey: 'agent_2/upl_size_mismatch/file.png',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/uploads/agent_2/upl_size_mismatch/file.png',
      headers: {
        'content-type': 'image/png',
      },
      payload: Buffer.from([1, 2, 3, 4, 5, 6, 7]),
    });

    expect(response.statusCode).toBe(413);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('payload_too_large');
    expect(supabaseMocks.storageUpload).not.toHaveBeenCalled();
  });

  it('writes uploads in immutable mode and marks pending sessions as processing', async () => {
    uploads.set('upl_pending', {
      id: 'upl_pending',
      agentId: 'agent_3',
      status: 'pending',
      contentType: 'image/png',
      sizeBytes: 8,
      storageKey: 'agent_3/upl_pending/file.png',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/uploads/agent_3/upl_pending/file.png',
      headers: {
        'content-type': 'image/png',
      },
      payload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    });

    expect(response.statusCode).toBe(200);
    const body = parseJson<{ success: true; data: { uploaded: boolean; url: string } }>(response.payload);
    expect(body.success).toBe(true);
    expect(body.data.uploaded).toBe(true);
    expect(body.data.url).toContain('agent_3/upl_pending/file.png');
    expect(supabaseMocks.storageUpload).toHaveBeenCalledWith(
      'agent_3/upl_pending/file.png',
      expect.any(Buffer),
      expect.objectContaining({
        contentType: 'image/png',
        upsert: false,
      }),
    );
    expect(prismaMocks.uploadUpdate).toHaveBeenCalledWith({
      where: { id: 'upl_pending' },
      data: { status: 'processing' },
    });
    expect(uploads.get('upl_pending')?.status).toBe('processing');
  });

  it('treats storage already-exists responses as idempotent success', async () => {
    uploads.set('upl_processing', {
      id: 'upl_processing',
      agentId: 'agent_4',
      status: 'processing',
      contentType: 'image/png',
      sizeBytes: 8,
      storageKey: 'agent_4/upl_processing/file.png',
      expiresAt: new Date(Date.now() + 60_000),
    });
    supabaseMocks.storageUpload.mockResolvedValueOnce({
      error: {
        message: 'The resource already exists',
        statusCode: 409,
      } as SupabaseUploadError,
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/uploads/agent_4/upl_processing/file.png',
      headers: {
        'content-type': 'image/png',
      },
      payload: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    });

    expect(response.statusCode).toBe(200);
    const body = parseJson<{ success: true; data: { uploaded: boolean } }>(response.payload);
    expect(body.success).toBe(true);
    expect(body.data.uploaded).toBe(true);
  });
});
