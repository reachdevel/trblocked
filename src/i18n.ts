import { readdirSync, readFileSync } from "node:fs";
import type { Note } from "./types.ts";

const localesDir = new URL("../locales/", import.meta.url);

/** A catalog value is a template; arrays are joined with newlines (used for multi-line help). */
export type Catalog = Record<string, string | string[]>;

export function availableLocales(): string[] {
  return readdirSync(localesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function readCatalog(locale: string): Catalog {
  return JSON.parse(readFileSync(new URL(`${locale}.json`, localesDir), "utf8")) as Catalog;
}

export interface Translator {
  readonly locale: string;
  t(key: string, params?: Note["params"]): string;
  note(n: Note): string;
}

/** English is the base: a locale that lacks a key falls back to it instead of showing a raw key. */
export function createTranslator(locale: string): Translator {
  const catalog: Catalog = { ...readCatalog("en"), ...(locale === "en" ? {} : readCatalog(locale)) };
  const tr: Translator = {
    locale,
    t(key, params = {}) {
      const raw = catalog[key];
      if (raw === undefined) return key;
      const template = Array.isArray(raw) ? raw.join("\n") : raw;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => {
        const v = params[name];
        if (v === undefined) return "";
        return typeof v === "object" ? tr.note(v) : String(v);
      });
    },
    note: (n) => tr.t(n.code, n.params),
  };
  return tr;
}

// ---------- locale selection ----------

/** Language subtag of the first meaningful locale variable ("tr_TR.UTF-8" -> "tr"); C/POSIX count as unset. */
export function detectSystemLanguage(env: NodeJS.ProcessEnv, platform: string = process.platform): string | undefined {
  const tagOf = (v?: string) => {
    if (!v || v === "C" || v === "POSIX" || v.startsWith("C.")) return undefined;
    return v.toLowerCase().split(/[_.\-@]/)[0] || undefined;
  };
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const lang = tagOf(env[key]);
    if (lang) return lang;
  }
  // GUI-launched processes have no LANG on macOS, but its preferences are reliable. Elsewhere ICU just says en-US.
  return platform === "darwin" ? tagOf(Intl.DateTimeFormat().resolvedOptions().locale.replace("-", "_")) : undefined;
}

export interface LocaleChoice {
  flag?: string;
  saved?: string;
  env: NodeJS.ProcessEnv;
  available?: string[];
  platform?: string;
}

/**
 * --lang > TRBLOCKED_LANG > saved config > system language > tr.
 * System language: Turkish -> tr, any other language -> en (no catalog for it), undetectable -> tr.
 */
export function resolveLocale(c: LocaleChoice): string {
  const available = c.available ?? availableLocales();
  for (const explicit of [c.flag, c.env.TRBLOCKED_LANG, c.saved]) {
    const lang = explicit?.toLowerCase().split(/[_\-.]/)[0];
    if (lang && available.includes(lang)) return lang;
  }
  const system = detectSystemLanguage(c.env, c.platform);
  if (system === undefined) return "tr";
  return available.includes(system) ? system : "en";
}

// ---------- terminal capability ----------

/** Variables that only a graphical terminal emulator sets (iTerm, Terminal.app, VS Code, kitty, Windows Terminal, VTE...). */
const EMULATOR_MARKERS = ["TERM_PROGRAM", "LC_TERMINAL", "ITERM_SESSION_ID", "WT_SESSION", "KITTY_WINDOW_ID", "VTE_VERSION", "KONSOLE_VERSION", "WEZTERM_EXECUTABLE", "COLORTERM"];

/**
 * ASCII only on positive evidence of a limited terminal: a dumb terminal, the kernel console, or a locale that
 * explicitly names a legacy charset (tr_TR.ISO8859-9). Locale variables that name no charset (C, POSIX, en_US,
 * unset) say nothing about the terminal: modern terminals render UTF-8 whatever LANG is. `TERM=linux` is only the
 * kernel console when no emulator announces itself: iTerm profiles can report `linux` and still render everything.
 * Callers offer --ascii / --unicode / cli.charset for the cases this cannot know.
 */
export function terminalSupportsUnicode(env: NodeJS.ProcessEnv): boolean {
  if (env.TERM === "dumb") return false;
  if (env.TERM === "linux" && !EMULATOR_MARKERS.some((k) => env[k])) return false;
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const charset = /\.([A-Za-z0-9_-]+)/.exec(effective)?.[1];
  return !charset || /^utf-?8$/i.test(charset);
}

const TR_MAP: Record<string, string> = {
  ğ: "g", Ğ: "G", ü: "u", Ü: "U", ş: "s", Ş: "S", ö: "o", Ö: "O", ç: "c", Ç: "C", ı: "i", İ: "I",
  â: "a", Â: "A", î: "i", Î: "I", û: "u", Û: "U",
};

/** Turkish letters -> nearest ASCII; anything else outside ASCII becomes "?". Escape sequences are untouched. */
export function asciify(s: string): string {
  return s.replace(/[^\x00-\x7f]/gu, (ch) => TR_MAP[ch] ?? "?");
}

export interface Symbols {
  ok: string;
  bad: string;
  unknown: string;
  warn: string;
  barFull: string;
  barEmpty: string;
  spinner: string[];
  dot: string;
  sep: string;
  ellipsis: string;
  pointer: string;
}

export const UNICODE_SYMBOLS: Symbols = {
  ok: "✔", bad: "✖", unknown: "?", warn: "⚠", barFull: "█", barEmpty: "░",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], dot: "·", sep: " · ", ellipsis: "…", pointer: "❯",
};

export const ASCII_SYMBOLS: Symbols = {
  ok: "+", bad: "x", unknown: "?", warn: "!", barFull: "#", barEmpty: "-",
  spinner: ["|", "/", "-", "\\"], dot: "-", sep: " - ", ellipsis: "...", pointer: ">",
};
