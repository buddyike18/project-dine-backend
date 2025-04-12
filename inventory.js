const express = require('express');
const router = express.Router();

const handleError = (res, err) => res.status(500).json({ error: err.message });

module.exports = (pool, verifyToken) => {
  // [GET] /inventory - Get all inventory items
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM inventory');
      res.json({ inventory: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /inventory - Add new inventory item
  router.post('/', verifyToken, async (req, res) => {
    const { name, quantity, unit, low_stock_threshold } = req.body;
    if (!name || quantity == null || !unit) {
      return res.status(400).json({ error: 'Name, quantity, and unit are required' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO inventory (name, quantity, unit, low_stock_threshold) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, quantity, unit, low_stock_threshold || 0]
      );
      res.status(201).json({ inventory_item: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PUT] /inventory/:id - Update inventory item
  router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { name, quantity, unit, low_stock_threshold } = req.body;
    if (!name || quantity == null || !unit) {
      return res.status(400).json({ error: 'Name, quantity, and unit are required' });
    }
    try {
      const result = await pool.query(
        'UPDATE inventory SET name = $1, quantity = $2, unit = $3, low_stock_threshold = $4 WHERE id = $5 RETURNING *',
        [name, quantity, unit, low_stock_threshold || 0, id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Inventory item not found' });
      res.json({ inventory_item: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [DELETE] /inventory/:id - Delete inventory item
  router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query('DELETE FROM inventory WHERE id = $1 RETURNING *', [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Inventory item not found' });
      res.json({ message: 'Inventory item deleted' });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /inventory/low-stock - Get low stock items
  router.get('/low-stock', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM inventory WHERE quantity <= low_stock_threshold'
      );
      res.json({ low_stock_items: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /inventory/order - Place supplier order
  router.post('/order', verifyToken, async (req, res) => {
    const { supplier_id, items } = req.body;
    if (!supplier_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Supplier ID and items are required' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO supplier_orders (supplier_id, items, order_status) VALUES ($1, $2, $3) RETURNING *',
        [supplier_id, JSON.stringify(items), 'Pending']
      );
      res.status(201).json({ order: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /inventory/orders - Get all supplier orders
  router.get('/orders', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM supplier_orders');
      res.json({ supplier_orders: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PUT] /inventory/orders/:id - Update order status
  router.put('/orders/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { order_status } = req.body;
    if (!order_status) {
      return res.status(400).json({ error: 'Order status is required' });
    }
    try {
      const result = await pool.query(
        'UPDATE supplier_orders SET order_status = $1 WHERE id = $2 RETURNING *',
        [order_status, id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
      res.json({ order: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [DELETE] /inventory/orders/:id - Delete supplier order
  router.delete('/orders/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query('DELETE FROM supplier_orders WHERE id = $1 RETURNING *', [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
      res.json({ message: 'Supplier order deleted' });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /inventory/report - Inventory stock report
  router.get('/report', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT name AS item_name, quantity, low_stock_threshold,
          (CASE WHEN quantity <= low_stock_threshold THEN true ELSE false END) AS low_stock
        FROM inventory ORDER BY name ASC
      `);
      res.json({ inventory_report: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /inventory/bulk-update - Bulk update inventory
  router.post('/bulk-update', verifyToken, async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items must be a non-empty array' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        if (typeof item.id !== 'number' || typeof item.quantity !== 'number') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Each item must have numeric id and quantity' });
        }
        await client.query(
          'UPDATE inventory SET quantity = $1 WHERE id = $2',
          [item.quantity, item.id]
        );
      }
      await client.query('COMMIT');
      res.status(200).json({ message: 'Bulk update successful' });
    } catch (err) {
      await client.query('ROLLBACK');
      handleError(res, err);
    } finally {
      client.release();
    }
  });

  return router;
};
