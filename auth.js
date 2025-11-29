// routes/auth.js
const express = require('express');
const router = express.Router();

const handleError = (res, err) => res.status(500).json({ error: err.message });

module.exports = (function () {
  return function authRouter(pool, verifyToken, admin) {
    // [POST] /auth/user-profile - Create User Profile
    router.post('/user-profile', verifyToken, async (req, res) => {
      const { name, email, phone } = req.body;
      if (!name || !email) {
        return res.status(400).json({ error: 'Name and email are required' });
      }
      try {
        const result = await pool.query(
          'INSERT INTO users (id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING *',
          [req.user.uid, name, email, phone || null]
        );
        res.status(201).json({ message: 'User profile created', user: result.rows[0] });
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json({ error: 'Email already exists' });
        }
        handleError(res, err);
      }
    });

    // [PUT] /auth/profile - Update User Email
    router.put('/profile', verifyToken, async (req, res) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      try {
        await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.user.uid]);
        res.status(200).json({ message: 'Profile updated' });
      } catch (err) {
        handleError(res, err);
      }
    });

    // [DELETE] /auth/delete - Delete User Account
    router.delete('/delete', verifyToken, async (req, res) => {
      try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.user.uid]);
        res.status(200).json({ message: 'User account deleted' });
      } catch (err) {
        handleError(res, err);
      }
    });

    // [POST] /auth/refresh - (Caution) Refresh Firebase Token (client-side preferred)
    router.post('/refresh', async (req, res) => {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token required' });
      }
      try {
        const newToken = await admin.auth().verifyIdToken(refreshToken);
        res.status(200).json({ accessToken: newToken });
      } catch (err) {
        res.status(401).json({ error: 'Invalid refresh token', details: err.message });
      }
    });

    // [GET] /auth/me - Get Current User Profile
    router.get('/me', verifyToken, async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.uid]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'User not found' });
        }
        res.status(200).json({ user: result.rows[0] });
      } catch (err) {
        handleError(res, err);
      }
    });

    return router;
  };
})();
