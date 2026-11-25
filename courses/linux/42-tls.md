# TLS ve Let's Encrypt (certbot)

HTTPS artık bir seçenek değil: tarayıcılar HTTP siteleri "güvenli değil" diye işaretliyor, HTTP/2 pratikte TLS gerektiriyor, çerezlerin `Secure` bayrağı ve pek çok tarayıcı API'si sadece HTTPS'te çalışıyor. Bu derste sertifikanın ne olduğunu, Let's Encrypt ile otomatik sertifika almayı, nginx'te doğru TLS ayarını ve en sık karşılaşılan TLS hatalarının teşhisini göreceğiz.

## Kısaca TLS

İstemci `https://odeme.ornek.com`'a bağlanınca:

1. TCP bağlantısından sonra istemci **ClientHello** gönderir. İçinde istediği alan adı (**SNI**) da vardır. nginx, aynı IP'deki birden fazla siteden hangisinin sertifikasını sunacağını buna göre seçer.
2. Sunucu **sertifikasını** ve **ara sertifikaları** (zincir) gönderir.
3. İstemci zinciri kendi güvendiği **kök sertifikalara** kadar doğrular, sertifikadaki alan adının (SAN) istediği adla eşleştiğini ve süresinin geçmediğini kontrol eder.
4. Anahtar değişimiyle oturum anahtarları üretilir. Bundan sonrası simetrik şifrelidir.

Sertifika, "bu açık anahtar bu alan adına aittir" diyen ve bir sertifika otoritesi (CA) tarafından imzalanmış bir belgedir. **Özel anahtar** (`privkey.pem`) sunucudan hiç çıkmaz ve `600` izinle saklanır.

## Let's Encrypt nasıl doğrular?

Let's Encrypt ücretsiz, kısa ömürlü (şu an 90 gün, ileride daha da kısalması planlanıyor) sertifikalar verir ve alan adının sende olduğunu **ACME** protokolüyle otomatik doğrular:

| Yöntem | Nasıl | Ne zaman |
|---|---|---|
| **HTTP-01** | CA, `http://alanadi/.well-known/acme-challenge/<token>` adresinden bir dosya ister | En yaygını. Alan adının bu sunucuyu göstermesi ve **80 portunun internete açık** olması gerekir |
| **DNS-01** | CA, `_acme-challenge.alanadi` için bir TXT kaydı ister | **Wildcard** (`*.ornek.com`) için tek yol. Sunucu internete kapalıyken de çalışır. DNS sağlayıcısının API'si gerekir |

90 günlük süre bilinçli bir tercihtir: yenileme otomatik olmak zorundadır. Elle yenilenen sertifika er geç unutulur.

## certbot ile gerçek bir sunucuda

Bu adımlar için **gerçek bir alan adı** ve o alan adının A kaydının sunucunu göstermesi gerekir, bu yüzden lab'da yapamayız. Kendi sunucunda sırasıyla:

```bash
apt-get install -y certbot python3-certbot-nginx

# 1) nginx eklentisi: sertifikayı alır, server block'u kendisi düzenler
certbot --nginx -d odeme.ornek.com -d www.odeme.ornek.com \
        --agree-tos -m ops@ornek.com --redirect

# 2) ya da sadece sertifikayı al, nginx'i kendin ayarla (daha öngörülebilir)
certbot certonly --webroot -w /var/www/letsencrypt -d odeme.ornek.com
```

İkinci yöntemde nginx'in ACME isteklerini o klasörden sunması gerekir:

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/www/letsencrypt;
}
```

Sertifikalar şurada durur:

```text
/etc/letsencrypt/live/odeme.ornek.com/
├── fullchain.pem   # sunucu sertifikası + ara sertifikalar  -> ssl_certificate
├── privkey.pem     # özel anahtar                           -> ssl_certificate_key
├── cert.pem        # sadece sunucu sertifikası (nginx'te KULLANMA)
└── chain.pem       # sadece ara sertifikalar
```

Bunlar `/etc/letsencrypt/archive/` altındaki sürümlü dosyalara symlink'tir. Yenilemede symlink güncellenir, nginx ayarına dokunmak gerekmez.

### Otomatik yenileme

Paket bir systemd timer kurar (ya da cron işi):

```bash
systemctl list-timers | grep certbot
certbot renew --dry-run
```

`--dry-run` gerçek yenileme yapmadan bütün akışı Let's Encrypt'in test ortamında dener. Kurulumdan sonra **mutlaka** çalıştır. Yenileme 30 gün kala yapılır.

Yenilenen sertifikanın devreye girmesi için nginx'in yeniden yüklenmesi gerekir. Bunu bir **deploy hook** ile yap:

```bash
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

`--nginx` eklentisi bunu kendisi yapar. `certonly --webroot` ile aldıysan hook'u sen eklemelisin. Aksi hâlde sertifika diskte yenilenir ama nginx 90. gün eskisini sunmaya devam eder ve site kapanır.

> **Dikkat:** Let's Encrypt'in üretim ortamında **hız sınırları** vardır (örneğin aynı alan adı kümesi için haftada 5 kopya sertifika). Denemeler yaparken `--staging` (ya da `--test-cert`) kullan, çalıştığından emin olunca kaldır.

## nginx TLS ayarı

Lab'da gerçek bir alan adımız olmadığı için **kendinden imzalı** bir sertifika üretip aynı ayarı kuracağız. Sertifika dışındaki her şey birebir aynıdır.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
nginx dersindeki kurulumu yaptıysan aynı ortamda devam et. Yapmadıysan önce `apt-get update && apt-get install -y nginx`.
```

```bash
mkdir -p /etc/ssl/demo
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout /etc/ssl/demo/privkey.pem -out /etc/ssl/demo/fullchain.pem \
  -subj "/CN=demo.local" -addext "subjectAltName=DNS:demo.local,DNS:www.demo.local"
chmod 600 /etc/ssl/demo/privkey.pem
openssl x509 -in /etc/ssl/demo/fullchain.pem -noout -subject -enddate -ext subjectAltName
```

Önerilen ayarların bir kısmını paylaşılan bir parça dosyasına koyalım. Mozilla'nın SSL Configuration Generator'ının "intermediate" profiline benzer:

```bash
cat > /etc/nginx/snippets/tls.conf <<'EOF'
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
add_header Strict-Transport-Security "max-age=63072000" always;
EOF
```

Site:

```bash
mkdir -p /var/www/demo && echo "<h1>HTTPS çalışıyor</h1>" > /var/www/demo/index.html
cat > /etc/nginx/sites-available/demo <<'EOF'
server {
    listen 80;
    server_name demo.local www.demo.local;

    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name demo.local www.demo.local;

    ssl_certificate     /etc/ssl/demo/fullchain.pem;
    ssl_certificate_key /etc/ssl/demo/privkey.pem;
    include snippets/tls.conf;

    root /var/www/demo;
    location / { try_files $uri $uri/ =404; }
}
EOF
ln -sf /etc/nginx/sites-available/demo /etc/nginx/sites-enabled/demo
nginx -t && systemctl reload nginx
```

> nginx 1.25.1 ve sonrasında HTTP/2 için yeni yazım `listen 443 ssl;` + ayrı bir `http2 on;` satırıdır. Eski yazım (`listen 443 ssl http2;`) orada da çalışır ama `nginx -t` bir uyarı verir. Ubuntu 22.04/24.04 paketleri (1.18/1.24) yeni yazımı tanımadığı için burada eskisini kullandık. Sürümünü `nginx -v` ile görebilirsin.

Test:

```bash
curl -sI -H 'Host: demo.local' http://localhost | grep -i -E '^HTTP|location'
curl -s --resolve demo.local:443:127.0.0.1 https://demo.local
curl -s -k --resolve demo.local:443:127.0.0.1 https://demo.local
```

- İlki 301 ile HTTPS'e yönlendiriyor.
- İkincisi **hata veriyor**: curl kendinden imzalı sertifikaya güvenmiyor. Doğru davranış bu.
- Üçüncüsü `-k` ile doğrulamayı atlıyor. **Sadece test için.** Betiklerde ve uygulama kodunda doğrulamayı kapatmak, TLS'in bütün amacını yok eder.

`--resolve` DNS'e dokunmadan bir alan adını belirli bir IP'ye yönlendirir. SNI ve sertifika eşleşmesini doğru test etmenin yolu budur. `https://127.0.0.1` ile test edersen sertifika adı eşleşmez.

### HSTS hakkında

`Strict-Transport-Security` başlığı tarayıcıya "bu siteye `max-age` süresince sadece HTTPS ile gel" der. Tarayıcı sonraki ziyaretlerde HTTP'ye hiç gitmez. Güçlü bir korumadır, ama geri alınması zordur: HTTPS'in tüm alt alan adlarında çalıştığından emin olmadan `includeSubDomains` ekleme. İlk denemelerde kısa bir `max-age` (örneğin `300`) ile başla.

## TLS sorunlarını teşhis etmek

`openssl s_client` TLS bağlantısının ham hâlini gösterir:

```bash
openssl s_client -connect 127.0.0.1:443 -servername demo.local </dev/null 2>/dev/null | head -20
openssl s_client -connect 127.0.0.1:443 -servername demo.local </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

Gerçek bir sitede de dene (lab'dan internete çıkış var):

```bash
openssl s_client -connect letsencrypt.org:443 -servername letsencrypt.org </dev/null 2>/dev/null | grep -E 's:|i:|Verify return'
```

`s:` (subject) ve `i:` (issuer) satırları zinciri gösterir: sunucu sertifikası → ara sertifika → kök. En alttaki `Verify return code: 0 (ok)` zincirin doğrulandığını söyler.

Sık görülen sorunlar:

| Belirti | Sebep | Çözüm |
|---|---|---|
| Tarayıcıda çalışıyor, `curl`/mobil/Java'da "unable to get local issuer certificate" | Ara sertifika eksik (`cert.pem` kullanılmış) | `ssl_certificate` → `fullchain.pem` |
| "certificate has expired" | Yenileme çalışmıyor ya da nginx yenilenen sertifikayı yüklemedi | `certbot renew --dry-run`, deploy hook, `systemctl reload nginx` |
| "hostname mismatch" / `NET::ERR_CERT_COMMON_NAME_INVALID` | Sertifikanın SAN listesinde bu ad yok | `-d` ile adı ekleyip yeniden al |
| Yanlış sitenin sertifikası geliyor | SNI eşleşmedi, varsayılan server cevap verdi | `server_name`, `listen 443 ssl default_server` |
| HTTP-01 doğrulaması başarısız | 80 portu kapalı, DNS başka yeri gösteriyor ya da HTTP→HTTPS yönlendirmesi `/.well-known` yolunu da yakalıyor | Güvenlik duvarı, `dig +short alanadi`, `^~ /.well-known` location'ı |

### Süre takibi

Sertifikanın bitmesine kaç gün kaldığını kontrol eden tek satır. İzleme sistemine bağlamak için iyi bir aday:

```bash
echo | openssl s_client -connect letsencrypt.org:443 -servername letsencrypt.org 2>/dev/null \
  | openssl x509 -noout -enddate
openssl x509 -in /etc/ssl/demo/fullchain.pem -noout -checkend $((14*86400)) && echo "14 günden fazla var" || echo "14 gün içinde bitiyor!"
```

`-checkend N`, sertifika N saniye içinde bitecekse 1 döner. Bir timer'a bağlanıp başarısızlıkta alarm verdirilebilir (önceki dersteki ölü adam izleme).

## Alıştırma (lab'da)

1. `/etc/ssl/demo/fullchain.pem` sertifikasının SAN listesinde hangi adlar var? `www.demo.local` ile HTTPS isteği at ve sertifikanın kabul edildiğini (`-k` olmadan değil, `--cacert` ile) doğrula.
2. Sertifikayı sadece 1 gün geçerli olacak şekilde yeniden üret, nginx'i yeniden yükle ve `-checkend` ile 14 günlük kontrolün alarm verdiğini gör.

<details><summary>Çözüm</summary>

```bash
openssl x509 -in /etc/ssl/demo/fullchain.pem -noout -ext subjectAltName
curl -s --cacert /etc/ssl/demo/fullchain.pem --resolve www.demo.local:443:127.0.0.1 https://www.demo.local

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout /etc/ssl/demo/privkey.pem -out /etc/ssl/demo/fullchain.pem \
  -subj "/CN=demo.local" -addext "subjectAltName=DNS:demo.local,DNS:www.demo.local"
nginx -t && systemctl reload nginx
echo | openssl s_client -connect 127.0.0.1:443 -servername demo.local 2>/dev/null | openssl x509 -noout -checkend $((14*86400)) || echo "ALARM: sertifika 14 gün içinde bitiyor"
```

`--cacert` ile kendinden imzalı sertifikayı güvenilir kök olarak verdik, böylece doğrulamayı kapatmadan test ettik. Bir şirket içi CA kullandığında da aynı yöntem geçerli.

</details>

```quiz
Site tarayıcıda sorunsuz açılıyor ama bir Java servisi "PKIX path building failed" hatası alıyor. En olası sebep?
- Java eski
- [x] nginx'te `cert.pem` kullanılmış, ara sertifika gönderilmiyor
- Sertifikanın süresi dolmuş
? Tarayıcılar eksik ara sertifikayı kendileri tamamlayabilir, çoğu istemci tamamlayamaz. `fullchain.pem` kullan.
```

```quiz
`*.ornek.com` wildcard sertifikası almak için hangi doğrulama yöntemi gerekir?
- HTTP-01
- [x] DNS-01
- Hiçbiri, Let's Encrypt wildcard vermez
? Wildcard sertifikalar yalnızca DNS-01 ile doğrulanır.
```

```quiz
Sertifika diskte yenilendi ama site hâlâ eski (süresi geçmiş) sertifikayı sunuyor. Neden?
- certbot yanlış klasöre yazdı
- [x] nginx yeniden yüklenmedi, eski sertifika bellekte
- Tarayıcı önbelleği
? Deploy hook ile her yenilemeden sonra `systemctl reload nginx` çalıştırılmalı.
```

## Özet

- Sertifika = alan adı + açık anahtar + CA imzası. Özel anahtar `600`, sunucudan çıkmaz.
- HTTP-01: 80 portu ve DNS gerekli. DNS-01: wildcard ve kapalı sunucular.
- `ssl_certificate` her zaman `fullchain.pem`.
- `certbot renew --dry-run` + deploy hook ile `systemctl reload nginx`.
- Test: `curl --resolve`, `openssl s_client -servername`, `openssl x509 -checkend`.
