import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { files: string[]; bin: Record<string, string> };

test("every directory the code reads at runtime is shipped in the npm package", () => {
  // e.g. new URL("../locales/", import.meta.url) or new URL("../config/default.json", import.meta.url)
  const needed = new Set<string>();
  for (const f of readdirSync(new URL("src/", root), { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(new URL(`src/${f}`, root), "utf8");
    for (const m of text.matchAll(/new URL\(\s*["'`]\.\.\/([A-Za-z0-9_-]+)[/"'`]/g)) needed.add(m[1]!);
  }
  assert.ok(needed.has("config") && needed.has("locales"), `found: ${[...needed]}`); // the scan itself works
  for (const dir of needed) assert.ok(pkg.files.includes(dir), `"${dir}" is read at runtime but missing from package.json "files": ${pkg.files}`);
});

test("the bin entry points into dist, which is shipped", () => {
  assert.ok(pkg.files.includes("dist"));
  for (const target of Object.values(pkg.bin)) assert.match(target, /^(\.\/)?dist\//);
});
