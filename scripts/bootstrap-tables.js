'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

function required(name) {
  const value = process.env[name];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function parseTables(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    const error = new Error(
      'BOOTSTRAP_TABLES_JSON must contain valid JSON'
    );
    error.code = 'BOOTSTRAP_INVALID_TABLES_JSON';
    throw error;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    const error = new Error(
      'BOOTSTRAP_TABLES_JSON must be a non-empty array'
    );
    error.code = 'BOOTSTRAP_INVALID_TABLES';
    throw error;
  }

  if (parsed.length > 200) {
    const error = new Error(
      'Bootstrap table count exceeds allowed maximum'
    );
    error.code = 'BOOTSTRAP_TOO_MANY_TABLES';
    throw error;
  }

  const seen = new Set();

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const error = new Error(
        `Table entry ${index + 1} must be an object`
      );
      error.code = 'BOOTSTRAP_INVALID_TABLE';
      throw error;
    }

    const tableId = String(entry.table_id ?? '').trim();
    const displayName = String(entry.display_name ?? '').trim();

    if (!tableId) {
      const error = new Error(
        `Table entry ${index + 1} is missing table_id`
      );
      error.code = 'BOOTSTRAP_INVALID_TABLE_ID';
      throw error;
    }

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tableId)) {
      const error = new Error(
        `Table entry ${index + 1} table_id must match ^[A-Za-z0-9_-]{1,64}$`
      );
      error.code = 'BOOTSTRAP_INVALID_TABLE_ID';
      throw error;
    }

    if (!displayName) {
      const error = new Error(
        `Table entry ${index + 1} is missing display_name`
      );
      error.code = 'BOOTSTRAP_INVALID_DISPLAY_NAME';
      throw error;
    }

    if (displayName.length > 120) {
      const error = new Error(
        `Table entry ${index + 1} display_name is too long`
      );
      error.code = 'BOOTSTRAP_INVALID_DISPLAY_NAME';
      throw error;
    }

    if (seen.has(tableId)) {
      const error = new Error(
        `Duplicate table_id in bootstrap input: ${tableId}`
      );
      error.code = 'BOOTSTRAP_DUPLICATE_TABLE_ID';
      throw error;
    }

    seen.add(tableId);

    return {
      tableId,
      displayName,
    };
  });
}

function buildPool() {
  const databaseUrl = required('DATABASE_URL');

  let ssl = false;

  try {
    const hostname = new URL(databaseUrl).hostname;

    if (
      hostname &&
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1' &&
      !hostname.endsWith('.railway.internal')
    ) {
      ssl = { rejectUnauthorized: false };
    }
  } catch {
    throw new Error('DATABASE_URL is invalid');
  }

  return new Pool({
    connectionString: databaseUrl,
    ssl,
  });
}

async function main() {
  const configuredSecret = required('ADMIN_ROLE_SECRET');
  const suppliedSecret = required('BOOTSTRAP_ADMIN_ROLE_SECRET');
  const restaurantId = required('BOOTSTRAP_RESTAURANT_ID');
  const tables = parseTables(required('BOOTSTRAP_TABLES_JSON'));

  if (!secureEqual(configuredSecret, suppliedSecret)) {
    const error = new Error('Bootstrap authorization failed');
    error.code = 'BOOTSTRAP_UNAUTHORIZED';
    throw error;
  }

  if (!isUuid(restaurantId)) {
    const error = new Error(
      'BOOTSTRAP_RESTAURANT_ID must be a valid UUID'
    );
    error.code = 'BOOTSTRAP_INVALID_RESTAURANT_ID';
    throw error;
  }

  const requestedById = new Map(
    tables.map((table) => [table.tableId, table])
  );

  const pool = buildPool();
  let client;
  let committed = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    /*
     * Lock the parent restaurant to serialize initial operational
     * bootstrap for this restaurant.
     */
    const restaurantResult = await client.query(
      `
        SELECT id
        FROM public.restaurants
        WHERE id = $1
          AND active = true
        FOR UPDATE
      `,
      [restaurantId]
    );

    if (restaurantResult.rowCount !== 1) {
      const error = new Error(
        'Bootstrap refused: active restaurant not found'
      );
      error.code = 'BOOTSTRAP_RESTAURANT_NOT_FOUND';
      throw error;
    }

    /*
     * Lock the registry while reconciling the initial table set.
     */
    await client.query(
      'LOCK TABLE public.restaurant_tables IN EXCLUSIVE MODE'
    );

    const existingResult = await client.query(
      `
        SELECT
          id,
          table_id::text AS table_id,
          display_name,
          active
        FROM public.restaurant_tables
        WHERE restaurant_id = $1
        ORDER BY table_id
      `,
      [restaurantId]
    );

    /*
     * Existing rows are allowed only when they are members of the exact
     * requested bootstrap set. This permits safe retries but prevents this
     * script from becoming a general-purpose table-management mechanism.
     */
    for (const existing of existingResult.rows) {
      const requested = requestedById.get(
        String(existing.table_id)
      );

      if (!requested) {
        const error = new Error(
          `Bootstrap refused: existing table ${existing.table_id} is outside the requested initial set`
        );
        error.code = 'BOOTSTRAP_EXISTING_TABLE_SET_MISMATCH';
        throw error;
      }

      if (existing.display_name !== requested.displayName) {
        const error = new Error(
          `Bootstrap refused: existing table ${existing.table_id} has different metadata`
        );
        error.code = 'BOOTSTRAP_EXISTING_TABLE_METADATA_MISMATCH';
        throw error;
      }

      if (existing.active !== true) {
        const error = new Error(
          `Bootstrap refused: existing table ${existing.table_id} is inactive`
        );
        error.code = 'BOOTSTRAP_EXISTING_TABLE_INACTIVE';
        throw error;
      }
    }

    const existingIds = new Set(
      existingResult.rows.map((row) =>
        String(row.table_id)
      )
    );

    const created = [];

    for (const table of tables) {
      if (existingIds.has(table.tableId)) {
        continue;
      }

      const result = await client.query(
        `
          INSERT INTO public.restaurant_tables (
            restaurant_id,
            table_id,
            display_name,
            active
          )
          VALUES ($1, $2, $3, true)
          RETURNING
            id,
            restaurant_id,
            table_id,
            display_name,
            active,
            created_at,
            updated_at
        `,
        [
          restaurantId,
          table.tableId,
          table.displayName,
        ]
      );

      created.push(result.rows[0]);
    }

    const finalResult = await client.query(
      `
        SELECT
          id,
          restaurant_id,
          table_id,
          display_name,
          active
        FROM public.restaurant_tables
        WHERE restaurant_id = $1
        ORDER BY table_id
      `,
      [restaurantId]
    );

    if (finalResult.rowCount !== tables.length) {
      const error = new Error(
        'Bootstrap refused: final table registry does not match requested initial set'
      );
      error.code = 'BOOTSTRAP_FINAL_TABLE_SET_MISMATCH';
      throw error;
    }

    await client.query('COMMIT');
    committed = true;

    console.log('Initial restaurant table bootstrap succeeded.');
    console.log({
      restaurant_id: restaurantId,
      requested_count: tables.length,
      created_count: created.length,
      existing_count: tables.length - created.length,
    });

    console.table(finalResult.rows);
  } catch (error) {
    if (client && !committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Database rollback failed:', {
          code: rollbackError?.code || null,
          message:
            rollbackError?.message ||
            'Unknown rollback failure',
        });
      }
    }

    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Initial restaurant table bootstrap failed:', {
    code: error?.code || null,
    message: error?.message || 'Unknown bootstrap failure',
  });

  process.exit(1);
});
