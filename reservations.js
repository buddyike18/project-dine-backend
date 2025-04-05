const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken) => {
  // Existing endpoints...

  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM reservations ORDER BY reservation_time ASC');
      res.json({ reservations: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', verifyToken, async (req, res) => {
    const { user_id, restaurant_id, reservation_time, num_guests, table_id, notes } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO reservations (user_id, restaurant_id, reservation_time, num_guests, table_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [user_id, restaurant_id, reservation_time, num_guests, table_id, notes]
      );
      res.status(201).json({ reservation: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', verifyToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM reservations WHERE id = $1', [req.params.id]);
      res.json({ message: 'Reservation cancelled' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id/assign-table', verifyToken, async (req, res) => {
    const { table_id } = req.body;
    try {
      const result = await pool.query(
        'UPDATE reservations SET table_id = $1 WHERE id = $2 RETURNING *',
        [table_id, req.params.id]
      );
      res.json({ reservation: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/waitlist', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at ASC');
      res.json({ waitlist: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/waitlist', verifyToken, async (req, res) => {
    const { user_id, restaurant_id, num_guests, notes } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO waitlist (user_id, restaurant_id, num_guests, notes)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [user_id, restaurant_id, num_guests, notes]
      );
      res.status(201).json({ waitlist_entry: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/waitlist/:id', verifyToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM waitlist WHERE id = $1', [req.params.id]);
      res.json({ message: 'Waitlist entry removed' });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tables', verifyToken, async (req, res) => {
    const { restaurant_id, table_number, capacity } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO tables (restaurant_id, table_number, capacity) VALUES ($1, $2, $3) RETURNING *',
        [restaurant_id, table_number, capacity]
      );
      res.status(201).json({ table: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/tables/:id', verifyToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM tables WHERE id = $1', [req.params.id]);
      res.json({ message: 'Table deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // NEW: Get reservations by date
  router.get('/date/:date', verifyToken, async (req, res) => {
    const { date } = req.params;
    try {
      const result = await pool.query(
        'SELECT * FROM reservations WHERE DATE(reservation_time) = $1 ORDER BY reservation_time ASC',
        [date]
      );
      res.json({ reservations: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // NEW: Get reservations by user
  router.get('/user/:user_id', verifyToken, async (req, res) => {
    const { user_id } = req.params;
    try {
      const result = await pool.query(
        'SELECT * FROM reservations WHERE user_id = $1 ORDER BY reservation_time DESC',
        [user_id]
      );
      res.json({ reservations: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
