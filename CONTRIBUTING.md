# Katkı rehberi

Teşekkürler. En çok işe yarayacak şeyler: **başka sağlayıcılardan/mobil hatlardan gerçek ölçümler**, yeni diller, sağlayıcı DNS adresleri ve "şu sitede yanlış sonuç verdi" bildirimleri.

## Geliştirme ortamı

```bash
npm ci
npm run build       # dist/ klasörünü temizleyip derler
npm test            # 101 test, internet gerekmez
npm run typecheck   # src + test için sıkı tip denetimi
```

- Testleri çalıştırmak için **Node 22.18+** (testler TypeScript'i doğrudan çalıştırır) ve **`openssl`** komutu gerekir (testler geçici bir TLS sertifikası üretir; repoda anahtar yoktur). Paket kendisi Node 20.19+ ile çalışır.
- Testler Node'un tip soyma modunda çalışır: **`enum`, `namespace`, constructor parametre özelliği (`constructor(private x)`) ve `import x = require()` kullanmayın**; göreli import'larda `.ts` uzantısı yazın.
- **Çalışma zamanı bağımlılığı eklemeyin.** Sıfır bağımlılık bilinçli bir özellik.
- Herkese açık API `src/index.ts` içindeki kısa liste; `test/api.test.ts` onu korur. Genişletmek bilinçli bir karardır.
- Mantık içinde **İngilizce cümle yazmayın**: açıklamalar `{ code, params }` olarak üretilir, metinler `locales/` içindedir.

## Yeni dil eklemek

`locales/en.json` dosyasını `locales/<dil-kodu>.json` olarak kopyalayın, değerleri çevirin (`{yer_tutucu}`'lara dokunmayın), `meta.name` alanına dilin kendi adını yazın. `npm test` anahtarların ve yer tutucuların `en` ile birebir aynı olduğunu denetler. Başka bir şey gerekmez: dil otomatik bulunur.

## Yeni sağlayıcı DNS'i

Sağlayıcınızın DNS adresini ve cevap verdiğini gösterin:

```bash
dig +short @<dns-adresi> <engelli-bir-site>   # engel sayfası IP'si dönüyor mu?
dig +short @<dns-adresi> example.com           # normal cevap veriyor mu?
```

Sonra `config/default.json` içindeki `ispResolvers` listesine ekleyin ve PR açıklamasına **hangi sağlayıcı, hangi ağ (ev/mobil), ne zaman** denediğinizi yazın. Engel sayfası IP'si farklıysa `blockPageIps` listesine de ekleyin.

## Yeni engel imzası

Engel sayfaları ve yönlendirmeler `config/default.json` içindeki `http.signatures` ile tanınır (`where`: `body` ya da `location`, `pattern`: büyük/küçük harf duyarsız düzenli ifade). İmzayı eklerken **yakaladığınız gerçek cevabı** (başlıklar ve gövde, kişisel veri olmadan) PR'a ekleyin ve `test/http.test.ts` içine bir test yazın; normal bir yönlendirmenin imzayla **eşleşmediğini** de sınayın.

## Yanlış sonuç bildirimi

Şunları yazın:

- Komut ve `--json` çıktısı (isterseniz alan adını gizleyin, `evidence` işe yarıyor)
- Sağlayıcı, bağlantı türü (ev/mobil/kurumsal), **VPN açık mıydı**, tarih ve saat
- `trblocked --version`, `node -v` ve işletim sistemi
- Sorun tekrarlanıyor mu? Bazı sonuçlar doğası gereği dalgalıdır (README: [Bilinen sorunlar](README.md#bilinen-sorunlar-ve-sınırlar)); `--injection` ile deneyin.

## Davranış değiştirirken

- Test ekleyin. Gerçek ağda nadir görülen durumlar için `test/check.test.ts` içindeki yerel laboratuvara bakın (Host'a göre cevap kesen, enjekte eden sahte sunucular).
- **Ölçemediğiniz bir "iyileştirmeyi" eklemeyin.** Önerinizi bir ölçümle getirin (tespit oranı, süre); ölçümle gelen değişiklikleri hızla birleştiririz.
- Gerçek ağ doğrulaması CI'da yoktur; PR'da neyi hangi ağda elle denediğinizi yazın.

## Güvenlik ve etik

Bu araç engel **aşmaz**; yalnızca ölçer. Engel aşma ya da CAPTCHA çözme ekleyen PR'ları kabul etmiyoruz. Güvenlik açığı bulursanız herkese açık issue yerine yazara e-postayla bildirin (`package.json` içindeki adres).
