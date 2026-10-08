// The public API. Keep it small: everything exported here is a promise to library users.
// Internals (probes, pools, verdict helpers) stay importable only from inside the package.
export { check } from "./check.ts";
export type { CheckDeps } from "./check.ts";
export { checkMany } from "./batch.ts";
export type { BatchEvent, BatchOptions } from "./batch.ts";
export { GlobalpingProbe } from "./reference/globalping.ts";
export type { GlobalpingOptions } from "./reference/globalping.ts";
export { parseTarget, TargetError } from "./target.ts";
export { ConfigFileError, loadDefaultConfig, loadConfigFile, resolveConfig, validateConfig } from "./config.ts";
export type { ConfigFile } from "./config.ts";
export { createTranslator, resolveLocale, availableLocales } from "./i18n.ts";
export type { Translator } from "./i18n.ts";
export { detectEnvironment } from "./env.ts";
export type { Environment } from "./env.ts";
export type * from "./types.ts";
