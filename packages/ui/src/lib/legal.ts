import type { Locale } from "./i18n";

const SITE = "https://tomrade.com";

/** tomrade.com's home page in the reader's language. */
export const siteUrl = (locale: Locale) => (locale === "zh" ? `${SITE}/zh/` : `${SITE}/`);

/** The Terms of Service and Privacy Policy live on the site, in both languages; the app only links there. */
export const legalUrl = (doc: "terms" | "privacy", locale: Locale) => `${siteUrl(locale)}${doc}/`;
