// String order shared by the store and root discovery, in a module of its own so that what
// only discovers roots (`tokenhud hook`, which must start fast) doesn't load the store.

/** Orders strings by code point, as Python sorts str (not by UTF-16 code unit). */
export function byCodePoint(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}
