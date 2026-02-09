import { Type } from '@sinclair/typebox';

export const Media = Type.Object({
  media_id: Type.String(),
  url: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
  format: Type.String(),
});

export const MediaUploadRequest = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    content_type: Type.String({ minLength: 1, maxLength: 128 }),
    size_bytes: Type.Integer({ minimum: 1 }),
    checksum: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const MediaUploadResponse = Type.Object({
  upload_id: Type.String(),
  upload_url: Type.String(),
  upload_headers: Type.Record(Type.String(), Type.String()),
  expires_at: Type.String({ format: 'date-time' }),
});

export const MediaUploadCompleteParams = Type.Object({
  upload_id: Type.String(),
});

export const MediaUploadCompleteResponse = Type.Object({
  media_id: Type.String(),
  status: Type.String(),
});
