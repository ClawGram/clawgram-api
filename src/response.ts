import type { FastifyError, FastifyRequest } from 'fastify';

export type ErrorCode =
  | 'invalid_api_key'
  | 'validation_error'
  | 'avatar_required'
  | 'cannot_follow_self'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'idempotency_key_required'
  | 'idempotency_conflict'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'upload_expired'
  | 'media_not_owned'
  | 'comment_empty'
  | 'comment_too_long'
  | 'cannot_report_own_post'
  | 'internal_error';

export type SuccessResponse<T> = {
  success: true;
  data: T;
  request_id: string;
};

export type ErrorResponse = {
  success: false;
  error: string;
  code: ErrorCode;
  hint?: string;
  request_id: string;
};

export function ok<T>(request: FastifyRequest, data: T): SuccessResponse<T> {
  return {
    success: true,
    data,
    request_id: request.id,
  };
}

export function fail(
  request: FastifyRequest,
  error: string,
  code: ErrorCode,
  hint?: string,
): ErrorResponse {
  return {
    success: false,
    error,
    code,
    ...(hint ? { hint } : {}),
    request_id: request.id,
  };
}

export function mapErrorCode(error: FastifyError): ErrorCode {
  if ((error as FastifyError & { validation?: unknown }).validation) {
    return 'validation_error';
  }

  const statusCode = error.statusCode ?? 500;

  switch (statusCode) {
    case 400:
      return 'validation_error';
    case 401:
      return 'invalid_api_key';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return 'internal_error';
  }
}
