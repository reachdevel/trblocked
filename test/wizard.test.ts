import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../src/i18n.ts";
import { makeStyle } from "../src/ui.ts";
import { Cancelled, physicalRows, runWizard } from "../src/wizard.ts";

const style = makeStyle(false);
const sink = () => {
  const chunks: string[] = [];
  return { write: (s: string) => chunks.push(s), text: () => chunks.join("") };
};

test("numbered mode (piped stdin): answers become settings, language switches the next prompts", async () => {
  const input = new PassThrough();
  input.end("1\n2\n2\n"); // lang #1 (en), outside check: No, warnings: No
  const out = sink();
  const { config, locale } = await runWizard({ input, output: out }, { existing: {}, currentLocale: "tr", style, sym: UNICODE_SYMBOLS });
  assert.equal(locale, "en");
  assert.deepEqual(config, { cli: { lang: "en", warnings: false }, reference: { enabled: false } });
  assert.match(out.text(), /Dil \/ Language/); // first question follows the current locale (tr)
  assert.match(out.text(), /Confirm suspected IP blocks/); // English prompt after choosing English
});

test("numbered mode: empty or invalid answers keep the defaults (current locale, yes, yes)", async () => {
  const input = new PassThrough();
  input.end("\nnonsense\n\n");
  const { config, locale } = await runWizard({ input, output: sink() }, { existing: {}, currentLocale: "tr", style, sym: UNICODE_SYMBOLS });
  assert.equal(locale, "tr");
  assert.deepEqual(config, { cli: { lang: "tr", warnings: true }, reference: { enabled: true } });
});

test("existing settings are preserved and used as defaults", async () => {
  const input = new PassThrough();
  input.end("\n\n\n");
  const existing = { throttle: { enabled: true }, cli: { warnings: false }, reference: { enabled: false } } as const;
  const { config } = await runWizard({ input, output: sink() }, { existing, currentLocale: "en", style, sym: ASCII_SYMBOLS });
  assert.equal(config.throttle?.enabled, true);
  assert.equal(config.cli?.warnings, false); // default index followed the saved "No"
  assert.equal(config.reference?.enabled, false);
});

test("arrow-key mode on a TTY: Down/Enter selects, collapses to one answer line, restores raw mode", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[], setRawMode(m: boolean) { this.raw.push(m); } });
  const out = sink();
  const done = runWizard({ input, output: out }, { existing: {}, currentLocale: "tr", style, sym: UNICODE_SYMBOLS });
  const press = (seq: string) => new Promise<void>((r) => setImmediate(() => (input.write(seq), r())));
  // Q1 languages are sorted [en, tr]; default is tr (index 1). Up -> en, Enter.
  await press("\x1b[A"); await press("\r");
  // Q2 outside check: default Yes. Down -> No, Enter.
  await press("\x1b[B"); await press("\r");
  // Q3 warnings: Enter keeps Yes.
  await press("\r");
  const { config } = await done;
  assert.deepEqual(config, { cli: { lang: "en", warnings: true }, reference: { enabled: false } });
  assert.deepEqual(input.raw, [true, false, true, false, true, false]);
  assert.match(out.text(), /✔ Dil \/ Language English/); // collapsed summary line
});

test("Ctrl-C in arrow-key mode rejects with Cancelled", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const done = runWizard({ input, output: sink() }, { existing: {}, currentLocale: "en", style, sym: UNICODE_SYMBOLS });
  setImmediate(() => input.write("\x03"));
  await assert.rejects(done, Cancelled);
});

test("physicalRows counts wrapped rows, ignoring colour codes", () => {
  assert.equal(physicalRows(["abc", "defgh"], 80), 2);
  assert.equal(physicalRows(["x".repeat(81)], 80), 2);
  assert.equal(physicalRows(["x".repeat(80)], 80), 1);
  assert.equal(physicalRows(["\x1b[31m" + "x".repeat(10) + "\x1b[0m", ""], 5), 3);
});

test("redraw on a narrow terminal moves up by wrapped rows, not by line count", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const writes: string[] = [];
  const output = { columns: 30, write: (s: string) => writes.push(s) };
  const done = runWizard({ input, output }, { existing: {}, currentLocale: "en", style, sym: UNICODE_SYMBOLS });
  const press = (seq: string) => new Promise<void>((r) => setImmediate(() => (input.write(seq), r())));
  await press("\x1b[B"); // redraw of the (long) language title
  const cursorUps = writes.map((w) => /\x1b\[(\d+)F/.exec(w)?.[1]).filter(Boolean).map(Number);
  assert.ok(cursorUps[0]! >= 3, `language block (title wraps at 30 cols) is ${cursorUps[0]} rows`);
  await press("\x03");
  await assert.rejects(done, Cancelled);
});
