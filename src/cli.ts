#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs, parseTargetList, UsageError } from "./args.ts";
import type { CliOptions } from "./args.ts";
import { checkMany } from "./batch.ts";
import { ConfigFileError, loadConfigFile, loadUserConfig, mergeOverrides, resolveConfig, saveUserConfig, userConfigPath } from "./config.ts";
import type { ConfigFile } from "./config.ts";
import { detectEnvironment } from "./env.ts";
import { asciify, ASCII_SYMBOLS, availableLocales, createTranslator, resolveLocale, terminalSupportsUnicode, UNICODE_SYMBOLS } from "./i18n.ts";
import type { Translator } from "./i18n.ts";
import type { Note } from "./types.ts";
import { GlobalpingProbe } from "./reference/globalping.ts";
import { colorEnabled, formatResults, formatWarnings, LiveRegion, makeStyle, Progress, renderLive } from "./ui.ts";
import { Cancelled, runWizard } from "./wizard.ts";

const env = process.env;
let unicode = terminalSupportsUnicode(env); // refined once flags and saved settings are known
let sym = unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
/** Turkish letters survive on UTF-8 terminals; on limited ones they are transliterated rather than shown as garbage. */
const fmt = (s: string) => (unicode ? s : asciify(s));

/** Resolve once the stream has flushed, so process.exit never truncates piped output. */
const write = (stream: NodeJS.WriteStream, text: string) => new Promise<void>((resolve) => stream.write(`${fmt(text)}\n`, () => resolve()));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A config file problem: the first note is the headline, the rest are listed under it. */
async function reportConfigError(err: ConfigFileError, tr: Translator): Promise<number> {
  const [head, ...rest] = err.notes as [Note, ...Note[]];
  await write(process.stderr, tr.note(head));
  for (const n of rest) await write(process.stderr, `  ${sym.dot} ${tr.note(n)}`);
  return 2;
}

/** The version of the installed package (package.json is always shipped next to dist/). */
function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

async function main(): Promise<number> {
  if (process.argv.slice(2).some((a) => a === "-V" || a === "--version")) {
    await write(process.stdout, `trblocked ${packageVersion()}`);
    return 0;
  }
  let user: ConfigFile;
  try {
    user = loadUserConfig();
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
    return reportConfigError(err, createTranslator(resolveLocale({ env }))); // the saved language is unusable here
  }
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.lang && !availableLocales().includes(opts.lang.toLowerCase())) {
      throw new UsageError("unsupportedLang", { lang: opts.lang, available: availableLocales().join(", ") });
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    const tr = createTranslator(resolveLocale({ saved: user.cli?.lang, env }));
    await write(process.stderr, tr.note(err.note));
    return 2;
  }

  // --ascii / --unicode > saved cli.charset > auto-detection.
  const charset = opts.ascii ? "ascii" : opts.unicode ? "unicode" : user.cli?.charset ?? "auto";
  if (charset !== "auto") unicode = charset === "unicode";
  sym = unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;

  const locale = resolveLocale({ flag: opts.lang, saved: user.cli?.lang, env });
  const tr = createTranslator(locale);
  const errStyle = makeStyle(colorEnabled(process.stderr, env, opts.noColor));
  const outStyle = makeStyle(colorEnabled(process.stdout, env, opts.noColor));

  if (opts.help) {
    await write(process.stdout, tr.t("help"));
    return 0;
  }

  // ---- config subcommand ----
  if (opts.command === "config-show") {
    const path = userConfigPath(env);
    const saved = loadUserConfig(path);
    await write(process.stdout, Object.keys(saved).length ? `${tr.t("wizard.show", { path })}\n${JSON.stringify(saved, null, 2)}` : tr.t("wizard.none"));
    return 0;
  }
  if (opts.command === "config") {
    try {
      const { config, locale: chosen } = await runWizard({ input: process.stdin, output: process.stderr }, { existing: user, currentLocale: locale, style: errStyle, sym });
      const path = userConfigPath(env);
      saveUserConfig(config, path);
      await write(process.stdout, createTranslator(chosen).t("wizard.saved", { path }));
      return 0;
    } catch (err) {
      if (err instanceof Cancelled) return 130;
      throw err;
    }
  }

  // ---- targets ----
  const targets = [...opts.targets];
  if (opts.file) {
    try {
      targets.push(...parseTargetList(opts.file === "-" ? await readStdin() : readFileSync(opts.file, "utf8")));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      await write(process.stderr, tr.t(code === "ENOENT" ? "error.fileNotFound" : "error.fileUnreadable", { path: opts.file, message: err instanceof Error ? err.message : String(err) }));
      return 2;
    }
  }
  if (targets.length === 0) {
    await write(process.stderr, tr.t("help"));
    return 2;
  }

  // Precedence: defaults < user config < --config file < flags.
  let fileConfig: ConfigFile = {};
  if (opts.config) {
    try {
      fileConfig = loadConfigFile(opts.config);
    } catch (err) {
      if (!(err instanceof ConfigFileError)) throw err;
      return reportConfigError(err, tr);
    }
  }
  const flagConfig: ConfigFile = {
    ...(opts.throttle ? { throttle: { enabled: true } } : {}),
    ...(opts.injection ? { http: { injection: { enabled: true } } } : {}),
  };
  const { cli = {}, ...engine } = mergeOverrides<ConfigFile>(user, fileConfig, flagConfig);
  const cfg = resolveConfig(engine);
  const useReference = opts.noReference ? false : opts.reference ? true : cfg.reference.enabled;
  const reference = useReference ? new GlobalpingProbe({ ...cfg.reference.globalping, token: env.GLOBALPING_TOKEN }) : undefined;

  // ---- environment warnings (VPN, hotspot) ----
  const environment = cli.warnings !== false && !opts.silent ? await detectEnvironment(cfg.controlTarget.host) : undefined;
  if (environment?.warnings.length) {
    for (const line of formatWarnings(environment.warnings, { style: errStyle, sym, tr })) await write(process.stderr, line);
  }

  // Progress lives on stderr so stdout stays clean for pipes; it only shows on a real terminal.
  const live = process.stderr.isTTY && !opts.noProgress && !opts.silent && env.TERM !== "dumb";
  const region = new LiveRegion(process.stderr);
  const progress = new Progress(targets);
  const started = Date.now();
  let frame = 0;
  const draw = () =>
    region.draw(
      renderLive(progress, {
        width: process.stderr.columns || 80,
        frame: frame++,
        elapsedMs: Date.now() - started,
        style: errStyle,
        sym,
        tr,
        maxRows: Math.max(1, Math.min(6, (process.stderr.rows || 24) - 4)),
      }).map(fmt),
    );
  const timer = live ? setInterval(draw, 80) : undefined;
  if (live) {
    draw();
    process.once("SIGINT", () => {
      region.clear();
      process.exit(130);
    });
  }

  let results;
  try {
    results = await checkMany(targets, { concurrency: opts.concurrency, config: engine, reference, onEvent: (e) => progress.handle(e) });
  } finally {
    clearInterval(timer);
    if (live) region.clear();
  }
  if (environment?.warnings.length) for (const r of results) r.warnings = environment.warnings;

  if (opts.json) {
    await write(process.stdout, JSON.stringify(opts.singleInput ? results[0] : results, null, 2));
  } else {
    await write(process.stdout, formatResults(results, { style: outStyle, sym, tr, verbose: opts.verbose, elapsedMs: Date.now() - started, width: process.stdout.isTTY ? process.stdout.columns : undefined }).join("\n"));
  }
  if (results.some((r) => r.status === "blocked")) return 1;
  return results.some((r) => r.status === "inconclusive") ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
