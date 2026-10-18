import { isBuiltinLocale, type Locale } from "./dicts";

const SITE = "https://tomrade.com";

/** tomrade.com's home page in the reader's language, for a language the app ships; English for one a pack adds. */
export const siteUrl = (locale: Locale) => (locale === "en" || !isBuiltinLocale(locale) ? `${SITE}/` : `${SITE}/${locale.toLowerCase()}/`);

/** The Terms of Service and Privacy Policy live on the site, in English and Simplified Chinese; the app only links there. */
export const legalUrl = (doc: "terms" | "privacy", locale: Locale) => `${siteUrl(locale === "zh" ? "zh" : "en")}${doc}/`;
