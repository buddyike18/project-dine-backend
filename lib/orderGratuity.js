function calculateAutomaticGratuityCents(
  subtotalCents,
  enabled,
  gratuityBps
) {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new TypeError(
      'subtotalCents must be a non-negative integer'
    );
  }

  if (typeof enabled !== 'boolean') {
    throw new TypeError('enabled must be boolean');
  }

  if (
    !Number.isInteger(gratuityBps) ||
    gratuityBps < 0 ||
    gratuityBps > 5000
  ) {
    throw new TypeError(
      'gratuityBps must be an integer between 0 and 5000'
    );
  }

  if (!enabled || gratuityBps === 0) {
    return 0;
  }

  return Math.round(
    (subtotalCents * gratuityBps) / 10000
  );
}

module.exports = {
  calculateAutomaticGratuityCents,
};
