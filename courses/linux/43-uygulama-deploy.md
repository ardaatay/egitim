# Node/Python uygulamasını servis olarak yayınlamak

Önceki derslerdeki parçaları birleştiriyoruz: ayrı bir kullanıcı, systemd servisi, nginx reverse proxy. Bu derste gerçek bir Python web uygulamasını (Flask + gunicorn) baştan sona yayınlayacağız, ardından aynı şeyin Node.js karşılığını göreceğiz. Odak, "çalışıyor" ile "üretimde düzgün çalışıyor" arasındaki farklarda: worker sayısı, düzgün kapanma, sağlık kontrolü, gizli bilgiler, loglar.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Bu dersin tamamı lab'da. Önceki derslerden kalan nginx kurulumu varsa sorun değil, üzerine yazacağız.
```

## Üretim kontrol listesi

Uygulama tarafında, sunucuya koymadan önce:

- **Ayarlar ortam değişkenlerinden okunur** (12-factor). Kodda sunucuya özel yol, parola, port yok.
- **Loglar stdout/stderr'e yazılır.** Dosya ve rotasyon işini journald yapar.
- **Bir sağlık uç noktası** vardır (`/health`): uygulama ayakta ve bağımlılıklarına (veritabanı) ulaşabiliyorsa 200 döner.
- **SIGTERM yakalanır**: yeni istek almayı bırak, açık istekleri bitir, çık.
- **Sadece `127.0.0.1` dinlenir**, dışarıya nginx açılır.
- **Geliştirme sunucusu kullanılmaz.** `flask run`, `python manage.py runserver`, `nodemon` üretim için değildir. Python'da gunicorn/uvicorn, Node'da doğrudan `node` (systemd ile).

## Python: Flask + gunicorn

### 1. Kullanıcı ve klasörler

```bash
apt-get update && apt-get install -y python3-venv nginx curl
useradd --system --no-create-home --shell /usr/sbin/nologin odeme
mkdir -p /srv/odeme-api/app
```

### 2. Uygulama

Normalde bu kod git deposundan ya da CI'ın ürettiği bir paketten gelir. Burada elle yazıyoruz:

```bash
cat > /srv/odeme-api/app/app.py <<'EOF'
import os, signal, sys, time, logging
from flask import Flask, jsonify

logging.basicConfig(stream=sys.stdout, level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger("odeme")

app = Flask(__name__)
SURUM = os.getenv("APP_VERSION", "dev")

@app.get("/health")
def health():
    return jsonify(durum="ok", surum=SURUM, pid=os.getpid())

@app.get("/api/odemeler")
def odemeler():
    time.sleep(0.05)
    log.info("odeme listesi istendi")
    return jsonify([{"id": 1, "tutar": 120.5}, {"id": 2, "tutar": 80}])

@app.get("/api/yavas")
def yavas():
    time.sleep(5)
    return jsonify(sonuc="yavaş ama tamam")
EOF

cat > /srv/odeme-api/app/requirements.txt <<'EOF'
flask==3.0.3
gunicorn==22.0.0
EOF
```

### 3. Sanal ortam

Sistem Python'una `pip install` yapma: paket yöneticisinin kurduğu paketlerle çakışır, yeni Ubuntu sürümleri buna zaten izin vermez (PEP 668). Her uygulamanın kendi **venv**'i olur:

```bash
python3 -m venv /srv/odeme-api/venv
/srv/odeme-api/venv/bin/pip install -q --upgrade pip
/srv/odeme-api/venv/bin/pip install -q -r /srv/odeme-api/app/requirements.txt
/srv/odeme-api/venv/bin/gunicorn --version
```

venv'i etkinleştirmeye (`source venv/bin/activate`) gerek yok. `venv/bin/` altındaki çalıştırılabilir dosyaları tam yoluyla çağırmak yeterli ve systemd'de doğru olan da budur.

### 4. Ayar ve gizli bilgiler

```bash
cat > /etc/odeme-api.env <<'EOF'
APP_VERSION=1.0.0
LOG_LEVEL=INFO
DATABASE_URL=postgres://odeme:gizli@127.0.0.1/odeme
EOF
chown root:odeme /etc/odeme-api.env
chmod 640 /etc/odeme-api.env
chown -R root:root /srv/odeme-api
```

Kod `root`'a ait ve uygulama kullanıcısı sadece okuyabiliyor (izinler dersindeki düzen).

### 5. gunicorn ayarı

```bash
cat > /srv/odeme-api/gunicorn.conf.py <<'EOF'
import multiprocessing
bind = "127.0.0.1:8000"
workers = multiprocessing.cpu_count() * 2 + 1
timeout = 30              # bu süreyi aşan worker öldürülüp yenisi açılır
graceful_timeout = 20     # SIGTERM sonrası açık istekleri bitirme süresi
keepalive = 5
accesslog = "-"           # stdout -> journald
errorlog = "-"
max_requests = 2000       # bellek sızıntısına karşı worker'ları ara ara yenile
max_requests_jitter = 200
EOF
```

- **workers**: gunicorn'un önerdiği `2 × CPU + 1` başlangıç noktasıdır. Senkron worker'lar bir anda tek istek işler, yani 5 worker = aynı anda 5 istek. Uygulama çoğunlukla dış servis ya da veritabanı bekliyorsa `gthread` (iş parçacıklı) ya da async worker'lar (`uvicorn.workers.UvicornWorker`) daha verimlidir.
- **timeout**: Senkron worker bu süre boyunca yanıt vermezse ana süreç onu öldürür. Journal'da `WORKER TIMEOUT` görürsün. nginx'in `proxy_read_timeout`'u bundan büyük olmalı, aksi hâlde nginx önce vazgeçip 504 verir.
- **max_requests**: Sızıntı yapan bir uygulamanın belleğinin sınırsız büyümesini önleyen ucuz bir önlem.

### 6. systemd servisi

```bash
cat > /etc/systemd/system/odeme-api.service <<'EOF'
[Unit]
Description=Ödeme API (gunicorn)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=main
User=odeme
Group=odeme
WorkingDirectory=/srv/odeme-api/app
EnvironmentFile=/etc/odeme-api.env
ExecStart=/srv/odeme-api/venv/bin/gunicorn -c /srv/odeme-api/gunicorn.conf.py app:app
ExecReload=/bin/kill -HUP $MAINPID
KillMode=mixed
TimeoutStopSec=30
Restart=on-failure
RestartSec=2

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now odeme-api
systemctl status odeme-api --no-pager | head -15
curl -s 127.0.0.1:8000/health
```

Yeni satırlar:

- **`Type=notify`** + **`NotifyAccess=main`**: gunicorn, worker'lar hazır olunca systemd'ye bildirir (sadece ana sürecin bildirimi kabul edilir). `systemctl start` uygulama gerçekten istek almaya hazır olduğunda döner. Deploy betikleri için önemli.
- **`ExecReload` + HUP**: gunicorn HUP alınca ayarı yeniden okur, yeni worker'lar başlatıp eskileri nazikçe kapatır. Bağlantılar kopmaz.
- **`KillMode=mixed`**: stop sırasında SIGTERM sadece ana sürece gider (ana süreç worker'ları düzgünce kapatır), süre dolarsa SIGKILL hepsine.

`status` çıktısındaki CGroup bölümünde bir ana süreç ve onun altında worker'ları göreceksin.

### 7. nginx

```bash
cat > /etc/nginx/sites-available/odeme <<'EOF'
upstream odeme_api {
    server 127.0.0.1:8000;
    keepalive 16;
}
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://odeme_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 35s;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/demo
ln -sf /etc/nginx/sites-available/odeme /etc/nginx/sites-enabled/odeme
nginx -t && systemctl reload nginx
curl -s localhost/health
curl -s localhost/api/odemeler
journalctl -u odeme-api -n 5 --no-pager
```

İstek nginx → gunicorn → Flask zincirini geçti. Journal'da hem gunicorn'un erişim logu hem uygulamanın kendi `INFO` satırı var.

## Düzgün kapanmayı görmek

5 saniye süren bir istek gönderip ortasında servisi yeniden başlatalım:

```bash
(curl -s -w "  [HTTP %{http_code}]\n" localhost/api/yavas &) ; sleep 1; systemctl restart odeme-api; sleep 6
journalctl -u odeme-api -n 15 --no-pager | grep -i -E 'shutting|exiting|booting|handling signal'
```

İstek `200` ile tamamlandı, çünkü gunicorn SIGTERM'i aldıktan sonra `graceful_timeout` boyunca açık isteği bitirmeyi bekledi. `TimeoutStopSec` bundan kısa olsaydı systemd worker'ı öldürür, istek yarıda kesilirdi.

Ama yeniden başlatma süresince gelen **yeni** istekler ne oldu? Ana süreç dinlemeyi bıraktığı için o birkaç saniyede gelenler nginx'ten 502 alır. Bunu bir sonraki derste ele alacağız. `systemctl reload` (HUP) ise dinleyen soketi hiç kapatmadığı için bu kesintiyi yaşamaz:

```bash
for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code} " localhost/health; sleep 0.1; done & sleep 0.5; systemctl reload odeme-api; wait; echo
```

Hepsi 200 olmalı.

## Kaynak sınırları ve izleme

```bash
systemctl set-property odeme-api MemoryMax=300M CPUQuota=150%
systemctl show odeme-api -p MemoryMax -p CPUQuotaPerSecUSec
systemd-cgtop -n 1 | head
```

`set-property` bir drop-in dosyası oluşturur ve sınırı anında uygular. Bellek sınırına çarpan bir worker'ı cgroup OOM'u öldürür, gunicorn yenisini başlatır. Journal'da `Worker (pid:...) was sent SIGKILL! Perhaps out of memory?` görürsün.

## Node.js karşılığı

Aynı düzen, farklı çalıştırma komutu. Node'u **sistem genelinde** kur (dağıtım paketi, NodeSource deposu ya da resmî ikili dosyalar). `nvm` kullanıcıya özeldir ve servis kullanıcısının ortamında bulunmaz.

```bash
apt-get install -y nodejs
node --version
mkdir -p /srv/siparis/app
cat > /srv/siparis/app/server.js <<'EOF'
const http = require("http");
const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, {"content-type": "application/json"}); return res.end(JSON.stringify({durum: "ok", pid: process.pid})); }
  res.writeHead(404); res.end();
});
server.listen(port, "127.0.0.1", () => console.log(`dinleniyor :${port}`));
process.on("SIGTERM", () => {
  console.log("SIGTERM alındı, kapanıyorum");
  server.close(() => process.exit(0));      // yeni bağlantı alma, açıkları bitir
  setTimeout(() => process.exit(1), 10000).unref();
});
EOF

cat > /etc/systemd/system/siparis.service <<'EOF'
[Unit]
Description=Sipariş servisi (Node)
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
DynamicUser=yes
WorkingDirectory=/srv/siparis/app
Environment=NODE_ENV=production PORT=3000
ExecStart=/usr/bin/node server.js
Restart=on-failure
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now siparis
curl -s 127.0.0.1:3000/health; echo
systemctl stop siparis && journalctl -u siparis -n 3 --no-pager
```

İki not:

- **`DynamicUser=yes`**: systemd servis başlarken geçici bir kullanıcı oluşturur ve durunca kaldırır. `useradd` gerekmez, servis otomatik olarak `ProtectSystem=strict` ve `PrivateTmp` ile çalışır. Kalıcı veri gerekiyorsa `StateDirectory=siparis` ekle, systemd `/var/lib/siparis`'i doğru sahiplikle oluşturur.
- **PM2 gerekli mi?** PM2'nin sağladığı yeniden başlatma, log toplama ve açılışta başlatma özelliklerini systemd zaten veriyor. İkisini üst üste koymak iki süreç yöneticisi demektir ve sinyaller, loglar, kaynak sınırları karmaşıklaşır. Birden fazla CPU kullanmak için Node'un `cluster` modülü ya da birden fazla systemd örneği (`siparis@3001`, `siparis@3002` şablon birimleri) ve nginx `upstream` kullanılabilir.

Bağımlılıkları olan gerçek bir Node uygulamasında sunucuya `npm install` değil `npm ci --omit=dev` yapılır. `ci`, `package-lock.json`'a birebir uyar ve kilit dosyasıyla `package.json` uyuşmazsa hata verir. Derleme adımı (TypeScript, frontend bundle) mümkünse CI'da yapılır, sunucuya sadece çıktı gelir.

## Deploy sonrası doğrulama

Bir deploy, servis "active" olduğunda değil, sağlık kontrolü geçtiğinde bitmiştir. Deploy betiklerinde kullanacağımız kalıp:

```bash
saglik_bekle() {
  for i in $(seq 1 30); do
    if curl -fsS -m 2 "$1" >/dev/null; then echo "sağlıklı ($i. deneme)"; return 0; fi
    sleep 1
  done
  echo "sağlık kontrolü başarısız: $1" >&2; return 1
}
systemctl restart odeme-api && saglik_bekle http://127.0.0.1:8000/health
```

`curl -f` HTTP 4xx/5xx durumunda sıfırdan farklı kod döner. `-m 2` asılı kalan bir isteği 2 saniyede keser.

## Alıştırma (lab'da)

1. `/etc/odeme-api.env` içinde `APP_VERSION=1.1.0` yap. Değişikliğin `/health` çıktısına yansıması için ne gerekiyor? `reload` yeterli mi, `restart` mı gerekiyor? Deneyerek bul.
2. gunicorn worker sayısını 2'ye indir. `/api/yavas` uç noktasına aynı anda 4 istek atıp toplam süreyi ölç. Sonucu açıkla.

<details><summary>Çözüm</summary>

```bash
sed -i 's/APP_VERSION=.*/APP_VERSION=1.1.0/' /etc/odeme-api.env
systemctl reload odeme-api; sleep 2; curl -s localhost/health; echo
systemctl restart odeme-api; sleep 2; curl -s localhost/health; echo
```

`reload` yetmez: `EnvironmentFile` sadece süreç **başlarken** okunur ve HUP ile ana süreç yeniden başlamaz, yeni worker'lar ana sürecin ortamını devralır. Ortam değişkeni değişikliği `restart` gerektirir. (gunicorn'un kendi `raw_env` ayarı ya da uygulamanın dosyadan okuması bunu değiştirebilir.)

```bash
sed -i 's/^workers = .*/workers = 2/' /srv/odeme-api/gunicorn.conf.py
systemctl restart odeme-api; sleep 2
time (for i in 1 2 3 4; do curl -s -o /dev/null localhost/api/yavas & done; wait)
```

Yaklaşık 10 saniye sürer: 2 senkron worker aynı anda 2 istek işler, 4 istek iki tur sürer. Bekleme ağırlıklı uç noktalarda `worker_class = "gthread"` ve `threads = 4` gibi bir ayar aynı işi ~5 saniyede bitirir.

</details>

```quiz
nginx 504 döndürüyor, journal'da gunicorn `WORKER TIMEOUT` yazıyor. Ne oluyor?
- nginx uygulamaya bağlanamıyor
- [x] Bir istek gunicorn `timeout` süresini aştı, worker öldürüldü
- Sunucunun belleği bitti
? Yavaş uç noktayı hızlandır ya da async/thread worker kullan. Timeout'u artırmak son çare. nginx `proxy_read_timeout` gunicorn `timeout`'tan büyük olmalı.
```

```quiz
Servis kullanıcısıyla çalışan Node uygulaması için Node'u nasıl kurmalısın?
- Servis kullanıcısının ev klasörüne nvm ile
- [x] Sistem genelinde (paket, NodeSource ya da resmî ikili) ve `ExecStart`'ta tam yolla
- `npx` ile her açılışta indirerek
? nvm kullanıcıya özeldir ve kabuk ayarlarına bağlıdır. systemd bunları okumaz.
```

```quiz
`EnvironmentFile`'daki bir değeri değiştirdin. Hangisi gerekir?
- `systemctl reload app`
- [x] `systemctl restart app`
- `systemctl daemon-reload` yeterli
? Ortam değişkenleri süreç başlarken okunur. Birim dosyasını değiştirmediğin için `daemon-reload` da gerekmez.
```

## Özet

- Uygulama: ortam değişkenleri, stdout log, `/health`, SIGTERM işleme, `127.0.0.1`.
- Python: venv + gunicorn + `Type=notify` + `ExecReload` HUP. Node: sistem genelinde node, `server.close()` ile düzgün kapanma, PM2 yerine systemd.
- `restart` kısa bir kesinti yaratır, gunicorn `reload` yaratmaz.
- Deploy, sağlık kontrolü geçtiğinde biter: `curl -fsS -m 2` ile bekle.
