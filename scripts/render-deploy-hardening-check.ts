import { getRequiredCorsOrigins, validateProductionConfig } from '../src/config/deploy-hardening';

type Args = {
  apiBaseUrl: string;
  withLocalEnvCheck: boolean;
};

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apiBaseUrl: 'https://clawgram-api.onrender.com',
    withLocalEnvCheck: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args.apiBaseUrl = token;
      continue;
    }

    if (token === '--api-base-url') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --api-base-url');
      }
      args.apiBaseUrl = next;
      index += 1;
      continue;
    }

    if (token.startsWith('--api-base-url=')) {
      const value = token.slice('--api-base-url='.length);
      if (!value) {
        throw new Error('Missing value for --api-base-url=');
      }
      args.apiBaseUrl = value;
      continue;
    }

    if (token === '--with-local-env-check') {
      args.withLocalEnvCheck = true;
      continue;
    }

    if (token === '--help') {
      console.log(
        [
          'Usage: npm run deploy:hardening:check -- [--api-base-url <url>] [--with-local-env-check]',
          '',
          '  --api-base-url <url>       API base URL to test (default https://clawgram-api.onrender.com)',
          '  --with-local-env-check     Validate current shell env as production config',
        ].join('\n'),
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function normalizeBaseUrl(rawValue: string): string {
  const parsed = new URL(rawValue);
  return parsed.origin.replace(/\/+$/, '');
}

async function runPreflightCheck(baseUrl: string, origin: string): Promise<CheckResult> {
  const response = await fetch(`${baseUrl}/api/v1/posts`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization,Content-Type',
    },
  });

  const allowOrigin = response.headers.get('access-control-allow-origin');
  const ok = response.status === 204 && allowOrigin === origin;
  return {
    name: `preflight allow ${origin}`,
    ok,
    detail: `status=${response.status} access-control-allow-origin=${allowOrigin ?? '<missing>'}`,
  };
}

async function runDenyCheck(baseUrl: string): Promise<CheckResult> {
  const response = await fetch(`${baseUrl}/api/v1/posts`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization,Content-Type',
    },
  });

  const allowOrigin = response.headers.get('access-control-allow-origin');
  const ok = response.status === 403 && !allowOrigin;
  return {
    name: 'preflight deny unknown origin',
    ok,
    detail: `status=${response.status} access-control-allow-origin=${allowOrigin ?? '<missing>'}`,
  };
}

async function runPublicReadCorsCheck(baseUrl: string, origin: string): Promise<CheckResult> {
  const response = await fetch(`${baseUrl}/api/v1/explore?limit=1`, {
    method: 'GET',
    headers: {
      Origin: origin,
    },
  });

  const allowOrigin = response.headers.get('access-control-allow-origin');
  const ok = response.status === 200 && allowOrigin === '*';
  return {
    name: 'public read CORS wildcard',
    ok,
    detail: `status=${response.status} access-control-allow-origin=${allowOrigin ?? '<missing>'}`,
  };
}

function formatResult(result: CheckResult): string {
  return `${result.ok ? '[pass]' : '[fail]'} ${result.name}: ${result.detail}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args.apiBaseUrl);
  const requiredOrigins = getRequiredCorsOrigins();
  const checks: CheckResult[] = [];

  if (args.withLocalEnvCheck) {
    const validation = validateProductionConfig({
      ...process.env,
      NODE_ENV: 'production',
    });
    for (const warning of validation.warnings) {
      checks.push({
        name: 'local production env warning',
        ok: true,
        detail: warning,
      });
    }
    for (const error of validation.errors) {
      checks.push({
        name: 'local production env error',
        ok: false,
        detail: error,
      });
    }
  }

  for (const origin of requiredOrigins) {
    checks.push(await runPreflightCheck(baseUrl, origin));
  }
  checks.push(await runDenyCheck(baseUrl));
  checks.push(await runPublicReadCorsCheck(baseUrl, requiredOrigins[0]));

  for (const check of checks) {
    console.log(formatResult(check));
  }

  const failedCount = checks.filter((check) => !check.ok).length;
  if (failedCount > 0) {
    console.error(`render-deploy-hardening-check failed with ${failedCount} failing check(s)`);
    process.exit(1);
  }

  console.log('render-deploy-hardening-check passed');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
