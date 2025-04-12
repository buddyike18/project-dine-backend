const express = require('express');
const router = express.Router();

const handleError = (res, err) => res.status(500).json({ error: err.message });

module.exports = (pool, verifyToken) => {
  // [GET] /employees - Fetch all employees
  router.get('/', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM employees');
      res.json({ employees: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /employees - Create new employee
  router.post('/', verifyToken, async (req, res) => {
    const { name, role, email } = req.body;
    if (!name || !role || !email) {
      return res.status(400).json({ error: 'Name, role, and email are required' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO employees (name, role, email) VALUES ($1, $2, $3) RETURNING *',
        [name, role, email]
      );
      res.status(201).json({ employee: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PUT] /employees/:id - Update employee
  router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { name, role, email } = req.body;
    if (!name || !role || !email) {
      return res.status(400).json({ error: 'Name, role, and email are required' });
    }
    try {
      const result = await pool.query(
        'UPDATE employees SET name = $1, role = $2, email = $3 WHERE id = $4 RETURNING *',
        [name, role, email, id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found' });
      res.json({ employee: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [DELETE] /employees/:id - Delete employee
  router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query('DELETE FROM employees WHERE id = $1 RETURNING *', [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found' });
      res.json({ message: 'Employee deleted' });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /employees/:id/shifts - View employee shifts
  router.get('/:id/shifts', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM shifts WHERE employee_id = $1', [req.params.id]);
      res.json({ shifts: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /employees/:id/shifts - Create shift for employee
  router.post('/:id/shifts', verifyToken, async (req, res) => {
    const { shift_date, start_time, end_time } = req.body;
    if (!shift_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'All shift fields are required' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO shifts (employee_id, shift_date, start_time, end_time) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.params.id, shift_date, start_time, end_time]
      );
      res.status(201).json({ shift: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /employees/:id/payroll - View employee payroll
  router.get('/:id/payroll', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM payroll WHERE employee_id = $1', [req.params.id]);
      res.json({ payroll: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [POST] /employees/:id/payroll - Create payroll entry
  router.post('/:id/payroll', verifyToken, async (req, res) => {
    const { pay_period, gross_salary, net_salary } = req.body;
    if (!pay_period || gross_salary == null || net_salary == null) {
      return res.status(400).json({ error: 'All payroll fields are required' });
    }
    try {
      const result = await pool.query(
        'INSERT INTO payroll (employee_id, pay_period, gross_salary, net_salary) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.params.id, pay_period, gross_salary, net_salary]
      );
      res.status(201).json({ payroll: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /employees/:id/tips-earnings - View tips & earnings
  router.get('/:id/tips-earnings', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM tips_earnings WHERE employee_id = $1', [req.params.id]);
      res.json({ tips_earnings: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /employees/:id/roles - View employee role and permissions
  router.get('/:id/roles', verifyToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT role, permissions FROM employees WHERE id = $1', [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Employee not found' });
      res.json({ roles: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /employees/:id/activity - View activity log
  router.get('/:id/activity', verifyToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM employee_activity WHERE employee_id = $1 ORDER BY timestamp DESC',
        [req.params.id]
      );
      res.json({ activity_logs: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [GET] /employees/search/query?q=term - Search employees
  router.get('/search/query', verifyToken, async (req, res) => {
    const { q } = req.query;
    try {
      const result = await pool.query(
        `SELECT * FROM employees WHERE name ILIKE $1 OR role ILIKE $1`,
        [`%${q}%`]
      );
      res.json({ employees: result.rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // [PATCH] /employees/:id/status - Toggle active status
  router.patch('/:id/status', verifyToken, async (req, res) => {
    const { status } = req.body;
    if (typeof status !== 'boolean') {
      return res.status(400).json({ error: 'Status must be a boolean' });
    }
    try {
      const result = await pool.query(
        'UPDATE employees SET status = $1 WHERE id = $2 RETURNING *',
        [status, req.params.id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found' });
      res.json({ employee: result.rows[0] });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
};
