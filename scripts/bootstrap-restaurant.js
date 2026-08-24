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

function isValidIanaTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
    }).format();

    return true;
  } catch {
    return false;
  }
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

  const restaurantName = required('BOOTSTRAP_RESTAURANT_NAME');
  const restaurantTimezone = required('BOOTSTRAP_RESTAURANT_TIMEZONE');

  if (!secureEqual(configuredSecret, suppliedSecret)) {
    const error = new Error('Bootstrap authorization failed');
    error.code = 'BOOTSTRAP_UNAUTHORIZED';
    throw error;
  }

  if (restaurantName.length > 200) {
    const error = new Error('Restaurant name is too long');
    error.code = 'BOOTSTRAP_INVALID_RESTAURANT_NAME';
    throw error;
  }

  if (!isValidIanaTimezone(restaurantTimezone)) {
    const error = new Error('Restaurant timezone must be a valid IANA timezone');
    error.code = 'BOOTSTRAP_INVALID_TIMEZONE';
    throw error;
  }

  const pool = buildPool();
  let client;
  let committed = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    /*
     * Serialize initial bootstrap attempts. This operator-only mechanism
     * is intentionally usable only while the restaurants table is empty.
     */
    await client.query('LOCK TABLE restaurants IN EXCLUSIVE MODE');

    const existingRestaurants = await client.query(
      `
        SELECT id
        FROM restaurants
        LIMIT 1
      `
    );

    if (existingRestaurants.rowCount > 0) {
      const error = new Error(
        'Bootstrap refused: a restaurant already exists'
      );
      error.code = 'BOOTSTRAP_RESTAURANT_ALREADY_EXISTS';
      throw error;
    }

    const result = await client.query(
      `
        INSERT INTO restaurants (
          name,
          timezone,
          active
        )
        VALUES ($1, $2, true)
        RETURNING
          id,
          name,
          timezone,
          active,
          created_at
      `,
      [restaurantName, restaurantTimezone]
    );

    await client.query('COMMIT');
    committed = true;

    const restaurant = result.rows[0];

    console.log('Initial restaurant bootstrap succeeded.');
    console.log({
      id: restaurant.id,
      name: restaurant.name,
      timezone: restaurant.timezone,
      active: restaurant.active,
      created_at: restaurant.created_at,
    });
  } catch (error) {
    if (client && !committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Database rollback failed:', {
          code: rollbackError?.code || null,
          message:
            rollbackError?.message || 'Unknown rollback failure',
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
  console.error('Initial restaurant bootstrap failed:', {
    code: error?.code || null,
    message: error?.message || 'Unknown bootstrap failure',
  });

  process.exit(1);
});
