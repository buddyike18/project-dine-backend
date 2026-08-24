// File: db.js
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis,
  idleTimeoutMillis: config.database.idleTimeoutMillis,
  ssl: config.database.sslOptions,
});

pool.on('error', () => {
  process.emitWarning('postgres_pool_idle_client_error', {
    code: 'POSTGRES_POOL_IDLE_CLIENT_ERROR',
  });
});

module.exports = pool;
