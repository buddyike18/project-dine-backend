const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken, admin) => {
  // Load and mount route modules
  router.use('/auth', require('./auth')(pool, verifyToken));
  router.use('/employees', require('./employees')(pool, verifyToken));
  router.use('/inventory', require('./inventory')(pool, verifyToken));
  router.use('/menu', require('./menu')(pool, verifyToken));
  router.use('/notifications', require('./notifications')(pool, verifyToken, admin));
  router.use('/orders', require('./orders')(pool, verifyToken));
  router.use('/reports', require('./reports')(pool, verifyToken));
  router.use('/reservations', require('./reservations')(pool, verifyToken));
  router.use('/restaurants', require('./restaurants')(pool, verifyToken));

  return router;
};
