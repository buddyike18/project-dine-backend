// File: routes/orders.js

const authorizeRoles = require('../middleware/authorizeRoles');
const buildOrdersRouter = require('./orders/orders.routes');

/**
 * Thin wrapper that preserves the existing export signature:
 *   module.exports = (pool, verifyToken) => router
 *
 * Routes and logic are implemented in ./orders/orders.routes.js
 */
module.exports = (pool, verifyToken) => {
  const requireRoles = (...roles) =>
    authorizeRoles(...roles);

  const handleError = (res, _err) =>
    res.status(500).json({
      error: 'Internal server error',
    });

return buildOrdersRouter({ pool, verifyToken, requireRoles, handleError });
};