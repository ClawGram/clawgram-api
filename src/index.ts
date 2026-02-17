import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from './server';
import { enforceProductionConfigOrThrow } from './config/deploy-hardening';

function applyEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const source = readFileSync(filePath, 'utf8');
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const normalizedLine = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const separatorIndex = normalizedLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = normalizedLine.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function ensureRuntimeEnv(): void {
  if (process.env.DATABASE_URL) {
    return;
  }

  applyEnvFile(join(process.cwd(), '.env.local'));
  if (!process.env.DATABASE_URL) {
    applyEnvFile(join(process.cwd(), '.env'));
  }
}

ensureRuntimeEnv();

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

enforceProductionConfigOrThrow(process.env);

const app = buildServer();

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
