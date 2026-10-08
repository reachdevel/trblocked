import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigFileError, loadConfigFile, loadDefaultConfig, loadUserConfig, mergeOverrides, resolveConfig, saveUserConfig, userConfigPath, validateConfig } from "../src/config.ts";

test("mergeOverrides: later wins, plain objects merge recursively, arrays replace, inputs untouched", () => {
  const a = { throttle: { enabled: false, ratio: 0.2 }, ispResolvers: ["a.test"], cli: { lang: "tr" } };
  const b = { throttle: { enabled: true }, ispResolvers: ["b.test"] };
  const c = { cli: { warnings: false } };
  assert.deepEqual(mergeOverrides<object>(a, b, c), {
    throttle: { enabled: true, ratio: 0.2 },
    ispResolvers: ["b.test"],
    cli: { lang: "tr", warnings: false },
  });
  assert.deepEqual(a.throttle, { enabled: false, ratio: 0.2 });
  assert.deepEqual(mergeOverrides<object>(undefined, { x: 1 }), { x: 1 });
});

test("resolveConfig layers an override over the defaults, including nested provider settings", () => {
  const cfg = resolveConfig({ reference: { enabled: false }, timeoutsMs: { tcp: 123 } });
  assert.equal(cfg.reference.enabled, false);
  assert.equal(cfg.reference.globalping.apiUrl, "https://api.globalping.io/v1"); // untouched sibling
  assert.equal(cfg.timeoutsMs.tcp, 123);
  assert.equal(cfg.timeoutsMs.dns, 3000);
  assert.equal(resolveConfig().reference.enabled, true); // outside check defaults to on
});

test("user config: path follows XDG_CONFIG_HOME, missing file is empty, save/load round-trips, corrupt file is an error", () => {
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: "/x" }), "/x/trblocked/config.json");
  assert.match(userConfigPath({}), /\.config\/trblocked\/config\.json$/);
  const dir = mkdtempSync(join(tmpdir(), "trblocked-"));
  const path = join(dir, "nested", "config.json");
  assert.deepEqual(loadUserConfig(path), {});
  saveUserConfig({ cli: { lang: "en" }, reference: { enabled: false } }, path);
  assert.deepEqual(loadUserConfig(path), { cli: { lang: "en" }, reference: { enabled: false } });
  assert.ok(readFileSync(path, "utf8").endsWith("}\n"));
  writeFileSync(path, "{ not json");
  assert.throws(() => loadUserConfig(path), (e: unknown) => e instanceof ConfigFileError && e.notes[0]?.code === "config.invalidJson");
});

const codes = (notes: { code: string }[]) => notes.map((n) => n.code);

test("validateConfig: the defaults, empty and realistic overrides are all valid", () => {
  assert.deepEqual(validateConfig(loadDefaultConfig()), []);
  assert.deepEqual(validateConfig({}), []);
  assert.deepEqual(validateConfig({ timeoutsMs: { dns: 1000 }, reference: { enabled: false }, ispResolvers: ["1.2.3.4"], cli: { lang: "tr", charset: "ascii", warnings: false } }), []);
  assert.deepEqual(validateConfig({ dohEndpoints: [{ name: "x", url: "https://x" }], http: { injection: { enabled: true } } }), []);
});

test("validateConfig: typos get a suggestion, unknown keys and wrong types are reported with their path", () => {
  const issues = validateConfig({ reference: { enable: true }, timeoutsMs: { dns: "fast" }, bogus: 1, cli: { lang: 5 }, ispResolvers: "1.2.3.4" });
  assert.deepEqual(issues.map((n) => [n.code, n.params?.path]), [
    ["config.unknownKeySuggest", "reference.enable"],
    ["config.wrongType", "timeoutsMs.dns"],
    ["config.unknownKey", "bogus"],
    ["config.wrongType", "cli.lang"],
    ["config.wrongType", "ispResolvers"],
  ]);
  assert.equal(issues[0]!.params?.suggestion, "reference.enabled");
  assert.deepEqual(issues[1]!.params?.expected, { code: "config.type.number" });
  assert.deepEqual(issues[1]!.params?.got, { code: "config.type.string" });
});

test("validateConfig: array elements are checked against the default's element shape; enum values too", () => {
  assert.deepEqual(codes(validateConfig({ ispResolvers: ["1.2.3.4", 5] })), ["config.wrongType"]);
  assert.deepEqual(validateConfig({ ispResolvers: ["1.2.3.4", 5] })[0]!.params?.path, "ispResolvers[1]");
  assert.deepEqual(codes(validateConfig({ dohEndpoints: [{ name: "x", ulr: "https://x" }] })), ["config.unknownKeySuggest"]);
  assert.deepEqual(codes(validateConfig({ cli: { charset: "latin1" } })), ["config.badValue"]);
  assert.deepEqual(codes(validateConfig([])), ["config.wrongType"]); // not an object at all
  assert.deepEqual(codes(validateConfig({ timeoutsMs: null })), ["config.wrongType"]);
});

test("loadConfigFile: unreadable, not JSON and invalid files all raise ConfigFileError with a headline note", () => {
  const dir = mkdtempSync(join(tmpdir(), "trblocked-cfg-"));
  const codeOf = (path: string) => {
    try {
      loadConfigFile(path);
    } catch (e) {
      return e instanceof ConfigFileError ? e.notes.map((n) => n.code) : ["other"];
    }
    return ["ok"];
  };
  assert.deepEqual(codeOf(join(dir, "missing.json")), ["config.unreadable"]);
  writeFileSync(join(dir, "broken.json"), "{ nope");
  assert.deepEqual(codeOf(join(dir, "broken.json")), ["config.invalidJson"]);
  writeFileSync(join(dir, "typo.json"), '{"timeoutsMs":{"dsn":1}}');
  assert.deepEqual(codeOf(join(dir, "typo.json")), ["config.invalid", "config.unknownKeySuggest"]);
  writeFileSync(join(dir, "good.json"), '{"timeoutsMs":{"dns":1}}');
  assert.deepEqual(codeOf(join(dir, "good.json")), ["ok"]);
});
