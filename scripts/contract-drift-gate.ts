import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { buildServer } from '../src/server';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type ParameterObject = {
  name?: unknown;
  $ref?: unknown;
};

type SecurityRequirementObject = Record<string, unknown>;

type Mismatch = {
  path: string;
  method?: HttpMethod;
  type: 'missing_path' | 'missing_operation' | 'response_status' | 'parameter' | 'request_body' | 'security';
  details: string;
};

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

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

function hasRequestBody(operation: Record<string, unknown>): boolean {
  return operation.requestBody !== undefined;
}

function collectSecurityNames(operation: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const security = operation.security;
  if (!Array.isArray(security)) {
    return names;
  }

  for (const requirement of security) {
    if (!requirement || typeof requirement !== 'object') {
      continue;
    }
    for (const name of Object.keys(requirement as SecurityRequirementObject)) {
      names.add(name);
    }
  }

  return names;
}

function getOperation(
  pathItem: Record<string, unknown> | null,
  method: HttpMethod,
): Record<string, unknown> | null {
  const candidate = pathItem?.[method];
  return candidate && typeof candidate === 'object'
    ? (candidate as Record<string, unknown>)
    : null;
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
    const runtimeDoc = app.swagger() as Record<string, unknown>;
    const runtimePaths = runtimeDoc.paths;
    if (!runtimePaths || typeof runtimePaths !== 'object') {
      throw new Error('Runtime swagger document is missing `paths`.');
    }

    const mismatches: Mismatch[] = [];
    const allPaths = sorted([
      ...Object.keys(runtimePaths as Record<string, unknown>),
      ...Object.keys(staticPaths as Record<string, unknown>),
    ]);

    for (const pathName of allPaths) {
      const runtimePathItemRaw = (runtimePaths as Record<string, unknown>)[pathName];
      const staticPathItemRaw = (staticPaths as Record<string, unknown>)[pathName];
      const runtimePathItem =
        runtimePathItemRaw && typeof runtimePathItemRaw === 'object'
          ? (runtimePathItemRaw as Record<string, unknown>)
          : null;
      const staticPathItem =
        staticPathItemRaw && typeof staticPathItemRaw === 'object'
          ? (staticPathItemRaw as Record<string, unknown>)
          : null;

      if (!runtimePathItem) {
        mismatches.push({
          path: pathName,
          type: 'missing_path',
          details: 'missing from runtime swagger output',
        });
        continue;
      }

      if (!staticPathItem) {
        mismatches.push({
          path: pathName,
          type: 'missing_path',
          details: 'missing from openapi.yaml',
        });
        continue;
      }

      for (const method of HTTP_METHODS) {
        const runtimeOperation = getOperation(runtimePathItem, method);
        const staticOperation = getOperation(staticPathItem, method);

        if (!runtimeOperation && !staticOperation) {
          continue;
        }

        if (!runtimeOperation) {
          mismatches.push({
            path: pathName,
            method,
            type: 'missing_operation',
            details: 'missing from runtime swagger output',
          });
          continue;
        }

        if (!staticOperation) {
          mismatches.push({
            path: pathName,
            method,
            type: 'missing_operation',
            details: 'missing from openapi.yaml',
          });
          continue;
        }

        const runtimeStatuses = collectStatuses(runtimeOperation);
        const staticStatuses = collectStatuses(staticOperation);
        if (
          sorted(runtimeStatuses).join(',') !== sorted(staticStatuses).join(',')
        ) {
          mismatches.push({
            path: pathName,
            method,
            type: 'response_status',
            details: `runtime=[${sorted(runtimeStatuses).join(', ')}] static=[${sorted(staticStatuses).join(', ')}]`,
          });
        }

        const runtimeParameterNames = collectParameterNames(runtimeDoc, runtimePathItem, runtimeOperation);
        const staticParameterNames = collectParameterNames(staticDoc, staticPathItem, staticOperation);
        if (
          sorted(runtimeParameterNames).join(',') !== sorted(staticParameterNames).join(',')
        ) {
          mismatches.push({
            path: pathName,
            method,
            type: 'parameter',
            details: `runtime=[${sorted(runtimeParameterNames).join(', ')}] static=[${sorted(staticParameterNames).join(', ')}]`,
          });
        }

        if (hasRequestBody(runtimeOperation) !== hasRequestBody(staticOperation)) {
          mismatches.push({
            path: pathName,
            method,
            type: 'request_body',
            details: `runtime=${hasRequestBody(runtimeOperation)} static=${hasRequestBody(staticOperation)}`,
          });
        }

        const runtimeSecurityNames = collectSecurityNames(runtimeOperation);
        const staticSecurityNames = collectSecurityNames(staticOperation);
        if (
          sorted(runtimeSecurityNames).join(',') !== sorted(staticSecurityNames).join(',')
        ) {
          mismatches.push({
            path: pathName,
            method,
            type: 'security',
            details: `runtime=[${sorted(runtimeSecurityNames).join(', ')}] static=[${sorted(staticSecurityNames).join(', ')}]`,
          });
        }
      }
    }

    if (mismatches.length > 0) {
      console.error('Contract drift detected:');
      for (const mismatch of mismatches) {
        const methodPrefix = mismatch.method ? ` ${mismatch.method.toUpperCase()}` : '';
        console.error(`- ${mismatch.path}${methodPrefix} ${mismatch.type}: ${mismatch.details}`);
      }
      process.exitCode = 1;
      return;
    }

    const operationCount = allPaths.reduce((total, pathName) => {
      const runtimePathItem = (runtimePaths as Record<string, unknown>)[pathName];
      if (!runtimePathItem || typeof runtimePathItem !== 'object') {
        return total;
      }
      return (
        total +
        HTTP_METHODS.filter((method) => method in (runtimePathItem as Record<string, unknown>)).length
      );
    }, 0);

    console.log(`Contract gate passed for ${operationCount} operations across ${allPaths.length} paths.`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Contract gate failed: ${message}`);
  process.exitCode = 1;
});
