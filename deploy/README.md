# Binflip — VPS kurulum rehberi (sıfırdan canlıya)

Bu rehber temiz bir sunucudan başlayıp önce **dry-run** (gerçek işlem yok), sonra **küçük bir canlı test** ile biter.
Anahtar ve canlıya alma adımları **senin** adımındır; Claude bu adımları senin yerine yapmaz.

> Güvenlik kuralları (değişmez)
> - Ana cüzdanın özel anahtarı sunucuya **asla** girmez. Bot ayrı, yeni üretilmiş bir cüzdanla çalışır.
> - Anahtar repoya, `.env`'e veya loglara yazılmaz; sunucuda şifreli durur, panele hiç gelmez.
> - Varsayılan `DRY_RUN=1`. Canlı için `docker-compose.live.yml` + keystore parolası gerekir.

---

## 1. Sunucu seçimi

| | Öneri |
|---|---|
| İşletim sistemi | **Ubuntu 24.04 LTS** |
| Boyut | 2 vCPU / 4 GB RAM / 40 GB SSD (en az). Derleme için 4 GB rahat eder. |
| Konum | Helius bölgesine yakın: **Frankfurt / Amsterdam** veya **US-East (Ashburn/NY)** |
| Sağlayıcı | Hetzner, DigitalOcean, Vultr, OVH — hepsi olur |

Sunucuyu oluştururken **SSH anahtarı** ile oluştur (parolayla değil).

Bilgisayarında anahtar yoksa:

```bash
ssh-keygen -t ed25519 -C binflip-vps
```

`~/.ssh/id_ed25519.pub` içeriğini sağlayıcının "SSH key" alanına yapıştır.

## 2. Sağlamlaştırma (tek seferlik, root olarak)

```bash
ssh root@SUNUCU_IP
```

```bash
curl -fsSL https://raw.githubusercontent.com/Skyzeesol/binflip/main/deploy/bootstrap.sh -o bootstrap.sh
```

Repo private olduğu için bu link çalışmazsa betiği bilgisayarından kopyala:

```bash
scp deploy/bootstrap.sh root@SUNUCU_IP:
```

Önce oku, sonra çalıştır:

```bash
less bootstrap.sh
```

```bash
bash bootstrap.sh
```

Ne yapar: `binflip` kullanıcısını açar, SSH'ı sadece anahtarla ve root'suz yapar, firewall'da sadece SSH'ı açık bırakır
(panel ve API dışarıya **kapalı**), fail2ban, otomatik güvenlik güncellemeleri, 2 GB swap ve Docker kurar.

**Bu oturumu kapatmadan** yeni bir terminalde giriş yapabildiğini dene:

```bash
ssh binflip@SUNUCU_IP
```

## 3. Kodu çek (salt-okunur deploy anahtarı)

Sunucuda (`binflip` kullanıcısıyla):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/binflip_deploy -N "" -C binflip-deploy
```

```bash
cat ~/.ssh/binflip_deploy.pub
```

Bu satırı GitHub'da **Skyzeesol/binflip → Settings → Deploy keys → Add deploy key** ekranına yapıştır.
"Allow write access" kutusunu **işaretleme**.

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/binflip_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

```bash
git clone git@github.com:Skyzeesol/binflip.git ~/binflip
```

```bash
cd ~/binflip
```

## 4. `.env`

```bash
cp .env.example .env && chmod 600 .env
```

```bash
nano .env
```

Doldurulacaklar:

| Değişken | Değer |
|---|---|
| `SOLANA_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=HELIUS_KEY` (anahtar **URL parametresi** olarak) |
| `SESSION_SECRET` | `openssl rand -base64 48` çıktısı (cüzdan anahtarı değil, panel çerezini imzalar) |
| `SWEEP_TO_ADDRESS` | Ana cüzdanının **sadece public adresi** (kârlar buraya süpürülür) |
| `POSTGRES_PASSWORD` | Uzun rastgele bir parola: `openssl rand -hex 24` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | İsteğe bağlı, bildirimler için |

`DRY_RUN=1` ve `LIVE_CONFIRMED=0` olarak **kalsın**.

## 5. İlk açılış (dry-run)

```bash
./deploy/update.sh
```

Panelin giriş cüzdanını tanımla (Phantom'daki adresin; imzayla giriş yapacaksın, anahtar istenmez):

```bash
docker compose run --rm migrate node packages/db/dist/cli.js user:init --wallet PHANTOM_ADRESIN
```

## 6. Bot cüzdanı (senin adımın)

```bash
mkdir -p keystore secrets && chmod 700 keystore secrets
```

Keystore parolasını yaz (uzun ve rastgele; bir parola yöneticisinde de sakla):

```bash
openssl rand -base64 32 > secrets/keystore_passphrase && chmod 600 secrets/keystore_passphrase
```

Container `node` kullanıcısıyla (uid 1000) çalışır; klasörlere erişebilmesi için:

```bash
sudo chown -R 1000:1000 keystore secrets
```

Yeni bot cüzdanını üret (ekrana sadece public adres basılır):

```bash
docker compose -f docker-compose.yml -f docker-compose.live.yml run --rm -v "$PWD/secrets:/secrets:ro" migrate node packages/db/dist/cli.js wallet:create --label agent --out /keystore/agent.json --passphrase-file /secrets/keystore_passphrase
```

**Yedek (çok önemli):** şifreli keystore ve parolayı **ayrı ayrı** sunucu dışına al. Bilgisayarında:

```bash
scp binflip@SUNUCU_IP:binflip/keystore/agent.json ./binflip-agent.json
```

Parolayı parola yöneticine kaydet; ikisini aynı yerde tutma. Sunucu kaybolursa bu ikisiyle cüzdan geri gelir.

## 7. Gecikmeyi ölç (dry-run'da 1–2 saat çalıştır)

Panelden veya CLI ile en az bir lider ekle, sonra:

```bash
./deploy/latency.sh 2h
```

Hedef: p50 birkaç saniye. `ws: 0` görünürse WebSocket gelmiyor, her şey yedek poll ile geliyor demektir
(Helius'ta normalde WebSocket çalışır).

## 8. Panel (SSH tüneli)

Panel internete açık değil. Bilgisayarında:

```bash
ssh -N -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 binflip@SUNUCU_IP
```

Sonra tarayıcıda `http://localhost:3000` → cüzdanınla (Jupiter, Phantom, Solflare…) imzala → giriş.

**Tünelsiz, telefondan (Tailscale):** sunucuda `tailscale up` + `tailscale serve --bg 3000` ile panel `https://binflip.xxxx.ts.net` adresinde sadece senin Tailscale cihazlarına açılır.
Bu adresi `.env`'e ekle, yoksa giriş reddedilir (imza bu adrese bağlanır):

```bash
echo "PANEL_ORIGINS=http://localhost:3000,https://binflip.xxxx.ts.net" >> .env && ./deploy/update.sh
```

Telefonda adresi Jupiter (ya da Phantom) uygulamasının içindeki tarayıcıdan aç.

## 9. Küçük canlı test (senin adımın)

1. Bot cüzdanına **küçük** miktar SOL gönder (ör. 0.5–1 SOL).
2. Panelden risk limitlerini düşük tut (işlem başına en fazla 0.1–0.2 SOL).
3. Canlıyı aç:

```bash
./deploy/update.sh --live
```

4. İlk kopyaları panelin **Logs** sayfasından ve Solscan'den takip et.

**Acil durdurma (kill switch):**

```bash
docker compose run --rm migrate node packages/db/dist/cli.js kill
```

Geri açmak için `unkill`. Tamamen dry-run'a dönmek için `--live` olmadan `./deploy/update.sh`.

## 10. Güncelleme ve geri alma

```bash
./deploy/update.sh --live
```

Sağlık kontrolü geçmezse betik geri alma komutunu yazar (`git checkout ESKI_COMMIT && ./deploy/update.sh --live`).
Migration'lar her açılışta otomatik uygulanır.

## 11. Günlük yedek

```bash
crontab -e
```

Şu satırı ekle:

```
17 3 * * * /home/binflip/binflip/deploy/backup.sh >> /home/binflip/binflip-data/backup.log 2>&1
```

Yedekler `~/binflip-data/backups` altında 14 gün tutulur. Ara sıra bilgisayarına da kopyala.

## 12. Sunucuda yapılacak doğrulamalar (Claude ile)

- DAMM V2 add / remove / claim / close simülasyonları (canlı bir DAMM V2 SOL pozisyonuyla).
- Smart Token Retention: gerçek bir tut → lider geri ekler → yeniden kullan döngüsü.
- Helius ile gecikme ölçümü (`latency.sh`).
- İlk küçük canlı işlem.

## Sorun giderme

| Belirti | Bak |
|---|---|
| Servis ayağa kalkmıyor | `docker compose logs --tail 100 SERVIS` |
| Executor "keystore" hatası | `keystore/` ve `secrets/` sahibi uid 1000 mi? (`ls -ln`) |
| RPC 401/403 | Helius anahtarı URL'de `?api-key=` olarak mı? |
| Disk doldu | `docker system prune -af` (eski imajları siler) |
