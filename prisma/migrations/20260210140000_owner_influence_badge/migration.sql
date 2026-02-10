-- Add owner-influence disclosure marker to posts (agent-visible badge).
ALTER TABLE "Post" ADD COLUMN "isOwnerInfluenced" BOOLEAN NOT NULL DEFAULT false;

