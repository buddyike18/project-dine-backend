const express = require('express');
const router = express.Router();

const handleError = (res, err) => res.status(500).json({ error: err.message });

module.exports = (pool, verifyToken) => {
  // [GET] /menu/:restaurant_id - Get all menu items for a restaurant
  router.get('/:restaurant_id', async (req, res) => {
    const { restaurant_id } = req.params;
    try {
      const result = await pool.query(
        'SELECT * FROM menu WHERE restaurant_id = $1',
        [restaurant_id]
      );
      res.json({ menu: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /menu - Add a menu item
  router.post('/', verifyToken, async (req, res) => {
    const { restaurant_id, name, price, description, category } = req.body;
    if (!restaurant_id || !name || price == null) {
      return res.status(400).json({ error: 'restaurant_id, name, and price are required' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO menu (restaurant_id, name, price, description, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [restaurant_id, name, price, description || '', category || '']
      );
      res.status(201).json({ menu_item: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PUT] /menu/:id - Update a menu item
  router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { name, price, description, category } = req.body;
    if (!name || price == null) {
      return res.status(400).json({ error: 'name and price are required' });
    }
    try {
      const result = await pool.query(
        'UPDATE menu SET name = $1, price = $2, description = $3, category = $4 WHERE id = $5 RETURNING *',
        [name, price, description || '', category || '', id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Menu item not found' });
      res.json({ menu_item: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [DELETE] /menu/:id - Delete a menu item
  router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query('DELETE FROM menu WHERE id = $1 RETURNING *', [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Menu item not found' });
      res.json({ message: 'Menu item deleted successfully' });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /menu/categories/all - Get distinct categories
  router.get('/categories/all', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT DISTINCT category FROM menu ORDER BY category ASC');
      res.json({ categories: result.rows.map(r => r.category) });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /menu/popular/all - Get most popular menu items
  router.get('/popular/all', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT m.*, COUNT(*) AS order_count
        FROM order_items oi
        JOIN menu m ON oi.menu_id = m.id
        GROUP BY m.id
        ORDER BY order_count DESC
        LIMIT 10
      `);
      res.json({ popular_items: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PATCH] /menu/:id/availability - Toggle menu item availability
  router.patch('/:id/availability', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { available } = req.body;
    if (typeof available !== 'boolean') {
      return res.status(400).json({ error: 'available must be a boolean' });
    }
    try {
      const result = await pool.query(
        'UPDATE menu SET available = $1 WHERE id = $2 RETURNING *',
        [available, id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Menu item not found' });
      res.status(200).json({ menu_item: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /menu/:restaurant_id/search?q=keyword - Search menu items
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
      handleError(res, err);
    }
  });

  return router;
};
