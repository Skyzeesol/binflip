# Denetim sonrası düzeltilmiş rapor (28 Kasım 2026)

Kapsam: `2a46516` denetimi (Codex). Kod `2d1db96` (`research/ilginc`). Bütün sayılar sunucudaki tam arşivden, ayrı bir worktree'de (`~/ilginc/binflip-report`) üretildi; çalışan gölge servisine ve eski çıktılara dokunulmadı. Çalıştırma: `research/ilginc/report_run.sh`.

## 1. Gölge uyumu: %81,6 yeniden hesaplandı

**Canlı gölge pencereleri, eski (`2a46516`) ve yeni puanlama, aynı girdiyle** (`rescore.mjs`; liderin işlemi blok zamanından 3 sn sonra işlenmiş varsayılır; 2 ve 5 sn duyarlılık parantezde):

| Pencere | Karşılaştırma | Slotlu | Birebir, eski | Birebir, yeni | Birebir ve slota göre önce, yeni |
|---|---|---|---|---|---|
| mm-data-v1 | 1.223 | yok | %85,4 (77,8–80,9) | %85,4 | doğrulanamaz |
| mm-data-v2 | 288 | yok | %76,0 (72,6–69,4) | %76,0 | doğrulanamaz |
| mm-data-v3 | 1.660 | yok | %85,8 (86,6–81,9) | %85,8 | doğrulanamaz |
| mm-data-v4 | 780 | yok | %77,6 (80,4–70,6) | %77,6 | doğrulanamaz |
| mm-data-v5 | 72 | %96 | %76,4 | %76,4 | **%76,4** |
| mm-data (şu an) | 66 | %98 | %80,3 | %81,8 | **%81,8** |

- %81,6 eski pencerelerin canlı puanıydı. Yeniden puanlama bu pencerelerde eski ve yeni sürümde aynı sonucu veriyor (fark sadece slotlu pencerelerde, +1,5 puan). Sonuç liderin işleminin ne zaman işlendiği varsayımına duyarlı: aynı pencere 2–5 sn aralığında 10 puana kadar oynuyor.
- **Zamanında karar** sadece slotlu pencerelerde ölçülebiliyor: **%76–82** (138 karşılaştırma). Eski pencerelerde (4.000'den fazla) slot yok, oradaki "zamanında" iddiası doğrulanamaz.
- "Önce" = kararı tetikleyen fiyat gözleminin slotu; yerel karar zamanı liderin bloğundan sonra olan "önce" kararlar ayrıca sayılıyor: canlı pencerelerde %0.

**Kayıtçı arşivi üzerinde yeniden oynatma** (`shadow_replay.mjs`, 6.621 karşılaştırma, aynı girdi): eski %66,3 → yeni %66,6 birebir; slota göre önce %24,3, aynı slot %6,9, sonra %35,4. Kayıtçı havuzları 2 sn'de bir HTTP ile okuyor; canlı servis WebSocket kullanıyor. Bu yüzden bu sayı canlı gölgeyi değil, yavaş gözlemle ne olacağını gösterir.

## 2. +90,9 SOL yeniden hesaplandı

| Ölçüm | Eski | Yeni |
|---|---|---|
| Tahmin (`pnl.mjs`, kapanan pozisyonlar) | +90,94 SOL (1.602) | **+83,36 SOL** (1.615; fee 1.092 SOL) |
| SOL'ün Y olmadığı havuz | dahildi (yanlış fiyat) | 22 pozisyon dışarıda |
| Zincir seviyesi: tahmin / **cüzdanda gerçekleşen** | 88,54 / 59,08 (%92) | 85,08 / **58,14 SOL** (%91,0, 1.488 pozisyon) |
| Pozisyon seviyesi (588): tahmin / gerçekleşen | 0,63 / −7,06 | −1,91 / −7,51 SOL |
| Hiçbir pozisyona atfedilemeyen satış | raporlanmıyordu | 1.657 / 5.853 imza, 426,75 SOL |
| Cüzdan seviyesi | −61,12 | −61,12 SOL (170 satılmamış token ve dönem başı/sonu açık pozisyonlar hariç; tek başına yorumlanamaz) |

- **+90,9 SOL kullanılmamalı.** Doğrulanabilen en iyi sayı: 8–25 Kasım'da pozisyonların %91'inde **cüzdanda gerçekleşen +58,1 SOL**.
- Tahmin, gerçekleşenden pozisyon başına 0,018 SOL fazla (toplam −26,9 SOL). Sebep: kapanışta kalan token aktif bin fiyatından değerleniyor, gerçek satış daha kötü.
- Düzeltilen hatalar: ayrı eklemeler, kısmi çekimler ve ayrı fee claim'leri artık sayılıyor. Oran, en yüksek yatırılan sermayeye göre hesaplanıyor. Aynı mint'in birden çok token hesabı toplanıyor. Her pozisyon kendi olaylarını taşıyor ve cüzdan değişimi imza başına bir kez sayılıyor. Rebalance ile swap aynı imzadaysa iki kez sayılmıyor. Dönem sonunda açık olan aynı token pozisyonları da çakışma kontrolüne giriyor.

## 3. Hipotezler, önceden ayrılmış dönemde (`holdout.mjs`, ayrım 20 Kasım)

Eşikler sadece eğitim döneminden (8–19 Kasım) çıkarıldı, test dönemi (20–25 Kasım) bir kez puanlandı.

| Hipotez | Eğitim | Test | Sonuç |
|---|---|---|---|
| H1 giriş: hacim sıçramasından sonra açılış (`spike5 ≥ 0,9`) | açılış %68,6 vs kontrol %38,2, AUC 0,735 | %60,4 vs %42,6, AUC 0,641 | **Zayıflıyor**, ama rastgeleden iyi |
| H2 lot: düşük volatilite → büyük lot | kural %43,8 vs taban %64,5 | %42,4 vs %58,7 | **Reddedildi** (her zaman en sık lotu seçmekten kötü) |
| H3 çıkış: ~55 dk taşıma yoksa kapat | pasif kapanışların %38,7'si 50–65 dk'da | %42,8 | **Tutuyor** |
| H4 havuz seçimi (aynı andaki evren, uygun havuzlar arasında yüzdelik) | fee/TVL, hacim, fee ilk %10 civarı; ilk %20'de olma payı 0,71–0,82 | yüzdelik aynı (~0,9), ilk %20 payı 0,54–0,65 | **Sinyal var, zayıflıyor**; TVL, piyasa değeri, holder sinyal değil; seçilen havuzlar genç (yaş yüzdeliği 0,18) |

Uyarılar: H1'de eski mum dosyalarında kapsam bilgisi yok; 461 açılışın hacmi "bilinmiyor" sayıldı (eskiden sıfır sayılıyordu). H4 sadece kayıtçının çalıştığı 26–28 Kasım'dan, 86 açılış.

## 4. Sonuç

- Gölge motoru, slotlu pencerelerde liderin taşımalarının **%76–82'sini birebir ve önceden** veriyor. Eski %81,6 bu ölçüyle ancak bu küçük pencerelerde doğrulanıyor.
- Liderin gerçekleşen sonucu **+58,1 SOL** (17 gün, %91 kapsam). +90,9 değil.
- Canlı pilot giriş ve çıkışta lideri izliyor. Bu yüzden pilot sadece mekaniği (taşıma, kapanış, satış) doğrular; liderden bağımsız bir strateji (H1–H4) doğrulanmış olmaz. Bağımsız strateji için H2 bırakılmalı, H1 ve H4 daha uzun bir test penceresiyle yeniden sınanmalı.
