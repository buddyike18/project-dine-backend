const path = require('path');

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');

const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();

if (nodeEnv !== 'production') {
  require('dotenv').config();
}

let config;

try {
  config = require('./config');
} catch (err) {
  const reason =
    typeof err?.message === 'string' &&
    err.message.startsWith('[CONFIG ERROR]')
      ? 'CONFIGURATION_INVALID'
      : 'CONFIGURATION_LOAD_FAILED';

  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      at: 'boot',
      event: 'configuration.load_failed',
      category: 'configuration',
      msg: 'Application configuration is invalid',
      reason,
    })
  );

  process.exit(1);
}

const pool = require('./db');
const verifyToken = require('./middleware/verifyToken');
const {
  startFirebaseDeletionRetryWorker,
} = require('./routes/auth');

function getRequestId(req) {
  return (
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    req.headers['x-amzn-trace-id'] ||
    null
  );
}



function sanitizeRequestId(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();

  // Reject empty, oversized, or non-printable values.
  if (
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    !/^[A-Za-z0-9._:=;@,-]+$/.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

function getRequestPath(req) {
  return req.path || req.originalUrl.split('?')[0];
}

function genRequestId() {
  // Lightweight, dependency-free request id
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function shouldLogRequests() {
  return config.logging.requests;
}

function logEvent(level, payload) {
  const out = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  };
  const line = JSON.stringify(out);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const STABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  '57P01',
  '57P02',
  '57P03',
  '08001',
  '08006',
  '53300',
]);

function classifyError(error, fallbackReason) {
  const fallback = String(
    fallbackReason || 'INTERNAL_OPERATION_FAILED'
  )
    .trim()
    .toUpperCase();

  const code =
    typeof error?.code === 'string'
      ? error.code.trim().toUpperCase()
      : '';

  if (STABLE_ERROR_CODES.has(code)) {
    return code;
  }

  if (error instanceof TypeError) {
    return 'TYPE_ERROR';
  }

  if (
    /^[A-Z0-9_]{1,80}$/.test(fallback)
  ) {
    return fallback;
  }

  return 'INTERNAL_OPERATION_FAILED';
}

function failStartup(category, message, err = null) {
  logEvent('error', {
    at: 'boot',
    category,
    msg: message,
    reason: classifyError(
      err,
      `${String(category || 'APPLICATION')
        .trim()
        .toUpperCase()}_STARTUP_FAILED`
    ),
  });

  process.exit(1);
}



let shuttingDown = false;
let server = null;
let stopFirebaseDeletionRetryWorker = null;

async function gracefulShutdown(signal, fatalError = null) {
  if (shuttingDown) return;
  shuttingDown = true;

  const shutdownStartedAt = Date.now();
  const initialExitCode = fatalError ? 1 : 0;
  let cleanupFailed = false;

  clearInterval(
    tableSessionRateLimitCleanupInterval
  );

  logEvent(fatalError ? 'error' : 'info', {
    at: 'shutdown',
    event: 'shutdown.started',
    msg: 'Shutdown initiated',
    signal,
    exitCode: initialExitCode,
    reason: fatalError
      ? classifyError(
          fatalError,
          'FATAL_PROCESS_ERROR'
        )
      : null,
  });

  let httpServerClosed = !server;
  let retryWorkerStopped =
    typeof stopFirebaseDeletionRetryWorker !== 'function';
  let databasePoolClosed = !pool;

  const forceExit = setTimeout(() => {
    if (
      server &&
      typeof server.closeAllConnections === 'function'
    ) {
      server.closeAllConnections();
    }

    logEvent('error', {
      at: 'shutdown',
      event: 'shutdown.forced',
      msg: 'Forced shutdown timeout exceeded',
      signal,
      exitCode: 1,
      elapsedMs: Date.now() - shutdownStartedAt,
      httpServerClosed,
      retryWorkerStopped,
      databasePoolClosed,
    });

    process.exit(1);
  }, 10000);

  let waitForHttpServerClose = Promise.resolve();

  if (server) {
    waitForHttpServerClose = new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          cleanupFailed = true;

          logEvent('error', {
            at: 'shutdown',
            event: 'http_server.shutdown_failed',
            msg: 'HTTP server shutdown failed',
            reason: classifyError(
              err,
              'HTTP_SERVER_SHUTDOWN_FAILED'
            ),
          });
        } else {
          httpServerClosed = true;
        }

        resolve();
      });
    });

    if (
      typeof server.closeIdleConnections === 'function'
    ) {
      server.closeIdleConnections();
    }
  }

  try {
    if (
      typeof stopFirebaseDeletionRetryWorker ===
      'function'
    ) {
      await Promise.resolve(
        stopFirebaseDeletionRetryWorker()
      );

      stopFirebaseDeletionRetryWorker = null;
      retryWorkerStopped = true;

      logEvent('info', {
        at: 'shutdown',
        event: 'firebase_deletion_worker.stopped',
        msg: 'Firebase deletion retry worker stopped',
      });
    }
  } catch (err) {
    cleanupFailed = true;

    logEvent('error', {
      at: 'shutdown',
      event:
        'firebase_deletion_worker.shutdown_failed',
      msg:
        'Firebase deletion retry worker shutdown failed',
      reason: classifyError(
        err,
        'FIREBASE_DELETION_WORKER_SHUTDOWN_FAILED'
      ),
    });
  }

  await waitForHttpServerClose;

  try {
    if (pool) {
      await pool.end();
      databasePoolClosed = true;

      logEvent('info', {
        at: 'shutdown',
        event: 'database.pool_closed',
        msg: 'Database pool closed',
      });
    }
  } catch (err) {
    cleanupFailed = true;

    logEvent('error', {
      at: 'shutdown',
      event: 'database.pool_shutdown_failed',
      msg: 'Database pool shutdown failed',
      reason: classifyError(
        err,
        'DATABASE_POOL_SHUTDOWN_FAILED'
      ),
    });
  }

  clearTimeout(forceExit);

  const exitCode =
    initialExitCode === 1 || cleanupFailed ? 1 : 0;

  logEvent(cleanupFailed ? 'error' : 'info', {
    at: 'shutdown',
    event: cleanupFailed
      ? 'shutdown.completed_with_errors'
      : 'shutdown.completed',
    msg: cleanupFailed
      ? 'Shutdown completed with errors'
      : 'Shutdown completed',
    signal,
    exitCode,
    elapsedMs: Date.now() - shutdownStartedAt,
    httpServerClosed,
    retryWorkerStopped,
    databasePoolClosed,
  });

  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  void gracefulShutdown('unhandledRejection', err);
});

process.on('uncaughtException', (err) => {
  void gracefulShutdown('uncaughtException', err);
});


function validateRequiredEnv() {
  try {
    config.validateConfig();
  } catch (err) {
    failStartup(
      'configuration',
      'Application configuration is invalid',
      err
    );
  }
}

// Phase 9.5A failure simulation readiness controls
let dbHealthy = true;

function isDbUnavailableError(err) {
  const code = err?.code;
  // Common PG connection / availability codes
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03' || // cannot_connect_now
    code === '08001' || // sqlclient_unable_to_establish_sqlconnection
    code === '08006' || // connection_failure
    code === '53300'    // too_many_connections
  ) return true;

  const msg = String(err?.message || '').toLowerCase();
  if (
    msg.includes('terminating connection') ||
    msg.includes('connection refused') ||
    msg.includes('could not connect') ||
    msg.includes('connection terminated') ||
    msg.includes('the database system is starting up') ||
    msg.includes('the database system is shutting down') ||
    msg.includes('database system is shutting down') ||
    msg.includes('no pg_hba.conf entry')
  ) return true;

  return false;
}

function setDbHealthy(next, reason) {
  if (dbHealthy === next) return;
  dbHealthy = next;
  logEvent(next ? 'info' : 'warn', {
    at: 'db',
    msg: next ? 'Database marked healthy' : 'Database marked unhealthy',
    reason: reason || null,
  });
}


// Firebase Admin credentials

// Firebase is required in every deployable environment.
validateRequiredEnv();

const configuredFirebaseKeyPath = String(
  config.firebase.serviceAccountPath || ''
).trim();

const configuredFirebaseProjectId = String(
  config.firebase.projectId || ''
).trim();

if (!configuredFirebaseKeyPath) {
  failStartup('firebase_config','FIREBASE_SERVICE_ACCOUNT_PATH is required');
}

if (!configuredFirebaseProjectId) {
  failStartup('firebase_config','FIREBASE_PROJECT_ID is required');
}

const firebaseKeyPath = path.resolve(configuredFirebaseKeyPath);

if (!fs.existsSync(firebaseKeyPath)) {
  failStartup('firebase_config','Firebase service account file not found');
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    fs.readFileSync(firebaseKeyPath, 'utf8')
  );
} catch (err) {
  failStartup('firebase_config','Firebase service account file is invalid JSON', err);
}

if (
  typeof serviceAccount.project_id !== 'string' ||
  serviceAccount.project_id.trim() === ''
) {
  failStartup('firebase_config','Firebase service account is missing project_id');
}

if (
  serviceAccount.project_id.trim() !==
  configuredFirebaseProjectId
) {
  failStartup('firebase_config','Firebase service account project_id mismatch');
}

let validatedFirebaseProjectId;

if (admin.apps.length === 0) {
  const initializedApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: configuredFirebaseProjectId,
  });

  validatedFirebaseProjectId = String(
    initializedApp.options.projectId || ''
  ).trim();
} else {
  const existingApp = admin.app();

  const existingFirebaseProjectId = String(
    existingApp.options.projectId || ''
  ).trim();

  if (!existingFirebaseProjectId) {
    failStartup('firebase_init','Existing Firebase Admin app is missing a configured projectId');
  }

  if (existingFirebaseProjectId !== configuredFirebaseProjectId) {
    failStartup('firebase_init','Existing Firebase Admin app projectId mismatch');
  }

  validatedFirebaseProjectId = existingFirebaseProjectId;
}

if (!validatedFirebaseProjectId) {
  failStartup('firebase_init','Firebase Admin app did not expose a validated projectId');
}

if (validatedFirebaseProjectId !== configuredFirebaseProjectId) {
  failStartup('firebase_init','Initialized Firebase Admin app projectId mismatch');
}

const firebaseAdmin = admin;

logEvent('info', {
  at: 'firebase',
  msg: 'Firebase initialized',
  projectId: validatedFirebaseProjectId,
});

if (typeof verifyToken !== 'function') {
  failStartup('middleware','verifyToken middleware is not available');
}

let safeVerifyToken;

if (verifyToken.length === 1) {
  safeVerifyToken = verifyToken(firebaseAdmin);
} else {
  safeVerifyToken = verifyToken;
}

if (typeof safeVerifyToken !== 'function') {
  failStartup('middleware','verifyToken did not produce valid middleware');
}

// The singleton PostgreSQL pool is created in db.js.

pool.on('error', (err) => {
  setDbHealthy(false, 'pool_error');

  logEvent('error', {
    at: 'db',
    event: 'database.pool_error',
    msg: 'Unexpected PostgreSQL pool error',
    reason: classifyError(
      err,
      'DATABASE_POOL_ERROR'
    ),
  });
});

async function runDatabaseReadinessProbe() {
  const client = await pool.connect();

  try {
    await client.query({
      text: 'SELECT 1',
      query_timeout:
        config.database.connectionTimeoutMillis,
    });
  } finally {
    client.release();
  }
}

// Initial connectivity is verified during bootstrap.

// Setup Express
const app = express();

app.set(
  'trust proxy',
  config.server.trustProxyHops
);

const TABLE_SESSION_RATE_LIMIT_RETENTION_HOURS = 24;
const TABLE_SESSION_RATE_LIMIT_CLEANUP_INTERVAL_MS =
  60 * 60 * 1000;

const TABLE_SESSION_RATE_LIMIT_DATABASE_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);

const tableSessionRateLimitCleanupInterval =
  setInterval(async () => {
    try {
      await pool.query(
        `DELETE FROM public.table_session_verification_limits
         WHERE updated_at <
           now() - make_interval(hours => $1)`,
        [TABLE_SESSION_RATE_LIMIT_RETENTION_HOURS]
      );

      logEvent('info', {
        at: 'server',
        event:
          'table_session_rate_limit_cleanup_completed',
        reason: 'maintenance_completed',
      });
    } catch (error) {
      const code = String(
        error?.code ||
          error?.cause?.code ||
          ''
      ).trim();

      logEvent('error', {
        at: 'server',
        event:
          'table_session_rate_limit_cleanup_failed',
        reason:
          TABLE_SESSION_RATE_LIMIT_DATABASE_CODES.has(code)
            ? 'database_unavailable'
            : 'maintenance_failed',
      });
    }
  }, TABLE_SESSION_RATE_LIMIT_CLEANUP_INTERVAL_MS);

tableSessionRateLimitCleanupInterval.unref?.();


// Request id + request logging (Phase 9 hardened)
app.use((req, res, next) => {
  const existing = sanitizeRequestId(getRequestId(req));
  const rid = existing || genRequestId();
  req.requestId = rid;
  req.logEvent = (
    level,
    event,
    payload = {}
  ) => {
    logEvent(level, {
      at: 'request',
      event,
      requestId: rid,
      ...payload,
    });
  };
  res.setHeader('X-Request-Id', rid);

  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;

    // In production: only log errors by default (>=400), unless LOG_REQUESTS enabled.
    const logAll = shouldLogRequests();
    const isError = status >= 400;
    if (!logAll && !isError) return;

    req.logEvent(
      isError ? 'warn' : 'info',
      'http_request_completed',
      {
        method: req.method,
        path: getRequestPath(req),
        status,
        ms,
      }
    );
  });

  next();
});

// Phase 9.5A — request hang protection
app.use((req, res, next) => {
  const timeoutMs = config.server.requestTimeoutMs;
  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs);
  next();
});

// CORS origins are validated and normalized by config/index.js.
app.use(
  cors({
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  })
);

// Body parsing with size limits
// IMPORTANT: Stripe webhooks require the raw request body for signature verification.
// So we:
//  - parse raw ONLY for the webhook path
//  - skip JSON/urlencoded parsers for that webhook path
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

const jsonParser = express.json({ limit: '1mb' });
const urlencodedParser = express.urlencoded({ extended: true, limit: '1mb' });

app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/payments/webhook')) return next();
  return jsonParser(req, res, next);
});

app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/api/payments/webhook')) return next();
  return urlencodedParser(req, res, next);
});

// Global set

app.set('pool', pool);

// Health & readiness endpoints (MVP 2)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/ready', async (req, res) => {
  try {
    await runDatabaseReadinessProbe();
    setDbHealthy(true, 'ready_probe_ok');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    setDbHealthy(false, 'ready_probe_failed');
    req.logEvent(
      'error',
      'readiness_check_failed',
      {
        reason: classifyError(
          err,
          'READINESS_DATABASE_CHECK_FAILED'
        ),
      }
    );
    res.status(503).json({ status: 'not_ready', error: 'Database unavailable' });
  }
});

// Routes
// IMPORTANT: Avoid duplicated routes by using a single router entrypoint.
// All API routes should be mounted inside ./routes/index.js (exported as a function).
app.use(
  '/api',
  require('./routes')(
    pool,
    safeVerifyToken,
    firebaseAdmin,
    logEvent
  )
);

// 404 handler (ensures unknown routes are visible as 404s)
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler (ensures 500s are visible and consistent)
app.use((err, req, res, next) => {
  req.logEvent?.(
    'error',
    'request_unhandled_error',
    {
      reason: classifyError(
        err,
        'UNHANDLED_REQUEST_ERROR'
      ),
    }
  );
  if (res.headersSent) return next(err);
  const dbDown = isDbUnavailableError(err) || isDbUnavailableError(err?.cause) || dbHealthy === false;
  if (dbDown) {
    return res.status(503).json({ error: 'Service unavailable', code: 'DB_UNAVAILABLE' });
  }
  const candidateStatus = Number(err?.status);
  const status =
    Number.isInteger(candidateStatus) &&
    candidateStatus >= 400 &&
    candidateStatus <= 499
      ? candidateStatus
      : 500;

  return res.status(status).json({
    error:
      status === 500
        ? 'Internal server error'
        : 'Request failed',
  });
});


async function bootstrap() {
  try {
    await runDatabaseReadinessProbe();

    setDbHealthy(true, 'initial_probe_ok');

    logEvent('info', {
      at: 'db',
      event: 'database.initial_probe_succeeded',
      msg: 'PostgreSQL Connected',
    });
  } catch (err) {
    setDbHealthy(false, 'initial_probe_failed');

    logEvent('error', {
      at: 'boot',
      event: 'database.initial_probe_failed',
      category: 'database_connectivity',
      msg: 'PostgreSQL initial connectivity probe failed',
      reason: classifyError(
        err,
        'DATABASE_INITIAL_PROBE_FAILED'
      ),
    });

    await gracefulShutdown('databaseStartupError', err);
    return;
  }

  try {
    const stopWorker =
      startFirebaseDeletionRetryWorker(pool, logEvent);

    if (typeof stopWorker !== 'function') {
      throw new TypeError(
        'Firebase deletion retry worker did not return a stop function'
      );
    }

    stopFirebaseDeletionRetryWorker = stopWorker;

    logEvent('info', {
      at: 'boot',
      event: 'firebase_deletion_worker.started',
      msg: 'Firebase deletion retry worker started',
    });
  } catch (err) {
    logEvent('error', {
      at: 'boot',
      event: 'firebase_deletion_worker.startup_failed',
      category: 'background_worker',
      msg: 'Firebase deletion retry worker failed to start',
      reason: classifyError(
        err,
        'FIREBASE_DELETION_WORKER_STARTUP_FAILED'
      ),
    });

    await gracefulShutdown(
      'firebaseDeletionWorkerStartupError',
      err
    );
    return;
  }

  const port = config.server.port;

  server = app.listen(
    port,
    config.server.host,
    () => {
      logEvent('info', {
        at: 'boot',
        event: 'server.listening',
        msg: 'Server listening',
        host: config.server.host,
        port,
      });
    }
  );

  server.on('error', (err) => {
    console.error({
      code: err?.code,
      name: err?.name,
    });

    logEvent('error', {
      at: 'boot',
      event: 'server.error',
      msg: 'HTTP server error',
      reason: classifyError(
        err,
        'HTTP_SERVER_ERROR'
      ),
    });

    void gracefulShutdown('httpServerError', err);
  });

  server.headersTimeout =
    config.server.headersTimeoutMs;
  server.requestTimeout =
    config.server.serverRequestTimeoutMs;
  server.keepAliveTimeout =
    config.server.keepaliveTimeoutMs;
}

void bootstrap();
