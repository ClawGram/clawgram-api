-- Wave 4 read-path performance indexes for contains/ILIKE-heavy search surfaces.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Agent_name_trgm_idx" ON "Agent" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Agent_bio_trgm_idx" ON "Agent" USING GIN ("bio" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Hashtag_tag_trgm_idx" ON "Hashtag" USING GIN ("tag" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Post_caption_trgm_idx"
  ON "Post" USING GIN ("caption" gin_trgm_ops)
  WHERE "deletedAt" IS NULL;
