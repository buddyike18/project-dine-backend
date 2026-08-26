const express = require('express');
const { resolveActor } = require('../middleware/resolveActor');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function isUniqueViolation(err) {
  return err?.code === '23505';
}

function handleError(req, res, reason) {
  req.logEvent?.(
    'error',
    'menu_request_failed',
    { reason }
  );

  return res.status(500).json({
    error: 'Internal server error',
  });
}

const MENU_MANAGER_ROLES = new Set(['Manager']);

async function resolveMenuManager(pool, req) {
  const actor = await resolveActor(pool, req);

  if (!MENU_MANAGER_ROLES.has(actor.role)) {
    const error = new Error('Forbidden');
    error.status = 403;
    error.statusCode = 403;
    throw error;
  }

  return actor;
}

function sendMenuError(req, res, err, reason) {
  const statusCode = Number(err?.statusCode || err?.status || 500);

  if (statusCode === 401) {
    return res.status(401).json({
      error: 'Authentication required',
    });
  }

  if (statusCode === 403) {
    return res.status(403).json({
      error: 'Forbidden',
    });
  }

  return handleError(req, res, reason);
}

module.exports = (pool, verifyToken) => {
  // TEMP (dev): resolve a DB menu_items.id (UUID) from restaurant UUID + item name.
  // [GET] /menu/menu-items/resolve?restaurant_id=<uuid>&name=<string>
  // Note: This lives under the /menu router for now. When menu becomes fully DB-driven,
  // this endpoint can be removed.
  router.get('/menu-items/resolve', async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu lookup route is disabled' });
  });

  // Phase 37 — Modern menu infrastructure
  // [GET] /menu/categories?restaurant_id=<uuid> - Get menu categories from menu_categories
  router.get('/categories', async (req, res) => {
    const restaurant_id = String(req.query.restaurant_id || '').trim();

    if (!restaurant_id) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }

    if (!isUuid(restaurant_id)) {
      return res.status(400).json({ error: 'restaurant_id must be a valid UUID' });
    }

    try {
      const result = await pool.query(
        `SELECT id,
                restaurant_id,
                name,
                sort_order,
                active,
                menu_type
         FROM menu_categories
         WHERE restaurant_id = $1
           AND active = true
         ORDER BY sort_order ASC, name ASC`,
        [restaurant_id]
      );

      return res.json({ categories: result.rows });
    } catch (err) {
      handleError(req, res, 'MENU_CATEGORIES_READ_FAILED');
    }
  });

  // Phase 37 — Modern menu infrastructure
  // [POST] /menu/categories - Create a menu category in menu_categories
  
  // Phase 40E — Authenticated management category read, including inactive records
  router.get('/manage/categories', verifyToken, async (req, res) => {
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_CATEGORIES_READ_FAILED');
    }

    try {
      const result = await pool.query(
        `SELECT id,
                restaurant_id,
                name,
                sort_order,
                active,
                menu_type
         FROM menu_categories
         WHERE restaurant_id = $1
         ORDER BY sort_order ASC, name ASC`,
        [actor.restaurantId]
      );

      return res.json({ categories: result.rows });
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_CATEGORIES_READ_FAILED');
    }
  });

  router.post('/categories', verifyToken, async (req, res) => {
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_CATEGORY_CREATE_FAILED');
    }

    const restaurant_id = actor.restaurantId;
    const name = String(req.body.name || '').trim();
    const menu_type = String(req.body.menu_type || 'FOOD').trim().toUpperCase();
    const active = typeof req.body.active === 'boolean' ? req.body.active : true;
    const sortOrderValue = req.body.sort_order ?? 0;
    const sort_order = Number(sortOrderValue);

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (!Number.isFinite(sort_order)) {
      return res.status(400).json({ error: 'sort_order must be numeric' });
    }

    if (!['FOOD', 'DRINKS'].includes(menu_type)) {
      return res.status(400).json({ error: 'menu_type must be FOOD or DRINKS' });
    }

    try {
      const existing = await pool.query(
        `SELECT id
         FROM menu_categories
         WHERE restaurant_id = $1
           AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [restaurant_id, name]
      );

      if (existing.rowCount > 0) {
        return res.status(409).json({ error: 'Category already exists' });
      }

      const result = await pool.query(
        `INSERT INTO menu_categories (restaurant_id, name, sort_order, active, menu_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id,
                   restaurant_id,
                   name,
                   sort_order,
                   active,
                   menu_type`,
        [restaurant_id, name, sort_order, active, menu_type]
      );

      return res.status(201).json({ category: result.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Category already exists' });
      }
      return sendMenuError(req, res, err, 'MENU_CATEGORY_CREATE_FAILED');
    }
  });

  // Phase 37 — Modern menu infrastructure
  // [PATCH] /menu/categories/:categoryId - Update a menu category in menu_categories
  router.patch('/categories/:categoryId', verifyToken, async (req, res) => {
    const categoryId = String(req.params.categoryId || '').trim();
    let actor;

    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_CATEGORY_UPDATE_FAILED');
    }

    if (!isUuid(categoryId)) {
      return res.status(400).json({ error: 'categoryId must be a valid UUID' });
    }

    const restaurant_id = actor.restaurantId;

    try {
      const currentResult = await pool.query(
        `SELECT id,
                restaurant_id,
                name,
                sort_order,
                active,
                menu_type
         FROM menu_categories
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [categoryId, restaurant_id]
      );

      if (currentResult.rowCount === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const current = currentResult.rows[0];
      const name = req.body.name === undefined ? current.name : String(req.body.name || '').trim();
      const menu_type = req.body.menu_type === undefined
        ? current.menu_type
        : String(req.body.menu_type || '').trim().toUpperCase();
      const active = req.body.active === undefined ? current.active : req.body.active;
      const sort_order = req.body.sort_order === undefined ? current.sort_order : Number(req.body.sort_order);

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!Number.isFinite(sort_order)) {
        return res.status(400).json({ error: 'sort_order must be numeric' });
      }

      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be boolean' });
      }

      if (!['FOOD', 'DRINKS'].includes(menu_type)) {
        return res.status(400).json({ error: 'menu_type must be FOOD or DRINKS' });
      }

      const duplicate = await pool.query(
        `SELECT id
         FROM menu_categories
         WHERE restaurant_id = $1
           AND LOWER(name) = LOWER($2)
           AND id <> $3
         LIMIT 1`,
        [restaurant_id, name, categoryId]
      );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Category already exists' });
      }

      const result = await pool.query(
        `UPDATE menu_categories
         SET name = $1,
             sort_order = $2,
             active = $3,
             menu_type = $4
         WHERE id = $5
           AND restaurant_id = $6
         RETURNING id,
                   restaurant_id,
                   name,
                   sort_order,
                   active,
                   menu_type`,
        [name, sort_order, active, menu_type, categoryId, restaurant_id]
      );

      return res.json({ category: result.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Category already exists' });
      }
      return sendMenuError(req, res, err, 'MENU_CATEGORY_UPDATE_FAILED');
    }
  });

  // Phase 37 — Modern menu infrastructure
  // [GET] /menu/items?restaurant_id=<uuid> - Get menu items from menu_items
  router.get('/items', async (req, res) => {
    const restaurant_id = String(req.query.restaurant_id || '').trim();

    if (!restaurant_id) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }

    if (!isUuid(restaurant_id)) {
      return res.status(400).json({ error: 'restaurant_id must be a valid UUID' });
    }

    try {
      const result = await pool.query(
        `SELECT mi.id,
                mi.restaurant_id,
                mi.category_id,
                mc.name AS category_name,
                mc.menu_type,
                mi.name,
                mi.price_cents,
                mi.tax_rate_bps,
                mi.active,
                mi.available
         FROM menu_items mi
         LEFT JOIN menu_categories mc ON mc.id = mi.category_id
                                      AND mc.active = true
         WHERE mi.restaurant_id = $1
           AND mi.active = true
           AND (
             mi.category_id IS NULL
             OR mc.id IS NOT NULL
           )
         ORDER BY COALESCE(mc.sort_order, 9999) ASC, mc.name ASC, mi.name ASC`,
        [restaurant_id]
      );

      return res.json({ items: result.rows });
    } catch (err) {
      handleError(req, res, 'MENU_ITEMS_READ_FAILED');
    }
  });

  // Phase 37 — Modern menu infrastructure
  // [PATCH] /menu/items/:itemId - Update a menu item in menu_items
  
  // Phase 40E — Authenticated management item read, including inactive records
  router.get('/manage/items', verifyToken, async (req, res) => {
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_ITEMS_READ_FAILED');
    }

    try {
      const result = await pool.query(
        `SELECT mi.id,
                mi.restaurant_id,
                mi.category_id,
                mc.name AS category_name,
                mc.menu_type,
                mi.name,
                mi.price_cents,
                mi.tax_rate_bps,
                mi.active,
                mi.available
         FROM menu_items mi
         LEFT JOIN menu_categories mc ON mc.id = mi.category_id
         WHERE mi.restaurant_id = $1
         ORDER BY COALESCE(mc.sort_order, 9999) ASC,
                  mc.name ASC,
                  mi.name ASC`,
        [actor.restaurantId]
      );

      return res.json({ items: result.rows });
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_ITEMS_READ_FAILED');
    }
  });

  // Phase 41B — Create menu item
  router.post('/items', verifyToken, async (req, res) => {
    try {
      const actor = await resolveMenuManager(pool, req);
      const restaurant_id = actor.restaurantId;

      const category_id =
        req.body.category_id === undefined || req.body.category_id === null || req.body.category_id === ''
          ? null
          : String(req.body.category_id).trim();

      const name = String(req.body.name || '').trim();
      const price_cents = Number(req.body.price_cents);
      const tax_rate_bps = Number(req.body.tax_rate_bps);
      const active = req.body.active === undefined ? true : req.body.active;
      const available = req.body.available === undefined ? true : req.body.available;

      if (category_id !== null && !isUuid(category_id)) {
        return res.status(400).json({ error: 'category_id must be a valid UUID or null' });
      }

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!Number.isInteger(price_cents) || price_cents < 0) {
        return res.status(400).json({ error: 'price_cents must be an integer greater than or equal to 0' });
      }

      if (!Number.isInteger(tax_rate_bps) || tax_rate_bps < 0) {
        return res.status(400).json({ error: 'tax_rate_bps must be an integer greater than or equal to 0' });
      }

      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be boolean' });
      }

      if (typeof available !== 'boolean') {
        return res.status(400).json({ error: 'available must be boolean' });
      }

      if (category_id !== null) {
        const category = await pool.query(
          `SELECT id
           FROM menu_categories
           WHERE id = $1
             AND restaurant_id = $2
           LIMIT 1`,
          [category_id, restaurant_id]
        );

        if (category.rowCount === 0) {
          return res.status(400).json({ error: 'category_id must belong to the same restaurant' });
        }
      }

      const duplicate = category_id === null
        ? await pool.query(
            `SELECT id
             FROM menu_items
             WHERE restaurant_id = $1
               AND category_id IS NULL
               AND LOWER(name) = LOWER($2)
             LIMIT 1`,
            [restaurant_id, name]
          )
        : await pool.query(
            `SELECT id
             FROM menu_items
             WHERE restaurant_id = $1
               AND category_id = $2
               AND LOWER(name) = LOWER($3)
             LIMIT 1`,
            [restaurant_id, category_id, name]
          );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Item already exists in this category' });
      }

      const result = await pool.query(
        `INSERT INTO menu_items (
           restaurant_id,
           category_id,
           name,
           price_cents,
           tax_rate_bps,
           active,
           available
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id,
                   restaurant_id,
                   category_id,
                   name,
                   price_cents,
                   tax_rate_bps,
                   active,
                   available`,
        [restaurant_id, category_id, name, price_cents, tax_rate_bps, active, available]
      );

      return res.status(201).json({ item: result.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Item already exists in this category' });
      }
      return sendMenuError(req, res, err, 'MENU_ITEM_CREATE_FAILED');
    }
  });

  router.patch('/items/:itemId', verifyToken, async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    let actor;

    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_ITEM_UPDATE_FAILED');
    }

    if (!isUuid(itemId)) {
      return res.status(400).json({ error: 'itemId must be a valid UUID' });
    }

    const restaurant_id = actor.restaurantId;

    try {
      const currentResult = await pool.query(
        `SELECT id,
                restaurant_id,
                category_id,
                name,
                price_cents,
                tax_rate_bps,
                active,
                available
         FROM menu_items
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [itemId, restaurant_id]
      );

      if (currentResult.rowCount === 0) {
        return res.status(404).json({ error: 'Menu item not found' });
      }

      const current = currentResult.rows[0];

      const category_id = req.body.category_id === undefined
        ? current.category_id
        : req.body.category_id === null
          ? null
          : String(req.body.category_id || '').trim();

      const name = req.body.name === undefined
        ? current.name
        : String(req.body.name || '').trim();

      const price_cents = req.body.price_cents === undefined
        ? current.price_cents
        : Number(req.body.price_cents);

      const tax_rate_bps = req.body.tax_rate_bps === undefined
        ? current.tax_rate_bps
        : Number(req.body.tax_rate_bps);

      const active = req.body.active === undefined ? current.active : req.body.active;
      const available = req.body.available === undefined ? current.available : req.body.available;

      if (category_id !== null && !isUuid(category_id)) {
        return res.status(400).json({ error: 'category_id must be a valid UUID or null' });
      }

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!Number.isInteger(price_cents) || price_cents < 0) {
        return res.status(400).json({ error: 'price_cents must be an integer greater than or equal to 0' });
      }

      if (!Number.isInteger(tax_rate_bps) || tax_rate_bps < 0) {
        return res.status(400).json({ error: 'tax_rate_bps must be an integer greater than or equal to 0' });
      }

      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be boolean' });
      }

      if (typeof available !== 'boolean') {
        return res.status(400).json({ error: 'available must be boolean' });
      }

      if (category_id !== null) {
        const category = await pool.query(
          `SELECT id
           FROM menu_categories
           WHERE id = $1
             AND restaurant_id = $2
           LIMIT 1`,
          [category_id, restaurant_id]
        );

        if (category.rowCount === 0) {
          return res.status(400).json({ error: 'category_id must belong to the same restaurant' });
        }
      }

      const duplicate = category_id === null
        ? await pool.query(
            `SELECT id
             FROM menu_items
             WHERE restaurant_id = $1
               AND category_id IS NULL
               AND LOWER(name) = LOWER($2)
               AND id <> $3
             LIMIT 1`,
            [restaurant_id, name, itemId]
          )
        : await pool.query(
            `SELECT id
             FROM menu_items
             WHERE restaurant_id = $1
               AND category_id = $2
               AND LOWER(name) = LOWER($3)
               AND id <> $4
             LIMIT 1`,
            [restaurant_id, category_id, name, itemId]
          );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Item already exists in this category' });
      }

      await pool.query(
        `UPDATE menu_items
         SET category_id = $1,
             name = $2,
             price_cents = $3,
             tax_rate_bps = $4,
             active = $5,
             available = $6
         WHERE id = $7
           AND restaurant_id = $8`,
        [category_id, name, price_cents, tax_rate_bps, active, available, itemId, restaurant_id]
      );

      const updated = await pool.query(
        `SELECT mi.id,
                mi.restaurant_id,
                mi.category_id,
                mc.name AS category_name,
                mc.menu_type,
                mi.name,
                mi.price_cents,
                mi.tax_rate_bps,
                mi.active,
                mi.available
         FROM menu_items mi
         LEFT JOIN menu_categories mc ON mc.id = mi.category_id
         WHERE mi.id = $1
           AND mi.restaurant_id = $2
         LIMIT 1`,
        [itemId, restaurant_id]
      );

      return res.json({ item: updated.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Item already exists in this category' });
      }
      return sendMenuError(req, res, err, 'MENU_ITEM_UPDATE_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [GET] /menu/modifier-groups?restaurant_id=<uuid> - Get modifier groups for a restaurant
  router.get('/modifier-groups', async (req, res) => {
    const restaurant_id = String(req.query.restaurant_id || '').trim();

    if (!restaurant_id) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }

    if (!isUuid(restaurant_id)) {
      return res.status(400).json({ error: 'restaurant_id must be a valid UUID' });
    }

    try {
      const result = await pool.query(
        `SELECT id,
                restaurant_id,
                name,
                min_select,
                max_select,
                required,
                sort_order,
                active
         FROM modifier_groups
         WHERE restaurant_id = $1
           AND active = true
         ORDER BY sort_order ASC, name ASC`,
        [restaurant_id]
      );

      return res.json({ modifier_groups: result.rows });
    } catch (err) {
      handleError(req, res, 'MENU_MODIFIER_GROUPS_READ_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [PATCH] /menu/modifier-groups/:groupId - Update a modifier group in modifier_groups
  
  // Phase 40E — Authenticated management modifier-group read, including inactive records
  router.get('/manage/modifier-groups', verifyToken, async (req, res) => {
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_MODIFIER_GROUPS_READ_FAILED');
    }

    try {
      const result = await pool.query(
        `SELECT id,
                restaurant_id,
                name,
                min_select,
                max_select,
                required,
                sort_order,
                active
         FROM modifier_groups
         WHERE restaurant_id = $1
         ORDER BY sort_order ASC, name ASC`,
        [actor.restaurantId]
      );

      return res.json({ modifier_groups: result.rows });
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_MODIFIER_GROUPS_READ_FAILED');
    }
  });

  // Phase 41B — Create modifier group
  router.post('/modifier-groups', verifyToken, async (req, res) => {
    try {
      const actor = await resolveMenuManager(pool, req);
      const restaurant_id = actor.restaurantId;

      const name = String(req.body.name || '').trim();
      const min_select = req.body.min_select === undefined ? 0 : Number(req.body.min_select);
      const max_select = req.body.max_select === undefined ? 1 : Number(req.body.max_select);
      const sort_order = req.body.sort_order === undefined ? 0 : Number(req.body.sort_order);
      const active = req.body.active === undefined ? true : req.body.active;
      const required = min_select > 0;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!Number.isInteger(min_select) || min_select < 0) {
        return res.status(400).json({ error: 'min_select must be an integer greater than or equal to 0' });
      }

      if (!Number.isInteger(max_select) || max_select < 0) {
        return res.status(400).json({ error: 'max_select must be an integer greater than or equal to 0' });
      }

      if (max_select < min_select) {
        return res.status(400).json({ error: 'max_select must be greater than or equal to min_select' });
      }

      if (!Number.isInteger(sort_order)) {
        return res.status(400).json({ error: 'sort_order must be an integer' });
      }

      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be boolean' });
      }

      const duplicate = await pool.query(
        `SELECT id
         FROM modifier_groups
         WHERE restaurant_id = $1
           AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [restaurant_id, name]
      );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Modifier group already exists' });
      }

      const result = await pool.query(
        `INSERT INTO modifier_groups (
           restaurant_id,
           name,
           min_select,
           max_select,
           required,
           sort_order,
           active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id,
                   restaurant_id,
                   name,
                   min_select,
                   max_select,
                   required,
                   sort_order,
                   active`,
        [restaurant_id, name, min_select, max_select, required, sort_order, active]
      );

      return res.status(201).json({ modifier_group: result.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Modifier group already exists' });
      }
      return sendMenuError(req, res, err, 'MENU_MODIFIER_GROUP_CREATE_FAILED');
    }
  });

  router.patch('/modifier-groups/:groupId', verifyToken, async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    let actor;

    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MODIFIER_GROUP_UPDATE_FAILED');
    }

    if (!isUuid(groupId)) {
      return res.status(400).json({ error: 'groupId must be a valid UUID' });
    }

    const restaurant_id = actor.restaurantId;

    try {
      const currentResult = await pool.query(
        `SELECT id,
                restaurant_id,
                name,
                min_select,
                max_select,
                required,
                sort_order,
                active
         FROM modifier_groups
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [groupId, restaurant_id]
      );

      if (currentResult.rowCount === 0) {
        return res.status(404).json({ error: 'Modifier group not found' });
      }

      const current = currentResult.rows[0];
      const name = req.body.name === undefined ? current.name : String(req.body.name || '').trim();
      const min_select = req.body.min_select === undefined ? current.min_select : Number(req.body.min_select);
      const max_select = req.body.max_select === undefined ? current.max_select : Number(req.body.max_select);
      const sort_order = req.body.sort_order === undefined ? current.sort_order : Number(req.body.sort_order);
      const active = req.body.active === undefined ? current.active : req.body.active;
      const required = min_select > 0;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!Number.isInteger(min_select) || min_select < 0) {
        return res.status(400).json({ error: 'min_select must be an integer greater than or equal to 0' });
      }

      if (!Number.isInteger(max_select) || max_select < 0) {
        return res.status(400).json({ error: 'max_select must be an integer greater than or equal to 0' });
      }

      if (max_select < min_select) {
        return res.status(400).json({ error: 'max_select must be greater than or equal to min_select' });
      }

      if (!Number.isInteger(sort_order)) {
        return res.status(400).json({ error: 'sort_order must be an integer' });
      }

      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be boolean' });
      }

      const duplicate = await pool.query(
        `SELECT id
         FROM modifier_groups
         WHERE restaurant_id = $1
           AND LOWER(name) = LOWER($2)
           AND id <> $3
         LIMIT 1`,
        [restaurant_id, name, groupId]
      );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Modifier group already exists' });
      }

      const result = await pool.query(
        `UPDATE modifier_groups
         SET name = $1,
             min_select = $2,
             max_select = $3,
             required = $4,
             sort_order = $5,
             active = $6
         WHERE id = $7
           AND restaurant_id = $8
         RETURNING id,
                   restaurant_id,
                   name,
                   min_select,
                   max_select,
                   required,
                   sort_order,
                   active`,
        [name, min_select, max_select, required, sort_order, active, groupId, restaurant_id]
      );

      return res.json({ modifier_group: result.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Modifier group already exists' });
      }
      return sendMenuError(req, res, err, 'MENU_MODIFIER_GROUP_UPDATE_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [GET] /menu/modifier-options?restaurant_id=<uuid> - Get modifier options for a restaurant
  router.get('/modifier-options', async (req, res) => {
    const restaurant_id = String(req.query.restaurant_id || '').trim();

    if (!restaurant_id) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }

    if (!isUuid(restaurant_id)) {
      return res.status(400).json({ error: 'restaurant_id must be a valid UUID' });
    }

    try {
      const result = await pool.query(
        `SELECT mo.id,
                mo.group_id,
                mg.name AS group_name,
                mo.name,
                mo.price_delta_cents,
                mo.sort_order,
                mo.active
         FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
         WHERE mg.restaurant_id = $1
           AND mg.active = true
           AND mo.active = true
         ORDER BY mg.sort_order ASC, mg.name ASC, mo.sort_order ASC, mo.name ASC`,
        [restaurant_id]
      );

      return res.json({ modifier_options: result.rows });
    } catch (err) {
      handleError(req, res, 'MENU_MODIFIER_OPTIONS_READ_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [POST] /menu/modifier-options - Create a modifier option in modifier_options
  
  // Phase 40E — Authenticated management modifier-option read, including inactive records
  router.get('/manage/modifier-options', verifyToken, async (req, res) => {
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_MODIFIER_OPTIONS_READ_FAILED');
    }

    try {
      const result = await pool.query(
        `SELECT mo.id,
                mo.group_id,
                mg.name AS group_name,
                mo.name,
                mo.price_delta_cents,
                mo.sort_order,
                mo.active
         FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
         WHERE mg.restaurant_id = $1
         ORDER BY mg.sort_order ASC,
                  mg.name ASC,
                  mo.sort_order ASC,
                  mo.name ASC`,
        [actor.restaurantId]
      );

      return res.json({ modifier_options: result.rows });
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_MODIFIER_OPTIONS_READ_FAILED');
    }
  });

  router.post('/modifier-options', verifyToken, async (req, res) => {
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MODIFIER_OPTION_CREATE_FAILED');
    }

    const restaurant_id = actor.restaurantId;
    const group_id = String(req.body.group_id || '').trim();
    const name = String(req.body.name || '').trim();
    const priceDeltaValue = req.body.price_delta_cents ?? 0;
    const sortOrderValue = req.body.sort_order ?? 0;
    const price_delta_cents = Number(priceDeltaValue);
    const sort_order = Number(sortOrderValue);
    const active = typeof req.body.active === 'boolean' ? req.body.active : true;

    if (!group_id) {
      return res.status(400).json({ error: 'group_id is required' });
    }

    if (!isUuid(group_id)) {
      return res.status(400).json({ error: 'group_id must be a valid UUID' });
    }

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (!Number.isInteger(price_delta_cents) || price_delta_cents < 0) {
      return res.status(400).json({ error: 'price_delta_cents must be an integer greater than or equal to 0' });
    }

    if (!Number.isInteger(sort_order)) {
      return res.status(400).json({ error: 'sort_order must be an integer' });
    }

    try {
      const group = await pool.query(
        `SELECT id
         FROM modifier_groups
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [group_id, restaurant_id]
      );

      if (group.rowCount === 0) {
        return res.status(400).json({ error: 'group_id must belong to the same restaurant' });
      }

      const duplicate = await pool.query(
        `SELECT id
         FROM modifier_options
         WHERE group_id = $1
           AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [group_id, name]
      );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Modifier option already exists in this group' });
      }

      const created = await pool.query(
        `INSERT INTO modifier_options (group_id, name, price_delta_cents, sort_order, active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id,
                   group_id,
                   name,
                   price_delta_cents,
                   sort_order,
                   active`,
        [group_id, name, price_delta_cents, sort_order, active]
      );

      const result = await pool.query(
        `SELECT mo.id,
                mo.group_id,
                mg.name AS group_name,
                mo.name,
                mo.price_delta_cents,
                mo.sort_order,
                mo.active
         FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
         WHERE mo.id = $1
           AND mg.restaurant_id = $2
         LIMIT 1`,
        [created.rows[0].id, restaurant_id]
      );

      return res.status(201).json({ modifier_option: result.rows[0] || created.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Modifier option already exists in this group' });
      }
      return sendMenuError(req, res, err, 'MENU_MODIFIER_OPTION_CREATE_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [PATCH] /menu/modifier-options/:optionId - Update a modifier option in modifier_options
  router.patch('/modifier-options/:optionId', verifyToken, async (req, res) => {
    const optionId = String(req.params.optionId || '').trim();
    let actor;

    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MODIFIER_OPTION_UPDATE_FAILED');
    }

    if (!isUuid(optionId)) {
      return res.status(400).json({ error: 'optionId must be a valid UUID' });
    }

    const restaurant_id = actor.restaurantId;

    try {
      const currentResult = await pool.query(
        `SELECT mo.id,
                mo.group_id,
                mo.name,
                mo.price_delta_cents,
                mo.sort_order,
                mo.active
         FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
         WHERE mo.id = $1
           AND mg.restaurant_id = $2
         LIMIT 1`,
        [optionId, restaurant_id]
      );

      if (currentResult.rowCount === 0) {
        return res.status(404).json({ error: 'Modifier option not found' });
      }

      const current = currentResult.rows[0];
      const group_id = current.group_id;
      const name = req.body.name === undefined ? current.name : String(req.body.name || '').trim();
      const price_delta_cents = req.body.price_delta_cents === undefined
        ? current.price_delta_cents
        : Number(req.body.price_delta_cents);
      const sort_order = req.body.sort_order === undefined
        ? current.sort_order
        : Number(req.body.sort_order);
      const active = req.body.active === undefined ? current.active : req.body.active;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!Number.isInteger(price_delta_cents) || price_delta_cents < 0) {
        return res.status(400).json({ error: 'price_delta_cents must be an integer greater than or equal to 0' });
      }

      if (!Number.isInteger(sort_order)) {
        return res.status(400).json({ error: 'sort_order must be an integer' });
      }

      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be boolean' });
      }

      const duplicate = await pool.query(
        `SELECT id
         FROM modifier_options
         WHERE group_id = $1
           AND LOWER(name) = LOWER($2)
           AND id <> $3
         LIMIT 1`,
        [group_id, name, optionId]
      );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Modifier option already exists in this group' });
      }

      await pool.query(
        `UPDATE modifier_options
         SET name = $1,
             price_delta_cents = $2,
             sort_order = $3,
             active = $4
         WHERE id = $5`,
        [name, price_delta_cents, sort_order, active, optionId]
      );

      const updated = await pool.query(
        `SELECT mo.id,
                mo.group_id,
                mg.name AS group_name,
                mo.name,
                mo.price_delta_cents,
                mo.sort_order,
                mo.active
         FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
         WHERE mo.id = $1
           AND mg.restaurant_id = $2
         LIMIT 1`,
        [optionId, restaurant_id]
      );

      return res.json({ modifier_option: updated.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Modifier option already exists in this group' });
      }
      return sendMenuError(req, res, err, 'MENU_MODIFIER_OPTION_UPDATE_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [GET] /menu/items/:itemId/modifier-groups?restaurant_id=<uuid> - Get modifier groups linked to a menu item
  router.get('/items/:itemId/modifier-groups', async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    const restaurant_id = String(req.query.restaurant_id || '').trim();

    if (!itemId) {
      return res.status(400).json({ error: 'itemId is required' });
    }

    if (!isUuid(itemId)) {
      return res.status(400).json({ error: 'itemId must be a valid UUID' });
    }

    if (!restaurant_id) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }

    if (!isUuid(restaurant_id)) {
      return res.status(400).json({ error: 'restaurant_id must be a valid UUID' });
    }

    try {
      const item = await pool.query(
        `SELECT id
         FROM menu_items
         WHERE id = $1
           AND restaurant_id = $2
           AND active = true
         LIMIT 1`,
        [itemId, restaurant_id]
      );

      if (item.rowCount === 0) {
        return res.status(404).json({ error: 'Menu item not found' });
      }

      const groups = await pool.query(
        `SELECT mg.id,
                mimg.menu_item_id,
                mg.restaurant_id,
                mg.name,
                mg.min_select,
                mg.max_select,
                mg.required,
                COALESCE(mimg.sort_order, mg.sort_order) AS sort_order,
                mg.active
         FROM menu_item_modifier_groups mimg
         JOIN modifier_groups mg ON mg.id = mimg.group_id
         WHERE mimg.menu_item_id = $1
           AND mg.restaurant_id = $2
           AND mg.active = true
         ORDER BY COALESCE(mimg.sort_order, mg.sort_order) ASC, mg.name ASC`,
        [itemId, restaurant_id]
      );

      const options = await pool.query(
        `SELECT mo.id,
                mo.group_id,
                mo.name,
                mo.price_delta_cents,
                mo.sort_order,
                mo.active
         FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
         JOIN menu_item_modifier_groups mimg ON mimg.group_id = mg.id
         WHERE mimg.menu_item_id = $1
           AND mg.restaurant_id = $2
           AND mg.active = true
           AND mo.active = true
         ORDER BY mo.sort_order ASC, mo.name ASC`,
        [itemId, restaurant_id]
      );

      const modifierGroups = groups.rows.map((group) => ({
        ...group,
        options: options.rows.filter((option) => option.group_id === group.id),
      }));

      return res.json({ modifier_groups: modifierGroups });
    } catch (err) {
      handleError(req, res, 'MENU_ITEM_MODIFIER_GROUPS_READ_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [POST] /menu/items/:itemId/modifier-groups - Link a modifier group to a menu item
  
  // Phase 40E — Authenticated management item/modifier-group relationship read
  router.get('/manage/items/:itemId/modifier-groups', verifyToken, async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    let actor;

    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_ITEM_MODIFIER_GROUPS_READ_FAILED');
    }

    if (!isUuid(itemId)) {
      return res.status(400).json({ error: 'itemId must be a valid UUID' });
    }

    const restaurant_id = actor.restaurantId;

    try {
      const item = await pool.query(
        `SELECT id
         FROM menu_items
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [itemId, restaurant_id]
      );

      if (item.rowCount === 0) {
        return res.status(404).json({ error: 'Menu item not found' });
      }

      const groups = await pool.query(
        `SELECT mg.id,
                mimg.menu_item_id,
                mg.restaurant_id,
                mg.name,
                mg.min_select,
                mg.max_select,
                mg.required,
                COALESCE(mimg.sort_order, mg.sort_order) AS sort_order,
                mg.active
         FROM menu_item_modifier_groups mimg
         JOIN modifier_groups mg ON mg.id = mimg.group_id
         WHERE mimg.menu_item_id = $1
           AND mg.restaurant_id = $2
         ORDER BY COALESCE(mimg.sort_order, mg.sort_order) ASC,
                  mg.name ASC`,
        [itemId, restaurant_id]
      );

      const options = await pool.query(
        `SELECT mo.id,
                mo.group_id,
                mo.name,
                mo.price_delta_cents,
                mo.sort_order,
                mo.active
         FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
         JOIN menu_item_modifier_groups mimg ON mimg.group_id = mg.id
         WHERE mimg.menu_item_id = $1
           AND mg.restaurant_id = $2
         ORDER BY mo.sort_order ASC, mo.name ASC`,
        [itemId, restaurant_id]
      );

      const modifierGroups = groups.rows.map((group) => ({
        ...group,
        options: options.rows.filter((option) => option.group_id === group.id),
      }));

      return res.json({ modifier_groups: modifierGroups });
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_MANAGE_ITEM_MODIFIER_GROUPS_READ_FAILED');
    }
  });

  router.post('/items/:itemId/modifier-groups', verifyToken, async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_ITEM_MODIFIER_GROUP_LINK_FAILED');
    }

    const restaurant_id = actor.restaurantId;
    const group_id = String(req.body.group_id || '').trim();
    const sortOrderValue = req.body.sort_order ?? 0;
    const sort_order = Number(sortOrderValue);

    if (!itemId) {
      return res.status(400).json({ error: 'itemId is required' });
    }

    if (!isUuid(itemId)) {
      return res.status(400).json({ error: 'itemId must be a valid UUID' });
    }

    if (!group_id) {
      return res.status(400).json({ error: 'group_id is required' });
    }

    if (!isUuid(group_id)) {
      return res.status(400).json({ error: 'group_id must be a valid UUID' });
    }

    if (!Number.isInteger(sort_order)) {
      return res.status(400).json({ error: 'sort_order must be an integer' });
    }

    try {
      const item = await pool.query(
        `SELECT id
         FROM menu_items
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [itemId, restaurant_id]
      );

      if (item.rowCount === 0) {
        return res.status(404).json({ error: 'Menu item not found' });
      }

      const group = await pool.query(
        `SELECT id
         FROM modifier_groups
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [group_id, restaurant_id]
      );

      if (group.rowCount === 0) {
        return res.status(400).json({ error: 'group_id must belong to the same restaurant' });
      }

      const duplicate = await pool.query(
        `SELECT menu_item_id,
                group_id
         FROM menu_item_modifier_groups
         WHERE menu_item_id = $1
           AND group_id = $2
         LIMIT 1`,
        [itemId, group_id]
      );

      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Modifier group is already linked to this item' });
      }

      const created = await pool.query(
        `INSERT INTO menu_item_modifier_groups (menu_item_id, group_id, sort_order)
         VALUES ($1, $2, $3)
         RETURNING menu_item_id,
                   group_id,
                   sort_order`,
        [itemId, group_id, sort_order]
      );

      const linked = await pool.query(
        `SELECT mimg.menu_item_id,
                mimg.group_id,
                mimg.sort_order,
                mg.restaurant_id,
                mg.name,
                mg.min_select,
                mg.max_select,
                mg.required,
                mg.active
         FROM menu_item_modifier_groups mimg
         JOIN modifier_groups mg ON mg.id = mimg.group_id
         WHERE mimg.menu_item_id = $1
           AND mimg.group_id = $2
           AND mg.restaurant_id = $3
         LIMIT 1`,
        [itemId, group_id, restaurant_id]
      );

      return res.status(201).json({ item_modifier_group: linked.rows[0] || created.rows[0] });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Modifier group is already linked to this item' });
      }
      return sendMenuError(req, res, err, 'MENU_ITEM_MODIFIER_GROUP_LINK_FAILED');
    }
  });

  // Phase 37B — Modifier infrastructure
  // [DELETE] /menu/items/:itemId/modifier-groups/:groupId - Unlink a modifier group from a menu item
  router.delete('/items/:itemId/modifier-groups/:groupId', verifyToken, async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    const groupId = String(req.params.groupId || '').trim();
    let actor;
    try {
      actor = await resolveMenuManager(pool, req);
    } catch (err) {
      return sendMenuError(req, res, err, 'MENU_ITEM_MODIFIER_GROUP_UNLINK_FAILED');
    }

    const restaurant_id = actor.restaurantId;

    if (!itemId) {
      return res.status(400).json({ error: 'itemId is required' });
    }

    if (!isUuid(itemId)) {
      return res.status(400).json({ error: 'itemId must be a valid UUID' });
    }

    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }

    if (!isUuid(groupId)) {
      return res.status(400).json({ error: 'groupId must be a valid UUID' });
    }

    try {
      const item = await pool.query(
        `SELECT id
         FROM menu_items
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [itemId, restaurant_id]
      );

      if (item.rowCount === 0) {
        return res.status(404).json({ error: 'Menu item not found' });
      }

      const group = await pool.query(
        `SELECT id
         FROM modifier_groups
         WHERE id = $1
           AND restaurant_id = $2
         LIMIT 1`,
        [groupId, restaurant_id]
      );

      if (group.rowCount === 0) {
        return res.status(400).json({ error: 'groupId must belong to the same restaurant' });
      }

      const result = await pool.query(
        `DELETE FROM menu_item_modifier_groups
         WHERE menu_item_id = $1
           AND group_id = $2
         RETURNING menu_item_id,
                   group_id,
                   sort_order`,
        [itemId, groupId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Modifier group link not found' });
      }

      return res.json({ unlinked_modifier_group: result.rows[0] });
    } catch (err) {
      sendMenuError(req, res, err, 'MENU_ITEM_MODIFIER_GROUP_UNLINK_FAILED');
    }
  });

  // [GET] /menu/:restaurant_id - Legacy menu table read disabled
  router.get('/:restaurant_id', async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu read route is disabled' });
  });

  // [POST] /menu - Add a menu item
  router.post('/', verifyToken, async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu mutation route is disabled' });
  });

  // [PUT] /menu/:id - Update a menu item
  router.put('/:id', verifyToken, async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu mutation route is disabled' });
  });

  // [DELETE] /menu/:id - Delete a menu item
  router.delete('/:id', verifyToken, async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu mutation route is disabled' });
  });

  // [GET] /menu/categories/all - Get distinct categories
  router.get('/categories/all', verifyToken, async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu read route is disabled' });
  });

  // [GET] /menu/popular/all - Get most popular menu items
  router.get('/popular/all', verifyToken, async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu read route is disabled' });
  });

  // [PATCH] /menu/:id/availability - Toggle menu item availability
  router.patch('/:id/availability', verifyToken, async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu mutation route is disabled' });
  });

  // [GET] /menu/:restaurant_id/search?q=keyword - Search menu items
  router.get('/:restaurant_id/search', async (req, res) => {
    return res.status(410).json({ error: 'Legacy menu search route is disabled' });
  });

  return router;
};
