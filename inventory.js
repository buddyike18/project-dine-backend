const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken) => {
  // Get all inventory items
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM inventory');
      res.json({ inventory: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add new inventory item
  router.post('/', verifyToken, async (req, res) => {
    const { name, quantity, unit, low_stock_threshold } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO inventory (name, quantity, unit, low_stock_threshold) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, quantity, unit, low_stock_threshold]
      );
      res.status(201).json({ inventory_item: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update inventory item
  router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { name, quantity, unit, low_stock_threshold } = req.body;
    try {
      const result = await pool.query(
        'UPDATE inventory SET name = $1, quantity = $2, unit = $3, low_stock_threshold = $4 WHERE id = $5 RETURNING *',
        [name, quantity, unit, low_stock_threshold, id]
      );
      res.json({ inventory_item: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete inventory item
  router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('DELETE FROM inventory WHERE id = $1', [id]);
      res.json({ message: 'Inventory item deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get low stock items
  router.get('/low-stock', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM inventory WHERE quantity <= low_stock_threshold'
      );
      res.json({ low_stock_items: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Place supplier order
  router.post('/order', verifyToken, async (req, res) => {
    const { supplier_id, items } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO supplier_orders (supplier_id, items, order_status) VALUES ($1, $2, $3) RETURNING *',
        [supplier_id, JSON.stringify(items), 'Pending']
      );
      res.status(201).json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get all supplier orders
  router.get('/orders', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM supplier_orders');
      res.json({ supplier_orders: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update order status
  router.put('/orders/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { order_status } = req.body;
    try {
      const result = await pool.query(
        'UPDATE supplier_orders SET order_status = $1 WHERE id = $2 RETURNING *',
        [order_status, id]
      );
      res.json({ order: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete supplier order
  router.delete('/orders/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('DELETE FROM supplier_orders WHERE id = $1', [id]);
      res.json({ message: 'Supplier order deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Inventory report
  router.get('/report', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT item_name, quantity, low_stock_threshold,
          (CASE WHEN quantity <= low_stock_threshold THEN true ELSE false END) AS low_stock
        FROM inventory ORDER BY item_name ASC
      `);
      res.json({ inventory_report: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
