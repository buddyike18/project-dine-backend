const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken) => {
  // Get all restaurants
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM restaurants ORDER BY name ASC');
      res.json({ restaurants: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create new restaurant
  router.post('/', verifyToken, async (req, res) => {
    const { name, address, phone, description } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO restaurants (name, address, phone, description) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, address, phone, description]
      );
      res.status(201).json({ restaurant: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update restaurant
  router.put('/:id', verifyToken, async (req, res) => {
    const { name, address, phone, description } = req.body;
    try {
      const result = await pool.query(
        'UPDATE restaurants SET name = $1, address = $2, phone = $3, description = $4 WHERE id = $5 RETURNING *',
        [name, address, phone, description, req.params.id]
      );
      res.json({ restaurant: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete restaurant
  router.delete('/:id', verifyToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM restaurants WHERE id = $1', [req.params.id]);
      res.json({ message: 'Restaurant deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add menu category
  router.post('/:id/categories', verifyToken, async (req, res) => {
    const { name } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO menu_categories (restaurant_id, name) VALUES ($1, $2) RETURNING *',
        [req.params.id, name]
      );
      res.status(201).json({ category: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get categories for restaurant
  router.get('/:id/categories', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM menu_categories WHERE restaurant_id = $1 ORDER BY name ASC',
        [req.params.id]
      );
      res.json({ categories: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add modifiers for a menu item
  router.post('/menu/:menu_id/modifiers', verifyToken, async (req, res) => {
    const { name, price } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO menu_modifiers (menu_id, name, price) VALUES ($1, $2, $3) RETURNING *',
        [req.params.menu_id, name, price]
      );
      res.status(201).json({ modifier: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get modifiers for menu item
  router.get('/menu/:menu_id/modifiers', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM menu_modifiers WHERE menu_id = $1 ORDER BY name ASC',
        [req.params.menu_id]
      );
      res.json({ modifiers: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete modifier
  router.delete('/modifiers/:id', verifyToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM menu_modifiers WHERE id = $1', [req.params.id]);
      res.json({ message: 'Modifier deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
