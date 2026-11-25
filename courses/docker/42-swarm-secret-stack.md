# Secret, config ve stack ile uygulama dağıtımı

Önceki derste servisleri tek tek komutlarla oluşturduk. Gerçek bir uygulamada bu, Compose öncesi günlerin uzun `docker run` komutlarına dönmek demek. Swarm'ın cevabı **stack**: Compose dosyasını alıp bütün servisleri, ağları, secret'ları ve config'leri kümeye tek komutla dağıtır. Bu derste önce Swarm'ın gizli bilgi ve yapılandırma yönetimini, sonra Compose dersindeki sipariş uygulamasını stack olarak kümeye dağıtmayı göreceğiz.

```lab
Play with Docker
https://labs.play-with-docker.com/
3 node'lu küme (önceki dersler). Tek node'lu bir Swarm da (docker swarm init) bu ders için yeterli.
```

## Secret'lar

Ortam değişkenleri dersinde gizli bilgilerin neden ortam değişkeninde olmaması gerektiğini, Compose dersinde ise Swarm'sız Compose'un secret'ları basit bir bind mount olarak bağladığını görmüştük. Swarm'da secret'lar gerçek bir gizli bilgi yönetimiyle gelir:

- Manager'larda Raft günlüğünde **şifreli** saklanır (autolock ile anahtar da korunabilir).
- Sadece secret'a erişim verilmiş servislerin task'larına, **sadece o task'ların çalıştığı node'lara** ve şifreli kanal üzerinden gönderilir.
- Konteynerde `/run/secrets/<ad>` altında **bellekte (tmpfs)** bir dosya olarak görünür. Diske yazılmaz.
- `docker inspect`, `docker service inspect` ya da `docker secret inspect` ile **değeri görülemez**.

```bash
printf 'cok-gizli-parola' | docker secret create db_password -
openssl rand -base64 32 | docker secret create api_key -
docker secret ls
docker secret inspect db_password --pretty
```

`-` stdin'den okur. Değeri komut satırına yazmamak (kabuk geçmişine düşmesin) için bir dosyadan ya da borudan ver.

Bir servise ver:

```bash
docker service create --name gizli-deneme \
  --secret db_password \
  --secret source=api_key,target=api.key,uid=1000,gid=1000,mode=0400 \
  alpine sh -c 'ls -l /run/secrets; cat /run/secrets/db_password; echo; mount | grep secrets; sleep 1d'
sleep 5
docker service logs gizli-deneme
docker service inspect gizli-deneme --format '{{json .Spec.TaskTemplate.ContainerSpec.Secrets}}'
docker service rm gizli-deneme
```

- `target` ile konteynerdeki dosya adı, `uid`/`gid`/`mode` ile sahiplik ve izin ayarlanır. Compose'daki 644 sorunu burada yok: dosya sadece uygulamanın kullanıcısına okunabilir yapılabilir.
- `mount` çıktısında `tmpfs`: secret diske yazılmıyor.
- `service inspect` sadece secret'ın **adını ve kimliğini** gösteriyor, değerini değil.

### Secret'lar değiştirilemez: döndürme

Bir secret oluşturulduktan sonra **değiştirilemez**. Parola değiştirmek (rotation) için yeni adla yeni bir secret oluşturulur ve servis güncellenir:

```bash
printf 'yeni-parola-2' | docker secret create db_password_v2 -
docker service create --name kullanan --secret source=db_password,target=db_password alpine sh -c 'cat /run/secrets/db_password; echo; sleep 1d'
docker service update --secret-rm db_password --secret-add source=db_password_v2,target=db_password kullanan
sleep 5
docker service logs kullanan --tail 2
docker service rm kullanan
docker secret rm db_password
```

`target` aynı kaldığı için uygulama aynı dosya yolunu okumaya devam eder. Güncelleme bir rolling update olarak yapılır: yeni task'lar yeni secret'la başlar. Eski secret, onu kullanan servis kalmayınca silinebilir. Kullanılan bir secret'ı silmeye çalışmak hata verir. (Veritabanı parolası gibi iki tarafı olan secret'larda, önce veritabanında yeni parolayı geçerli yapıp sonra uygulamayı güncellemek gerekir.)

## Config'ler

Secret'ların gizli olmayan kardeşi: ayar dosyaları. Aynı şekilde kümede saklanır ve dosya olarak bağlanır, ama şifrelenmez ve tmpfs'te değildir:

```bash
cat > nginx.conf <<'EOF'
server {
    listen 80;
    location /health { return 200 "ok\n"; }
    location / { return 200 "config ile geldim\n"; }
}
EOF
docker config create nginx_v1 nginx.conf
docker service create --name cfg-web --publish 8095:80 \
  --config source=nginx_v1,target=/etc/nginx/conf.d/default.conf \
  nginx:1.27-alpine
sleep 5; curl -s localhost:8095
docker config inspect nginx_v1 --pretty | tail -8
docker service rm cfg-web
```

Bind mount'tan farkı: Dosya **her node'da** hazır. Task hangi node'a yerleşirse yerleşsin aynı içeriği bulur. Değiştirmek için secret'lardaki gibi yeni sürümlü bir config (`nginx_v2`) oluşturulup servis güncellenir.

## Stack: Compose dosyasıyla kümeye dağıtım

`docker stack deploy`, bir Compose dosyasını okur ve içindeki her şeyi Swarm nesnelerine çevirir: servisler, overlay ağlar, volume'ler, secret'lar, config'ler. Compose dosyasındaki **`deploy`** anahtarı, Swarm'a özgü ayarları taşır.

Compose dersindeki sipariş uygulamasını kümeye taşıyalım. Swarm kümesi imajı build etmez: her node'un imajı **bir registry'den çekebilmesi** gerekir. Önce kümede yerel bir registry çalıştırıp API imajını oraya gönderelim:

```bash
docker service create --name registry --publish 5000:5000 registry:2
mkdir -p ~/siparis-stack/api && cd ~/siparis-stack
cat > api/app.py <<'EOF'
import os, socket
import psycopg, redis
from flask import Flask, jsonify
app = Flask(__name__)
r = redis.Redis(host=os.environ["REDIS_HOST"], port=6379)
def db():
    return psycopg.connect(host=os.environ["DB_HOST"], user="app",
        password=open(os.environ["DB_PASSWORD_FILE"]).read().strip(), dbname="siparis")
@app.get("/health")
def health():
    return jsonify(durum="ok", konteyner=socket.gethostname(), surum=os.getenv("SURUM", "1"))
@app.post("/siparis")
def siparis():
    n = r.incr("sayac")
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS siparis(id serial primary key, no int, kim text)")
        c.execute("INSERT INTO siparis(no, kim) VALUES (%s, %s)", (n, socket.gethostname()))
    return jsonify(no=n, isleyen=socket.gethostname())
EOF
printf 'flask==3.0.3\ngunicorn==22.0.0\nredis==5.0.8\npsycopg[binary]==3.2.3\n' > api/requirements.txt
cat > api/Dockerfile <<'EOF'
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN useradd --system --uid 999 --no-create-home app
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
USER app
CMD ["gunicorn", "-b", "0.0.0.0:8000", "-w", "2", "--access-logfile", "-", "app:app"]
EOF
sleep 5
docker build -q -t 127.0.0.1:5000/siparis-api:1.0.0 ./api
docker push -q 127.0.0.1:5000/siparis-api:1.0.0
```

(`127.0.0.1:5000` her node'da routing mesh sayesinde aynı registry servisine ulaşır. Docker, `127.0.0.1` için TLS istemez. Gerçek kümede bunun yerine TLS'li bir registry kullanılır.)

Stack dosyası:

```bash
printf 'stack-parolasi' | docker secret create siparis_db_password_v1 -
cat > stack.yaml <<'EOF'
services:
  api:
    image: 127.0.0.1:5000/siparis-api:${API_TAG:-1.0.0}
    environment:
      DB_HOST: db
      REDIS_HOST: redis
      DB_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - source: db_password
        target: db_password
        uid: "999"
        mode: 0400
    ports:
      - "8080:8000"
    networks: [on, arka]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
      interval: 5s
      timeout: 3s
      retries: 3
      start_period: 10s
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 5s
        order: start-first
        failure_action: rollback
        monitor: 15s
      rollback_config:
        order: start-first
      restart_policy:
        condition: any
        delay: 3s
      resources:
        limits: { cpus: "0.5", memory: 256M }
        reservations: { memory: 64M }

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: siparis
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - source: db_password
        target: db_password
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [arka]
    deploy:
      replicas: 1
      placement:
        constraints: [node.role == manager]

  redis:
    image: redis:7-alpine
    networks: [arka]
    deploy:
      replicas: 1

networks:
  on:
    driver: overlay
  arka:
    driver: overlay
    internal: true

volumes:
  pgdata:

secrets:
  db_password:
    external: true
    name: siparis_db_password_v1
EOF
docker stack deploy -c stack.yaml siparis
```

Öne çıkanlar:

- **`deploy`** bloğu: replikalar, rolling update ve rollback ayarları, yeniden başlatma politikası, kaynak sınırları ve rezervasyonlar, yerleşim kısıtları. Önceki dersteki `docker service create` seçeneklerinin birebir karşılığı.
- **`secrets: external: true`**: Secret stack dışında, önceden (`docker secret create`) oluşturuldu. Böylece gizli değer hiçbir dosyada durmaz ve secret'ın sürümünü (`_v1`) ad üzerinden yönetebiliriz.
- **`db` için `placement`**: Veritabanı tek bir node'a (burada manager'lardan birine) sabitlenmeli, yoksa yerel volume'ü başka node'a taşınmaz. Çok node'lu üretimde `node.hostname == ...` ya da bir node etiketiyle **tek** bir node'a sabitle.

### Stack'i izlemek

```bash
docker stack ls
docker stack services siparis
docker stack ps siparis --filter desired-state=running
sleep 20
for i in 1 2 3 4 5; do curl -s -X POST localhost:8080/siparis; echo; done
```

Kaynaklar stack adıyla önek alır: `siparis_api`, `siparis_arka`. İstekler `isleyen` alanında farklı task'lara dağıldı.

### Güncelleme

Stack'i güncellemek için aynı komutu tekrar çalıştırırsın. Swarm sadece değişen servisleri günceller ve her biri için `update_config`'teki rolling update'i uygular:

```bash
sed -i 's/surum=os.getenv("SURUM", "1")/surum=os.getenv("SURUM", "2")/' api/app.py
docker build -q -t 127.0.0.1:5000/siparis-api:1.1.0 ./api && docker push -q 127.0.0.1:5000/siparis-api:1.1.0
(for i in $(seq 1 60); do curl -s localhost:8080/health | grep -o '"surum":"[0-9]"'; sleep 0.5; done) | uniq -c &
API_TAG=1.1.0 docker stack deploy -c stack.yaml siparis
wait
docker stack ps siparis --filter name=siparis_api | head -8
```

Çıktıda yanıtların kesintisiz şekilde `"surum":"1"`'den `"surum":"2"`'ye geçtiğini görürsün.

### Stack'te farklı davranan Compose özellikleri

`docker stack deploy` Compose dosyasının her özelliğini desteklemez. Desteklenmeyenler **sessizce yok sayılır** (ya da bir uyarı basılır):

| Compose özelliği | Stack'te |
|---|---|
| `build` | **Yok sayılır.** İmaj önceden build edilip registry'ye gönderilmeli |
| `depends_on` | Yok sayılır: servisler sırasız başlar. Uygulama bağımlılıklarını yeniden denemeli |
| `container_name` | Yok sayılır (replikalar olabileceği için) |
| `restart` | Yerine `deploy.restart_policy` |
| `profiles`, `develop.watch` | Yok |
| `.env` / `${VAR}` | Desteklenir, ama `.env` dosyası otomatik okunmaz. Değişkenler shell ortamından gelir |
| Göreli bind mount (`./x:/y`) | Her node'da aynı yol olmalı. Config'ler tercih edilir |

Yeni Docker sürümlerinde stack dosyasının bu kısıtlarını ve Compose spesifikasyonunu destekleme durumu değişebiliyor. Deploy öncesi `docker stack config -c stack.yaml` ile Swarm'ın dosyayı nasıl yorumladığını görebilirsin.

### Kaldırmak

```bash
docker stack rm siparis
docker service rm registry
docker volume ls
```

`stack rm` servisleri, ağları ve stack'in oluşturduğu secret/config'leri siler. **Volume'ler kalır** (her node'da ayrı ayrı). External secret'lar da kalır.

## Swarm'ın yeri

Bu bölümde Swarm ile şunları yaptık: çok node'lu bir küme kurduk, manager kaybına dayanıklılığı gördük, servisleri ölçekledik ve yerleştirdik, kesintisiz rolling update ve otomatik geri alma yaptık, şifreli secret'lar kullandık ve bütün uygulamayı tek bir Compose dosyasıyla dağıttık.

Kubernetes aynı kavramları daha genel ve genişletilebilir nesnelerle sunar: Pod (birlikte çalışan konteynerler), Deployment (rolling update), Service (VIP ve DNS), Ingress, Secret/ConfigMap, PersistentVolume (durumlu servisler için çözülmüş bir depolama modeli), otomatik ölçekleme. Kubernetes kursuna geçtiğinde Swarm'daki bu karşılıkları hatırlamak işini kolaylaştıracak.

## Alıştırma (lab'da)

1. `siparis_db_password_v2` adında yeni bir secret oluştur ve stack dosyasını bu secret'ı kullanacak şekilde güncelleyip yeniden deploy et. (Dikkat: PostgreSQL parolayı sadece veritabanı **ilk oluşturulurken** okur. Var olan bir veritabanında parolayı da değiştirmen gerekir.) Hangi sırayla yapmalısın?
2. Stack'te `api` için `deploy.placement.max_replicas_per_node: 1` ekle ve replikayı 4'e çıkar. 3 node'lu kümede ne olur?

<details><summary>Çözüm</summary>

1: Sıra önemli, yoksa uygulama eski parolayla bağlanamaz:

```bash
printf 'yeni-stack-parolasi' | docker secret create siparis_db_password_v2 -
docker exec $(docker ps -q -f name=siparis_db) psql -U app -d siparis -c "ALTER USER app PASSWORD 'yeni-stack-parolasi';"
sed -i 's/name: siparis_db_password_v1/name: siparis_db_password_v2/' stack.yaml
docker stack deploy -c stack.yaml siparis
docker stack ps siparis --filter desired-state=running
```

(`docker exec` komutunu `db` task'ının çalıştığı node'da çalıştırmalısın.) Önce veritabanında parolayı değiştir, sonra uygulamayı yeni secret'la güncelle. Arada kısa bir süre eski task'lar eski parolayla yeni bağlantı açamaz. Kesintisiz rotation için uygulamanın bağlantı havuzunun zaten açık bağlantıları kullanmaya devam etmesi ya da veritabanında geçici olarak iki kullanıcı/parola tutulması gerekir.

2: Her node'a en fazla 1 replika konabildiği için 3 task çalışır, 4. task `Pending` kalır ve hata sütununda "max replicas per node limit exceed" benzeri bir mesaj görünür. Bu ayar, bir node'un kaybında servisin birden fazla replikasının birden gitmesini engellemek için kullanılır.

</details>

```quiz
Swarm secret'ı konteynerde nerede ve nasıl durur?
- Ortam değişkeni olarak
- Diskteki bir dosyada
- [x] `/run/secrets/<ad>` altında, bellekte (tmpfs) bir dosya olarak
? Secret'lar diske yazılmaz ve sadece erişimi olan servislerin task'larına gönderilir.
```

```quiz
Bir Swarm secret'ının değerini değiştirmek için ne yapılır?
- `docker secret update`
- [x] Yeni adla yeni bir secret oluşturup servisi `--secret-rm` / `--secret-add` ile güncellemek (aynı `target` ile)
- Secret dosyasını /run/secrets altında düzenlemek
? Secret'lar değiştirilemez. Sürümlü adlar (`_v2`) ve aynı hedef yol ile döndürülür.
```

```quiz
`docker stack deploy` sırasında Compose dosyasındaki `build:` bölümüne ne olur?
- İmaj her node'da build edilir
- İmaj manager'da build edilip dağıtılır
- [x] Yok sayılır, imajın bir registry'de hazır olması gerekir
? Swarm build yapmaz. Her node imajı registry'den çeker.
```

## Özet

- Secret: Raft'ta şifreli, sadece ilgili task'lara, `/run/secrets` altında tmpfs. `uid/gid/mode` ayarlanabilir. Değiştirilemez, sürümlü adla döndürülür.
- Config: gizli olmayan ayar dosyaları, her node'da hazır.
- Stack: Compose dosyası + `deploy` bloğu → `docker stack deploy -c dosya ad`. Güncelleme aynı komutla, rolling update ile.
- Stack'te `build`, `depends_on`, `container_name` yok. İmajlar registry'den, bağımlılıklar uygulamada yeniden denemeyle.
- Durumlu servisleri tek node'a sabitle. Volume'ler `stack rm` sonrası kalır.
