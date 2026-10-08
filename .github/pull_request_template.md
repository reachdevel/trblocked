## Ne değişiyor ve neden?

## Kontrol listesi

- [ ] `npm test` ve `npm run typecheck` geçiyor
- [ ] Davranış değişiyorsa test eklendi (yerel laboratuvar: `test/check.test.ts`)
- [ ] Yeni bir engel imzası / sağlayıcı DNS'i ise: **yakalanan gerçek cevap ya da `dig` çıktısı** eklendi (kişisel veri olmadan)
- [ ] Gerçek ağda elle denendiyse: **hangi sağlayıcı, hangi bağlantı türü, ne zaman** yazıldı
- [ ] Çalışma zamanı bağımlılığı eklenmedi; `src/index.ts` (herkese açık API) değişmediyse `test/api.test.ts` aynı
