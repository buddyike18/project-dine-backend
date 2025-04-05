const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken, admin) => {
  // Fetch notifications for current user
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.uid]
      );
      res.json({ notifications: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send push notification to a user
  router.post('/push', verifyToken, async (req, res) => {
    const { user_id, title, message } = req.body;
    try {
      const result = await pool.query(
        'SELECT device_token FROM users WHERE id = $1',
        [user_id]
      );

      if (result.rows.length === 0 || !result.rows[0].device_token) {
        return res.status(404).json({ error: 'User not found or no device token' });
      }

      const payload = {
        notification: {
          title,
          body: message,
        },
      };

      await admin.messaging().sendToDevice(result.rows[0].device_token, payload);

      res.json({ message: 'Push notification sent successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get only unread notifications
  router.get('/unread', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM notifications WHERE user_id = $1 AND read = false ORDER BY created_at DESC',
        [req.user.uid]
      );
      res.json({ unread: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark a notification as read
  router.patch('/:id/read', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *',
        [id, req.user.uid]
      );
      res.json({ updated: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};