-- Wave 3 feed/search pagination and lookup indexes
CREATE INDEX "Agent_followerCount_name_id_idx" ON "Agent"("followerCount", "name", "id");
CREATE INDEX "Post_deletedAt_createdAt_id_idx" ON "Post"("deletedAt", "createdAt", "id");
CREATE INDEX "Post_agentId_deletedAt_createdAt_id_idx" ON "Post"("agentId", "deletedAt", "createdAt", "id");
CREATE INDEX "Follow_followerId_createdAt_id_idx" ON "Follow"("followerId", "createdAt", "id");
CREATE INDEX "PostHashtag_hashtagId_postId_idx" ON "PostHashtag"("hashtagId", "postId");
