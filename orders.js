const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken) => {
  // Get all orders for user
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM orders WHERE user_id = $1', [req.user.uid]);
      res.json({ orders: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Place new order
  router.post('/', verifyToken, async (req, res) => {
    const { restaurant_id, items, total_price } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO orders (user_id, restaurant_id, items, total_price) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.user.uid, restaurant_id, JSON.stringify(items), total_price]
      );
      res.status(201).json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update order
  router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { items, total_price } = req.body;
    try {
      const result = await pool.query(
        'UPDATE orders SET items = $1, total_price = $2 WHERE id = $3 RETURNING *',
        [JSON.stringify(items), total_price, id]
      );
      res.json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete order
  router.delete('/:id', verifyToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
      res.json({ message: 'Order deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add custom modifiers to order
  router.post('/:id/modifiers', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { modifiers } = req.body;
    try {
      const result = await pool.query(
        'UPDATE orders SET modifiers = $1 WHERE id = $2 RETURNING *',
        [JSON.stringify(modifiers), id]
      );
      res.json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Adjust order priority level
  router.put('/:id/priority', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { priority_level } = req.body;
    if (!['Low', 'Medium', 'High', 'Urgent'].includes(priority_level)) {
      return res.status(400).json({ error: 'Invalid priority level' });
    }
    try {
      const result = await pool.query(
        'UPDATE orders SET priority_level = $1 WHERE id = $2 RETURNING *',
        [priority_level, id]
      );
      res.json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update kitchen order status (KDS)
  router.put('/:id/status', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!['Pending', 'Preparing', 'Ready', 'Served', 'Completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    try {
      const result = await pool.query(
        'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );
      res.json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // KDS: get active orders
  router.get('/kds/active', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM orders WHERE status IN ('Pending', 'Preparing') ORDER BY created_at ASC"
      );
      res.json({ orders: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // KDS: completed orders
  router.get('/kds/completed', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM orders WHERE status = 'Completed' ORDER BY updated_at DESC"
      );
      res.json({ completed_orders: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // KDS: assign order to chef
  router.put('/:id/assign', verifyToken, async (req, res) => {
    const { chef_id } = req.body;
    try {
      const result = await pool.query(
        'UPDATE orders SET assigned_chef_id = $1 WHERE id = $2 RETURNING *',
        [chef_id, req.params.id]
      );
      res.json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Submit review for order
  router.post('/:id/review', verifyToken, async (req, res) => {
    const { rating, comment } = req.body;
    const order_id = req.params.id;

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    try {
      const result = await pool.query(
        'INSERT INTO reviews (user_id, order_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [req.user.uid, order_id, rating, comment]
      );
      res.status(201).json({ review: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
