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

  // Toggle open/closed status
  router.patch('/:id/status', verifyToken, async (req, res) => {
    const { is_open } = req.body;
    try {
      const result = await pool.query(
        'UPDATE restaurants SET is_open = $1 WHERE id = $2 RETURNING *',
        [is_open, req.params.id]
      );
      res.json({ restaurant: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Search restaurants by name
  router.get('/search/by-name', async (req, res) => {
    const { q } = req.query;
    try {
      const result = await pool.query(
        'SELECT * FROM restaurants WHERE name ILIKE $1 ORDER BY name ASC',
        [`%${q}%`]
      );
      res.json({ restaurants: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Location-based nearby search (simple lat/lng radius)
  router.get('/nearby', async (req, res) => {
    const { lat, lng, radius_km } = req.query;
    try {
      const result = await pool.query(
        `SELECT *, ( 6371 * acos( cos( radians($1) ) * cos( radians(latitude) ) * cos( radians(longitude) - radians($2) ) + sin( radians($1) ) * sin( radians(latitude) ) ) ) AS distance_km
         FROM restaurants
         HAVING ( 6371 * acos( cos( radians($1) ) * cos( radians(latitude) ) * cos( radians(longitude) - radians($2) ) + sin( radians($1) ) * sin( radians(latitude) ) ) ) < $3
         ORDER BY distance_km ASC`,
        [lat, lng, radius_km]
      );
      res.json({ nearby: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
