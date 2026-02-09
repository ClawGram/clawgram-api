import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type SetupConfig = {
  schema: string;
  outputDir: string;
  apply: boolean;
};

const DEFAULT_SCHEMA = process.env.D6_LOAD_SCHEMA ?? 'd6_load';
const OUTPUT_DIR = process.env.D6_LOAD_OUTPUT_DIR ?? 'artifacts/wave4-load';
const APPLY = process.env.D6_LOAD_SETUP_APPLY === '1';

function formatTimestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isPostgresUrl(value: string): boolean {
  return value.startsWith('postgresql://') || value.startsWith('postgres://');
}

function requireDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is required');
  }
  if (!isPostgresUrl(raw)) {
    throw new Error('DATABASE_URL must be a postgres connection string');
  }
  return new URL(raw);
}

async function buildCombinedSql(schema: string): Promise<string> {
  const migrations = [
    'prisma/migrations/20260209143000_init/migration.sql',
    'prisma/migrations/20260209165000_wave2_social_contract/migration.sql',
    'prisma/migrations/20260209203000_wave3_feed_search_indexes/migration.sql',
    'prisma/migrations/20260209224500_wave4_read_path_perf_indexes/migration.sql',
  ];

  const chunks: string[] = [];
  chunks.push(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);
  // Keep `public` in the search_path so extension-provided objects (e.g. `gin_trgm_ops`) resolve.
  chunks.push(`SET search_path TO "${schema}", public;`);
  chunks.push('');

  for (const migrationPath of migrations) {
    const absolute = resolve(migrationPath);
    const raw = await readFile(absolute, 'utf8');
    const sanitized = stripUtf8Bom(raw);
    chunks.push(`-- BEGIN ${migrationPath}`);
    chunks.push(sanitized.trimEnd());
    chunks.push(`-- END ${migrationPath}`);
    chunks.push('');
  }

  return `${chunks.join('\n')}\n`;
}

function runPsql(options: { url: URL; sqlFile: string }): Promise<void> {
  const user = decodeURIComponent(options.url.username);
  const password = decodeURIComponent(options.url.password);
  const host = options.url.hostname;
  const port = options.url.port ? Number(options.url.port) : 5432;
  const dbName = options.url.pathname.replace(/^\//, '') || 'postgres';

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'psql',
      ['-h', host, '-p', String(port), '-U', user, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', options.sqlFile],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          PGPASSWORD: password,
        },
      },
    );

    child.on('error', (err) => rejectPromise(err));
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`psql exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function run() {
  const config: SetupConfig = {
    schema: DEFAULT_SCHEMA,
    outputDir: OUTPUT_DIR,
    apply: APPLY,
  };

  const sql = await buildCombinedSql(config.schema);

  await mkdir(config.outputDir, { recursive: true });
  const outputPath = join(config.outputDir, `${formatTimestampForFilename(new Date())}_schema_setup_${config.schema}.sql`);
  await writeFile(outputPath, sql, 'utf8');

  if (config.apply) {
    const url = requireDatabaseUrl();
    await runPsql({ url, sqlFile: outputPath });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        schema: config.schema,
        output_path: outputPath,
        applied: config.apply,
      },
      null,
      2,
    )}\n`,
  );
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
