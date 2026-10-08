# trblocked

[![ci](https://github.com/reachdevel/trblocked/actions/workflows/ci.yml/badge.svg)](https://github.com/reachdevel/trblocked/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/trblocked)](https://www.npmjs.com/package/trblocked) [![license](https://img.shields.io/npm/l/trblocked)](LICENSE)

**Why won't this site open in Turkey?** DNS, IP, SNI, HTTP, throttling, or is the site simply down? `trblocked` tells those apart and explains which one it is.

```
$ trblocked example.com roblox.com nonexistent-zzq81.example --lang en

✔ example.com                accessible
✖ roblox.com                 blocked · dns, sni, http
    roblox.com, 07/08/2024 tarihli ve 2024/5282 D. İş Sayılı Adana 6. Sulh Ceza Hakimliği kararıyla erişime engellenmiştir.
? nonexistent-zzq81.example  inconclusive · This host does not exist (NXDOMAIN from DoH).

3 checked · 1 blocked · 1 accessible · 1 inconclusive · 6.6s
```

A command-line tool and a Node.js library with **no runtime dependencies**. The full documentation is in Turkish ([README.md](README.md)); this is the short version.

> **Status: 1.0.** The command-line flags, the library API and the JSON fields follow [semver](https://semver.org/): breaking changes only come with a new major version. The measuring side, however, was verified on a single network (one Superonline home line); we list exactly what we did and did not verify below.

## What it does

- Measures a block **layer by layer**: `dns`, `ip`, `sni`, `http`, `throttle`. Each layer is compared against a control (the same IP with a neutral SNI/Host, a trusted DoH answer, a vantage point outside Turkey), because "it timed out" alone proves nothing.
- Reads the court/BTK **decision text** from the block page when the block-page server answers.
- Checks many sites **in parallel**, with a live progress display that disappears when it is done.
- Speaks Turkish and English, and can output JSON.

It does **not** bypass blocks, does not automate BTK's query site (it sits behind a CAPTCHA), and does not judge whether a block is lawful. It measures **from your network** only.

## Install and use

Node.js **20.19+**, macOS or Linux (Windows is not supported).

```bash
npm install -g trblocked
trblocked pastebin.com
trblocked -f list.txt --json
trblocked pastebin.com --throttle     # also measure throttling
trblocked config                      # choose language and options
```

Exit codes: `0` all accessible, `1` something blocked, `2` inconclusive/error.

As a library (ESM; `require()` works on Node 20.19+):

```js
import { check, checkMany, createTranslator } from "trblocked";
const r = await check("pastebin.com");
console.log(r.status, r.types, r.confidence);
const en = createTranslator("en");
for (const note of r.notes) console.log(en.note(note)); // notes are { code, params }, language-neutral
```

Result fields: [docs/json.md](docs/json.md) (Turkish, field names are English).

## What we verified, and what we did not

- **Automated:** 101 tests against local fake servers and fake DNS, no internet needed. This covers rare situations (IP blocks, throttling, HTTP injection) deterministically.
- **By hand on a real Superonline line (macOS):** DNS block with decision text, SNI block, HTTP block-page injection by the ISP middlebox, a Host-header-only block on an HTTP-only server, outside confirmation via Globalping, the "not throttled" case, and the VPN warning with a real OpenVPN connection. All 101 tests pass on Node 25.9, 22.19 and 20.20.2; the packed tarball was installed in an empty project and run on Node 25 and 20.20.2.
- **Not verified:** any other ISP or mobile network; a *really* throttled site and a *really* IP-blocked site (those paths are only tested locally); the hotspot warning with a real phone hotspot.
- **On purpose not covered:** Node older than 20.19, Windows (we have no Windows machine), IPv6.

## Known limits

- The same site can come out slightly different between runs: the ISP middlebox injects its HTTP block page only some of the time (`--injection` counts hits).
- The decision text cannot always be read: the block-page server hardly answers for some sites.
- IPv4 only. Confidence levels are rule-based, not statistical.
- Default ISP DNS servers are Superonline's; on another ISP, add yours to `ispResolvers` in the config and tell us.
- Block signatures and addresses change over time; they live in `config/default.json`.
- Measurement rules (confidence levels, signatures, thresholds) may improve in minor releases as we see more networks; the meaning of the JSON fields does not change within a major version.

## Privacy

Every check sends the hostname to the **DoH providers** (Cloudflare `1.1.1.1`, Google `8.8.8.8`) and to your **ISP's DNS servers**, and connects to the target's own IPs. **Globalping** (`api.globalping.io`, hostname and `/` only) is on by default in the CLI but is only called when an IP block is suspected or a result is unexplained; turn it off with `--no-reference` or `trblocked config`. The library never calls it unless you pass a `reference`. Full table: [README.md](README.md#gizlilik-kime-ne-gidiyor).

## License

[MIT](LICENSE). Built together with the AI assistant Claude (Anthropic).
