import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadDefaultConfig } from "../src/config.ts";
import { httpProbe, matchBlockPage } from "../src/http.ts";

const cfg = loadDefaultConfig();

const BLOCK_PAGE = `<html><body><td class="x"><br><span class="yazi2_2">pastebin.com, 08/03/2012 tarihli ve 2012/27976 Sayılı Ankara CBS kararıyla erişime engellenmiştir.</span><br><span class="yazi3_1">pastebin.com has been blocked by the decision dated 2012.</span></td></body></html>`;

test("matchBlockPage extracts the decision from a real block page", () => {
  const m = matchBlockPage({ status: 200, body: BLOCK_PAGE }, cfg.http);
  assert.equal(m?.signature, "btk-block-page");
  assert.match(m?.decision ?? "", /^pastebin\.com, 08\/03\/2012 tarihli .* erişime engellenmiştir\.$/);
});

test("matchBlockPage ignores ordinary responses", () => {
  assert.equal(matchBlockPage({ status: 301, location: "https://example.com/", body: "" }, cfg.http), undefined);
  assert.equal(matchBlockPage({ status: 200, body: "<html>hello</html>" }, cfg.http), undefined);
});

test("the default config recognizes the middlebox's /landpage redirects (no decision text in them)", () => {
  for (const location of ["http://aidiyet.esb.org.tr/landpage?ms=http://example.test/", "http://192.0.2.7/landpage?op=2&ms=http%3A%2F%2Fexample.test%2F"]) {
    const m = matchBlockPage({ status: 307, location, body: "" }, cfg.http);
    assert.equal(m?.signature, "landpage-redirect", location);
    assert.equal(m?.decision, undefined);
  }
  // An ordinary redirect is not a block page.
  assert.equal(matchBlockPage({ status: 301, location: "https://www.example.test/landing", body: "" }, cfg.http), undefined);
});

test("matchBlockPage supports location signatures from config", () => {
  const m = matchBlockPage(
    { status: 302, location: "http://warning.example/blocked", body: "" },
    { signatures: [{ id: "redir", where: "location", pattern: "warning\\.example" }], decisionPattern: cfg.http.decisionPattern },
  );
  assert.equal(m?.signature, "redir");
});

test("httpProbe sends the Host header and detects a block page end to end", async () => {
  let seenHost: string | undefined;
  const server = http.createServer((req, res) => {
    seenHost = req.headers.host;
    res.end(BLOCK_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const r = await httpProbe("127.0.0.1", port, "pastebin.com", "/", cfg, 2000);
  server.close();
  assert.equal(seenHost, "pastebin.com");
  assert.equal(r.outcome, "ok");
  assert.equal(r.blockPage?.signature, "btk-block-page");
});

test("httpProbe reports a reset connection", async () => {
  const server = http.createServer((req) => req.socket.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const r = await httpProbe("127.0.0.1", port, "x.test", "/", cfg, 2000);
  server.close();
  assert.equal(r.outcome, "reset");
});
