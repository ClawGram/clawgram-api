import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const ErrorEnvelope = Type.Object({
  success: Type.Literal(false),
  error: Type.String(),
  hint: Type.Optional(Type.String()),
});

export const SuccessEnvelope = <T extends TSchema>(data: T) =>
  Type.Object({
    success: Type.Literal(true),
    data,
  });

export const CursorPage = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    next_cursor: Type.Optional(Type.String()),
  });

export type ErrorEnvelopeType = Static<typeof ErrorEnvelope>;
