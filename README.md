# Binflip

Meteora DLMM / DAMM V2 için Copy LP + bid-ask flip botu. Proje bağlamı, kararlar ve yol haritası: [`CLAUDE.md`](CLAUDE.md).

## Çalıştırma

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
curl -s 127.0.0.1:3001/health
```

Varsayılan mod **deneme (dry-run)**: bot hiçbir işlem imzalamaz. Canlı moda geçmek için `DRY_RUN=0` **ve** `LIVE_CONFIRMED=1` birlikte gerekir. Yalnızca birini ayarlarsan servisler başlamayı reddeder. Özel anahtar hiçbir zaman `.env` dosyasına yazılmaz.

## Panel

Panel sadece `127.0.0.1:3000`'de dinler. VPS'teyken kendi bilgisayarınızdan:

```bash
ssh -L 3000:127.0.0.1:3000 kullanici@vps
```

Sonra tarayıcıda `http://localhost:3000`. İlk girişten önce giriş cüzdanınızı kaydedin (sadece mesaj imzalar, bot cüzdanı değildir):

```bash
docker compose run --rm migrate node packages/db/dist/cli.js user:init --wallet <PHANTOM_ADRESINIZ>
```

`.env` içinde `SESSION_SECRET` dolu olmalı (`openssl rand -base64 48`).

## Geliştirme

```bash
pnpm install
pnpm build
pnpm test
```

Şema değişince: `pnpm db:generate` (yeni migration üretir). Migration'lar `migrate` servisiyle her açılışta uygulanır.

## Yapı

| Yol | Görev |
|---|---|
| `packages/core` | config, logger, sabitler, `Signer`, servis iskeleti |
| `packages/db` | Drizzle şeması, migration'lar |
| `apps/listener` | lider cüzdanları izler (Aşama 2) |
| `apps/executor` | işlemleri simüle eder, imzalar, gönderir (Aşama 3) |
| `apps/manager` | flip / compound / TP-SL döngüleri (Aşama 4) |
| `apps/telegram` | bildirimler, /status /pause /stop (Aşama 2) |
| `apps/api` | panel backend'i: cüzdanla giriş, liderler, kayıtlar, analiz, risk |
| `apps/web` | panel (Next.js): Copy LP, Pozisyonlar, Ayarlar |

TLS'i kesen bir proxy arkasında build alırken proxy CA'sını şöyle ver: `docker build --secret id=extra_ca,src=/yol/ca.crt -t binflip:local .`
