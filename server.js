const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { Pool } = require('pg');

// Load environment variables
dotenv.config();

// Initialize Firebase Admin SDK
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log('✅ Firebase Initialized Successfully');

// Initialize Express App
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// PostgreSQL Database Connection
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'dinedb',
  password: 'your_password_here', // Replace with your actual password
  port: 5432,
});

pool.connect()
  .then(() => console.log('✅ PostgreSQL Connected Successfully'))
  .catch(err => console.error('❌ PostgreSQL Connection Error:', err));

// Middleware to Verify Firebase Auth Token
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

// Create a Reservation
app.post('/reservations', verifyToken, async (req, res) => {
  try {
    const { user_id, restaurant_id, party_size, reservation_time } = req.body;
    const result = await pool.query(
      'INSERT INTO reservations (user_id, restaurant_id, party_size, reservation_time) VALUES ($1, $2, $3, $4) RETURNING *',
      [user_id, restaurant_id, party_size, reservation_time]
    );
    res.status(201).json({ message: 'Reservation created', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reservations for a User
app.get('/reservations', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reservations WHERE user_id = $1', [req.user.uid]);
    res.status(200).json({ reservations: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create an Order
app.post('/orders', verifyToken, async (req, res) => {
  try {
    const { user_id, restaurant_id, items, total_price } = req.body;
    const result = await pool.query(
      'INSERT INTO orders (user_id, restaurant_id, items, total_price) VALUES ($1, $2, $3, $4) RETURNING *',
      [user_id, restaurant_id, JSON.stringify(items), total_price]
    );
    res.status(201).json({ message: 'Order placed successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Orders for a User
app.get('/orders', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1', [req.user.uid]);
    res.status(200).json({ orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
