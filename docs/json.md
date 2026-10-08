# JSON çıktısı

`trblocked <hedef> --json` ya da kütüphanede `check()` / `checkMany()` aynı yapıyı döner (`CheckResult`).

- Komut satırında **tek bir hedef** (ve `-f` yok) verirseniz çıktı bir **nesnedir**; birden fazla hedef ya da `-f` varsa **dizidir**.
- Alanlar [semver](https://semver.org/lang/tr/)'e tabidir. Tip tanımları pakette (`dist/types.d.ts`).
- Alan adları İngilizcedir; **metinler yoktur**: açıklamalar `notes` içinde `{ code, params }` olarak gelir ve dile çevrilir.

## Örnek (kısaltılmış)

```json
{
  "target": "roblox.com",
  "host": "roblox.com",
  "blocked": true,
  "status": "blocked",
  "types": ["dns", "sni", "http"],
  "confidence": "high",
  "decision": "roblox.com, 07/08/2024 tarihli ve 2024/5282 D. İş Sayılı Adana 6. Sulh Ceza Hakimliği kararıyla erişime engellenmiştir.",
  "evidence": {
    "dns": {
      "isp":   { "source": "213.74.0.1", "rcode": "NOERROR", "addresses": ["195.175.254.2"] },
      "truth": { "source": "google", "rcode": "NOERROR", "addresses": ["128.116.44.3"] },
      "ispVerdict": { "blocked": true, "reason": "blockpage-ip" }
    },
    "ips": [
      {
        "ip": "128.116.44.3",
        "tcp": { "outcome": "ok", "ms": 43 },
        "tlsRealSni": { "outcome": "timeout", "ms": 5002 },
        "tlsAltSni":  { "outcome": "ok", "ms": 131, "authorized": false }
      }
    ]
  },
  "notes": [
    { "code": "dns.blocked.blockpage-ip" },
    { "code": "tls.sni", "params": { "host": "roblox.com", "alt": "example.com" } }
  ]
}
```

## Üst düzey alanlar

| Alan | Tür | Anlamı |
|---|---|---|
| `target` | string | Verdiğiniz girdi, olduğu gibi |
| `host` | string | Çözümlenen alan adı ya da IP |
| `status` | `"blocked"` \| `"accessible"` \| `"inconclusive"` | Sonuç |
| `blocked` | boolean | `status === "blocked"` kısayolu |
| `types` | `("dns"\|"ip"\|"sni"\|"http"\|"throttle")[]` | Hangi katmanlarda engel bulundu (birden fazla olabilir) |
| `confidence` | `"high"` \| `"medium"` \| `"low"` | Kanıtın cinsine göre kural tabanlı güven. `inconclusive` her zaman `low` |
| `decision` | string? | Engel sayfasından okunan karar metni (okunabildiyse) |
| `notes` | `Note[]` | Neden bu sonuç: dilden bağımsız açıklamalar |
| `warnings` | `Note[]`? | Ortam uyarıları (VPN, hotspot). Komut satırı ekler, `check()` eklemez |
| `error` | string? | Hedef hiç kontrol edilemediyse (ör. geçersiz girdi) |
| `evidence` | nesne | Aşağıda |

### `Note`

`{ "code": "tls.sni", "params": { "host": "...", "alt": "..." } }`. Kodların tamamı ve metinleri [`locales/en.json`](../locales/en.json) içindedir (`code` = katalog anahtarı). `params` değerleri bir `Note` da olabilir (iç içe). Kütüphanede `createTranslator("tr").note(not)` ile metne çevirin.

## `evidence`

### `evidence.dns` (alan adı hedeflerinde)

| Alan | Anlamı |
|---|---|
| `isp` | Sağlayıcı DNS havuzunun (yarışan) ilk kesin cevabı |
| `system` | İşletim sisteminin bu bilgisayar için verdiği cevap (`/etc/hosts` dahil) |
| `truth` | DoH'tan gelen güvenilir cevap; gerçek IP'ler buradan alınır |
| `ispVerdict`, `systemVerdict` | `{ blocked, reason }`; `reason`: `blockpage-ip`, `nxdomain`, `bogon-ip`, `cert-mismatch`, `none`, `unknown` |

Bir cevap: `{ source, rcode, addresses[] }`; `rcode`: `NOERROR`, `NXDOMAIN`, `SERVFAIL`, `TIMEOUT`, `ERROR`.

### `evidence.ips[]` (her gerçek IP için)

| Alan | Anlamı |
|---|---|
| `ip` | Test edilen adres |
| `tcp` | Ana porta (443; `http://` için 80) TCP sonucu: `{ outcome, ms, code? }`. `outcome`: `ok`, `reset`, `timeout`, `refused`, `unreachable`, `error` |
| `tcpHttp` | 80 portuna TCP (ana port 80 değilse) |
| `tlsRealSni` | Gerçek site adıyla TLS: `{ outcome, ms, authorized? }`. `outcome`: `ok`, `alert`, `reset`, `timeout`, `error` |
| `tlsAltSni` | Aynı IP'ye nötr adla (`example.com`) TLS (kontrol) |
| `http` | Düz HTTP, gerçek `Host`: `{ outcome, ms, status?, location?, blockPage? }`. `blockPage`: `{ signature, decision? }` (imza eşleştiyse) |
| `httpAlt` | Yalnızca gerçek `Host` cevapsızsa: nötr `Host` ile aynı IP (kademeli test) |
| `httpRoot` | Yalnızca URL'de yol varsa ve `http` cevapsızsa: gerçek `Host`, `/` yolu |
| `injection` | `--injection` ile: `{ attempts, hits }` |

### `evidence.reference` (dış doğrulama yapıldıysa)

`{ provider, reachable, samples[], detail }`. `reachable`: `true` (bir uç nokta cevap verdi), `false` (hiçbiri vermedi), alan yok (belirlenemedi). `samples[]`: `{ location, ok, detail }`.

### `evidence.throttle` (`--throttle` ile)

`{ ip, workload, real, control?, ratio?, throttled?, reason? }`. `real` ve `control.sample`: `{ outcome, status?, bytes, complete, ttfbMs?, windowMs?, bytesPerSec? }`. `control.kind`: `same-ip-sni` (güven yüksek) ya da `external` (orta). `throttled` yoksa ölçüm değerlendirilemedi ve nedeni `reason` (bir `Note`) içindedir.

## Kararlılık

Bu doküman `1.x` içindir. Yeni alanlar ve yeni `notes[].code` değerleri küçük sürümlerde eklenebilir: **bilinmeyen alanları ve kodları yok sayın**. Mevcut bir alanın kaldırılması, yeniden adlandırılması ya da anlamının değişmesi ancak yeni bir ana sürümle olur.

`evidence` teşhis amaçlı ham kanıttır; yapısı aynı kurallara tabidir ama içindeki sayılar (süreler, boyutlar) her ölçümde değişir. Karar vermek için `status`, `types`, `confidence`, `notes[].code` ve `decision` alanlarını kullanın.
