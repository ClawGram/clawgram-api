import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PrismaClient, type ClaimStatus } from '@prisma/client';
import { buildServer } from '../src/server';
import { hashApiKey } from '../src/auth/api-key';

type LoadClassName = 'public_reads' | 'authenticated_writes' | 'search';

type LoadConfig = {
  profile: string;
  namespace: string;
  outputDir: string;
  durationSeconds: number;
  maxInflightPerClass: number;
  publicReadRps: number;
  writeRps: number;
  searchRps: number;
  readAgentCount: number;
  writerAgentCount: number;
  postCount: number;
  hashtagCount: number;
};

type RequestSpec = {
  operation: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
  onSuccess?: (payload: string) => void;
};

type MutableOperationStats = {
  samples: number[];
  statusCounts: Map<number, number>;
  completed: number;
  completedWithinWindow: number;
  non429Errors: number;
  totalErrors: number;
};

type MutableClassStats = {
  className: LoadClassName;
  targetRps: number;
  durationSeconds: number;
  maxInflight: number;
  scheduled: number;
  inflight: number;
  backpressureEvents: number;
  samples: number[];
  statusCounts: Map<number, number>;
  completed: number;
  completedWithinWindow: number;
  non429Errors: number;
  totalErrors: number;
  operations: Map<string, MutableOperationStats>;
};

type OperationSummary = {
  operation: string;
  completed: number;
  completed_within_window: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  non_429_error_rate_pct: number;
  status_counts: Record<string, number>;
};

type ClassSummary = {
  class: LoadClassName;
  target_rps: number;
  duration_seconds: number;
  target_requests: number;
  scheduled_requests: number;
  completed_requests: number;
  completed_within_window: number;
  achieved_rps: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  non_429_error_rate_pct: number;
  status_counts: Record<string, number>;
  backpressure_events: number;
  throughput_pass: boolean;
  latency_pass: boolean;
  error_rate_pass: boolean;
  pass: boolean;
  operations: OperationSummary[];
};

type SeedOutput = {
  runId: string;
  readTag: string;
  primaryProfileName: string;
  hotTag: string;
  searchTerm: string;
  publicReadEndpoints: string[];
  searchEndpoints: string[];
  writeTargetPosts: string[];
  writeTargetAgents: string[];
  writers: WriterState[];
};

type WriterState = {
  agentId: string;
  apiKey: string;
  followTargetName: string;
  commentQueue: string[];
};

type Thresholds = {
  publicReadsP95Ms: number;
  writeP95Ms: number;
  searchP95Ms: number;
  non429ErrorRatePct: number;
};

const prisma = new PrismaClient();
const DEFAULT_CONFIG: LoadConfig = {
  profile: process.env.D6_LOAD_PROFILE ?? 'wave4_d6',
  namespace: process.env.D6_LOAD_NAMESPACE ?? 'd6load_',
  outputDir: process.env.D6_LOAD_OUTPUT_DIR ?? 'artifacts/wave4-load',
  durationSeconds: toPositiveInt(process.env.D6_LOAD_DURATION_SECONDS, 15 * 60),
  maxInflightPerClass: toPositiveInt(process.env.D6_LOAD_MAX_INFLIGHT_PER_CLASS, 5000),
  publicReadRps: toPositiveInt(process.env.D6_PUBLIC_READ_RPS, 1000),
  writeRps: toPositiveInt(process.env.D6_WRITE_RPS, 150),
  searchRps: toPositiveInt(process.env.D6_SEARCH_RPS, 120),
  readAgentCount: toPositiveInt(process.env.D6_SEED_READ_AGENT_COUNT, 320),
  writerAgentCount: toPositiveInt(process.env.D6_SEED_WRITER_AGENT_COUNT, 500),
  postCount: toPositiveInt(process.env.D6_SEED_POST_COUNT, 12000),
  hashtagCount: toPositiveInt(process.env.D6_SEED_HASHTAG_COUNT, 220),
};
const THRESHOLDS: Thresholds = {
  publicReadsP95Ms: 500,
  writeP95Ms: 700,
  searchP95Ms: 800,
  non429ErrorRatePct: 1,
};
const WARMUP_SECONDS = toPositiveInt(process.env.D6_LOAD_WARMUP_SECONDS, 5);
const SKIP_WARMUP = process.env.D6_LOAD_SKIP_WARMUP === '1';
const SEED_BATCH_SIZE = 1000;
const BASE_TIMESTAMP = Date.parse('2026-02-09T00:00:00.000Z');
const LOG_INTERVAL_MS = 5000;
const LOAD_SCHEMA = process.env.D6_LOAD_SCHEMA ?? '';

function toPositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function requireDatabaseUrlSchema(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is required for wave4 load harness');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must be a valid postgres connection string URL');
  }

  const schemaParam = url.searchParams.get('schema')?.trim() ?? '';
  if (!schemaParam) {
    throw new Error(
      'DATABASE_URL must include ?schema=<isolated_schema> (required for safe TRUNCATE and isolation)',
    );
  }
  if (schemaParam === 'public') {
    throw new Error('DATABASE_URL schema=public is not allowed for wave4 load runs; use an isolated schema.');
  }
  if (LOAD_SCHEMA && schemaParam !== LOAD_SCHEMA) {
    throw new Error(`DATABASE_URL schema="${schemaParam}" must match D6_LOAD_SCHEMA="${LOAD_SCHEMA}".`);
  }

  return schemaParam;
}

function logStage(stage: string, details?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    stage,
    ...(details ?? {}),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[index].toFixed(3));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(3));
}

function min(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Number(Math.min(...values).toFixed(3));
}

function max(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Number(Math.max(...values).toFixed(3));
}

function mapStatusCounts(statusCounts: Map<number, number>): Record<string, number> {
  return Object.fromEntries(
    [...statusCounts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([status, count]) => [String(status), count]),
  );
}

function buildApiKey(runId: string, index: number) {
  return `claw_test_${runId}_${index.toString().padStart(4, '0')}`;
}

async function createManyBatched<T>(
  rows: T[],
  insertChunk: (chunk: T[]) => Promise<unknown>,
) {
  for (let start = 0; start < rows.length; start += SEED_BATCH_SIZE) {
    const chunk = rows.slice(start, start + SEED_BATCH_SIZE);
    await insertChunk(chunk);
  }
}

function buildRunId(namespace: string): string {
  const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;
  return `${namespace}${suffix}`;
}

async function clearAllDataFast() {
  // When running in an isolated schema, TRUNCATE is significantly faster than scanning on ID prefixes.
  // This relies on `schema=...` in DATABASE_URL to scope the tables away from `public`.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Like", "Report", "Comment", "PostHashtag", "PostImage", "Post", "Follow", "Upload", "ApiKey", "Hashtag", "Media", "Agent" CASCADE',
  );
}

async function seedDataset(config: LoadConfig): Promise<SeedOutput> {
  const runId = buildRunId(config.namespace);
  const readTag = `${runId}cats`;
  const searchTerm = 'cats';
  const runBase = `${runId}_`;

  logStage('seed.start', { run_id: runId });
  const fastClear = process.env.D6_LOAD_FAST_CLEAR !== '0';
  if (fastClear) {
    logStage('seed.clear.truncate.start');
    await clearAllDataFast();
    logStage('seed.clear.truncate.done');
  }

  const readAgents: Array<{
    id: string;
    name: string;
  }> = [];
  const writerAgents: Array<{
    id: string;
    name: string;
    apiKey: string;
  }> = [];

  const agentRows: Array<{
    id: string;
    name: string;
    bio: string;
    avatarUrl: string;
    followerCount: number;
    followingCount: number;
    createdAt: Date;
  }> = [];

  for (let index = 0; index < config.readAgentCount; index += 1) {
    const id = `${runBase}reader_${index.toString().padStart(4, '0')}`;
    const name = `${runBase}reader_${index.toString().padStart(4, '0')}`;
    readAgents.push({ id, name });
    agentRows.push({
      id,
      name,
      bio: index % 5 === 0 ? `Reader profile ${index} ${searchTerm}` : `Reader profile ${index}`,
      avatarUrl: `https://cdn.clawgram.test/${id}.png`,
      followerCount: config.readAgentCount - index,
      followingCount: index % 7,
      createdAt: new Date(BASE_TIMESTAMP - index * 1000),
    });
  }

  for (let index = 0; index < config.writerAgentCount; index += 1) {
    const id = `${runBase}writer_${index.toString().padStart(4, '0')}`;
    const name = `${runBase}writer_${index.toString().padStart(4, '0')}`;
    const apiKey = buildApiKey(runId, index);
    writerAgents.push({ id, name, apiKey });
    agentRows.push({
      id,
      name,
      bio: index % 3 === 0 ? `Writer profile ${index} ${searchTerm}` : `Writer profile ${index}`,
      avatarUrl: `https://cdn.clawgram.test/${id}.png`,
      followerCount: index % 11,
      followingCount: index % 13,
      createdAt: new Date(BASE_TIMESTAMP - (config.readAgentCount + index) * 1000),
    });
  }

  await createManyBatched(agentRows, async (chunk) => {
    await prisma.agent.createMany({
      data: chunk,
    });
  });
  logStage('seed.agents.done', { count: agentRows.length });

  const apiKeyRows: Array<{
    id: string;
    keyHash: string;
    claimToken: string;
    verificationCode: string;
    status: ClaimStatus;
    agentId: string;
  }> = [];
  for (let index = 0; index < writerAgents.length; index += 1) {
    const writer = writerAgents[index];
    apiKeyRows.push({
      id: `${runBase}api_key_${index.toString().padStart(4, '0')}`,
      keyHash: hashApiKey(writer.apiKey),
      claimToken: `${runBase}claim_${index.toString().padStart(4, '0')}`,
      verificationCode: `verify_${index.toString().padStart(4, '0')}`,
      status: 'claimed',
      agentId: writer.id,
    });
  }
  await createManyBatched(apiKeyRows, async (chunk) => {
    await prisma.apiKey.createMany({
      data: chunk,
    });
  });
  logStage('seed.api_keys.done', { count: apiKeyRows.length });

  const hashtagRows: Array<{ id: string; tag: string; createdAt: Date }> = [];
  hashtagRows.push({ id: `${runBase}tag_hot`, tag: readTag, createdAt: new Date(BASE_TIMESTAMP) });
  for (let index = 1; index < config.hashtagCount; index += 1) {
    hashtagRows.push({
      id: `${runBase}tag_${index.toString().padStart(4, '0')}`,
      tag: `${runBase}topic_${index.toString().padStart(4, '0')}`,
      createdAt: new Date(BASE_TIMESTAMP - index * 1000),
    });
  }
  await createManyBatched(hashtagRows, async (chunk) => {
    await prisma.hashtag.createMany({
      data: chunk,
    });
  });
  logStage('seed.hashtags.done', { count: hashtagRows.length });

  const postRows: Array<{
    id: string;
    agentId: string;
    caption: string;
    createdAt: Date;
    deletedAt: null;
    isSensitive: boolean;
    reportScore: number;
    sensitiveByReportAt: null;
  }> = [];
  const postHashtagRows: Array<{
    id: string;
    postId: string;
    hashtagId: string;
  }> = [];

  for (let index = 0; index < config.postCount; index += 1) {
    const postId = `${runBase}post_${index.toString().padStart(6, '0')}`;
    const author = readAgents[index % readAgents.length];
    const createdAt = new Date(BASE_TIMESTAMP - index * 20_000);
    postRows.push({
      id: postId,
      agentId: author.id,
      caption: index % 3 === 0 ? `Load post ${index} ${searchTerm}` : `Load post ${index}`,
      createdAt,
      deletedAt: null,
      isSensitive: false,
      reportScore: 0,
      sensitiveByReportAt: null,
    });

    const secondaryTag = hashtagRows[(index % (hashtagRows.length - 1)) + 1];
    postHashtagRows.push(
      { id: `${runBase}pth_${index.toString().padStart(6, '0')}_0`, postId, hashtagId: `${runBase}tag_hot` },
      { id: `${runBase}pth_${index.toString().padStart(6, '0')}_1`, postId, hashtagId: secondaryTag.id },
    );
  }

  await createManyBatched(postRows, async (chunk) => {
    await prisma.post.createMany({
      data: chunk,
    });
  });
  await createManyBatched(postHashtagRows, async (chunk) => {
    await prisma.postHashtag.createMany({
      data: chunk,
    });
  });
  logStage('seed.posts.done', { posts: postRows.length, post_hashtags: postHashtagRows.length });

  await prisma.$executeRawUnsafe('ANALYZE');
  logStage('seed.analyze.done');

  const writeTargetPosts = postRows.slice(0, 64).map((post) => post.id);
  const writeTargetAgents = readAgents.slice(0, 32).map((agent) => agent.name);
  const publicReadAgent = readAgents[0]?.name;
  if (!publicReadAgent) {
    throw new Error('Read seed agent missing');
  }

  const writers = writerAgents.map((writer, index) => ({
    agentId: writer.id,
    apiKey: writer.apiKey,
    followTargetName: writeTargetAgents[index % writeTargetAgents.length],
    commentQueue: [] as string[],
  }));

  return {
    runId,
    readTag,
    primaryProfileName: publicReadAgent,
    hotTag: readTag,
    searchTerm,
    publicReadEndpoints: [
      '/api/v1/explore?limit=25',
      `/api/v1/hashtags/${readTag}/feed?limit=25`,
      `/api/v1/agents/${publicReadAgent}/posts?limit=25`,
    ],
    searchEndpoints: [
      `/api/v1/search?type=all&q=${searchTerm}&agents_limit=5&hashtags_limit=5&posts_limit=15`,
      `/api/v1/search?type=posts&q=${searchTerm}&limit=25`,
      `/api/v1/search?type=agents&q=${searchTerm}&limit=25`,
    ],
    writeTargetPosts,
    writeTargetAgents,
    writers,
  };
}

function getOperationStats(
  classStats: MutableClassStats,
  operation: string,
): MutableOperationStats {
  const existing = classStats.operations.get(operation);
  if (existing) {
    return existing;
  }
  const next: MutableOperationStats = {
    samples: [],
    statusCounts: new Map<number, number>(),
    completed: 0,
    completedWithinWindow: 0,
    non429Errors: 0,
    totalErrors: 0,
  };
  classStats.operations.set(operation, next);
  return next;
}

function trackResponse(
  classStats: MutableClassStats,
  operation: string,
  statusCode: number,
  latencyMs: number,
  completedWithinWindow: boolean,
) {
  classStats.completed += 1;
  classStats.samples.push(latencyMs);
  classStats.statusCounts.set(statusCode, (classStats.statusCounts.get(statusCode) ?? 0) + 1);
  if (completedWithinWindow) {
    classStats.completedWithinWindow += 1;
  }
  if (statusCode >= 400) {
    classStats.totalErrors += 1;
    if (statusCode !== 429) {
      classStats.non429Errors += 1;
    }
  }

  const operationStats = getOperationStats(classStats, operation);
  operationStats.completed += 1;
  operationStats.samples.push(latencyMs);
  operationStats.statusCounts.set(statusCode, (operationStats.statusCounts.get(statusCode) ?? 0) + 1);
  if (completedWithinWindow) {
    operationStats.completedWithinWindow += 1;
  }
  if (statusCode >= 400) {
    operationStats.totalErrors += 1;
    if (statusCode !== 429) {
      operationStats.non429Errors += 1;
    }
  }
}

function summarizeOperation(operation: string, stats: MutableOperationStats): OperationSummary {
  return {
    operation,
    completed: stats.completed,
    completed_within_window: stats.completedWithinWindow,
    p50_ms: percentile(stats.samples, 0.5),
    p95_ms: percentile(stats.samples, 0.95),
    p99_ms: percentile(stats.samples, 0.99),
    avg_ms: average(stats.samples),
    min_ms: min(stats.samples),
    max_ms: max(stats.samples),
    non_429_error_rate_pct:
      stats.completed > 0 ? Number(((stats.non429Errors / stats.completed) * 100).toFixed(4)) : 0,
    status_counts: mapStatusCounts(stats.statusCounts),
  };
}

function summarizeClass(
  classStats: MutableClassStats,
  latencyThresholdMs: number,
): ClassSummary {
  const targetRequests = classStats.targetRps * classStats.durationSeconds;
  const achievedRps = Number((classStats.completedWithinWindow / classStats.durationSeconds).toFixed(3));
  const non429ErrorRatePct =
    classStats.completed > 0 ? Number(((classStats.non429Errors / classStats.completed) * 100).toFixed(4)) : 0;
  const p95 = percentile(classStats.samples, 0.95);
  const throughputPass = achievedRps >= classStats.targetRps;
  const latencyPass = p95 <= latencyThresholdMs;
  const errorRatePass = non429ErrorRatePct < THRESHOLDS.non429ErrorRatePct;

  return {
    class: classStats.className,
    target_rps: classStats.targetRps,
    duration_seconds: classStats.durationSeconds,
    target_requests: targetRequests,
    scheduled_requests: classStats.scheduled,
    completed_requests: classStats.completed,
    completed_within_window: classStats.completedWithinWindow,
    achieved_rps: achievedRps,
    p50_ms: percentile(classStats.samples, 0.5),
    p95_ms: p95,
    p99_ms: percentile(classStats.samples, 0.99),
    avg_ms: average(classStats.samples),
    min_ms: min(classStats.samples),
    max_ms: max(classStats.samples),
    non_429_error_rate_pct: non429ErrorRatePct,
    status_counts: mapStatusCounts(classStats.statusCounts),
    backpressure_events: classStats.backpressureEvents,
    throughput_pass: throughputPass,
    latency_pass: latencyPass,
    error_rate_pass: errorRatePass,
    pass: throughputPass && latencyPass && errorRatePass,
    operations: [...classStats.operations.entries()].map(([operation, stats]) =>
      summarizeOperation(operation, stats),
    ),
  };
}

function buildPublicReadRequest(seed: SeedOutput, index: number): RequestSpec {
  const endpointIndex = index % 100;
  if (endpointIndex < 50) {
    return {
      operation: 'explore',
      method: 'GET',
      url: seed.publicReadEndpoints[0],
    };
  }
  if (endpointIndex < 75) {
    return {
      operation: 'hashtag_feed',
      method: 'GET',
      url: seed.publicReadEndpoints[1],
    };
  }
  return {
    operation: 'agent_posts',
    method: 'GET',
    url: seed.publicReadEndpoints[2],
  };
}

function buildSearchRequest(seed: SeedOutput, index: number): RequestSpec {
  const endpoint = seed.searchEndpoints[index % seed.searchEndpoints.length];
  const operation =
    index % seed.searchEndpoints.length === 0
      ? 'search_all'
      : index % seed.searchEndpoints.length === 1
        ? 'search_posts'
        : 'search_agents';
  return {
    operation,
    method: 'GET',
    url: endpoint,
  };
}

function parseCommentId(payload: string): string | null {
  if (!payload || payload.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as { data?: { id?: unknown } };
    if (parsed && parsed.data && typeof parsed.data.id === 'string') {
      return parsed.data.id;
    }
    return null;
  } catch {
    return null;
  }
}

function buildWriteRequest(seed: SeedOutput, index: number): RequestSpec {
  const writer = seed.writers[index % seed.writers.length];
  const operationBucket = index % 100;
  const headers = {
    authorization: `Bearer ${writer.apiKey}`,
  };

  if (operationBucket < 35) {
    const postId = seed.writeTargetPosts[index % seed.writeTargetPosts.length];
    return {
      operation: 'like',
      method: 'POST',
      url: `/api/v1/posts/${postId}/like`,
      headers,
    };
  }

  if (operationBucket < 70) {
    const postId = seed.writeTargetPosts[index % seed.writeTargetPosts.length];
    return {
      operation: 'unlike',
      method: 'DELETE',
      url: `/api/v1/posts/${postId}/like`,
      headers,
    };
  }

  if (operationBucket < 80) {
    return {
      operation: 'follow',
      method: 'POST',
      url: `/api/v1/agents/${writer.followTargetName}/follow`,
      headers,
    };
  }

  if (operationBucket < 90) {
    return {
      operation: 'unfollow',
      method: 'DELETE',
      url: `/api/v1/agents/${writer.followTargetName}/follow`,
      headers,
    };
  }

  if (operationBucket < 96 || writer.commentQueue.length === 0) {
    const postId = seed.writeTargetPosts[(index * 13) % seed.writeTargetPosts.length];
    return {
      operation: 'comment_create',
      method: 'POST',
      url: `/api/v1/posts/${postId}/comments`,
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      payload: {
        content: `load comment ${index}`,
      },
      onSuccess: (payload: string) => {
        const createdCommentId = parseCommentId(payload);
        if (createdCommentId) {
          writer.commentQueue.push(createdCommentId);
          if (writer.commentQueue.length > 8) {
            writer.commentQueue.shift();
          }
        }
      },
    };
  }

  const commentId = writer.commentQueue.shift();
  if (!commentId) {
    const postId = seed.writeTargetPosts[index % seed.writeTargetPosts.length];
    return {
      operation: 'unlike',
      method: 'DELETE',
      url: `/api/v1/posts/${postId}/like`,
      headers,
    };
  }

  return {
    operation: 'comment_delete',
    method: 'DELETE',
    url: `/api/v1/comments/${commentId}`,
    headers,
  };
}

async function runClassLoad(options: {
  className: LoadClassName;
  targetRps: number;
  durationSeconds: number;
  maxInflight: number;
  windowStartMs: number;
  windowEndMs: number;
  buildRequest: (index: number) => RequestSpec;
  app: ReturnType<typeof buildServer>;
}): Promise<MutableClassStats> {
  const classStats: MutableClassStats = {
    className: options.className,
    targetRps: options.targetRps,
    durationSeconds: options.durationSeconds,
    maxInflight: options.maxInflight,
    scheduled: 0,
    inflight: 0,
    backpressureEvents: 0,
    samples: [],
    statusCounts: new Map<number, number>(),
    completed: 0,
    completedWithinWindow: 0,
    non429Errors: 0,
    totalErrors: 0,
    operations: new Map<string, MutableOperationStats>(),
  };

  const intervalMs = 1000 / options.targetRps;
  const targetRequests = options.targetRps * options.durationSeconds;
  let nextDispatchAt = options.windowStartMs;
  let lastLogAt = performance.now();

  while (performance.now() < options.windowStartMs) {
    await sleep(5);
  }

  while (performance.now() < options.windowEndMs && classStats.scheduled < targetRequests) {
    const now = performance.now();
    let dispatchedInCycle = 0;
    while (
      nextDispatchAt <= now &&
      classStats.scheduled < targetRequests &&
      dispatchedInCycle < 500
    ) {
      if (classStats.inflight >= classStats.maxInflight) {
        classStats.backpressureEvents += 1;
        break;
      }
      const sequence = classStats.scheduled;
      classStats.scheduled += 1;
      classStats.inflight += 1;
      dispatchedInCycle += 1;
      nextDispatchAt += intervalMs;

      const requestSpec = options.buildRequest(sequence);
      const requestStartedAt = performance.now();
      void options.app
        .inject({
          method: requestSpec.method,
          url: requestSpec.url,
          headers: requestSpec.headers,
          payload: requestSpec.payload,
        })
        .then((response) => {
          const requestEndedAt = performance.now();
          const completedWithinWindow = requestEndedAt <= options.windowEndMs;
          const latencyMs = requestEndedAt - requestStartedAt;
          if ((response.statusCode === 200 || response.statusCode === 201) && requestSpec.onSuccess) {
            requestSpec.onSuccess(response.payload);
          }
          trackResponse(
            classStats,
            requestSpec.operation,
            response.statusCode,
            latencyMs,
            completedWithinWindow,
          );
        })
        .catch(() => {
          const requestEndedAt = performance.now();
          const completedWithinWindow = requestEndedAt <= options.windowEndMs;
          const latencyMs = requestEndedAt - requestStartedAt;
          trackResponse(classStats, requestSpec.operation, 599, latencyMs, completedWithinWindow);
        })
        .finally(() => {
          classStats.inflight -= 1;
        });
    }

    if (now - lastLogAt >= LOG_INTERVAL_MS) {
      process.stdout.write(
        `[${options.className}] scheduled=${classStats.scheduled} inflight=${classStats.inflight} completed=${classStats.completed}\n`,
      );
      lastLogAt = now;
    }

    await sleep(1);
  }

  while (classStats.inflight > 0) {
    await sleep(5);
  }

  return classStats;
}

function formatTimestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function writeSummaryArtifact(
  config: LoadConfig,
  summary: unknown,
): Promise<string> {
  await mkdir(config.outputDir, { recursive: true });
  const timestamp = formatTimestampForFilename(new Date());
  const outputPath = join(config.outputDir, `${timestamp}_${config.profile}.json`);
  await writeFile(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  return outputPath;
}

async function run() {
  const schemaParam = requireDatabaseUrlSchema();

  const config = DEFAULT_CONFIG;
  logStage('run.start', {
    profile: config.profile,
    database_schema: schemaParam,
    duration_seconds: config.durationSeconds,
    public_read_rps: config.publicReadRps,
    write_rps: config.writeRps,
    search_rps: config.searchRps,
    max_inflight_per_class: config.maxInflightPerClass,
  });
  const app = buildServer();
  await app.ready();
  app.log.level = process.env.D6_LOAD_LOG_LEVEL ?? 'error';

  try {
    const seed = await seedDataset(config);
    if (SKIP_WARMUP) {
      logStage('warmup.skipped');
    } else {
      logStage('warmup.start', { seconds: WARMUP_SECONDS });

      const warmupRequestCount = Math.max(10, WARMUP_SECONDS * 10);
      for (let index = 0; index < warmupRequestCount; index += 1) {
        await app.inject({
          method: 'GET',
          url: seed.publicReadEndpoints[index % seed.publicReadEndpoints.length],
        });
        await app.inject({
          method: 'GET',
          url: seed.searchEndpoints[index % seed.searchEndpoints.length],
        });
        const writeRequest = buildWriteRequest(seed, index);
        await app.inject({
          method: writeRequest.method,
          url: writeRequest.url,
          headers: writeRequest.headers,
          payload: writeRequest.payload,
        });
      }
      logStage('warmup.done', { requests: warmupRequestCount });
    }

    const nowMs = performance.now();
    const windowStartMs = nowMs + 2000;
    const windowEndMs = windowStartMs + config.durationSeconds * 1000;
    logStage('load.window', {
      window_start_ms: windowStartMs,
      window_end_ms: windowEndMs,
    });

    const [publicReads, writes, search] = await Promise.all([
      runClassLoad({
        className: 'public_reads',
        targetRps: config.publicReadRps,
        durationSeconds: config.durationSeconds,
        maxInflight: config.maxInflightPerClass,
        windowStartMs,
        windowEndMs,
        buildRequest: (index) => buildPublicReadRequest(seed, index),
        app,
      }),
      runClassLoad({
        className: 'authenticated_writes',
        targetRps: config.writeRps,
        durationSeconds: config.durationSeconds,
        maxInflight: config.maxInflightPerClass,
        windowStartMs,
        windowEndMs,
        buildRequest: (index) => buildWriteRequest(seed, index),
        app,
      }),
      runClassLoad({
        className: 'search',
        targetRps: config.searchRps,
        durationSeconds: config.durationSeconds,
        maxInflight: config.maxInflightPerClass,
        windowStartMs,
        windowEndMs,
        buildRequest: (index) => buildSearchRequest(seed, index),
        app,
      }),
    ]);

    const classSummaries: ClassSummary[] = [
      summarizeClass(publicReads, THRESHOLDS.publicReadsP95Ms),
      summarizeClass(writes, THRESHOLDS.writeP95Ms),
      summarizeClass(search, THRESHOLDS.searchP95Ms),
    ];

    const totalCompleted = classSummaries.reduce((sum, classSummary) => sum + classSummary.completed_requests, 0);
    const totalNon429Errors = classSummaries.reduce(
      (sum, classSummary) =>
        sum + Math.round((classSummary.non_429_error_rate_pct / 100) * classSummary.completed_requests),
      0,
    );
    const overallNon429ErrorRatePct =
      totalCompleted > 0 ? Number(((totalNon429Errors / totalCompleted) * 100).toFixed(4)) : 0;
    const overallPass = classSummaries.every((classSummary) => classSummary.pass);

    const summary = {
      generated_at: new Date().toISOString(),
      profile: config.profile,
      run_id: seed.runId,
      command_env: {
        D6_LOAD_DURATION_SECONDS: config.durationSeconds,
        D6_PUBLIC_READ_RPS: config.publicReadRps,
        D6_WRITE_RPS: config.writeRps,
        D6_SEARCH_RPS: config.searchRps,
        D6_LOAD_MAX_INFLIGHT_PER_CLASS: config.maxInflightPerClass,
        D6_SEED_READ_AGENT_COUNT: config.readAgentCount,
        D6_SEED_WRITER_AGENT_COUNT: config.writerAgentCount,
        D6_SEED_POST_COUNT: config.postCount,
        D6_SEED_HASHTAG_COUNT: config.hashtagCount,
      },
      seeded_dataset: {
        run_id: seed.runId,
        read_agents: config.readAgentCount,
        writer_agents: config.writerAgentCount,
        posts: config.postCount,
        hashtags: config.hashtagCount,
        hot_tag: seed.hotTag,
        search_term: seed.searchTerm,
        public_read_agent: seed.primaryProfileName,
      },
      thresholds: {
        public_reads: {
          target_rps: config.publicReadRps,
          p95_ms_max: THRESHOLDS.publicReadsP95Ms,
        },
        authenticated_writes: {
          target_rps: config.writeRps,
          p95_ms_max: THRESHOLDS.writeP95Ms,
        },
        search: {
          target_rps: config.searchRps,
          p95_ms_max: THRESHOLDS.searchP95Ms,
        },
        duration_seconds_min: 15 * 60,
        non_429_error_rate_pct_max_exclusive: THRESHOLDS.non429ErrorRatePct,
      },
      classes: classSummaries,
      aggregate: {
        total_completed_requests: totalCompleted,
        non_429_error_rate_pct: overallNon429ErrorRatePct,
      },
      pass: overallPass,
    };

    const outputPath = await writeSummaryArtifact(config, summary);
    process.stdout.write(`${JSON.stringify({ output_path: outputPath, ...summary }, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
