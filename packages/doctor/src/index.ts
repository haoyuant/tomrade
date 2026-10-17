export { Doctor, DoctorConfig, DoctorOptions, DEFAULT_INCLUDE, REPORT_KINDS, Topic, fingerprint, type ReportKind, type Check, type CheckResult, type Diagnosis, type RemoteReport, type Report, type ReportInclude, type ReportView, type ReportsView, type SendResult, type Transport } from "./service.js";
export { parseCatalog, fetchCatalog, CATALOG_MAX_AGE_MS } from "./catalog.js";
export { Doctor as default } from "./service.js";
export { BUNDLED, KnownIssue, before, matches, type Evidence } from "./issues.js";
export { scrub, tail, newestFiles, errorLines } from "./evidence.js";
export { DOCTOR_WORDS, type Words } from "./words.js";
