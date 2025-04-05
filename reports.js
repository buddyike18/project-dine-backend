const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken) => {
  // Sales summary by day
  router.get('/sales/daily', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DATE(created_at) AS date, COUNT(*) AS orders_count, SUM(total_price) AS total_sales
        FROM orders
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
      `);
      res.json({ daily_sales: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Weekly revenue report
  router.get('/revenue/weekly', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT DATE_TRUNC('week', created_at) AS week, SUM(total_price) AS revenue
        FROM orders
        GROUP BY week
        ORDER BY week DESC
        LIMIT 8
      `);
      res.json({ weekly_revenue: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Employee performance summary
  router.get('/employees/performance', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT e.id, e.name,
               COUNT(o.id) AS orders_handled,
               COALESCE(SUM(te.amount), 0) AS total_tips
        FROM employees e
        LEFT JOIN orders o ON o.assigned_chef_id = e.id
        LEFT JOIN tips_earnings te ON te.employee_id = e.id
        GROUP BY e.id
        ORDER BY orders_handled DESC
      `);
      res.json({ performance: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top-selling items
  router.get('/top-items', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT menu_item, COUNT(*) AS order_count
        FROM orders
        GROUP BY menu_item
        ORDER BY order_count DESC
        LIMIT 10
      `);
      res.json({ top_items: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Revenue by restaurant
  router.get('/revenue/by-restaurant', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT r.name AS restaurant, SUM(o.total_price) AS revenue
        FROM orders o
        JOIN restaurants r ON o.restaurant_id = r.id
        GROUP BY r.name
        ORDER BY revenue DESC
      `);
      res.json({ revenue_by_restaurant: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Order trends by hour
  router.get('/trends/hourly', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT EXTRACT(HOUR FROM created_at) AS hour, COUNT(*) AS orders
        FROM orders
        GROUP BY hour
        ORDER BY hour ASC
      `);
      res.json({ hourly_trends: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Custom report by date range
  router.post('/sales/custom', verifyToken, async (req, res) => {
    const { start_date, end_date } = req.body;
    try {
      const result = await pool.query(
        'SELECT DATE(created_at) AS date, COUNT(*) AS orders_count, SUM(total_price) AS total_sales FROM orders WHERE created_at BETWEEN $1 AND $2 GROUP BY DATE(created_at) ORDER BY date DESC',
        [start_date, end_date]
      );
      res.json({ custom_sales: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Average order value
  router.get('/orders/average-value', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT AVG(total_price) AS avg_order_value FROM orders');
      res.json({ avg_order_value: result.rows[0].avg_order_value });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
