/*
 * db/bootstrap-database.js
 *
 * One-time fresh-database bootstrap.
 * - Refuses to run against an initialized Dine database.
 * - Applies the authoritative schema.sql snapshot.
 * - Seeds only the frozen historical migration baseline.
 * - Leaves all future migrations pending for `npm run db:migrate`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

let config;

try {
  const nodeEnv = String(process.env.NODE_ENV || '')
    .trim()
    .toLowerCase();

  if (nodeEnv !== 'production') {
    require('dotenv').config();
  }

  const { buildMigrationConfig } = require('../config');
  config = buildMigrationConfig();
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
      at: 'database_bootstrap',
      event: 'bootstrap.configuration_failed',
      reason,
    })
  );

  process.exit(1);
}

const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');
const BASELINE_PATH = path.join(
  __dirname,
  'baseline-migrations.txt'
);

const BOOTSTRAP_LOCK_KEY_1 = 1145652805;
const BOOTSTRAP_LOCK_KEY_2 = 41;

function logEvent(level, event, fields = {}) {
  const writer =
    level === 'error' ? console.error : console.log;

  writer(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      at: 'database_bootstrap',
      event,
      ...fields,
    })
  );
}

function loadBaselineFilenames() {
  const filenames = fs
    .readFileSync(BASELINE_PATH, 'utf8')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (filenames.length === 0) {
    throw new Error('BASELINE_MANIFEST_EMPTY');
  }

  if (new Set(filenames).size !== filenames.length) {
    throw new Error('BASELINE_MANIFEST_DUPLICATE');
  }

  for (const filename of filenames) {
    if (!/^[A-Za-z0-9._-]+\.sql$/.test(filename)) {
      throw new Error('BASELINE_MANIFEST_INVALID_FILENAME');
    }

    const migrationPath = path.join(
      __dirname,
      'migrations',
      filename
    );

    if (!fs.existsSync(migrationPath)) {
      throw new Error('BASELINE_MIGRATION_MISSING');
    }
  }

  return filenames;
}

function loadSchemaSql() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error('SCHEMA_SNAPSHOT_MISSING');
  }

  const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');

  if (!raw.trim()) {
    throw new Error('SCHEMA_SNAPSHOT_EMPTY');
  }

  const lines = raw.split(/\r?\n/);
  const unexpectedMetaCommands = lines.filter(
    (line) =>
      /^\\/.test(line) &&
      !/^\\(?:restrict|unrestrict)\b/.test(line)
  );

  if (unexpectedMetaCommands.length > 0) {
    throw new Error('SCHEMA_UNSUPPORTED_PSQL_META_COMMAND');
  }

  return lines
    .filter(
      (line) =>
        !/^\\(?:restrict|unrestrict)\b/.test(line)
    )
    .join('\n');
}

async function rollbackSafely(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    logEvent('error', 'bootstrap.rollback_failed', {
      reason: 'BOOTSTRAP_ROLLBACK_FAILED',
    });
  }
}

async function assertFreshDatabase(client) {
  const relations = await client.query(`
    SELECT c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND c.relname NOT IN (
        'schema_migrations',
        'schema_migrations_id_seq'
      )
    ORDER BY c.relname
    LIMIT 1;
  `);

  if (relations.rowCount > 0) {
    throw new Error('DATABASE_ALREADY_INITIALIZED');
  }

  const ledgerExists = await client.query(`
    SELECT to_regclass('public.schema_migrations') IS NOT NULL
      AS exists;
  `);

  if (ledgerExists.rows[0]?.exists === true) {
    const ledger = await client.query(`
      SELECT count(*)::integer AS count
      FROM public.schema_migrations;
    `);

    if ((ledger.rows[0]?.count || 0) > 0) {
      throw new Error('MIGRATION_LEDGER_NOT_EMPTY');
    }
  }
}

async function run() {
  const client = new Client({
    connectionString: config.database.url,
    connectionTimeoutMillis:
      config.database.connectionTimeoutMillis,
    ssl: config.database.sslOptions,
  });

  let advisoryLockHeld = false;
  let transactionStarted = false;

  try {
    const schemaSql = loadSchemaSql();
    const baselineFilenames = loadBaselineFilenames();

    await client.connect();

    await client.query(
      `SET statement_timeout TO ${config.migrations.statementTimeoutMs}`
    );

    const lockResult = await client.query(
      `
        SELECT pg_try_advisory_lock($1, $2) AS acquired
      `,
      [BOOTSTRAP_LOCK_KEY_1, BOOTSTRAP_LOCK_KEY_2]
    );

    if (lockResult.rows[0]?.acquired !== true) {
      throw new Error('BOOTSTRAP_LOCK_UNAVAILABLE');
    }

    advisoryLockHeld = true;

    logEvent('info', 'bootstrap.connection_ready');
    logEvent('info', 'bootstrap.lock_acquired');

    await assertFreshDatabase(client);

    logEvent('info', 'bootstrap.database_verified_fresh');

    await client.query('BEGIN');
    transactionStarted = true;

    await client.query(`
      DROP TABLE IF EXISTS public.schema_migrations CASCADE;
    `);

    await client.query(schemaSql);

    const ledgerExists = await client.query(`
      SELECT to_regclass('public.schema_migrations') IS NOT NULL
        AS exists;
    `);

    if (ledgerExists.rows[0]?.exists !== true) {
      throw new Error('SCHEMA_MIGRATION_LEDGER_MISSING');
    }

    const existingLedger = await client.query(`
      SELECT count(*)::integer AS count
      FROM public.schema_migrations;
    `);

    if ((existingLedger.rows[0]?.count || 0) !== 0) {
      throw new Error('SCHEMA_MIGRATION_LEDGER_NOT_EMPTY');
    }

    for (const filename of baselineFilenames) {
      await client.query(
        `
          INSERT INTO public.schema_migrations (filename)
          VALUES ($1)
        `,
        [filename]
      );
    }

    const seededLedger = await client.query(`
      SELECT filename
      FROM public.schema_migrations;
    `);

    const seededFilenames = seededLedger.rows.map(
      (row) => row.filename
    );

    const seededFilenameSet = new Set(seededFilenames);
    const baselineFilenameSet = new Set(baselineFilenames);

    const hasDuplicateSeededFilenames =
      seededFilenameSet.size !== seededFilenames.length;

    const hasMissingBaselineFilename = baselineFilenames.some(
      (filename) => !seededFilenameSet.has(filename)
    );

    const hasUnexpectedSeededFilename = seededFilenames.some(
      (filename) => !baselineFilenameSet.has(filename)
    );

    if (
      seededFilenames.length !== baselineFilenames.length ||
      hasDuplicateSeededFilenames ||
      hasMissingBaselineFilename ||
      hasUnexpectedSeededFilename
    ) {
      throw new Error('BASELINE_LEDGER_VERIFICATION_FAILED');
    }

    await client.query('COMMIT');
    transactionStarted = false;

    logEvent('info', 'bootstrap.schema_applied');
    logEvent('info', 'bootstrap.baseline_seeded', {
      migrationCount: baselineFilenames.length,
    });
    logEvent('info', 'bootstrap.run_succeeded');
  } catch (err) {
    if (transactionStarted) {
      await rollbackSafely(client);
    }

    logEvent('error', 'bootstrap.run_failed', {
      reason:
        typeof err?.message === 'string' &&
        /^[A-Z0-9_]+$/.test(err.message)
          ? err.message
          : 'BOOTSTRAP_RUN_FAILED',
      pgCode: err?.code ?? null,
      detail:
        process.env.NODE_ENV === 'development'
          ? err?.message ?? null
          : null,
    });

    process.exitCode = 1;
  } finally {
    if (advisoryLockHeld) {
      try {
        await client.query(
          `
            SELECT pg_advisory_unlock($1, $2)
          `,
          [BOOTSTRAP_LOCK_KEY_1, BOOTSTRAP_LOCK_KEY_2]
        );

        logEvent('info', 'bootstrap.lock_released');
      } catch {
        logEvent('error', 'bootstrap.lock_release_failed', {
          reason: 'BOOTSTRAP_LOCK_RELEASE_FAILED',
        });

        process.exitCode = 1;
      }
    }

    try {
      await client.end();
    } catch {
      logEvent('error', 'bootstrap.connection_close_failed', {
        reason: 'BOOTSTRAP_CONNECTION_CLOSE_FAILED',
      });

      process.exitCode = 1;
    }
  }
}

run();
