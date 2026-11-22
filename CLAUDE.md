# Binflip — Copy LP + Bid-Ask Flip Botu (Solana / Meteora)

> Bu dosya Claude Code'a proje bağlamını aktarmak için hazırlandı. Repo kökünde `CLAUDE.md` olarak da kullanılabilir.
> Tarih: 22 Kasım 2026

---

## 1. Ne yapıyoruz?

Meteora DLMM (ve DAMM V2) üzerinde **başarılı LP cüzdanlarını kopyalayan** ve kopyalanan pozisyonları **kendi kurallarımızla yöneten** (bid-ask flip, auto-compound, TP/SL) profesyonel bir uygulama. 7/24 bir **VPS** üzerinde çalışacak. Amatör bir script değil, ürün kalitesinde olacak.

**Bugünkü elle yapılan akış (otomatikleşecek olan):**
1. Lider cüzdan (ör. "Disiplinli Karınca") pozisyon açar.
2. Biz aynı havuzda HawkFi üzerinden elle pozisyon açıyoruz.
3. HawkFi fee'leri compound ediyor.
4. Fiyat belirli bir % düşünce bid-ask likiditesini çekip ters tarafa (fiyatın üstüne) koyuyor. Fiyat dönünce oradan da kazanıyoruz.
5. Lider pozisyonu kapatınca biz de kapatıyoruz.

**Neden kendi botumuz:** Aylık hedef 50–100 SOL fee. HawkFi getirinin **%8'ini** alıyor (yatırma/çekme/otomasyon %0), yani ayda 4–8 SOL. Ayrıca lider cüzdanlar değişebilir ("Karınca yarın öbür gün gider, bizim app baki"), bu yüzden çok cüzdanlı bir **Copy LP sayfası** gerekiyor.

---

## 2. Kesin kararlar

| Konu | Karar |
|---|---|
| Pozisyon büyüklüğü | **Biz seçeceğiz.** Cüzdan başına: liderin %'si ya da sabit SOL, üst sınırlı. |
| Lider cüzdanlar | Tek cüzdana bağlı değil. Cüzdan ekleme/çıkarma/duraklatma panelden yapılır. |
| Çalışma ortamı | VPS, 7/24. Docker, izleme ve loglarla. |
| Kalite | Profesyonel: kuyruk, tekrar deneme, idempotency, testler, gözlemlenebilirlik. |
| HawkFi | Kullanılmayacak. İşlevleri (flip, compound, reshape) bizim botta olacak. |
| warlock-v2 (github.com/sicknature-x/warlock-v2) | Doğrudan kullanılmayacak (denetlenmemiş, swap'larda %0,5 referans ücreti var). Sadece fikir kaynağı. |

---

## 3. Strateji spesifikasyonu

### 3.1 Kademeli Bid-Ask Flip (varsayılan mod)
Kaynak: yunus (@0xyunss), "Why Bid-Ask Flip on Meteora?" makalesi ve görselleri.
- **Başlangıç:** Fiyatın altına tek taraflı SOL ile **bid-ask** pozisyon. Likidite aralığın alt ucunda yoğun.
- **Tetik:** Fiyat giriş seviyesinden (ya da son flip'ten) **%14 düşünce** (ayarlanabilir, %10–17 arası). 100 binstep'te yaklaşık **15 bin** ediyor (1,01^15 ≈ %16).
- **İşlem:** Pozisyonun **sadece token'a dönüşmüş bin'leri** çekilir. Bu token'lar fiyatın hemen üstünden başlayan, yukarı doğru yoğunlaşan bir **bid-ask (ask tarafı)** dağılımıyla geri eklenir. **Aşağıdaki SOL bin'lere dokunulmaz.**
- **Swap yok:** Token zaten elimizde, fiyatın üstüne tek taraflı ekleniyor.
- **Mantık:** Dipte al (bid), yukarıda sat (ask). Kazanç = fee + pozitif IL/sermaye kazancı. Düşük hacimli token'larda da çalışıyor. Yazarın iddiası: kâr/fee oranı ~%92; normal bid-ask'te 1/3–1/2.
- Diğer yazıda eşik %10. **Eşik, cüzdan/pozisyon bazında ayarlanabilir olmalı.**

### 3.2 Dipte Flip (HawkFi "Heart Attack Ping Pong (Bid-Ask-Flip)" eşdeğeri)
- Şekil: Bid-Ask. Auto-rebalance: **Down Only**, cooldown 0 dk, swapless, "Ping Pong 69-0-69" = **AR aşağıda toplam 69 bin – 0 bin spread – AR yukarıda toplam 69 bin** (HawkFi Ping Pong sayfasında doğrulandı, bkz. §14.2).
- Aralığın tamamı token'a dönünce (out of range below) hepsi çekilir ve 0 spread ile fiyatın üstüne bid-ask olarak konur.
- HawkFi varsayılanları: TP (SOL) %7; SL (SOL) havuz fiyatı düşüşünde, eşik belirtilmemiş.

### 3.3 Precision Hybrid (HawkFi modeli, ikinci aşama)
- Şekil: aktif bin etrafında **%50 Spot + %50 Bid-Ask**.
- İdeal giriş: düzeltmede, geniş aralık, sadece SOL.
- **Reshape Liquidity (RL):** Aralık sabit kalır, sadece dağılım aktif bin etrafında yeniden kurulur. Tetik: aktif bin N bin kayınca (HawkFi aralığı 1–51 bin).
- "+ Rebalance" varyantı: RL 34 bin, AR yukarı ve aşağı, cooldown 0, Ping Pong 68-0-68, auto-compound açık.
- Precision Flip: Curve (RL 5 bin) ile Hybrid (RL 12 bin) arasında kenarda geçiş, flip buffer 2 bin.

### 3.4 Ortak kurallar
- **Auto-compound:** Fee'leri belirli aralıklarla claim edip pozisyona ekle (ya da SOL'e çevir, ayarlanabilir).
- **TP/SL:** SOL ya da USD bazında. yunus: TP en az %10, SL %10 ama önce tepki beklenir (**trailing stop**).
- **Çıkış:** Lider kapattı **VEYA** bizim TP/SL tetiklendi; hangisi önce gelirse.
- **Token filtresi (opsiyonel):** Yaş ≥ 2–3 gün, piyasa değeri ≥ 300k, meme guard.
- **Maliyet farkındalığı:** HawkFi bin başlatma ücretlerini karşılıyordu, artık **bin array rent'ini biz ödüyoruz.** Sık reshape/flip = işlem ücreti. Eşikleri çok küçük tutma, maliyeti logla.

---

## 4. Ürün spesifikasyonu — Copy LP sayfası

Model: LP Agent'ın Copy LP sayfası (app.lpagent.io/copying) + HawkFi'nin pozisyon yönetimi.

### Cüzdan başına ayarlar (6 adım)
1. **Boyut:** % of leader | sabit SOL | pozisyon başına üst sınır | tek işlemde en fazla ekleme (SOL). Önerilen % = bizim net varlık / liderin net varlığı (LP Agent örneği: 16.48 / 134.62 → %12). Lider aynı pozisyona sonradan ekleme yaparsa ilk oran korunur, üst sınır aşılmaz.
2. **Çıkış kuralları:** Liderle çık + TP % + SL % + trailing SL, para birimi SOL/USD.
3. **Ne kopyalanacak:** DLMM stratejileri (Spot / Curve / BidAsk / Custom) seçilebilir | DAMM V2 | DLMM Pro (beta).
4. **Koruma:** Meme Protection (güvenilir taraf (SOL/USDC/USDT) neredeyse boşsa atla) | Smart Token Retention (lider çıkınca token'ı bir süre tut, geri eklerse sat-al yapmadan yeniden kullan) | yaş ve piyasa değeri filtresi.
5. **Etiket + agent cüzdanı.**
6. **Pozisyon yönetimi (bizim farkımız):** Sadece aynala | Kademeli flip (eşik %) | Dipte flip | Precision Hybrid (RL bin) + compound aralığı + fee'leri SOL'e çevir.

### Genel
- **Fon koruması:** Kapanan pozisyonlardaki toplam zarar X SOL'e ya da net varlığın %Y'sine ulaşırsa bütün kopyalar durur (LP Agent örneği: 1.57 SOL = %6).
- **Kopya kayıtları** (her olay ve işlem), **Analiz** (cüzdan bazında PnL, fee, açılan pozisyon; 7G/1A/3A/Tümü).
- **Telegram bildirimleri** ve **/stop acil durdurma komutu.**
- Durum rozetleri: Aktif / Duraklatıldı.

### Referans: kullanıcının mevcut LP Agent ayarları
| Cüzdan | Adres | Boyut | Çıkış | Kapsam | Sonuç |
|---|---|---|---|---|---|
| kelebek (tek aktif) | 9c8JPG...1uTM (tam adres LP Agent'tan alınacak) | %28, üst sınır yok | Kapalı | DLMM (hepsi) + DAMM V2 | 629 pozisyon, +42.36 SOL |
| Disiplinli Karınca | `zbmg9d5xHtouvKtFGqASdKbHEQ4bQdJwqtQPkdvc3Ud` | %50 | TP5/SL5 | DLMM + DAMM V2, meme guard açık | Yeni |
| fenaolabilir | 4fj7Kv...y4r6 | %50 | Kapalı | Hepsi | +15.63 SOL |
| patates2 | 7z5pz9...8VB8 | %96 | Kapalı | Hepsi | +7.13 SOL |
| metatrader | 7MGuNv...XJ42 | %25 | Kapalı | Sadece DLMM | +0.86 SOL |

Not: Kâr eden cüzdanlarda otomatik çıkış kapalı (liderle çıkılıyor).

---

## 5. Mimari (öneri)

```
[Helius gRPC/WebSocket] → listener → events (Redis/BullMQ) → executor → Solana
                                             ↓
                                position-manager (flip / compound / TP-SL döngüleri)
                                             ↓
                            Postgres ←→ API ←→ Next.js panel (Copy LP sayfası)
                                             ↓
                                      Telegram bot
```

- **Dil:** TypeScript, Node 20+, monorepo (pnpm workspaces): `apps/listener`, `apps/executor`, `apps/manager`, `apps/api`, `apps/web`, `packages/core` (meteora, strategy, sizing), `packages/db`.
- **Zincir:** `@meteora-ag/dlmm` (resmi DLMM SDK), DAMM V2 için resmi Meteora SDK, `@solana/web3.js`, gerekirse Jupiter (sadece çıkışta token→SOL).
- **Algılama:** Lider cüzdanlarda Meteora program çağrıları.
  - DLMM program ID: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (**SDK/IDL'den doğrula**)
  - DAMM V2 program ID: `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (**doğrula**)
  - İlgili instruction'lar (IDL'den doğrula): initializePosition, addLiquidityByStrategy(OneSide), addLiquidityByWeight, removeLiquidity(ByRange), claimFee, closePosition.
  - Liderin pozisyonundan şunlar çıkarılır: havuz, lowerBinId/genişlik, strateji tipi, miktarlar. Bunlar bizim boyuta ölçeklenir.
- **Yürütme:** Öncelik ücreti, simülasyon, slippage limiti, tekrar deneme, **idempotency** (aynı lider olayına tek işlem). Pozisyon başına durum makinesi: OPENING → ACTIVE → FLIPPING → CLOSING → CLOSED.
- **Veri:** Postgres (Prisma ya da Drizzle): leaders, copy_settings, positions, events, txs, pnl_snapshots.
- **Panel:** Next.js. Giriş, cüzdanla mesaj imzalayarak.
- **Telegram:** grammy. Bildirimler + /status /pause /stop.
- **Dağıtım:** Docker Compose (VPS), healthcheck, yapılandırılmış loglar, Sentry ya da benzeri.

---

## 6. Güvenlik kuralları (zorunlu)

- **Ayrı agent cüzdanı.** Ana cüzdanın anahtarı asla kullanılmaz.
- Anahtar repoya, `.env`'e ya da loglara **yazılmaz**. Sunucuda şifreli saklanır, panele hiç gelmez.
- **DRY_RUN=1 varsayılan.** Canlıya geçmek için açık `LIVE_CONFIRMED=1` + kullanıcının kendi eylemi gerekir.
- İşlem başına ve gün başına SOL limitleri, fon koruması, acil durdurma.
- Anahtarı girmek ve canlıya almak **kullanıcının adımıdır.**

---

## 7. Aşamalar ve kabul kriterleri

1. **İskelet:** Monorepo, DB şeması, config, Docker. → `docker compose up` çalışıyor.
2. **Dinleyici + deneme modu:** Kayıtlı cüzdanların DLMM olaylarını gerçek zamanlı yakalar, "şunu yapardım" kaydı ve Telegram mesajı üretir. → Karınca ve kelebek'in açma/kapamaları birkaç saniye içinde doğru boyutla loglanıyor.
3. **Canlı kopya (tek cüzdan, küçük boyut):** Açma/kapama aynalama. → Devnet ya da çok küçük mainnet testi.
4. **Pozisyon yöneticisi:** Kademeli flip + compound + TP/SL/trailing. → Fiyat simülasyonuyla birim testleri; dlmmsim.xyz ile mantık karşılaştırması.
5. **Panel:** Copy LP sayfası (6 adım), kayıtlar, analiz.
6. **Ek modlar:** Dipte flip, Precision Hybrid (RL), DAMM V2 kopya, Smart Token Retention.

---

## 8. Açık sorular (kullanıcıya sor)

1. **Uygulamayı kim kullanacak?** Sadece biz mi, yoksa başka kullanıcılar da mı? Çok kullanıcılıysa anahtar saklama, güvenlik ve hukuki sorumluluk bambaşka bir mimari gerektirir. **Bu, en kritik karar.**
2. Kademeli flip varsayılan eşiği %14 mü, %10 mu?
3. TP/SL varsayılanları (yunus: %10/%10 trailing; HawkFi: TP %7).
4. Helius plan ve RPC bütçesi; VPS sağlayıcısı ve bölgesi.
5. kelebek ve diğer cüzdanların tam adresleri (LP Agent'tan).

---

## 9. Kaynaklar

- HawkFi dokümanları: https://hawkfi.gitbook.io/whitepaper (index: /llms.txt)
  - Ücretler: /faqs · Precision Hybrid: /hawkfi-solana/hawkfi-models/precision-hybrid
  - Heart Attack Ping Pong: /hawkfi-solana/hawkfi-models/heart-attack/heart-attack-ping-pong-bid-ask-flip
  - Reshape Liquidity: /hawkfi-solana/hawkfi-models/build-your-own-models/reshape-liquidity-rl
  - Ping Pong AR: /hawkfi-solana/hawkfi-models/build-your-own-models/auto-rebalance-ar/ping-pong-auto-rebalance
- yunus makalesi: https://x.com/0xyunss/status/2123387410725953788
- Simülasyon: https://dlmmsim.xyz · PnL kontrolü: https://metlex.io
- LP Agent Copy LP: https://app.lpagent.io/copying · İyi uygulamalar: https://docs.lpagent.io/tutorials/copy-lp-best-practices
- Referans repo (sadece fikir): https://github.com/sicknature-x/warlock-v2

---

## 10. Yan not

Telegram "Solana Ray | Wallet Tracker" botunda Karınca cüzdanı "Disiplinli Karınca" adıyla eklendi. Sadece Add Liquidity / Remove Liquidity bildirimleri açık. Bot hazır olana kadar yedek sinyal kaynağı olarak kullanılabilir.

---

## 11. Doğrulama sonuçları (22 Kasım 2026, npm paketlerinden)

Kaynak: `@meteora-ag/dlmm@1.9.14` ve `@meteora-ag/cp-amm-sdk@1.5.1` içindeki IDL'ler.

**Program ID'leri: ikisi de DOĞRU.**
- DLMM: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
- DAMM V2 (cp-amm): `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`

**DLMM instruction'ları (IDL'de snake_case).** Dinleyici hem v1 hem "2" varyantlarını yakalamalı, çünkü yeni SDK'lar genelde `...2` olanları kullanıyor:
- Açma: `initialize_position`, `initialize_position2`, `initialize_position_pda`, `initialize_position_by_operator`
- Ekleme: `add_liquidity`, `add_liquidity2`, `add_liquidity_by_strategy`, `add_liquidity_by_strategy2`, `add_liquidity_by_strategy_one_side`, `add_liquidity_by_weight`, `add_liquidity_by_weight2`, `add_liquidity_one_side`, `add_liquidity_one_side_precise`, `add_liquidity_one_side_precise2`
- Çekme: `remove_liquidity`, `remove_liquidity2`, `remove_liquidity_by_range`, `remove_liquidity_by_range2`, `remove_all_liquidity`
- Yeniden dağıtma: `rebalance_liquidity` (tek işlemde çek + ekle; flip/reshape için de kullanılabilir, incelenmeli)
- Fee: `claim_fee`, `claim_fee2`, `claim_reward`, `claim_reward2`
- Kapama: `close_position`, `close_position2`, `close_position_if_empty`
- Boyut: `increase_position_length(2)`, `decrease_position_length`
- Not: `place_limit_order` / `cancel_limit_order` da var (DLMM Pro olabilir).

**DAMM V2 instruction'ları:**
`create_position`, `add_liquidity`, `remove_liquidity`, `remove_all_liquidity`, `claim_position_fee`, `claim_reward`, `close_position`, `split_position`, `split_position2`, `lock_position`, `permanent_lock_position`.

Orijinal metindeki `initializePosition / addLiquidityByStrategy(OneSide) / addLiquidityByWeight / removeLiquidity(ByRange) / claimFee / closePosition` isimleri v1 için doğru ama eksik.

---

## 12. Karar: kullanıcı modeli (8.1'in cevabı)

**Yol:** önce sadece biz → sonra birkaç güvenilir kişi → belki herkese açık.
**İlke:** Bugün tek kullanıcı için çalışır, ama ileride yeniden yazmayı gerektirecek üç yeri baştan doğru kur. Gerisini ihtiyaç çıkınca ekle.

**Baştan kurulacaklar (ucuz, sonradan değiştirmesi pahalı):**
1. **Çok kiracılı veri modeli:** Her tabloda `user_id` olsun (leaders, copy_settings, positions, events, txs, pnl_snapshots). Başta tek bir kullanıcı satırı olur. Limitler, fon koruması ve /stop kullanıcı bazında çalışsın.
2. **İmza soyutlaması:** Kod `Signer` arayüzü üzerinden imzalasın, anahtara doğrudan dokunmasın. Aşama 1–2: `DryRunSigner` (hiç imzalamaz). Aşama 3: sunucuda şifreli yerel keystore. Güvenilir kişiler gelince: kullanıcı başına ayrı agent cüzdanı. Herkese açık aşamada: KMS/MPC ya da non-custodial operatör modeli.
3. **Cüzdanla giriş (Sign-In With Solana):** Tek kullanıcıda da aynı akış. Panelde rol alanı (`owner` / `member`) olsun.

**Non-custodial seçeneği (araştırılacak):** DLMM IDL'de `update_position_operator` ve `initialize_position_by_operator` var. Kullanıcı pozisyonun sahibi kalıp botu operatör yapabilirse, herkese açık aşamada kullanıcının anahtarını tutmamız gerekmeyebilir. Operatörün neleri yapabildiği ve fonların kime gittiği program kaynağından doğrulanmalı. DAMM V2 için `update_delegate_permission` incelenecek.

**Şimdilik YAPILMAYACAKLAR:** açık kayıt, ödeme/abonelik, kullanıcı başına izole worker, KYC ve hukuki çerçeve. Bunlar herkese açık aşamanın işi.

---

## 13. Durum

**Proje adı:** Binflip (paket kapsamı `@binflip/*`).

**Aşama 1 (iskelet): TAMAM (22 Kasım 2026).** `docker compose up` ile 8 servis ayağa kalkıyor, hepsi healthy.
- `packages/core`: config (zod; DRY_RUN varsayılan, `DRY_RUN=0` + `LIVE_CONFIRMED=1` olmadan çalışmayı reddeder, çıkış kodu 78), pino logger (anahtar/token redaction), program ID'leri, `Signer` arayüzü + `DryRunSigner`, health sunucusu, graceful shutdown, `runService` bootstrap.
- `packages/db`: Drizzle şeması (9 tablo, hepsinde `user_id`), ilk migration `drizzle/0000_*.sql`, `migrate` betiği.
- `apps/{listener,executor,manager,telegram}`: Postgres + Redis'e bağlanan, `/health` sunan iskeletler. `apps/api`: Fastify, `/health` ve `/v1/status`.
- `apps/web` (Next.js) bilerek ertelendi, Aşama 5'te eklenecek.
- Testler: `pnpm test` (config güvenlik kapıları, DryRunSigner).

**Konvansiyonlar:** SOL = lamports (bigint), token = ham birim `numeric(40,0)`, yüzdeler = baz puan (1400 = %14). Drizzle'da bigint default'ları `sql\`...\`` ile yazılır (drizzle-kit BigInt serileştiremiyor).

**Sırada: Aşama 2** (dinleyici + deneme modu). Başlamadan önce gerekenler: lider cüzdanların tam adresleri (§8.5) ve Helius planı/API anahtarı (§8.4).

---

## 14. Referans ürün incelemesi (22 Kasım 2026, resmi dokümanlardan)

Kaynaklar: docs.lpagent.io (copy-lp, copy-settings, copy-management, settings, fee, best practices) ve hawkfi.gitbook.io (AR, swapless AR, Ping Pong, RL, AC, TP, SL, Heart Attack Ping Pong, Precision Hybrid). **Binflip = LP Agent'ın kopyalama motoru + HawkFi'nin otomasyon blokları + yunus'un kademeli flip'i.**

### 14.1 LP Agent Copy LP: aynen alınacaklar
**Diyalog 5 adım** (bizim 6. adımımız, yani pozisyon yönetimi, LP Agent'ta yok):
1. **Sizing:** Copy % (1–10000), "Suggested" = bizim net varlık / liderin net varlığı, **Max Increase Amount per Tx** (her açma ve her eklemede üst sınır, boş = sınırsız, 0 kaydedilemez). Sadece Max verilirse liderin miktarı Max'e kadar kopyalanır. **Max açılışı kısarsa** sonraki eklemeler o küçük oranla yapılır (30 gün boyunca, ardından tekrar Copy %). Çekme/kapama her zaman yüzdeyle yapılır, sınır uygulanmaz.
2. **Exit rules:** TP/SL para birimi SOL/USD (Max'in birimini de belirler), TP %, SL %. Yeni hesapta varsayılan 10/10. TP/SL açılışta pozisyona **kopyalanır**, sonradan ayar değişse de açık pozisyonu etkilemez. Trailing yok (bizde olacak).
3. **What to copy:** DLMM stratejileri (Spot/Curve/BidAsk/Custom) ve DAMM V2. Hepsi varsayılan açık.
4. **Protection:**
   - **Meme Protection** (varsayılan açık): yatırılan miktarın **%95'inden fazlası** güvenilmeyen token'daysa (SOL/USDC/USDT dışı) atla. İki taraf da güvenilirse ya da hiçbiri değilse kontrol yapılmaz. Bu bir "skip"tir, tekrar denenmez.
   - **Smart Token Retention** (sadece DLMM, varsayılan kapalı): Hold for 30s / **1dk** / 2dk / 5dk. Hemen satma koşulları: fiyat **%5**'ten fazla düşerse (0,5–50), lider token'ı satarsa ya da süre dolarsa. Kapatılınca, duraklatılınca ya da durdurulunca tutulan token satılır. Logda "Holding" + geri sayım + "Sell now" gösterilir.
5. **Label.**

**Hesap geneli ayarlar:** token filtreleri (Jupiter Organic Score ≥50, Market Cap ≥$500k, 24s hacim ≥$100k, holder ≥100, blacklist), slippage (tüm swap'lar için; %7 üstünde uyarı).

**Davranışlar:**
- Sadece kopyalama başladıktan **sonra** açılan pozisyonlar kopyalanır.
- Lider kısmi çekerse aynı oranda çekilir. Claim, compound ve rebalance da aynalanır. Aynalanamayan rebalance atlanır ve nedeni loglanır.
- Lider boş pozisyon açıp birkaç saniye sonra fonlarsa: biz de boş açarız. Fonlayamazsak ~1 dk sonra kapatıp rent'i geri alırız.
- Ortalama tutma süresi **18 dk**'nın altındaki lider için "High-frequency" uyarısı gösterilir.
- **Duraklatma = kapamalar da kopyalanmaz** (açık kopyalar kendi TP/SL'leriyle kalır). **Bizde farklı olacak:** `follow_exits_while_paused` varsayılan açık.
- Cüzdan sürekli fonsuz kalırsa kopyalar otomatik duraklatılır ve bildirim gider.

**Fund protection:** varsayılan **net varlığın %20'si**, "max loss from peak". Sadece kapanmış kopyalar sayılır. % değeri kayıt anında sabit SOL'e çevrilir ve sayaç sıfırlanır. Tetiklenince açma/ekleme/compound/rebalance durur, **çıkışlar liderle devam eder**. Resume ve Turn off seçenekleri var.

**Copy Logs:** 7 gün. Sonuç durumları: Open / Closed / Holding / Not opened / Skipped / Failed / Pending. Her nedenin yanında "tek tıkla düzelt" butonu var (Raise slippage, Top up, Edit copy size, Edit filters…). Analiz aralıkları: 7D / 1M / 3M / 1Y / YTD / ALL.

**Ücret (önemli):** LP Agent kopyalama kapanışlarında ve claim'lerde **LP fee'lerinin %8'ini** alıyor (TP/SL dahil). Elle işlem %0,1, açma ücretsiz. Yani şu anki akışta hem LP Agent'a hem HawkFi'ye %8 ödeniyor. Binflip ikisinin de yerine geçiyor.

**Güvenlik modeli (herkese açık aşama için referans):** anahtarlar Turnkey'de (donanım). Otomasyonun imzaladığı anahtar fonları sadece kullanıcının kendi hesaplarına gönderebiliyor (politika tabanlı imza). Bkz. §12.

### 14.2 HawkFi otomasyon blokları: bizim modlarımızın parametreleri
- **Auto-rebalance (AR):** aralığın tamamını taşır. Swapped ya da swapless. Modlar: Fixed Schedule / Up or Down / Up only / Down only. Cooldown 0 dk–24 s. Deposit slippage %3, swap slippage dinamik (en fazla %5). Rebalance Buffer: None / Price / Time.
- **Ping Pong AR (swapless):** "AR aşağıda toplam bin – spread – AR yukarıda toplam bin" (ör. 69-0-69, 68-0-68).
- **Reshape Liquidity (RL):** aralık sabit kalır, dağılım aktif bin etrafında yeniden kurulur. Allowed Bin Movement 1–51. **Advanced RL (Precision Flip):** Starting Shape + Allowed Bin Movement + Flip Buffer ↔ Alternate Shape + Alternate Allowed Bin Movement + Alternate Flip Buffer (ör. Curve 5 bin, buffer 5 ↔ Hybrid 12 bin, buffer 2). Her iki token'da da transfer vergisi varsa kullanılamaz.
- **Auto-compound (AC):** compound şekli Spot / Curve / Bid-Ask. **Auto-accumulate (AA)** alternatifi: fee'leri SOL/USDC olarak cüzdana çeker.
- **TP/SL tetikleri:** pool price, position balance, unclaimed fees, balance+fees, market cap, position age, PnL (USD), PnL (SOL). Çıkış: No swap / Swap to SOL / Swap to USDC. SL slippage %3 sabit. Kademeli TP (birden çok seviye) destekleniyor.
- **Heart Attack Ping Pong varsayılanları:** Bid-Ask, AR Down only, cooldown 0, Ping Pong 69-0-69, TP:SOL **%7**, SL:SOL **−%20** PnL.

### 14.3 Şemaya yansıyanlar (migration 0001)
`user_risk_settings`: fund protection (%20 varsayılan, peak'ten, tetiklenme zamanı), token filtreleri, slippage. `copy_settings`: `follow_exits_while_paused`, meme eşiği (9500 bps), STR parametreleri, DAMM V2 varsayılan açık. Pozisyon durumu `HOLDING` eklendi. `txs.reason` eklendi (skip/fail nedeni). AR/RL/AC/TP-SL tetik detayları mod bazında `management_params` (jsonb) içinde tutulacak; şekli 4. aşamada zod ile sabitlenecek.
