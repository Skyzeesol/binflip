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

---

## 15. Aşama 2: dinleyici + deneme modu (devam ediyor)

**Akış:** `listener` (WS `logsSubscribe` mentions=lider + `LISTENER_POLL_MS` (varsayılan 5 sn) aralıkla `getSignaturesForAddress` ile kaçanları yakalama) → `leader-events` kuyruğu → `getTransaction` → decode → `leader_events` (kullanıcı başına, `(user, signature, ix_index)` idempotent) → `execution` kuyruğu → `executor` planlar → `txs` (`planned` / `skipped` + `reason`) ve `positions` (dry-run aynası) → `notifications` → `telegram` (token yoksa sadece loglar).

**Decoder (`packages/core/src/meteora`):** Anchor `BorshCoder` + SDK IDL'leri. Instruction'lardan isim, hesap ve argümanlar alınır, **miktarlar programın emit ettiği event'lerden** okunur (`AddLiquidity`, `RemoveLiquidity`, `Rebalancing`, `ClaimFee2`, `PositionCreate`, `PositionClose`, DAMM V2'de `Evt*`). CPI (router/bot üzerinden) çağrılar da yakalanır. Testler Karınca'nın gerçek mainnet işlemleriyle yapılıyor (`packages/core/test/fixtures/tx`).

**Karınca'nın gerçek davranışı (fixture'lardan):**
- Açma iki ayrı işlemde: `initialize_position2 + increase_position_length2` (boş pozisyon), birkaç saniye sonra `rebalance_liquidity` ile fonlama. Yani `add_liquidity_by_strategy` değil **`rebalance_liquidity`** kullanıyor. Biz de boş açıp ilk fonlamayı "ilk boyutlandırma" sayıyoruz (LP Agent da böyle yapıyor).
- Şekil: `rebalance_liquidity.adds` içindeki delta'dan çıkarılıyor (SDK builder'larıyla doğrulandı): delta 0 = Spot, negatif (bit_flag 4/8) = Curve, pozitif = Bid-Ask. Karınca tek taraflı SOL ile **bid-ask** açıyor.
- Kapama: `remove_liquidity_by_range2 (bps 10000) + claim_fee2 + close_position_if_empty`. `PositionClose` event'i yoksa pozisyon kapanmamıştır, "remove" sayılır.
- Sık `claim_fee2` yapıyor. Swap'larını DLMM üzerinden routelanmış Jupiter ile yapıyor; bunlar pozisyon olmadığı için yok sayılıyor.

**Boyutlandırma (`sizing.ts`) ve planlama (`planner.ts`):** LP Agent kuralları birebir uygulanıyor, dokümandaki örnekler test olarak yazıldı. Oran ppm cinsinden tutuluyor. Duraklatma, kill switch ve fon koruması girişleri engeller ama çıkışları engellemez.

**Teknik notlar:**
- Helius API anahtarını **sadece URL parametresi** olarak kabul ediyor (`?api-key=`), header ile çalışmıyor. VPS'te `SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...` olarak `.env`'e yazılacak (bu bir RPC anahtarı, cüzdan anahtarı değil). Geliştirmede public RPC kullanılıyor.
- Helius **Parsed Streams** (program + instruction filtreli, decode edilmiş WS akışı, ücretsiz planda da var) ikinci kaynak olarak eklenecek.
- `@meteora-ag/dlmm` ESM build'i Node'da kırık (dizin importu). SDK'lar `createRequire` ile CJS üzerinden yükleniyor.
- Sandbox'ta Node `fetch`'inin proxy'yi kullanması için `NODE_USE_ENV_PROXY=1` gerekiyor; WS için `HTTPS_PROXY` varsa `https-proxy-agent` kullanılıyor. VPS'te ikisi de gerekmez.
- Lider yönetimi panel gelene kadar CLI ile: `node packages/db/dist/cli.js leader:add --address … --label … --pct 50 --tp 5 --sl 5` (ayrıca `user:init`, `leader:list`, `leader:pause`, `leader:resume`, `leader:remove`).
- Geliştirme: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis` → servisler host'ta çalışır.

**Açık konu: gecikme.** İlk canlı testte (public RPC) WS bildirimleri Karınca için gelmedi, olaylar 13–18 sn'de poll'dan yakalandı. Public RPC'de mention aboneliği genel olarak çalışıyor (test edildi). Geçici çözüm olarak poll 5 sn'ye indirildi. VPS'te Helius ile ölçülecek; gerekirse Parsed Streams'e geçilecek.

**Henüz yok:** meme koruması için iki taraflı eklemelerde fiyat bazlı oran, token filtreleri (market cap/hacim/holder fiyat verisi ister), Telegram komutları, Parsed Streams kaynağı.

---

## 16. Aşama 3: canlı kopya (kod hazır, gerçek parayla test edilmedi)

**Parçalar:**
- `packages/core/src/keystore.ts`: agent cüzdanı **scrypt (N=2^17) + AES-256-GCM** ile şifreli. Public key AAD olarak doğrulanıyor. Parola dosyadan (Docker secret) okunuyor. `KeystoreSigner` anahtarı dışarı vermiyor (`toJSON`/`inspect` sadece public key döndürüyor).
- `packages/core/src/meteora/dlmmTx.ts`: resmi SDK ile open / add / remove / close / claim. **70 binden genişse** extended empty position + `addLiquidityByStrategyChunkable` kullanılıyor. Sadece tek taraflı SOL; aralık aktif binin SOL tarafına kırpılıyor.
- `packages/core/src/solana/sender.ts`: priority fee, simülasyon (sigVerify kapalı), imza, **imza yayından ÖNCE DB'ye yazılıyor**, onaylanana kadar 2 sn'de bir yeniden yayın, blockhash süresi dolunca hata.
- `apps/executor`: canlı modda keystore + kayıtlı agent wallet zorunlu. Açılışlardan (boş açılış dahil) ve eklemelerden önce bakiye kontrolü yapılıyor (tutar + `SOL_RESERVE_LAMPORTS`, varsayılan 0,1 SOL). Status akışı: planned → submitted → confirmed / failed. Yarıda kalan bir iş **asla yeniden gönderilmiyor**, `interrupted_needs_review` olarak işaretleniyor ve bildirim gidiyor.
- CLI: `wallet:create` (yeni cüzdan üretir, ana cüzdan import edilemez; üzerine yazmayı reddeder; dosya izni 0600), `risk:show`, `risk:set --max-per-tx --max-per-day`, `kill` / `unkill`.
- `docker-compose.live.yml`: canlı mod sadece bu override ile açılır.

**Doğrulama (gerçek para olmadan):**
- Mainnet simülasyonu (Karınca'nın `CcG3fy…` havuzu ve pozisyonu, sigVerify kapalı): dar bid-ask açılış (61 bin, ~243k CU), 348 binlik boş extended açılış (~48k CU), chunked ekleme, %50 çekme, %100 çekme + kapama ve claim. **Hepsi geçti.**
- Canlı mod kapıları: keystore yoksa başlamıyor, parola yanlışsa başlamıyor, bakiyesiz cüzdanla açılış/ekleme `low_balance` ile atlanıyor.

**Maliyet notu:** Karınca'nın 348 binlik pozisyonları SDK'da **5 işleme** bölünüyor (ekleme, çekme, claim), yani her hareket ~5 işlem ücreti ve ~5 × 300-700k CU demek. Bin array rent'i de ilk kez dokunulan bin'lerde bizden çıkar. Küçük boyutlarda bu maliyet fee gelirini geçebilir (LP Agent de en az 5 SOL net varlık öneriyor).

**Henüz yok / bilinen sınırlar:**
- Kapanışta kalan token → SOL swap'ı (Jupiter) yok. Token cüzdanda kalır (LP Agent'taki "Tokens left in wallet" durumu).
- Rebalance aynalama ve DAMM V2 canlı kopya yok (`damm_live_not_supported` ile atlanıyor).
- Gerçek mainnet testi kullanıcının adımı: `wallet:create` → küçük SOL gönder → `docker-compose.live.yml`. VPS'te `./keystore` klasörü container kullanıcısına (uid 1000) okunabilir olmalı.

---

## 17. Operatör modeli araştırması (22 Kasım 2026, mainnet simülasyonu)

**Yöntem:** Karınca'nın gerçek pozisyonu (`8SQhSEg6…`, havuz `CcG3fy…`) üzerinde, tek bir simüle işlem içinde (sigVerify kapalı, zincire hiçbir şey gönderilmedi) sahip `update_position_operator` ile rastgele bir test operatörü atadı, ardından operatör ve karşılaştırma için bir yabancı adres işlemleri denedi. Betik: geliştirme sırasında scratchpad'de `opertest.cjs`.

| Deneme | Sonuç |
|---|---|
| Operatör %50 çeker → **sahibin** token hesaplarına | ✅ |
| Operatör %50 çeker → **kendi** token hesaplarına | ❌ `WithdrawToWrongTokenAccount` (remove_liquidity2.rs:91) |
| Operatör fee claim → sahibin hesaplarına | ✅ |
| Operatör fee claim → kendi hesaplarına | ❌ `WithdrawToWrongTokenAccount` (claim_fee2.rs:71) |
| Operatör sahibin parasıyla ekler, SPL delegate **yok** | ❌ token programı `OwnerMismatch` (0x4) |
| Operatör sahibin parasıyla ekler, sahip operatöre SPL **delegate** vermiş (SOL + token hesabı) | ✅ |
| Yabancı adres (operatör değil): çekme / claim / ekleme | ❌ `ConstraintRaw` (pozisyon yetki kontrolü) |

**Sonuç:**
- **Kendi pozisyonlarını bota devretmek (0xyunss tarzı yönetim) non-custodial olarak MÜMKÜN.** Kullanıcı pozisyonu ana cüzdanıyla açar ve bir kez imzalar: (1) `update_position_operator(bot)`, (2) SOL ve token hesapları için bota SPL delegate izni. Bundan sonra bot çekme, claim ve ekleme yapabilir (yani flip ve compound). **Çekilen her şey programın kuralı gereği sahibin cüzdanına döner.** Ana cüzdanın anahtarı sunucuya hiç gelmez.
- **Risk sınırı:** SPL delegate, izin verilen miktar kadar token'ı herhangi bir yere transfer etme yetkisi de verir. Bot anahtarı ele geçirilirse risk delegate edilen miktarla sınırlıdır (native SOL, diğer token'lar ve NFT'ler güvende). Bu yüzden izin miktarı sınırlı tutulmalı ve panelde "izni geri al" (revoke) olmalı.
- **Kopya trading için operatör modeli yetmez:** Her yeni pozisyon için sahibin operatör ataması (imza) gerekir, bu da otomatik kopyayla uyuşmaz. `initialize_position_by_operator` ise launch pool'lar için ve token launch kanıtı istiyor (`MissingTokenAmountAsTokenLaunchProof`). **Kopyalar ayrı agent cüzdanında kalmalı.**

**Karar önerisi (hibrit):**
1. Kopyalar → ayrı agent cüzdanı (bot pozisyonların sahibi). Sadece bu cüzdandaki para risktedir.
2. Kullanıcının kendi açtığı pozisyonlar → ana cüzdanda kalır, operatör + sınırlı delegate ile bota devredilir. Panelde tek tıkla "bota devret" işlemi hazırlanır, kullanıcı Phantom'da imzalar.

**Henüz test edilmedi:** operatörün pozisyonu kapatması (rent nereye gider), operatörün `rebalance_liquidity` çağırması (flip'i tek işlemde ve token transferi olmadan yapabilir), Token-2022 transfer-fee'li token'lar.

**KARAR (kullanıcı, 22 Kasım 2026): Ayrı bot cüzdanı.** Ana cüzdan anahtarı sunucuya hiç gelmez. Kopyalar ve kullanıcının kendi pozisyonları aynı bot (agent) cüzdanında olur; kullanıcı kendi pozisyonlarını bu cüzdanı Phantom'a ekleyip açar, bot cüzdandaki her pozisyonu bulup yönetir (LP Agent "Manage Manual Position" eşdeğeri, 4. aşamada). Operatör modeli ileride isteğe bağlı seçenek. Risk azaltma: bot cüzdanında sadece çalışan sermaye tutulur, kâr eşiği aşınca **ana cüzdana otomatik süpürülür**, sunucu sağlamlaştırılır.

**Sıra (kullanıcı):** 1) kapanışta token → SOL, 2) 4. aşama (kademeli flip, compound, TP/SL, trailing), 3) rebalance aynalama. Panel planlandığı gibi 5. aşamada.

---

## 18. Çıkışta token → SOL ve kâr süpürme (madde 1, tamam)

**LP Agent davranışı (kullanıcı kararı: "lpagent nasıl yapıyorsa"):**
- Lider **çektiğinde ya da kapattığında**, o işlemden çıkan token SOL'e satılır. Miktar, işlemden önceki ve sonraki bakiye farkıyla ölçülür; cüzdandaki başka token'lara dokunulmaz.
- **Rota:** önce Jupiter (`lite-api.jup.ag/swap/v1`, platform ücreti istenmiyor), rota yoksa ya da Jupiter hata verirse aynı DLMM havuzu. Slippage `user_risk_settings.slippage_bps`'ten alınır.
- **Satılana kadar tekrar:** `swapback` kuyruğu, 30 sn → 1 → 2 → 4 → 8 dk → en fazla 15 dk aralıkla, toplam 1000 deneme (7 günden fazla). Fiyat etkisi yüzünden token bırakılmaz. İlk başarısızlıkta ve satışta bildirim gider.
- **Çift satış koruması:** her denemeden önce kayıttaki son imzanın durumu ve güncel bakiye kontrol edilir. Satılacak miktar, olaydan çıkan miktar ile bakiyenin küçüğüdür.
- Swap işlemi `swap_<event>` satırıdır. Durumlar: planned → submitted → confirmed; tekrar beklerken `tokens_left_retrying`.
- **Smart Token Retention** (lider geri eklerse tut) henüz yok; eklendiğinde satış onun ayarlarına göre bekletilecek.

**Kâr süpürme:** satış (ya da token'sız kapanış) sonrası bakiye `SWEEP_KEEP_LAMPORTS + SWEEP_MIN_LAMPORTS`'u aşarsa fazlası `SWEEP_TO_ADDRESS`'e (ana cüzdanın public adresi) gönderilir. Adres sadece sunucu ayarından okunur. Kayıt `sweep_<event>` satırıdır.

**Doğrulama:** Jupiter ile, cüzdanda gerçekten bulunan bir token'ın satışı mainnet'te simüle edildi (~120k CU, OK). Rotası olmayan bir token için Jupiter hata verdi; bu durumda havuz yoluna düşülüyor. Havuz yolu: aynı işlem içinde alım + geri satış simülasyonu OK.

---

## 19. Aşama 4: pozisyon yöneticisi (devam ediyor)

**Karar (kullanıcı):** kademeli flip varsayılan eşiği **%10**. Lider bazında değiştirilebilir: `copy_settings.management_params.flipThresholdBps`, CLI'da `leader:add … --mode staged_flip --flip-threshold 12`. Panelde de ayarlanabilir olacak.

**Motor (`packages/core/src/strategy`), saf fonksiyonlar, fiyat simülasyonu testleriyle:**
- `bins.ts`: bin bazında model. `price(bin) = (1+binStep/1e4)^binId`. Fiyat düşerken geçtiği bin'lerdeki SOL token'a, yükselirken geçtiği bin'lerdeki token SOL'e dönüşür. Şekiller: spot (eşit), bid-ask (fiyattan uzaklaştıkça artar), curve (azalır). `binsForDrop(1000, 100) = 11` (1,01^-11 ≈ −%10,4).
- `manage.ts` `decide()`: önce çıkışlar (TP, SL, trailing), sonra flip.
  - **Trailing** sadece pozisyon bir kez kâra geçtikten sonra devreye girer (yunus: "önce tepki beklenir"). Kârda değilken düşüşü normal SL yönetir.
  - **Kademeli flip:** girişten ya da son flip'ten itibaren fiyat ≥ eşik kadar düşünce, sadece fiyatın içinden geçtiği **token bin'leri** (aktif binin üstü) çekilir ve 0 spread ile fiyatın hemen üstünden başlayan bid-ask ask tarafına konur. Aşağıdaki SOL bin'lerine dokunulmaz. Sonraki eşik son flip'ten ölçülür.
  - **Dipte flip:** aralığın altına çıkınca (hepsi token) tamamı fiyatın üstüne konur.
  - Claim edilmiş fee'ler PnL'e dahil.
- `applyFlip()` testleri: SOL bin'leri korunuyor, token miktarı ve pozisyon değeri flip anında korunuyor, sonrasında toparlanma token'ı fiyatın üstünde satıyor.

**Manager servisi (`apps/manager`):** her `MANAGER_TICK_MS`'de (varsayılan 30 sn) ACTIVE pozisyonları gerçek havuz fiyatıyla değerlendirir.
- Deneme modunda her pozisyon `positions.sim_state` içinde sanal bir modeldir. Executor'ın aynaladığı eklemeler modele eklenir. Flip ve kapanış kararları `txs`'e `planned` olarak yazılır ve bildirim gider.
- **Canlı mod:** manager pozisyonu zincirden okur (`readLivePosition`; claim edilmemiş fee'ler değere dahil), karar verir ve `management` kuyruğuna koyar. Job id'si `mgmt_<pozisyon>_<tür>_<aktifBin>`, yani aynı bin'de tek aksiyon. Executor işi **uygulamadan önce zincirde tekrar okuyup kararı yeniden doğrular**; eski kararlar düşürülür. Lider olayları ve yönetim kararları executor'da **tek kilitle sırayla** çalışır.
  - **Kapanış (TP/SL/trailing):** %100 çek + kapat, çıkan token swap-back kuyruğuna gider, pozisyon CLOSED olur.
  - **Flip:** token bin'leri çekilir, çıkan token miktarı ölçülür ve **sadece o miktar** güncel fiyatın hemen üstüne (0 spread) ask tarafına eklenir. İlerleme `txs.plan.stage` alanında tutulur (planned → removed → added); ekleme başarısız olursa yeniden denemede sadece ekleme yapılır, token satılmaz.
  - Doğrulama: Karınca'nın gerçek pozisyonunda flip (token bin'i çek + fiyatın üstüne 20 bine bid-ask ekle) tek işlemde mainnet simülasyonunu geçti (~395k CU). SDK pozisyon aralığını yukarı doğru kendisi genişletiyor. Zincirden okuma + karar akışı da gerçek pozisyonla test edildi.
- Not: bin step 20 havuzlarda %10 düşüş = **53 bin** (`binsForDrop`).

**Auto-compound (HawkFi AC modeli):** lider bazında `compound_interval_minutes` (CLI `--compound 60`). Süre dolunca, claim edilmemiş fee'lerin değeri `COMPOUND_MIN_LAMPORTS`'u (varsayılan 0,02 SOL) aşıyorsa compound yapılır. Eşiğin altındaki fee'ler beklemeye devam eder; her compound birkaç işlem ücreti tuttuğu için küçük miktarlar taşınmaz. İcra: claim, ardından SOL fee'leri pozisyon aralığında fiyatın altına/aktif bine, token fee'leri fiyatın üstüne **spot** olarak eklenir. Fiyatın üstünde bin yoksa (tek taraflı bid pozisyonu) token fee'leri swap-back ile SOL'e satılır. Exit ya da flip kararı varsa compound yapılmaz. Compound edilen fee yatırılan sermayeye eklenmez, PnL'de kâr olarak görünür. Deneme modunda fee modeli olmadığı için compound simüle edilmiyor.

**Kalanlar:** Precision Hybrid / reshape, SOL'ün X olduğu havuzlar, kullanıcının kendi açtığı pozisyonları bulup yönetme ("Manage Manual Position").

**Manuel pozisyonlar ("Manage Manual Position"):** kullanıcı bot cüzdanını Phantom'a ekleyip kendi pozisyonunu açar. Manager canlı modda ~5 dakikada bir `getAllLbPairPositionsByUser` ile cüzdanı tarar ve bilmediği pozisyonları `leader_id = null` ile yönetime alır (bildirim gider). Ayarlar kullanıcı başına `manual_settings` tablosunda: mod, flip eşiği, TP/SL/trailing, compound. CLI: `manual:set --mode staged_flip --flip-threshold 10 --tp 10 --sl 10 --compound 60`, `manual:set --off`, `manual:show`. Yatırılan miktar bilinmediği için **PnL, yönetime alındığı andaki değerden** ölçülür. Zincirde artık olmayan pozisyonlar (Phantom'dan kapatılanlar) `closed_externally` olarak kapatılır. Doğrulama: geçici bir test kullanıcısıyla Karınca'nın public adresi taratıldı, 8 pozisyonun hepsi değerleriyle bulundu; test verisi sonra silindi.

**Madde 2 (4. aşama) durumu:** kademeli flip, dipte flip, TP/SL/trailing, auto-compound ve manuel pozisyon yönetimi tamam (deneme + canlı icra). Kalanlar: Precision Hybrid / reshape (6. aşama), SOL'ün X olduğu havuzlar, deneme modunda fee simülasyonu.

---

## 20. Rebalance aynalama (madde 3, tamam)

**Kural (LP Agent):** "Rebalance: kopyayı aynı şekilde taşır. Lider pozisyonun sadece bir kısmını taşırsa, ya da aynı hamlede kâr alır veya para eklerse aynalanmaz, atlanır." `core/meteora/rebalance.ts` `classifyRebalance`:
- **Tam taşıma:** eski aralığın tamamı %100 çekilmiş ve her tarafta eklenen ≈ çekilen (±%3; rebalance swapless olduğu için taraflar ayrı karşılaştırılır) → aynalanır.
- Kısmi çekme → `rebalance_partial`. Eklenen > çekilen → `rebalance_topup`. Eklenen < çekilen → `rebalance_take_profit`.
- Decoder artık `rebalance` ayrıntısını taşıyor: eski/yeni aralık (`Rebalancing` event'i) ve liderin ekleme segmentleri (gerçek fixture ile test edildi).

**Uygulama yöntemi: kapat ve yeniden aç.** SDK'nın `RebalancePosition` yolu (tek `rebalance_liquidity`) 348 binlik pozisyonda mainnet simülasyonunda `ComputationalBudgetExceeded` verdi ve SDK bunu parçalara bölmüyor. Bu yüzden zaten simüle edilmiş parçalar kullanılıyor:
1. Pozisyondaki SOL ve token miktarını oku, %100 çek ve kapat (parçalı).
2. Liderin yeni aralığında yeni pozisyon aç, SOL'ü liderin şekliyle (spot/curve/bid-ask) fiyatın altına koy (geniş aralıkta boş açılış + parçalı ekleme).
3. Token'ı yeni aralıkta fiyatın üstüne koy. Yeni aralıkta fiyatın üstünde bin yoksa token swap-back ile SOL'e satılır.

`positions` kaydında yeni aralık, yeni pozisyon adresi ve giriş bini güncellenir; flip referansı sıfırlanır. Deneme modunda sanal model bir sonraki manager turunda yeni aralıkta yeniden kurulur (yaklaşık).

**Maliyet:** pozisyon rent'i eski pozisyondan iade edilir, yenisi için ödenir; ayrıca yeni aralıktaki bin array rent'i ve birkaç işlem ücreti. Sık rebalance yapan liderlerde bu maliyet loglanır (`txs.fee_lamports`).

**Doğrulanmadı:** yeni açılan pozisyona eklemenin uçtan uca simülasyonu (pozisyon zincirde var olmadan simüle edilemiyor). Parçaların her biri ayrı ayrı mainnet simülasyonunu geçti.

---

## 21. Aşama 5: panel (tamam, ilk sürüm)

**API (`apps/api`, Fastify):**
- **Cüzdanla giriş (SIWS):** `POST /v1/auth/nonce` → cüzdan mesajı imzalar → `POST /v1/auth/verify`. Nonce tek kullanımlık ve 5 dakika geçerli, ed25519 imza doğrulanıyor, sadece `users.login_wallet` olarak kayıtlı cüzdan girebiliyor. Oturum HMAC imzalı, httpOnly + SameSite=strict çerez (7 gün). `SESSION_SECRET` zorunlu (32+ karakter; cüzdan anahtarı değil).
- Uç noktalar: `/v1/me`, `/v1/leaders` (GET/POST/PATCH/DELETE + `/:id/pause|resume`), `/v1/logs?tab=all|not_opened|failed|open|closed&leaderId=` (7 gün), `/v1/analysis?range=7D|1M|3M|ALL`, `/v1/positions?state=`, `/v1/risk` (GET/PATCH), `/v1/kill`, `/v1/unkill`, `/v1/manual` (GET/PUT).
- Ayarlar arayüz birimleriyle (%, SOL) gidip gelir; dönüşüm tek bir yerde (`apps/api/src/settings.ts`, testli). LP Agent'ın %1 alt sınırı ve "Max 0 kaydedilemez" kuralı doğrulamada uygulanıyor.
- PnL: manager her turda `positions.current_value_sol`'ü yazar (claim edilmemiş fee'ler dahil) ve 5 dakikada bir `pnl_snapshots` kaydeder. Analiz grafiği, her pozisyonun günlük **son** ölçümünü cüzdan bazında toplar. "Tahmini" diye işaretli.

**Arayüz (`apps/web`, Next.js 16.4.5 + React 19.3.1, ek UI kütüphanesi yok):**
- `/login`: Phantom/Solflare ile mesaj imzalayarak giriş. Panel hiçbir zaman özel anahtar istemez.
- `/` **Copy LP**: Kopyalanan Cüzdanlar (Aktif/Duraklatıldı grupları, kopya anahtarı, "Bırak"), Analiz (7G/1A/3A/Tümü, KPI'lar, SVG grafik, cüzdan tablosu), Kopya Kayıtları (LP Agent sekmeleri, aynı nedenle atlanan ardışık satırlar katlanır, satıra tıklayınca lider ve bizim işlem linkleri, hata).
- **6 adımlı kopya diyaloğu:** Boyut, Çıkış kuralları, Ne kopyalanacak, Koruma, Etiket, **Pozisyon yönetimi** (bizim adımımız: mod + flip eşiği + compound).
- `/positions`: açık/kapalı pozisyonlar, aralık, yatırılan/güncel/PnL, flip sayısı (30 sn'de bir yenilenir).
- `/settings`: bot cüzdanı (sadece public adres), limitler, fon koruması, slippage, token filtreleri, kara liste, kendi açılan pozisyonların yönetimi.
- Üst menüde DENEME/CANLI rozeti ve **Acil durdur** butonu (yeni girişleri durdurur, çıkışlar devam eder). Canlıya geçiş panelden yapılamaz, sadece sunucuda.
- Açık/koyu tema, mobil uyumlu. `/api/*` Next üzerinden api servisine proxy'lenir (aynı origin, çerez httpOnly kalır).

**Docker:** `web` servisi (Next standalone, `127.0.0.1:3000`), `api` (`127.0.0.1:3001`). Dışarıya port açılmaz: panele SSH tüneliyle (`ssh -L 3000:127.0.0.1:3000 vps`) ya da TLS'li reverse proxy ile erişilir. Doğrulama: imaj derlendi, `api` ve `web` container'ları healthy, oturum açılıp tüm sayfaların ekran görüntüleri alındı (koyu, açık, mobil).

**İlk giriş için:** sunucuda `node packages/db/dist/cli.js user:init --wallet <PHANTOM_GIRIS_ADRESINIZ>`. Bu, sadece mesaj imzalayan giriş cüzdanıdır; bot cüzdanı değildir ve ana cüzdanınız olabilir (anahtarı sunucuya gelmez).

**Eksikler / sonraki:** "tek tıkla düzelt" butonları (LP Agent'taki Raise slippage, Top up gibi), lider portföy/net varlıktan önerilen %, yüksek frekans uyarısı (ortalama tutma < 18 dk), fon korumasının icrası (şu an sadece ayar), token filtrelerinin icrası (fiyat verisi gerekiyor), Telegram komutları.

---

## 22. KARAR: LP Agent'la ayrışma yok (kullanıcı, 23 Kasım 2026)

> "lpagent ile görüş ayrılığına düştüğümüz bir konu olmasın, onları taklit edelim."

Kural: Kopyalama davranışında LP Agent dokümanı (bkz. §14) referanstır. Bizim **eklentilerimiz** (flip modları, trailing stop, acil durdurma, kâr süpürme, manuel pozisyon kuralları) kalır, çünkü LP Agent davranışını değiştirmezler ya da varsayılan olarak kapalıdırlar.

**Tespit edilen farklar ve yapılacaklar:**

| # | Konu | LP Agent | Bizde (önce) | Yapılacak |
|---|---|---|---|---|
| A | Duraklatma | Duraklatılan cüzdandan **kapanışlar dahil** hiçbir şey kopyalanmaz | `follow_exits_while_paused` varsayılan açık | Varsayılan kapalı, mevcut kayıtlar da kapalıya çekilir |
| B | TP/SL | Açılışta pozisyona **kopyalanır**, sonraki ayar değişikliği açık pozisyonu etkilemez | Canlı olarak güncel ayardan okunuyordu | Pozisyon açılışında TP/SL/trailing pozisyona yazılır |
| C | Analiz aralıkları | 7D, 1M (varsayılan), 3M, 1Y, YTD, ALL | 7G, 1A, 3A, Tümü | 1Y ve YTD eklenir |
| D | Kayıt sonuçları | "Not opened" (ör. düşük bakiye) ile "Skipped" (ayarlar reddetti) ayrı; nedenlerin yanında tek tıkla düzelt butonu | Hepsi "Atlandı", buton yok | Ayrım + düzelt butonları |
| E | Fon koruması | Varsayılan açık, %20, zirveden kayıp, sadece kapanan kopyalar; tetiklenince girişler/compound/rebalance durur, çıkışlar devam eder; Resume / Turn off | Sadece ayar, icra yok | İcra + Resume / Kapat |
| F | Fonsuz cüzdan | Kopyalar sürekli fon yüzünden başarısız olursa cüzdanlar otomatik duraklatılır | Yok | Ardışık `low_balance` → otomatik duraklat + bildirim |
| G | Boş açılış | Fonlama gelmezse ~1 dk sonra kapatılır, rent geri alınır | Boş pozisyon açık kalıyordu | 60 sn sonra kontrol, boşsa kapat |
| H | Token filtreleri | Organic score, market cap, 24s hacim, holder, kara liste: açılmadan önce kontrol | Sadece ayar | Jupiter token verisiyle icra |
| I | Meme koruması | Kopyanın yatıracağı değerin **%95'inden fazlası** güvenilmeyen token'daysa atla | Sadece token-only eklemeler | Fiyatla değer oranı |
| J | İki taraflı ekleme | Aynı havuz ve aralık, kopya boyutunda (zap: SOL'ün bir kısmı token'a çevrilir) | Sadece SOL tarafı, tek taraflı | Zap-in: liderin oranına göre swap + iki taraflı ekleme |
| K | Önerilen % ve uyarı | Net varlık oranı ile öneri; ortalama tutma < 18 dk ise "High-frequency" uyarısı | Yok | Diyalogda öneri + uyarı |
| L | Smart Token Retention | Var (DLMM) | "Yakında" | Uygulanır |
| M | DAMM V2 | Canlı kopyalanır | Canlıda atlanıyor | cp-amm SDK ile canlı kopya |

LP Agent'ın %8 fee'si ve swap yönlendiricisi (OKX) taklit edilmez: fee'den kurtulmak projenin amacı; swap için Jupiter kullanılıyor.

**Durum (23 Kasım 2026):**
- **A–L tamam** (testli, push edildi). Doğrulamalar: zap (DLMM swap + iki taraflı ekleme) mainnet simülasyonu OK (~450k CU); Jupiter token API'si (organic score, mcap, holder, hacim, yaş) erişilebilir; `/v1/insights` Karınca için: net varlık 150 SOL, önerilen %4,54, çıkışlarının **%40'ında** 1 dk içinde aynı havuza geri dönüyor (STR'nin anlamlı olduğu lider tipi).
- **M (DAMM V2 canlı) kodlandı:** `core/meteora/dammTx.ts` (cp-amm SDK: açma = pozisyon NFT + iki taraflı likidite, ekleme, % çekme, çek + kapat, claim, değer). Her yatırma zap (DAMM V2 iki token ister). Liderin kısmi çekmesi `liquidity_delta / (kalan + delta)` oranıyla aynalanıyor. Boş açılış zincire dokunmuyor, ilk fonlamada pozisyon oluşuyor. DAMM V2 kopyalarında TP/SL/trailing (değer = SDK withdraw quote + bekleyen fee). Flip yok (DLMM bin stratejisi). **Açılış mainnet simülasyonu OK (~110k CU)**; ekleme/çekme/claim/kapama simülasyonu açık bir pozisyon bulunca yapılacak.
- **Ek bulgu: mainnet'te v1 işlemler var.** `getTransaction` artık `maxSupportedTransactionVersion: 1` ile çağrılıyor; aksi halde v1 kullanan liderlerin hareketleri okunamıyordu. Decoder v1 işlemleri sorunsuz çözüyor (gerçek işlemlerle kontrol edildi).
