# İlginç (BviQ) — strateji bulguları

Cüzdan: `BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU`
Veri: **91.004 işlemin tamamı**, 2026-11-08 16:59 → 2026-11-25 23:03 UTC (17 gün). Sunucuda indirildi (Helius), Binflip decoder ile çözüldü, `analyze.mjs` raporu.
Canlı kayıt (`recorder.mjs`) 2026-11-25 23:00'dan beri sunucuda çalışıyor (işlemler + 2 sn'de bir aktif bin + 5 dk'da bir havuz evreni).

Etiketler: **KESİN** = istisnasız ya da ~%100 · **GÜÇLÜ** = büyük çoğunluk, mantığı belli · **AÇIK** = henüz açıklanamıyor.

## Özet: bot tek cümlede

Fiyatın hemen yanında, `w = round(100/bin_step)` binlik **tek taraflı** bir pozisyon tutar; aktif bin pozisyondan **2 bin** uzaklaşınca tek `rebalance_liquidity` ile pozisyonu aktif binin hemen yanına taşır (SOL ise altına, token ise üstüne), fee'yi her seferinde claim eder; aynı anda ~20 havuzda bunu yapar, pozisyonu ortalama ~40 dk tutar, kapanışta kalan token'ı aynı saniyede satar ve çoğunlukla aynı havuza geri döner.

## A. Geometri

| Parametre | Değer | Etiket |
|---|---|---|
| Genişlik | `w = max(1, round(100 / bin_step))` — bs 1→100?, 5→20, 8→13, 10→10, 15→7, 16→6, 20→5, 25→4, 30→3, 50→2, ≥80→1 | **KESİN** (68.274 / 68.274 rebalance) |
| Yerleşim | SOL → `[aktif−w, aktif−1]`, token → `[aktif+1, aktif+w]`; aktif bine hiç konmaz | **KESİN** (68.273 / 68.274) |
| Şekil | Açılış `SpotImBalanced`, rebalance'ta `delta = 0` (düz) | **KESİN** |
| Taraf | Her işlem tek taraflı; çekilen taraf = eklenen taraf. Taraf değişimi fiyatın bin'i geçmesiyle olur, bot sadece taşır | **KESİN** |
| Pozisyon hesabı | Aynı pozisyon `rebalance_liquidity` ile taşınır; yeni pozisyon açılmaz | **KESİN** |

## B. Rebalance tetiği

| Parametre | Değer | Etiket |
|---|---|---|
| Uzaklık | Aktif bin pozisyonun **≥ 2 bin** dışında → taşı. Uzaklık 1'de **hiç** rebalance yok. Dağılım: ±2 %66, ±3 %15, ±4 %7, ±5+ kuyruk (fiyat atlaması / döngü gecikmesi) | **KESİN** (eşik), GÜÇLÜ (kuyruk = gecikme) |
| Yön | Simetrik (+2: 23.055, −2: 22.103); her bin_step'te aynı | **KESİN** |
| Talimat | `removes=[[min,max,10000]]`, tek `adds` segmenti, `active_id` = görülen bin, `max_active_bin_slippage = 0`, `should_claim_fee = true`, `shrink_mode = 0` | **KESİN** (68.274) |
| Başarısızlık | 12.803 başarısız (%15,8), hepsi `Custom 6004` (bin kayma toleransı); günlük %10–21. Tekrar dener | **KESİN** |
| Hız | Rebalance'lar arası medyan 20–68 sn (rapor); döngü ~5 sn. Kesin döngü süresi canlı kayıttan çıkacak | GÜÇLÜ |

## C. Miktarlar

| Parametre | Değer | Etiket |
|---|---|---|
| Açılış lotu | **Üç kademe: 1 SOL (%43), 2 SOL (%26), 7 SOL (%18)**; kalan %13 ara değerler (1,5–6). Bakiyenin %2–16'sı; bakiyeyle orantılı değil | **KESİN** (kademeler), AÇIK (hangi havuza hangi kademe) |
| Kademe seçimi | bin_step ya da taban fee ile açıklanmıyor (aynı grupta üçü de var). Aday: havuz TVL / hacim / fee-TVL o anda → canlı havuz evreni kaydıyla test edilecek | AÇIK |
| SOL yeniden yatırma | %73: çekilen ana para aynen geri (`yA = yW`), fee cüzdanda kalır (bileşik değil). %20: cüzdandan ek SOL (çoğunlukla lota tamamlama, bazen lotun üstüne çıkma). Kesin formül pozisyon bazında muhasebe ile çıkacak | GÜÇLÜ / AÇIK (ek kısmın formülü) |
| Token tarafı | Token'ın neredeyse tamamı geri konur; `x0` SOL cinsinden değer (program bin fiyatına böler) | GÜÇLÜ |
| Fee | Her rebalance'ta claim. Token fee'leri DLMM `swap/swap2` ya da Jupiter ile SOL'e | **KESİN** (claim), GÜÇLÜ (satış) |

## D. Açılış

| Parametre | Değer | Etiket |
|---|---|---|
| Talimat | `initialize_position + add_liquidity_by_strategy2` (1.647); `max_active_bin_slippage = 0`; ücret 11.000 lamport | **KESİN** |
| Taraf | %99 sadece SOL, `[aktif−w, aktif−1]` | **KESİN** |
| Başarısız açılış | 337 (%17) — aynı kayma hatası | **KESİN** |

## E. Ölçek ve süre

| Parametre | Değer | Etiket |
|---|---|---|
| Eşzamanlı pozisyon | Medyan 21, q10–q90 9–25, en fazla 33 | **KESİN** |
| Pozisyon ömrü | Medyan 37 dk (q25 9 dk, q75 112 dk, q90 6 saat) | **KESİN** |
| Pozisyon başına rebalance | Medyan 13 (q75 35, q90 80) | **KESİN** |
| Günlük | 57–170 açılış, 2.300–9.500 işlem, işlem ücreti günde 0,02–0,07 SOL | **KESİN** |

## G. Kapanış

| Parametre | Değer | Etiket |
|---|---|---|
| Talimat | `remove_liquidity_by_range2 (10000) + claim_fee2 + close_position_if_empty` | **KESİN** |
| Kapanış anı | %60'ında aktif bin pozisyona 1 bin uzakta (normal duruş) → çıkış "fiyat kaçtı" değil, ayrı bir karar | **KESİN** (gözlem), AÇIK (kural) |
| Çıkan taraf | SOL %65, token %24, karışık %10 | **KESİN** |
| Kalan token | Kapanıştan **0–1 sn** sonra satılır (Jupiter 2.731, DLMM swap2 2.100, swap 894) | **KESİN** |
| Çıkış kuralı adayı | Rapor: son 15 dk'da fiyat >%10 oynama (çıkışların %18–47'si). Canlı kayıt + dakikalık fiyatla test edilecek | AÇIK |

## H. Yeniden giriş

| Parametre | Değer | Etiket |
|---|---|---|
| Aynı havuza dönüş | Kapanışların **%82'si** (1.337 / 1.635) | **KESİN** |
| Bekleme | q10 4 sn, q25 4 dk, medyan 50 dk, q75 5,4 saat | **KESİN** (dağılım), AÇIK (koşul) |

## E2. Havuz evreni (girilen 323 havuz)

| Parametre | Değer | Etiket |
|---|---|---|
| Çift | 316 SOL, 5 USDC, 2 diğer | **KESİN** |
| bin_step | 100 (138), 200 (53), 80 (51), 20, 50, 125, 10, 25… | **KESİN** |
| Taban fee | Çoğu %1–3 (2: 132, 1: 58, 3: 25, 5: 21), ama %0,01–0,5 olanlar da var → "taban fee ≥ %1" filtresi **yok** | **KESİN** |
| Launchpad | pump.fun 216, yok 67, raydium-launchlab 17, stonkfun 11, met-dbc 8 | **KESİN** |
| Havuz yaşı (açılışta) | q10 16 dk, q25 2,7 saat, medyan 6,8 gün, q75 64 gün → hem yeni hem eski havuzlar | **KESİN** |
| Seçim kuralı | AÇIK — canlı evren kaydıyla (girdiği vs girmediği) çıkarılacak | AÇIK |

## I. Yürütme

| Parametre | Değer | Etiket |
|---|---|---|
| Format | Rebalance'lar v1 işlem, compute ayarı mesajda; 6.000 lamport. Açılış 11.000; swap 15.000 (ComputeBudget talimatlı) | **KESİN** |
| Jito / bahşiş | Yok | **KESİN** |
| İmzalayan | %99,6 BviQ; kasa `GcEZ…` 43 işlem (fonlama) | **KESİN** |

## J. Para akışı

| Parametre | Değer | Etiket |
|---|---|---|
| Fonlama | Kasa `GcEZ…` → BviQ: 8–19 Kasım arası 43 transfer (0,1–12,5 SOL) | **KESİN** |
| Çıkış | 2026-11-20 02:24: 20 SOL → `9gbS…` | **KESİN** |
| Bakiye | Açılışlarda görülen SOL bakiyesi 12 → 71 SOL arası | **KESİN** |

## Kalan açık sorular (öncelik sırasıyla)

1. **Havuz seçimi ve giriş tetiği** → canlı havuz evreni (5 dk) + dakikalık OHLCV; girdiği/girmediği karşılaştırması, karar ağacı.
2. **Çıkış kuralı** → kapanış öncesi fiyat/hacim/volatilite (canlı kayıt `v_parameters.volatility_accumulator` dahil).
3. **Lot kademesi** (1 / 2 / 7 SOL) → giriş anındaki havuz metrikleriyle.
4. **SOL ek yatırma formülü** → pozisyon bazında muhasebe (claim + fee satışı dahil).
5. **Döngü süresi** → canlı kayıtta uzaklık 2'ye ulaşma anı ile rebalance anı arasındaki gecikme.

---

## Güncelleme 27 Kasım: giriş, çıkış ve lot (dakikalık veri) + gölge motor

Kaynak: GeckoTerminal 1 dk mumları (323 havuz, 644 istek), `features.mjs`. Her karar için karar dakikasından **önceki** dakikalar kullanıldı. Kontrol = aynı havuzda açılıştan 2 saat önce (pozisyon yokken). `spike5` = son 5 dk hacmi / saatin 5 dk ortalaması (tavanı 12: saatin bütün hacmi son 5 dk'daysa).

### Giriş (1.340 açılış / 827 kontrol) — **GÜÇLÜ**

| Ölçüt | Açılış medyan (q25–q75) | Kontrol medyan (q25–q75) |
|---|---|---|
| 5 dk hacim ($) | 1.346 (83–6.002) | 123 (0–1.187) |
| spike5 | **2,9** (0,92–12) | 0,57 (0,1–1,3) |
| 15 dk fiyat aralığı % | 11,6 (2,0–32) | 7,2 (3,1–14,5) |
| Son 15 dk işlem olan dakika | 10 | 6 |
| 5 dk fiyat değişimi q10/q90 | −14,5 / +14,7 | −4,5 / +4,4 |

→ Açılışlar bir **hareket/hacim patlamasının hemen arkasından** geliyor, yön fark etmiyor (5 dk fiyat değişimi medyanı 0, kuyruklar iki yönde de kalın). Açılışların ~%75'inde spike5 ≥ 0,9; kontrolün %75'inde ≤ 1,3. Kesin eşik ve ikinci koşul için canlı evren kaydı (girmediği havuzlar) gerekiyor.

### Lot kademesi — **GÜÇLÜ aday kural: volatiliteye ters**

| Lot | n | 15 dk fiyat aralığı medyan | 1 saat hacim medyan | Launchpad |
|---|---|---|---|---|
| **7 SOL** | 292 | **%1,2** | $123 | %84 launchpad'siz (LST: strongSOL, xSOL; tokenize: QNT, LTC, LLY, WLFI…) |
| 2 SOL | 191 | %29,6 | $27k | çoğu pump.fun |
| 1 SOL | 711 | %20,4 | $18,5k | çoğu pump.fun |

→ Sakin (düşük volatiliteli) tokenlara büyük lot, volatil memecoin'lere küçük lot. Aynı havuz (GMEx, NEURALINK) farklı zamanlarda farklı kademe alabiliyor → kademe havuz tipinden çok **açılış anındaki volatiliteye** bağlı olabilir. Eşik testi sırada.

### Çıkış (1.329 kapanış / 1.089 pozisyon ortası) — **AÇIK**

Fiyat ve hacim kapanışı açıklamıyor: spike5 0,62 vs 0,46, 15 dk aralık %19,3 vs %17,4, 5 dk fiyat değişimi kuyrukları benzer. Tutma süresi medyan 56 dk; tutarken fiyat değişimi q25/q75 −%5,9 / +%5,9 (simetrik). → Sıradaki aday: **pozisyon bazında kâr/zarar** (envanter kaybı, fee/kayıp oranı) ve süre. Pozisyon muhasebesi yazılacak.

### Gölge motor (WebSocket + processed, 406 karşılaştırma, ~8 saat)

Birebir %85,7 · doğru taraf %93,3 · görmeden kaçırma %5,2 (çoğu tam +2) · yanlış taraf %1,2 · kural farkı %0,2 · karar gecikmesi medyan 0 sn. Önceki sürüm (2 sn okuma, confirmed): birebir %70, görmeden kaçırma %19,5.
Bilinen sorun: public RPC WebSocket'i saatte ~37 kez kopuyor (1006); boşlukları 2 sn'lik okuma dolduruyor. Yanlış taraf vakaları incelenecek (aday: processed seviyesinde sonradan geri alınan durum).

---

## Güncelleme 28 Kasım: çıkış (pozisyon muhasebesi) ve Helius WebSocket

Kaynak: `pnl.mjs` (tam veri, 1.602 kapanan pozisyon; +33 SOL lotsuz dışarıda), `exit2.mjs`, `waits.mjs`. Kâr/zarar = pozisyon değeri (token, aktif bin fiyatıyla) + toplanan fee + cüzdana dönen − yatırılan; lotun yüzdesi.

### Kârın kaynağı — **KESİN**
- Toplam kâr/zarar **+90,9 SOL**; toplanan fee **1.072,8 SOL**; envanter sonucu ≈ **−982 SOL**. Fee'nin ~%92'si fiyat/envanter kaybına gidiyor.
- Kârla kapanan pozisyon %43,4. Kapanışta kâr/zarar medyanı 0 (q10 −%14, q90 +%15) → sabit TP/SL eşiği yok.

### Çıkış 1: hareketsizlik zaman aşımı — **GÜÇLÜ**
Son taşımadan (ya da açılıştan) kapanışa kadar geçen süre, 5 dk kovalarla: `0–5: 1.161 · 5–50: 30 · 50–55: 7 · 55–60: 92 · 60–65: 82 · 65–70: 26 · …`
Hiç taşınmayan 272 pozisyonun tutma süresi: 54–61 dk'da yığılıyor (medyan 61). → **Yaklaşık 55 dk rebalance olmazsa kapat.** 5–50 dk aralığında neredeyse hiç kapanış yok. Kuyruk (65–180+ dk, ~200 kapanış): kural bunlarda liderden önce kapatırdı; lider bazen daha uzun bekliyor (ikinci koşul açık: aralık içinde süren fee?).

### Çıkış 2: aktivite yavaşlayınca — **GÜÇLÜ ipucu, eşik AÇIK**
1.142 "aktif" çıkış (son taşımadan < 5 dk sonra): kapanış öncesi son 15 dk taşıma sayısı medyan 10 (diğer anlarda 14), önceki taşımadan geçen süre 47 sn (diğerlerinde 17 sn), girişten kayma daha az (11 vs 15 bin). Sıçrama büyüklüğü farksız (medyan 2). → Hareket hızlanırken değil, **soğurken** çıkıyor.

### Lider neden bazen geç taşıyor — **KESİN (kısmi)**
Gölge motorun liderden önce davrandığı 36 incelenebilir vakanın 21'inde lider aynı pencerede taşımayı **denemiş ama başarısız** olmuş (hepsi `Custom 6004`, bin kayma toleransı); 15'inde hiç denememiş. Vakaların yarısı iki havuzda (BfREfu…, BFKBQT… = XMR-SOL, tarihsel başarısızlık %28,7). → Uyumsuzluğun önemli kısmı liderin kendi işlem başarısızlıkları; canlıda biz de yaşayacağız.

### Gölge motor, Helius WebSocket (~11 saat, 741 karşılaştırma)
Birebir %81,6 · doğru taraf %93,1 · görmeden kaçırma **%2,4** (public RPC'de %5,2) · kural farkı %2,3 · yanlış taraf %2,2 (çoğu yukarıdaki iki havuzda, liderin başarısız denemeleri) · WebSocket kopması 11 saatte 2 (public'te saatte ~37) · kararların %97'si WebSocket'ten.
