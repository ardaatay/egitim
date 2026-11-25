# nginx: statik site ve reverse proxy

Uygulamanı doğrudan 80/443 portundan internete açmak yerine önüne nginx koyarsın. nginx TLS'i sonlandırır, statik dosyaları uygulamaya hiç uğratmadan sunar, sıkıştırma ve önbellek başlıklarını ekler, yavaş istemcileri tamponlar, birden fazla uygulamayı tek sunucuda alan adına göre ayırır ve uygulama yeniden başlarken bile 80/443'ü açık tutar.

Bu dersin tamamı lab'da:

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Komutları lab terminalinde çalıştır. Lab'ın menüsünde sunucudaki bir portu tarayıcıda açma seçeneği de var, sonuçları `curl` yerine tarayıcıda görmek istersen 80 portunu açabilirsin.
```

## Kurulum ve dosya düzeni

```bash
apt-get update && apt-get install -y nginx
systemctl status nginx --no-pager
curl -sI localhost | head -3
```

Debian/Ubuntu düzeni:

| Yol | İçerik |
|---|---|
| `/etc/nginx/nginx.conf` | Ana ayar: worker sayısı, log biçimi, `include` satırları |
| `/etc/nginx/sites-available/` | Site (server block) dosyaları |
| `/etc/nginx/sites-enabled/` | Etkin olanlara symlink'ler |
| `/etc/nginx/conf.d/*.conf` | Ek ayarlar (RHEL tabanlılarda siteler de burada) |
| `/etc/nginx/snippets/` | Tekrar kullanılan parçalar |
| `/var/log/nginx/` | `access.log`, `error.log` |

Etkinleştirmek = `sites-enabled` içine symlink koymak:

```bash
ls -l /etc/nginx/sites-enabled/
```

### Her değişiklikten sonra

```bash
nginx -t && systemctl reload nginx
```

`nginx -t` sözdizimini ve dosya yollarını doğrular. `reload` bağlantıları koparmadan yeni ayarı devreye alır (ana süreç SIGHUP alır, yeni worker'lar başlar, eskiler mevcut istekleri bitirip kapanır). Ayar hatalıysa `reload` eski ayarla çalışmaya devam eder, ama `restart` nginx'i hiç açmayabilir. Bu yüzden **önce `-t`, sonra `reload`** bir alışkanlık olmalı.

Tam birleştirilmiş ayarı görmek için `nginx -T` (bütün include'lar açılmış hâlde).

## Statik site

Bir site klasörü hazırlayalım:

```bash
mkdir -p /var/www/demo/assets
cat > /var/www/demo/index.html <<'EOF'
<!doctype html><title>demo</title>
<link rel="stylesheet" href="/assets/site.css">
<h1>nginx çalışıyor</h1>
EOF
echo "h1 { color: teal }" > /var/www/demo/assets/site.css
chown -R root:root /var/www/demo
find /var/www/demo -type d -exec chmod 755 {} + ; find /var/www/demo -type f -exec chmod 644 {} +
```

Server block:

```bash
cat > /etc/nginx/sites-available/demo <<'EOF'
server {
    listen 80;
    server_name demo.local;

    root /var/www/demo;
    index index.html;

    access_log /var/log/nginx/demo.access.log;
    error_log  /var/log/nginx/demo.error.log warn;

    location / {
        try_files $uri $uri/ =404;
    }

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
}
EOF
ln -s /etc/nginx/sites-available/demo /etc/nginx/sites-enabled/demo
nginx -t && systemctl reload nginx
curl -s -H 'Host: demo.local' localhost
curl -sI -H 'Host: demo.local' localhost/assets/site.css | grep -i -E 'cache|expires'
```

`-H 'Host: demo.local'` ile DNS ayarlamadan belirli bir `server_name`'i test ettik. nginx hangi server block'u seçeceğine `listen` ve `Host` başlığına bakarak karar verir. Hiçbiri eşleşmezse o port için **varsayılan** server (ilk tanımlanan ya da `default_server` işaretli olan) cevap verir. Bilinmeyen alan adlarına içerik sunmamak için genelde boş bir varsayılan server tanımlanır:

```nginx
server {
    listen 80 default_server;
    server_name _;
    return 444;    # bağlantıyı yanıtsız kapat
}
```

### location eşleştirme sırası

En çok kafa karıştıran konulardan biri. nginx bir istek için location'ları şu sırayla değerlendirir:

1. `location = /tam/yol` **tam eşleşme** varsa hemen onu kullanır.
2. Önek (prefix) location'lar arasında **en uzun eşleşeni** bulur. Bu `^~` ile işaretliyse orada durur.
3. Regex location'ları (`~` büyük/küçük harf duyarlı, `~*` duyarsız) **dosyadaki sırayla** dener, ilk eşleşen kazanır.
4. Hiçbir regex eşleşmezse 2. adımdaki en uzun önek kullanılır.

```nginx
location = /health          { return 200 "ok\n"; }
location ^~ /assets/        { ... }         # regex'lere hiç bakılmaz
location ~* \.(png|jpg|svg)$ { expires 7d; }
location /                  { ... }         # her şeyi yakalayan son çare
```

### root ve alias

```nginx
location /docs/ { root  /var/www;        }   # /docs/a.html -> /var/www/docs/a.html
location /docs/ { alias /srv/manual/;    }   # /docs/a.html -> /srv/manual/a.html
```

`root` location yolunu **ekler**, `alias` onun **yerine geçer**. `alias` kullanırken her iki taraftaki sondaki `/` işaretlerinin tutarlı olması gerekir. Tutarsız olursa ya 404 alırsın ya da yol aşma (path traversal) açığı oluşur.

### SPA (React, Vue) için try_files

İstemci tarafında yönlendirme yapan uygulamalarda `/siparisler/42` gibi bir yol sunucuda dosya olarak yoktur. Hepsi `index.html`'e düşmelidir:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

## Reverse proxy

Şimdi arkaya bir uygulama koyalım. systemd dersindeki gibi basit bir Python sunucusu yeterli. Gerçek bir uygulama gibi sadece localhost'u dinlesin:

```bash
mkdir -p /srv/api && echo '{"durum":"ok"}' > /srv/api/health
cd /srv/api && nohup python3 -m http.server 8080 --bind 127.0.0.1 >/dev/null 2>&1 &
cd ~
curl -s 127.0.0.1:8080/health
```

> Uygulamanın `127.0.0.1`'i dinlemesi önemlidir. `0.0.0.0` dinlerse nginx'i atlayıp doğrudan 8080'e erişilebilir. Güvenlik duvarı olsa bile bu ikinci bir koruma katmanıdır.

Server block'a proxy ekle:

```bash
cat > /etc/nginx/sites-available/demo <<'EOF'
upstream api_backend {
    server 127.0.0.1:8080;
    keepalive 16;
}

server {
    listen 80;
    server_name demo.local;
    root /var/www/demo;

    client_max_body_size 20m;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        proxy_pass http://api_backend/;

        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 5s;
        proxy_read_timeout    60s;
    }
}
EOF
nginx -t && systemctl reload nginx
curl -s -H 'Host: demo.local' localhost/api/health
```

Satır satır:

- **`proxy_pass http://api_backend/;`** sonundaki `/` önemlidir: location önekini (`/api/`) atıp kalanı iletir. `/api/health` → `/health`. Sondaki `/` olmasaydı (`proxy_pass http://api_backend;`) istek olduğu gibi `/api/health` olarak giderdi. 404'lerin çok yaygın bir sebebi bu farktır.
- **`upstream` + `keepalive` + `proxy_http_version 1.1` + `Connection ""`**: nginx ile uygulama arasında bağlantıları yeniden kullanır. Bu olmadan her istek için yeni TCP bağlantısı açılır ve yoğun trafikte `TIME_WAIT` soketleri birikir.
- **`Host`**: Uygulama hangi alan adıyla çağrıldığını bilsin (yönlendirme URL'leri, çoklu kiracı).
- **`X-Real-IP` / `X-Forwarded-For`**: Uygulama aksi hâlde bütün istekleri `127.0.0.1`'den geliyor görür. Uygulama tarafında da bu başlıklara **sadece proxy'den geldiğinde** güvenilecek şekilde ayar yapılmalı (Express'te `trust proxy`, Django'da `SECURE_PROXY_SSL_HEADER`).
- **`X-Forwarded-Proto`**: TLS nginx'te bittiği için uygulama isteği `http` sanır. Bu başlık olmadan "https'e yönlendir" mantığı sonsuz döngüye girer.
- **`client_max_body_size`**: Varsayılan **1 MB**. Dosya yükleme özelliği ekleyince ilk göreceğin hata `413 Request Entity Too Large` olur.

### WebSocket

WebSocket bağlantıları HTTP `Upgrade` ile başlar ve nginx'in bunu açıkça iletmesi gerekir:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
# server içinde:
location /ws/ {
    proxy_pass http://api_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
}
```

`map` bloğu `http` seviyesinde olmalı (site dosyasının en üstü, `server` dışında). `proxy_read_timeout` uzatılmazsa boşta kalan WebSocket bağlantıları 60 saniyede kopar.

## Sıkıştırma

Ubuntu'nun `nginx.conf`'unda `gzip on;` zaten var, ama sadece `text/html` sıkıştırılır. Diğer türleri ekle:

```bash
cat > /etc/nginx/conf.d/gzip.conf <<'EOF'
gzip_vary on;
gzip_proxied any;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_types text/css application/javascript application/json image/svg+xml text/plain;
EOF
nginx -t && systemctl reload nginx
```

## Hata kodlarını okumak

nginx'in döndürdüğü hata kodları, sorunun nerede olduğunu doğrudan söyler:

| Kod | nginx'in anlattığı | İlk bakılacak |
|---|---|---|
| **403** | Dosyayı okuyamıyorum ya da klasör listelemesi kapalı | Yol boyunca izinler (`namei -l`), `index` dosyası var mı |
| **404** | Dosya yok | `root`/`alias`, `proxy_pass` sondaki `/`, `try_files` |
| **413** | İstek gövdesi çok büyük | `client_max_body_size` |
| **499** | İstemci yanıtı beklemeden bağlantıyı kapattı | Uygulama çok yavaş (istemci zaman aşımı) |
| **502** | Uygulamaya bağlanamadım ya da bağlantı koptu | Uygulama çalışıyor mu, doğru port mu, çöktü mü |
| **504** | Uygulamaya bağlandım ama zamanında cevap gelmedi | Yavaş sorgu, `proxy_read_timeout` |

Hepsinde ayrıntı **error log**'dadır, access log'da değil:

```bash
tail -n 20 /var/log/nginx/demo.error.log
```

502'yi kendimiz üretelim. Uygulamayı durdur ve isteği tekrarla:

```bash
pkill -f 'http.server 8080'
curl -s -o /dev/null -w "%{http_code}\n" -H 'Host: demo.local' localhost/api/health
tail -n 2 /var/log/nginx/demo.error.log
```

Error log'da `connect() failed (111: Connection refused) while connecting to upstream` satırını göreceksin. Bu, "uygulama o portu dinlemiyor" demektir. Bir de `upstream timed out (110: Connection timed out)` (504) ve `upstream prematurely closed connection` (uygulama yanıt verirken çöktü) satırlarını tanımak işe yarar.

## Erişim logunu zenginleştirmek

Log analizi dersinde kullandığımız yanıt süresi alanları nginx'te şöyle eklenir:

```nginx
log_format timed '$remote_addr - $remote_user [$time_local] "$request" '
                 '$status $body_bytes_sent "$http_referer" "$http_user_agent" '
                 'rt=$request_time urt=$upstream_response_time';
access_log /var/log/nginx/demo.access.log timed;
```

`$request_time` istemcinin gördüğü toplam süre, `$upstream_response_time` uygulamanın harcadığı süre. İkisi arasındaki büyük fark, yavaş istemciyi ya da ağ sorununu gösterir.

## Alıştırma (lab'da)

1. Python uygulamasını yeniden başlat. `/api/` altındaki isteklerin uygulamaya `/api` önekini **koruyarak** gitmesini sağla (yani `/api/health` isteği uygulamada `/api/health` olarak görünsün). Uygulamada bu yol yok, 404 almalısın. Uygulamanın konsoluna düşen yolu kontrol et.
2. `client_max_body_size` değerini `1k` yap. 2 KB'lık bir POST isteği atarak 413 al.
3. `/health` için, uygulamaya gitmeden nginx'in kendisinin `200 ok` döndüğü bir location ekle.

<details><summary>Çözüm</summary>

```bash
cd /srv/api && nohup python3 -m http.server 8080 --bind 127.0.0.1 > /tmp/api.log 2>&1 & cd ~
sed -i 's#proxy_pass http://api_backend/;#proxy_pass http://api_backend;#' /etc/nginx/sites-available/demo
sed -i 's#client_max_body_size 20m;#client_max_body_size 1k;\n    location = /health { access_log off; return 200 "ok\\n"; }#' /etc/nginx/sites-available/demo
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w "%{http_code}\n" -H 'Host: demo.local' localhost/api/health
tail -n 1 /tmp/api.log
head -c 2048 /dev/zero | curl -s -o /dev/null -w "%{http_code}\n" -H 'Host: demo.local' --data-binary @- localhost/api/health
curl -s -H 'Host: demo.local' localhost/health
```

`api.log`'un son satırında `"GET /api/health HTTP/1.1" 404` görürsün, yani önek korundu.

</details>

```quiz
`location /api/ { proxy_pass http://127.0.0.1:8080/; }` ile `/api/users` isteği uygulamaya hangi yolla gider?
- `/api/users`
- [x] `/users`
- `/api/api/users`
? `proxy_pass` URL'sinde bir yol (burada `/`) varsa, location öneki o yolla değiştirilir.
```

```quiz
nginx 502 Bad Gateway döndürüyor ve error log'da "Connection refused" var. Sorun nerede?
- nginx ayarında sözdizimi hatası
- [x] Uygulama ilgili portu dinlemiyor (kapalı, çökmüş ya da farklı portta)
- İstemcinin interneti yavaş
? 502 + Connection refused: upstream'e TCP bağlantısı kurulamadı. `systemctl status` ve `ss -tlnp` ile kontrol et.
```

```quiz
Ayarı değiştirdin. Kesintisiz ve güvenli şekilde devreye almak için?
- `systemctl restart nginx`
- [x] `nginx -t && systemctl reload nginx`
- nginx'i durdurup yeniden başlatmak
? `-t` hatayı önceden yakalar. `reload` mevcut bağlantıları koparmadan yeni worker'larla devam eder.
```

```quiz
Kullanıcılar 5 MB'lık dosya yükleyemiyor, nginx 413 döndürüyor. Çözüm?
- `proxy_read_timeout` artırmak
- [x] `client_max_body_size` değerini artırmak
- Uygulamayı yeniden başlatmak
? Varsayılan 1 MB'dır. Uygulamanın da kendi gövde sınırı olabilir.
```

## Özet

- `nginx -t && systemctl reload nginx` her değişiklikten sonra.
- server seçimi `listen` + `Host` ile, bilinmeyen alan adları için `default_server`.
- location önceliği: `=` → en uzun önek (`^~` ise dur) → regex sırayla → en uzun önek.
- `root` ekler, `alias` değiştirir. `proxy_pass`'te sondaki `/` öneki atar.
- Proxy başlıkları: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`. Bağlantı yeniden kullanımı için `keepalive`.
- 502 bağlanamadım, 504 cevap gelmedi, 413 gövde büyük, 403 izin. Ayrıntı error log'da.
