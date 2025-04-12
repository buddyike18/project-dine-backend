// server.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load environment variables
dotenv.config();

// Firebase credentials check
const firebaseKeyPath = path.join(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(firebaseKeyPath)) {
  console.error('❌ Missing firebase-service-account.json');
  process.exit(1);
}

// Initialize Firebase
const serviceAccount = require(firebaseKeyPath);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log('✅ Firebase Initialized');

// Setup Express
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Setup PostgreSQL
const pool = new Pool({
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DATABASE || 'dinedb',
  password: process.env.PG_PASSWORD || 'your_password_here',
  port: process.env.PG_PORT || 5432,
});

pool.connect()
  .then(() => console.log('✅ PostgreSQL Connected'))
  .catch(err => {
    console.error('❌ PostgreSQL Error:', err.message);
    process.exit(1);
  });

// Firebase Middleware
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized - Token missing' });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token', details: err.message });
  }
};

// Global set
app.set('pool', pool);
app.set('verifyToken', verifyToken);

// Routes
app.use('/api/auth', require('./routes/auth')(pool, verifyToken));
app.use('/api/employees', require('./routes/employee')(pool, verifyToken));
app.use('/api/inventory', require('./routes/inventory')(pool, verifyToken));
app.use('/api/menu', require('./routes/menu')(pool, verifyToken));
app.use('/api/orders', require('./routes/orders')(pool, verifyToken));
app.use('/api/restaurants', require('./routes/restaurants')(pool, verifyToken));
app.use('/api/reports', require('./routes/reports')(pool, verifyToken));
app.use('/api/reservations', require('./routes/reservations')(pool, verifyToken));
app.use('/api/notifications', require('./routes/notifications')(pool, verifyToken));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});