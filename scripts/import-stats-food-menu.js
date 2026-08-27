'use strict';

require('dotenv').config();

const { Pool } = require('pg');

const RESTAURANT_ID =
  process.env.STATS_RESTAURANT_ID ||
  'e777e6b5-4b3e-48f9-b84b-486a804b27de';

const APPLY = process.argv.includes('--apply');

if (APPLY) {
  console.error(
    'APPLY_DISABLED: this importer is currently dry-run only'
  );
  process.exit(1);
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

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

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
