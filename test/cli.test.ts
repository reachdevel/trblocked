import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testCert } from "./helpers/tls-cert.ts";

const { key, cert } = testCert();
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function run(args: string[], env: Record<string, string | undefined>, stdin = ""): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" };
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    child.stdin.end(stdin);
  });
}

const UTF8_TR = { LANG: "tr_TR.UTF-8" };
const xdg = () => ({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "isb-xdg-")) });

test("--help follows the system language, --lang beats it", async () => {
  const x = xdg();
  assert.match((await run(["--help"], { ...x, ...UTF8_TR })).out, /^Kullanım: trblocked/);
  assert.match((await run(["--help"], { ...x, LANG: "en_US.UTF-8" })).out, /^Usage: trblocked/);
  assert.match((await run(["--help", "--lang", "en"], { ...x, ...UTF8_TR })).out, /^Usage: trblocked/);
  assert.match((await run(["--help"], { ...x, TRBLOCKED_LANG: "en", ...UTF8_TR })).out, /^Usage: trblocked/);
});

test("a C/unset locale does NOT downgrade the output: Turkish letters stay (regression: iTerm users saw ASCII)", async () => {
  for (const env of [{ LANG: "C" }, { LC_ALL: "C" }, {}]) {
    const r = await run(["--help", "--lang", "tr"], { ...xdg(), ...env });
    assert.match(r.out, /^Kullanım: trblocked/, JSON.stringify(env));
    assert.match(r.out, /Türkiye'de engelli/);
  }
});

test("limited terminals get ASCII: legacy charset, TERM=linux, --ascii, saved cli.charset; --unicode overrides", async () => {
  const pureAscii = (s: string) => assert.ok(!/[^\x00-\x7f]/.test(s), "output must be pure ASCII");
  const legacy = await run(["--help", "--lang", "tr"], { ...xdg(), LANG: "tr_TR.ISO8859-9" });
  assert.match(legacy.out, /^Kullanim: trblocked/);
  assert.match(legacy.out, /Sitelerin Turkiye'de engelli/);
  pureAscii(legacy.out);

  pureAscii((await run(["--help", "--lang", "tr"], { ...xdg(), TERM: "linux", LANG: "tr_TR.UTF-8" })).out);
  pureAscii((await run(["--help", "--lang", "tr", "--ascii"], { ...xdg(), ...UTF8_TR })).out);
  assert.match((await run(["--help", "--lang", "tr", "--unicode"], { ...xdg(), LANG: "tr_TR.ISO8859-9" })).out, /^Kullanım:/);

  const x = xdg();
  mkdirSync(join(x.XDG_CONFIG_HOME, "trblocked"), { recursive: true });
  writeFileSync(join(x.XDG_CONFIG_HOME, "trblocked", "config.json"), JSON.stringify({ cli: { charset: "ascii", lang: "tr" } }));
  pureAscii((await run(["--help"], { ...x, ...UTF8_TR })).out);
  assert.match((await run(["--help", "--unicode"], { ...x, ...UTF8_TR })).out, /^Kullanım:/); // flag beats saved setting
});

test("usage errors are localized and exit 2", async () => {
  const x = xdg();
  const tr = await run(["--bogus"], { ...x, ...UTF8_TR });
  assert.equal(tr.code, 2);
  assert.equal(tr.err.trim(), "Bilinmeyen seçenek: --bogus");
  assert.equal((await run(["--bogus"], { ...x, LANG: "en_US.UTF-8" })).err.trim(), "Unknown option: --bogus");
  assert.match((await run(["--lang", "xx", "a.com"], { ...x, ...UTF8_TR })).err, /Desteklenmeyen dil "xx" \(mevcut: en, tr\)/);
});

test("config: wizard (numbered stdin) saves settings, show prints them, later runs use the saved language", async () => {
  const x = xdg();
  const none = await run(["config", "show"], { ...x, ...UTF8_TR });
  assert.match(none.out, /Henüz kayıtlı ayar yok/);

  const set = await run(["config"], { ...x, LANG: "en_US.UTF-8" }, "1\n2\n2\n"); // en, outside check No, warnings No
  assert.equal(set.code, 0);
  assert.match(set.out, /^Saved to .*trblocked\/config\.json$/m);

  const shown = JSON.parse((await run(["config", "show"], { ...x, ...UTF8_TR })).out.split("\n").slice(1).join("\n"));
  assert.deepEqual(shown, { cli: { lang: "en", warnings: false }, reference: { enabled: false } });

  // saved language wins over the (Turkish) system language
  assert.match((await run(["--help"], { ...x, ...UTF8_TR })).out, /^Usage:/);
  // bare --config is the same wizard
  assert.match((await run(["--config"], { ...x, ...UTF8_TR }, "2\n\n\n")).out, /^Saved to|kaydedildi/m);
});

test("end to end against a local TLS server: Turkish and English verdicts, JSON shape, exit codes", async () => {
  const control = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
  const web = https.createServer({ key, cert }, (_q, res) => res.end("ok"));
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  try {
    const dir = mkdtempSync(join(tmpdir(), "isb-cfg-"));
    const cfgPath = join(dir, "c.json");
    writeFileSync(cfgPath, JSON.stringify({
      controlTarget: { host: "127.0.0.1", port: (control.address() as net.AddressInfo).port },
      reference: { enabled: false },
      cli: { warnings: false },
    }));
    const target = `https://127.0.0.1:${(web.address() as net.AddressInfo).port}`;
    const x = xdg();

    const trRun = await run([target, "--config", cfgPath], { ...x, ...UTF8_TR });
    assert.equal(trRun.code, 0);
    assert.match(trRun.out, /✔ 127\.0\.0\.1  erişilebilir/);

    const enRun = await run([target, "--config", cfgPath, "--lang", "en"], { ...x, ...UTF8_TR });
    assert.match(enRun.out, /✔ 127\.0\.0\.1  accessible/);

    const asciiRun = await run([target, "--config", cfgPath], { ...x, LANG: "tr_TR.ISO8859-9", TRBLOCKED_LANG: "tr" });
    assert.match(asciiRun.out, /^\+ 127\.0\.0\.1  erisilebilir/);

    const json = JSON.parse((await run([target, "--config", cfgPath, "--json"], { ...x, ...UTF8_TR })).out);
    assert.equal(json.status, "accessible"); // one positional target -> object, not array
    assert.ok(json.evidence.ips[0].tlsAltSni === undefined || typeof json.evidence.ips[0].tlsAltSni === "object");

    const bad = await run(["http://", "--config", cfgPath], { ...x, ...UTF8_TR });
    assert.equal(bad.code, 2);
    assert.match(bad.out, /\? http:\/\/\s+belirsiz\n\s+· Geçersiz hedef: http:\/\//); // a single target gets its reason below, not on the status line
  } finally {
    control.close();
    web.close();
  }
});

test("file and config errors are localized, name the file and exit 2 (no stack traces)", async () => {
  const x = xdg();
  const dir = mkdtempSync(join(tmpdir(), "isb-err-"));
  const missing = await run(["-f", join(dir, "nope.txt"), "--lang", "tr"], x);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /^Dosya bulunamadı: .*nope\.txt$/m);

  writeFileSync(join(dir, "broken.json"), "{ nope");
  const broken = await run(["example.com", "--config", join(dir, "broken.json"), "--lang", "en"], x);
  assert.equal(broken.code, 2);
  assert.match(broken.err, /broken\.json is not valid JSON/);

  writeFileSync(join(dir, "typo.json"), JSON.stringify({ reference: { enable: true }, timeoutsMs: { dns: "fast" } }));
  const typo = await run(["example.com", "--config", join(dir, "typo.json"), "--lang", "tr"], x);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /typo\.json dosyasında sorunlar var:/);
  assert.match(typo.err, /"reference\.enable" bilinen bir ayar değil; şunu mu demek istedin: "reference\.enabled"\?/);
  assert.match(typo.err, /"timeoutsMs\.dns" sayı olmalı, metin verilmiş\./);
  assert.ok(!/node:internal|at .*\(.*:\d+:\d+\)/.test(typo.err), "no stack trace");

  // a broken saved config must not make the tool unusable silently: it says so, in the system language
  const bad = xdg();
  mkdirSync(join(bad.XDG_CONFIG_HOME, "trblocked"), { recursive: true });
  writeFileSync(join(bad.XDG_CONFIG_HOME, "trblocked", "config.json"), '{"cli":{"lang":"tr","warnings":"yes"}}');
  const saved = await run(["example.com"], { ...bad, LANG: "en_US.UTF-8" });
  assert.equal(saved.code, 2);
  assert.match(saved.err, /config\.json has problems:/);
  assert.match(saved.err, /"cli\.warnings" should be true or false, not a string\./);
});

test("--version prints the package version and nothing else, before any config is read", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  for (const flag of ["--version", "-V"]) {
    const r = await run([flag], xdg());
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), `trblocked ${pkg.version}`);
    assert.equal(r.err, "");
  }
  // a broken saved config must not stop --version from answering
  const bad = xdg();
  mkdirSync(join(bad.XDG_CONFIG_HOME, "trblocked"), { recursive: true });
  writeFileSync(join(bad.XDG_CONFIG_HOME, "trblocked", "config.json"), "{ nope");
  assert.equal((await run(["--version"], bad)).code, 0);
});
