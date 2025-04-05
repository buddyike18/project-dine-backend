const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken) => {
  // Get all menu items for a restaurant
  router.get('/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try {
      const result = await pool.query(
        'SELECT * FROM menu WHERE restaurant_id = $1',
        [restaurant_id]
      );
      res.json({ menu: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add a menu item
  router.post('/', verifyToken, async (req, res) => {
    const { restaurant_id, name, price, description, category } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO menu (restaurant_id, name, price, description, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [restaurant_id, name, price, description, category]
      );
      res.status(201).json({ menu_item: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update a menu item
  router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { name, price, description, category } = req.body;
    try {
      const result = await pool.query(
        'UPDATE menu SET name = $1, price = $2, description = $3, category = $4 WHERE id = $5 RETURNING *',
        [name, price, description, category, id]
      );
      res.json({ menu_item: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a menu item
  router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('DELETE FROM menu WHERE id = $1', [id]);
      res.json({ message: 'Menu item deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get distinct categories
  router.get('/categories/all', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT DISTINCT category FROM menu ORDER BY category ASC'
      );
      res.json({ categories: result.rows.map(r => r.category) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get popular items
  router.get('/popular/all', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT menu_item, COUNT(*) AS order_count
        FROM orders
        GROUP BY menu_item
        ORDER BY order_count DESC
        LIMIT 10
      `);
      res.json({ popular_items: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle menu item availability
  router.patch('/:id/availability', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { available } = req.body;
    try {
      const result = await pool.query(
        'UPDATE menu SET available = $1 WHERE id = $2 RETURNING *',
        [available, id]
      );
      res.status(200).json({ menu_item: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Search menu items by keyword
  router.get('/:restaurant_id/search', async (req, res) => {
    const { restaurant_id } = req.params;
    const { q } = req.query;
    try {
      const result = await pool.query(
        'SELECT * FROM menu WHERE restaurant_id = $1 AND (name ILIKE $2 OR description ILIKE $2)',
        [restaurant_id, `%${q}%`]
      );
      res.json({ results: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};