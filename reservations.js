// File: routes/reservations.js
const express = require('express');
const router = express.Router();
const authorizeRoles = require('../middleware/authorizeRoles');

const handleError = (res, err) => res.status(500).json({ error: err.message });

module.exports = (pool, verifyToken) => {
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM reservations ORDER BY reservation_time ASC');
      res.json({ reservations: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/', verifyToken, async (req, res) => {
    const { user_id, restaurant_id, reservation_time, num_guests, table_id, notes } = req.body;
    if (!user_id || !restaurant_id || !reservation_time || !num_guests) {
      return res.status(400).json({ error: 'Missing required reservation fields' });
    }
    try {
      const result = await pool.query(
        `INSERT INTO reservations (user_id, restaurant_id, reservation_time, num_guests, table_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [user_id, restaurant_id, reservation_time, num_guests, table_id, notes]
      );
      res.status(201).json({ reservation: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/:id', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM reservations WHERE id = $1 RETURNING *', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Reservation not found' });
      res.json({ message: 'Reservation cancelled' });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/:id/assign-table', verifyToken, authorizeRoles('Manager', 'Host'), async (req, res) => {
    const { table_id } = req.body;
    if (!table_id) return res.status(400).json({ error: 'table_id required' });
    try {
      const result = await pool.query(
        'UPDATE reservations SET table_id = $1 WHERE id = $2 RETURNING *',
        [table_id, req.params.id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Reservation not found' });
      res.json({ reservation: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/waitlist', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at ASC');
      res.json({ waitlist: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/waitlist', verifyToken, async (req, res) => {
    const { user_id, restaurant_id, num_guests, notes } = req.body;
    if (!user_id || !restaurant_id || !num_guests) {
      return res.status(400).json({ error: 'Missing required waitlist fields' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO waitlist (user_id, restaurant_id, num_guests, notes) VALUES ($1, $2, $3, $4) RETURNING *',
        [user_id, restaurant_id, num_guests, notes]
      );
      res.status(201).json({ waitlist_entry: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/waitlist/:id', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM waitlist WHERE id = $1 RETURNING *', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Waitlist entry not found' });
      res.json({ message: 'Waitlist entry removed' });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/tables/available', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT * FROM tables
        WHERE id NOT IN (
          SELECT table_id FROM reservations WHERE reservation_time > NOW() - INTERVAL '2 hours'
        )
        ORDER BY table_number ASC
      `);
      res.json({ available_tables: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/tables', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { restaurant_id, table_number, capacity } = req.body;
    if (!restaurant_id || !table_number || !capacity) {
      return res.status(400).json({ error: 'Missing table data' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO tables (restaurant_id, table_number, capacity) VALUES ($1, $2, $3) RETURNING *',
        [restaurant_id, table_number, capacity]
      );
      res.status(201).json({ table: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/tables/:id', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM tables WHERE id = $1 RETURNING *', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Table not found' });
      res.json({ message: 'Table deleted' });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/date/:date', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM reservations WHERE DATE(reservation_time) = $1 ORDER BY reservation_time ASC',
        [req.params.date]
      );
      res.json({ reservations: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/user/:user_id', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM reservations WHERE user_id = $1 ORDER BY reservation_time DESC',
        [req.params.user_id]
      );
      res.json({ reservations: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
};
