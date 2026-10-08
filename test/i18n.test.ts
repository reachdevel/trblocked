import assert from "node:assert/strict";
import test from "node:test";
import { asciify, availableLocales, createTranslator, detectSystemLanguage, readCatalog, resolveLocale, terminalSupportsUnicode } from "../src/i18n.ts";

const placeholders = (v: string | string[]) => [...new Set([...(Array.isArray(v) ? v.join("\n") : v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

test("every locale has exactly the keys of en, with the same placeholders", () => {
  const en = readCatalog("en");
  for (const locale of availableLocales()) {
    const c = readCatalog(locale);
    assert.deepEqual(Object.keys(c).sort(), Object.keys(en).sort(), `${locale}: key mismatch`);
    for (const key of Object.keys(en)) assert.deepEqual(placeholders(c[key]!), placeholders(en[key]!), `${locale}: placeholders of ${key}`);
  }
});

test("translator interpolates, renders nested notes, joins multi-line values, falls back to en", () => {
  const en = createTranslator("en");
  assert.equal(en.t("tcp.partial", { blocked: 1, total: 4 }), "TCP is blocked on 1 of 4 IPs only; not counted as an IP block.");
  assert.equal(en.note({ code: "throttle.unjudged", params: { reason: { code: "throttle.reason.http", params: { status: 503 } } } }), "Throttling could not be judged: HTTP 503");
  assert.ok(en.t("help").includes("\n"));
  assert.equal(en.t("no.such.key"), "no.such.key");
  assert.equal(createTranslator("tr").t("status.blocked"), "engelli");
});

test("detectSystemLanguage reads LC_ALL > LC_MESSAGES > LANG and ignores C/POSIX", () => {
  assert.equal(detectSystemLanguage({ LANG: "tr_TR.UTF-8" }, "linux"), "tr");
  assert.equal(detectSystemLanguage({ LANG: "en_US.UTF-8", LC_ALL: "tr_TR.UTF-8" }, "linux"), "tr");
  assert.equal(detectSystemLanguage({ LANG: "C" }, "linux"), undefined);
  assert.equal(detectSystemLanguage({ LANG: "C.UTF-8" }, "linux"), undefined);
  assert.equal(detectSystemLanguage({}, "linux"), undefined);
});

test("resolveLocale: flag > TRBLOCKED_LANG > saved > system; Turkish->tr, other->en, unknown->tr", () => {
  const avail = ["en", "tr"];
  const r = (c: object) => resolveLocale({ env: {}, available: avail, platform: "linux", ...c });
  assert.equal(r({ flag: "en", saved: "tr", env: { TRBLOCKED_LANG: "tr" } }), "en");
  assert.equal(r({ saved: "en", env: { TRBLOCKED_LANG: "tr" } }), "tr");
  assert.equal(r({ saved: "en", env: { LANG: "tr_TR.UTF-8" } }), "en"); // saved beats system
  assert.equal(r({ env: { LANG: "tr_TR.UTF-8" } }), "tr");
  assert.equal(r({ env: { LANG: "en_US.UTF-8" } }), "en");
  assert.equal(r({ env: { LANG: "de_DE.UTF-8" } }), "en"); // no German catalog
  assert.equal(r({ env: {} }), "tr"); // undetectable -> default
  assert.equal(r({ flag: "xx", env: {} }), "tr"); // unsupported explicit value is ignored here (the CLI rejects --lang earlier)
});

test("terminalSupportsUnicode: ASCII only on positive evidence, never for a bare C/POSIX/unset locale", () => {
  // These say nothing about the terminal (iTerm renders UTF-8 whatever LANG is): keep Turkish letters.
  for (const env of [{}, { LANG: "C" }, { LC_ALL: "C" }, { LC_CTYPE: "POSIX" }, { LANG: "en_US" }, { LANG: "tr_TR" }, { LANG: "tr_TR.UTF-8" }, { LANG: "en_US.utf8" }, { LANG: "C.UTF-8" }, { LC_ALL: "C", LANG: "en_US.UTF-8" }, { TERM: "xterm-256color", LANG: "C" }, { TERM: "linux", TERM_PROGRAM: "iTerm.app", LANG: "tr_TR.UTF-8" }, { TERM: "linux", LC_TERMINAL: "iTerm2" }]) {
    assert.equal(terminalSupportsUnicode(env), true, JSON.stringify(env));
  }
  // Positive evidence of a limited terminal.
  for (const env of [{ LANG: "tr_TR.ISO-8859-9" }, { LANG: "tr_TR.ISO8859-9" }, { LC_ALL: "tr_TR.CP1254" }, { LANG: "en_US.US-ASCII" }, { TERM: "dumb" }, { TERM: "linux", LANG: "en_US.UTF-8" }]) {
    assert.equal(terminalSupportsUnicode(env), false, JSON.stringify(env));
  }
});

test("asciify transliterates every Turkish letter and masks the rest", () => {
  assert.equal(asciify("ğüşöçıĞÜŞİÖÇ"), "gusociGUSIOC");
  assert.equal(asciify("erişime engellenmiştir, Sayılı İş"), "erisime engellenmistir, Sayili Is");
  assert.equal(asciify("a ✔ b"), "a ? b");
  assert.equal(asciify("plain \x1b[31mtext\x1b[0m"), "plain \x1b[31mtext\x1b[0m");
});
