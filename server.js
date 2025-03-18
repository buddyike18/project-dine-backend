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
  user: process.env.PG_USER || 'postgres',
  host: process.env.PG_HOST || 'localhost',
  database: process.env.PG_DATABASE || 'dinedb',
  password: process.env.PG_PASSWORD || 'your_password_here', // Replace with actual password
  port: process.env.PG_PORT || 5432,
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

// Update User Profile
app.put('/api/auth/profile', verifyToken, async (req, res) => {
  try {
    const { email } = req.body;
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.user.uid]);
    res.status(200).json({ message: 'Profile updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete User Account
app.delete('/api/auth/delete', verifyToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.uid]);
    res.status(200).json({ message: 'User account deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a Restaurant
app.post('/api/restaurants', verifyToken, async (req, res) => {
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
app.get('/api/restaurants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM restaurants');
    res.status(200).json({ restaurants: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Restaurant Information
app.put('/api/restaurants/:id', verifyToken, async (req, res) => {
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
app.delete('/api/restaurants/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM restaurants WHERE id = $1', [id]);
    res.status(200).json({ message: 'Restaurant deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// Add a Menu Item
app.post('/api/menu', verifyToken, async (req, res) => {
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
app.get('/api/menu/:restaurant_id', async (req, res) => {
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
app.put('/api/menu/:id', verifyToken, async (req, res) => {
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
app.delete('/api/menu/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM menu WHERE id = $1', [id]);
      res.status(200).json({ message: 'Menu item deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Create a Table Reservation
app.post('/api/reservations', verifyToken, async (req, res) => {
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
app.get('/api/reservations', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM reservations WHERE user_id = $1', [req.user.uid]);
      res.status(200).json({ reservations: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

// Update a Reservation
app.put('/api/reservations/:id', verifyToken, async (req, res) => {
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
app.delete('/api/reservations/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM reservations WHERE id = $1', [id]);
      res.status(200).json({ message: 'Reservation deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch All Orders for a User
app.get('/api/orders', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM orders WHERE user_id = $1', [req.user.uid]);
      res.status(200).json({ orders: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create an Order
app.post('/api/orders', verifyToken, async (req, res) => {
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
app.put('/api/orders/:id', verifyToken, async (req, res) => {
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
app.delete('/api/orders/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM orders WHERE id = $1', [id]);
      res.status(200).json({ message: 'Order deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Sales Reports
app.get('/api/reports/sales', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM sales_reports');
      res.status(200).json({ sales_reports: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Employee Sales Reports
app.get('/api/reports/employees', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM employee_sales_reports');
      res.status(200).json({ employee_sales_reports: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch All Employees
app.get('/api/employees', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM employees');
      res.status(200).json({ employees: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add a New Employee
app.post('/api/employees', verifyToken, async (req, res) => {
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
app.put('/api/employees/:id', verifyToken, async (req, res) => {
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
app.delete('/api/employees/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM employees WHERE id = $1', [id]);
      res.status(200).json({ message: 'Employee deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Employee Shifts
app.get('/api/employees/:id/shifts', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1',
        [id]
      );
      res.status(200).json({ shifts: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create a Shift for an Employee
app.post('/api/employees/:id/shifts', verifyToken, async (req, res) => {
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
app.put('/api/employees/:id/shifts/:shift_id', verifyToken, async (req, res) => {
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
app.delete('/api/employees/:id/shifts/:shift_id', verifyToken, async (req, res) => {
    try {
      const { id, shift_id } = req.params;
      await pool.query('DELETE FROM shifts WHERE id = $1 AND employee_id = $2', [shift_id, id]);
      res.status(200).json({ message: 'Shift deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Employee Payroll Information
app.get('/api/employees/:id/payroll', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        'SELECT * FROM payroll WHERE employee_id = $1',
        [id]
      );
      res.status(200).json({ payroll: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add Payroll Information for an Employee
app.post('/api/employees/:id/payroll', verifyToken, async (req, res) => {
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
app.put('/api/employees/:id/payroll/:payroll_id', verifyToken, async (req, res) => {
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
app.delete('/api/employees/:id/payroll/:payroll_id', verifyToken, async (req, res) => {
    try {
      const { id, payroll_id } = req.params;
      await pool.query('DELETE FROM payroll WHERE id = $1 AND employee_id = $2', [payroll_id, id]);
      res.status(200).json({ message: 'Payroll record deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Notifications for a User
app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1', [req.user.uid]);
      res.status(200).json({ notifications: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Inventory Items
app.get('/api/inventory', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM inventory');
      res.status(200).json({ inventory: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Add an Inventory Item
app.post('/api/inventory', verifyToken, async (req, res) => {
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
app.put('/api/inventory/:id', verifyToken, async (req, res) => {
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
app.delete('/api/inventory/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM inventory WHERE id = $1', [id]);
      res.status(200).json({ message: 'Inventory item deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Low Stock Inventory Items
app.get('/api/inventory/low-stock', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM inventory WHERE quantity <= low_stock_threshold');
      res.status(200).json({ low_stock_items: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Place a Supplier Order for Inventory Restock
app.post('/api/inventory/order', verifyToken, async (req, res) => {
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

  // Place a Supplier Order for Inventory Restock
app.post('/api/inventory/order', verifyToken, async (req, res) => {
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
app.get('/api/inventory/orders', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM supplier_orders');
      res.status(200).json({ supplier_orders: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Supplier Orders
app.get('/api/inventory/orders', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM supplier_orders');
      res.status(200).json({ supplier_orders: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update Supplier Order Status
app.put('/api/inventory/orders/:id', verifyToken, async (req, res) => {
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
app.delete('/api/inventory/orders/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM supplier_orders WHERE id = $1', [id]);
      res.status(200).json({ message: 'Supplier order deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Employee Work Hours
app.get('/api/employees/:id/work-hours', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        'SELECT * FROM work_hours WHERE employee_id = $1',
        [id]
      );
      res.status(200).json({ work_hours: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Record Employee Work Hours
app.post('/api/employees/:id/work-hours', verifyToken, async (req, res) => {
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
app.put('/api/employees/:id/work-hours/:work_hours_id', verifyToken, async (req, res) => {
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
app.delete('/api/employees/:id/work-hours/:work_hours_id', verifyToken, async (req, res) => {
    try {
      const { id, work_hours_id } = req.params;
      await pool.query('DELETE FROM work_hours WHERE id = $1 AND employee_id = $2', [work_hours_id, id]);
      res.status(200).json({ message: 'Work hours deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Employee Tips & Earnings
app.get('/api/employees/:id/tips-earnings', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        'SELECT * FROM tips_earnings WHERE employee_id = $1',
        [id]
      );
      res.status(200).json({ tips_earnings: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Record Employee Tips & Earnings
app.post('/api/employees/:id/tips-earnings', verifyToken, async (req, res) => {
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
app.put('/api/employees/:id/tips-earnings/:tips_earnings_id', verifyToken, async (req, res) => {
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
app.delete('/api/employees/:id/tips-earnings/:tips_earnings_id', verifyToken, async (req, res) => {
    try {
      const { id, tips_earnings_id } = req.params;
      await pool.query('DELETE FROM tips_earnings WHERE id = $1 AND employee_id = $2', [tips_earnings_id, id]);
      res.status(200).json({ message: 'Tips and earnings record deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Employee Performance Report
app.get('/api/employees/:id/performance', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        'SELECT * FROM employee_performance WHERE employee_id = $1',
        [id]
      );
      res.status(200).json({ performance_report: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Record Employee Performance Data
app.post('/api/employees/:id/performance', verifyToken, async (req, res) => {
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
app.put('/api/employees/:id/performance/:performance_id', verifyToken, async (req, res) => {
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
app.post('/api/auth/refresh', async (req, res) => {
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
app.get('/api/employees/:id/activity', verifyToken, async (req, res) => {
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
app.post('/api/employees/:id/shift-swap', verifyToken, async (req, res) => {
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
app.put('/api/employees/shift-swap/:swap_id', verifyToken, async (req, res) => {
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
app.get('/api/waitlist', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at ASC');
      res.status(200).json({ waitlist: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Add Customer to Waitlist
app.post('/api/waitlist', verifyToken, async (req, res) => {
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
app.post('/api/waitlist/:id/notify', verifyToken, async (req, res) => {
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
app.delete('/api/waitlist/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM waitlist WHERE id = $1', [id]);
      res.status(200).json({ message: 'Customer removed from waitlist' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Add Custom Modifiers for Orders
app.post('/api/orders/:id/modifiers', verifyToken, async (req, res) => {
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
app.put('/api/orders/:id/priority', verifyToken, async (req, res) => {
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
app.put('/api/orders/:id/status', verifyToken, async (req, res) => {
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

  // Process Gift Card Payment
app.post('/api/payments/gift-card', verifyToken, async (req, res) => {
    try {
      const { gift_card_number, order_id, amount } = req.body;
      const result = await pool.query(
        'SELECT balance FROM gift_cards WHERE card_number = $1', [gift_card_number]
      );
      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid gift card number' });
      }
      const balance = result.rows[0].balance;
      if (balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      await pool.query('UPDATE gift_cards SET balance = balance - $1 WHERE card_number = $2', [amount, gift_card_number]);
      await pool.query('INSERT INTO payments (order_id, payment_method, amount) VALUES ($1, $2, $3)', [order_id, 'Gift Card', amount]);
      res.status(200).json({ message: 'Payment processed successfully', remaining_balance: balance - amount });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Accrue or Redeem Loyalty Points
app.post('/api/payments/loyalty-points', verifyToken, async (req, res) => {
    try {
      const { user_id, order_id, action, points } = req.body;
      if (!['accrue', 'redeem'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use accrue or redeem' });
      }
      const userPoints = await pool.query('SELECT points FROM loyalty_program WHERE user_id = $1', [user_id]);
      let currentPoints = userPoints.rows.length ? userPoints.rows[0].points : 0;
      if (action === 'redeem' && currentPoints < points) {
        return res.status(400).json({ error: 'Insufficient loyalty points' });
      }
      const newPoints = action === 'accrue' ? currentPoints + points : currentPoints - points;
      await pool.query('INSERT INTO payments (order_id, payment_method, amount) VALUES ($1, $2, $3)', [order_id, 'Loyalty Points', points]);
      await pool.query('UPDATE loyalty_program SET points = $1 WHERE user_id = $2 RETURNING *', [newPoints, user_id]);
      res.status(200).json({ message: `Loyalty points ${action}d successfully`, updated_points: newPoints });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete User Account
app.delete('/api/auth/delete', verifyToken, async (req, res) => {
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [req.user.uid]);
      res.status(200).json({ message: 'User account deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Employee Roles & Permissions
app.get('/api/employees/:id/roles', verifyToken, async (req, res) => {
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
app.get('/api/tables/available', verifyToken, async (req, res) => {
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
app.get('/api/menu/categories', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT DISTINCT category FROM menu ORDER BY category ASC');
      res.status(200).json({ categories: result.rows.map(row => row.category) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Most Ordered Menu Items
app.get('/api/menu/popular', verifyToken, async (req, res) => {
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
app.get('/api/payments/history', verifyToken, async (req, res) => {
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
app.get('/api/inventory/report', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT item_name, quantity, low_stock_threshold, (CASE WHEN quantity <= low_stock_threshold THEN true ELSE false END) AS low_stock FROM inventory ORDER BY item_name ASC'
      );
      res.status(200).json({ inventory_report: result.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch Revenue Reports by Timeframe
app.get('/api/reports/revenue', verifyToken, async (req, res) => {
    try {
      const { timeframe } = req.query; // Options: daily, weekly, monthly
      let query;
      if (timeframe === 'daily') {
        query = "SELECT DATE(payment_date) AS date, SUM(amount) AS total_revenue FROM payments WHERE payment_date >= NOW() - INTERVAL '30 days' GROUP BY DATE(payment_date) ORDER BY date DESC";
      } else if (timeframe === 'weekly') {
        query = "SELECT DATE_TRUNC('week', payment_date) AS week, SUM(amount) AS total_revenue FROM payments WHERE payment_date >= NOW() - INTERVAL '12 weeks' GROUP BY week ORDER BY week DESC";
      } else if (timeframe === 'monthly') {
        query = "SELECT DATE_TRUNC('month', payment_date) AS month, SUM(amount) AS total_revenue FROM payments WHERE payment_date >= NOW() - INTERVAL '12 months' GROUP BY month ORDER BY month DESC";
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
app.post('/api/notifications/push', verifyToken, async (req, res) => {
    try {
      const { user_id, title, message } = req.body;
      const result = await pool.query(
        'SELECT device_token FROM users WHERE id = $1',
        [user_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found or no device token available' });
      }
      const deviceToken = result.rows[0].device_token;
      const payload = {
        notification: {
          title: title,
          body: message
        }
      };
      await admin.messaging().sendToDevice(deviceToken, payload);
      res.status(200).json({ message: 'Push notification sent successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send Promotional Discounts
app.post('/api/promotions', verifyToken, async (req, res) => {
    try {
      const { title, description, discount_code, expiration_date, target_audience } = req.body;
      const result = await pool.query(
        'INSERT INTO promotions (title, description, discount_code, expiration_date, target_audience) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [title, description, discount_code, expiration_date, target_audience]
      );
      res.status(201).json({ message: 'Promotional discount created successfully', promotion: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Collect Customer Feedback & Ratings
app.post('/api/reviews', verifyToken, async (req, res) => {
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
app.post('/api/waitlist', verifyToken, async (req, res) => {
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
app.get('/api/waitlist', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at ASC');
    res.status(200).json({ waitlist: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Notify Waitlist Customer
app.post('/api/waitlist/:id/notify', verifyToken, async (req, res) => {
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
app.delete('/api/waitlist/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM waitlist WHERE id = $1', [id]);
    res.status(200).json({ message: 'Customer removed from waitlist' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Customer Review
app.post('/api/reviews', verifyToken, async (req, res) => {
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
app.get('/api/reviews/:restaurant_id', async (req, res) => {
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
app.put('/api/reviews/:id', verifyToken, async (req, res) => {
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
app.delete('/api/reviews/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);
    res.status(200).json({ message: 'Review deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Shifts for an Employee
app.get('/api/shifts/:employee_id', verifyToken, async (req, res) => {
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
app.put('/api/shifts/:id', verifyToken, async (req, res) => {
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
app.delete('/api/shifts/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM shifts WHERE id = $1', [id]);
    res.status(200).json({ message: 'Shift deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Request a Shift Swap
app.post('/api/shifts/:id/swap', verifyToken, async (req, res) => {
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
app.put('/api/shifts/swap/:swap_id', verifyToken, async (req, res) => {
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
app.get('/api/kds/orders', verifyToken, async (req, res) => {
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
app.put('/api/kds/orders/:id/status', verifyToken, async (req, res) => {
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
app.put('/api/kds/orders/:id/assign', verifyToken, async (req, res) => {
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
app.get('/api/kds/orders/completed', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE status = 'Completed' ORDER BY updated_at DESC"
    );
    res.status(200).json({ completed_orders: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

