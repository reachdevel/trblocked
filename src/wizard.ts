import { createInterface, emitKeypressEvents } from "node:readline";
import { availableLocales, createTranslator, readCatalog } from "./i18n.ts";
import type { Symbols } from "./i18n.ts";
import type { ConfigFile } from "./config.ts";
import type { Style } from "./ui.ts";

export interface WizardIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: { write(s: string): unknown; columns?: number };
}

/** Terminal rows a block of lines occupies once long lines wrap (cursor-up must count rows, not lines). */
export function physicalRows(lines: string[], columns: number): number {
  const visible = (l: string) => [...l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")].length;
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil(visible(l) / Math.max(1, columns))), 0);
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

interface Option<T> {
  label: string;
  value: T;
}

interface Look {
  style: Style;
  sym: Symbols;
  hint: string;
}

/** Arrow-key list on a TTY (collapses to one answer line when done); numbered prompt otherwise. */
export interface Selector {
  select<T>(title: string, options: Option<T>[], defaultIndex: number, look: Look): Promise<T>;
  close(): void;
}

function ttySelector(io: WizardIO): Selector {
  const { input, output } = io;
  emitKeypressEvents(input);
  return {
    close() {},
    select<T>(title: string, options: Option<T>[], defaultIndex: number, look: Look): Promise<T> {
      const { style: c, sym } = look;
      let idx = defaultIndex;
      let drawn = 0;
      const draw = () => {
        const lines = [`${c.bold(title)} ${c.dim(`(${look.hint})`)}`, ...options.map((o, i) => (i === idx ? `${c.cyan(sym.pointer)} ${c.cyan(o.label)}` : `  ${o.label}`))];
        output.write(`${drawn ? `\x1b[${drawn}F` : ""}\x1b[J${lines.join("\n")}\n`);
        drawn = physicalRows(lines, output.columns || 80);
      };
      input.setRawMode?.(true);
      input.resume();
      draw();
      return new Promise<T>((resolve, reject) => {
        const finish = (fn: () => void) => {
          input.off("keypress", onKey);
          input.setRawMode?.(false);
          input.pause();
          fn();
        };
        const onKey = (_: string | undefined, key?: { name?: string; ctrl?: boolean }) => {
          if (!key) return;
          if (key.ctrl && key.name === "c") return finish(() => reject(new Cancelled()));
          if (key.name === "up") idx = (idx - 1 + options.length) % options.length;
          else if (key.name === "down") idx = (idx + 1) % options.length;
          else if (key.name === "return") {
            return finish(() => {
              output.write(`\x1b[${drawn}F\x1b[J${c.green(sym.ok)} ${title} ${c.cyan(options[idx]!.label)}\n`);
              resolve(options[idx]!.value);
            });
          } else return;
          draw();
        };
        input.on("keypress", onKey);
      });
    },
  };
}

function lineSelector(io: WizardIO): Selector {
  const rl = createInterface({ input: io.input });
  const lines = rl[Symbol.asyncIterator]();
  return {
    close: () => rl.close(),
    async select<T>(title: string, options: Option<T>[], defaultIndex: number): Promise<T> {
      io.output.write(`${title}\n${options.map((o, i) => `  ${i + 1}) ${o.label}${i === defaultIndex ? " *" : ""}`).join("\n")}\n> `);
      const { value } = await lines.next();
      const n = Number(String(value ?? "").trim());
      const picked = Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defaultIndex;
      io.output.write(`${options[picked]!.label}\n`);
      return options[picked]!.value;
    },
  };
}

export interface WizardOptions {
  existing: ConfigFile;
  /** Locale highlighted by default in the first question. */
  currentLocale: string;
  style: Style;
  sym: Symbols;
}

/** Asks for language, outside check and warnings; returns `existing` updated (nothing is written here). */
export async function runWizard(io: WizardIO, o: WizardOptions): Promise<{ config: ConfigFile; locale: string }> {
  const selector = io.input.isTTY && io.input.setRawMode ? ttySelector(io) : lineSelector(io);
  try {
    const locales = availableLocales();
    const first = createTranslator(o.currentLocale);
    const look = (hint: string): Look => ({ style: o.style, sym: o.sym, hint });

    const locale = await selector.select(
      first.t("wizard.lang.q"),
      locales.map((l) => ({ label: String(readCatalog(l)["meta.name"] ?? l), value: l })),
      Math.max(0, locales.indexOf(o.currentLocale)),
      look(first.t("wizard.hint")),
    );
    const tr = createTranslator(locale);
    const yesNo = [
      { label: tr.t("wizard.yes"), value: true },
      { label: tr.t("wizard.no"), value: false },
    ];
    const reference = await selector.select(tr.t("wizard.reference.q"), yesNo, o.existing.reference?.enabled === false ? 1 : 0, look(tr.t("wizard.hint")));
    const warnings = await selector.select(tr.t("wizard.warnings.q"), yesNo, o.existing.cli?.warnings === false ? 1 : 0, look(tr.t("wizard.hint")));

    return {
      locale,
      config: {
        ...o.existing,
        cli: { ...o.existing.cli, lang: locale, warnings },
        reference: { ...o.existing.reference, enabled: reference },
      },
    };
  } finally {
    selector.close();
  }
}
