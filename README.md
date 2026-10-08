# trblocked

**Bir site Türkiye'de neden açılmıyor?** DNS mi, IP mi, SNI mi, HTTP mi, yavaşlatma mı, yoksa site mi kapalı? `trblocked` bunu ayırt eder ve nedenini söyler.

```
$ trblocked example.com github.com roblox.com nonexistent-zzq81.example

✔ example.com                erişilebilir
✔ github.com                 erişilebilir
✖ roblox.com                 engelli · dns, sni, http
    roblox.com, 07/08/2024 tarihli ve 2024/5282 D. İş Sayılı Adana 6. Sulh Ceza Hakimliği kararıyla erişime engellenmiştir.
? nonexistent-zzq81.example  belirsiz · Bu alan adı mevcut değil (DoH'tan NXDOMAIN).

4 kontrol edildi · 1 engelli · 2 erişilebilir · 1 belirsiz · 12.7s
```

Komut satırı aracı ve Node.js kütüphanesi olarak gelir, çalışma zamanı bağımlılığı yoktur.
English summary: [README.en.md](README.en.md).

> **Durum: 1.0.** Komut satırı bayrakları, kütüphane API'si ve JSON alanları [semver](https://semver.org/lang/tr/)'e tabidir: kırıcı değişiklik ancak yeni bir ana sürümle gelir. Ölçüm tarafı ise tek bir ağda (Superonline, bir ev hattı) doğrulandı. Neyi denediğimizi, neyi deneyemediğimizi aşağıda açıkça yazdık: [Neleri test ettik](#neleri-test-ettik-neleri-edemedik) ve [Bilinen sorunlar](#bilinen-sorunlar-ve-sınırlar).

## İçindekiler

[Neden yaptık](#neden-yaptık) · [Ne yapar, ne yapmaz](#ne-yapar-ne-yapmaz) · [Kurulum](#kurulum) · [Çıktıyı okumak](#çıktıyı-okumak) · [Komut satırı](#komut-satırı) · [Ayarlar](#ayarlar) · [Kütüphane olarak](#kütüphane-olarak) · [Nasıl çalışıyor](#nasıl-çalışıyor) · [Neleri test ettik](#neleri-test-ettik-neleri-edemedik) · [Bilinen sorunlar](#bilinen-sorunlar-ve-sınırlar) · [Gizlilik](#gizlilik-kime-ne-gidiyor) · [Katkı](#katkı) · [Lisans](#lisans-ve-notlar)

## Neden yaptık

Bir site açılmadığında tarayıcı hep aynı şeyi söyler: "Bu siteye ulaşılamıyor". Oysa arkasında çok farklı şeyler olabilir:

- İnternet sağlayıcının DNS'i alan adını bir **engel sayfasına** yönlendiriyor olabilir.
- Alan adı çözülüyor ama sitenin **IP adresine** gidilemiyordur.
- IP'ye gidiliyor ama TLS el sıkışması, içindeki **site adı (SNI)** görüldüğü için kesiliyordur.
- Düz HTTP'de isteğin **`Host` başlığı** yüzünden cevap verilmiyordur ya da ara kutu kendi yönlendirmesini enjekte ediyordur.
- Bağlantı kuruluyor ama **bilerek yavaşlatılıyordur**.
- Ya da hiçbiri değil: **site gerçekten kapalıdır.**

Bu ayrım önemli. Siteyi "açıp açmamak" yetmez: hangi katmanda ne olduğunu, bir VPN'in neden işe yaradığını (ya da yaramadığını), sorunun sende mi sitede mi olduğunu bilmek istiyoruz. Biz tek bir doğru/yanlış değil, **hangi katmanda engel var** sorusunun cevabını istedik; bunu her katmanı bir **kontrol grubuyla karşılaştırarak** yapıyoruz (aşağıda: [Nasıl çalışıyor](#nasıl-çalışıyor)). Sırf "zaman aşımı oldu" demek yetmez, çünkü o da sitenin kapalı olduğu anlamına gelebilir.

## Ne yapar, ne yapmaz

**Yapar**

- Bir alan adının ya da URL'nin engelini **katman katman** ölçer: `dns`, `ip`, `sni`, `http`, `throttle` (yavaşlatma).
- Engel sayfasından **mahkeme/BTK karar metnini** okur (okunabildiği zaman).
- Çok sayıda siteyi **paralel** kontrol eder, canlı ilerleme gösterir, bitince sadece sonucu bırakır.
- Sonucu **güven seviyesiyle** verir ve dayanağını (kanıtı) JSON'da saklar.
- Türkçe ve İngilizce konuşur; çıktı JSON da olabilir.

**Yapmaz**

- Engel **aşmaz** ve aşma yöntemi önermez. Sadece ölçer.
- BTK'nın site sorgu sayfasını otomatikleştirmez (arkasında CAPTCHA var).
- Engelin **doğru ya da yanlış** olduğuna karar vermez, hukuki tavsiye değildir.
- **Senin ağından** ölçer. Başka bir ISP'de, başka bir şehirde ya da mobil hatta sonuç farklı olabilir.

## Kurulum

Node.js **20.19 ya da üstü** gerekir. macOS ve Linux için yazıldı ve denendi; Windows desteklenmiyor.

```bash
npm install -g trblocked      # kalıcı kurulum
npx trblocked pastebin.com    # kurmadan denemek için
```

Kaynaktan:

```bash
git clone https://github.com/reachdevel/trblocked.git && cd trblocked
npm ci && npm run build
node dist/cli.js pastebin.com
```

İlk çalıştırmada dil sistem dilinden seçilir (Türkçe ya da İngilizce). Değiştirmek için `trblocked config` çalıştırın.

## Çıktıyı okumak

### Sonuç ve güven

| Durum | Anlamı |
|---|---|
| `erişilebilir` | Bu ağdan siteye ulaşıldı, engel bulunmadı. |
| `engelli` | En az bir katmanda engel kanıtı var (`types` hangileri olduğunu söyler). |
| `belirsiz` | Karar verecek kanıt yok: site yok, kapalı olabilir ya da ölçüm yapılamadı. Nedeni altında yazar. |

Güven (`yüksek`, `orta`, `düşük`) bilimsel bir olasılık değil, **kanıtın cinsine göre bir kural**: karşılaştırmalı kanıt (aynı IP'de gerçek ve nötr SNI) yüksek, tek başına zaman aşımı orta, harici doğrulama varsa yükselir.

### Engel türleri

| Tür | Ne demek | Nasıl anlıyoruz |
|---|---|---|
| `dns` | İnternet sağlayıcının DNS'i yalan söylüyor | Sağlayıcı DNS'i engel sayfası IP'si (ya da yalan NXDOMAIN) dönüyor, güvenilir DoH cevabı farklı |
| `ip` | IP'ye hiç gidilemiyor | Gerçek IP'lerin **bütün** portlarında (443 ve 80) bağlantı sıfırlanıyor ya da cevapsız. Dışarıdan erişilebiliyorsa güven yükselir, dışarıdan da kapalıysa "engel değil, site kapalı" denir |
| `sni` | TLS el sıkışması site adı yüzünden kesiliyor | Aynı IP'ye gerçek site adıyla el sıkışma ölür, nötr bir adla (`example.com`) tamamlanır |
| `http` | Düz HTTP'de engel | Ya engel sayfası/yönlendirme enjekte ediliyor (imzayla tanınır), ya da gerçek `Host` başlığı cevapsız kalırken nötr `Host` cevap alıyor |
| `throttle` | Bağlantı bilerek yavaşlatılıyor | Aynı sunucudan gerçek SNI ile indirme hızı, nötr SNI ile olandan çok düşük (`--throttle` ile açılır) |

Birden fazla tür aynı anda çıkabilir (`dns, sni, http`): kararlar genelde birkaç katmanı birden uygular.

### Çıkış kodları

| Kod | Anlamı |
|---|---|
| `0` | Hepsi erişilebilir |
| `1` | En az biri engelli |
| `2` | Belirsiz sonuç, hata ya da yanlış kullanım |

## Komut satırı

```bash
trblocked pastebin.com                       # tek site (nedenleri altında listeler)
trblocked a.com b.com c.com                  # toplu, paralel
trblocked http://site.example/dosya.zip      # URL: şema ve yol dikkate alınır
trblocked -f liste.txt                       # dosyadan (satır başına bir hedef, # yorum)
cat liste.txt | trblocked -f -               # stdin'den
trblocked pastebin.com --json                # makine okunur çıktı
trblocked pastebin.com --throttle            # yavaşlatmayı da ölç
```

**Şema ve yol:** `http://` verirseniz site düz HTTP sunuyor demektir; 80 portu ana port olur, TLS denenmez. Şema vermezseniz hem 443 hem 80 denenir. URL'deki yol yalnızca düz HTTP testinde kullanılır (HTTPS'te yol şifreli olduğu için ağdan görünmez); yola özgü bir engel varsa ayırt edilir.

### Seçenekler

| Seçenek | Ne yapar |
|---|---|
| `-f, --file <yol>` | Hedefleri dosyadan oku (`-` = stdin) |
| `-c, --concurrency <n>` | Aynı anda kontrol edilen hedef sayısı (varsayılan 16) |
| `--throttle` | Bant genişliği yavaşlatmasını da ölç (birkaç MB indirir, hedefler sırayla) |
| `--injection` | Düz HTTP isteğini tekrarla; engel sayfası bazen enjekte edildiği için "N denemenin K'sında" diye raporlar |
| `--no-reference` | Şüpheli IP engellerini Türkiye dışından doğrulama (varsayılan: açık, bkz. [Gizlilik](#gizlilik-kime-ne-gidiyor)) |
| `--reference globalping` | Dış doğrulamayı zorla aç (ayarlardan kapatmış olsanız bile) |
| `--lang <tr\|en>` | Çıktı dili |
| `--ascii`, `--unicode` | Karakter setini zorla (Türkçe harfleri dönüştür / UTF-8) |
| `--config <dosya>` | Ayarları geçersiz kılan JSON dosyası |
| `--json` | JSON çıktı (bkz. [docs/json.md](docs/json.md)) |
| `-v, --verbose` | Toplu çalışmada da her notu göster |
| `-s, --silent` | Sadece sonuç: ilerleme ve uyarı yok |
| `--no-color`, `--no-progress` | Renk / canlı ilerleme kapalı |
| `-V, --version` | Sürümü göster |
| `-h, --help` | Yardım |

İlerleme göstergesi **stderr**'e çizilir ve bitince silinir; sonuçlar **stdout**'a gider, yani `| grep`, `> sonuc.txt` temiz çalışır. `NO_COLOR` ve `FORCE_COLOR` ortam değişkenleri dikkate alınır.

### Uyarılar

Aracın ortamına bakıp sonucu bozabilecek durumları **uyarı** olarak yazar (`-s` ile kapanır):

- **VPN/tünel aktif:** İnternete giden yol bir tünel arayüzünden çıkıyorsa, engeller ISP'nizde uygulandığı için engelli siteler erişilebilir görünebilir.
- **Telefon hotspot'u:** Mobil operatörler engelleri kendi yöntemleriyle uygular ve sağlayıcı DNS'leri cevap vermeyebilir; sonuç mobil ağı yansıtır. (Bu bir tahmin: ağ geçidi adresine bakılır.)

## Ayarlar

```bash
trblocked config         # etkileşimli kurulum: dil, dış doğrulama, uyarılar
trblocked config show    # kayıtlı ayarları göster
```

Ayarlar `~/.config/trblocked/config.json` içine yazılır (`XDG_CONFIG_HOME` varsa orası). Öncelik sırası: **varsayılanlar < kayıtlı ayarlar < `--config` dosyası < komut satırı bayrakları**. Dil için `TRBLOCKED_LANG` ortam değişkeni de var.

Her şey yapılandırılabilir, kodda gömülü veri yok: sağlayıcı DNS'leri, DoH adresleri, engel sayfası IP'leri ve imzaları, zaman aşımları, hız eşikleri. Tamamı [`config/default.json`](config/default.json) içinde. Config dosyanızı yazarken **yazım hatalarını yakalarız**:

```
$ trblocked pastebin.com --config benim.json
benim.json dosyasında sorunlar var:
  · "reference.enable" bilinen bir ayar değil; şunu mu demek istedin: "reference.enabled"?
  · "timeoutsMs.dns" sayı olmalı, metin verilmiş.
```

**Başka bir internet sağlayıcısındaysanız:** varsayılan sağlayıcı DNS listesi Superonline'ındır. Başka bir ağda bu sunucular cevap vermeyebilir; araç bunu "sağlayıcı DNS'i cevap vermedi" diye söyler ama DNS engelini değerlendiremez. Kendi sağlayıcınızın DNS adreslerini config'e `ispResolvers` olarak ekleyin, ve **lütfen bize bildirin** (bkz. [CONTRIBUTING.md](CONTRIBUTING.md)).

## Kütüphane olarak

Sadece ESM (`import`). Node 20.19+ içinde `require()` de çalışır. TypeScript tipleri pakette.

```js
import { check, checkMany, createTranslator } from "trblocked";

const sonuc = await check("pastebin.com");
console.log(sonuc.status, sonuc.types, sonuc.confidence);
// "blocked" [ "dns", "sni", "http" ] "medium"

// Güven, en zayıf kanıtın seviyesidir. Burada "orta": http kararı yalnızca Host cevapsızlığına dayanıyor
// ve dışarıdan doğrulanmadı (kütüphane dış doğrulamayı siz vermedikçe yapmaz).

// Notlar dilden bağımsızdır ({ code, params }); istediğiniz dilde yazıya çevirin:
const tr = createTranslator("tr");
for (const not of sonuc.notes) console.log(tr.note(not));
```

Toplu ve ilerleme olaylarıyla:

```js
const sonuclar = await checkMany(["a.com", "b.com", "c.com"], {
  concurrency: 8,
  onEvent: (e) => console.log(e.index, e.type), // start | plan | stage | done
});
```

Dışarıdan doğrulama ve ayar:

```js
import { check, GlobalpingProbe } from "trblocked";

// Kütüphane kendiliğinden dışarıya bağlanmaz: dış doğrulamayı siz verirsiniz.
const r = await check("site.example", { throttle: { enabled: true } }, { reference: new GlobalpingProbe() });
```

Herkese açık API bilerek küçük tutuldu (`check`, `checkMany`, `GlobalpingProbe`, `parseTarget`, ayar ve dil yardımcıları, tipler). Alan alan ayrıntı: [docs/json.md](docs/json.md).

## Nasıl çalışıyor

Her katman, **kontrol grubuyla karşılaştırılarak** ölçülür: "bağlanamadım" tek başına bir şey kanıtlamaz, ama "gerçek adla bağlanamadım, nötr adla bağlandım" kanıtlar.

```
alan adı ──► DNS ──────────► sağlayıcı DNS'i  vs  DoH (Cloudflare/Google)
               │               engel sayfası IP'si, sahte NXDOMAIN, geçersiz sertifika?
               ▼
          gerçek IP'ler (DoH'tan) ──► her IP için, paralel:
               ├─ TCP 443 ve TCP 80 ........ hepsi ölüyse: ip
               ├─ TLS: gerçek SNI  vs  example.com ... biri ölüp diğeri yaşıyorsa: sni
               └─ HTTP :80: gerçek Host ... engel sayfası imzası?  sessizse ↓
                    └─ nötr Host (+ gerekirse "/" yolu) ile tekrar ... biri yaşıyorsa: http
               ▼
          (gerekirse) dış doğrulama ── Türkiye dışından erişilebiliyor mu? ── kesinti/engel ayrımı
          (istenirse) --throttle ───── aynı IP, gerçek SNI vs nötr SNI hızı ── yavaşlatma
```

Birkaç tasarım kararı:

- **Gerçek IP'yi DoH'tan alırız**, sağlayıcının DNS'inden değil; böylece DNS yalan söylese bile geri kalan katmanları doğru adrese karşı ölçeriz.
- **`ip` için her port ölü olmalı.** 443 cevapsız ama 80 canlıysa bu yalnızca "sunucu HTTPS sunmuyor" demektir; IP engeli değildir.
- **Kademeli:** pahalı/ayrıntılı testler (nötr `Host`, kök yol, tekrarlı enjeksiyon, hız ölçümü, dış doğrulama) yalnızca ihtiyaç olduğunda ya da istendiğinde çalışır.
- **Bağlantı kontrolü:** genel bağlantı yoksa (`1.1.1.1:443`'e ulaşılamıyorsa) her zaman aşımı engel gibi görünürdü; bu durumda ölçüm yapmayı reddederiz.
- **Hepsi paralel.** Tek bir engelli site yaklaşık **5-7 saniye** sürer (TLS zaman aşımını beklemek zorunda), liste uzasa da toplam süre en yavaş hedef kadardır. Tek istisna `--throttle`: hız ölçümleri birbirinin bant genişliğini yemesin diye sırayla yapılır.

## Neleri test ettik, neleri edemedik

### Otomatik testler: 101 test, 15 dosya

`npm test` internet gerektirmez. Yerel bir "laboratuvar" kurar: sahte HTTP/TLS sunucuları (Host'a göre cevap kesenler, engel sayfası enjekte edenler, bazen enjekte edenler, kapalı portlar, yavaşlatanlar) ve sahte DNS cevapları. Böylece **gerçek ağda nadir görülen durumları da** (IP engeli, yavaşlatma, HTTP enjeksiyonu) deterministik olarak sınarız. Kapsam:

- Karar mantığı: DNS yorumu, TCP/HTTP kararları, güven seviyeleri, dış doğrulamanın kararı değiştirdiği durumlar.
- Katmanlar: TCP, TLS, HTTP, hız ölçümü (yerel sunucuyla), toplu işleme ve paralellik sınırları.
- Arayüz: canlı ilerleme, çıktı biçimi, dil kataloglarının tutarlılığı, ASCII/UTF-8 seçimi, VPN/hotspot ayrıştırıcıları (gerçek `route` çıktılarıyla), sihirbaz (ok tuşlarıyla dahil), config doğrulama.
- Paket: yayınlanan pakette `locales/` ve `config/` var mı, herkese açık API listesi değişti mi.

### Gerçek ağda elle doğruladıklarımız

Bir Superonline ev hattında, macOS'ta:

- Engelsiz siteler `erişilebilir`; olmayan alan adı `belirsiz`.
- **DNS engeli:** sağlayıcı DNS'i engel sayfası IP'sine (`195.175.254.2`) yönlendiriyor, sayfadan karar metni okunuyor.
- **SNI engeli:** aynı IP'ye gerçek adla TLS kesiliyor, `example.com` ile tamamlanıyor.
- **HTTP engeli:** hem ara kutunun enjekte ettiği yönlendirmeler (`Via: 1.0 middlebox`, `/landpage`) hem de **yalnızca `Host` başlığına göre** cevap kesen bir ev sunucusu yakalandı.
- Dışarıdan doğrulama (Globalping, DE/US) gerçek bir vakada "sunucu ayakta, engel buradan" sonucunu doğruladı.
- `--throttle`: yavaşlatma **olmayan** durum doğru çıktı.
- Paketlenmiş halin kurulumu, komutun ve kütüphanenin boş bir projeden çalışması, TypeScript tiplerinin çözülmesi.
- **VPN uyarısı** gerçek bir OpenVPN bağlantısıyla denendi; VPN yokken yanlış alarm vermiyor.
- Node **25.9**, **22.19** ve **20.20.2**'de 101/101 test; paketlenmiş halin Node 25 ve 20.20.2'de kurulup çalışması.

### Deneyemediklerimiz (dürüst liste)

- **Başka bir sağlayıcı/ağ.** Tüm canlı doğrulama tek bir hatta yapıldı. Turkcell Mobil, Vodafone, TürkNet, Türk Telekom'da ne çıkar bilmiyoruz.
- **Gerçekten yavaşlatılan bir site** (`throttle` pozitifi) ve **gerçekten IP engelli bir site** (`ip` pozitifi) bulunamadı. Bu iki yolun mantığı yerel sunucularla test edildi, gerçek ağda görülmedi.
- **Hotspot uyarısı** gerçek bir telefon hotspot'uyla denenmedi. Ağ geçidi adresine bakan bir tahmin; yalnızca `route` çıktısı örnekleriyle test edildi.

### Bilerek yapmadıklarımız

- **Node 20.19'dan eski sürümler:** denemedik, desteklemiyoruz (`engines`: `>=20.19`).
- **Windows:** elimizde Windows makine yok; desteklemiyoruz (macOS ve Linux).
- **IPv6:** kapsam dışı bıraktık; araç yalnızca IPv4 test eder.

## Bilinen sorunlar ve sınırlar

Bunlar hata değil, ölçtüğümüz sistemin ya da yaklaşımımızın sınırları. Bilmeniz gerekir:

1. **Aynı site iki çalıştırmada farklı çıkabilir.** Ara kutu HTTP engel sayfasını/yönlendirmesini her istekte değil, bazen enjekte ediyor. Aynı site bir seferinde `dns, sni`, ötekinde `dns, sni, http` çıkabilir. `--injection` bunu "N denemenin K'sında" diye görünür kılar.
2. **Karar metni her zaman okunamaz.** Engel sayfası sunucusu bazı sitelerde neredeyse hiç cevap vermiyor (denediğimiz birinde yaklaşık %4), vermeyince de bir yönlendirme gösterip metin vermiyor. Bu durumda araç bunu söyleyen bir not ekler; metni uydurmaz.
3. **Yalnızca IPv4.** Yalnızca IPv6 adresi olan bir site `belirsiz` çıkar ("IPv4 adresi yok").
4. **Güven seviyeleri kural tabanlıdır**, istatistiksel değil. "Yüksek", "bunu karşılaştırmalı kanıtla gördük" demektir.
5. **Dış doğrulama coğrafyaya duyarlı.** Globalping DE ve US'den bakar; bir site coğrafi olarak farklı davranıyorsa "dışarıdan erişilebiliyor" notu yanıltabilir. Ücretsiz kotası saatte 250 krediyle sınırlıdır (çağrı başına birkaç kredi, yalnızca gerektiğinde çağrılır).
6. **Kötü ağda yanlış alarm riski.** Çok yavaş ya da kayıplı bir bağlantıda zaman aşımları engel gibi görünebilir. Genel bağlantı hiç yoksa ölçüm yapmayı reddederiz, ama "kısmen bozuk" bağlantıyı ayırt edemeyiz.
7. **Proxy/kurumsal ağlar** DNS ve TCP ölçümlerini bozabilir (araç `HTTP_PROXY` kullanmaz, ama ağ kendisi araya girebilir).
8. **`--throttle`** yalnızca TLS (443) üstünde, indirilebilir bir yanıt varken ölçer. Küçük sayfalarda ("example.com") ölçülemez; "hedefe daha büyük bir kaynak verin" der. Karşılaştırma sunucunun kendisiyle yapılır; sunucu SNI/Host uyuşmazlığını reddediyorsa (CDN'ler) harici bir kaynağa düşer ve güven düşer.
9. **Sistem DNS notu** ("bu bilgisayarın DNS'i etkilenmiyor") cevabın engel sayfası IP'si olup olmadığına bakar; sistem DNS'inizin gerçek IP'yi verdiğini kanıtlamaz.
10. **Engel imzaları ve IP'ler zamanla değişir** (engel sayfası adresi, yönlendirme yolları). Hepsi `config/default.json` içinde ve değiştirilebilir; güncel kalması için topluluğun yardımı gerekir.
11. **Yalnızca ESM** (`import`; Node 20.19+ içinde `require()` de çalışır). Ölçüm kuralları (güven seviyeleri, imzalar, eşikler) başka ağlardan gelen kanıtlarla küçük sürümlerde iyileşebilir; JSON alanlarının anlamı ise bir ana sürüm içinde değişmez.

## Gizlilik: kime ne gidiyor

Kontrol ettiğiniz alan adları üçüncü taraflara gidebilir. Bilmeniz gereken:

| Kime | Ne gider | Ne zaman |
|---|---|---|
| **Cloudflare (`1.1.1.1`) ve Google (`8.8.8.8`)** DoH | Kontrol ettiğiniz **her alan adı** | Her kontrolde (gerçek IP'yi öğrenmek için) |
| **Sağlayıcınızın DNS'i** (`ispResolvers`) | Alan adı (düz DNS) | Her kontrolde |
| **Hedef sitenin kendi IP'leri** | Bağlantı denemeleri, `Host`/SNI başlıkları | Her kontrolde. Hedef sunucu sizin IP'nizi görür |
| **Engel sayfası sunucusu** (`195.175.254.2`) | Alan adı | Yalnızca DNS engeli bulunursa |
| **`1.1.1.1:443`** | Sadece bir TCP bağlantısı (bağlantı kontrolü) | Her kontrolde |
| **Globalping** (`api.globalping.io`) | Alan adı ve `/` yolu. Siteye DE/US'deki probe'lar gerçek istek atar | **Varsayılan açık**, ama yalnızca şüpheli IP engelinde ya da açıklanamayan sonuçta. `--no-reference` ile ya da `trblocked config` ile kapatılır |
| **`speed.cloudflare.com`** | Bir indirme isteği | Yalnızca `--throttle` ve hedef sunucu SNI karşılaştırmasını kabul etmiyorsa |

Alan adlarınızı bu kuruluşlara göstermek istemiyorsanız `config/default.json` içindeki `dohEndpoints` ve `ispResolvers` listelerini kendi seçtiğinizle değiştirin. Kütüphane olarak kullanırken `check()` kendiliğinden hiçbir dış doğrulama çağrısı yapmaz; `reference` vermezseniz Globalping'e hiçbir şey gitmez.

## Katkı

Yeni dil, yeni sağlayıcı DNS'i, yeni engel imzası ya da "bu sitede yanlış sonuç verdi" bildirimi çok değerli: bkz. [CONTRIBUTING.md](CONTRIBUTING.md). En çok ihtiyaç duyduğumuz şey **başka sağlayıcılardan ve mobil hatlardan gerçek ölçümler**.

## Lisans ve notlar

[MIT](LICENSE). Yazar: Levent Kurt.

Bu proje, yapay zekâ asistanı **Claude (Anthropic)** ile birlikte geliştirildi: tasarım kararları, kod, test ve bu doküman birlikte yazıldı; neyin gerçek ağda doğrulandığı yukarıda açıkça ayrılmıştır.

`trblocked` bir **ölçüm aracıdır**. Sonuçlarını hukuki ya da teknik bir kesinlik olarak değil, **o anda, sizin ağınızdan alınmış bir kanıt** olarak okuyun.
