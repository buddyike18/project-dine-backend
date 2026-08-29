const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateCanonicalOrderPricing,
} = require('../lib/orderPricing');

test('calculates canonical pricing from database values', async () => {
  const restaurantId =
    'e777e6b5-4b3e-48f9-b84b-486a804b27de';
  const menuItemId =
    '11111111-1111-4111-8111-111111111111';
  const groupId =
    '22222222-2222-4222-8222-222222222222';
  const optionId =
    '33333333-3333-4333-8333-333333333333';

  const calls = [];

  const query = async (step, sql, params) => {
    calls.push({ step, sql, params });

    if (step === 'load restaurant pricing settings') {
      return {
        rows: [{
          automatic_gratuity_enabled: true,
          automatic_gratuity_bps: 1800,
        }],
      };
    }

    if (step === 'hydrate canonical menu item') {
      return {
        rows: [{
          id: menuItemId,
          name: 'Canonical Item',
          price_cents: 1300,
          tax_rate_bps: 925,
        }],
      };
    }

    if (step === 'load linked modifier groups') {
      return {
        rows: [{
          id: groupId,
          name: 'Canonical Modifier',
          min_select: 1,
          max_select: 1,
        }],
      };
    }

    if (step === 'load canonical modifier options') {
      return {
        rows: [{
          id: optionId,
          group_id: groupId,
          name: 'Canonical Option',
          price_delta_cents: 200,
        }],
      };
    }

    throw new Error(`Unexpected query step: ${step}`);
  };

  const result = await calculateCanonicalOrderPricing({
    query,
    restaurantId,
    items: [{
      menu_item_id: menuItemId,
      quantity: 1,
      modifiers: [{
        group_id: groupId,
        option_ids: [optionId],
      }],

      // Deliberately untrusted values. The service must ignore them.
      price_cents: 1,
      tax_rate_bps: 0,
      modifier_total_cents: 1,
    }],
  });

  assert.equal(result.subtotal_cents, 1500);
  assert.equal(result.tax_cents, 139);
  assert.equal(result.tip_cents, 270);
  assert.equal(result.total_cents, 1909);

  assert.equal(result.automatic_gratuity_enabled, true);
  assert.equal(result.automatic_gratuity_bps, 1800);

  assert.equal(result.normalizedItems.length, 1);
  assert.equal(
    result.normalizedItems[0].unit_price_cents_snapshot,
    1300
  );
  assert.equal(
    result.normalizedItems[0].modifier_total_cents,
    200
  );
  assert.equal(
    result.normalizedItems[0].tax_rate_bps,
    925
  );

  assert.deepEqual(
    calls.map((call) => call.step),
    [
      'load restaurant pricing settings',
      'hydrate canonical menu item',
      'load linked modifier groups',
      'load canonical modifier options',
    ]
  );
});
