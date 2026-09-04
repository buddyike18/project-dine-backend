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

function parseBarChairs(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    const error = new Error(
      'BOOTSTRAP_BAR_CHAIRS_JSON must contain valid JSON'
    );
    error.code = 'BOOTSTRAP_INVALID_BAR_CHAIRS_JSON';
    throw error;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    const error = new Error(
      'BOOTSTRAP_BAR_CHAIRS_JSON must be a non-empty array'
    );
    error.code = 'BOOTSTRAP_INVALID_BAR_CHAIRS';
    throw error;
  }

  if (parsed.length > 200) {
    const error = new Error(
      'Bootstrap bar chair count exceeds allowed maximum'
    );
    error.code = 'BOOTSTRAP_TOO_MANY_BAR_CHAIRS';
    throw error;
  }

  const seen = new Set();

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const error = new Error(
        `Bar chair entry ${index + 1} must be an object`
      );
      error.code = 'BOOTSTRAP_INVALID_BAR_CHAIR';
      throw error;
    }

    const chairNumber = Number(entry.chair_number);
    const displayName =
      entry.display_name === undefined || entry.display_name === null
        ? null
        : String(entry.display_name).trim();

    if (!Number.isInteger(chairNumber) || chairNumber <= 0) {
      const error = new Error(
        `Bar chair entry ${index + 1} chair_number must be a positive integer`
      );
      error.code = 'BOOTSTRAP_INVALID_BAR_CHAIR_NUMBER';
      throw error;
    }

    if (displayName !== null) {
      if (!displayName) {
        const error = new Error(
          `Bar chair entry ${index + 1} display_name must not be blank`
        );
        error.code = 'BOOTSTRAP_INVALID_DISPLAY_NAME';
        throw error;
      }

      if (displayName.length > 120) {
        const error = new Error(
          `Bar chair entry ${index + 1} display_name is too long`
        );
        error.code = 'BOOTSTRAP_INVALID_DISPLAY_NAME';
        throw error;
      }
    }

    if (seen.has(chairNumber)) {
      const error = new Error(
        `Duplicate chair_number in bootstrap input: ${chairNumber}`
      );
      error.code = 'BOOTSTRAP_DUPLICATE_BAR_CHAIR_NUMBER';
      throw error;
    }

    seen.add(chairNumber);

    return {
      chairNumber,
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
  const chairs = parseBarChairs(required('BOOTSTRAP_BAR_CHAIRS_JSON'));

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

  const requestedByNumber = new Map(
    chairs.map((chair) => [chair.chairNumber, chair])
  );

  const pool = buildPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const restaurant = await client.query(
      `SELECT id, name, active
       FROM restaurants
       WHERE id = $1
       FOR UPDATE`,
      [restaurantId]
    );

    if (restaurant.rowCount !== 1) {
      const error = new Error('Bootstrap restaurant not found');
      error.code = 'BOOTSTRAP_RESTAURANT_NOT_FOUND';
      throw error;
    }

    if (restaurant.rows[0].active !== true) {
      const error = new Error('Bootstrap restaurant is inactive');
      error.code = 'BOOTSTRAP_RESTAURANT_INACTIVE';
      throw error;
    }

    await client.query('LOCK TABLE bar_chairs IN EXCLUSIVE MODE');

    const existingResult = await client.query(
      `SELECT
         id,
         chair_number,
         display_name,
         active
       FROM bar_chairs
       WHERE restaurant_id = $1
       ORDER BY chair_number`,
      [restaurantId]
    );

    const existingByNumber = new Map();

    for (const row of existingResult.rows) {
      const expected = requestedByNumber.get(row.chair_number);

      if (!expected) {
        const error = new Error(
          `Unexpected existing bar chair outside requested bootstrap set: ${row.chair_number}`
        );
        error.code = 'BOOTSTRAP_UNEXPECTED_EXISTING_BAR_CHAIR';
        throw error;
      }

      if (row.active !== true) {
        const error = new Error(
          `Existing bar chair ${row.chair_number} is inactive`
        );
        error.code = 'BOOTSTRAP_EXISTING_BAR_CHAIR_INACTIVE';
        throw error;
      }

      const existingDisplayName =
        row.display_name === null ? null : String(row.display_name).trim();

      if (existingDisplayName !== expected.displayName) {
        const error = new Error(
          `Existing bar chair ${row.chair_number} display_name does not match requested bootstrap data`
        );
        error.code = 'BOOTSTRAP_BAR_CHAIR_METADATA_MISMATCH';
        throw error;
      }

      existingByNumber.set(row.chair_number, row);
    }

    let created = 0;

    for (const chair of chairs) {
      if (existingByNumber.has(chair.chairNumber)) {
        continue;
      }

      await client.query(
        `INSERT INTO bar_chairs (
           restaurant_id,
           chair_number,
           display_name
         )
         VALUES ($1, $2, $3)`,
        [
          restaurantId,
          chair.chairNumber,
          chair.displayName,
        ]
      );

      created += 1;
    }

    const finalResult = await client.query(
      `SELECT
         chair_number,
         display_name,
         active
       FROM bar_chairs
       WHERE restaurant_id = $1
       ORDER BY chair_number`,
      [restaurantId]
    );

    if (finalResult.rowCount !== chairs.length) {
      const error = new Error(
        `Final bar chair registry count mismatch: expected ${chairs.length}, found ${finalResult.rowCount}`
      );
      error.code = 'BOOTSTRAP_BAR_CHAIR_COUNT_MISMATCH';
      throw error;
    }

    for (const row of finalResult.rows) {
      const expected = requestedByNumber.get(row.chair_number);

      if (
        !expected ||
        row.active !== true ||
        (row.display_name === null
          ? null
          : String(row.display_name).trim()) !== expected.displayName
      ) {
        const error = new Error(
          `Final bar chair registry validation failed for chair ${row.chair_number}`
        );
        error.code = 'BOOTSTRAP_BAR_CHAIR_FINAL_VALIDATION_FAILED';
        throw error;
      }
    }

    await client.query('COMMIT');

    console.log('Bar chair bootstrap complete:', {
      restaurantId,
      restaurantName: restaurant.rows[0].name,
      requested: chairs.length,
      created,
      existing: chairs.length - created,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      console.error('Bar chair bootstrap rollback failed:', {
        code: rollbackError?.code || null,
        message: rollbackError?.message || 'Unknown rollback failure',
      });
    });

    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Bar chair bootstrap failed:', {
    code: error?.code || null,
    message: error?.message || 'Unknown bootstrap failure',
  });

  process.exit(1);
});
