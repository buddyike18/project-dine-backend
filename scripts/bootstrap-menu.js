'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

function required(name) {
  const value = process.env[name];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function asInteger(value, name, { min = null, max = null } = {}) {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }

  if (min !== null && value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }

  if (max !== null && value > max) {
    throw new Error(`${name} must be <= ${max}`);
  }

  return value;
}

function asName(value, name) {
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    throw new Error(`${name} is required`);
  }

  if (normalized.length > 200) {
    throw new Error(`${name} is too long`);
  }

  return normalized;
}

function parsePayload(raw) {
  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    const error = new Error(
      'BOOTSTRAP_MENU_JSON must contain valid JSON'
    );
    error.code = 'BOOTSTRAP_INVALID_MENU_JSON';
    throw error;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('BOOTSTRAP_MENU_JSON must contain an object');
  }

  const categories = Array.isArray(payload.categories)
    ? payload.categories
    : [];

  const items = Array.isArray(payload.items)
    ? payload.items
    : [];

  const modifierGroups = Array.isArray(payload.modifier_groups)
    ? payload.modifier_groups
    : [];

  if (categories.length === 0) {
    throw new Error('At least one menu category is required');
  }

  if (items.length === 0) {
    throw new Error('At least one menu item is required');
  }

  if (
    categories.length > 100 ||
    items.length > 1000 ||
    modifierGroups.length > 250
  ) {
    throw new Error('Bootstrap menu payload exceeds allowed limits');
  }

  const categoryKeys = new Set();
  const itemKeys = new Set();
  const groupKeys = new Set();

  const normalizedCategories = categories.map((entry, index) => {
    const key = asName(
      entry?.key,
      `categories[${index}].key`
    );

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw new Error(
        `categories[${index}].key must match ^[A-Za-z0-9_-]{1,64}$`
      );
    }

    if (categoryKeys.has(key)) {
      throw new Error(`Duplicate category key: ${key}`);
    }

    categoryKeys.add(key);

    return {
      key,
      name: asName(entry?.name, `categories[${index}].name`),
      sortOrder: asInteger(
        entry?.sort_order ?? 0,
        `categories[${index}].sort_order`
      ),
      active: entry?.active !== false,
    };
  });

  const normalizedGroups = modifierGroups.map((entry, index) => {
    const key = asName(
      entry?.key,
      `modifier_groups[${index}].key`
    );

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw new Error(
        `modifier_groups[${index}].key must match ^[A-Za-z0-9_-]{1,64}$`
      );
    }

    if (groupKeys.has(key)) {
      throw new Error(`Duplicate modifier group key: ${key}`);
    }

    groupKeys.add(key);

    const minSelect = asInteger(
      entry?.min_select ?? 0,
      `modifier_groups[${index}].min_select`,
      { min: 0 }
    );

    const maxSelect = asInteger(
      entry?.max_select ?? 1,
      `modifier_groups[${index}].max_select`,
      { min: 0 }
    );

    if (minSelect > maxSelect) {
      throw new Error(
        `modifier_groups[${index}] min_select cannot exceed max_select`
      );
    }

    const requiredValue = minSelect > 0;

    if (
      entry?.required !== undefined &&
      Boolean(entry.required) !== requiredValue
    ) {
      throw new Error(
        `modifier_groups[${index}].required must equal (min_select > 0)`
      );
    }

    const options = Array.isArray(entry?.options)
      ? entry.options
      : [];

    const optionNames = new Set();

    const normalizedOptions = options.map((option, optionIndex) => {
      const name = asName(
        option?.name,
        `modifier_groups[${index}].options[${optionIndex}].name`
      );

      if (optionNames.has(name)) {
        throw new Error(
          `Duplicate modifier option name "${name}" in group ${key}`
        );
      }

      optionNames.add(name);

      return {
        name,
        priceDeltaCents: asInteger(
          option?.price_delta_cents ?? 0,
          `modifier_groups[${index}].options[${optionIndex}].price_delta_cents`,
          { min: 0 }
        ),
        sortOrder: asInteger(
          option?.sort_order ?? optionIndex,
          `modifier_groups[${index}].options[${optionIndex}].sort_order`
        ),
        active: option?.active !== false,
      };
    });

    return {
      key,
      name: asName(
        entry?.name,
        `modifier_groups[${index}].name`
      ),
      minSelect,
      maxSelect,
      required: requiredValue,
      sortOrder: asInteger(
        entry?.sort_order ?? index,
        `modifier_groups[${index}].sort_order`
      ),
      active: entry?.active !== false,
      options: normalizedOptions,
    };
  });

  const normalizedItems = items.map((entry, index) => {
    const key = asName(entry?.key, `items[${index}].key`);

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw new Error(
        `items[${index}].key must match ^[A-Za-z0-9_-]{1,64}$`
      );
    }

    if (itemKeys.has(key)) {
      throw new Error(`Duplicate item key: ${key}`);
    }

    itemKeys.add(key);

    const categoryKey = asName(
      entry?.category_key,
      `items[${index}].category_key`
    );

    if (!categoryKeys.has(categoryKey)) {
      throw new Error(
        `items[${index}] references unknown category ${categoryKey}`
      );
    }

    const modifierGroupKeys = Array.isArray(
      entry?.modifier_group_keys
    )
      ? entry.modifier_group_keys.map(String)
      : [];

    for (const groupKey of modifierGroupKeys) {
      if (!groupKeys.has(groupKey)) {
        throw new Error(
          `items[${index}] references unknown modifier group ${groupKey}`
        );
      }
    }

    if (
      new Set(modifierGroupKeys).size !==
      modifierGroupKeys.length
    ) {
      throw new Error(
        `items[${index}] contains duplicate modifier group references`
      );
    }

    return {
      key,
      categoryKey,
      name: asName(entry?.name, `items[${index}].name`),
      priceCents: asInteger(
        entry?.price_cents,
        `items[${index}].price_cents`,
        { min: 0 }
      ),
      taxRateBps: asInteger(
        entry?.tax_rate_bps ?? 0,
        `items[${index}].tax_rate_bps`,
        { min: 0 }
      ),
      active: entry?.active !== false,
      available: entry?.available !== false,
      modifierGroupKeys,
    };
  });

  return {
    categories: normalizedCategories,
    items: normalizedItems,
    modifierGroups: normalizedGroups,
  };
}

function buildPool() {
  const databaseUrl = required('DATABASE_URL');

  let ssl = false;

  try {
    const hostname = new URL(databaseUrl).hostname;

    if (
      hostname &&
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1' &&
      !hostname.endsWith('.railway.internal')
    ) {
      ssl = { rejectUnauthorized: false };
    }
  } catch {
    throw new Error('DATABASE_URL is invalid');
  }

  return new Pool({
    connectionString: databaseUrl,
    ssl,
  });
}

async function main() {
  const configuredSecret = required('ADMIN_ROLE_SECRET');
  const suppliedSecret = required('BOOTSTRAP_ADMIN_ROLE_SECRET');
  const restaurantId = required('BOOTSTRAP_RESTAURANT_ID');
  const menu = parsePayload(required('BOOTSTRAP_MENU_JSON'));

  if (!secureEqual(configuredSecret, suppliedSecret)) {
    const error = new Error('Bootstrap authorization failed');
    error.code = 'BOOTSTRAP_UNAUTHORIZED';
    throw error;
  }

  if (!isUuid(restaurantId)) {
    const error = new Error(
      'BOOTSTRAP_RESTAURANT_ID must be a valid UUID'
    );
    error.code = 'BOOTSTRAP_INVALID_RESTAURANT_ID';
    throw error;
  }

  const pool = buildPool();

  let client;
  let committed = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const restaurantResult = await client.query(
      `
        SELECT id
        FROM public.restaurants
        WHERE id = $1
          AND active = true
        FOR UPDATE
      `,
      [restaurantId]
    );

    if (restaurantResult.rowCount !== 1) {
      const error = new Error(
        'Bootstrap refused: active restaurant not found'
      );
      error.code = 'BOOTSTRAP_RESTAURANT_NOT_FOUND';
      throw error;
    }

    await client.query(
      'LOCK TABLE public.menu_categories IN EXCLUSIVE MODE'
    );

    await client.query(
      'LOCK TABLE public.menu_items IN EXCLUSIVE MODE'
    );

    await client.query(
      'LOCK TABLE public.modifier_groups IN EXCLUSIVE MODE'
    );

    await client.query(
      'LOCK TABLE public.modifier_options IN EXCLUSIVE MODE'
    );

    await client.query(
      'LOCK TABLE public.menu_item_modifier_groups IN EXCLUSIVE MODE'
    );

    /*
     * This is intentionally a one-time initial bootstrap.
     * Refuse to overwrite, merge, or silently alter an existing menu.
     */
    const existingResult = await client.query(
      `
        SELECT
          (
            SELECT count(*)
            FROM public.menu_categories
            WHERE restaurant_id = $1
          )::int AS categories,
          (
            SELECT count(*)
            FROM public.menu_items
            WHERE restaurant_id = $1
          )::int AS items,
          (
            SELECT count(*)
            FROM public.modifier_groups
            WHERE restaurant_id = $1
          )::int AS modifier_groups,
          (
            SELECT count(*)
            FROM public.modifier_options mo
            JOIN public.modifier_groups mg
              ON mg.id = mo.group_id
            WHERE mg.restaurant_id = $1
          )::int AS modifier_options,
          (
            SELECT count(*)
            FROM public.menu_item_modifier_groups mimg
            JOIN public.menu_items mi
              ON mi.id = mimg.menu_item_id
            WHERE mi.restaurant_id = $1
          )::int AS item_group_links
      `,
      [restaurantId]
    );

    const existing = existingResult.rows[0];

    if (
      existing.categories > 0 ||
      existing.items > 0 ||
      existing.modifier_groups > 0 ||
      existing.modifier_options > 0 ||
      existing.item_group_links > 0
    ) {
      const error = new Error(
        'Bootstrap refused: restaurant already has menu data'
      );
      error.code = 'BOOTSTRAP_MENU_ALREADY_EXISTS';
      throw error;
    }

    const categoryIds = new Map();

    for (const category of menu.categories) {
      const result = await client.query(
        `
          INSERT INTO public.menu_categories (
            restaurant_id,
            name,
            sort_order,
            active
          )
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `,
        [
          restaurantId,
          category.name,
          category.sortOrder,
          category.active,
        ]
      );

      categoryIds.set(category.key, result.rows[0].id);
    }

    const groupIds = new Map();

    for (const group of menu.modifierGroups) {
      const result = await client.query(
        `
          INSERT INTO public.modifier_groups (
            restaurant_id,
            name,
            min_select,
            max_select,
            required,
            sort_order,
            active
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `,
        [
          restaurantId,
          group.name,
          group.minSelect,
          group.maxSelect,
          group.required,
          group.sortOrder,
          group.active,
        ]
      );

      const groupId = result.rows[0].id;
      groupIds.set(group.key, groupId);

      for (const option of group.options) {
        await client.query(
          `
            INSERT INTO public.modifier_options (
              group_id,
              name,
              price_delta_cents,
              sort_order,
              active
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            groupId,
            option.name,
            option.priceDeltaCents,
            option.sortOrder,
            option.active,
          ]
        );
      }
    }

    const itemIds = new Map();

    for (const item of menu.items) {
      const categoryId = categoryIds.get(item.categoryKey);

      const result = await client.query(
        `
          INSERT INTO public.menu_items (
            restaurant_id,
            category_id,
            name,
            price_cents,
            tax_rate_bps,
            active,
            available
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `,
        [
          restaurantId,
          categoryId,
          item.name,
          item.priceCents,
          item.taxRateBps,
          item.active,
          item.available,
        ]
      );

      itemIds.set(item.key, result.rows[0].id);
    }

    for (const item of menu.items) {
      const itemId = itemIds.get(item.key);

      for (
        let index = 0;
        index < item.modifierGroupKeys.length;
        index += 1
      ) {
        const groupKey = item.modifierGroupKeys[index];
        const groupId = groupIds.get(groupKey);

        await client.query(
          `
            INSERT INTO public.menu_item_modifier_groups (
              menu_item_id,
              group_id,
              sort_order
            )
            VALUES ($1, $2, $3)
          `,
          [
            itemId,
            groupId,
            index,
          ]
        );
      }
    }

    await client.query('COMMIT');
    committed = true;

    console.log('Initial restaurant menu bootstrap succeeded.');
    console.log({
      restaurant_id: restaurantId,
      categories: menu.categories.length,
      items: menu.items.length,
      modifier_groups: menu.modifierGroups.length,
      modifier_options: menu.modifierGroups.reduce(
        (sum, group) => sum + group.options.length,
        0
      ),
      item_group_links: menu.items.reduce(
        (sum, item) =>
          sum + item.modifierGroupKeys.length,
        0
      ),
    });
  } catch (error) {
    if (client && !committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Database rollback failed:', {
          code: rollbackError?.code || null,
          message:
            rollbackError?.message ||
            'Unknown rollback failure',
        });
      }
    }

    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Initial restaurant menu bootstrap failed:', {
    code: error?.code || null,
    message: error?.message || 'Unknown bootstrap failure',
  });

  process.exit(1);
});
