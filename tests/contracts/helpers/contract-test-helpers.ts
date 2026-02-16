type PrismaDbMockSpec = Record<string, readonly string[] | string>;

function methodToMockKey(model: string, method: string): string {
  return `${model}${method.charAt(0).toUpperCase()}${method.slice(1)}`;
}

function requireMock(flatMocks: Record<string, unknown>, key: string): unknown {
  if (!(key in flatMocks)) {
    throw new Error(`Missing prisma mock function "${key}"`);
  }
  return flatMocks[key];
}

export function createPrismaDbMock(
  flatMocks: Record<string, unknown>,
  spec: PrismaDbMockSpec,
): { prisma: Record<string, unknown> } {
  const prisma: Record<string, unknown> = {};

  for (const [model, methodsOrKey] of Object.entries(spec)) {
    if (model === '$transaction') {
      const key = typeof methodsOrKey === 'string' ? methodsOrKey : 'transaction';
      prisma.$transaction = requireMock(flatMocks, key);
      continue;
    }

    if (typeof methodsOrKey === 'string') {
      prisma[model] = requireMock(flatMocks, methodsOrKey);
      continue;
    }

    const modelMethods: Record<string, unknown> = {};
    for (const method of methodsOrKey) {
      modelMethods[method] = requireMock(flatMocks, methodToMockKey(model, method));
    }
    prisma[model] = modelMethods;
  }

  return { prisma };
}

export function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}
