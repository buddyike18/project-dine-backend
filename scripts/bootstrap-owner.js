'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const firebaseAdmin = require('firebase-admin');

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

function initializeFirebase() {
  if (firebaseAdmin.apps.length > 0) {
    return;
  }

  const projectId = required('FIREBASE_PROJECT_ID');
  const serviceAccountPath = required('FIREBASE_SERVICE_ACCOUNT_PATH');

  const serviceAccount = JSON.parse(
    fs.readFileSync(serviceAccountPath, 'utf8')
  );

  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount),
    projectId,
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
  const firebaseUid = required('BOOTSTRAP_FIREBASE_UID');
  const restaurantId = required('BOOTSTRAP_RESTAURANT_ID');
  const ownerName = required('BOOTSTRAP_OWNER_NAME');

  if (!secureEqual(configuredSecret, suppliedSecret)) {
    const error = new Error('Bootstrap authorization failed');
    error.code = 'BOOTSTRAP_UNAUTHORIZED';
    throw error;
  }

  initializeFirebase();

  /*
   * Validate the Firebase identity before opening the database transaction.
   * This proves the supplied UID belongs to a real Firebase Authentication
   * user without mutating either system.
   */
  const firebaseUser = await firebaseAdmin.auth().getUser(firebaseUid);
  const previousClaims = firebaseUser.customClaims || {};

  const pool = buildPool();
  let client;
  let claimsUpdated = false;
  let committed = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    /*
     * Lock the restaurant row. This both validates the restaurant and
     * serializes concurrent bootstrap attempts for the same restaurant.
     */
    const restaurantResult = await client.query(
      `
        SELECT id
        FROM restaurants
        WHERE id = $1
        FOR UPDATE
      `,
      [restaurantId]
    );

    if (restaurantResult.rowCount !== 1) {
      const error = new Error('Restaurant does not exist');
      error.code = 'BOOTSTRAP_RESTAURANT_NOT_FOUND';
      throw error;
    }

    /*
     * Bootstrap is permanently disabled for this restaurant as soon as
     * an active Owner exists.
     */
    const ownerResult = await client.query(
      `
        SELECT id
        FROM users
        WHERE restaurant_id = $1
          AND role = 'Owner'
          AND active = true
        LIMIT 1
      `,
      [restaurantId]
    );

    if (ownerResult.rowCount > 0) {
      const error = new Error(
        'Bootstrap refused: an active Owner already exists for this restaurant'
      );
      error.code = 'BOOTSTRAP_OWNER_ALREADY_EXISTS';
      throw error;
    }

    /*
     * Never use bootstrap as a role override for an already provisioned
     * database identity.
     */
    const existingUserResult = await client.query(
      `
        SELECT id, restaurant_id, role, active
        FROM users
        WHERE firebase_uid = $1
        LIMIT 1
      `,
      [firebaseUid]
    );

    if (existingUserResult.rowCount > 0) {
      const error = new Error(
        'Bootstrap refused: Firebase UID is already provisioned'
      );
      error.code = 'BOOTSTRAP_UID_ALREADY_PROVISIONED';
      throw error;
    }

    const insertResult = await client.query(
      `
        INSERT INTO users (
          firebase_uid,
          restaurant_id,
          role,
          name,
          active
        )
        VALUES ($1, $2, 'Owner', $3, true)
        RETURNING
          id,
          firebase_uid,
          restaurant_id,
          role,
          name,
          active,
          created_at
      `,
      [firebaseUid, restaurantId, ownerName]
    );

    const owner = insertResult.rows[0];

    await firebaseAdmin.auth().setCustomUserClaims(firebaseUid, {
      ...previousClaims,
      role: 'Owner',
      restaurantId,
      staff_user_id: owner.id,
    });

    claimsUpdated = true;

    await client.query('COMMIT');
    committed = true;

    console.log('Initial Owner bootstrap succeeded.');
    console.log({
      id: owner.id,
      firebase_uid: owner.firebase_uid,
      restaurant_id: owner.restaurant_id,
      role: owner.role,
      name: owner.name,
      active: owner.active,
    });
  } catch (error) {
    if (client && !committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Database rollback failed:', {
          code: rollbackError?.code || null,
          message: rollbackError?.message || 'Unknown rollback failure',
        });
      }
    }

    /*
     * If Firebase was changed but PostgreSQL did not commit, restore the
     * exact claims that existed before bootstrap.
     */
    if (claimsUpdated && !committed) {
      try {
        await firebaseAdmin.auth().setCustomUserClaims(
          firebaseUid,
          previousClaims
        );
      } catch (claimsRollbackError) {
        console.error('Firebase claims rollback failed:', {
          code: claimsRollbackError?.code || null,
          message:
            claimsRollbackError?.message ||
            'Unknown Firebase claims rollback failure',
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
  console.error('Initial Owner bootstrap failed:', {
    code: error?.code || null,
    message: error?.message || 'Unknown bootstrap failure',
  });

  process.exit(1);
});
