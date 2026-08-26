// Configuration module for project-dine-backend

const ENV = process.env;

const allowedAppEnvs = new Set(['local', 'staging', 'production']);
const allowedLogLevels = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);
const allowedPgSslModes = new Set(['disable', 'require', 'verify-full']);
const MIGRATION_STATEMENT_TIMEOUT_MS = 15 * 60 * 1000;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);

function fail(message) {
  throw new Error(`[CONFIG ERROR] ${message}`);
}

function required(name) {
  const value = ENV[name];

  if (value == null || String(value).trim() === '') {
    fail(`Missing required env: ${name}`);
  }

  return String(value).trim();
}

function optional(name, fallback) {
  const value = ENV[name];

  if (value == null || String(value).trim() === '') {
    return fallback;
  }

  return String(value).trim();
}

function parseBoolean(name, fallback) {
  const raw = ENV[name];

  if (raw == null || String(raw).trim() === '') {
    return fallback;
  }

  switch (String(raw).trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
      return true;

    case 'false':
    case '0':
    case 'no':
      return false;

    default:
      fail(`${name} must be one of: true,false,1,0,yes,no`);
  }
}

function parseInteger(
  name,
  fallback,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}
) {
  const raw = ENV[name];

  if (raw == null || String(raw).trim() === '') {
    return fallback;
  }

  const trimmed = String(raw).trim();

  if (!/^-?\d+$/.test(trimmed)) {
    fail(`${name} must be an integer`);
  }

  const value = Number(trimmed);

  if (!Number.isSafeInteger(value)) {
    fail(`${name} must be a safe integer`);
  }

  if (value < min) {
    fail(`${name} must be >= ${min}`);
  }

  if (value > max) {
    fail(`${name} must be <= ${max}`);
  }

  return value;
}

function buildPostgresSslOptions(mode) {
  switch (mode) {
    case 'disable':
      return false;

    case 'require':
      return {
        rejectUnauthorized: false,
      };

    case 'verify-full':
      return {
        rejectUnauthorized: true,
      };

    default:
      fail('Unsupported PostgreSQL SSL mode');
  }
}

function validateHost(host, appEnv) {
  const normalizedHost = String(host).trim().toLowerCase();

  if (normalizedHost === '') {
    fail('HOST must not be empty');
  }

  if (appEnv !== 'local' && loopbackHosts.has(normalizedHost)) {
    fail('HOST must not use a loopback address outside local development');
  }

  return host;
}

function parseCorsOrigins(rawOrigins, appEnv) {
  const entries = rawOrigins.split(',').map((value) => value.trim());

  if (entries.some((value) => value === '')) {
    fail('CORS_ORIGINS must not contain empty entries');
  }

  const normalizedOrigins = entries.map((value) => {
    if (value === '*') {
      fail('CORS_ORIGINS must not contain a wildcard origin');
    }

    let parsed;

    try {
      parsed = new URL(value);
    } catch {
      fail('CORS_ORIGINS must contain valid absolute origins');
    }

    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      fail(
        'CORS_ORIGINS entries must not include paths, queries, or fragments'
      );
    }

    if (parsed.username || parsed.password) {
      fail('CORS_ORIGINS entries must not include credentials');
    }

    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = loopbackHosts.has(hostname);

    if (appEnv !== 'local' && isLoopback) {
      fail(
        'CORS_ORIGINS must not use loopback origins outside local development'
      );
    }

    if (appEnv === 'local') {
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        fail('CORS_ORIGINS must use HTTP or HTTPS');
      }
    } else if (parsed.protocol !== 'https:') {
      fail('CORS_ORIGINS must use HTTPS outside local development');
    }

    return parsed.origin;
  });

  return [...new Set(normalizedOrigins)];
}


function readTableSessionLinkBaseUrl(appEnv) {
  const rawValue = String(
    process.env.TABLE_SESSION_LINK_BASE_URL ?? ''
  ).trim();

  if (!rawValue) {
    if (appEnv === 'production') {
      fail(
        'Missing required env: TABLE_SESSION_LINK_BASE_URL'
      );
    }

    return null;
  }

  let parsed;

  try {
    parsed = new URL(rawValue);
  } catch {
    fail(
      'TABLE_SESSION_LINK_BASE_URL must be an absolute URL'
    );
  }

  if (parsed.protocol !== 'https:') {
    fail(
      'TABLE_SESSION_LINK_BASE_URL must use HTTPS'
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(
      'TABLE_SESSION_LINK_BASE_URL must not include credentials, query parameters, or fragments'
    );
  }

  if (
    parsed.pathname !== '/' &&
    parsed.pathname !== ''
  ) {
    fail(
      'TABLE_SESSION_LINK_BASE_URL must not include a path'
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  const isPrivateHostname =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);

  if (isPrivateHostname) {
    fail(
      'TABLE_SESSION_LINK_BASE_URL must not use a local or private host'
    );
  }

  if (
    appEnv === 'production' &&
    parsed.origin !==
      'https://app.dineworkspace.com'
  ) {
    fail(
      'Production table-session links must use https://app.dineworkspace.com'
    );
  }

  return parsed.origin;
}


function readTableLinkSigningSecret(appEnv) {
  const rawValue = String(
    process.env.TABLE_LINK_SIGNING_SECRET ?? ''
  ).trim();

  if (!rawValue) {
    if (appEnv === 'production') {
      fail('Missing required env: TABLE_LINK_SIGNING_SECRET');
    }

    return null;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(rawValue)) {
    fail(
      'TABLE_LINK_SIGNING_SECRET must be exactly 64 hexadecimal characters'
    );
  }

  return rawValue.toLowerCase();
}


function buildMigrationConfig() {
  const appEnv = required('APP_ENV');

  if (!allowedAppEnvs.has(appEnv)) {
    fail(
      `Invalid APP_ENV: ${appEnv}. Must be one of: local, staging, production`
    );
  }

  const nodeEnv = optional(
    'NODE_ENV',
    appEnv === 'production' ? 'production' : 'development'
  );

  if (appEnv === 'production') {
    if (nodeEnv !== 'production') {
      fail('NODE_ENV must be production when APP_ENV=production');
    }
  } else if (nodeEnv === 'production') {
    fail('NODE_ENV may be production only when APP_ENV=production');
  }

  const databaseUrl = required('DATABASE_URL');

  const pgSsl = optional(
    'PG_SSL',
    appEnv === 'production' ? 'verify-full' : 'disable'
  ).toLowerCase();

  if (!allowedPgSslModes.has(pgSsl)) {
    fail('PG_SSL must be one of: disable,require,verify-full');
  }

  if (appEnv === 'production' && pgSsl === 'disable') {
    fail('PG_SSL may not be disable when APP_ENV=production');
  }

  const pgSslOptions = buildPostgresSslOptions(pgSsl);

  const pgConnectionTimeoutMs = parseInteger(
    'PG_CONNECTION_TIMEOUT_MS',
    10000,
    {
      min: 1000,
      max: 60000,
    }
  );

  return {
    app: {
      env: appEnv,
      nodeEnv,
    },

    database: {
      url: databaseUrl,
      sslOptions: pgSslOptions,
      connectionTimeoutMillis: pgConnectionTimeoutMs,
    },

    migrations: {
      statementTimeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS,
    },
  };
}

function buildConfig() {
  const appEnv = required('APP_ENV');

  if (!allowedAppEnvs.has(appEnv)) {
    fail(
      `Invalid APP_ENV: ${appEnv}. Must be one of: local, staging, production`
    );
  }

  const tableSessionLinkBaseUrl =
    readTableSessionLinkBaseUrl(appEnv);

  const tableLinkSigningSecret =
    readTableLinkSigningSecret(appEnv);

  const nodeEnv = optional(
    'NODE_ENV',
    appEnv === 'production' ? 'production' : 'development'
  );

  if (appEnv === 'production') {
    if (nodeEnv !== 'production') {
      fail('NODE_ENV must be production when APP_ENV=production');
    }
  } else if (nodeEnv === 'production') {
    fail('NODE_ENV may be production only when APP_ENV=production');
  }

  const databaseUrl = required('DATABASE_URL');
  const firebaseProjectId = required('FIREBASE_PROJECT_ID');
  const firebaseServiceAccountPath = required(
    'FIREBASE_SERVICE_ACCOUNT_PATH'
  );
  const stripeSecretKey = required('STRIPE_SECRET_KEY');
  const stripeWebhookSecret = required('STRIPE_WEBHOOK_SECRET');
  const adminRoleSecret = required('ADMIN_ROLE_SECRET');
  const corsOrigins = parseCorsOrigins(required('CORS_ORIGINS'), appEnv);

  if (appEnv === 'production' && !stripeSecretKey.startsWith('sk_live_')) {
    fail('STRIPE_SECRET_KEY must be a live-mode key in production');
  }

  if (appEnv !== 'production' && stripeSecretKey.startsWith('sk_live_')) {
    fail('STRIPE_SECRET_KEY must not be a live-mode key outside production');
  }

  if (
    !stripeSecretKey.startsWith('sk_live_') &&
    !stripeSecretKey.startsWith('sk_test_')
  ) {
    fail('STRIPE_SECRET_KEY has an unsupported key format');
  }

  const logLevel = optional('LOG_LEVEL', 'info').toLowerCase();

  if (!allowedLogLevels.has(logLevel)) {
    fail(`Invalid LOG_LEVEL: ${logLevel}`);
  }

  const host = validateHost(optional('HOST', '0.0.0.0'), appEnv);
  const portFallback = appEnv === 'local' ? 3000 : undefined;
  const port = parseInteger('PORT', portFallback, {
    min: 1,
    max: 65535,
  });

  if (port == null) {
    fail('Missing required env: PORT');
  }

  const trustProxyHops = parseInteger(
    'TRUST_PROXY_HOPS',
    appEnv === 'production' ? undefined : 0,
    {
      min: 0,
      max: 10,
    }
  );

  if (trustProxyHops == null) {
    fail('Missing required env: TRUST_PROXY_HOPS');
  }

  const pgSsl = optional(
    'PG_SSL',
    appEnv === 'production' ? 'verify-full' : 'disable'
  ).toLowerCase();

  if (!allowedPgSslModes.has(pgSsl)) {
    fail('PG_SSL must be one of: disable,require,verify-full');
  }

  if (appEnv === 'production' && pgSsl === 'disable') {
    fail('PG_SSL may not be disable when APP_ENV=production');
  }

  const pgSslOptions = buildPostgresSslOptions(pgSsl);

  const pgPort = parseInteger('PG_PORT', 5432, {
    min: 1,
    max: 65535,
  });

  const pgPoolMax = parseInteger('PG_POOL_MAX', 10, {
    min: 1,
    max: 50,
  });

  const pgConnectionTimeoutMs = parseInteger(
    'PG_CONNECTION_TIMEOUT_MS',
    10000,
    {
      min: 1000,
      max: 60000,
    }
  );

  const pgIdleTimeoutMs = parseInteger(
    'PG_IDLE_TIMEOUT_MS',
    30000,
    {
      min: 1000,
      max: 300000,
    }
  );

  const requestTimeoutMs = parseInteger(
    'REQUEST_TIMEOUT_MS',
    30000,
    {
      min: 1000,
      max: 120000,
    }
  );

  const serverRequestTimeoutMs = parseInteger(
    'SERVER_REQUEST_TIMEOUT_MS',
    30000,
    {
      min: 1000,
      max: 120000,
    }
  );

  const headersTimeoutMs = parseInteger(
    'HEADERS_TIMEOUT_MS',
    60000,
    {
      min: 1000,
      max: 125000,
    }
  );

  const keepaliveTimeoutMs = parseInteger(
    'KEEPALIVE_TIMEOUT_MS',
    5000,
    {
      min: 1000,
      max: 60000,
    }
  );

  if (headersTimeoutMs <= keepaliveTimeoutMs) {
    fail(
      'HEADERS_TIMEOUT_MS must be greater than KEEPALIVE_TIMEOUT_MS'
    );
  }

  if (headersTimeoutMs < serverRequestTimeoutMs) {
    fail(
      'HEADERS_TIMEOUT_MS must be greater than or equal to SERVER_REQUEST_TIMEOUT_MS'
    );
  }

  if (requestTimeoutMs > serverRequestTimeoutMs) {
    fail(
      'REQUEST_TIMEOUT_MS must be less than or equal to SERVER_REQUEST_TIMEOUT_MS'
    );
  }

  return {
    app: {
      env: appEnv,
      nodeEnv,
      isLocal: appEnv === 'local',
      isStaging: appEnv === 'staging',
      isProduction: appEnv === 'production',
    },

    database: {
      url: databaseUrl,
      host: optional('PG_HOST', 'localhost'),
      port: pgPort,
      name: optional('PG_DATABASE'),
      username: optional('PG_USER'),
      password: optional('PG_PASSWORD'),
      ssl: pgSsl,
      sslOptions: pgSslOptions,
      poolMax: pgPoolMax,
      connectionTimeoutMillis: pgConnectionTimeoutMs,
      idleTimeoutMillis: pgIdleTimeoutMs,
    },

    firebase: {
      projectId: firebaseProjectId,
      serviceAccountPath: firebaseServiceAccountPath,
    },

    stripe: {
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret,
    },

    auth: {
      adminRoleSecret,
    },

    cors: {
      origin: corsOrigins,
      credentials: parseBoolean('CORS_CREDENTIALS', false),
    },

    logging: {
      level: logLevel,
      requests: parseBoolean('LOG_REQUESTS', false),
    },

    migrations: {
      statementTimeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS,
    },

    links: {
      tableSessionBaseUrl:
        tableSessionLinkBaseUrl,
      tableLinkSigningSecret,
    },

    server: {
      host,
      port,
      trustProxyHops,
      requestTimeoutMs,
      headersTimeoutMs,
      serverRequestTimeoutMs,
      keepaliveTimeoutMs,
    },
  };
}

let runtimeConfig = null;

function getRuntimeConfig() {
  if (runtimeConfig === null) {
    runtimeConfig = buildConfig();
  }

  return runtimeConfig;
}

function validateConfig() {
  const config = getRuntimeConfig();

  return {
    ok: true,
    env: config.app.env,
  };
}

const exportedConfig = {
  buildMigrationConfig,
  validateConfig,
};

for (const key of [
  'app',
  'database',
  'firebase',
  'stripe',
  'auth',
  'cors',
  'logging',
  'migrations',
  'links',
  'server',
]) {
  Object.defineProperty(exportedConfig, key, {
    enumerable: true,
    get() {
      return getRuntimeConfig()[key];
    },
  });
}

module.exports = exportedConfig;
