export interface StagingSmokeCheck {
  name: string;
  passed: boolean;
  status?: number;
  detail?: string;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export async function runStagingSmoke(
  baseUrl: string,
  adminKey: string,
  fetcher: Fetcher = fetch,
): Promise<StagingSmokeCheck[]> {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.hostname !== '127.0.0.1' && base.hostname !== 'localhost') {
    throw new Error('BASE_URL must use HTTPS outside localhost');
  }
  const checks: StagingSmokeCheck[] = [];
  const checkGet = async (
    name: string,
    route: string,
    validate: (response: Response, body: string) => string | undefined,
    init: RequestInit = {},
  ) => {
    try {
      const response = await fetcher(new URL(route, base), {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      const detail = validate(response, body);
      checks.push({ name, passed: detail === undefined, status: response.status, ...(detail && { detail }) });
    } catch (error) {
      checks.push({
        name,
        passed: false,
        detail: error instanceof Error ? error.name : 'request failed',
      });
    }
  };

  await checkGet('GET /health', '/health', (response) =>
    response.status === 200 ? undefined : 'expected HTTP 200',
  );
  await checkGet('GET /ready', '/ready', (response) =>
    response.status === 200 ? undefined : 'expected HTTP 200',
  );
  await checkGet('GET /worker-status', '/worker-status', (response) =>
    response.status === 200 ? undefined : 'expected HTTP 200',
  );
  await checkGet('GET /console with strict CSP', '/console', (response, body) =>
    response.status === 200 &&
    response.headers.get('content-security-policy') === STRICT_CSP &&
    /<html[\s>]/i.test(body)
      ? undefined
      : 'expected HTML, HTTP 200, and strict console CSP',
  );
  let sessionRole: string | undefined;
  await checkGet(
    'GET /admin/session',
    '/admin/session',
    (response, body) => {
      if (response.status !== 200) return 'expected HTTP 200';
      try {
        const session: unknown = JSON.parse(body);
        if (
          typeof session === 'object' &&
          session !== null &&
          'role' in session &&
          typeof session.role === 'string'
        ) {
          sessionRole = session.role;
          return undefined;
        }
      } catch {
        return 'expected a session response with a role';
      }
      return 'expected a session response with a role';
    },
    { headers: { Authorization: `Bearer ${adminKey}` } },
  );
  if (sessionRole) checks[checks.length - 1]!.detail = `role=${sessionRole}`;
  await checkGet('GET /register', '/register', (response, body) =>
    response.status === 200 && /<html[\s>]/i.test(body)
      ? undefined
      : 'expected registration HTML and HTTP 200',
  );

  try {
    const response = await fetcher(new URL('/webhooks/whatsapp', base), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'invalid-signature',
      },
      body: new URLSearchParams({
        MessageSid: 'SM_PHASE6_INVALID_SIGNATURE',
        From: 'whatsapp:+10000000000',
        To: 'whatsapp:+10000000001',
        Body: 'staging smoke invalid signature',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    let code: unknown;
    try {
      const payload: unknown = JSON.parse(body);
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'object' &&
        payload.error !== null &&
        'code' in payload.error
      ) {
        code = payload.error.code;
      }
    } catch {
      code = undefined;
    }
    checks.push({
      name: 'POST /webhooks/whatsapp rejects invalid signature',
      passed: response.status === 403 && code === 'invalid_signature',
      status: response.status,
      ...(response.status !== 403 || code !== 'invalid_signature'
        ? { detail: 'expected HTTP 403 invalid_signature' }
        : {}),
    });
  } catch (error) {
    checks.push({
      name: 'POST /webhooks/whatsapp rejects invalid signature',
      passed: false,
      detail: error instanceof Error ? error.name : 'request failed',
    });
  }
  return checks;
}

function printChecks(checks: StagingSmokeCheck[]): void {
  console.log('RESULT  CHECK                                          STATUS  DETAIL');
  for (const check of checks) {
    console.log(
      `${check.passed ? 'PASS' : 'FAIL'}     ${check.name.padEnd(47)} ${String(check.status ?? '-').padEnd(6)} ${check.detail ?? ''}`,
    );
  }
}

if (/(?:^|[\\/])staging-smoke\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
  const baseUrl = process.env['BASE_URL'];
  const adminKey = process.env['ADMIN_KEY'];
  if (!baseUrl || !adminKey) {
    console.error('Set BASE_URL and ADMIN_KEY in the environment.');
    process.exitCode = 2;
  } else {
    runStagingSmoke(baseUrl, adminKey)
      .then((checks) => {
        printChecks(checks);
        if (checks.some((check) => !check.passed)) process.exitCode = 1;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.name : 'Staging smoke failed.');
        process.exitCode = 1;
      });
  }
}
