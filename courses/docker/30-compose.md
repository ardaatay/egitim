# Compose ile çok servisli uygulama: YAML, CLI, build

Gerçek bir uygulama tek konteyner değildir: bir API, bir veritabanı, bir önbellek, önünde bir nginx. Önceki derslerde her biri için uzun `docker run` komutları yazdık: ağ oluştur, volume oluştur, doğru sırayla başlat, doğru ortam değişkenlerini ver. **Docker Compose** bütün bunları tek bir YAML dosyasında **bildirimsel** olarak tanımlar ve tek komutla ayağa kaldırır.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh  (compose eklentisi dahil gelir)
```

## Compose v1 ve v2

- **v1**: Python ile yazılmış ayrı bir araç, komut `docker-compose` (tireli). 2023'te desteği bitti.
- **v2**: Go ile yeniden yazılmış Docker CLI eklentisi, komut **`docker compose`** (boşluklu). Bu derste kullandığımız.

Dosya adı olarak `compose.yaml` önerilir (`docker-compose.yml` de okunur). Eski dosyalardaki en üstteki `version: "3.8"` satırı artık **gereksizdir** ve yok sayılır: Compose, tek ve birleşik **Compose Specification**'ı kullanır.

```bash
docker compose version
```

## Örnek uygulama

Bir sipariş sayacı: Flask API, sayacı Redis'te tutar, kayıtları PostgreSQL'e yazar, önünde nginx durur.

```bash
mkdir -p ~/siparis/api ~/siparis/nginx && cd ~/siparis

cat > api/app.py <<'EOF'
import os, socket
import psycopg, redis
from flask import Flask, jsonify

app = Flask(__name__)
r = redis.Redis(host=os.environ["REDIS_HOST"], port=6379)

def db():
    return psycopg.connect(host=os.environ["DB_HOST"], user="app",
                           password=open(os.environ["DB_PASSWORD_FILE"]).read().strip(),
                           dbname="siparis")

@app.get("/health")
def health():
    return jsonify(durum="ok", konteyner=socket.gethostname())

@app.post("/siparis")
def siparis():
    n = r.incr("sayac")
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS siparis(id serial primary key, no int, kim text)")
        c.execute("INSERT INTO siparis(no, kim) VALUES (%s, %s)", (n, socket.gethostname()))
    return jsonify(no=n, isleyen=socket.gethostname())

@app.get("/siparis")
def liste():
    with db() as c:
        rows = c.execute("SELECT no, kim FROM siparis ORDER BY id DESC LIMIT 5").fetchall()
    return jsonify(toplam=int(r.get("sayac") or 0), son=[{"no": a, "kim": b} for a, b in rows])
EOF

cat > api/requirements.txt <<'EOF'
flask==3.0.3
gunicorn==22.0.0
redis==5.0.8
psycopg[binary]==3.2.3
EOF

cat > api/Dockerfile <<'EOF'
# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN useradd --system --no-create-home app
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
USER app
EXPOSE 8000
CMD ["gunicorn", "-b", "0.0.0.0:8000", "-w", "2", "--access-logfile", "-", "app:app"]
EOF

cat > nginx/default.conf <<'EOF'
upstream api { server api:8000; }
server {
    listen 80;
    location / {
        proxy_pass http://api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

mkdir -p secrets && printf 'cok-gizli-parola' > secrets/db_password
chmod 700 secrets && chmod 644 secrets/db_password
```

## compose.yaml

```bash
cat > compose.yaml <<'EOF'
name: siparis

services:
  nginx:
    image: nginx:1.27-alpine
    ports:
      - "127.0.0.1:8080:80"
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - api
    networks: [on]

  api:
    build: ./api
    image: siparis-api:dev
    environment:
      DB_HOST: db
      REDIS_HOST: redis
      DB_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
    depends_on:
      - db
      - redis
    networks: [on, arka]

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: siparis
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks: [arka]

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    networks: [arka]

networks:
  on:
  arka:
    internal: true

volumes:
  pgdata:
  redisdata:

secrets:
  db_password:
    file: ./secrets/db_password
EOF
```

Üst seviye anahtarlar:

| Anahtar | İçerik |
|---|---|
| `name` | Proje adı. Verilmezse klasör adı kullanılır |
| `services` | Her biri bir (ya da ölçeklenince birden fazla) konteyner |
| `networks` | Ağlar. Tanımlanmazsa Compose tek bir `default` ağ oluşturur |
| `volumes` | İsimli volume'ler |
| `secrets`, `configs` | Konteynere dosya olarak verilen gizli bilgi ve ayarlar |

> Swarm olmadan Compose, `secrets` dosyalarını konteynere salt okunur bir **bind mount** olarak bağlar ve sahiplik/izin ayarlarını (`uid`, `mode`) uygulamaz. Dosyanın konteynerdeki kullanıcı (burada `app` ve `postgres`) tarafından okunabilmesi gerektiği için dosya `644`. Gizliliği host tarafında klasörün `700` izni sağlıyor. Swarm bölümünde secret'lar şifreli saklanır ve izinleri ayarlanabilir.

Servis anahtarlarının çoğu `docker run` seçeneklerinin birebir karşılığı: `image`, `ports` (`-p`), `volumes` (`-v`), `environment` (`-e`), `env_file`, `command`, `networks`, `restart`, `user`, `healthcheck`, `init`, `mem_limit`... Önceki derslerde öğrendiğin her şey burada da geçerli. Sadece YAML'da yazılıyor.

> YAML girinti tabanlıdır ve **tab karakteri kabul etmez**. Port tanımlarını her zaman tırnak içinde yaz: `"8080:80"`. Tırnaksız `22:22` gibi bazı değerler YAML 1.1'de altmışlık tabanda sayı olarak yorumlanabilir.

## Çalıştırmak

```bash
docker compose config --quiet && echo "dosya geçerli"
docker compose up -d --build
docker compose ps
```

`up` sırasıyla şunları yaptı: `api` imajını build etti, ağları ve volume'leri oluşturdu, konteynerleri `depends_on` sırasına göre başlattı (önce `db` ve `redis`, sonra `api`, en son `nginx`).

```bash
sleep 5
curl -s -X POST localhost:8080/siparis; echo
curl -s -X POST localhost:8080/siparis; echo
curl -s localhost:8080/siparis; echo
```

### İsimlendirme ve ağ

```bash
docker ps --format '{{.Names}}'
docker network ls | grep siparis
docker volume ls | grep siparis
```

Kaynaklar **proje adıyla** önek alır: `siparis-api-1`, `siparis_on`, `siparis_pgdata`. Aynı sunucuda aynı compose dosyasını farklı proje adlarıyla (`-p test`, `-p staging`) çalıştırabilirsin, birbirine karışmazlar.

Servisler birbirine **servis adıyla** ulaşır (`db`, `redis`, `api`): Compose her ağı kullanıcı tanımlı bir bridge ağı olarak oluşturur, ağ dersindeki DNS burada otomatik çalışır. nginx `arka` ağında olmadığı için veritabanına ulaşamaz:

```bash
docker compose exec nginx ping -c 1 -W 2 db || echo "nginx db'yi göremiyor (beklenen)"
docker compose exec api python -c "import socket; print(socket.gethostbyname('db'))"
```

## Günlük CLI

| Komut | İşlev |
|---|---|
| `docker compose up -d` | Oluştur ve başlat. Tanım değiştiyse **sadece değişen** servisleri yeniden oluşturur |
| `docker compose up -d --build` | Önce `build` tanımlı servisleri yeniden build et |
| `docker compose ps` | Proje konteynerleri ve durumları |
| `docker compose logs -f api` | Bir ya da birden fazla servisin logları (renkli önekle) |
| `docker compose exec db psql -U app siparis` | Çalışan konteynerde komut |
| `docker compose run --rm api python -c "..."` | Servisin tanımıyla **yeni, tek seferlik** bir konteyner |
| `docker compose stop` / `start` / `restart api` | Durdur, başlat, yeniden başlat |
| `docker compose pull` | İmajları güncelle |
| `docker compose top`, `images`, `port nginx 80` | Bilgi |
| `docker compose config` | Değişkenler ve birleştirmeler uygulanmış **son** hâli göster |
| `docker compose down` | Konteynerleri ve ağları sil. **Volume'ler kalır** |
| `docker compose down -v` | Volume'leri de sil (veri gider) |

```bash
docker compose logs --tail 5 api
docker compose exec db psql -U app siparis -c "SELECT count(*) FROM siparis;"
docker compose run --rm api python -c "import flask; print(flask.__version__)"
```

### Değişiklik yapınca

Compose bildirimseldir: dosyayı değiştir, tekrar `up -d` yaz, Compose mevcut durumla istenen durumu karşılaştırıp sadece gerekeni yapar.

```bash
sed -i 's/"-w", "2"/"-w", "3"/' api/Dockerfile
docker compose up -d --build
docker compose ps
docker compose exec api ps aux 2>/dev/null | grep -c gunicorn || docker compose top api
```

Sadece `api` yeniden oluşturuldu. `db`, `redis` ve `nginx` dokunulmadan çalışmaya devam etti.

## Ölçekleme

```bash
docker compose up -d --scale api=3
docker compose ps api
docker compose restart nginx
for i in 1 2 3 4 5 6; do curl -s -X POST localhost:8080/siparis; echo; done
```

`isleyen` alanında farklı konteyner adları görüyorsun. Docker DNS'i `api` adını üç konteynerin IP'lerine çözüyor. nginx ise `upstream` içindeki adları **sadece açılışta** çözer ve sonradan eklenen konteynerleri görmez. Bu yüzden ölçeklemeden sonra nginx'i yeniden başlattık (ya da nginx'te `resolver 127.0.0.11` ile dinamik çözüm). Aynı nedenle ölçeklenen bir servis host'a sabit bir **portla yayınlanamaz**: üç konteyner aynı host portunu alamaz.

```bash
docker compose up -d --scale api=1
```

## Build ayrıntıları

```yaml
  api:
    build:
      context: ./api
      dockerfile: Dockerfile
      target: production        # multi-stage aşaması
      args:
        APP_VERSION: "1.4.0"
    image: registry.ornek.com/siparis-api:1.4.0
```

`build` ve `image` birlikte verilirse, build edilen imaj o adla etiketlenir ve `docker compose push` ile registry'ye gönderilebilir. Sadece `image` verilen servisler build edilmez, çekilir.

```bash
docker compose build --pull     # temel imajları da güncelleyerek build et
docker compose build --no-cache api
```

## Değişkenler ve .env

Compose dosyasında `${DEGISKEN}` ifadeleri, **shell ortamından** ve proje klasöründeki **`.env`** dosyasından doldurulur:

```bash
cat > .env <<'EOF'
NGINX_PORT=8080
API_TAG=dev
EOF
sed -i 's/"127.0.0.1:8080:80"/"127.0.0.1:${NGINX_PORT:-8080}:80"/; s/image: siparis-api:dev/image: siparis-api:${API_TAG:?API_TAG tanımlanmalı}/' compose.yaml
docker compose config | grep -E 'published|siparis-api'
NGINX_PORT=9090 docker compose config | grep published
```

| Yazım | Anlamı |
|---|---|
| `${VAR}` | Değer (tanımsızsa boş + uyarı) |
| `${VAR:-varsayılan}` | Boş/tanımsızsa varsayılan |
| `${VAR:?hata mesajı}` | Boş/tanımsızsa hata ver ve dur |
| `$$` | Kaçış: konteynere `$` olarak geçer |

İki farklı şeyi karıştırma:

- **`.env`** dosyası: Compose dosyasındaki `${...}` ifadelerini doldurur. Konteynere **otomatik geçmez**.
- **`env_file:`** anahtarı: Belirtilen dosyadaki değişkenleri **konteynerin ortamına** koyar.

Öncelik (yüksekten düşüğe): shell ortamı → `.env` → dosyadaki varsayılanlar.

## Geliştirme döngüsü: watch

Geliştirmede kod değişince imajı yeniden build etmek yavaştır. Compose'un `develop.watch` özelliği dosyaları izler:

```yaml
  api:
    build: ./api
    develop:
      watch:
        - action: sync           # değişen dosyaları çalışan konteynere kopyala
          path: ./api
          target: /app
          ignore: [__pycache__]
        - action: rebuild        # bağımlılıklar değişince imajı yeniden build et
          path: ./api/requirements.txt
```

`docker compose watch` (ya da `docker compose up --watch`) ile çalıştırılır. Bind mount'a göre avantajı, Mac ve Windows'taki dosya paylaşım yavaşlığını ve UID sorunlarını yaşamaması.

## Temizlik

```bash
docker compose down
docker volume ls | grep siparis
docker compose down -v
```

İlk `down` sonrası volume'ler duruyor, `-v` ile silindi.

## Alıştırma (lab'da)

1. `compose.yaml`'a `adminer` (veritabanı yönetim arayüzü, `adminer:4` imajı, 8080 portu) adında bir servis ekle. Sadece `arka` ağında olsun ve host'un `127.0.0.1:8081` portuna yayınlansın. Ne oldu? Neden?
2. Sorunu düzelt: adminer hem veritabanına ulaşabilsin hem de host'tan erişilebilsin.
3. `docker compose run --rm db psql ...` ile `docker compose exec db psql ...` arasındaki fark nedir?

<details><summary>Çözüm</summary>

1: `arka` ağı `internal: true` olduğu için Docker o ağdaki konteynerlere **port yayınlamaz**: internal ağın dışarıyla hiçbir bağlantısı yoktur. `curl localhost:8081` cevap vermez.

2: adminer'ı iki ağa da bağla:

```yaml
  adminer:
    image: adminer:4
    ports: ["127.0.0.1:8081:8080"]
    networks: [on, arka]
```

```bash
docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' localhost:8081
```

3: `exec`, **çalışan** `db` konteynerinde yeni bir süreç başlatır. `run`, `db` servisinin tanımıyla (imaj, volume, ağ, ortam) **yeni bir konteyner** oluşturur. `db` için `run` kullanmak, aynı veri klasörünü kullanan **ikinci bir PostgreSQL sunucusu** başlatmaya çalışmak demektir, tehlikelidir. `run` tek seferlik işler (migration, betik, test) içindir.

</details>

```quiz
`docker compose down` sonrası veritabanı verisi ne olur?
- Silinir
- [x] İsimli volume'de durur. Silmek için `down -v` gerekir
- Konteynerle birlikte arşivlenir
? down konteynerleri ve ağları siler, volume'leri korur.
```

```quiz
compose.yaml'daki `${API_TAG}` değerini nereden alır?
- `env_file:` ile verilen dosyadan
- [x] Shell ortamından ya da proje klasöründeki `.env` dosyasından
- Konteynerin ortamından
? `.env` dosyası Compose dosyasındaki ifadeleri doldurur. `env_file:` ise konteynerin ortamına değişken koyar.
```

```quiz
`docker compose up -d` komutunu sadece `api` servisinin tanımını değiştirdikten sonra tekrar çalıştırdın. Ne olur?
- Bütün servisler yeniden oluşturulur
- [x] Sadece `api` (ve ona bağlı değişen servisler) yeniden oluşturulur
- Hiçbir şey, önce `down` gerekir
? Compose mevcut durumu istenen durumla karşılaştırır ve sadece farkları uygular.
```

## Özet

- `docker compose` (v2), `compose.yaml`, en üstte `version:` gerekmez.
- `services`, `networks`, `volumes`, `secrets`. Servis anahtarları `docker run` seçeneklerinin karşılığı.
- Servisler birbirine servis adıyla ulaşır. Kaynaklar proje adıyla önek alır.
- `up -d --build`, `ps`, `logs -f`, `exec`, `run --rm`, `config`, `down` (`-v` veri siler).
- `.env` → `${VAR:-x}`, `${VAR:?}`. `env_file` → konteyner ortamı.
- `--scale`, `build` + `image`, geliştirmede `watch`.
