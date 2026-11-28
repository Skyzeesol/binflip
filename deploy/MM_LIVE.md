# İlginç motoru (apps/mm): küçük canlı test

Bu kurulum **Binflip'e dokunmaz**: ayrı klasör, ayrı Docker projesi (`binflip-mm`), ayrı cüzdan.
Postgres/Redis kullanmaz. Anahtarı girmek ve canlıya almak **senin** adımın.

## Ne yapar

- **Giriş:** BviQ (`BviQcBvn…v6eU`) yeni bir pozisyon açınca aynı havuzda kendi pozisyonunu açar. Sabit lot (`MM_LOT_SOL`), sadece SOL, aktif binin hemen altına.
- **Rebalance:** Kendi kurallarıyla, BviQ'yi beklemeden yapar: aktif bin 2 bin uzaklaşınca tek işlemde taşır, fee'yi toplar. Her işlem göndermeden önce simüle edilir; fiyat kaçtıysa işlem gönderilmez, ücret ödenmez.
- **Çıkış:** BviQ kapatınca kapatır, ya da 55 dk hareketsizlikte. Kalan token'ı Jupiter ile (yoksa havuzdan) satar.
- **Sınırlar:** en fazla `MM_MAX_POSITIONS` açık pozisyon. Cüzdanda her zaman `MM_RESERVE_SOL` kadar SOL bırakır.

## 1. Kodu ayrı klasöre al (binflip kullanıcısıyla)

```bash
ssh binflip@5.222.2.209
```

```bash
git clone --depth 1 -b research/ilginc git@github.com:Skyzeesol/binflip.git ~/binflip-mm && cd ~/binflip-mm
```

## 2. Ayarlar

Helius RPC adresini Binflip'ten kopyala (anahtar ekrana basılmaz):

```bash
grep '^SOLANA_RPC_URL=' ~/binflip/.env > .env.mm && chmod 600 .env.mm && wc -c .env.mm
```

```bash
mkdir -p keystore-mm secrets mm-data && chmod 700 keystore-mm secrets
```

## 3. İmajı derle (birkaç dakika sürer)

```bash
docker compose -f docker-compose.mm.yml build
```

## 4. Bot cüzdanını oluştur

Parolayı iki kez soracak (ekranda görünmez, en az 12 karakter). Sonunda **public adresi** yazar.

```bash
touch secrets/mm_passphrase && docker compose -f docker-compose.mm.yml run --rm -it wallet
```

Aynı parolayı servisin okuyacağı dosyaya yaz (ekranda görünmez):

```bash
read -rs -p "Parola: " P && printf %s "$P" > secrets/mm_passphrase && unset P && chmod 600 secrets/mm_passphrase && echo
```

Parolayı ve `keystore-mm/mm.json` dosyasını güvenli bir yerde **yedekle**. Kaybolursa cüzdandaki para kurtarılamaz.

## 5. Cüzdana SOL gönder

Phantom'dan, 4. adımda yazan adrese **az** gönder. Örneğin 0,5 SOL: 3 pozisyon × 0,1 SOL + 0,15 yedek + ücretler.

## 6. Canlıya al

```bash
printf 'DRY_RUN=0\nLIVE_CONFIRMED=1\nMM_LIVE=1\nMM_LOT_SOL=0.1\nMM_MAX_POSITIONS=3\n' >> .env.mm
```

```bash
docker compose -f docker-compose.mm.yml up -d mm
```

Başlangıç kaydında `LIVE: mm will send transactions` satırı, cüzdan adresi ve bakiye görünmeli:

```bash
docker compose -f docker-compose.mm.yml logs --tail 30 mm
```

## İzleme

```bash
tail -f mm-data/live.$(date -u +%F).jsonl
```

| Kayıt | Anlamı |
|---|---|
| `open` | Pozisyon açıldı |
| `rebalance` | Taşındı |
| `rebalance_failed` | Fiyat kaçtı. Normaldir, bir sonraki fiyat değişiminde tekrar dener. |
| `close` | Kapandı |
| `sell` | Token satıldı |
| `open_skipped` | Açılmadı (sebep yanında yazar) |

## Durdurma

| Ne istiyorsun | Komut |
|---|---|
| Yeni pozisyon açmasın (açıklar yönetilmeye devam eder) | `touch mm-data/STOP` |
| **Tüm pozisyonları kapatsın ve token'ları satsın** | `touch mm-data/CLOSE_ALL` |
| Tekrar açmaya başlasın | `rm -f mm-data/STOP mm-data/CLOSE_ALL` |
| Servisi tamamen durdur (önce `CLOSE_ALL` ile kapatmayı bekle!) | `docker compose -f docker-compose.mm.yml down` |

Servis yeniden başlarsa açık pozisyonları `mm-data/live-state.json` dosyasından hatırlar ve yönetmeye devam eder.
