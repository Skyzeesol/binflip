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
