/**
 * What `isPlainObject` answers for each kind of value (#407). The five body
 * parsers that call it each had a copy of the same body before; these are the
 * answers that body gave, so every caller's verdict is unchanged.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPlainObject } from './plain-object.ts';

class Point {
  x = 1;
  y = 2;
}

/** Values that are not a non-null, non-array object. */
const NOT_OBJECTS: readonly unknown[] = [
  null,
  undefined,
  [],
  [1, 2],
  'text',
  '',
  0,
  42,
  Number.NaN,
  true,
  false,
  1n,
  Symbol('s'),
  () => ({}),
];

describe('isPlainObject (#407)', () => {
  it('is true for an object literal, with keys or without, and for an object with no prototype', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ words: ['a'] }), true);
    assert.equal(isPlainObject(JSON.parse('{"jsonrpc":"2.0"}')), true);
    assert.equal(isPlainObject(Object.create(null)), true);
  });

  // Behaviour unchanged: the helper means "a non-null object that is not an
  // array", not "an object whose prototype is Object.prototype", so a Date and
  // a class instance are true, as they were for every copy it replaces.
  it('is true for a Date and for a class instance, since it does not look at the prototype', () => {
    assert.equal(isPlainObject(new Date(0)), true);
    assert.equal(isPlainObject(new Point()), true);
  });

  it('is false for null, undefined, an array, a string, a number, every other primitive and a function', () => {
    for (const value of NOT_OBJECTS) {
      assert.equal(isPlainObject(value), false, String(value));
    }
  });
});
