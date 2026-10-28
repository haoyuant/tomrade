/** Props the window builds afresh from each state it hears, though the same: compared by what they hold. */
const BY_VALUE = new Set(["session", "terminal", "closed", "places", "look"]);

/** Whether a cell's props would draw it the same: each as itself, the rows made afresh by what they hold. */
export function sameCellProps<P extends object>(a: P, b: P): boolean {
  const keys = Object.keys(a) as (keyof P & string)[];
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]) || (BY_VALUE.has(k) && JSON.stringify(a[k]) === JSON.stringify(b[k])));
}
