// File: routes/notifications.js
const express = require('express');
const router = express.Router();
const authorizeRoles = require('../middleware/authorizeRoles');

const handleError = (res, err) => res.status(500).json({ error: err.message });

module.exports = (pool, verifyToken, admin) => {
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
        [req.user.uid]
      );
      res.json({ notifications: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/unread', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM notifications WHERE user_id = $1 AND read = false ORDER BY created_at DESC',
        [req.user.uid]
      );
      res.json({ unread: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/push', verifyToken, authorizeRoles('Manager', 'Host'), async (req, res) => {
    const { user_id, title, message } = req.body;
    if (!user_id || !title || !message) {
      return res.status(400).json({ error: 'user_id, title, and message are required' });
    }
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
      handleError(res, err);
    }
  });

  router.patch('/:id/read', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *',
        [id, req.user.uid]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Notification not found or unauthorized' });
      }
      res.json({ updated: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
};
