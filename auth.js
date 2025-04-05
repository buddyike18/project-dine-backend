// routes/auth.js
const express = require('express');
const router = express.Router();

module.exports = (function () {
  return function authRouter(pool, verifyToken, admin) {
    // Create User Profile
    router.post('/user-profile', verifyToken, async (req, res) => {
      try {
        const { name, email, phone } = req.body;
        const result = await pool.query(
          'INSERT INTO users (id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING *',
          [req.user.uid, name, email, phone]
        );
        res.status(201).json({ message: 'User profile created', user: result.rows[0] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Update User Profile
    router.put('/profile', verifyToken, async (req, res) => {
      try {
        const { email } = req.body;
        await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.user.uid]);
        res.status(200).json({ message: 'Profile updated' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Delete User Account
    router.delete('/delete', verifyToken, async (req, res) => {
      try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.user.uid]);
        res.status(200).json({ message: 'User account deleted' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Refresh Firebase Auth Token
    router.post('/refresh', async (req, res) => {
      try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

        const newToken = await admin.auth().verifyIdToken(refreshToken, true);
        res.status(200).json({ accessToken: newToken });
      } catch (err) {
        res.status(401).json({ error: 'Invalid refresh token', details: err.message });
      }
    });

    // Get current user info
    router.get('/me', verifyToken, async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.status(200).json({ user: result.rows[0] });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    return router;
  };
})();
