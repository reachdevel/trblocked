import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, parseTargetList, UsageError } from "../src/args.ts";
import type { BatchEvent } from "../src/batch.ts";
import { ASCII_SYMBOLS, createTranslator, UNICODE_SYMBOLS } from "../src/i18n.ts";
import type { CheckResult } from "../src/types.ts";
import { bar, clip, colorEnabled, formatResults, formatWarnings, LiveRegion, makeStyle, Progress, renderLive } from "../src/ui.ts";

const plain = makeStyle(false);
const en = createTranslator("en");
const tr = createTranslator("tr");
const base = { style: plain, sym: UNICODE_SYMBOLS, tr: en };
const result = (over: Partial<CheckResult>): CheckResult => ({
  target: "x", host: "x", blocked: false, status: "accessible", types: [], confidence: "high", evidence: { ips: [] }, notes: [], ...over,
});

test("parseArgs: flags, values, targets", () => {
  const o = parseArgs(["a.com", "-c", "4", "--throttle", "-v", "b.com", "--reference", "globalping", "--json", "-f", "list.txt", "--lang", "en", "-s", "--no-reference"]);
  assert.deepEqual(o.targets, ["a.com", "b.com"]);
  assert.equal(o.concurrency, 4);
  assert.ok(o.throttle && o.verbose && o.json && o.silent && o.noReference);
  assert.equal(o.reference, "globalping");
  assert.equal(o.file, "list.txt");
  assert.equal(o.lang, "en");
  assert.equal(o.singleInput, false);
  assert.equal(parseArgs(["a.com"]).singleInput, true);
  assert.deepEqual([parseArgs(["--ascii"]).ascii, parseArgs(["--unicode"]).unicode, parseArgs([]).ascii], [true, true, false]);
});

test("parseArgs: config subcommand and bare --config start the wizard; --config <file> stays an override", () => {
  assert.equal(parseArgs(["config"]).command, "config");
  assert.equal(parseArgs(["config", "show"]).command, "config-show");
  assert.equal(parseArgs(["--config"]).command, "config");
  assert.equal(parseArgs(["a.com", "--config", "--json"]).command, "config");
  const o = parseArgs(["a.com", "--config", "my.json"]);
  assert.equal(o.command, undefined);
  assert.equal(o.config, "my.json");
});

test("parseArgs: usage errors carry a catalog code", () => {
  const code = (argv: string[]) => {
    try {
      parseArgs(argv);
    } catch (e) {
      return e instanceof UsageError ? e.note.code : "other";
    }
  };
  assert.equal(code(["--bogus"]), "error.unknownOption");
  assert.equal(code(["-c", "0"]), "error.needsPositiveInt");
  assert.equal(code(["-f"]), "error.needsValue");
  assert.equal(code(["--reference", "x"]), "error.badReference");
});

test("parseTargetList ignores blanks and comments", () => {
  assert.deepEqual(parseTargetList("a.com\n\n# note\n  b.com  # trailing\r\nc.com"), ["a.com", "b.com", "c.com"]);
});

test("colorEnabled honors NO_COLOR, FORCE_COLOR, TTY", () => {
  assert.equal(colorEnabled({ isTTY: true }, {}), true);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled({ isTTY: true }, {}, true), false);
  assert.equal(colorEnabled({ isTTY: true }, { TERM: "dumb" }), false);
});

test("clip counts visible columns and keeps escapes balanced", () => {
  const s = makeStyle(true);
  assert.equal(clip("abcdef", 3), "abc");
  const clipped = clip(s.red("abcdef"), 3);
  assert.ok(clipped.startsWith("\x1b[31mabc") && clipped.endsWith("\x1b[0m"));
  assert.equal(clip("⠹ héllo", 4), "⠹ hé");
});

test("bar renders proportional fill in both symbol sets", () => {
  assert.equal(bar(0.5, 10, UNICODE_SYMBOLS), "█████░░░░░");
  assert.equal(bar(0.5, 10, ASCII_SYMBOLS), "#####-----");
  assert.equal(bar(2, 4, UNICODE_SYMBOLS), "████");
  assert.equal(bar(-1, 4, UNICODE_SYMBOLS), "░░░░");
});

test("Progress: fraction follows stages, tolerates overlapping stages, finishes at 1", () => {
  const p = new Progress(["a", "b"]);
  const ev = (e: object): BatchEvent => e as BatchEvent;
  p.handle(ev({ type: "start", index: 0, target: "a" }));
  p.handle(ev({ type: "plan", index: 0, target: "a", stages: ["dns", "connect"] }));
  assert.equal(p.fraction, 0);
  p.handle(ev({ type: "stage", index: 0, target: "a", stage: "dns", state: "start" }));
  p.handle(ev({ type: "stage", index: 0, target: "a", stage: "connect", state: "start" }));
  assert.deepEqual(p.states[0]!.running, ["dns", "connect"]);
  p.handle(ev({ type: "stage", index: 0, target: "a", stage: "connect", state: "end" }));
  assert.deepEqual(p.states[0]!.running, ["dns"]);
  assert.equal(p.fractionOf(p.states[0]!), 0.5 + 0.25);
  p.handle(ev({ type: "done", index: 0, target: "a", result: result({}) }));
  p.handle(ev({ type: "done", index: 1, target: "b", result: result({}) }));
  assert.equal(p.fraction, 1);
  assert.equal(p.doneCount, 2);
});

test("renderLive: batch header, active rows, localized stage names, width clipping", () => {
  const p = new Progress(["one.com", "two.com", "three.com"]);
  p.handle({ type: "start", index: 0, target: "one.com" });
  p.handle({ type: "stage", index: 0, target: "one.com", stage: "connect", state: "start" });
  const o = { width: 60, frame: 0, elapsedMs: 1500, style: plain, sym: UNICODE_SYMBOLS, maxRows: 4 };
  const english = renderLive(p, { ...o, tr: en });
  assert.match(english[0]!, /Checking 3 targets/);
  assert.match(english[0]!, /0\/3/);
  assert.match(english[0]!, /1\.5s/);
  assert.match(english[1]!, /one\.com connect…/);
  assert.equal(english.length, 2);
  assert.match(renderLive(p, { ...o, tr })[0]!, /3 hedef kontrol ediliyor/);
  assert.match(renderLive(p, { ...o, tr })[1]!, /bağlantı…/);
  for (const l of renderLive(p, { ...o, width: 30, tr: en })) assert.ok(l.length <= 29);
});

test("LiveRegion redraws in place and clear() leaves nothing but a visible cursor", () => {
  const writes: string[] = [];
  const r = new LiveRegion({ write: (s) => writes.push(s) });
  r.draw(["a", "b"]);
  r.draw(["c"]);
  r.clear();
  assert.ok(writes[0]!.startsWith("\x1b[?25l") && writes[0]!.endsWith("a\nb\n"));
  assert.ok(writes[1]!.startsWith("\x1b[2F\x1b[J"));
  assert.equal(writes[2], "\x1b[1F\x1b[J\x1b[?25h");
  r.clear();
  assert.equal(writes.length, 3);
});

test("formatResults: single blocked target shows decision and notes, system note last", () => {
  const lines = formatResults(
    [
      result({
        host: "pastebin.com", status: "blocked", types: ["dns", "sni"],
        decision: "pastebin.com, 08/03/2012 ... erişime engellenmiştir.",
        notes: [{ code: "dns.blocked.blockpage-ip" }, { code: "tls.sni", params: { host: "pastebin.com", alt: "example.com" } }, { code: "dns.system.hosts", params: { host: "pastebin.com", ip: "195.175.254.2" } }],
      }),
    ],
    { ...base, verbose: false, elapsedMs: 100 },
  );
  assert.equal(lines[0], "✖ pastebin.com  blocked · dns, sni");
  assert.equal(lines[1], "    pastebin.com, 08/03/2012 ... erişime engellenmiştir.");
  assert.match(lines[2]!, /block-page IP/);
  assert.match(lines.at(-1)!, /Your \/etc\/hosts file maps pastebin\.com to 195\.175\.254\.2/);
});

test("formatResults: Turkish labels and unicode vs ascii symbols", () => {
  const r = [result({ host: "a.com" }), result({ host: "b.com", status: "blocked", types: ["throttle"], confidence: "medium" })];
  const t = formatResults(r, { ...base, tr, verbose: false, elapsedMs: 2200 });
  assert.equal(t[0], "✔ a.com  erişilebilir");
  assert.equal(t[1], "✖ b.com  engelli · yavaşlatma (güven: orta)");
  assert.match(t.at(-1)!, /^2 kontrol edildi · 1 engelli · 1 erişilebilir · 0 belirsiz · 2\.2s$/);
  const a = formatResults(r, { ...base, sym: ASCII_SYMBOLS, tr, verbose: false, elapsedMs: 0 });
  assert.equal(a[0], "+ a.com  erişilebilir"); // text is untouched here; the CLI transliterates at write time
  assert.ok(a[1]!.startsWith("x b.com"));
});

test("formatResults: batch is compact, aligned, with a summary and no notes", () => {
  const lines = formatResults(
    [
      result({ host: "example.com", notes: [{ code: "throttle.none", params: { real: "1", control: "1", ratio: "1" } }] }),
      result({ host: "pastebin.com", status: "blocked", types: ["dns"], confidence: "medium", notes: [{ code: "dns.blocked.blockpage-ip" }] }),
      result({ host: "nx.test", status: "inconclusive", confidence: "low", notes: [{ code: "dns.hostMissing" }] }),
    ],
    { ...base, verbose: false, elapsedMs: 2200 },
  );
  assert.deepEqual(lines, [
    "✔ example.com   accessible",
    "✖ pastebin.com  blocked · dns (medium confidence)",
    "? nx.test       inconclusive · This host does not exist (NXDOMAIN from DoH).",
    "",
    "3 checked · 1 blocked · 1 accessible · 1 inconclusive · 2.2s",
  ]);
  assert.ok(formatResults([result({ notes: [{ code: "connect.noIps" }] }), result({})], { ...base, verbose: true, elapsedMs: 0 }).includes("    · No usable IP addresses to test."));
});

test("formatResults: a single inconclusive target lists its reasons below; a batch line is cut to the terminal width", () => {
  const long = result({ host: "only-http.example", status: "inconclusive", confidence: "low", notes: [{ code: "tcp.timeout" }, { code: "ref.inconclusive", params: { provider: "g", detail: "d" } }] });
  const single = formatResults([long], { ...base, verbose: false, elapsedMs: 0 });
  assert.equal(single[0], "? only-http.example  inconclusive");
  assert.match(single[1]!, /^    · TCP connections time out/);
  assert.equal(single.length, 3);
  const batch = formatResults([long, result({ host: "ok.test" })], { ...base, verbose: false, elapsedMs: 0, width: 50 });
  assert.ok(batch[0]!.length <= 49, `cut to width: ${batch[0]!.length}`);
});

test("formatWarnings renders a labelled line per warning", () => {
  const w = formatWarnings([{ code: "env.hotspot", params: { kind: { code: "env.hotspot.ios" } } }], { style: plain, sym: UNICODE_SYMBOLS, tr });
  assert.match(w[0]!, /^⚠ uyarı: Telefon hotspot'una bağlı görünüyorsun \(iPhone\)/);
});
