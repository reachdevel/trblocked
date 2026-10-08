import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../src/index.ts";

test("the public API is exactly this list: growing it is a deliberate decision, not an accident", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "ConfigFileError",
    "GlobalpingProbe",
    "TargetError",
    "availableLocales",
    "check",
    "checkMany",
    "createTranslator",
    "detectEnvironment",
    "loadConfigFile",
    "loadDefaultConfig",
    "parseTarget",
    "resolveConfig",
    "resolveLocale",
    "validateConfig",
  ]);
});
