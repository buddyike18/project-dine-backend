const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken, admin, logEvent) => {
  router.use(
    '/auth',
    require('./auth')(pool, verifyToken, logEvent)
  );

  router.use('/menu', require('./menu')(pool, verifyToken));
  router.use('/restaurants', require('./restaurants')(pool));
  router.use(
    '/table-sessions',
    require('./tableSessions')(pool, verifyToken)
  );
  router.use('/orders', require('./orders')(pool, verifyToken));
  router.use('/payments', require('./payments')(pool, verifyToken));
  router.use('/reports', require('./reports')(pool, verifyToken));
  router.use(
    '/staff',
    require('./staff')(pool, verifyToken, admin)
  );
  router.use(
    '/table-assignments',
    require('./tableAssignments')(pool, verifyToken)
  );

  return router;
};
