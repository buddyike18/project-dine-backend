// File: middleware/authorizeRoles.js

module.exports = function authorizeRoles(...allowedRoles) {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    const error = new Error(
      'authorizeRoles requires at least one allowed role'
    );
    error.code = 'ROLE_AUTHORIZATION_CONFIGURATION_INVALID';
    throw error;
  }

  return (req, res, next) => {
    try {
      const actorRole = req.actor?.role;

      if (!req.actor || !actorRole) {
        req.logEvent?.(
          'error',
          'role_authorization_failed',
          { reason: 'ROLE_ACTOR_CONTEXT_MISSING' }
        );

        return res.status(403).json({
          error: 'Forbidden',
        });
      }

      if (!allowedRoles.includes(actorRole)) {
        return res.status(403).json({
          error: 'Forbidden',
        });
      }

      return next();
    } catch (_error) {
      req.logEvent?.(
        'error',
        'role_authorization_failed',
        { reason: 'ROLE_AUTHORIZATION_FAILED' }
      );

      return res.status(500).json({
        error: 'Internal server error',
      });
    }
  };
};
