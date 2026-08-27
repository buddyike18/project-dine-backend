'use strict';

require('dotenv').config();

const { Pool } = require('pg');

const RESTAURANT_ID =
  process.env.STATS_RESTAURANT_ID ||
  'e777e6b5-4b3e-48f9-b84b-486a804b27de';

const APPLY = process.argv.includes('--apply');

const confirmRestaurantArg =
  process.argv.find(
    (arg) =>
      arg.startsWith(
        '--confirm-restaurant='
      )
  );

const CONFIRMED_RESTAURANT_ID =
  confirmRestaurantArg
    ? confirmRestaurantArg
        .slice(
          '--confirm-restaurant='.length
        )
        .trim()
    : '';

function assertApplyGuard() {
  if (!APPLY) {
    return;
  }

  if (
    !process.env.STATS_RESTAURANT_ID
  ) {
    throw new Error(
      'APPLY_GUARD_FAILED: STATS_RESTAURANT_ID must be explicitly set'
    );
  }

  if (
    !CONFIRMED_RESTAURANT_ID
  ) {
    throw new Error(
      'APPLY_GUARD_FAILED: --confirm-restaurant=<uuid> is required'
    );
  }

  if (
    CONFIRMED_RESTAURANT_ID !==
    RESTAURANT_ID
  ) {
    throw new Error(
      'APPLY_GUARD_FAILED: --confirm-restaurant does not match STATS_RESTAURANT_ID'
    );
  }
}

/*
 * Provisioning data only.
 *
 * This file is a backend data-import mechanism. None of this menu
 * content is consumed directly by dine-customer or another client.
 *
 * The first pass intentionally contains only records already proven
 * in production. The complete official food-menu dataset will be
 * added after the importer engine itself passes review.
 */
const MENU = require('./data/stats-food-menu');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function printAction(action, type, name, details = '') {
  const suffix = details ? ` | ${details}` : '';
  console.log(
    `${action.padEnd(10)} ${type.padEnd(18)} ${name}${suffix}`
  );
}


async function loadMenuState(
  client,
  restaurantId
) {
  const categories =
    await client.query(
      `
        SELECT *
        FROM public.menu_categories
        WHERE restaurant_id = $1
      `,
      [restaurantId]
    );

  const items =
    await client.query(
      `
        SELECT *
        FROM public.menu_items
        WHERE restaurant_id = $1
      `,
      [restaurantId]
    );

  const groups =
    await client.query(
      `
        SELECT *
        FROM public.modifier_groups
        WHERE restaurant_id = $1
      `,
      [restaurantId]
    );

  const options =
    await client.query(
      `
        SELECT mo.*
        FROM public.modifier_options mo
        JOIN public.modifier_groups mg
          ON mg.id = mo.group_id
        WHERE mg.restaurant_id = $1
      `,
      [restaurantId]
    );

  const links =
    await client.query(
      `
        SELECT
          rel.menu_item_id,
          rel.group_id,
          rel.sort_order
        FROM public.menu_item_modifier_groups rel
        JOIN public.menu_items mi
          ON mi.id = rel.menu_item_id
        WHERE mi.restaurant_id = $1
      `,
      [restaurantId]
    );

  return {
    categories: categories.rows,
    items: items.rows,
    groups: groups.rows,
    options: options.rows,
    links: links.rows,
  };
}

function findCategory(
  state,
  name
) {
  return state.categories.find(
    (row) =>
      normalize(row.name) ===
      normalize(name)
  );
}

function findItem(
  state,
  categoryId,
  name
) {
  return state.items.find(
    (row) =>
      row.category_id === categoryId &&
      normalize(row.name) ===
        normalize(name)
  );
}

function findGroup(
  state,
  name
) {
  return state.groups.find(
    (row) =>
      normalize(row.name) ===
      normalize(name)
  );
}

function findOption(
  state,
  groupId,
  desired
) {
  const acceptedNames =
    new Set(
      [
        desired.name,
        ...(desired.aliases || []),
      ].map(normalize)
    );

  return state.options.find(
    (row) =>
      row.group_id === groupId &&
      acceptedNames.has(
        normalize(row.name)
      )
  );
}

async function resolveNewItemTaxRateBps(
  client,
  restaurantId
) {
  const result =
    await client.query(
      `
        SELECT DISTINCT
          tax_rate_bps
        FROM public.menu_items
        WHERE restaurant_id = $1
          AND active = TRUE
          AND tax_rate_bps IS NOT NULL
        ORDER BY tax_rate_bps
      `,
      [restaurantId]
    );

  if (result.rowCount !== 1) {
    throw new Error(
      `NEW_ITEM_TAX_RATE_UNRESOLVED: expected exactly one active tax rate, found ${result.rowCount}`
    );
  }

  const taxRateBps =
    Number(
      result.rows[0]
        .tax_rate_bps
    );

  if (
    !Number.isInteger(
      taxRateBps
    ) ||
    taxRateBps < 0
  ) {
    throw new Error(
      'NEW_ITEM_TAX_RATE_INVALID'
    );
  }

  return taxRateBps;
}

async function applyCategories(
  client,
  restaurantId
) {
  let state =
    await loadMenuState(
      client,
      restaurantId
    );

  for (
    const desired
    of MENU.categories
  ) {
    const existing =
      findCategory(
        state,
        desired.name
      );

    if (existing) {
      await client.query(
        `
          UPDATE public.menu_categories
          SET
            name = $1,
            sort_order = $2,
            active = TRUE
          WHERE id = $3
            AND restaurant_id = $4
        `,
        [
          desired.name,
          desired.sortOrder,
          existing.id,
          restaurantId,
        ]
      );

      continue;
    }

    await client.query(
      `
        INSERT INTO public.menu_categories (
          restaurant_id,
          name,
          sort_order,
          active
        )
        VALUES ($1, $2, $3, TRUE)
      `,
      [
        restaurantId,
        desired.name,
        desired.sortOrder,
      ]
    );

    state =
      await loadMenuState(
        client,
        restaurantId
      );
  }
}

async function applyItems(
  client,
  restaurantId
) {
  let state =
    await loadMenuState(
      client,
      restaurantId
    );

  const newItemTaxRateBps =
    await resolveNewItemTaxRateBps(
      client,
      restaurantId
    );

  for (
    const desired
    of MENU.items
  ) {
    const category =
      findCategory(
        state,
        desired.category
      );

    if (!category) {
      throw new Error(
        `APPLY_CATEGORY_NOT_FOUND: ${desired.category}`
      );
    }

    const existing =
      findItem(
        state,
        category.id,
        desired.name
      );

    if (existing) {
      await client.query(
        `
          UPDATE public.menu_items
          SET
            category_id = $1,
            name = $2,
            price_cents = $3,
            tax_rate_bps = $4,
            active = $5,
            available = $6
          WHERE id = $7
            AND restaurant_id = $8
        `,
        [
          category.id,
          desired.name,
          desired.priceCents,
          existing.tax_rate_bps,
          desired.active,
          desired.available,
          existing.id,
          restaurantId,
        ]
      );

      continue;
    }

    await client.query(
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
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7
        )
      `,
      [
        restaurantId,
        category.id,
        desired.name,
        desired.priceCents,
        newItemTaxRateBps,
        desired.active,
        desired.available,
      ]
    );

    state =
      await loadMenuState(
        client,
        restaurantId
      );
  }
}

async function applyModifierGroups(
  client,
  restaurantId
) {
  let state =
    await loadMenuState(
      client,
      restaurantId
    );

  for (
    let index = 0;
    index <
      MENU.modifierGroups.length;
    index += 1
  ) {
    const desired =
      MENU.modifierGroups[
        index
      ];

    const sortOrder =
      index + 1;

    const existing =
      findGroup(
        state,
        desired.name
      );

    if (existing) {
      await client.query(
        `
          UPDATE public.modifier_groups
          SET
            name = $1,
            min_select = $2,
            max_select = $3,
            required = $4,
            sort_order = $5,
            active = TRUE
          WHERE id = $6
            AND restaurant_id = $7
        `,
        [
          desired.name,
          desired.minSelect,
          desired.maxSelect,
          desired.required,
          sortOrder,
          existing.id,
          restaurantId,
        ]
      );

      continue;
    }

    await client.query(
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
        VALUES (
          $1, $2, $3, $4,
          $5, $6, TRUE
        )
      `,
      [
        restaurantId,
        desired.name,
        desired.minSelect,
        desired.maxSelect,
        desired.required,
        sortOrder,
      ]
    );

    state =
      await loadMenuState(
        client,
        restaurantId
      );
  }
}

async function applyModifierOptions(
  client,
  restaurantId
) {
  let state =
    await loadMenuState(
      client,
      restaurantId
    );

  for (
    const desiredGroup
    of MENU.modifierGroups
  ) {
    const group =
      findGroup(
        state,
        desiredGroup.name
      );

    if (!group) {
      throw new Error(
        `APPLY_GROUP_NOT_FOUND: ${desiredGroup.name}`
      );
    }

    for (
      const desiredOption
      of desiredGroup.options
    ) {
      const existing =
        findOption(
          state,
          group.id,
          desiredOption
        );

      if (existing) {
        await client.query(
          `
            UPDATE public.modifier_options
            SET
              name = $1,
              price_delta_cents = $2,
              sort_order = $3,
              active = TRUE
            WHERE id = $4
              AND group_id = $5
          `,
          [
            desiredOption.name,
            desiredOption
              .priceDeltaCents,
            desiredOption.sortOrder,
            existing.id,
            group.id,
          ]
        );

        continue;
      }

      await client.query(
        `
          INSERT INTO public.modifier_options (
            group_id,
            name,
            price_delta_cents,
            sort_order,
            active
          )
          VALUES (
            $1, $2, $3, $4, TRUE
          )
        `,
        [
          group.id,
          desiredOption.name,
          desiredOption
            .priceDeltaCents,
          desiredOption.sortOrder,
        ]
      );

      state =
        await loadMenuState(
          client,
          restaurantId
        );
    }
  }
}

async function applyItemGroupLinks(
  client,
  restaurantId
) {
  let state =
    await loadMenuState(
      client,
      restaurantId
    );

  for (
    const desiredItem
    of MENU.items
  ) {
    const category =
      findCategory(
        state,
        desiredItem.category
      );

    if (!category) {
      throw new Error(
        `LINK_CATEGORY_NOT_FOUND: ${desiredItem.category}`
      );
    }

    const item =
      findItem(
        state,
        category.id,
        desiredItem.name
      );

    if (!item) {
      throw new Error(
        `LINK_ITEM_NOT_FOUND: ${desiredItem.name}`
      );
    }

    for (
      let index = 0;
      index <
        desiredItem
          .modifierGroups
          .length;
      index += 1
    ) {
      const groupName =
        desiredItem
          .modifierGroups[
            index
          ];

      const group =
        findGroup(
          state,
          groupName
        );

      if (!group) {
        throw new Error(
          `LINK_GROUP_NOT_FOUND: ${groupName}`
        );
      }

      const sortOrder =
        index + 1;

      const existing =
        state.links.find(
          (row) =>
            row.menu_item_id ===
              item.id &&
            row.group_id ===
              group.id
        );

      if (existing) {
        await client.query(
          `
            UPDATE public.menu_item_modifier_groups
            SET sort_order = $1
            WHERE menu_item_id = $2
              AND group_id = $3
          `,
          [
            sortOrder,
            item.id,
            group.id,
          ]
        );

        continue;
      }

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
          item.id,
          group.id,
          sortOrder,
        ]
      );

      state =
        await loadMenuState(
          client,
          restaurantId
        );
    }
  }
}

function verifyAppliedMenu(
  state
) {
  const failures = [];

  for (
    const desired
    of MENU.categories
  ) {
    const category =
      findCategory(
        state,
        desired.name
      );

    if (!category) {
      failures.push(
        `CATEGORY_MISSING:${desired.name}`
      );
      continue;
    }

    if (
      Number(
        category.sort_order
      ) !== desired.sortOrder ||
      category.active !== true
    ) {
      failures.push(
        `CATEGORY_MISMATCH:${desired.name}`
      );
    }
  }

  for (
    const desired
    of MENU.items
  ) {
    const category =
      findCategory(
        state,
        desired.category
      );

    if (!category) {
      failures.push(
        `ITEM_CATEGORY_MISSING:${desired.name}`
      );
      continue;
    }

    const item =
      findItem(
        state,
        category.id,
        desired.name
      );

    if (!item) {
      failures.push(
        `ITEM_MISSING:${desired.name}`
      );
      continue;
    }

    if (
      Number(
        item.price_cents
      ) !==
        desired.priceCents ||
      item.active !==
        desired.active ||
      item.available !==
        desired.available
    ) {
      failures.push(
        `ITEM_MISMATCH:${desired.name}`
      );
    }
  }

  for (
    let index = 0;
    index <
      MENU.modifierGroups.length;
    index += 1
  ) {
    const desired =
      MENU.modifierGroups[
        index
      ];

    const group =
      findGroup(
        state,
        desired.name
      );

    if (!group) {
      failures.push(
        `GROUP_MISSING:${desired.name}`
      );
      continue;
    }

    if (
      Number(
        group.min_select
      ) !== desired.minSelect ||
      Number(
        group.max_select
      ) !== desired.maxSelect ||
      group.required !==
        desired.required ||
      Number(
        group.sort_order
      ) !== index + 1 ||
      group.active !== true
    ) {
      failures.push(
        `GROUP_MISMATCH:${desired.name}`
      );
    }

    for (
      const desiredOption
      of desired.options
    ) {
      const option =
        state.options.find(
          (row) =>
            row.group_id ===
              group.id &&
            normalize(row.name) ===
              normalize(
                desiredOption.name
              )
        );

      if (!option) {
        failures.push(
          `OPTION_MISSING:${desired.name}/${desiredOption.name}`
        );
        continue;
      }

      if (
        Number(
          option.price_delta_cents
        ) !==
          desiredOption
            .priceDeltaCents ||
        Number(
          option.sort_order
        ) !==
          desiredOption
            .sortOrder ||
        option.active !== true
      ) {
        failures.push(
          `OPTION_MISMATCH:${desired.name}/${desiredOption.name}`
        );
      }
    }
  }

  for (
    const desiredItem
    of MENU.items
  ) {
    const category =
      findCategory(
        state,
        desiredItem.category
      );

    if (!category) {
      continue;
    }

    const item =
      findItem(
        state,
        category.id,
        desiredItem.name
      );

    if (!item) {
      continue;
    }

    for (
      let index = 0;
      index <
        desiredItem
          .modifierGroups
          .length;
      index += 1
    ) {
      const groupName =
        desiredItem
          .modifierGroups[
            index
          ];

      const group =
        findGroup(
          state,
          groupName
        );

      if (!group) {
        continue;
      }

      const link =
        state.links.find(
          (row) =>
            row.menu_item_id ===
              item.id &&
            row.group_id ===
              group.id
        );

      if (!link) {
        failures.push(
          `LINK_MISSING:${desiredItem.name}/${groupName}`
        );
        continue;
      }

      if (
        Number(
          link.sort_order
        ) !==
          index + 1
      ) {
        failures.push(
          `LINK_MISMATCH:${desiredItem.name}/${groupName}`
        );
      }
    }
  }

  if (failures.length) {
    throw new Error(
      [
        'POST_WRITE_VERIFICATION_FAILED',
        ...failures,
      ].join('\n')
    );
  }
}

async function applyMenu(
  pool
) {
  assertApplyGuard();

  const client =
    await pool.connect();

  let transactionOpen =
    false;

  try {
    console.log(
      '=============================================='
    );
    console.log(
      'STATS FOOD MENU IMPORT — TRANSACTIONAL APPLY'
    );
    console.log(
      '=============================================='
    );
    console.log(
      `restaurant=${RESTAURANT_ID}`
    );
    console.log(
      `confirmed_restaurant=${CONFIRMED_RESTAURANT_ID}`
    );
    console.log(
      'automatic_deactivation=DISABLED'
    );
    console.log(
      'delete_operations=DISABLED'
    );
    console.log();

    const restaurantResult =
      await client.query(
        `
          SELECT id, name, active
          FROM public.restaurants
          WHERE id = $1
        `,
        [RESTAURANT_ID]
      );

    if (
      restaurantResult.rowCount !==
      1
    ) {
      throw new Error(
        `RESTAURANT_NOT_FOUND:${RESTAURANT_ID}`
      );
    }

    if (
      restaurantResult.rows[0]
        .active !== true
    ) {
      throw new Error(
        `RESTAURANT_INACTIVE:${RESTAURANT_ID}`
      );
    }

    console.log(
      `Restaurant: ${restaurantResult.rows[0].name}`
    );

    await client.query('BEGIN');
    transactionOpen = true;

    console.log('BEGIN=OK');

    await applyCategories(
      client,
      RESTAURANT_ID
    );
    console.log(
      'CATEGORIES=OK'
    );

    await applyItems(
      client,
      RESTAURANT_ID
    );
    console.log(
      'ITEMS=OK'
    );

    await applyModifierGroups(
      client,
      RESTAURANT_ID
    );
    console.log(
      'MODIFIER_GROUPS=OK'
    );

    await applyModifierOptions(
      client,
      RESTAURANT_ID
    );
    console.log(
      'MODIFIER_OPTIONS=OK'
    );

    await applyItemGroupLinks(
      client,
      RESTAURANT_ID
    );
    console.log(
      'ITEM_GROUP_LINKS=OK'
    );

    const finalState =
      await loadMenuState(
        client,
        RESTAURANT_ID
      );

    verifyAppliedMenu(
      finalState
    );

    console.log(
      'POST_WRITE_VERIFICATION=PASS'
    );

    await client.query(
      'COMMIT'
    );

    transactionOpen = false;

    console.log('COMMIT=OK');
    console.log(
      'APPLY COMPLETE — TRANSACTION COMMITTED'
    );
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query(
          'ROLLBACK'
        );

        console.error(
          'ROLLBACK=OK'
        );
      } catch (
        rollbackError
      ) {
        console.error(
          'ROLLBACK_FAILED',
          rollbackError.message
        );
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  if (APPLY) {
    try {
      await applyMenu(pool);
    } finally {
      await pool.end();
    }

    return;
  }

  try {
    console.log('==============================================');
    console.log('STATS FOOD MENU IMPORT — DRY RUN');
    console.log('==============================================');
    console.log(`restaurant=${RESTAURANT_ID}`);
    console.log('writes=DISABLED');
    console.log();

    const restaurantResult = await pool.query(
      `
        SELECT id, name, active
        FROM public.restaurants
        WHERE id = $1
      `,
      [RESTAURANT_ID]
    );

    if (restaurantResult.rowCount !== 1) {
      throw new Error(
        `RESTAURANT_NOT_FOUND:${RESTAURANT_ID}`
      );
    }

    const restaurant = restaurantResult.rows[0];

    console.log(
      `Restaurant: ${restaurant.name} (${restaurant.id})`
    );
    console.log(`Active: ${restaurant.active}`);
    console.log();

    const [
      categoryResult,
      itemResult,
      groupResult,
      optionResult,
      linkResult,
    ] = await Promise.all([
      pool.query(
        `
          SELECT *
          FROM public.menu_categories
          WHERE restaurant_id = $1
        `,
        [RESTAURANT_ID]
      ),

      pool.query(
        `
          SELECT *
          FROM public.menu_items
          WHERE restaurant_id = $1
        `,
        [RESTAURANT_ID]
      ),

      pool.query(
        `
          SELECT *
          FROM public.modifier_groups
          WHERE restaurant_id = $1
        `,
        [RESTAURANT_ID]
      ),

      pool.query(
        `
          SELECT mo.*
          FROM public.modifier_options mo
          JOIN public.modifier_groups mg
            ON mg.id = mo.group_id
          WHERE mg.restaurant_id = $1
        `,
        [RESTAURANT_ID]
      ),

      pool.query(
        `
          SELECT
            rel.menu_item_id,
            rel.group_id,
            rel.sort_order
          FROM public.menu_item_modifier_groups rel
          JOIN public.menu_items mi
            ON mi.id = rel.menu_item_id
          WHERE mi.restaurant_id = $1
        `,
        [RESTAURANT_ID]
      ),
    ]);

    const categories = categoryResult.rows;
    const items = itemResult.rows;
    const groups = groupResult.rows;
    const options = optionResult.rows;
    const links = linkResult.rows;

    const categoryByName = new Map(
      categories.map((row) => [
        normalize(row.name),
        row,
      ])
    );

    const groupByName = new Map(
      groups.map((row) => [
        normalize(row.name),
        row,
      ])
    );

    console.log('========== CATEGORIES ==========');

    for (const desired of MENU.categories) {
      const existing =
        categoryByName.get(normalize(desired.name));

      if (!existing) {
        printAction(
          'CREATE',
          'category',
          desired.name,
          `sort_order=${desired.sortOrder}`
        );
        continue;
      }

      const current = {
        sortOrder: existing.sort_order,
        active: existing.active,
      };

      const target = {
        sortOrder: desired.sortOrder,
        active: true,
      };

      printAction(
        same(current, target) ? 'KEEP' : 'UPDATE',
        'category',
        desired.name,
        same(current, target)
          ? `id=${existing.id}`
          : `${JSON.stringify(current)} -> ${JSON.stringify(target)}`
      );
    }

    console.log();
    console.log('========== ITEMS ==========');

    for (const desired of MENU.items) {
      const category =
        categoryByName.get(normalize(desired.category));

      if (!category) {
        printAction(
          'BLOCKED',
          'item',
          desired.name,
          `missing category=${desired.category}`
        );
        continue;
      }

      const existing = items.find(
        (row) =>
          row.category_id === category.id &&
          normalize(row.name) === normalize(desired.name)
      );

      if (!existing) {
        printAction(
          'CREATE',
          'item',
          desired.name,
          `category=${desired.category} price=${desired.priceCents}`
        );
        continue;
      }

      const current = {
        description: existing.description ?? null,
        priceCents: existing.price_cents,
        sortOrder: existing.sort_order,
        active: existing.active,
        available: existing.available,
      };

      const target = {
        description: desired.description,
        priceCents: desired.priceCents,
        sortOrder: desired.sortOrder,
        active: desired.active,
        available: desired.available,
      };

      printAction(
        same(current, target) ? 'KEEP' : 'UPDATE',
        'item',
        desired.name,
        same(current, target)
          ? `id=${existing.id}`
          : `${JSON.stringify(current)} -> ${JSON.stringify(target)}`
      );
    }

    console.log();
    console.log('========== MODIFIER GROUPS ==========');

    for (const desired of MENU.modifierGroups) {
      const existing =
        groupByName.get(normalize(desired.name));

      if (!existing) {
        printAction(
          'CREATE',
          'modifier-group',
          desired.name
        );
        continue;
      }

      const current = {
        minSelect: existing.min_select,
        maxSelect: existing.max_select,
        required: existing.required,
        active: existing.active,
      };

      const target = {
        minSelect: desired.minSelect,
        maxSelect: desired.maxSelect,
        required: desired.required,
        active: true,
      };

      printAction(
        same(current, target) ? 'KEEP' : 'UPDATE',
        'modifier-group',
        desired.name,
        same(current, target)
          ? `id=${existing.id}`
          : `${JSON.stringify(current)} -> ${JSON.stringify(target)}`
      );

      const existingOptions =
        options.filter(
          (row) => row.group_id === existing.id
        );

      for (const desiredOption of desired.options) {
        const acceptableNames = new Set(
          [
            desiredOption.name,
            ...(desiredOption.aliases || []),
          ].map(normalize)
        );

        const existingOption =
          existingOptions.find(
            (row) =>
              acceptableNames.has(
                normalize(row.name)
              )
          );

        if (!existingOption) {
          printAction(
            'CREATE',
            'modifier-option',
            `${desired.name} / ${desiredOption.name}`,
            `delta=${desiredOption.priceDeltaCents}`
          );
          continue;
        }

        const currentOption = {
          name: existingOption.name,
          priceDeltaCents:
            existingOption.price_delta_cents,
          sortOrder:
            existingOption.sort_order,
          active:
            existingOption.active,
        };

        const targetOption = {
          name: desiredOption.name,
          priceDeltaCents:
            desiredOption.priceDeltaCents,
          sortOrder:
            desiredOption.sortOrder,
          active: true,
        };

        printAction(
          same(currentOption, targetOption)
            ? 'KEEP'
            : 'UPDATE',
          'modifier-option',
          `${desired.name} / ${desiredOption.name}`,
          same(currentOption, targetOption)
            ? `id=${existingOption.id}`
            : `${JSON.stringify(currentOption)} -> ${JSON.stringify(targetOption)}`
        );
      }
    }

    console.log();
    console.log('========== ITEM ↔ GROUP LINKS ==========');

    for (const desiredItem of MENU.items) {
      const category =
        categoryByName.get(
          normalize(desiredItem.category)
        );

      if (!category) {
        continue;
      }

      const item = items.find(
        (row) =>
          row.category_id === category.id &&
          normalize(row.name) ===
            normalize(desiredItem.name)
      );

      if (!item) {
        for (
          let i = 0;
          i < desiredItem.modifierGroups.length;
          i += 1
        ) {
          printAction(
            'PENDING',
            'item-group-link',
            `${desiredItem.name} / ${desiredItem.modifierGroups[i]}`,
            'item will be created'
          );
        }

        continue;
      }

      for (
        let i = 0;
        i < desiredItem.modifierGroups.length;
        i += 1
      ) {
        const groupName =
          desiredItem.modifierGroups[i];

        const group =
          groupByName.get(normalize(groupName));

        if (!group) {
          printAction(
            'PENDING',
            'item-group-link',
            `${desiredItem.name} / ${groupName}`,
            'group will be created'
          );
          continue;
        }

        const link = links.find(
          (row) =>
            row.menu_item_id === item.id &&
            row.group_id === group.id
        );

        if (!link) {
          printAction(
            'CREATE',
            'item-group-link',
            `${desiredItem.name} / ${groupName}`,
            `sort_order=${i + 1}`
          );
          continue;
        }

        printAction(
          link.sort_order === i + 1
            ? 'KEEP'
            : 'UPDATE',
          'item-group-link',
          `${desiredItem.name} / ${groupName}`,
          link.sort_order === i + 1
            ? `sort_order=${link.sort_order}`
            : `sort_order=${link.sort_order} -> ${i + 1}`
        );
      }
    }

    console.log();
    console.log('========== DEACTIVATION CANDIDATES ==========');
    console.log(
      'REPORT ONLY — importer will not deactivate records.'
    );

    const desiredCategoryNames =
      new Set(
        MENU.categories.map((x) => normalize(x.name))
      );

    for (const existing of categories) {
      if (
        existing.active &&
        !desiredCategoryNames.has(
          normalize(existing.name)
        )
      ) {
        printAction(
          'DEACTIVATE',
          'category',
          existing.name,
          'candidate only'
        );
      }
    }

    /*
     * Item/group/option deactivation reporting is deliberately
     * deferred until the complete official dataset is loaded.
     * Reporting them now would incorrectly flag legitimate menu
     * records absent from this framework-only dataset.
     */

    console.log();
    console.log('========== UNRESOLVED SOURCE RULES ==========');

    for (const unresolved of MENU.unresolved || []) {
      printAction(
        'UNRESOLVED',
        'source-rule',
        unresolved.item,
        unresolved.rule
      );
    }

    console.log();
    console.log('==============================================');
    console.log('DRY RUN COMPLETE — ZERO WRITES PERFORMED');
    console.log('==============================================');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('IMPORT_DRY_RUN_FAILED');
  console.error(error.message);
  process.exit(1);
});
