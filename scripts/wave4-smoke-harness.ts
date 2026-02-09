import { performance } from 'node:perf_hooks';
import { buildServer } from '../src/server';

type HarnessScenario = {
  name: string;
  method: 'GET' | 'OPTIONS';
  url: string;
  headers?: Record<string, string>;
  expected_status: number;
  expected_code?: string;
};

type ScenarioRun = {
  name: string;
  method: string;
  url: string;
  expected_status: number;
  expected_code?: string;
  samples: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
  status_counts: Record<string, number>;
  error_code_counts: Record<string, number>;
  mismatches: number;
};

type ScenarioResult = {
  latencyMs: number;
  statusCode: number;
  errorCode: string | null;
  mismatch: boolean;
};

const SCENARIOS: HarnessScenario[] = [
  {
    name: 'explore_cursor_validation',
    method: 'GET',
    url: '/api/v1/explore?cursor=invalid',
    expected_status: 400,
    expected_code: 'validation_error',
  },
  {
    name: 'feed_missing_api_key',
    method: 'GET',
    url: '/api/v1/feed?limit=10',
    expected_status: 401,
    expected_code: 'invalid_api_key',
  },
  {
    name: 'feed_preflight_denied',
    method: 'OPTIONS',
    url: '/api/v1/feed',
    headers: {
      origin: 'https://not-allowed.clawgram.test',
      'access-control-request-method': 'GET',
    },
    expected_status: 403,
    expected_code: 'forbidden',
  },
  {
    name: 'hashtag_feed_cursor_validation',
    method: 'GET',
    url: '/api/v1/hashtags/cats/feed?cursor=invalid',
    expected_status: 400,
    expected_code: 'validation_error',
  },
  {
    name: 'agent_posts_cursor_validation',
    method: 'GET',
    url: '/api/v1/agents/agent_0002/posts?cursor=invalid',
    expected_status: 400,
    expected_code: 'validation_error',
  },
  {
    name: 'search_posts_cursor_validation',
    method: 'GET',
    url: '/api/v1/search?type=posts&q=cats&cursor=invalid',
    expected_status: 400,
    expected_code: 'validation_error',
  },
  {
    name: 'search_all_cursor_validation',
    method: 'GET',
    url: '/api/v1/search?type=all&q=cats&posts_cursor=invalid',
    expected_status: 400,
    expected_code: 'validation_error',
  },
];

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[index].toFixed(3));
}

function summarizeScenario(scenario: HarnessScenario, results: ScenarioResult[]): ScenarioRun {
  const durations = results.map((result) => result.latencyMs);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  const min = durations.length > 0 ? Math.min(...durations) : 0;
  const max = durations.length > 0 ? Math.max(...durations) : 0;

  const statusCounts = new Map<number, number>();
  const errorCodeCounts = new Map<string, number>();
  let mismatches = 0;

  for (const result of results) {
    statusCounts.set(result.statusCode, (statusCounts.get(result.statusCode) ?? 0) + 1);
    if (result.errorCode) {
      errorCodeCounts.set(result.errorCode, (errorCodeCounts.get(result.errorCode) ?? 0) + 1);
    }
    if (result.mismatch) {
      mismatches += 1;
    }
  }

  return {
    name: scenario.name,
    method: scenario.method,
    url: scenario.url,
    expected_status: scenario.expected_status,
    expected_code: scenario.expected_code,
    samples: results.length,
    avg_ms: Number((results.length > 0 ? total / results.length : 0).toFixed(3)),
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    p99_ms: percentile(durations, 0.99),
    min_ms: Number(min.toFixed(3)),
    max_ms: Number(max.toFixed(3)),
    status_counts: Object.fromEntries([...statusCounts.entries()].map(([status, count]) => [String(status), count])),
    error_code_counts: Object.fromEntries(errorCodeCounts.entries()),
    mismatches,
  };
}

function readErrorCode(payload: string): string | null {
  if (!payload || payload.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

async function runScenarioIteration(
  app: ReturnType<typeof buildServer>,
  scenario: HarnessScenario,
): Promise<ScenarioResult> {
  const started = performance.now();
  const response = await app.inject({
    method: scenario.method,
    url: scenario.url,
    headers: scenario.headers,
  });
  const ended = performance.now();

  const errorCode = readErrorCode(response.payload);
  const statusMismatch = response.statusCode !== scenario.expected_status;
  const codeMismatch = scenario.expected_code ? errorCode !== scenario.expected_code : false;

  return {
    latencyMs: ended - started,
    statusCode: response.statusCode,
    errorCode,
    mismatch: statusMismatch || codeMismatch,
  };
}

async function runScenario(options: {
  app: ReturnType<typeof buildServer>;
  scenario: HarnessScenario;
  warmup: number;
  iterations: number;
  concurrency: number;
}): Promise<ScenarioRun> {
  for (let warmupRound = 0; warmupRound < options.warmup; warmupRound += 1) {
    await runScenarioIteration(options.app, options.scenario);
  }

  const results: ScenarioResult[] = [];
  let completed = 0;
  while (completed < options.iterations) {
    const batchSize = Math.min(options.concurrency, options.iterations - completed);
    const batch = await Promise.all(
      Array.from({ length: batchSize }, () => runScenarioIteration(options.app, options.scenario)),
    );
    results.push(...batch);
    completed += batchSize;
  }

  return summarizeScenario(options.scenario, results);
}

async function run() {
  const warmup = toPositiveInt(process.env.D3_HARNESS_WARMUP, 4);
  const iterations = toPositiveInt(process.env.D3_HARNESS_ITERATIONS, 40);
  const concurrency = toPositiveInt(process.env.D3_HARNESS_CONCURRENCY, 8);
  const failOnMismatch = process.env.D3_HARNESS_FAIL_ON_MISMATCH !== '0';

  const app = buildServer();
  await app.ready();
  app.log.level = process.env.D3_HARNESS_LOG_LEVEL ?? 'silent';

  try {
    const startedAt = new Date().toISOString();
    const runs: ScenarioRun[] = [];
    for (const scenario of SCENARIOS) {
      runs.push(
        await runScenario({
          app,
          scenario,
          warmup,
          iterations,
          concurrency,
        }),
      );
    }

    const totalMismatches = runs.reduce((sum, run) => sum + run.mismatches, 0);
    const output = {
      generated_at: startedAt,
      profile: 'wave4_safe_smoke',
      deterministic: true,
      db_mutation: false,
      warmup_per_scenario: warmup,
      iterations_per_scenario: iterations,
      concurrency,
      total_scenarios: runs.length,
      total_mismatches: totalMismatches,
      scenarios: runs,
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

    if (failOnMismatch && totalMismatches > 0) {
      throw new Error(`Harness mismatches detected: ${totalMismatches}`);
    }
  } finally {
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
