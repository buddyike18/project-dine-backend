const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateAutomaticGratuityCents,
} = require('../lib/orderGratuity');

test('disabled automatic gratuity returns zero', () => {
  assert.equal(
    calculateAutomaticGratuityCents(1300, false, 1800),
    0
  );
});

test('18 percent automatic gratuity on $13 is $2.34', () => {
  assert.equal(
    calculateAutomaticGratuityCents(1300, true, 1800),
    234
  );
});

test('20 percent automatic gratuity on $98 is $19.60', () => {
  assert.equal(
    calculateAutomaticGratuityCents(9800, true, 2000),
    1960
  );
});

test('zero percent returns zero when enabled', () => {
  assert.equal(
    calculateAutomaticGratuityCents(1300, true, 0),
    0
  );
});

test('rounds to the nearest cent', () => {
  assert.equal(
    calculateAutomaticGratuityCents(999, true, 1800),
    180
  );
});

test('rejects invalid subtotal', () => {
  assert.throws(
    () =>
      calculateAutomaticGratuityCents(
        -1,
        true,
        1800
      ),
    TypeError
  );
});

test('rejects gratuity above 50 percent', () => {
  assert.throws(
    () =>
      calculateAutomaticGratuityCents(
        1300,
        true,
        5001
      ),
    TypeError
  );
});
