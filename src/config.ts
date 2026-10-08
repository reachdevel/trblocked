import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliSettings, Config, ConfigOverride, Note } from "./types.ts";

const defaultConfigUrl = new URL("../config/default.json", import.meta.url);

/** A config file: engine overrides plus an optional `cli` section for CLI-only preferences. */
export type ConfigFile = ConfigOverride & { cli?: CliSettings };

export function loadDefaultConfig(): Config {
  return JSON.parse(readFileSync(defaultConfigUrl, "utf8")) as Config;
}

/** A config file that cannot be used; `notes` explain why (rendered by the i18n layer). */
export class ConfigFileError extends Error {
  readonly notes: Note[];
  constructor(notes: Note[]) {
    super(notes.map((n) => n.code).join(", "));
    this.notes = notes;
  }
}

const CLI_SCHEMA = { lang: "", charset: "auto", warnings: true };
const CHARSETS = ["auto", "unicode", "ascii"];

const typeNote = (v: unknown): Note => ({ code: `config.type.${Array.isArray(v) ? "array" : v === null ? "null" : typeof v}` });

/** Closest known key within a small edit distance, to turn a typo into a suggestion. */
function closest(key: string, candidates: string[]): string | undefined {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const up = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = up;
      }
    }
    return row[b.length]!;
  };
  const best = candidates.map((c) => ({ c, d: distance(key.toLowerCase(), c.toLowerCase()) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(2, Math.floor(key.length / 3)) ? best.c : undefined;
}

function walk(value: unknown, schema: unknown, path: string, out: Note[]): void {
  if (isPlain(schema)) {
    if (!isPlain(value)) return void out.push({ code: "config.wrongType", params: { path: path || "(root)", expected: { code: "config.type.object" }, got: typeNote(value) } });
    for (const [key, v] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (!(key in schema)) {
        const suggestion = closest(key, Object.keys(schema));
        out.push(suggestion ? { code: "config.unknownKeySuggest", params: { path: here, suggestion: path ? `${path}.${suggestion}` : suggestion } } : { code: "config.unknownKey", params: { path: here } });
      } else {
        walk(v, schema[key], here, out);
      }
    }
  } else if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return void out.push({ code: "config.wrongType", params: { path, expected: { code: "config.type.array" }, got: typeNote(value) } });
    if (schema.length > 0) value.forEach((el, i) => walk(el, schema[0], `${path}[${i}]`, out));
  } else if (typeof value !== typeof schema) {
    out.push({ code: "config.wrongType", params: { path, expected: typeNote(schema), got: typeNote(value) } });
  }
}

/**
 * Check a user-written config against the shape of the defaults: unknown keys (with a "did you mean"),
 * wrong types and bad enum values. Empty array = fine. Run for files people edit; `check()` itself stays lenient.
 */
export function validateConfig(value: unknown, defaults: object = loadDefaultConfig()): Note[] {
  const issues: Note[] = [];
  walk(value, { ...defaults, cli: CLI_SCHEMA }, "", issues);
  const charset = isPlain(value) && isPlain(value.cli) ? value.cli.charset : undefined;
  if (typeof charset === "string" && !CHARSETS.includes(charset)) {
    issues.push({ code: "config.badValue", params: { path: "cli.charset", allowed: CHARSETS.join(", ") } });
  }
  return issues;
}

export function loadConfigFile(path: string): ConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigFileError([{ code: "config.unreadable", params: { file: path, message: err instanceof Error ? err.message : String(err) } }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigFileError([{ code: "config.invalidJson", params: { file: path, message: err instanceof Error ? err.message : String(err) } }]);
  }
  const issues = validateConfig(parsed);
  if (issues.length > 0) throw new ConfigFileError([{ code: "config.invalid", params: { file: path } }, ...issues]);
  return parsed as ConfigFile;
}

/** `$XDG_CONFIG_HOME/trblocked/config.json`, defaulting to `~/.config/trblocked/config.json`. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "trblocked", "config.json");
}

/** A missing file is normal (returns {}); an unreadable or invalid one is a ConfigFileError. */
export function loadUserConfig(path = userConfigPath()): ConfigFile {
  if (!existsSync(path)) return {};
  return loadConfigFile(path);
}

export function saveUserConfig(config: ConfigFile, path = userConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Later wins. Plain objects merge recursively; arrays and scalars replace. */
export function mergeOverrides<T extends object>(...layers: (T | undefined)[]): T {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      const prev = out[k];
      out[k] = isPlain(v) && isPlain(prev) ? mergeOverrides(prev, v) : isPlain(v) ? mergeOverrides(v) : v;
    }
  }
  return out as T;
}

export function resolveConfig(override: ConfigOverride = {}): Config {
  return mergeOverrides<object>(loadDefaultConfig(), override) as Config;
}
