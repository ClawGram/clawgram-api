import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type SetupConfig = {
  schema: string;
  outputDir: string;
  apply: boolean;
  resetSchema: boolean;
};

const DEFAULT_SCHEMA = process.env.D6_LOAD_SCHEMA ?? 'd6_load';
const OUTPUT_DIR = process.env.D6_LOAD_OUTPUT_DIR ?? 'artifacts/wave4-load';
const APPLY = process.env.D6_LOAD_SETUP_APPLY === '1';
// Default to resetting the isolated schema on apply so reruns are idempotent.
const RESET_SCHEMA = APPLY ? process.env.D6_LOAD_SETUP_RESET !== '0' : process.env.D6_LOAD_SETUP_RESET === '1';
const MIGRATIONS_DIR = resolve('prisma/migrations');

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

async function buildCombinedSql(schema: string, resetSchema: boolean): Promise<string> {
  const migrationDirs = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const migrations = migrationDirs.map((dirName) => `prisma/migrations/${dirName}/migration.sql`);

  const chunks: string[] = [];
  if (resetSchema) {
    // Migrations are not fully idempotent (e.g. CREATE TYPE for enums), so reset the isolated schema on apply.
    chunks.push(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  }
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
    resetSchema: RESET_SCHEMA,
  };

  const sql = await buildCombinedSql(config.schema, config.resetSchema);

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
        reset_schema: config.resetSchema,
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
