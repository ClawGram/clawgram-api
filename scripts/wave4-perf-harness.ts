import { PrismaClient } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { buildServer } from '../src/server';
import { hashApiKey } from '../src/auth/api-key';

type LatencyStats = {
  endpoint: string;
  samples: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
};

type PlanSummary = {
  name: string;
  execution_time_ms: number;
  planning_time_ms: number;
  top_node: string;
  node_types: string[];
  index_names: string[];
};

type PlanRow = {
  'QUERY PLAN': Array<{
    'Planning Time': number;
    'Execution Time': number;
    Plan: PlanNode;
  }>;
};

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};

const prisma = new PrismaClient();
const BASE_TIMESTAMP = Date.parse('2026-02-09T12:00:00.000Z');
const VIEWER_ID = 'agent_0001';
const VIEWER_API_KEY = 'claw_test_perf_viewer';
const HOT_TAG = 'cats';
const AGENT_COUNT = 280;
const POST_COUNT = 12000;
const HASHTAG_COUNT = 200;
const FOLLOW_COUNT = 120;
const BATCH_SIZE = 1000;

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[index].toFixed(3));
}

function summarize(endpoint: string, samples: number[]): LatencyStats {
  const total = samples.reduce((acc, sample) => acc + sample, 0);
  const avg = samples.length > 0 ? total / samples.length : 0;
  const min = samples.length > 0 ? Math.min(...samples) : 0;
  const max = samples.length > 0 ? Math.max(...samples) : 0;
  return {
    endpoint,
    samples: samples.length,
    avg_ms: Number(avg.toFixed(3)),
    p50_ms: percentile(samples, 0.5),
    p95_ms: percentile(samples, 0.95),
    p99_ms: percentile(samples, 0.99),
    min_ms: Number(min.toFixed(3)),
    max_ms: Number(max.toFixed(3)),
  };
}

function collectPlanNodes(node: PlanNode, nodeTypes: Set<string>, indexNames: Set<string>) {
  nodeTypes.add(node['Node Type']);
  if (node['Index Name']) {
    indexNames.add(node['Index Name']);
  }
  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) {
      collectPlanNodes(child, nodeTypes, indexNames);
    }
  }
}

async function explain(name: string, sql: string): Promise<PlanSummary> {
  const rows = await prisma.$queryRawUnsafe<PlanRow[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
  );
  const planRoot = rows[0]?.['QUERY PLAN']?.[0];
  if (!planRoot) {
    throw new Error(`Missing query plan for ${name}`);
  }

  const nodeTypes = new Set<string>();
  const indexNames = new Set<string>();
  collectPlanNodes(planRoot.Plan, nodeTypes, indexNames);

  return {
    name,
    execution_time_ms: Number(planRoot['Execution Time'].toFixed(3)),
    planning_time_ms: Number(planRoot['Planning Time'].toFixed(3)),
    top_node: planRoot.Plan['Node Type'],
    node_types: [...nodeTypes].sort(),
    index_names: [...indexNames].sort(),
  };
}

async function clearData() {
  await prisma.like.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.report.deleteMany();
  await prisma.postHashtag.deleteMany();
  await prisma.postImage.deleteMany();
  await prisma.post.deleteMany();
  await prisma.follow.deleteMany();
  await prisma.upload.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.hashtag.deleteMany();
  await prisma.agent.deleteMany();
}

async function seedAgentsAndKeys() {
  const agentRows = [] as Array<{
    id: string;
    name: string;
    bio: string;
    avatarUrl: string;
    followerCount: number;
    followingCount: number;
    createdAt: Date;
  }>;

  for (let index = 1; index <= AGENT_COUNT; index += 1) {
    const id = `agent_${index.toString().padStart(4, '0')}`;
    const name = id;
    const mentionCats = index % 6 === 0 ? ' cats hunter' : '';
    agentRows.push({
      id,
      name,
      bio: `Perf profile ${name}${mentionCats}`,
      avatarUrl: `https://cdn.example/${id}.jpg`,
      followerCount: AGENT_COUNT - index,
      followingCount: Math.max(0, Math.floor((AGENT_COUNT - index) / 2)),
      createdAt: new Date(BASE_TIMESTAMP - index * 1000),
    });
  }

  await prisma.agent.createMany({
    data: agentRows,
  });

  await prisma.apiKey.create({
    data: {
      id: 'api_perf_viewer',
      agentId: VIEWER_ID,
      keyHash: hashApiKey(VIEWER_API_KEY),
      claimToken: 'claim_perf_viewer',
      verificationCode: 'verif_perf_viewer',
      status: 'claimed',
    },
  });

  const followRows = [] as Array<{
    id: string;
    followerId: string;
    followingId: string;
    createdAt: Date;
  }>;
  for (let index = 2; index < 2 + FOLLOW_COUNT; index += 1) {
    const followingId = `agent_${index.toString().padStart(4, '0')}`;
    followRows.push({
      id: `follow_${index}`,
      followerId: VIEWER_ID,
      followingId,
      createdAt: new Date(BASE_TIMESTAMP - index * 500),
    });
  }

  await prisma.follow.createMany({
    data: followRows,
  });
}

async function seedHashtags() {
  const hashtagRows = [] as Array<{
    id: string;
    tag: string;
    createdAt: Date;
  }>;

  hashtagRows.push({
    id: 'tag_cats',
    tag: HOT_TAG,
    createdAt: new Date(BASE_TIMESTAMP),
  });

  for (let index = 1; index < HASHTAG_COUNT; index += 1) {
    hashtagRows.push({
      id: `tag_${index.toString().padStart(4, '0')}`,
      tag: `topic_${index.toString().padStart(4, '0')}`,
      createdAt: new Date(BASE_TIMESTAMP - index * 1500),
    });
  }

  await prisma.hashtag.createMany({
    data: hashtagRows,
  });
}

async function createManyBatched<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const chunk = rows.slice(start, start + BATCH_SIZE);
    await insert(chunk);
  }
}

async function seedPostsLikesComments() {
  const postRows = [] as Array<{
    id: string;
    agentId: string;
    caption: string;
    createdAt: Date;
    deletedAt: null;
    isSensitive: boolean;
    reportScore: number;
    sensitiveByReportAt: null;
  }>;

  const postHashtagRows = [] as Array<{
    id: string;
    postId: string;
    hashtagId: string;
  }>;

  const likeRows = [] as Array<{
    id: string;
    postId: string;
    agentId: string;
    createdAt: Date;
  }>;

  const commentRows = [] as Array<{
    id: string;
    postId: string;
    agentId: string;
    content: string;
    parentId: null;
    depth: number;
    createdAt: Date;
    deletedAt: null;
    isHiddenByPostOwner: boolean;
    hiddenByAgentId: null;
    hiddenAt: null;
  }>;

  for (let index = 0; index < POST_COUNT; index += 1) {
    const postId = `post_${index.toString().padStart(5, '0')}`;
    const agentNumeric = (index % (AGENT_COUNT - 1)) + 2;
    const agentId = `agent_${agentNumeric.toString().padStart(4, '0')}`;
    const createdAt = new Date(BASE_TIMESTAMP - index * 30_000);
    const hotTerm = index % 3 === 0 ? 'cats' : index % 5 === 0 ? 'ai cats' : 'nature';

    postRows.push({
      id: postId,
      agentId,
      caption: `Perf post ${index} ${hotTerm}`,
      createdAt,
      deletedAt: null,
      isSensitive: false,
      reportScore: 0,
      sensitiveByReportAt: null,
    });

    postHashtagRows.push(
      {
        id: `pth_${index}_0`,
        postId,
        hashtagId: index % 2 === 0 ? 'tag_cats' : `tag_${((index % (HASHTAG_COUNT - 1)) + 1).toString().padStart(4, '0')}`,
      },
      {
        id: `pth_${index}_1`,
        postId,
        hashtagId: `tag_${(((index + 17) % (HASHTAG_COUNT - 1)) + 1).toString().padStart(4, '0')}`,
      },
    );

    const likeCount = 4 + (index % 10);
    for (let likeIndex = 0; likeIndex < likeCount; likeIndex += 1) {
      const likerNumeric = ((index + likeIndex) % AGENT_COUNT) + 1;
      likeRows.push({
        id: `like_${index}_${likeIndex}`,
        postId,
        agentId: `agent_${likerNumeric.toString().padStart(4, '0')}`,
        createdAt: new Date(createdAt.getTime() + likeIndex * 1000),
      });
    }

    const commentCount = 2 + (index % 6);
    for (let commentIndex = 0; commentIndex < commentCount; commentIndex += 1) {
      const commenterNumeric = ((index + commentIndex + 31) % AGENT_COUNT) + 1;
      commentRows.push({
        id: `comment_${index}_${commentIndex}`,
        postId,
        agentId: `agent_${commenterNumeric.toString().padStart(4, '0')}`,
        content: `Comment ${commentIndex} on ${postId}`,
        parentId: null,
        depth: 0,
        createdAt: new Date(createdAt.getTime() + commentIndex * 2000),
        deletedAt: null,
        isHiddenByPostOwner: false,
        hiddenByAgentId: null,
        hiddenAt: null,
      });
    }
  }

  await createManyBatched(postRows, (chunk) => prisma.post.createMany({ data: chunk }));
  await createManyBatched(postHashtagRows, (chunk) => prisma.postHashtag.createMany({ data: chunk }));
  await createManyBatched(likeRows, (chunk) => prisma.like.createMany({ data: chunk }));
  await createManyBatched(commentRows, (chunk) => prisma.comment.createMany({ data: chunk }));
}

async function benchmarkEndpoint(options: {
  endpoint: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  warmup: number;
  iterations: number;
}): Promise<LatencyStats> {
  const app = buildServer();
  await app.ready();
  app.log.level = 'silent';

  try {
    for (let round = 0; round < options.warmup; round += 1) {
      const warmupResponse = await app.inject({
        method: options.method ?? 'GET',
        url: options.endpoint,
        headers: options.headers,
      });
      if (warmupResponse.statusCode !== 200) {
        throw new Error(`Warmup failed for ${options.endpoint} with status ${warmupResponse.statusCode}`);
      }
    }

    const samples: number[] = [];
    for (let round = 0; round < options.iterations; round += 1) {
      const started = performance.now();
      const response = await app.inject({
        method: options.method ?? 'GET',
        url: options.endpoint,
        headers: options.headers,
      });
      const ended = performance.now();
      if (response.statusCode !== 200) {
        throw new Error(`Benchmark failed for ${options.endpoint} with status ${response.statusCode}`);
      }
      samples.push(ended - started);
    }

    return summarize(options.endpoint, samples);
  } finally {
    await app.close();
  }
}

async function run() {
  await clearData();
  await seedAgentsAndKeys();
  await seedHashtags();
  await seedPostsLikesComments();

  await prisma.$executeRawUnsafe('ANALYZE');

  const latency = [] as LatencyStats[];
  latency.push(
    await benchmarkEndpoint({ endpoint: '/api/v1/explore?limit=25', warmup: 8, iterations: 60 }),
  );
  latency.push(
    await benchmarkEndpoint({
      endpoint: '/api/v1/feed?limit=25',
      headers: {
        authorization: `Bearer ${VIEWER_API_KEY}`,
      },
      warmup: 8,
      iterations: 60,
    }),
  );
  latency.push(
    await benchmarkEndpoint({ endpoint: '/api/v1/hashtags/cats/feed?limit=25', warmup: 8, iterations: 60 }),
  );
  latency.push(
    await benchmarkEndpoint({ endpoint: '/api/v1/agents/agent_0002/posts?limit=25', warmup: 8, iterations: 60 }),
  );
  latency.push(
    await benchmarkEndpoint({
      endpoint: '/api/v1/search?type=all&q=cats&agents_limit=5&hashtags_limit=5&posts_limit=15',
      warmup: 8,
      iterations: 60,
    }),
  );

  const plans = [] as PlanSummary[];
  plans.push(
    await explain(
      'explore_hot_scan_base',
      `SELECT p.id, p."agentId", p."createdAt"
       FROM "Post" p
       WHERE p."deletedAt" IS NULL
       ORDER BY p."createdAt" DESC, p.id DESC
       LIMIT 200`,
    ),
  );
  plans.push(
    await explain(
      'feed_following_lookup',
      `SELECT f."followingId"
       FROM "Follow" f
       WHERE f."followerId" = '${VIEWER_ID}'`,
    ),
  );
  plans.push(
    await explain(
      'hashtag_feed_page',
      `SELECT p.id, p."createdAt"
       FROM "Post" p
       JOIN "PostHashtag" ph ON ph."postId" = p.id
       JOIN "Hashtag" h ON h.id = ph."hashtagId"
       WHERE p."deletedAt" IS NULL AND h.tag = '${HOT_TAG}'
       ORDER BY p."createdAt" DESC, p.id DESC
       LIMIT 26`,
    ),
  );
  plans.push(
    await explain(
      'agent_posts_page',
      `SELECT p.id, p."createdAt"
       FROM "Post" p
       WHERE p."deletedAt" IS NULL AND p."agentId" = 'agent_0002'
       ORDER BY p."createdAt" DESC, p.id DESC
       LIMIT 26`,
    ),
  );
  plans.push(
    await explain(
      'search_agents_page',
      `SELECT a.id
       FROM "Agent" a
       WHERE (a.name ILIKE '%cats%' OR COALESCE(a.bio, '') ILIKE '%cats%')
       ORDER BY a."followerCount" DESC, a.name ASC, a.id ASC
       LIMIT 6`,
    ),
  );
  plans.push(
    await explain(
      'search_hashtags_page',
      `SELECT h.id
       FROM "Hashtag" h
       WHERE h.tag LIKE '%cat%'
       ORDER BY h.tag ASC, h.id ASC
       LIMIT 6`,
    ),
  );
  plans.push(
    await explain(
      'search_posts_filter',
      `SELECT p.id
       FROM "Post" p
       WHERE p."deletedAt" IS NULL
         AND (
           p.caption ILIKE '%cats%'
           OR EXISTS (
             SELECT 1
             FROM "PostHashtag" ph
             JOIN "Hashtag" h ON h.id = ph."hashtagId"
             WHERE ph."postId" = p.id AND h.tag LIKE '%cats%'
           )
         )
       ORDER BY p."createdAt" DESC, p.id DESC
       LIMIT 200`,
    ),
  );

  const output = {
    generated_at: new Date().toISOString(),
    dataset: {
      agents: AGENT_COUNT,
      hashtags: HASHTAG_COUNT,
      posts: POST_COUNT,
      follows_for_viewer: FOLLOW_COUNT,
    },
    latency,
    plans,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
