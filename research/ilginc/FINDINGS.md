# İlginç (BviQ) — strateji bulguları

Cüzdan: `BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU`
Geçmiş: 90.934 işlem, 2026-11-08 16:59 UTC → bugün (17 gün).
Kaynak: public RPC (`getSignaturesForAddress` + `getTransaction`), Binflip Meteora decoder, Meteora datapi.

Etiketler: **KESİN** = örnekteki her işlemde görüldü · **ÖN** = örnekte görüldü, tam veriyle doğrulanacak · **AÇIK** = bilinmiyor.

Durum: ilk ~1.900 işlem (son ~2 gün) üzerinde. Tam geçmiş iniyor; sayılar tam veriyle güncellenecek.

## A. Pozisyon geometrisi

| Parametre | Değer | Etiket |
|---|---|---|
| Genişlik | `w = max(1, round(100 / bin_step))` (bs 10→10, 15→7, 16→6, 20→5, 25→4, 50→2, ≥80→1) | KESİN (656/656 rebalance) |
| SOL tarafı yerleşim | `[aktif−w, aktif−1]`, aktif bine dokunmaz | KESİN |
| Token tarafı yerleşim | `[aktif+1, aktif+w]` | KESİN |
| Şekil | `SpotImBalanced` açılışta; rebalance'ta `delta=0` (düz/spot) | KESİN |
| Taraf | Her rebalance tek taraflı. Çekilen taraf = eklenen taraf; taraf değişimi rebalance ile değil, fiyatın bin'i geçmesiyle oluyor | KESİN |
| Pozisyon yeniden kullanımı | Aynı pozisyon hesabı `rebalance_liquidity` ile taşınıyor (yeni pozisyon açılmıyor) | KESİN |

## B. Rebalance tetiği

| Parametre | Değer | Etiket |
|---|---|---|
| Tetik uzaklığı | Aktif bin aralığın **2 bin** dışında (araya 1 boş bin) → taşı. Daha büyük uzaklıklar (3–7) fiyat atlaması/gecikme | ÖN (mod 2: 459/656) |
| Yön | Yukarı ve aşağı simetrik (+2: 221, −2: 238) | ÖN |
| Talimat | Tek `rebalance_liquidity`: `removes=[aralık, 10000 bps]`, `adds=[tek segment]`, `max_active_bin_slippage=0`, `should_claim_fee=true`, `shrink_mode=0`, `max_deposit_*=0` | KESİN |
| Başarısızlık | ~%11–13 (`ExceededBinSlippageTolerance`); tekrar deniyor | ÖN |

## C. Miktarlar ve envanter

| Parametre | Değer | Etiket |
|---|---|---|
| SOL tarafı miktar | **Sabit lot** yeniden yatırılır (`y0 × w = lot`). Fee ve fazla SOL cüzdanda kalır — **bileşik yok** (rapordaki "ücretle geri koy" yanlış) | KESİN (313/313) |
| Token tarafı miktar | `x0` **SOL cinsinden değer** (program bin fiyatına bölüyor). İlk token yerleşiminde `x0 = önceki SOL çekimi` (ör. 1,008 SOL). Elindeki token'ın neredeyse tamamı geri konuyor, küçük artıklar cüzdanda | ÖN |
| Fee | Her rebalance'ta claim ediliyor (`should_claim_fee`). Token fee'leri ayrı küçük swap'larla (DLMM `swap2` / Jupiter) SOL'e çevriliyor | ÖN |
| Kapanış | `remove_liquidity_by_range2 + claim_fee2 + close_position_if_empty`; kalan token Jupiter ile satılıyor (bazen 2 parçada) | ÖN |
| Açılış lotu | 1, 1,16, 2, 2,04, 4,27, 7 SOL… — havuza göre değişiyor | AÇIK (kural?) |

## I. Yürütme

| Parametre | Değer | Etiket |
|---|---|---|
| İşlem formatı | **v1 işlem**, compute ayarı mesaj içinde (ComputeBudget talimatı yok) | KESİN |
| Ücret | Rebalance 6.000 lamport, açılış 11.000, swap 15.000 (ComputeBudget talimatlı, v0) | KESİN |
| LUT | Az kullanılıyor (~%10) | ÖN |
| Talimat sırası (rebalance) | `ATA create (idempotent) ×2 → DLMM rebalance_liquidity → Token` (+ gerekirse WSOL wrap: System transfer + SyncNative) | KESİN |
| Swap | Jupiter v6 (`JUP6Lk…`) ve doğrudan DLMM `swap/swap2` | KESİN |

## E. Havuz evreni

| Parametre | Değer | Etiket |
|---|---|---|
| Çift | Çoğu SOL (Y=WSOL), az sayıda USDC çifti | ÖN |
| Taban fee | %0,03 – %3 arası (rapordaki "≥ %1" filtresi **yok**) | ÖN |
| bin_step | 10 – 200 | ÖN |

## Açık sorular

- Açılış lotu kuralı (sabit liste mi, TVL/hacim oranı mı, bakiye yüzdesi mi?)
- Giriş tetiği ve havuz sıralaması (D, E, F)
- Çıkış kuralı (G) ve yeniden giriş (H)
- Tetik 2 bin mi, yoksa "2 bin + süre" mi? → canlı havuz kaydıyla (aşama 4)
- Cüzdan rotasyonu (J)
