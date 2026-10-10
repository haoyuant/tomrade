/**
 * Two spellings of one repository read the same, so a checkout keyed by URL is
 * found from any of them. Mirrors `normalizeRemote` in @tomradex/repos, which
 * the renderer cannot import (it pulls in node).
 */
export const normalizeRemote = (remote: string): string => remote.trim().replace(/\/\/[^@/]*@/, "//").replace(/\/+$/, "").replace(/\.git$/, "");
