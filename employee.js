const express = require('express');
const router = express.Router();

module.exports = (pool, verifyToken) => {
  // CRUD: Employees
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM employees');
      res.json({ employees: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', verifyToken, async (req, res) => {
    const { name, role, email } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO employees (name, role, email) VALUES ($1, $2, $3) RETURNING *',
        [name, role, email]
      );
      res.status(201).json({ employee: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { name, role, email } = req.body;
    try {
      const result = await pool.query(
        'UPDATE employees SET name = $1, role = $2, email = $3 WHERE id = $4 RETURNING *',
        [name, role, email, id]
      );
      res.json({ employee: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('DELETE FROM employees WHERE id = $1', [id]);
      res.json({ message: 'Employee deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Shifts
  router.get('/:id/shifts', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM shifts WHERE employee_id = $1',
        [req.params.id]
      );
      res.json({ shifts: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/shifts', verifyToken, async (req, res) => {
    const { shift_date, start_time, end_time } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO shifts (employee_id, shift_date, start_time, end_time) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.params.id, shift_date, start_time, end_time]
      );
      res.status(201).json({ shift: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Payroll
  router.get('/:id/payroll', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM payroll WHERE employee_id = $1',
        [req.params.id]
      );
      res.json({ payroll: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/payroll', verifyToken, async (req, res) => {
    const { pay_period, gross_salary, net_salary } = req.body;
    try {
      const result = await pool.query(
        'INSERT INTO payroll (employee_id, pay_period, gross_salary, net_salary) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.params.id, pay_period, gross_salary, net_salary]
      );
      res.status(201).json({ payroll: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Tips & Earnings
  router.get('/:id/tips-earnings', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM tips_earnings WHERE employee_id = $1',
        [req.params.id]
      );
      res.json({ tips_earnings: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Roles & Permissions
  router.get('/:id/roles', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT role, permissions FROM employees WHERE id = $1',
        [req.params.id]
      );
      res.json({ roles: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Activity Logs
  router.get('/:id/activity', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM employee_activity WHERE employee_id = $1 ORDER BY timestamp DESC',
        [req.params.id]
      );
      res.json({ activity_logs: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
