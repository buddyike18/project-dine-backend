// File: routes/orders.js
module.exports = (pool, verifyToken) => {
  const express = require('express');
  const router = express.Router();
  const authorizeRoles = require('../middleware/authorizeRoles');

  const handleError = (res, err) => res.status(500).json({ error: err.message });
  const allowedStatus = ['Pending', 'Preparing', 'Ready', 'Served', 'Completed'];
  const allowedPriority = ['Low', 'Medium', 'High', 'Urgent'];

  const validate = (rules) => (req, res, next) => {
    for (const [field, check] of Object.entries(rules)) {
      if (!check(req.body[field])) {
        return res.status(400).json({ error: `Invalid or missing '${field}'` });
      }
    }
    next();
  };

  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT o.*, 
               COALESCE(json_agg(json_build_object(
                 'menu_id', oi.menu_id,
                 'quantity', oi.quantity,
                 'price', oi.price
               )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        WHERE o.user_id = $1
        GROUP BY o.id
        ORDER BY o.created_at DESC
      `, [req.user.uid]);
      res.json({ orders: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/', validate({
    restaurant_id: Number.isInteger,
    items: Array.isArray,
    total_price: (v) => typeof v === 'number' && v >= 0,
  }), verifyToken, authorizeRoles('Manager', 'Bartender', 'Host', 'Server'), async (req, res) => {
    const client = await pool.connect();
    const { restaurant_id, items, total_price, payment } = req.body;
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(
        'INSERT INTO orders (user_id, restaurant_id, total_price, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [req.user.uid, restaurant_id, total_price]
      );
      const order = orderResult.rows[0];

      for (const item of items) {
        await client.query(
          'INSERT INTO order_items (order_id, menu_id, quantity, price) VALUES ($1, $2, $3, $4)',
          [order.id, item.menu_id, item.quantity, item.price]
        );
      }

      if (payment) {
        await client.query(
          'INSERT INTO payments (order_id, amount, method) VALUES ($1, $2, $3)',
          [order.id, payment.amount, payment.method]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ order });
    } catch (err) {
      await client.query('ROLLBACK');
      handleError(res, err);
    } finally {
      client.release();
    }
  });

  router.delete('/:id', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM orders WHERE id = $1 AND user_id = $2 RETURNING *',
        [req.params.id, req.user.uid]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found or unauthorized' });
      res.json({ message: 'Order deleted successfully' });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/:id/status', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { status } = req.body;
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    try {
      const result = await pool.query(
        'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
        [status, req.params.id, req.user.uid]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found or unauthorized' });
      res.json({ order: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/:id/review', validate({
    rating: (v) => Number.isInteger(v) && v >= 1 && v <= 5,
    comment: (v) => typeof v === 'string',
  }), verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'INSERT INTO reviews (user_id, order_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [req.user.uid, req.params.id, req.body.rating, req.body.comment]
      );
      res.status(201).json({ review: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/history', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT o.*, 
                COALESCE(json_agg(json_build_object(
                  'menu_id', oi.menu_id,
                  'quantity', oi.quantity,
                  'price', oi.price
                )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
         FROM orders o
         LEFT JOIN order_items oi ON o.id = oi.order_id
         WHERE o.user_id = $1
         GROUP BY o.id
         ORDER BY o.created_at DESC`,
        [req.user.uid]
      );
      res.json({ history: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/:id/assign', validate({ chef_id: Number.isInteger }), verifyToken, authorizeRoles('Manager'), async (req, res) => {
    try {
      const result = await pool.query(
        'UPDATE orders SET assigned_chef_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
        [req.body.chef_id, req.params.id, req.user.uid]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found or unauthorized' });
      res.json({ order: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/status/:status', verifyToken, async (req, res) => {
    const { status } = req.params;
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    try {
      const result = await pool.query(`
        SELECT o.*, 
                COALESCE(json_agg(json_build_object(
                  'menu_id', oi.menu_id,
                  'quantity', oi.quantity,
                  'price', oi.price
                )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
         FROM orders o
         LEFT JOIN order_items oi ON o.id = oi.order_id
         WHERE o.user_id = $1 AND o.status = $2
         GROUP BY o.id
         ORDER BY o.created_at DESC`,
        [req.user.uid, status]
      );
      res.json({ filtered: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/kds/active', verifyToken, authorizeRoles('Manager', 'Line Cook', 'Prep Cook'), async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT o.*, 
                COALESCE(json_agg(json_build_object(
                  'menu_id', oi.menu_id,
                  'quantity', oi.quantity,
                  'price', oi.price
                )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
         FROM orders o
         LEFT JOIN order_items oi ON o.id = oi.order_id
         WHERE o.status IN ('Pending', 'Preparing')
         GROUP BY o.id
         ORDER BY o.created_at ASC`);
      res.json({ active_orders: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/kds/completed', verifyToken, authorizeRoles('Manager', 'Line Cook', 'Prep Cook'), async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT o.*, 
                COALESCE(json_agg(json_build_object(
                  'menu_id', oi.menu_id,
                  'quantity', oi.quantity,
                  'price', oi.price
                )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
         FROM orders o
         LEFT JOIN order_items oi ON o.id = oi.order_id
         WHERE o.status = 'Completed'
         GROUP BY o.id
         ORDER BY o.updated_at DESC`);
      res.json({ completed_orders: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/:id/priority', validate({
    priority_level: (v) => allowedPriority.includes(v)
  }), verifyToken, authorizeRoles('Manager'), async (req, res) => {
    try {
      const result = await pool.query(
        'UPDATE orders SET priority_level = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
        [req.body.priority_level, req.params.id, req.user.uid]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found or unauthorized' });
      res.json({ order: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/:id', validate({
    items: Array.isArray,
    total_price: (v) => typeof v === 'number' && v >= 0,
  }), verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const check = await client.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.uid]);
      if (check.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }

      await client.query('DELETE FROM order_items WHERE order_id = $1', [req.params.id]);
      for (const item of req.body.items) {
        await client.query(
          'INSERT INTO order_items (order_id, menu_id, quantity, price) VALUES ($1, $2, $3, $4)',
          [req.params.id, item.menu_id, item.quantity, item.price]
        );
      }

      const update = await client.query(
        'UPDATE orders SET total_price = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [req.body.total_price, req.params.id]
      );

      await client.query('COMMIT');
      res.json({ order: update.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      handleError(res, err);
    } finally {
      client.release();
    }
  });

  router.post('/:id/modifiers', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { modifiers } = req.body;
    if (!Array.isArray(modifiers)) {
      return res.status(400).json({ error: 'Modifiers must be an array' });
    }
    try {
      const result = await pool.query(
        'UPDATE orders SET modifiers = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
        [JSON.stringify(modifiers), req.params.id, req.user.uid]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found or unauthorized' });
      res.json({ order: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
};