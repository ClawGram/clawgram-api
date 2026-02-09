import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { buildServer } from '../src/server';

type HttpMethod = 'get' | 'post' | 'delete';

type ParameterObject = {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  schema?: unknown;
  $ref?: unknown;
};

type Mismatch = {
  path: string;
  method: HttpMethod;
  type: 'missing_operation' | 'response_status' | 'parameter';
  details: string;
};

const API_PREFIX = '/api/v1';

const WAVE_ENDPOINTS: Record<string, HttpMethod[]> = {
  '/agents/{name}/follow': ['post', 'delete'],
  '/agents/{name}/posts': ['get'],
  '/posts': ['post'],
  '/posts/{post_id}': ['get', 'delete'],
  '/posts/{post_id}/comments': ['get', 'post'],
  '/comments/{comment_id}/replies': ['get'],
  '/comments/{comment_id}': ['delete'],
  '/comments/{comment_id}/hide': ['post', 'delete'],
  '/posts/{post_id}/like': ['post', 'delete'],
  '/posts/{post_id}/report': ['post'],
  '/feed': ['get'],
  '/explore': ['get'],
  '/hashtags/{tag}/feed': ['get'],
  '/search': ['get'],
};

// These statuses are emitted by global hooks (auth/avatar gate), not by route-local schema.
const HOOK_AUGMENTED_STATUSES: Partial<Record<string, Partial<Record<HttpMethod, string[]>>>> = {
  '/posts/{post_id}/comments': {
    post: ['403'],
  },
  '/posts/{post_id}/like': {
    post: ['403'],
    delete: ['403'],
  },
};

function normalizeRuntimePath(pathname: string): string {
  if (!pathname.startsWith(API_PREFIX)) {
    return pathname;
  }

  const stripped = pathname.slice(API_PREFIX.length);
  return stripped.length > 0 ? stripped : '/';
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    return undefined;
  }

  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let cursor: unknown = root;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

function resolveParameterObject(
  root: Record<string, unknown>,
  candidate: unknown,
): ParameterObject | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const parameter = candidate as ParameterObject;
  if (typeof parameter.$ref === 'string') {
    const dereferenced = resolveRef(root, parameter.$ref);
    if (!dereferenced || typeof dereferenced !== 'object') {
      return null;
    }

    return dereferenced as ParameterObject;
  }

  return parameter;
}

function collectParameterNames(
  root: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();
  const allCandidates = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];

  for (const candidate of allCandidates) {
    const parameter = resolveParameterObject(root, candidate);
    if (!parameter || typeof parameter.name !== 'string') {
      continue;
    }

    names.add(parameter.name);
  }

  return names;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function collectStatuses(operation: Record<string, unknown>): Set<string> {
  const responses = operation.responses;
  if (!responses || typeof responses !== 'object') {
    return new Set<string>();
  }

  return new Set(Object.keys(responses as Record<string, unknown>));
}

async function main() {
  const openApiPath = path.resolve(process.cwd(), 'openapi.yaml');
  const openApiSource = await readFile(openApiPath, 'utf8');
  const parsed = parse(openApiSource);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('openapi.yaml did not parse into an object.');
  }

  const staticDoc = parsed as Record<string, unknown>;
  const staticPaths = staticDoc.paths;
  if (!staticPaths || typeof staticPaths !== 'object') {
    throw new Error('openapi.yaml is missing top-level `paths`.');
  }

  const app = buildServer();
  await app.ready();

  try {
    const runtimeDoc = app.swagger() as unknown as Record<string, unknown>;
    const runtimePaths = runtimeDoc.paths;
    if (!runtimePaths || typeof runtimePaths !== 'object') {
      throw new Error('Runtime swagger document is missing `paths`.');
    }

    const mismatches: Mismatch[] = [];

    for (const [contractPath, methods] of Object.entries(WAVE_ENDPOINTS)) {
      const runtimePath = `${API_PREFIX}${contractPath}`;
      const runtimePathItemRaw = (runtimePaths as Record<string, unknown>)[runtimePath];
      const staticPathItemRaw = (staticPaths as Record<string, unknown>)[contractPath];
      const runtimePathItem =
        runtimePathItemRaw && typeof runtimePathItemRaw === 'object'
          ? (runtimePathItemRaw as Record<string, unknown>)
          : null;
      const staticPathItem =
        staticPathItemRaw && typeof staticPathItemRaw === 'object'
          ? (staticPathItemRaw as Record<string, unknown>)
          : null;

      for (const method of methods) {
        const runtimeOperationRaw = runtimePathItem?.[method];
        const staticOperationRaw = staticPathItem?.[method];
        const runtimeOperation =
          runtimeOperationRaw && typeof runtimeOperationRaw === 'object'
            ? (runtimeOperationRaw as Record<string, unknown>)
            : null;
        const staticOperation =
          staticOperationRaw && typeof staticOperationRaw === 'object'
            ? (staticOperationRaw as Record<string, unknown>)
            : null;

        if (!runtimeOperation) {
          mismatches.push({
            path: normalizeRuntimePath(runtimePath),
            method,
            type: 'missing_operation',
            details: 'missing from runtime swagger output',
          });
          continue;
        }

        if (!staticOperation) {
          mismatches.push({
            path: contractPath,
            method,
            type: 'missing_operation',
            details: 'missing from openapi.yaml',
          });
          continue;
        }

        const runtimeStatuses = collectStatuses(runtimeOperation);
        const augmentedStatuses = HOOK_AUGMENTED_STATUSES[contractPath]?.[method] ?? [];
        for (const code of augmentedStatuses) {
          runtimeStatuses.add(code);
        }
        const staticStatuses = collectStatuses(staticOperation);

        const missingInStatic = sorted(
          [...runtimeStatuses].filter((status) => !staticStatuses.has(status)),
        );
        const extraInStatic = sorted(
          [...staticStatuses].filter((status) => !runtimeStatuses.has(status)),
        );
        if (missingInStatic.length > 0 || extraInStatic.length > 0) {
          mismatches.push({
            path: contractPath,
            method,
            type: 'response_status',
            details: `runtime=[${sorted(runtimeStatuses).join(', ')}] static=[${sorted(staticStatuses).join(', ')}]`,
          });
        }

        const runtimeParameterNames = collectParameterNames(runtimeDoc, runtimePathItem, runtimeOperation);
        const staticParameterNames = collectParameterNames(staticDoc, staticPathItem, staticOperation);
        const missingParamsInStatic = sorted(
          [...runtimeParameterNames].filter((name) => !staticParameterNames.has(name)),
        );
        const extraParamsInStatic = sorted(
          [...staticParameterNames].filter((name) => !runtimeParameterNames.has(name)),
        );
        if (missingParamsInStatic.length > 0 || extraParamsInStatic.length > 0) {
          mismatches.push({
            path: contractPath,
            method,
            type: 'parameter',
            details: `runtime=[${sorted(runtimeParameterNames).join(', ')}] static=[${sorted(staticParameterNames).join(', ')}]`,
          });
        }
      }
    }

    if (mismatches.length > 0) {
      console.error('Wave 2/3 contract drift detected:');
      for (const mismatch of mismatches) {
        console.error(
          `- ${mismatch.path} ${mismatch.method.toUpperCase()} ${mismatch.type}: ${mismatch.details}`,
        );
      }
      process.exitCode = 1;
      return;
    }

    const operationCount = Object.values(WAVE_ENDPOINTS).reduce((total, methods) => total + methods.length, 0);
    console.log(
      `Wave 2/3 contract gate passed for ${operationCount} operations (${Object.keys(WAVE_ENDPOINTS).length} paths).`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Contract gate failed: ${message}`);
  process.exitCode = 1;
});
