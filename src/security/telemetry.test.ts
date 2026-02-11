import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { logHttpRequestSummary, logOperationalErrorSignals } from './telemetry';

type MockLog = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function makeRequest(params: { method: string; url: string }): FastifyRequest {
  const log: MockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    id: 'req_test',
    method: params.method,
    url: params.url,
    query: {},
    log,
  } as unknown as FastifyRequest;
}

describe('logHttpRequestSummary', () => {
  it('logs summary event for non-OPTIONS requests', () => {
    const request = makeRequest({ method: 'GET', url: '/api/v1/explore?limit=1' });

    logHttpRequestSummary(request, 503, 12.34567);

    expect(request.log.info).toHaveBeenCalledTimes(1);
    const [fields, message] = (request.log.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toBe('api.http_request');
    expect(fields).toMatchObject({
      event: 'api.http_request',
      request_id: 'req_test',
      method: 'GET',
      path: '/api/v1/explore',
      status_code: 503,
      status_class: 'server_error',
      duration_ms: 12.346,
    });
  });

  it('skips OPTIONS requests', () => {
    const request = makeRequest({ method: 'OPTIONS', url: '/api/v1/posts' });

    logHttpRequestSummary(request, 204, 1.5);

    expect(request.log.info).not.toHaveBeenCalled();
  });
});

describe('logOperationalErrorSignals', () => {
  it('logs generic 5xx signal for server errors', () => {
    const request = makeRequest({ method: 'POST', url: '/api/v1/posts' });

    logOperationalErrorSignals(request, 500, new Error('boom'));

    expect(request.log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = (request.log.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toBe('ops.http_5xx');
    expect(fields).toMatchObject({
      event: 'ops.http_5xx',
      request_id: 'req_test',
      method: 'POST',
      path: '/api/v1/posts',
      status_code: 500,
      status_class: 'server_error',
    });
  });

  it('logs dedicated pool exhaustion signal for prisma P2024', () => {
    const request = makeRequest({ method: 'GET', url: '/api/v1/explore' });

    logOperationalErrorSignals(request, 500, {
      code: 'P2024',
      message: 'Timed out fetching a new connection from the connection pool.',
      meta: {
        modelName: 'Post',
        connection_limit: 5,
        timeout: 10,
      },
    });

    expect(request.log.error).toHaveBeenCalledTimes(2);
    const [fields, message] = (request.log.error as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(message).toBe('ops.db_pool_exhausted');
    expect(fields).toMatchObject({
      event: 'ops.db_pool_exhausted',
      request_id: 'req_test',
      method: 'GET',
      path: '/api/v1/explore',
      status_code: 500,
      prisma_code: 'P2024',
      model_name: 'Post',
      connection_limit: 5,
      timeout_seconds: 10,
    });
  });
});
