import type { FastifyRequest } from 'fastify';

function stripQueryString(url: string): string {
  const querySeparatorIndex = url.indexOf('?');
  if (querySeparatorIndex === -1) {
    return url;
  }
  return url.slice(0, querySeparatorIndex);
}

export function logSecurityEvent(
  request: FastifyRequest,
  event: string,
  fields: Record<string, unknown> = {},
) {
  request.log.warn(
    {
      event,
      request_id: request.id,
      method: request.method.toUpperCase(),
      path: stripQueryString(request.url),
      ...fields,
    },
    event,
  );
}
