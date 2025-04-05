// File: orders.js
const express = require('express');
const router = express.Router();
const pool = require('./db');

const handleError = (res, err) => res.status(500).json({ error: err.message });
const allowedStatus = ['Pending', 'Preparing', 'Ready', 'Served', 'Completed'];
const allowedPriority = ['Low', 'Medium', 'High', 'Urgent'];

// validation middleware factory
const validate = (checks) => (req, res, next) => {
  for (const [field, check] of Object.entries(checks)) {
    if (!check(req.body[field])) {
      return res.status(400).json({ error: `Invalid or missing '${field}'` });
    }
  }
  next();
};

module.exports = (verifyToken) => {
  // Get all orders for user with items
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
      res.status(500).json({ error: err.message });
    }
  });

  // Place new order with items and payment
  router.post('/', verifyToken, async (req, res) => {
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
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Delete order by ID (cascades to items/payments)
  router.delete('/:id', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM orders WHERE id = $1 AND user_id = $2 RETURNING *',
        [req.params.id, req.user.uid]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }
      res.json({ message: 'Order deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update order status
  router.put('/:id/status', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['Pending', 'Preparing', 'Ready', 'Served', 'Completed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    try {
      const result = await pool.query(
        'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
        [status, id, req.user.uid]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Order not found or unauthorized' });
      }
      res.json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Submit review for an order
router.post('/:id/review', verifyToken, async (req, res) => {
  const { rating, comment } = req.body;
  const orderId = req.params.id;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO reviews (user_id, order_id, rating, comment, created_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [req.user.uid, orderId, rating, comment]
    );

    res.status(201).json({ review: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View order history for the logged-in user
router.get('/history', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, 
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
    res.status(500).json({ error: err.message });
  }
});

// Assign order to a chef
router.put('/:id/assign', verifyToken, async (req, res) => {
  const { chef_id } = req.body;
  const { id } = req.params;

  if (!chef_id || isNaN(chef_id)) {
    return res.status(400).json({ error: 'Invalid chef_id' });
  }

  try {
    const result = await pool.query(
      `UPDATE orders 
       SET assigned_chef_id = $1, updated_at = NOW() 
       WHERE id = $2 AND user_id = $3 
       RETURNING *`,
      [chef_id, id, req.user.uid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found or unauthorized' });
    }

    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get orders by status for the logged-in user
router.get('/status/:status', verifyToken, async (req, res) => {
  const { status } = req.params;
  const allowed = ['Pending', 'Preparing', 'Ready', 'Served', 'Completed'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  try {
    const result = await pool.query(
      `SELECT o.*, 
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
    res.status(500).json({ error: err.message });
  }
});

// Get active orders for KDS (kitchen display system)
router.get('/kds/active', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, 
              COALESCE(json_agg(json_build_object(
                'menu_id', oi.menu_id,
                'quantity', oi.quantity,
                'price', oi.price
              )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.status IN ('Pending', 'Preparing')
       GROUP BY o.id
       ORDER BY o.created_at ASC`
    );

    res.json({ active_orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get completed orders for KDS (kitchen display system)
router.get('/kds/completed', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, 
              COALESCE(json_agg(json_build_object(
                'menu_id', oi.menu_id,
                'quantity', oi.quantity,
                'price', oi.price
              )) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.status = 'Completed'
       GROUP BY o.id
       ORDER BY o.updated_at DESC`
    );

    res.json({ completed_orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update the priority level of an order
router.put('/:id/priority', verifyToken, async (req, res) => {
  const { priority_level } = req.body;
  const { id } = req.params;
  const allowed = ['Low', 'Medium', 'High', 'Urgent'];

  if (!allowed.includes(priority_level)) {
    return res.status(400).json({ error: 'Invalid priority level' });
  }

  try {
    const result = await pool.query(
      `UPDATE orders 
       SET priority_level = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 
       RETURNING *`,
      [priority_level, id, req.user.uid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found or unauthorized' });
    }

    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update order items and total price
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { items, total_price } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, req.user.uid]
    );
    if (check.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or unauthorized' });
    }

    await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);

    for (const item of items) {
      await client.query(
        'INSERT INTO order_items (order_id, menu_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [id, item.menu_id, item.quantity, item.price]
      );
    }

    const update = await client.query(
      'UPDATE orders SET total_price = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [total_price, id]
    );

    await client.query('COMMIT');
    res.json({ order: update.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Add or update modifiers on an order
router.post('/:id/modifiers', verifyToken, async (req, res) => {
  const { modifiers } = req.body;
  const { id } = req.params;

  try {
    const result = await pool.query(
      'UPDATE orders SET modifiers = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
      [JSON.stringify(modifiers), id, req.user.uid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found or unauthorized' });
    }

    res.json({ order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  return router;
};
