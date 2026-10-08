import type { BatchEvent } from "./batch.ts";
import type { Symbols, Translator } from "./i18n.ts";
import type { CheckResult, Note, Stage } from "./types.ts";

// ---------- styling ----------

export interface Style {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { enabled, bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

/** NO_COLOR / --no-color win, then FORCE_COLOR, then "is this a real terminal". */
export function colorEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv, noColorFlag = false): boolean {
  if (noColorFlag || (env.NO_COLOR !== undefined && env.NO_COLOR !== "")) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return !!stream.isTTY && env.TERM !== "dumb";
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** Cut `s` to `width` visible columns, keeping escape sequences intact (and closing styles). */
export function clip(s: string, width: number): string {
  let out = "";
  let visible = 0;
  let sawEscape = false;
  for (let i = 0; i < s.length; ) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m) {
      out += m[0];
      sawEscape = true;
      i += m[0].length;
      continue;
    }
    if (visible >= width) break;
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    visible++;
    i += ch.length;
  }
  return sawEscape ? out + "\x1b[0m" : out;
}

export function bar(fraction: number, width: number, sym: Pick<Symbols, "barFull" | "barEmpty">): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return sym.barFull.repeat(filled) + sym.barEmpty.repeat(width - filled);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// ---------- progress model ----------

export interface TargetState {
  target: string;
  stages: Stage[];
  ended: number;
  running: Stage[];
  started: boolean;
  done: boolean;
}

export class Progress {
  readonly states: TargetState[];

  constructor(targets: readonly string[]) {
    this.states = targets.map((target) => ({ target, stages: [], ended: 0, running: [], started: false, done: false }));
  }

  handle(e: BatchEvent): void {
    const s = this.states[e.index];
    if (!s) return;
    if (e.type === "start") s.started = true;
    else if (e.type === "plan") s.stages = e.stages;
    else if (e.type === "stage") {
      if (e.state === "start") s.running.push(e.stage);
      else {
        s.running = s.running.filter((x) => x !== e.stage);
        s.ended++;
      }
    } else if (e.type === "done") {
      s.done = true;
      s.running = [];
    }
  }

  get doneCount(): number {
    return this.states.filter((s) => s.done).length;
  }

  fractionOf(s: TargetState): number {
    if (s.done) return 1;
    if (s.stages.length === 0) return 0;
    return Math.min(1, (s.ended + (s.running.length > 0 ? 0.5 : 0)) / s.stages.length);
  }

  get fraction(): number {
    return this.states.length === 0 ? 1 : this.states.reduce((sum, s) => sum + this.fractionOf(s), 0) / this.states.length;
  }
}

export interface LiveOptions {
  width: number;
  frame: number;
  elapsedMs: number;
  style: Style;
  sym: Symbols;
  tr: Translator;
  /** Max lines for the whole live region. */
  maxRows: number;
}

/** Pure: the lines of the live region for the current progress. */
export function renderLive(p: Progress, o: LiveOptions): string[] {
  const { style: c, sym, tr } = o;
  const spin = c.cyan(sym.spinner[o.frame % sym.spinner.length]!);
  const pct = `${Math.floor(p.fraction * 100)}%`.padStart(4);
  const barWidth = Math.max(10, Math.min(30, o.width - 50));
  const stageText = (running: Stage[]) => running.map((s) => tr.t(`stage.${s}`)).join(" + ");
  const lines: string[] = [];

  if (p.states.length === 1) {
    const s = p.states[0]!;
    const stage = s.running.length ? c.dim(`  ${stageText(s.running)}${sym.ellipsis}`) : "";
    lines.push(`${spin} ${c.bold(s.target)}  ${c.cyan(bar(p.fraction, barWidth, sym))}${pct}${stage}`);
  } else {
    lines.push(
      `${spin} ${c.bold(tr.t("ui.checking", { n: p.states.length }))}  ${c.cyan(bar(p.fraction, barWidth, sym))}${pct}  ${c.dim(`${p.doneCount}/${p.states.length}`)}  ${c.dim(seconds(o.elapsedMs))}`,
    );
    const active = p.states.filter((s) => s.started && !s.done).slice(0, Math.max(0, o.maxRows - 1));
    for (const s of active) lines.push(`  ${c.dim(sym.dot)} ${s.target} ${c.dim(s.running.length ? `${stageText(s.running)}${sym.ellipsis}` : "")}`);
  }
  return lines.slice(0, o.maxRows).map((l) => clip(l, Math.max(10, o.width - 1)));
}

/** Redraws a block of lines in place on a TTY stream; leaves nothing behind on clear(). */
export class LiveRegion {
  private lines = 0;
  private cursorHidden = false;
  private readonly out: { write(s: string): unknown };

  constructor(out: { write(s: string): unknown }) {
    this.out = out;
  }

  draw(lines: string[]): void {
    let buf = this.cursorHidden ? "" : "\x1b[?25l";
    this.cursorHidden = true;
    if (this.lines > 0) buf += `\x1b[${this.lines}F`;
    buf += `\x1b[J${lines.join("\n")}\n`;
    this.lines = lines.length;
    this.out.write(buf);
  }

  clear(): void {
    let buf = "";
    if (this.lines > 0) buf += `\x1b[${this.lines}F\x1b[J`;
    if (this.cursorHidden) buf += "\x1b[?25h";
    this.lines = 0;
    this.cursorHidden = false;
    if (buf) this.out.write(buf);
  }
}

// ---------- final output ----------

export interface FormatOptions {
  style: Style;
  sym: Symbols;
  tr: Translator;
  /** Print every note for every target (otherwise notes only for a single non-accessible target). */
  verbose: boolean;
  elapsedMs: number;
  /** Terminal width: long inline reasons in a batch are cut to it (omit when output is not a terminal). */
  width?: number;
}

export function formatResults(results: CheckResult[], o: FormatOptions): string[] {
  const { style: c, sym, tr } = o;
  const single = results.length === 1;
  const hostWidth = Math.min(40, Math.max(...results.map((r) => r.host.length), 0));
  const lines: string[] = [];

  for (const r of results) {
    const host = r.host.length > hostWidth ? `${r.host.slice(0, hostWidth - 1)}${sym.ellipsis}` : r.host.padEnd(hostWidth);
    let icon: string;
    let text: string;
    if (r.status === "blocked") {
      icon = c.red(sym.bad);
      text = c.red(`${tr.t("status.blocked")}${sym.sep}${r.types.map((t) => tr.t(`type.${t}`)).join(", ")}`);
    } else if (r.status === "accessible") {
      icon = c.green(sym.ok);
      text = c.green(tr.t("status.accessible"));
    } else {
      icon = c.yellow(sym.unknown);
      // A single target gets its reasons below; in a batch the first one rides on the line (cut to the width).
      text = c.yellow(tr.t("status.inconclusive")) + (!single && r.notes[0] ? c.dim(`${sym.sep}${tr.note(r.notes[0])}`) : "");
    }
    const conf =
      r.status !== "inconclusive" && r.confidence !== "high"
        ? c.dim(` ${tr.t("ui.confidence", { level: tr.t(`confidence.${r.confidence}`) })}`)
        : "";
    const line = `${icon} ${host}  ${text}${conf}`;
    lines.push(o.width ? clip(line, o.width - 1) : line);
    if (r.decision) lines.push(`    ${c.dim(r.decision)}`);

    const showNotes = o.verbose || (single && r.status !== "accessible");
    if (showNotes) {
      for (const n of r.notes) lines.push(`    ${c.dim(`${sym.dot} ${tr.note(n)}`)}`);
    }
  }

  if (!single) {
    const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
    const part = (n: number, key: string, paint: (s: string) => string) => (n > 0 ? paint(tr.t(key, { n })) : c.dim(tr.t(key, { n })));
    lines.push(
      "",
      [
        c.bold(tr.t("ui.summary.checked", { n: results.length })),
        part(count("blocked"), "ui.summary.blocked", c.red),
        part(count("accessible"), "ui.summary.accessible", c.green),
        part(count("inconclusive"), "ui.summary.inconclusive", c.yellow),
        c.dim(seconds(o.elapsedMs)),
      ].join(c.dim(sym.sep)),
    );
  }
  return lines;
}

export function formatWarnings(warnings: Note[], o: { style: Style; sym: Symbols; tr: Translator }): string[] {
  return warnings.map((w) => `${o.style.yellow(`${o.sym.warn} ${o.tr.t("ui.warning")}:`)} ${o.tr.note(w)}`);
}
