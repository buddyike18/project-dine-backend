// File: routes/restaurants.js
const express = require('express');
const router = express.Router();
const authorizeRoles = require('../middleware/authorizeRoles');

const handleError = (res, err) => res.status(500).json({ error: err.message });

module.exports = (pool, verifyToken) => {
  // [GET] /restaurants - Public
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM restaurants ORDER BY name ASC');
      res.json({ restaurants: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /restaurants - Manager only
  router.post('/', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { name, address, phone, description } = req.body;
    if (!name || !address || !phone) {
      return res.status(400).json({ error: 'Missing required restaurant fields' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO restaurants (name, address, phone, description) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, address, phone, description]
      );
      res.status(201).json({ restaurant: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PUT] /restaurants/:id - Manager only
  router.put('/:id', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { name, address, phone, description } = req.body;
    try {
      const result = await pool.query(
        'UPDATE restaurants SET name = $1, address = $2, phone = $3, description = $4 WHERE id = $5 RETURNING *',
        [name, address, phone, description, req.params.id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Restaurant not found' });
      res.json({ restaurant: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [DELETE] /restaurants/:id - Manager only
  router.delete('/:id', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM restaurants WHERE id = $1 RETURNING *', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Restaurant not found' });
      res.json({ message: 'Restaurant deleted' });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /restaurants/:id/categories - Manager only
  router.post('/:id/categories', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    try {
      const result = await pool.query(
        'INSERT INTO menu_categories (restaurant_id, name) VALUES ($1, $2) RETURNING *',
        [req.params.id, name]
      );
      res.status(201).json({ category: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /restaurants/:id/categories - Authenticated users
  router.get('/:id/categories', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM menu_categories WHERE restaurant_id = $1 ORDER BY name ASC',
        [req.params.id]
      );
      res.json({ categories: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /restaurants/menu/:menu_id/modifiers - Manager only
  router.post('/menu/:menu_id/modifiers', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { name, price } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'Modifier name and price required' });
    try {
      const result = await pool.query(
        'INSERT INTO menu_modifiers (menu_id, name, price) VALUES ($1, $2, $3) RETURNING *',
        [req.params.menu_id, name, price]
      );
      res.status(201).json({ modifier: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /restaurants/menu/:menu_id/modifiers - Public
  router.get('/menu/:menu_id/modifiers', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM menu_modifiers WHERE menu_id = $1 ORDER BY name ASC',
        [req.params.menu_id]
      );
      res.json({ modifiers: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [DELETE] /restaurants/modifiers/:id - Manager only
  router.delete('/modifiers/:id', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM menu_modifiers WHERE id = $1 RETURNING *', [req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Modifier not found' });
      res.json({ message: 'Modifier deleted' });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PATCH] /restaurants/:id/status - Manager only
  router.patch('/:id/status', verifyToken, authorizeRoles('Manager'), async (req, res) => {
    const { is_open } = req.body;
    if (typeof is_open !== 'boolean') return res.status(400).json({ error: 'is_open must be boolean' });
    try {
      const result = await pool.query(
        'UPDATE restaurants SET is_open = $1 WHERE id = $2 RETURNING *',
        [is_open, req.params.id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Restaurant not found' });
      res.json({ restaurant: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /restaurants/search/by-name?q=
  router.get('/search/by-name', async (req, res) => {
    const { q } = req.query;
    try {
      const result = await pool.query(
        'SELECT * FROM restaurants WHERE name ILIKE $1 ORDER BY name ASC',
        [`%${q}%`]
      );
      res.json({ restaurants: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /restaurants/nearby?lat=&lng=&radius_km=
  router.get('/nearby', async (req, res) => {
    const { lat, lng, radius_km } = req.query;
    if (!lat || !lng || !radius_km) return res.status(400).json({ error: 'Missing lat/lng/radius_km query params' });
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
      handleError(res, err);
    }
  });

  return router;
};