/**
 * Whether a value is a non-null object that is not an array: what the request
 * body parsers require of a JSON object before reading its keys.
 *
 * It does not look at the prototype: a `Date`, a class instance and an object
 * made with `Object.create(null)` count as much as `{}` does.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
