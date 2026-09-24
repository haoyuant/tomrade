type Version = [number, number, number];

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export const isVersion = (text: string): boolean => parseVersion(text) !== null;

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function comparator(version: Version, token: string): boolean {
  const cmp = (v: Version) => {
    for (let i = 0; i < 3; i++) if (version[i] !== v[i]) return version[i] - v[i];
    return 0;
  };
  if (token === "*" || token === "x") return true;
  const op = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!op) return false;
  const base = parseVersion(op[2]);
  if (!base) return false;
  switch (op[1]) {
    case "^": {
      if (cmp(base) < 0) return false;
      if (base[0] > 0) return version[0] === base[0];
      if (base[1] > 0) return version[0] === 0 && version[1] === base[1];
      return version[0] === 0 && version[1] === 0 && version[2] === base[2];
    }
    case "~":
      return cmp(base) >= 0 && version[0] === base[0] && version[1] === base[1];
    case ">=":
      return cmp(base) >= 0;
    case "<=":
      return cmp(base) <= 0;
    case ">":
      return cmp(base) > 0;
    case "<":
      return cmp(base) < 0;
    default:
      return cmp(base) === 0;
  }
}

/** The subset of npm ranges plugins need: `^`, `~`, comparisons, `*`, spaces for AND and `||` for OR. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split("||").some((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => comparator(v, token));
  });
}

export const isRange = (range: string): boolean => range.split("||").every((part) => part.trim().split(/\s+/).filter(Boolean).every((t) => t === "*" || t === "x" || /^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+/.test(t)));
