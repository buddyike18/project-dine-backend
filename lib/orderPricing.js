const { calculateOrderTaxCents } = require('./orderTax');
const {
  calculateAutomaticGratuityCents,
} = require('./orderGratuity');

async function calculateCanonicalOrderPricing({
  query,
  restaurantId,
  items,
}) {
  if (typeof query !== 'function') {
    throw new TypeError('query must be a function');
  }

  if (!restaurantId) {
    throw new TypeError('restaurantId is required');
  }

  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }

  const restaurantSettingsResult = await query(
    'load restaurant pricing settings',
    `SELECT
       automatic_gratuity_enabled,
       automatic_gratuity_bps
     FROM public.restaurants
     WHERE id = $1
       AND active = TRUE
     LIMIT 1`,
    [restaurantId]
  );

  const restaurantSettings =
    restaurantSettingsResult.rows?.[0];

  if (!restaurantSettings) {
    const err = new Error('Restaurant not found');
    err.status = 404;
    throw err;
  }

  const normalizedItems = [];

  for (const item of items) {
    const menuItemId = item.menu_item_id;

    const menuItemResult = await query(
      'hydrate canonical menu item',
      `SELECT mi.id,
              mi.name,
              mi.price_cents,
              mi.tax_rate_bps
       FROM menu_items mi
       LEFT JOIN menu_categories mc
         ON mc.id = mi.category_id
        AND mc.active = true
       WHERE mi.id = $1
         AND mi.restaurant_id = $2
         AND mi.active = true
         AND mi.available = true
         AND (
           mi.category_id IS NULL
           OR mc.id IS NOT NULL
         )
       LIMIT 1`,
      [menuItemId, restaurantId]
    );

    const menuItemRow = menuItemResult.rows?.[0];

    if (!menuItemRow) {
      const err = new Error('Menu item is unavailable or invalid');
      err.status = 400;
      throw err;
    }

    const linkedGroupsResult = await query(
      'load linked modifier groups',
      `SELECT mg.id,
              mg.name,
              mg.min_select,
              mg.max_select
       FROM menu_item_modifier_groups mimg
       JOIN modifier_groups mg
         ON mg.id = mimg.group_id
       WHERE mimg.menu_item_id = $1
         AND mg.restaurant_id = $2
         AND mg.active = true
       ORDER BY COALESCE(mimg.sort_order, mg.sort_order) ASC,
                mg.name ASC`,
      [menuItemId, restaurantId]
    );

    const linkedGroups = linkedGroupsResult.rows || [];
    const linkedGroupMap = new Map(
      linkedGroups.map((group) => [group.id, group])
    );

    const submittedGroups = Array.isArray(item.modifiers)
      ? item.modifiers
      : [];

    const submittedGroupMap = new Map();

    for (const submittedGroup of submittedGroups) {
      if (submittedGroupMap.has(submittedGroup.group_id)) {
        const err = new Error('Duplicate modifier group selection');
        err.status = 400;
        throw err;
      }

      submittedGroupMap.set(submittedGroup.group_id, submittedGroup);

      if (!linkedGroupMap.has(submittedGroup.group_id)) {
        const err = new Error('Invalid modifier group for menu item');
        err.status = 400;
        throw err;
      }
    }

    const normalizedModifiers = [];
    let modifierTotalCents = 0;

    for (const linkedGroup of linkedGroups) {
      const submittedGroup = submittedGroupMap.get(linkedGroup.id);
      const optionIds = submittedGroup?.option_ids || [];
      const selectionCount = optionIds.length;

      if (
        selectionCount < linkedGroup.min_select ||
        selectionCount > linkedGroup.max_select
      ) {
        const err = new Error('Invalid modifier selection count');
        err.status = 400;
        throw err;
      }

      const uniqueOptionIds = new Set(optionIds);

      if (uniqueOptionIds.size !== optionIds.length) {
        const err = new Error('Duplicate modifier option selection');
        err.status = 400;
        throw err;
      }

      if (optionIds.length === 0) {
        continue;
      }

      const optionsResult = await query(
        'load canonical modifier options',
        `SELECT id,
                group_id,
                name,
                price_delta_cents
         FROM modifier_options
         WHERE group_id = $1
           AND active = true
           AND id = ANY($2::uuid[])
         ORDER BY id ASC`,
        [linkedGroup.id, optionIds]
      );

      const optionRows = optionsResult.rows || [];

      if (optionRows.length !== optionIds.length) {
        const err = new Error('Invalid modifier option for group');
        err.status = 400;
        throw err;
      }

      for (const optionRow of optionRows) {
        modifierTotalCents += optionRow.price_delta_cents;

        normalizedModifiers.push({
          group_id: linkedGroup.id,
          option_id: optionRow.id,
          group_name_snapshot: linkedGroup.name,
          option_name_snapshot: optionRow.name,
          price_delta_cents_snapshot: optionRow.price_delta_cents,
          quantity: 1,
        });
      }
    }

    normalizedItems.push({
      menu_item_id: menuItemRow.id,
      name_snapshot: menuItemRow.name,
      unit_price_cents_snapshot: menuItemRow.price_cents,
      quantity: item.quantity,
      modifier_total_cents: modifierTotalCents,
      tax_rate_bps: Number(menuItemRow.tax_rate_bps || 0),
      modifiers: normalizedModifiers,
    });
  }

  const subtotal_cents = normalizedItems.reduce(
    (sum, it) =>
      sum +
      (it.unit_price_cents_snapshot + it.modifier_total_cents) *
        it.quantity,
    0
  );
  const tax_cents = calculateOrderTaxCents(normalizedItems);
  const tip_cents = calculateAutomaticGratuityCents(
    subtotal_cents,
    restaurantSettings.automatic_gratuity_enabled === true,
    Number(restaurantSettings.automatic_gratuity_bps || 0)
  );
  const total_cents = subtotal_cents + tax_cents + tip_cents;

  return {
    normalizedItems,
    subtotal_cents,
    tax_cents,
    tip_cents,
    total_cents,
    automatic_gratuity_enabled:
      restaurantSettings.automatic_gratuity_enabled === true,
    automatic_gratuity_bps:
      Number(restaurantSettings.automatic_gratuity_bps || 0),
  };
}

module.exports = {
  calculateCanonicalOrderPricing,
};
