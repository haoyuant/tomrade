import path from "node:path";

const TYPES: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xml: "application/xml",
  svg: "image/svg+xml",
  json: "application/json",
  jsonl: "application/jsonl",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  ini: "text/plain",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  sh: "text/x-shellscript",
  sql: "application/sql",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf"
};

export const mimeOf = (file: string): string => TYPES[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

/** Text as the viewer understands it: shown as characters, never bytes. `svg` counts — it is markup. */
export const isTextMime = (mime: string): boolean =>
  mime.startsWith("text/") || mime === "image/svg+xml" || /^application\/(json|jsonl|xml|yaml|toml|sql|javascript|typescript)$/.test(mime);

/** Bytes that cannot be UTF-8 text: a NUL in the first 8 KiB is how git decides too. */
export const looksBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8192).includes(0);
