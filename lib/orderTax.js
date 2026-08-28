'use strict';

/**
 * Calculates sales tax for one authoritative order line.
 *
 * Taxable line value includes:
 *   (base item price + selected modifier price) * quantity
 *
 * All inputs are integer cents / basis points.
 * Rounding is to the nearest cent using integer arithmetic.
 */
function calculateLineTaxCents({
  unitPriceCents,
  modifierTotalCents = 0,
  quantity,
  taxRateBps,
}) {
  for (const [name, value] of Object.entries({
    unitPriceCents,
    modifierTotalCents,
    quantity,
    taxRateBps,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }

  if (quantity < 1) {
    throw new TypeError('quantity must be at least 1');
  }

  if (taxRateBps > 10000) {
    throw new RangeError('taxRateBps must not exceed 10000');
  }

  const taxableLineCents =
    (unitPriceCents + modifierTotalCents) * quantity;

  if (!Number.isSafeInteger(taxableLineCents)) {
    throw new RangeError('taxable line amount exceeds safe integer range');
  }

  const numerator = taxableLineCents * taxRateBps;

  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError('tax calculation exceeds safe integer range');
  }

  return Math.floor((numerator + 5000) / 10000);
}

function calculateOrderTaxCents(items) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }

  return items.reduce(
    (sum, item) =>
      sum +
      calculateLineTaxCents({
        unitPriceCents: item.unit_price_cents_snapshot,
        modifierTotalCents: item.modifier_total_cents || 0,
        quantity: item.quantity,
        taxRateBps: item.tax_rate_bps || 0,
      }),
    0
  );
}

module.exports = {
  calculateLineTaxCents,
  calculateOrderTaxCents,
};
