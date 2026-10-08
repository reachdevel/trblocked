import type { Note } from "./types.ts";

/** A command-line mistake; `code`/`params` are rendered through the catalog (`error.<code>`). */
export class UsageError extends Error {
  readonly note: Note;
  constructor(code: string, params?: Note["params"]) {
    super(code);
    this.note = { code: `error.${code}`, params };
  }
}

export interface CliOptions {
  targets: string[];
  /** Exactly one positional target and no file: JSON output is an object, not an array. */
  singleInput: boolean;
  command?: "config" | "config-show";
  file?: string;
  json: boolean;
  config?: string;
  lang?: string;
  /** --ascii / --unicode force the character set (ascii wins if both are given). */
  ascii: boolean;
  unicode: boolean;
  /** Explicitly force the outside check on / off (otherwise the config decides). */
  reference?: "globalping";
  noReference: boolean;
  throttle: boolean;
  /** Repeat plain-HTTP requests to catch DPI that injects its block page only some of the time. */
  injection: boolean;
  concurrency?: number;
  verbose: boolean;
  silent: boolean;
  noColor: boolean;
  noProgress: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = { targets: [], singleInput: false, json: false, ascii: false, unicode: false, noReference: false, throttle: false, injection: false, verbose: false, silent: false, noColor: false, noProgress: false, help: false, version: false };
  if (argv[0] === "config") {
    o.command = argv[1] === "show" ? "config-show" : "config";
    return o;
  }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith("-") && v !== "-")) throw new UsageError("needsValue", { option: flag });
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-h": case "--help": o.help = true; break;
      case "-V": case "--version": o.version = true; break;
      case "--json": o.json = true; break;
      case "--throttle": o.throttle = true; break;
      case "--injection": o.injection = true; break;
      case "-v": case "--verbose": o.verbose = true; break;
      case "-s": case "--silent": o.silent = true; break;
      case "--ascii": o.ascii = true; break;
      case "--unicode": o.unicode = true; break;
      case "--no-color": o.noColor = true; break;
      case "--no-progress": o.noProgress = true; break;
      case "--no-reference": o.noReference = true; break;
      case "-f": case "--file": o.file = value(i++, a); break;
      case "--lang": o.lang = value(i++, a); break;
      case "--config": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) o.command = "config"; // bare --config = interactive setup
        else o.config = argv[++i];
        break;
      }
      case "--reference": {
        if (value(i++, a) !== "globalping") throw new UsageError("badReference");
        o.reference = "globalping";
        break;
      }
      case "-c": case "--concurrency": {
        const n = Number(value(i++, a));
        if (!Number.isInteger(n) || n < 1) throw new UsageError("needsPositiveInt", { option: a });
        o.concurrency = n;
        break;
      }
      default:
        if (a.startsWith("-") && a !== "-") throw new UsageError("unknownOption", { option: a });
        o.targets.push(a);
    }
  }
  o.singleInput = o.targets.length === 1 && o.file === undefined;
  return o;
}

/** One target per line; blank lines and `#` comments are ignored. */
export function parseTargetList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}
