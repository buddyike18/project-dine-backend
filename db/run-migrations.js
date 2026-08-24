/*
 * db/run-migrations.js
 *
 * Explicit, deterministic SQL migration runner.
 * - Does NOT auto-run on server startup
 * - Requires manual invocation: `npm run db:migrate`
 * - Applies migrations in lexical order
 * - Records applied migrations in schema_migrations table
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

let config;

try {
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();

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
      at: 'migrations',
      event: 'migration.configuration_failed',
      reason,
    })
  );

  process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK_KEY_1 = 1145652805;
const MIGRATION_LOCK_KEY_2 = 40;

function logEvent(level, event, fields = {}) {
  const writer =
    level === 'error' ? console.error : console.log;

  writer(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      at: 'migrations',
      event,
      ...fields,
    })
  );
}

async function rollbackSafely(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    logEvent('error', 'migration.rollback_failed', {
      reason: 'MIGRATION_ROLLBACK_FAILED',
    });
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
  let primaryFailure = null;
  let cleanupFailure = null;

  try {
    await client.connect();

    await client.query(
      `SET statement_timeout TO ${config.migrations.statementTimeoutMs}`
    );

    const lockResult = await client.query(
      `
        SELECT pg_try_advisory_lock($1, $2) AS acquired
      `,
      [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2]
    );

    if (lockResult.rows[0]?.acquired !== true) {
      throw new Error('MIGRATION_LOCK_UNAVAILABLE');
    }

    advisoryLockHeld = true;

    logEvent('info', 'migration.connection_ready');
    logEvent('info', 'migration.lock_acquired');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const already = await client.query(
        `
          SELECT 1
          FROM schema_migrations
          WHERE filename = $1
        `,
        [file]
      );

      if (already.rowCount > 0) {
        continue;
      }

      const fullPath = path.join(
        MIGRATIONS_DIR,
        file
      );
      const sql = fs.readFileSync(fullPath, 'utf8');

      logEvent('info', 'migration.apply_started', {
        filename: file,
      });

      await client.query('BEGIN');

      try {
        await client.query(sql);

        await client.query(
          `
            INSERT INTO schema_migrations (filename)
            VALUES ($1)
          `,
          [file]
        );

        await client.query('COMMIT');
      } catch (err) {
        await rollbackSafely(client);
        throw err;
      }

      logEvent('info', 'migration.apply_succeeded', {
        filename: file,
      });
    }

    logEvent('info', 'migration.run_succeeded');
  } catch (err) {
    primaryFailure = err;
    throw err;
  } finally {
    if (advisoryLockHeld) {
      try {
        const unlockResult = await client.query(
          `
            SELECT pg_advisory_unlock($1, $2)
              AS released
          `,
          [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2]
        );

        if (unlockResult.rows[0]?.released !== true) {
          throw new Error(
            'MIGRATION_LOCK_RELEASE_FAILED'
          );
        }

        logEvent('info', 'migration.lock_released');
      } catch {
        logEvent(
          'error',
          'migration.lock_release_failed',
          {
            reason: 'MIGRATION_LOCK_RELEASE_FAILED',
          }
        );

        cleanupFailure = new Error(
          'MIGRATION_LOCK_RELEASE_FAILED'
        );
      }
    }

    try {
      await client.end();
    } catch {
      logEvent(
        'error',
        'migration.connection_close_failed',
        {
          reason:
            'MIGRATION_CONNECTION_CLOSE_FAILED',
        }
      );

      if (!cleanupFailure) {
        cleanupFailure = new Error(
          'MIGRATION_CONNECTION_CLOSE_FAILED'
        );
      }
    }

    if (!primaryFailure && cleanupFailure) {
      throw cleanupFailure;
    }
  }
}

run().catch((err) => {
  let reason = 'MIGRATION_RUN_FAILED';

  if (err?.message === 'MIGRATION_LOCK_UNAVAILABLE') {
    reason = 'MIGRATION_LOCK_UNAVAILABLE';
  } else if (
    err?.message === 'MIGRATION_LOCK_RELEASE_FAILED'
  ) {
    reason = 'MIGRATION_LOCK_RELEASE_FAILED';
  } else if (
    err?.message ===
    'MIGRATION_CONNECTION_CLOSE_FAILED'
  ) {
    reason = 'MIGRATION_CONNECTION_CLOSE_FAILED';
  }

  logEvent('error', 'migration.run_failed', {
    reason,
  });

  process.exitCode = 1;
});
