'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateLineTaxCents,
  calculateOrderTaxCents,
} = require('../lib/orderTax');

const MECKLENBURG_TEST_RATE_BPS = 825;

test('825 bps: rounds $10.00 taxable line to 83 cents', () => {
  assert.equal(
    calculateLineTaxCents({
      unitPriceCents: 1000,
      modifierTotalCents: 0,
      quantity: 1,
      taxRateBps: MECKLENBURG_TEST_RATE_BPS,
    }),
    83
  );
});

test('825 bps: includes modifier price in taxable line', () => {
  assert.equal(
    calculateLineTaxCents({
      unitPriceCents: 1300,
      modifierTotalCents: 400,
      quantity: 1,
      taxRateBps: MECKLENBURG_TEST_RATE_BPS,
    }),
    140
  );
});

test('825 bps: applies quantity before cent rounding', () => {
  // ($13 + $4) * 2 = $34.00
  // $34.00 * 8.25% = $2.805 -> $2.81
  assert.equal(
    calculateLineTaxCents({
      unitPriceCents: 1300,
      modifierTotalCents: 400,
      quantity: 2,
      taxRateBps: MECKLENBURG_TEST_RATE_BPS,
    }),
    281
  );
});

test('zero-rate item produces zero tax', () => {
  assert.equal(
    calculateLineTaxCents({
      unitPriceCents: 2500,
      modifierTotalCents: 500,
      quantity: 3,
      taxRateBps: 0,
    }),
    0
  );
});

test('mixed-rate order sums tax from each authoritative line', () => {
  assert.equal(
    calculateOrderTaxCents([
      {
        unit_price_cents_snapshot: 1000,
        modifier_total_cents: 0,
        quantity: 1,
        tax_rate_bps: 825,
      },
      {
        unit_price_cents_snapshot: 1000,
        modifier_total_cents: 0,
        quantity: 1,
        tax_rate_bps: 0,
      },
      {
        unit_price_cents_snapshot: 1300,
        modifier_total_cents: 400,
        quantity: 2,
        tax_rate_bps: 825,
      },
    ]),
    364
  );
});

test('rejects invalid tax inputs', () => {
  assert.throws(
    () =>
      calculateLineTaxCents({
        unitPriceCents: 1000,
        modifierTotalCents: 0,
        quantity: 1,
        taxRateBps: -1,
      }),
    /taxRateBps/
  );

  assert.throws(
    () =>
      calculateLineTaxCents({
        unitPriceCents: 1000,
        modifierTotalCents: 0,
        quantity: 0,
        taxRateBps: 825,
      }),
    /quantity/
  );
});
