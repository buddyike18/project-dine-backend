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

// Check for Firebase credentials
const firebaseKeyPath = path.join(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(firebaseKeyPath)) {
  console.error('❌ Missing firebase-service-account.json');
  process.exit(1);
}

// Initialize Firebase Admin SDK
const serviceAccount = require(firebaseKeyPath);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log('✅ Firebase Initialized Successfully');

// Create Express App
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Define Server Port
const PORT = process.env.PORT || 3000;

// Setup PostgreSQL Pool
const pool = new Pool({
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DATABASE || 'dinedb',
  password: process.env.PG_PASSWORD || 'your_password_here',
  port: process.env.PG_PORT || 5432,
});

pool.connect()
  .then(() => console.log('✅ PostgreSQL Connected Successfully'))
  .catch(err => {
    console.error('❌ PostgreSQL Connection Error:', err);
    process.exit(1);
  });

// Firebase Auth Middleware
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized - Token missing' });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token', details: err.message });
  }
};

// Attach pool and verifyToken globally
app.set('pool', pool);
app.set('verifyToken', verifyToken);

// Routes
try {
  const indexRouter = require('./routes/index');
  if (!indexRouter || typeof indexRouter !== 'function' && typeof indexRouter.use !== 'function') {
    throw new Error('Exported module is not a valid router');
  }
  app.use('/api', indexRouter);
} catch (err) {
  console.error('❌ Cannot load ./routes/index.js - ensure file exists and is error-free.');
  console.error(err.message);
  process.exit(1);
}

// Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});

// Create a Reservation
router.post('/', verifyToken, async (req, res) => {
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
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reservations WHERE user_id = $1', [req.user.uid]);
    res.status(200).json({ reservations: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create an Order
router.post('/', verifyToken, async (req, res) => {
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
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1', [req.user.uid]);
    res.status(200).json({ orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update User Profile
router.put('/auth/profile', verifyToken, async (req, res) => {
  try {
    const { email } = req.body;
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.user.uid]);
    res.status(200).json({ message: 'Profile updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete User Account
router.delete('/auth/delete', verifyToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.uid]);
    res.status(200).json({ message: 'User account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a Restaurant
router.post('/restaurants', verifyToken, async (req, res) => {
  try {
    const { name, location } = req.body;
    const result = await pool.query(
      'INSERT INTO restaurants (name, location) VALUES ($1, $2) RETURNING *',
      [name, location]
    );
    res.status(201).json({ message: 'Restaurant added successfully', restaurant: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch All Restaurants
router.get('/restaurants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM restaurants');
    res.status(200).json({ restaurants: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Restaurant Information
router.put('/restaurants/:id', verifyToken, async (req, res) => {
  try {
    const { name, location } = req.body;
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE restaurants SET name = $1, location = $2 WHERE id = $3 RETURNING *',
      [name, location, id]
    );
    res.status(200).json({ message: 'Restaurant updated successfully', restaurant: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Restaurant
router.delete('/restaurants/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM restaurants WHERE id = $1', [id]);
    res.status(200).json({ message: 'Restaurant deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a Menu Item
router.post('/', verifyToken, async (req, res) => {
  try {
    const { restaurant_id, name, price, description } = req.body;
    const result = await pool.query(
      'INSERT INTO menu (restaurant_id, name, price, description) VALUES ($1, $2, $3, $4) RETURNING *',
      [restaurant_id, name, price, description]
    );
    res.status(201).json({ message: 'Menu item added successfully', menu_item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Menu Items for a Restaurant
router.get('/:restaurant_id', async (req, res) => {
  try {
    const { restaurant_id } = req.params;
    const result = await pool.query(
      'SELECT * FROM menu WHERE restaurant_id = $1',
      [restaurant_id]
    );
    res.status(200).json({ menu: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a Menu Item
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, description } = req.body;
    const result = await pool.query(
      'UPDATE menu SET name = $1, price = $2, description = $3 WHERE id = $4 RETURNING *',
      [name, price, description, id]
    );
    res.status(200).json({ message: 'Menu item updated successfully', menu_item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Menu Item
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM menu WHERE id = $1', [id]);
    res.status(200).json({ message: 'Menu item deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
  
  // Create a Table Reservation
router.post('/', verifyToken, async (req, res) => {
  try {
    const { user_id, restaurant_id, party_size, reservation_time } = req.body;
    const result = await pool.query(
      'INSERT INTO reservations (user_id, restaurant_id, party_size, reservation_time) VALUES ($1, $2, $3, $4) RETURNING *',
      [user_id, restaurant_id, party_size, reservation_time]
    );
    res.status(201).json({ message: 'Reservation created successfully', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reservations for a User
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reservations WHERE user_id = $1', [req.user.uid]);
    res.status(200).json({ reservations: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a Reservation
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { party_size, reservation_time } = req.body;
    const result = await pool.query(
      'UPDATE reservations SET party_size = $1, reservation_time = $2 WHERE id = $3 RETURNING *',
      [party_size, reservation_time, id]
    );
    res.status(200).json({ message: 'Reservation updated successfully', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Reservation
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM reservations WHERE id = $1', [id]);
    res.status(200).json({ message: 'Reservation deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Fetch All Orders for a User
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1', [req.user.uid]);
    res.status(200).json({ orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create an Order
router.post('/', verifyToken, async (req, res) => {
  try {
    const { restaurant_id, items, total_price } = req.body;
    const result = await pool.query(
      'INSERT INTO orders (user_id, restaurant_id, items, total_price) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.uid, restaurant_id, JSON.stringify(items), total_price]
    );
    res.status(201).json({ message: 'Order placed successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update an Order
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { items, total_price } = req.body;
    const result = await pool.query(
      'UPDATE orders SET items = $1, total_price = $2 WHERE id = $3 RETURNING *',
      [JSON.stringify(items), total_price, id]
    );
    res.status(200).json({ message: 'Order updated successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an Order
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
    res.status(200).json({ message: 'Order deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Fetch Sales Reports
router.get('/reports/sales', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sales_reports');
    res.status(200).json({ sales_reports: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Employee Sales Reports
router.get('/reports/employees', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employee_sales_reports');
    res.status(200).json({ employee_sales_reports: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch All Employees
router.get('/employees', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees');
    res.status(200).json({ employees: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Add a New Employee
router.post('/', verifyToken, async (req, res) => {
  try {
    const { name, role, email } = req.body;
    const result = await pool.query(
      'INSERT INTO employees (name, role, email) VALUES ($1, $2, $3) RETURNING *',
      [name, role, email]
    );
    res.status(201).json({ message: 'Employee added successfully', employee: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Employee Information
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, email } = req.body;
    const result = await pool.query(
      'UPDATE employees SET name = $1, role = $2, email = $3 WHERE id = $4 RETURNING *',
      [name, role, email, id]
    );
    res.status(200).json({ message: 'Employee updated successfully', employee: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an Employee
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM employees WHERE id = $1', [id]);
    res.status(200).json({ message: 'Employee deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Add a New Employee
router.post('/', verifyToken, async (req, res) => {
  try {
    const { name, role, email } = req.body;
    const result = await pool.query(
      'INSERT INTO employees (name, role, email) VALUES ($1, $2, $3) RETURNING *',
      [name, role, email]
    );
    res.status(201).json({ message: 'Employee added successfully', employee: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Employee Information
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, email } = req.body;
    const result = await pool.query(
      'UPDATE employees SET name = $1, role = $2, email = $3 WHERE id = $4 RETURNING *',
      [name, role, email, id]
    );
    res.status(200).json({ message: 'Employee updated successfully', employee: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an Employee
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM employees WHERE id = $1', [id]);
    res.status(200).json({ message: 'Employee deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Employee Shifts
router.get('/:id/shifts', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM shifts WHERE employee_id = $1', [id]);
    res.status(200).json({ shifts: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a Shift for an Employee
router.post('/:id/shifts', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { shift_date, start_time, end_time } = req.body;
    const result = await pool.query(
      'INSERT INTO shifts (employee_id, shift_date, start_time, end_time) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, shift_date, start_time, end_time]
    );
    res.status(201).json({ message: 'Shift created successfully', shift: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a Shift for an Employee
router.put('/:id/shifts/:shift_id', verifyToken, async (req, res) => {
  try {
    const { id, shift_id } = req.params;
    const { shift_date, start_time, end_time } = req.body;
    const result = await pool.query(
      'UPDATE shifts SET shift_date = $1, start_time = $2, end_time = $3 WHERE id = $4 AND employee_id = $5 RETURNING *',
      [shift_date, start_time, end_time, shift_id, id]
    );
    res.status(200).json({ message: 'Shift updated successfully', shift: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Shift for an Employee
router.delete('/:id/shifts/:shift_id', verifyToken, async (req, res) => {
  try {
    const { id, shift_id } = req.params;
    await pool.query('DELETE FROM shifts WHERE id = $1 AND employee_id = $2', [shift_id, id]);
    res.status(200).json({ message: 'Shift deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Fetch Employee Payroll Information
router.get('/:id/payroll', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM payroll WHERE employee_id = $1', [id]);
    res.status(200).json({ payroll: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Payroll Information for an Employee
router.post('/:id/payroll', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { pay_period, gross_salary, net_salary } = req.body;
    const result = await pool.query(
      'INSERT INTO payroll (employee_id, pay_period, gross_salary, net_salary) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, pay_period, gross_salary, net_salary]
    );
    res.status(201).json({ message: 'Payroll information added successfully', payroll: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Payroll Information for an Employee
router.put('/:id/payroll/:payroll_id', verifyToken, async (req, res) => {
  try {
    const { id, payroll_id } = req.params;
    const { pay_period, gross_salary, net_salary } = req.body;
    const result = await pool.query(
      'UPDATE payroll SET pay_period = $1, gross_salary = $2, net_salary = $3 WHERE id = $4 AND employee_id = $5 RETURNING *',
      [pay_period, gross_salary, net_salary, payroll_id, id]
    );
    res.status(200).json({ message: 'Payroll information updated successfully', payroll: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Payroll Information for an Employee
router.delete('/:id/payroll/:payroll_id', verifyToken, async (req, res) => {
  try {
    const { id, payroll_id } = req.params;
    await pool.query('DELETE FROM payroll WHERE id = $1 AND employee_id = $2', [payroll_id, id]);
    res.status(200).json({ message: 'Payroll record deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Fetch Notifications for a User
router.get('/notifications', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1', [req.user.uid]);
    res.status(200).json({ notifications: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Inventory Items
router.get('/inventory', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory');
    res.status(200).json({ inventory: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add an Inventory Item
router.post('/inventory', verifyToken, async (req, res) => {
  try {
    const { name, quantity, unit, low_stock_threshold } = req.body;
    const result = await pool.query(
      'INSERT INTO inventory (name, quantity, unit, low_stock_threshold) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, quantity, unit, low_stock_threshold]
    );
    res.status(201).json({ message: 'Inventory item added successfully', inventory_item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update an Inventory Item
router.put('/inventory/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, quantity, unit, low_stock_threshold } = req.body;
    const result = await pool.query(
      'UPDATE inventory SET name = $1, quantity = $2, unit = $3, low_stock_threshold = $4 WHERE id = $5 RETURNING *',
      [name, quantity, unit, low_stock_threshold, id]
    );
    res.status(200).json({ message: 'Inventory item updated successfully', inventory_item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an Inventory Item
router.delete('/inventory/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM inventory WHERE id = $1', [id]);
    res.status(200).json({ message: 'Inventory item deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Low Stock Inventory Items
router.get('/inventory/low-stock', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory WHERE quantity <= low_stock_threshold');
    res.status(200).json({ low_stock_items: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Place a Supplier Order for Inventory Restock
router.post('/inventory/order', verifyToken, async (req, res) => {
  try {
    const { supplier_id, items } = req.body;
    const result = await pool.query(
      'INSERT INTO supplier_orders (supplier_id, items, order_status) VALUES ($1, $2, $3) RETURNING *',
      [supplier_id, JSON.stringify(items), 'Pending']
    );
    res.status(201).json({ message: 'Supplier order placed successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Supplier Orders
router.get('/inventory/orders', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM supplier_orders');
    res.status(200).json({ supplier_orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Supplier Order Status
router.put('/inventory/orders/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { order_status } = req.body;
    const result = await pool.query(
      'UPDATE supplier_orders SET order_status = $1 WHERE id = $2 RETURNING *',
      [order_status, id]
    );
    res.status(200).json({ message: 'Supplier order status updated successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Supplier Order
router.delete('/inventory/orders/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM supplier_orders WHERE id = $1', [id]);
    res.status(200).json({ message: 'Supplier order deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Fetch Employee Work Hours
router.get('/:id/work-hours', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM work_hours WHERE employee_id = $1', [id]);
    res.status(200).json({ work_hours: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Record Employee Work Hours
router.post('/:id/work-hours', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, clock_in, clock_out, total_hours } = req.body;
    const result = await pool.query(
      'INSERT INTO work_hours (employee_id, date, clock_in, clock_out, total_hours) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, date, clock_in, clock_out, total_hours]
    );
    res.status(201).json({ message: 'Work hours recorded successfully', work_hours: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Employee Work Hours
router.put('/:id/work-hours/:work_hours_id', verifyToken, async (req, res) => {
  try {
    const { id, work_hours_id } = req.params;
    const { date, clock_in, clock_out, total_hours } = req.body;
    const result = await pool.query(
      'UPDATE work_hours SET date = $1, clock_in = $2, clock_out = $3, total_hours = $4 WHERE id = $5 AND employee_id = $6 RETURNING *',
      [date, clock_in, clock_out, total_hours, work_hours_id, id]
    );
    res.status(200).json({ message: 'Work hours updated successfully', work_hours: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Employee Work Hours
router.delete('/:id/work-hours/:work_hours_id', verifyToken, async (req, res) => {
  try {
    const { id, work_hours_id } = req.params;
    await pool.query('DELETE FROM work_hours WHERE id = $1 AND employee_id = $2', [work_hours_id, id]);
    res.status(200).json({ message: 'Work hours deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Employee Tips & Earnings
router.get('/:id/tips-earnings', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM tips_earnings WHERE employee_id = $1', [id]);
    res.status(200).json({ tips_earnings: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Record Employee Tips & Earnings
router.post('/:id/tips-earnings', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, tips, total_earnings } = req.body;
    const result = await pool.query(
      'INSERT INTO tips_earnings (employee_id, date, tips, total_earnings) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, date, tips, total_earnings]
    );
    res.status(201).json({ message: 'Tips and earnings recorded successfully', tips_earnings: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Employee Tips & Earnings
router.put('/:id/tips-earnings/:tips_earnings_id', verifyToken, async (req, res) => {
  try {
    const { id, tips_earnings_id } = req.params;
    const { date, tips, total_earnings } = req.body;
    const result = await pool.query(
      'UPDATE tips_earnings SET date = $1, tips = $2, total_earnings = $3 WHERE id = $4 AND employee_id = $5 RETURNING *',
      [date, tips, total_earnings, tips_earnings_id, id]
    );
    res.status(200).json({ message: 'Tips and earnings updated successfully', tips_earnings: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Employee Tips & Earnings
router.delete('/:id/tips-earnings/:tips_earnings_id', verifyToken, async (req, res) => {
  try {
    const { id, tips_earnings_id } = req.params;
    await pool.query('DELETE FROM tips_earnings WHERE id = $1 AND employee_id = $2', [tips_earnings_id, id]);
    res.status(200).json({ message: 'Tips and earnings record deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Employee Performance Report
router.get('/:id/performance', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM employee_performance WHERE employee_id = $1', [id]);
    res.status(200).json({ performance_report: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Record Employee Performance Data
router.post('/:id/performance', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, orders_processed, customer_ratings, sales_generated } = req.body;
    const result = await pool.query(
      'INSERT INTO employee_performance (employee_id, date, orders_processed, customer_ratings, sales_generated) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, date, orders_processed, customer_ratings, sales_generated]
    );
    res.status(201).json({ message: 'Employee performance recorded successfully', performance_data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Employee Performance Data
router.put('/:id/performance/:performance_id', verifyToken, async (req, res) => {
  try {
    const { id, performance_id } = req.params;
    const { date, orders_processed, customer_ratings, sales_generated } = req.body;
    const result = await pool.query(
      'UPDATE employee_performance SET date = $1, orders_processed = $2, customer_ratings = $3, sales_generated = $4 WHERE id = $5 AND employee_id = $6 RETURNING *',
      [date, orders_processed, customer_ratings, sales_generated, performance_id, id]
    );
    res.status(200).json({ message: 'Employee performance updated successfully', performance_data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

 // Refresh Authentication Token
router.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const newToken = await admin.auth().verifyIdToken(refreshToken, true);
    res.status(200).json({ accessToken: newToken });
  } catch (error) {
    res.status(401).json({ error: 'Invalid refresh token', details: error.message });
  }
});

// Fetch Employee Activity Logs
router.get('/:id/activity', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM employee_activity WHERE employee_id = $1 ORDER BY timestamp DESC',
      [id]
    );
    res.status(200).json({ activity_logs: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Request Employee Shift Swap
router.post('/:id/shift-swap', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { shift_id, swap_with_employee_id, reason } = req.body;
    const result = await pool.query(
      'INSERT INTO shift_swaps (employee_id, shift_id, swap_with_employee_id, reason, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, shift_id, swap_with_employee_id, reason, 'Pending']
    );
    res.status(201).json({ message: 'Shift swap request submitted', shift_swap: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve or Reject Shift Swap Request
router.put('/shift-swap/:swap_id', verifyToken, async (req, res) => {
  try {
    const { swap_id } = req.params;
    const { status } = req.body;
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use Approved or Rejected' });
    }
    const result = await pool.query(
      'UPDATE shift_swaps SET status = $1 WHERE id = $2 RETURNING *',
      [status, swap_id]
    );
    res.status(200).json({ message: `Shift swap request ${status}`, shift_swap: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Fetch Waitlist Entries
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at ASC');
    res.status(200).json({ waitlist: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Customer to Waitlist
router.post('/', verifyToken, async (req, res) => {
  try {
    const { customer_name, party_size } = req.body;
    const result = await pool.query(
      'INSERT INTO waitlist (customer_name, party_size, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [customer_name, party_size, 'Waiting']
    );
    res.status(201).json({ message: 'Customer added to waitlist', waitlist_entry: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Notify Waitlist Customer
router.post('/:id/notify', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE waitlist SET status = $1 WHERE id = $2 RETURNING *',
      ['Notified', id]
    );
    res.status(200).json({ message: 'Customer notified successfully', waitlist_entry: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove Customer from Waitlist
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM waitlist WHERE id = $1', [id]);
    res.status(200).json({ message: 'Customer removed from waitlist' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
  
  // Add Custom Modifiers for Orders
router.post('/:id/modifiers', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { modifiers } = req.body;
    const result = await pool.query(
      'UPDATE orders SET modifiers = $1 WHERE id = $2 RETURNING *',
      [JSON.stringify(modifiers), id]
    );
    res.status(200).json({ message: 'Order modifiers added successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adjust Order Priority Level
router.put('/:id/priority', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { priority_level } = req.body;
    if (!['Low', 'Medium', 'High', 'Urgent'].includes(priority_level)) {
      return res.status(400).json({ error: 'Invalid priority level. Use Low, Medium, High, or Urgent' });
    }
    const result = await pool.query(
      'UPDATE orders SET priority_level = $1 WHERE id = $2 RETURNING *',
      [priority_level, id]
    );
    res.status(200).json({ message: 'Order priority updated successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Kitchen Order Status
router.put('/:id/status', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['Pending', 'Preparing', 'Ready', 'Served', 'Completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use Pending, Preparing, Ready, Served, or Completed' });
    }
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    res.status(200).json({ message: 'Order status updated successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Delete User Account
router.delete('/auth/delete', verifyToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.uid]);
    res.status(200).json({ message: 'User account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Employee Roles & Permissions
router.get('/employees/:id/roles', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT role, permissions FROM employees WHERE id = $1',
      [id]
    );
    res.status(200).json({ roles: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available Tables
router.get('/tables/available', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tables WHERE status = $1 ORDER BY table_number ASC',
      ['Available']
    );
    res.status(200).json({ available_tables: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Menu Categories
router.get('/menu/categories', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT category FROM menu ORDER BY category ASC');
    res.status(200).json({ categories: result.rows.map(row => row.category) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Most Ordered Menu Items
router.get('/menu/popular', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT menu_item, COUNT(*) AS order_count FROM orders GROUP BY menu_item ORDER BY order_count DESC LIMIT 10'
    );
    res.status(200).json({ popular_items: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Payment History for Users
router.get('/payments/history', verifyToken, async (req, res) => {
  try {
    const { user_id } = req.user;
    const result = await pool.query(
      'SELECT * FROM payments WHERE user_id = $1 ORDER BY payment_date DESC',
      [user_id]
    );
    res.status(200).json({ payment_history: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Generate Inventory Report
router.get('/inventory/report', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT item_name, quantity, low_stock_threshold,
        (CASE WHEN quantity <= low_stock_threshold THEN true ELSE false END) AS low_stock
        FROM inventory ORDER BY item_name ASC`
    );
    res.status(200).json({ inventory_report: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Revenue Reports by Timeframe
router.get('/reports/revenue', verifyToken, async (req, res) => {
  try {
    const { timeframe } = req.query;
    let query;
    if (timeframe === 'daily') {
      query = `SELECT DATE(payment_date) AS date, SUM(amount) AS total_revenue
               FROM payments
               WHERE payment_date >= NOW() - INTERVAL '30 days'
               GROUP BY DATE(payment_date)
               ORDER BY date DESC`;
    } else if (timeframe === 'weekly') {
      query = `SELECT DATE_TRUNC('week', payment_date) AS week, SUM(amount) AS total_revenue
               FROM payments
               WHERE payment_date >= NOW() - INTERVAL '12 weeks'
               GROUP BY week
               ORDER BY week DESC`;
    } else if (timeframe === 'monthly') {
      query = `SELECT DATE_TRUNC('month', payment_date) AS month, SUM(amount) AS total_revenue
               FROM payments
               WHERE payment_date >= NOW() - INTERVAL '12 months'
               GROUP BY month
               ORDER BY month DESC`;
    } else {
      return res.status(400).json({ error: 'Invalid timeframe. Use daily, weekly, or monthly.' });
    }
    const result = await pool.query(query);
    res.status(200).json({ revenue_report: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Push Notifications to Mobile Users
router.post('/notifications/push', verifyToken, async (req, res) => {
  try {
    const { user_id, title, message } = req.body;
    const result = await pool.query('SELECT device_token FROM users WHERE id = $1', [user_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found or no device token available' });
    }
    const deviceToken = result.rows[0].device_token;
    const payload = {
      notification: {
        title,
        body: message
      }
    };
    await admin.messaging().sendToDevice(deviceToken, payload);
    res.status(200).json({ message: 'Push notification sent successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  // Collect Customer Feedback & Ratings
router.post('/reviews', verifyToken, async (req, res) => {
  try {
    const { user_id, order_id, rating, comment } = req.body;
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    const result = await pool.query(
      'INSERT INTO reviews (user_id, order_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
      [user_id, order_id, rating, comment]
    );
    res.status(201).json({ message: 'Review submitted successfully', review: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Customer to Waitlist
router.post('/waitlist', verifyToken, async (req, res) => {
  try {
    const { customer_name, party_size } = req.body;
    const result = await pool.query(
      'INSERT INTO waitlist (customer_name, party_size, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [customer_name, party_size, 'Waiting']
    );
    res.status(201).json({ message: 'Customer added to waitlist', waitlist_entry: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Waitlist Entries
router.get('/waitlist', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at ASC');
    res.status(200).json({ waitlist: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Notify Waitlist Customer
router.post('/waitlist/:id/notify', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE waitlist SET status = $1 WHERE id = $2 RETURNING *',
      ['Notified', id]
    );
    res.status(200).json({ message: 'Customer notified successfully', waitlist_entry: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove Customer from Waitlist
router.delete('/waitlist/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM waitlist WHERE id = $1', [id]);
    res.status(200).json({ message: 'Customer removed from waitlist' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Customer Review
router.post('/reviews', verifyToken, async (req, res) => {
  try {
    const { user_id, order_id, rating, comment } = req.body;
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    const result = await pool.query(
      'INSERT INTO reviews (user_id, order_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
      [user_id, order_id, rating, comment]
    );
    res.status(201).json({ message: 'Review submitted successfully', review: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reviews for a Restaurant
router.get('/reviews/:restaurant_id', async (req, res) => {
  try {
    const { restaurant_id } = req.params;
    const result = await pool.query(
      'SELECT * FROM reviews WHERE restaurant_id = $1 ORDER BY created_at DESC',
      [restaurant_id]
    );
    res.status(200).json({ reviews: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a Review
router.put('/reviews/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    const result = await pool.query(
      'UPDATE reviews SET rating = $1, comment = $2 WHERE id = $3 RETURNING *',
      [rating, comment, id]
    );
    res.status(200).json({ message: 'Review updated successfully', review: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Review
router.delete('/reviews/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);
    res.status(200).json({ message: 'Review deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Shifts for an Employee
router.get('/shifts/:employee_id', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.params;
    const result = await pool.query(
      'SELECT * FROM shifts WHERE employee_id = $1 ORDER BY shift_date ASC',
      [employee_id]
    );
    res.status(200).json({ shifts: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a Shift
router.put('/shifts/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { shift_date, start_time, end_time } = req.body;
    const result = await pool.query(
      'UPDATE shifts SET shift_date = $1, start_time = $2, end_time = $3 WHERE id = $4 RETURNING *',
      [shift_date, start_time, end_time, id]
    );
    res.status(200).json({ message: 'Shift updated successfully', shift: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Shift
router.delete('/shifts/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM shifts WHERE id = $1', [id]);
    res.status(200).json({ message: 'Shift deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Request a Shift Swap
router.post('/shifts/:id/swap', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { swap_with_employee_id, reason } = req.body;
    const result = await pool.query(
      'INSERT INTO shift_swaps (shift_id, swap_with_employee_id, reason, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, swap_with_employee_id, reason, 'Pending']
    );
    res.status(201).json({ message: 'Shift swap request submitted', shift_swap: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve or Reject a Shift Swap
router.put('/shifts/swap/:swap_id', verifyToken, async (req, res) => {
  try {
    const { swap_id } = req.params;
    const { status } = req.body;
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use Approved or Rejected' });
    }
    const result = await pool.query(
      'UPDATE shift_swaps SET status = $1 WHERE id = $2 RETURNING *',
      [status, swap_id]
    );
    res.status(200).json({ message: `Shift swap request ${status}`, shift_swap: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Orders for the Kitchen Display System
router.get('/kds/orders', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE status IN ('Pending', 'Preparing') ORDER BY created_at ASC"
    );
    res.status(200).json({ orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Order Status (e.g., Preparing, Ready, Served)
router.put('/kds/orders/:id/status', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['Pending', 'Preparing', 'Ready', 'Served', 'Completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use Pending, Preparing, Ready, Served, or Completed' });
    }
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    res.status(200).json({ message: 'Order status updated successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign a Kitchen Order to a Chef
router.put('/kds/orders/:id/assign', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { chef_id } = req.body;
    const result = await pool.query(
      'UPDATE orders SET assigned_chef_id = $1 WHERE id = $2 RETURNING *',
      [chef_id, id]
    );
    res.status(200).json({ message: 'Order assigned successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Completed Orders for Review
router.get('/kds/orders/completed', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE status = 'Completed' ORDER BY updated_at DESC"
    );
    res.status(200).json({ completed_orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available Tables
router.get('/tables/available', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tables WHERE status = $1 ORDER BY table_number ASC',
      ['Available']
    );
    res.status(200).json({ available_tables: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign a Table to a Reservation
router.post('/tables/assign', verifyToken, async (req, res) => {
  try {
    const { reservation_id, table_id } = req.body;
    const result = await pool.query(
      'UPDATE tables SET status = $1, reservation_id = $2 WHERE id = $3 RETURNING *',
      ['Occupied', reservation_id, table_id]
    );
    res.status(200).json({ message: 'Table assigned successfully', table: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark Table as Available
router.put('/tables/:id/status', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE tables SET status = $1, reservation_id = NULL WHERE id = $2 RETURNING *',
      ['Available', id]
    );
    res.status(200).json({ message: 'Table marked as available', table: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Table Status
router.get('/tables/status', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tables ORDER BY table_number ASC');
    res.status(200).json({ tables: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Employee Performance Data
router.get('/employees/:id/performance', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM employee_performance WHERE employee_id = $1 ORDER BY date DESC',
      [id]
    );
    res.status(200).json({ performance_report: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Record Employee Performance
router.post('/employees/:id/performance', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { date, orders_processed, customer_ratings, sales_generated } = req.body;
    const result = await pool.query(
      'INSERT INTO employee_performance (employee_id, date, orders_processed, customer_ratings, sales_generated) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, date, orders_processed, customer_ratings, sales_generated]
    );
    res.status(201).json({ message: 'Employee performance recorded successfully', performance_data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Employee Performance Data
router.put('/employees/:id/performance/:performance_id', verifyToken, async (req, res) => {
  try {
    const { id, performance_id } = req.params;
    const { date, orders_processed, customer_ratings, sales_generated } = req.body;
    const result = await pool.query(
      'UPDATE employee_performance SET date = $1, orders_processed = $2, customer_ratings = $3, sales_generated = $4 WHERE id = $5 AND employee_id = $6 RETURNING *',
      [date, orders_processed, customer_ratings, sales_generated, performance_id, id]
    );
    res.status(200).json({ message: 'Employee performance updated successfully', performance_data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Employee Performance Data
router.delete('/employees/:id/performance/:performance_id', verifyToken, async (req, res) => {
  try {
    const { id, performance_id } = req.params;
    await pool.query('DELETE FROM employee_performance WHERE id = $1 AND employee_id = $2', [performance_id, id]);
    res.status(200).json({ message: 'Performance record deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Modifications to a Menu Item
router.post('/menu/:id/modifications', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { modification_name, modification_price } = req.body;
    const result = await pool.query(
      'INSERT INTO menu_modifications (menu_id, modification_name, modification_price) VALUES ($1, $2, $3) RETURNING *',
      [id, modification_name, modification_price]
    );
    res.status(201).json({ message: 'Modification added successfully', modification: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Modifications for a Menu Item
router.get('/menu/:id/modifications', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM menu_modifications WHERE menu_id = $1',
      [id]
    );
    res.status(200).json({ modifications: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create User Profile
router.post('/auth/user-profile', verifyToken, async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    const result = await pool.query(
      'INSERT INTO users (id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.uid, name, email, phone]
    );
    res.status(201).json({ message: 'User profile created successfully', user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Restaurant Profile
router.post('/auth/restaurant-profile', verifyToken, async (req, res) => {
  try {
    const { owner_id, name, location, cuisine, contact } = req.body;
    const result = await pool.query(
      'INSERT INTO restaurants (owner_id, name, location, cuisine, contact) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [owner_id, name, location, cuisine, contact]
    );
    res.status(201).json({ message: 'Restaurant profile created successfully', restaurant: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Restaurant Profile
router.put('/auth/restaurant-profile/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, location, cuisine, contact } = req.body;
    const result = await pool.query(
      'UPDATE restaurants SET name = $1, location = $2, cuisine = $3, contact = $4 WHERE id = $5 RETURNING *',
      [name, location, cuisine, contact, id]
    );
    res.status(200).json({ message: 'Restaurant profile updated successfully', restaurant: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reservations by Date (Calendar View)
router.get('/reservations/calendar/:date', verifyToken, async (req, res) => {
  try {
    const { date } = req.params;
    const result = await pool.query(
      'SELECT * FROM reservations WHERE DATE(reservation_time) = $1 ORDER BY reservation_time ASC',
      [date]
    );
    res.status(200).json({ reservations: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reservations by Status (Upcoming, Ongoing, Completed, Cancelled)
router.get('/reservations/status/:status', verifyToken, async (req, res) => {
  try {
    const { status } = req.params;
    const result = await pool.query(
      'SELECT * FROM reservations WHERE status = $1 ORDER BY reservation_time ASC',
      [status]
    );
    res.status(200).json({ reservations: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reservations for a Specific Server
router.get('/reservations/server/:serverId', verifyToken, async (req, res) => {
  try {
    const { serverId } = req.params;
    const result = await pool.query(
      'SELECT * FROM reservations WHERE server_id = $1 ORDER BY reservation_time ASC',
      [serverId]
    );
    res.status(200).json({ reservations: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Expected People and Tables Reserved
router.get('/reservations/stats', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT SUM(party_size) AS total_people, COUNT(id) AS total_tables FROM reservations WHERE status IN ($1, $2)',
      ['Upcoming', 'Ongoing']
    );
    res.status(200).json({ stats: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Hourly Breakdown of Reservations
router.get('/reservations/hourly', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DATE_TRUNC('hour', reservation_time) AS hour, 
              COUNT(*) AS total 
       FROM reservations 
       GROUP BY DATE_TRUNC('hour', reservation_time) 
       ORDER BY hour ASC`
    );
    res.status(200).json({ hourly_breakdown: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Guest Information & Statistics
router.get('/reservations/guest/:user_id', verifyToken, async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await pool.query(
      `SELECT users.profile_picture, users.name, users.birthday, users.phone, users.email,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1) AS total_reservations,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Completed') AS visits,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Walk-In') AS walk_ins,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Invited') AS invites,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'No-Show') AS no_shows,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Cancelled') AS cancellations
       FROM users WHERE id = $1`,
      [user_id]
    );
    res.status(200).json({ guest: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Detailed Reservation Information
router.get('/reservations/details/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const result = await pool.query(
      `SELECT r.id, r.party_size, r.reservation_time, r.dining_area, r.table_number, r.notes, 
              r.cancellation_policy, u.name AS guest_name, u.phone, u.email
       FROM reservations r 
       JOIN users u ON r.user_id = u.id 
       WHERE r.id = $1`,
      [reservation_id]
    );
    res.status(200).json({ reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Message to Guest About Reservation
router.post('/reservations/message/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const { message } = req.body;
    const result = await pool.query(
      `INSERT INTO reservation_messages (reservation_id, message, created_at) VALUES ($1, $2, NOW()) RETURNING *`,
      [reservation_id, message]
    );
    res.status(201).json({ message: 'Message sent successfully', message_data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check-In Reservation & Update Table Status to Green
router.put('/reservations/check-in/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const result = await pool.query(
      "UPDATE reservations SET status = 'Ongoing' WHERE id = $1 RETURNING *",
      [reservation_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reservation not found' });

    await pool.query(
      "UPDATE tables SET status = 'Occupied (Green)' WHERE id = (SELECT table_number FROM reservations WHERE id = $1)",
      [reservation_id]
    );
    res.status(200).json({ message: 'Reservation checked in and table updated', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set Dining Time Limit per Reservation
router.put('/reservations/set-time-limit/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const { time_limit } = req.body;
    const result = await pool.query(
      "UPDATE reservations SET time_limit = $1 WHERE id = $2 RETURNING *",
      [time_limit, reservation_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reservation not found' });
    res.status(200).json({ message: 'Dining time limit set', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Table Status Updates
router.get('/tables/status-update', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id AS table_id, t.status, r.reservation_time, r.time_limit,
              CASE 
                  WHEN NOW() >= r.reservation_time + (r.time_limit * INTERVAL '1 minute') THEN 'Occupied (Red)'
                  WHEN NOW() >= r.reservation_time + ((r.time_limit - 10) * INTERVAL '1 minute') THEN 'Occupied (Yellow)'
                  ELSE t.status 
              END AS updated_status
       FROM tables t
       LEFT JOIN reservations r ON t.id = r.table_number
       WHERE t.status LIKE 'Occupied%'`
    );
    res.status(200).json({ tables: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reservations for a Specific Server
router.get('/reservations/server/:serverId', verifyToken, async (req, res) => {
  try {
    const { serverId } = req.params;
    const result = await pool.query(
      'SELECT * FROM reservations WHERE server_id = $1 ORDER BY reservation_time ASC',
      [serverId]
    );
    res.status(200).json({ reservations: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Expected People and Tables Reserved
router.get('/reservations/stats', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT SUM(party_size) AS total_people, COUNT(id) AS total_tables FROM reservations WHERE status IN ($1, $2)',
      ['Upcoming', 'Ongoing']
    );
    res.status(200).json({ stats: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Hourly Breakdown of Reservations
router.get('/reservations/hourly', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DATE_TRUNC('hour', reservation_time) AS hour, 
              COUNT(*) AS total 
       FROM reservations 
       GROUP BY DATE_TRUNC('hour', reservation_time) 
       ORDER BY hour ASC`
    );
    res.status(200).json({ hourly_breakdown: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Guest Information & Statistics
router.get('/reservations/guest/:user_id', verifyToken, async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await pool.query(
      `SELECT users.profile_picture, users.name, users.birthday, users.phone, users.email,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1) AS total_reservations,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Completed') AS visits,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Walk-In') AS walk_ins,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Invited') AS invites,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'No-Show') AS no_shows,
              (SELECT COUNT(*) FROM reservations WHERE user_id = $1 AND status = 'Cancelled') AS cancellations
       FROM users WHERE id = $1`,
      [user_id]
    );
    res.status(200).json({ guest: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Detailed Reservation Information
router.get('/reservations/details/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const result = await pool.query(
      `SELECT r.id, r.party_size, r.reservation_time, r.dining_area, r.table_number, r.notes, 
              r.cancellation_policy, u.name AS guest_name, u.phone, u.email
       FROM reservations r 
       JOIN users u ON r.user_id = u.id 
       WHERE r.id = $1`,
      [reservation_id]
    );
    res.status(200).json({ reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Message to Guest About Reservation
router.post('/reservations/message/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const { message } = req.body;
    const result = await pool.query(
      `INSERT INTO reservation_messages (reservation_id, message, created_at) VALUES ($1, $2, NOW()) RETURNING *`,
      [reservation_id, message]
    );
    res.status(201).json({ message: 'Message sent successfully', message_data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check-In Reservation & Update Table Status to Green
router.put('/reservations/check-in/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const result = await pool.query(
      "UPDATE reservations SET status = 'Ongoing' WHERE id = $1 RETURNING *",
      [reservation_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reservation not found' });

    await pool.query(
      "UPDATE tables SET status = 'Occupied (Green)' WHERE id = (SELECT table_number FROM reservations WHERE id = $1)",
      [reservation_id]
    );
    res.status(200).json({ message: 'Reservation checked in and table updated', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set Dining Time Limit per Reservation
router.put('/reservations/set-time-limit/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const { time_limit } = req.body;
    const result = await pool.query(
      "UPDATE reservations SET time_limit = $1 WHERE id = $2 RETURNING *",
      [time_limit, reservation_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reservation not found' });
    res.status(200).json({ message: 'Dining time limit set', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Table Status Updates
router.get('/tables/status-update', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id AS table_id, t.status, r.reservation_time, r.time_limit,
              CASE 
                  WHEN NOW() >= r.reservation_time + (r.time_limit * INTERVAL '1 minute') THEN 'Occupied (Red)'
                  WHEN NOW() >= r.reservation_time + ((r.time_limit - 10) * INTERVAL '1 minute') THEN 'Occupied (Yellow)'
                  ELSE t.status 
              END AS updated_status
       FROM tables t
       LEFT JOIN reservations r ON t.id = r.table_number
       WHERE t.status LIKE 'Occupied%'`
    );
    res.status(200).json({ tables: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch All Table Statuses
router.get('/tables/status', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tables ORDER BY table_number ASC');
    res.status(200).json({ tables: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available Reservation Dates
router.get('/reservations/available-dates', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT DISTINCT DATE(reservation_time) AS available_date FROM reservations WHERE reservation_time >= NOW() AND reservation_time < NOW() + INTERVAL '7 days' ORDER BY available_date ASC"
    );
    res.status(200).json({ available_dates: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available Reservation Slots
router.get('/reservations/slots/:date', verifyToken, async (req, res) => {
  try {
    const { date } = req.params;
    const result = await pool.query(
      "SELECT reservation_time FROM reservations WHERE DATE(reservation_time) = $1 ORDER BY reservation_time ASC",
      [date]
    );
    res.status(200).json({ available_slots: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available Party Size Options
router.get('/reservations/party-sizes', verifyToken, async (req, res) => {
  try {
    res.status(200).json({ party_sizes: [1, 2, 3, 4, 5, 6, 7, 'More'] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a New Reservation
app.post('/api/reservations/new', verifyToken, async (req, res) => {
  try {
    const { user_id, restaurant_id, party_size, reservation_time, server_id } = req.body;
    const result = await pool.query(
      "INSERT INTO reservations (user_id, restaurant_id, party_size, reservation_time, status, server_id) VALUES ($1, $2, $3, $4, 'Upcoming', $5) RETURNING *",
      [user_id, restaurant_id, party_size, reservation_time, server_id]
    );
    res.status(201).json({ message: 'Reservation created successfully', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available Time Slots for Selected Date and Party Size
app.get('/api/reservations/slots/:date/:party_size', verifyToken, async (req, res) => {
  try {
    const { date, party_size } = req.params;
    const result = await pool.query(
      `SELECT DISTINCT reservation_time 
       FROM reservations 
       WHERE DATE(reservation_time) = $1 
       AND party_size >= $2 
       AND status = 'Available' 
       ORDER BY reservation_time ASC`,
      [date, party_size]
    );
    res.status(200).json({ available_slots: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available Dining Options for Selected Time Slot
app.get('/api/reservations/dining-options/:date/:time/:party_size', verifyToken, async (req, res) => {
  try {
    const { date, time, party_size } = req.params;
    const result = await pool.query(
      `SELECT dr.name AS dining_room, 
              COUNT(t.id) AS available_tables, 
              dr.total_tables 
       FROM tables t 
       JOIN dining_rooms dr ON t.dining_room_id = dr.id 
       WHERE dr.capacity >= $1 
       AND t.status = 'Available' 
       GROUP BY dr.name, dr.total_tables`,
      [party_size]
    );
    res.status(200).json({ dining_options: result.rows, selected_time: time });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search for Existing Guest by Name, Phone, or Email
app.get('/api/guests/search', verifyToken, async (req, res) => {
  try {
    const { query } = req.query;
    const result = await pool.query(
      `SELECT id, name, phone, email FROM guests 
       WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 
       LIMIT 10`,
      [`%${query}%`]
    );
    res.status(200).json({ guests: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a New Guest if Not Found
app.post('/api/guests/new', verifyToken, async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const result = await pool.query(
      `INSERT INTO guests (name, phone, email) VALUES ($1, $2, $3) RETURNING *`,
      [name, phone, email]
    );
    res.status(201).json({ message: 'Guest added successfully', guest: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Reservation Summary Before Completion
app.get('/api/reservations/summary/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const result = await pool.query(
      `SELECT r.id, r.reservation_time, r.party_size, r.dining_room, r.table_number, g.name AS guest_name 
       FROM reservations r 
       LEFT JOIN guests g ON r.guest_id = g.id 
       WHERE r.id = $1`,
      [reservation_id]
    );
    res.status(200).json({ reservation_summary: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign Guest to a Reservation
router.put('/reservations/assign-guest/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const { guest_id } = req.body;
    const result = await pool.query(
      `UPDATE reservations SET guest_id = $1 WHERE id = $2 RETURNING *`,
      [guest_id, reservation_id]
    );
    res.status(200).json({ message: 'Guest assigned successfully', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Reservation with Additional Owner & Notes
router.put('/reservations/update/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const { additional_owner, notes } = req.body;
    const result = await pool.query(
      `UPDATE reservations SET additional_owner = $1, notes = $2 WHERE id = $3 RETURNING *`,
      [additional_owner, notes, reservation_id]
    );
    res.status(200).json({ message: 'Reservation updated successfully', reservation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Complete Reservation & Show Success Message
router.put('/reservations/complete/:reservation_id', verifyToken, async (req, res) => {
  try {
    const { reservation_id } = req.params;
    const result = await pool.query(
      `UPDATE reservations SET status = 'Confirmed' WHERE id = $1 RETURNING *`,
      [reservation_id]
    );
    const reservation = result.rows[0];
    res.status(200).json({ message: `Reservation booked! ${reservation.guest_name}, ${reservation.reservation_time}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search for an Existing Guest
router.get('/walk-in/search', verifyToken, async (req, res) => {
  try {
    const { query } = req.query;
    const result = await pool.query(
      `SELECT id, name, phone, email FROM guests 
       WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 
       LIMIT 10`,
      [`%${query}%`]
    );
    res.status(200).json({ guests: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a New Guest if Not Found
router.post('/walk-in/new', verifyToken, async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const result = await pool.query(
      `INSERT INTO guests (name, phone, email) VALUES ($1, $2, $3) RETURNING *`,
      [name, phone, email]
    );
    res.status(201).json({ message: 'Guest added successfully', guest: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a Walk-In Reservation with Optional Reservation Notes
router.post('/walk-in/reserve', verifyToken, async (req, res) => {
  try {
    const { guest_id, party_size, wait_time, notes } = req.body;
    let assigned_table = null;

    const tableResult = await pool.query(
      `SELECT id FROM tables WHERE status = 'Available' LIMIT 1`
    );

    if (tableResult.rows.length > 0) {
      assigned_table = tableResult.rows[0].id;
      await pool.query(
        `UPDATE tables SET status = 'Occupied' WHERE id = $1`,
        [assigned_table]
      );
    }

    const reservationResult = await pool.query(
      `INSERT INTO reservations (guest_id, party_size, reservation_time, status, table_number, wait_time, notes) 
       VALUES ($1, $2, NOW(), $3, $4, $5, $6) RETURNING *`,
      [guest_id, party_size, assigned_table ? 'Ongoing' : 'Waitlist', assigned_table, wait_time, notes]
    );

    res.status(201).json({
      message: assigned_table ? 'Walk-in assigned to a table' : 'Walk-in added to waitlist',
      reservation: reservationResult.rows[0],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

    // Create a Walk-In Reservation with Optional Reservation Notes
  router.post('/walk-in/reserve', verifyToken, async (req, res) => {
    try {
      const { guest_id, party_size, wait_time, notes } = req.body;
      let assigned_table = null;

      const tableResult = await pool.query(
        `SELECT id FROM tables WHERE status = 'Available' LIMIT 1`
      );

      if (tableResult.rows.length > 0) {
        assigned_table = tableResult.rows[0].id;
        await pool.query(
          `UPDATE tables SET status = 'Occupied' WHERE id = $1`,
          [assigned_table]
        );
      }

      const reservationResult = await pool.query(
        `INSERT INTO reservations (guest_id, party_size, reservation_time, status, table_number, wait_time, notes) 
         VALUES ($1, $2, NOW(), $3, $4, $5, $6) RETURNING *`,
        [guest_id, party_size, assigned_table ? 'Ongoing' : 'Waitlist', assigned_table, wait_time, notes]
      );

      res.status(201).json({
        message: assigned_table ? 'Walk-in assigned to a table' : 'Walk-in added to waitlist',
        reservation: reservationResult.rows[0],
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Assign a Walk-In Reservation to a Table (Drag & Drop)
  router.put('/walk-in/assign-table/:reservation_id', verifyToken, async (req, res) => {
    try {
      const { reservation_id } = req.params;
      const { table_id } = req.body;
      await pool.query(
        `UPDATE reservations SET status = 'Ongoing', table_number = $1 WHERE id = $2`,
        [table_id, reservation_id]
      );
      await pool.query(
        `UPDATE tables SET status = 'Occupied' WHERE id = $1`,
        [table_id]
      );
      res.status(200).json({ message: 'Walk-in assigned to table successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update Wait Time for Walk-In Reservation
  router.put('/walk-in/update-wait/:reservation_id', verifyToken, async (req, res) => {
    try {
      const { reservation_id } = req.params;
      const { wait_time } = req.body;
      const result = await pool.query(
        `UPDATE reservations SET wait_time = $1 WHERE id = $2 RETURNING *`,
        [wait_time, reservation_id]
      );
      res.status(200).json({ message: 'Wait time updated successfully', reservation: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

// Assign a Four-Digit Login Code to a New Employee
router.post('/employees/assign-code', verifyToken, async (req, res) => {
  try {
    const { employee_id, login_code } = req.body;
    if (login_code.length !== 4 || isNaN(login_code)) {
      return res.status(400).json({ error: 'Login code must be a 4-digit number' });
    }
    const result = await pool.query(
      `UPDATE employees SET login_code = $1 WHERE id = $2 RETURNING *`,
      [login_code, employee_id]
    );
    res.status(200).json({ message: 'Login code assigned successfully', employee: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Employee Login via Four-Digit Code
router.post('/employees/login', async (req, res) => {
  try {
    const { login_code } = req.body;
    const result = await pool.query(
      `SELECT id, name, role FROM employees WHERE login_code = $1`,
      [login_code]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid login code' });
    }
    res.status(200).json({ message: 'Login successful', employee: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Employee Roles
router.get('/employees/:employee_id/roles', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.params;
    const result = await pool.query(
      `SELECT role FROM employee_roles WHERE employee_id = $1`,
      [employee_id]
    );
    res.status(200).json({ roles: result.rows.map(row => row.role) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clock In Employee
router.post('/employees/clock-in', verifyToken, async (req, res) => {
  try {
    const { employee_id, role } = req.body;
    const result = await pool.query(
      `INSERT INTO employee_timesheets (employee_id, role, clock_in, week_start) 
       VALUES ($1, $2, NOW(), DATE_TRUNC('week', NOW())) RETURNING *`,
      [employee_id, role]
    );
    res.status(201).json({ message: 'Clock-in successful', timesheet: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clock Out Employee
router.post('/employees/clock-out', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.body;
    const result = await pool.query(
      `UPDATE employee_timesheets SET clock_out = NOW(), hours_worked = EXTRACT(EPOCH FROM (NOW() - clock_in)) / 3600 
       WHERE employee_id = $1 AND clock_out IS NULL RETURNING *`,
      [employee_id]
    );
    res.status(200).json({ message: 'Clock-out successful', timesheet: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start Break
router.post('/employees/start-break', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.body;
    await pool.query(
      `UPDATE employee_timesheets SET break_start = NOW() WHERE employee_id = $1 AND clock_out IS NULL AND break_start IS NULL`,
      [employee_id]
    );
    res.status(200).json({ message: 'Break started successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// End Break
router.post('/employees/end-break', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.body;
    await pool.query(
      `UPDATE employee_timesheets SET break_end = NOW(), break_duration = EXTRACT(EPOCH FROM (NOW() - break_start)) / 3600 
       WHERE employee_id = $1 AND clock_out IS NULL AND break_end IS NULL`,
      [employee_id]
    );
    res.status(200).json({ message: 'Break ended successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Weekly Logged Hours
router.get('/api/employees/:employee_id/timesheets', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.params;
    const result = await pool.query(
      `SELECT clock_in, clock_out, hours_worked, break_duration, role 
       FROM employee_timesheets 
       WHERE employee_id = $1 AND week_start = DATE_TRUNC('week', NOW()) 
       ORDER BY clock_in ASC`,
      [employee_id]
    );
    res.status(200).json({ timesheets: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Shift Reviews
router.get('/api/employees/:employee_id/reviews', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.params;
    const result = await pool.query(
      `SELECT shift_date, rating, comments FROM employee_reviews WHERE employee_id = $1 ORDER BY shift_date DESC`,
      [employee_id]
    );
    res.status(200).json({ reviews: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Switch User (Log Out Current User)
router.post('/api/employees/switch-user', verifyToken, async (req, res) => {
  try {
    res.status(200).json({ message: 'User switched successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Available POS System Tabs Based on Role
router.get('/api/employees/:employee_id/tabs', verifyToken, async (req, res) => {
  try {
    const { employee_id } = req.params;
    const result = await pool.query(
      `SELECT role FROM employee_roles WHERE employee_id = $1`,
      [employee_id]
    );

    const roles = result.rows.map(row => row.role);
    const accessibleTabs = [];

    accessibleTabs.push({ name: 'Employee Time Sheet', access: true });

    if (roles.includes('host') || roles.includes('manager') || roles.includes('owner')) {
      accessibleTabs.push({ name: 'Reservations', access: true });
    }
    if (roles.includes('server') || roles.includes('bartender') || roles.includes('manager') || roles.includes('owner')) {
      accessibleTabs.push({ name: 'Ordering', access: true });
    }
    if (roles.includes('kitchen') || roles.includes('bartender') || roles.includes('manager') || roles.includes('owner')) {
      accessibleTabs.push({ name: 'Kitchen Display System', access: true });
    }
    if (roles.includes('server') || roles.includes('bartender') || roles.includes('manager') || roles.includes('owner')) {
      accessibleTabs.push({ name: 'Transaction Report', access: true });
    }

    res.status(200).json({ tabs: accessibleTabs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Dining Room Floor Plan with Table Status
router.get('/api/ordering/floor-plan/:room_id', verifyToken, async (req, res) => {
  try {
    const { room_id } = req.params;
    const result = await pool.query(
      `SELECT t.id AS table_id, t.number AS table_number, t.status, t.capacity, t.has_seat_numbers 
       FROM tables t WHERE t.dining_room_id = $1 ORDER BY t.number ASC`,
      [room_id]
    );
    res.status(200).json({ tables: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Seat Numbers for Large Tables (10+ seats)
router.get('/api/ordering/seats/:table_id', verifyToken, async (req, res) => {
  try {
    const { table_id } = req.params;
    const result = await pool.query(
      `SELECT seat_number FROM table_seats WHERE table_id = $1 ORDER BY seat_number ASC`,
      [table_id]
    );
    res.status(200).json({ seats: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Place Order for a Specific Table
router.post('/api/ordering/place-order', verifyToken, async (req, res) => {
  try {
    const { table_id, seat_number, items } = req.body;
    const result = await pool.query(
      `INSERT INTO orders (table_id, seat_number, items, status, created_at) 
       VALUES ($1, $2, $3, 'Pending', NOW()) RETURNING *`,
      [table_id, seat_number, JSON.stringify(items)]
    );
    res.status(201).json({ message: 'Order placed successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Quick Order (Bypass Table Selection)
router.post('/api/ordering/quick-order', verifyToken, async (req, res) => {
  try {
    const { items } = req.body;
    const result = await pool.query(
      `INSERT INTO orders (table_id, seat_number, items, status, created_at) 
       VALUES (NULL, NULL, $1, 'Pending', NOW()) RETURNING *`,
      [JSON.stringify(items)]
    );
    res.status(201).json({ message: 'Quick order placed successfully', order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Access Check Information (Bill, Active Orders, etc.)
router.get('/api/ordering/check-access/:table_id', verifyToken, async (req, res) => {
  try {
    const { table_id } = req.params;
    const result = await pool.query(
      `SELECT o.id AS order_id, o.items, o.status, o.created_at 
       FROM orders o WHERE o.table_id = $1 AND o.status != 'Completed' ORDER BY o.created_at ASC`,
      [table_id]
    );
    res.status(200).json({ active_orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Switch User (Log Out Current User)
router.post('/api/employees/switch-user', verifyToken, async (req, res) => {
  try {
    res.status(200).json({ message: 'User switched successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Item to Order Screen (Draft Order)
router.post('/api/order/add-item', verifyToken, async (req, res) => {
  try {
    const { check_id, item, category, seat_number } = req.body;
    const result = await pool.query(
      `INSERT INTO order_items (check_id, item, category, seat_number, status) 
       VALUES ($1, $2, $3, $4, 'Pending') RETURNING *`,
      [check_id, item, category, seat_number]
    );
    res.status(201).json({ message: 'Item added to draft order', order_item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Tab Name
router.put('/api/order/tab-name/:check_id', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.params;
    const { tab_name } = req.body;
    const result = await pool.query(
      `UPDATE checks SET tab_name = $1 WHERE id = $2 RETURNING *`,
      [tab_name, check_id]
    );
    res.status(200).json({ message: 'Tab name updated', check: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit Order (Stay or Send)
router.post('/api/order/submit', verifyToken, async (req, res) => {
  try {
    const { check_id, action } = req.body;
    await pool.query(
      `UPDATE order_items SET status = 'Sent' WHERE check_id = $1 AND status = 'Pending'`,
      [check_id]
    );
    res.status(200).json({ message: `Order submitted with '${action}' action.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Order Summary (Drinks & Food)
router.get('/api/order/summary/:check_id', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.params;
    const result = await pool.query(
      `SELECT item, category, seat_number, status 
       FROM order_items WHERE check_id = $1 ORDER BY category, seat_number`,
      [check_id]
    );
    res.status(200).json({ summary: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Calculate Subtotal and Tax
router.get('/api/order/total/:check_id', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.params;
    const result = await pool.query(
      `SELECT SUM(price) AS subtotal, SUM(price * 0.08) AS tax 
       FROM order_items WHERE check_id = $1`,
      [check_id]
    );
    res.status(200).json({ totals: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Split Check or Items
router.post('/api/order/split', verifyToken, async (req, res) => {
  try {
    const { original_check_id, items_to_split } = req.body;
    const newCheck = await pool.query(
      `INSERT INTO checks (created_at) VALUES (NOW()) RETURNING id`
    );
    const newCheckId = newCheck.rows[0].id;

    await Promise.all(items_to_split.map(id => {
      return pool.query(`UPDATE order_items SET check_id = $1 WHERE id = $2`, [newCheckId, id]);
    }));

    res.status(200).json({ message: 'Check/items split successfully', new_check_id: newCheckId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pay for a Check
router.post('/api/order/pay', verifyToken, async (req, res) => {
  try {
    const { check_id, payment_method, amount } = req.body;
    await pool.query(
      `INSERT INTO payments (check_id, method, amount, paid_at) VALUES ($1, $2, $3, NOW())`,
      [check_id, payment_method, amount]
    );
    await pool.query(
      `UPDATE checks SET status = 'Paid' WHERE id = $1`,
      [check_id]
    );
    res.status(200).json({ message: 'Payment processed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Print Check
router.get('/api/order/print/:check_id', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.params;
    res.status(200).json({ message: `Tab ${check_id} sent to printer.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Main Categories (Food/Drinks)
router.get('/api/menu/main-categories', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT DISTINCT main_category FROM menu_items`);
    res.status(200).json({ main_categories: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Subcategories by Main Category
router.get('/api/menu/subcategories/:main_category', verifyToken, async (req, res) => {
  try {
    const { main_category } = req.params;
    const result = await pool.query(
      `SELECT DISTINCT subcategory FROM menu_items WHERE main_category = $1`,
      [main_category]
    );
    res.status(200).json({ subcategories: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Menu Items by Subcategory
router.get('/api/menu/items/:subcategory', verifyToken, async (req, res) => {
  try {
    const { subcategory } = req.params;
    const result = await pool.query(
      `SELECT id, name, price FROM menu_items WHERE subcategory = $1`,
      [subcategory]
    );
    res.status(200).json({ items: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Modifiers by Menu Item
router.get('/api/menu/modifiers/:item_id', verifyToken, async (req, res) => {
  try {
    const { item_id } = req.params;
    const result = await pool.query(
      `SELECT * FROM item_modifiers WHERE item_id = $1 ORDER BY step_order ASC`,
      [item_id]
    );
    res.status(200).json({ modifier_steps: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Modifier to Order Item
router.post('/api/order/modifier', verifyToken, async (req, res) => {
  try {
    const { order_item_id, modifier_name, modifier_price } = req.body;
    const result = await pool.query(
      `INSERT INTO order_item_modifiers (order_item_id, name, price) VALUES ($1, $2, $3) RETURNING *`,
      [order_item_id, modifier_name, modifier_price]
    );
    res.status(200).json({ message: 'Modifier added', modifier: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Dining Option (Dine In / Take Out)
router.post('/api/order/dining-option', verifyToken, async (req, res) => {
  try {
    const { order_item_id, option } = req.body;
    const result = await pool.query(
      `UPDATE order_items SET dining_option = $1 WHERE id = $2 RETURNING *`,
      [option, order_item_id]
    );
    res.status(200).json({ message: 'Dining option updated', item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Special Request
router.post('/api/order/special-request', verifyToken, async (req, res) => {
  try {
    const { order_item_id, request } = req.body;
    const result = await pool.query(
      `UPDATE order_items SET special_request = $1 WHERE id = $2 RETURNING *`,
      [request, order_item_id]
    );
    res.status(200).json({ message: 'Special request added', item: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apply Discount to Item
router.post('/api/order/discount', verifyToken, async (req, res) => {
  try {
    const { order_item_id, discount_name, discount_amount } = req.body;
    const result = await pool.query(
      `INSERT INTO order_item_discounts (order_item_id, discount_name, discount_amount) VALUES ($1, $2, $3) RETURNING *`,
      [order_item_id, discount_name, discount_amount]
    );
    res.status(200).json({ message: 'Discount applied', discount: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Checks by Status and Optional Filters
router.get('/api/checks/:employee_id/:status', verifyToken, async (req, res) => {
  try {
    const { employee_id, status } = req.params;
    const { search, sort } = req.query;

    let baseQuery = `SELECT c.id AS check_id, c.tab_name, c.dining_option, c.status, c.created_at, c.closed_at, 
                        COALESCE(SUM(oi.price + COALESCE(m.price, 0) - COALESCE(d.discount_amount, 0)), 0) AS total_due,
                        STRING_AGG(oi.item, ', ') AS ordered_items
                     FROM checks c
                     LEFT JOIN order_items oi ON c.id = oi.check_id
                     LEFT JOIN order_item_modifiers m ON oi.id = m.order_item_id
                     LEFT JOIN order_item_discounts d ON oi.id = d.order_item_id
                     WHERE c.server_id = $1 AND c.status = $2`;

    const params = [employee_id, status];
    if (search) {
      baseQuery += ` AND (CAST(c.id AS TEXT) ILIKE $3 OR c.tab_name ILIKE $3)`;
      params.push(`%${search}%`);
    }

    baseQuery += ` GROUP BY c.id`;

    if (sort === 'recent') {
      baseQuery += ` ORDER BY c.created_at DESC`;
    } else if (sort === 'oldest') {
      baseQuery += ` ORDER BY c.created_at ASC`;
    } else {
      baseQuery += ` ORDER BY c.id DESC`;
    }

    const result = await pool.query(baseQuery, params);
    res.status(200).json({ checks: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Check Details
router.get('/api/checks/detail/:check_id', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.params;
    const result = await pool.query(
      `SELECT c.id AS check_id, c.tab_name, c.dining_option, c.status, c.created_at, c.closed_at,
              SUM(oi.price + COALESCE(m.price, 0) - COALESCE(d.discount_amount, 0)) AS subtotal,
              ROUND(SUM(oi.price + COALESCE(m.price, 0) - COALESCE(d.discount_amount, 0)) * 0.08, 2) AS tax,
              ROUND(SUM(oi.price + COALESCE(m.price, 0) - COALESCE(d.discount_amount, 0)) * 1.08, 2) AS total
       FROM checks c
       LEFT JOIN order_items oi ON c.id = oi.check_id
       LEFT JOIN order_item_modifiers m ON oi.id = m.order_item_id
       LEFT JOIN order_item_discounts d ON oi.id = d.order_item_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [check_id]
    );
    res.status(200).json({ check: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Log Tip & Close Check
router.post('/api/checks/close', verifyToken, async (req, res) => {
  try {
    const { check_id, tip_amount } = req.body;
    await pool.query(
      `UPDATE checks SET tip_amount = $1, status = 'Paid', closed_at = NOW() WHERE id = $2 AND status = 'Closed'`,
      [tip_amount, check_id]
    );
    res.status(200).json({ message: 'Tip logged and check closed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Automatically Close Check on Cash Payment (No Tip)
router.post('/api/checks/pay-cash', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.body;
    await pool.query(
      `UPDATE checks SET status = 'Paid', closed_at = NOW() WHERE id = $1 AND status = 'Closed'`,
      [check_id]
    );
    res.status(200).json({ message: 'Cash check marked as paid' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Predict Common Tender Amounts
router.get('/api/payment/suggestions/:amount', verifyToken, (req, res) => {
  try {
    const amount = parseFloat(req.params.amount);
    const suggestions = [
      Math.ceil(amount),
      Math.ceil(amount / 5) * 5,
      Math.ceil(amount / 10) * 10
    ];
    res.status(200).json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit Payment Info
router.post('/api/payment/submit', verifyToken, async (req, res) => {
  try {
    const { check_id, payment_type, amount_tendered, tip_amount } = req.body;
    await pool.query(
      `INSERT INTO payments (check_id, method, amount, tip, paid_at) VALUES ($1, $2, $3, $4, NOW())`,
      [check_id, payment_type, amount_tendered, tip_amount]
    );
    await pool.query(
      `UPDATE checks SET status = 'Closed', closed_at = NOW(), tip_amount = $1 WHERE id = $2`,
      [tip_amount, check_id]
    );
    res.status(200).json({ message: 'Payment recorded successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Simulate Card Processing Request
router.post('/api/payment/card/initiate', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.body;
    const check = await pool.query(
      `SELECT c.id, c.tab_name,
              SUM(oi.price + COALESCE(m.price, 0) - COALESCE(d.discount_amount, 0)) AS subtotal,
              ROUND(SUM(oi.price + COALESCE(m.price, 0) - COALESCE(d.discount_amount, 0)) * 0.08, 2) AS tax,
              ROUND(SUM(oi.price + COALESCE(m.price, 0) - COALESCE(d.discount_amount, 0)) * 1.08, 2) AS total
       FROM checks c
       LEFT JOIN order_items oi ON c.id = oi.check_id
       LEFT JOIN order_item_modifiers m ON oi.id = m.order_item_id
       LEFT JOIN order_item_discounts d ON oi.id = d.order_item_id
       WHERE c.id = $1 GROUP BY c.id`,
      [check_id]
    );
    res.status(200).json({ payment_prompt: 'Insert, Swipe, or Tap Card', card_payment: check.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Type-In Card Number (Manual Entry)
router.post('/api/payment/card/manual', verifyToken, async (req, res) => {
  try {
    const { check_id, card_number, exp_date, cvv, tip_amount } = req.body;
    await pool.query(
      `INSERT INTO payments (check_id, method, amount, tip, paid_at, details)
       VALUES ($1, 'Card (Manual)', (SELECT ROUND(SUM(oi.price + COALESCE(m.price,0) - COALESCE(d.discount_amount,0)) * 1.08, 2)
       FROM order_items oi
       LEFT JOIN order_item_modifiers m ON oi.id = m.order_item_id
       LEFT JOIN order_item_discounts d ON oi.id = d.order_item_id
       WHERE oi.check_id = $1), $2, NOW(), $3)`,
      [check_id, tip_amount, `Card: ${card_number.slice(-4)}, Exp: ${exp_date}`]
    );
    await pool.query(`UPDATE checks SET status = 'Closed', closed_at = NOW(), tip_amount = $1 WHERE id = $2`, [tip_amount, check_id]);
    res.status(200).json({ message: 'Manual card payment accepted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel Card Payment Screen (Reset)
router.post('/api/payment/card/cancel', verifyToken, (req, res) => {
  res.status(200).json({ message: 'Card payment cancelled and screen reset' });
});

// CHECK: Tip Update
router.put('/api/checks/:check_id/tip', verifyToken, async (req, res) => {
  const { tip_amount } = req.body;
  const { check_id } = req.params;
  try {
    await pool.query(`UPDATE checks SET tip_amount = $1 WHERE id = $2`, [tip_amount, check_id]);
    res.status(200).json({ message: 'Tip updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CHECK: Get Check Items
router.get('/api/checks/:check_id/items', verifyToken, async (req, res) => {
  const { check_id } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM order_items WHERE check_id = $1`, [check_id]);
    res.status(200).json({ items: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CHECK: Split Items to New Check
router.post('/api/checks/split', verifyToken, async (req, res) => {
  const { check_id, item_ids } = req.body;
  try {
    const newCheck = await pool.query(`INSERT INTO checks (status, created_at) VALUES ('Open', NOW()) RETURNING id`);
    const newCheckId = newCheck.rows[0].id;
    for (const id of item_ids) {
      await pool.query(`UPDATE order_items SET check_id = $1 WHERE id = $2`, [newCheckId, id]);
    }
    res.status(200).json({ new_check_id: newCheckId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CARD: Auto-Detect Payment
router.post('/api/payment/card/auto-detect', verifyToken, async (req, res) => {
  const { check_id, amount, tip_amount, card_last4 } = req.body;
  try {
    await pool.query(`INSERT INTO payments (check_id, method, amount, tip, paid_at, details)
      VALUES ($1, 'Card (Auto)', $2, $3, NOW(), $4)`, [check_id, amount, tip_amount, `**** **** **** ${card_last4}`]);
    await pool.query(`UPDATE checks SET status = 'Closed', closed_at = NOW(), tip_amount = $1 WHERE id = $2`, [tip_amount, check_id]);
    res.status(200).json({ message: 'Card payment auto-detected and recorded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EMPLOYEE: Select Active Role
router.put('/api/employees/:id/role-active', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  try {
    await pool.query(`UPDATE employees SET active_role = $1 WHERE id = $2`, [role, id]);
    res.status(200).json({ message: 'Active role selected.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DINING: Get Rooms
router.get('/api/layout/rooms', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM dining_rooms ORDER BY name ASC`);
    res.status(200).json({ rooms: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DINING: Get Floor Plan
router.get('/api/layout/:room_id/floor-plan', verifyToken, async (req, res) => {
  const { room_id } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM tables WHERE dining_room_id = $1 ORDER BY number ASC`, [room_id]);
    res.status(200).json({ floor_plan: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RECEIPT: Print Preview
router.get('/api/order/print-preview/:check_id', verifyToken, async (req, res) => {
  const { check_id } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM order_items WHERE check_id = $1`, [check_id]);
    res.status(200).json({ preview: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POS: Switch User Session
router.post('/api/pos/session/switch-user', verifyToken, (req, res) => {
  res.status(200).json({ message: 'Session ended. Ready for next login.' });
});

// POS: Button Config
router.get('/api/pos/config/buttons', verifyToken, (req, res) => {
  res.status(200).json({ buttons: ['Pay', 'Split', 'Print', 'Checks', 'Quick Order', 'Switch User'] });
});

// KDS: Get Active Orders (Expo View)
router.get('/api/kds/orders', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.id AS order_id, o.check_id, o.created_at, o.dining_option, o.tab_name, o.server_name,
             oi.id AS item_id, oi.item, oi.subcategory, oi.status, oi.completed_at
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      WHERE o.status != 'Fulfilled'
      ORDER BY o.created_at ASC
    `);
    res.status(200).json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: Mark Item Complete
router.post('/api/kds/item/:item_id/complete', verifyToken, async (req, res) => {
  const { item_id } = req.params;
  try {
    await pool.query(`UPDATE order_items SET status = 'Complete', completed_at = NOW() WHERE id = $1`, [item_id]);
    res.status(200).json({ message: 'Item marked complete.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: Recall Order
router.post('/api/kds/order/:order_id/recall', verifyToken, async (req, res) => {
  const { order_id } = req.params;
  try {
    await pool.query(`UPDATE orders SET status = 'Recalled', recalled_at = NOW() WHERE id = $1`, [order_id]);
    res.status(200).json({ message: 'Order recalled to KDS.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: Fulfilled Orders
router.get('/api/kds/orders/fulfilled', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM orders WHERE status = 'Fulfilled' ORDER BY fulfilled_at DESC LIMIT 50
    `);
    res.status(200).json({ fulfilled_orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: View Orders by Station
router.get('/api/kds/station/:station_name', verifyToken, async (req, res) => {
  const { station_name } = req.params;
  try {
    const result = await pool.query(`
      SELECT o.id AS order_id, oi.*
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      WHERE oi.station = $1 AND o.status != 'Fulfilled'
      ORDER BY o.created_at ASC
    `, [station_name]);
    res.status(200).json({ station_orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: All Day View
router.get('/api/kds/view/all-day', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT item, subcategory, COUNT(*) AS quantity
      FROM order_items
      WHERE status != 'Complete'
      GROUP BY item, subcategory
      ORDER BY quantity DESC
    `);
    res.status(200).json({ summary: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: Expo View
router.get('/api/kds/view/expo', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM orders WHERE status != 'Fulfilled' ORDER BY created_at ASC
    `);
    res.status(200).json({ expo_orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: Subcategories for Footer Filters
router.get('/api/kds/subcategories', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT DISTINCT subcategory FROM order_items ORDER BY subcategory ASC`);
    res.status(200).json({ subcategories: result.rows.map(row => row.subcategory) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: Wait Threshold Settings (Update)
router.put('/api/kds/settings/wait-thresholds', verifyToken, async (req, res) => {
  const { green, yellow, red } = req.body;
  try {
    await pool.query(`UPDATE kds_settings SET green_threshold = $1, yellow_threshold = $2, red_threshold = $3`, [green, yellow, red]);
    res.status(200).json({ message: 'Thresholds updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// KDS: Status Counts Summary
router.get('/api/kds/status-counts', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT status, COUNT(*) FROM orders GROUP BY status`);
    res.status(200).json({ status_summary: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch checks by type: Open, Closed, Paid
router.get('/api/checks/:type', verifyToken, async (req, res) => {
  try {
    const { type } = req.params;
    const result = await pool.query('SELECT * FROM checks WHERE status = $1 ORDER BY updated_at DESC', [type]);
    res.status(200).json({ checks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Filter/Search Checks
router.get('/api/checks/search', verifyToken, async (req, res) => {
  try {
    const { query } = req.query;
    const result = await pool.query(
      `SELECT * FROM checks WHERE tab_name ILIKE $1 OR check_number::text ILIKE $1 ORDER BY updated_at DESC`,
      [`%${query}%`]
    );
    res.status(200).json({ checks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process cash payment
router.post('/api/payments/cash', verifyToken, async (req, res) => {
  try {
    const { check_id, amount_tendered, total_due } = req.body;
    const change_due = amount_tendered - total_due;
    await pool.query('UPDATE checks SET status = $1 WHERE id = $2', ['Closed', check_id]);
    res.status(200).json({ message: 'Cash payment complete', change_due });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record tip on a closed check
router.put('/api/payments/tip/:check_id', verifyToken, async (req, res) => {
  try {
    const { check_id } = req.params;
    const { tip_amount } = req.body;
    await pool.query('UPDATE checks SET tip = $1, status = $2 WHERE id = $3', [tip_amount, 'Paid', check_id]);
    res.status(200).json({ message: 'Tip recorded and check paid' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Split Check
router.post('/api/checks/:id/split', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { method, split_details } = req.body;
    const result = await pool.query(
      'INSERT INTO check_splits (check_id, method, details) VALUES ($1, $2, $3) RETURNING *',
      [id, method, JSON.stringify(split_details)]
    );
    res.status(201).json({ message: 'Check split successfully', split: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seat Assignment
router.post('/api/seating/assign', verifyToken, async (req, res) => {
  try {
    const { order_id, seat_number } = req.body;
    const result = await pool.query(
      'UPDATE orders SET seat_number = $1 WHERE id = $2 RETURNING *',
      [seat_number, order_id]
    );
    res.status(200).json({ message: 'Seat assigned', order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order actions: Stay/Send
router.post('/api/orders/:id/send', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { close_ui } = req.body;
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['Sent', id]);
    res.status(200).json({ message: close_ui ? 'Order sent & closed UI' : 'Order sent & stayed on screen' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});