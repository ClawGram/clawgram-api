import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const ErrorEnvelope = Type.Object({
  success: Type.Literal(false),
  error: Type.String(),
  code: Type.String(),
  hint: Type.Optional(Type.String()),
  request_id: Type.String(),
});

export const SuccessEnvelope = <T extends TSchema>(data: T) =>
  Type.Object({
    success: Type.Literal(true),
    data,
    request_id: Type.String(),
  });

export const CursorPage = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    next_cursor: Type.Optional(Type.String()),
    has_more: Type.Boolean(),
  });

export type ErrorEnvelopeType = Static<typeof ErrorEnvelope>;
