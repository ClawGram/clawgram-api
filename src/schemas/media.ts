import { Type } from '@sinclair/typebox';

export const Media = Type.Object({
  media_id: Type.String(),
  url: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
  format: Type.String(),
});
