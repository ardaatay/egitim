# Compose: ortamlar, profiller, sağlık ve bağımlılıklar

Önceki dersteki compose dosyası çalışıyor, ama üretime hazır değil: `depends_on` servislerin **hazır** olmasını beklemiyor, kaynak sınırı ve yeniden başlatma politikası yok, geliştirme ve üretim için ayrı dosyalar yok, veritabanı göçü (migration) bir yerde çalışmıyor. Bu derste aynı uygulamayı tek sunuculu bir üretim ortamında güvenle çalışacak hâle getiriyoruz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Önceki dersin ~/siparis klasörü yoksa o dersteki dosyaları oluşturma bloklarını önce çalıştır.
```

## depends_on gerçekte neyi bekler?

Önceki dersteki `depends_on: [db]` sadece **başlatma sırasını** belirler: `db` konteyneri **başladıktan** hemen sonra `api` başlatılır. PostgreSQL'in bağlantı kabul etmeye hazır olması birkaç saniye sürer. O arada gelen ilk istekler hata alır, uygulama açılışta veritabanına bağlanmaya çalışıyorsa çöker. (Linux kursundaki systemd `After=` dersinin aynısı.)

Çözüm: Servise **healthcheck** ekle ve bağımlılığı **koşullu** yaz:

```yaml
  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d siparis"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  api:
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
      migrate:
        condition: service_completed_successfully
```

| Koşul | Bekler |
|---|---|
| `service_started` | Konteyner başlasın (varsayılan) |
| `service_healthy` | Healthcheck `healthy` olsun |
| `service_completed_successfully` | Konteyner **0 koduyla bitsin** (migration gibi tek seferlik işler) |

Bu bekleme **sadece `docker compose up` sırasında** geçerlidir. Çalışma sırasında veritabanı yeniden başlarsa Compose `api`'yi beklemeye almaz. Uygulama, bağlantı hatalarında **yeniden denemeyi** her durumda bilmelidir.

## Migration: tek seferlik servis

Veritabanı şemasını değiştiren işler uygulamayla birlikte başlamamalı: üç replika aynı anda migration çalıştırmaya çalışır. Ayrı, tek seferlik bir servis olarak tanımla:

```yaml
  migrate:
    image: ${API_IMAGE}
    command: ["python", "migrate.py"]
    environment: *api-env
    secrets: [db_password]
    depends_on:
      db:
        condition: service_healthy
    restart: "no"
    networks: [arka]
```

`up` sırasında `migrate` çalışır ve biter. `api` ancak migration başarıyla bitince başlar. Migration başarısız olursa (sıfır olmayan kod) `api` hiç başlamaz ve `up` hata verir. Bozuk şemayla çalışan bir uygulamadan çok daha iyi.

## Tekrarlayan tanımlar: YAML anchor'ları ve x- alanları

Yukarıdaki `*api-env` bir YAML **anchor** referansı. `x-` ile başlayan üst seviye anahtarları Compose yok sayar. Bunlar ortak parçaları bir kez tanımlamak için kullanılır:

```yaml
x-api-env: &api-env
  DB_HOST: db
  REDIS_HOST: redis
  DB_PASSWORD_FILE: /run/secrets/db_password

x-logging: &logging
  driver: local
  options:
    max-size: "20m"
    max-file: "5"
```

Servislerde `environment: *api-env` ve `logging: *logging` ile kullanılır. Bir haritayı genişleterek kullanmak için `<<: *api-env` yazılır.

## Üretim için servis ayarları

Önceki derslerde öğrendiğin her şeyin Compose karşılığı:

```yaml
  api:
    image: ${API_IMAGE:?API_IMAGE tanımlanmalı}
    restart: unless-stopped
    init: true
    stop_grace_period: 30s
    read_only: true
    tmpfs: [/tmp]
    user: "999:999"
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 15s
    logging: *logging
```

| Anahtar | Ders |
|---|---|
| `restart: unless-stopped` | Yaşam döngüsü: sunucu yeniden başlayınca da ayağa kalkar |
| `init: true` | PID 1 ve sinyaller (`--init`) |
| `stop_grace_period` | `docker stop -t`. gunicorn'un `graceful_timeout`'undan büyük olmalı |
| `read_only` + `tmpfs` | Kök dosya sistemi salt okunur, yazılabilir sadece `/tmp` (güvenlik dersi) |
| `deploy.resources.limits` | `--cpus`, `--memory`. Compose v2 bunları Swarm olmadan da uygular |
| `healthcheck` | İmajda `curl` olmayabilir. Python imajında Python'un kendisiyle kontrol |
| `logging` | Log sürücüsü ve döndürme sınırları |

## Ortamlar: birden fazla dosyayı birleştirmek

Aynı uygulama geliştirmede bind mount, açık portlar ve debug log ile, üretimde sabit imaj etiketi, sınırlar ve sıkı ayarlarla çalışır. Compose bunu **dosya birleştirme** ile çözer.

**`compose.override.yaml` otomatik birleşir.** Proje klasöründe hem `compose.yaml` hem `compose.override.yaml` varsa, `docker compose up` ikisini birleştirir. Yaygın düzen:

```text
compose.yaml            ortak tanım (servisler, ağlar, volume'ler, healthcheck'ler)
compose.override.yaml   geliştirme farkları (build, bind mount, debug) -> otomatik
compose.prod.yaml       üretim farkları (imaj etiketi, sınırlar, restart)
```

```bash
docker compose up -d                                          # compose.yaml + compose.override.yaml
docker compose -f compose.yaml -f compose.prod.yaml up -d     # override YOK, prod var
docker compose -f compose.yaml -f compose.prod.yaml config    # birleşmiş sonucu gör
```

Birleştirme kuralları: Tek değerli alanlar (`image`, `command`) sonraki dosyadakiyle **değiştirilir**. Listeler ve haritalar (`ports`, `environment`, `volumes`) genelde **birleştirilir**. Bir listeyi tamamen değiştirmek için `!override`, bir alanı kaldırmak için `!reset` etiketleri kullanılır:

```yaml
services:
  nginx:
    ports: !override
      - "80:80"
      - "443:443"
```

Ne olduğundan emin olmak için her zaman `docker compose config` ile birleşmiş sonuca bak.

Alternatif olarak **`include`** ile başka compose dosyalarını (örneğin ayrı bir ekip tarafından yönetilen izleme yığınını) projeye dahil edebilir, **`extends`** ile bir servisi başka bir servisin tanımından türetebilirsin.

## Profiller

Her zaman çalışması gerekmeyen servisleri (yönetim arayüzleri, hata ayıklama araçları, yük testleri) **profil** arkasına koy:

```yaml
  adminer:
    image: adminer:4
    profiles: [araclar]
    ports: ["127.0.0.1:8081:8080"]
    networks: [on, arka]
```

```bash
docker compose up -d                       # adminer başlamaz
docker compose --profile araclar up -d     # adminer de başlar
COMPOSE_PROFILES=araclar docker compose ps
```

Profili olmayan servisler her zaman çalışır.

## Hepsini birleştirelim

Önceki dersin klasöründe dosyaları üretim düzenine çevirelim. Önce basit bir migration betiği ve imaja healthcheck için hiçbir şey eklemeye gerek yok (Python var):

```bash
cd ~/siparis
cat > api/migrate.py <<'EOF'
import os, time, psycopg
pw = open(os.environ["DB_PASSWORD_FILE"]).read().strip()
with psycopg.connect(host=os.environ["DB_HOST"], user="app", password=pw, dbname="siparis") as c:
    c.execute("CREATE TABLE IF NOT EXISTS siparis(id serial primary key, no int, kim text)")
    c.execute("CREATE INDEX IF NOT EXISTS siparis_no ON siparis(no)")
print("migration tamam")
EOF
docker compose down -v 2>/dev/null
docker build -q -t siparis-api:1.0.0 ./api
```

Ortak dosya:

```bash
cat > compose.yaml <<'EOF'
name: siparis

x-api-env: &api-env
  DB_HOST: db
  REDIS_HOST: redis
  DB_PASSWORD_FILE: /run/secrets/db_password

x-logging: &logging
  driver: local
  options: { max-size: "20m", max-file: "5" }

services:
  nginx:
    image: nginx:1.27-alpine
    volumes: ["./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro"]
    depends_on:
      api: { condition: service_healthy }
    networks: [on]
    logging: *logging

  api:
    image: ${API_IMAGE:-siparis-api:dev}
    environment: *api-env
    secrets: [db_password]
    init: true
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_started }
      migrate: { condition: service_completed_successfully }
    networks: [on, arka]
    logging: *logging

  migrate:
    image: ${API_IMAGE:-siparis-api:dev}
    command: ["python", "migrate.py"]
    environment: *api-env
    secrets: [db_password]
    depends_on:
      db: { condition: service_healthy }
    restart: "no"
    networks: [arka]

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: siparis
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d siparis"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [arka]
    logging: *logging

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: [redisdata:/data]
    networks: [arka]
    logging: *logging

  adminer:
    image: adminer:4
    profiles: [araclar]
    ports: ["127.0.0.1:8081:8080"]
    networks: [on, arka]

networks:
  on:
  arka: { internal: true }

volumes:
  pgdata:
  redisdata:

secrets:
  db_password:
    file: ./secrets/db_password
EOF
```

Geliştirme farkları (otomatik birleşir):

```bash
cat > compose.override.yaml <<'EOF'
services:
  nginx:
    ports: ["127.0.0.1:8080:80"]
  api:
    build: ./api
    environment:
      FLASK_DEBUG: "1"
EOF
```

Üretim farkları:

```bash
cat > compose.prod.yaml <<'EOF'
services:
  nginx:
    ports: ["80:80"]
    restart: unless-stopped
  api:
    image: ${API_IMAGE:?üretimde API_IMAGE açıkça verilmeli}
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 512M }
  db:
    restart: unless-stopped
    deploy:
      resources:
        limits: { memory: 1G }
  redis:
    restart: unless-stopped
EOF
```

Geliştirme ortamı ile başlat ve başlama sırasını izle:

```bash
docker compose up -d --build --wait
docker compose ps -a
docker compose logs migrate
curl -s -X POST localhost:8080/siparis; echo
```

`--wait`, bütün servisler `healthy` (ya da `running`) olana kadar bekler ve başarısız olursa hata koduyla döner. Deploy betiklerinde çok değerlidir. `ps -a` çıktısında `migrate` servisi `Exited (0)`: işini bitirip çıktı.

Şimdi üretim birleşimini gör ve çalıştır:

```bash
docker compose -f compose.yaml -f compose.prod.yaml config 2>&1 | head -3
API_IMAGE=siparis-api:1.0.0 docker compose -f compose.yaml -f compose.prod.yaml config | grep -A3 -E '^  api:' | head -5
docker compose down
API_IMAGE=siparis-api:1.0.0 docker compose -f compose.yaml -f compose.prod.yaml up -d --wait
docker compose ps
docker inspect siparis-api-1 --format 'readonly={{.HostConfig.ReadonlyRootfs}} mem={{.HostConfig.Memory}} restart={{.HostConfig.RestartPolicy.Name}}'
```

İlk komut `API_IMAGE` verilmediği için hata verdi (`:?` sayesinde). Üretimde yanlışlıkla `dev` imajıyla deploy etmek mümkün değil.

## Tek sunucuda deploy akışı

Compose, tek sunuculu üretim için pratik bir araç. Linux kursundaki deploy betiğinin Compose karşılığı:

```bash
export API_IMAGE=registry.ornek.com/siparis-api:4f9c2e1     # CI'ın ürettiği değişmez etiket
docker compose -f compose.yaml -f compose.prod.yaml pull
docker compose -f compose.yaml -f compose.prod.yaml up -d --wait --remove-orphans
docker image prune -f
```

- `pull` önce yeni imajları indirir. İndirme sırasında eski sürüm çalışmaya devam eder.
- `up -d` sadece imajı değişen servisleri yeniden oluşturur.
- `--wait` sağlık kontrollerini bekler. Başarısızsa betik hata verir ve önceki `API_IMAGE` ile tekrar `up` yapılarak **geri alınır**.
- `--remove-orphans`: compose dosyasından kaldırılmış servislerin konteynerlerini siler.

Sınırlar: Compose bir servisi yeniden oluştururken eski konteyneri durdurup yenisini başlatır. Arada **kısa bir kesinti** olur (Linux kursundaki `restart` boşluğu). Sıfır kesinti gerekiyorsa iki replika ve nginx'in yeniden denemesi, ya da rolling update yapan bir orkestratör gerekir: bir sonraki bölümde **Swarm**.

## Alıştırma (lab'da)

1. `migrate.py`'yi bilerek boz (örneğin ilk satıra `raise SystemExit(1)` ekle), imajı yeniden build edip `docker compose up -d --build --wait` çalıştır. `api` başladı mı? `up`'ın çıkış kodu ne?
2. Profil olmadan ve `--profile araclar` ile `docker compose config --services` çıktılarını karşılaştır.

<details><summary>Çözüm</summary>

```bash
cd ~/siparis
docker compose down
sed -i '1i raise SystemExit(1)' api/migrate.py
docker compose up -d --build --wait; echo "çıkış kodu: $?"
docker compose ps -a
docker compose logs migrate | tail -3
sed -i '1d' api/migrate.py
docker compose up -d --build --wait; echo "çıkış kodu: $?"

docker compose config --services
docker compose --profile araclar config --services
docker compose down -v
```

1: `migrate` `Exited (1)`, `api` ve dolayısıyla ona bağlı `nginx` **oluşturuldu ama başlatılmadı** (`Created`), `up` sıfır olmayan kodla döndü. Bozuk şemayla çalışan bir uygulama yerine, deploy başarısız oldu. Düzeltip tekrar `up` yapınca her şey sırayla ayağa kalktı.

2: Profil verilmeden `adminer` listede yok.

</details>

```quiz
`depends_on: [db]` (koşulsuz) ne garanti eder?
- PostgreSQL bağlantı kabul etmeye hazır olur
- [x] Sadece `db` konteynerinin `api`'den önce başlatıldığını
- `db` çökerse `api` de durdurulur
? Hazır olmayı beklemek için healthcheck ve `condition: service_healthy` gerekir.
```

```quiz
`compose.yaml` ve `compose.override.yaml` var. `docker compose -f compose.yaml -f compose.prod.yaml up -d` hangi dosyaları kullanır?
- Üçünü de
- [x] Sadece compose.yaml ve compose.prod.yaml
- Sadece compose.prod.yaml
? `-f` verildiğinde override dosyası otomatik eklenmez.
```

```quiz
Migration'ı uygulamayla aynı konteynerin açılışında değil ayrı bir servis olarak çalıştırmanın en önemli faydası?
- Daha hızlı çalışır
- [x] Replikalar aynı anda migration çalıştırmaz ve migration başarısızsa uygulama hiç başlamaz
- Daha az bellek kullanır
? `service_completed_successfully` koşulu uygulamayı başarılı migration'a bağlar.
```

## Özet

- `depends_on` + `condition: service_healthy / service_completed_successfully`. Uygulama yine de yeniden denemeyi bilmeli.
- Migration ayrı, tek seferlik servis.
- `x-` alanları ve YAML anchor'ları ile tekrar yok.
- `restart`, `init`, `stop_grace_period`, `read_only`, `deploy.resources`, `healthcheck`, `logging`.
- `compose.yaml` + otomatik `compose.override.yaml` (geliştirme), `-f compose.prod.yaml` (üretim). Sonucu `config` ile gör.
- Profiller isteğe bağlı servisler için. Deploy: `pull` + `up -d --wait --remove-orphans`.
