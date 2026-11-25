# Dockerfile yazmak ve build önbelleği

Çalışan bir Dockerfile yazmak kolay. **İyi** bir Dockerfile ise hızlı build olur (önbelleği doğru kullanır), küçük ve tekrarlanabilir bir imaj üretir, sinyalleri doğru iletir ve root olarak çalışmaz. Bu derste talimatları tek tek, ardından önbelleğin nasıl çalıştığını ve en sık yapılan hataları göreceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## Örnek uygulama

Linux kursundaki Flask uygulamasının sade bir hâli:

```bash
mkdir -p ~/odeme && cd ~/odeme
cat > app.py <<'EOF'
import os, signal, sys
from flask import Flask, jsonify
app = Flask(__name__)

@app.get("/health")
def health():
    return jsonify(durum="ok", surum=os.getenv("APP_VERSION", "dev"), pid=os.getpid())
EOF
cat > requirements.txt <<'EOF'
flask==3.0.3
gunicorn==22.0.0
EOF
```

## İlk (kötü) Dockerfile

Önce internette sık görülen, çalışan ama sorunlu bir sürüm:

```bash
cat > Dockerfile.kotu <<'EOF'
FROM python
COPY . /app
WORKDIR /app
RUN pip install -r requirements.txt
EXPOSE 8000
CMD gunicorn -b 0.0.0.0:8000 app:app
EOF
time docker build -q -f Dockerfile.kotu -t odeme:kotu .
docker images odeme
```

Çalışıyor, ama:

1. `FROM python`: etiketsiz, yani `latest`. Bugün Python 3.13, yarın 3.14. Tam (slim olmayan) imaj yaklaşık 1 GB.
2. `COPY . /app` bağımlılık kurulumundan **önce**: koddaki her değişiklik `pip install`'ı yeniden çalıştırır (aşağıda önbellek).
3. `.dockerignore` yok: `.git`, yerel venv, `.env` gibi dosyalar imaja girer.
4. `CMD` **kabuk biçiminde**: gunicorn `/bin/sh -c`'nin çocuğu olarak çalışır, PID 1 kabuk olur ve SIGTERM gunicorn'a ulaşmaz.
5. Root olarak çalışıyor.

Kod değişikliğinin build süresine etkisini gör:

```bash
echo "# değişiklik" >> app.py
time docker build -q -f Dockerfile.kotu -t odeme:kotu .
```

Tek satırlık değişiklik için bütün bağımlılıklar yeniden kuruldu.

## Talimatlar

| Talimat | İşlevi | Katman üretir mi? |
|---|---|---|
| `FROM imaj:etiket [AS ad]` | Temel imaj. Her aşama bununla başlar | Temel imajın katmanları |
| `RUN komut` | Build sırasında komut çalıştırır | Evet |
| `COPY kaynak hedef` | Build bağlamından dosya kopyalar | Evet |
| `ADD` | `COPY` + URL indirme + arşiv açma. Beklenmedik davranışları yüzünden **`COPY` tercih edilir** | Evet |
| `WORKDIR /yol` | Sonraki talimatların ve konteynerin çalışma klasörü (yoksa oluşturur) | Klasörü oluşturur |
| `ENV KEY=val` | Build'de ve çalışma zamanında geçerli ortam değişkeni | Hayır (config) |
| `ARG ad=varsayılan` | Sadece **build sırasında** geçerli değişken (`--build-arg`) | Hayır |
| `USER kullanici` | Sonraki `RUN`'lar ve konteyner bu kullanıcıyla çalışır | Hayır |
| `EXPOSE 8000` | Belgeleme amaçlı. Portu **yayınlamaz** | Hayır |
| `ENTRYPOINT`, `CMD` | Konteynerin çalıştıracağı komut (aşağıda) | Hayır |
| `HEALTHCHECK` | Sağlık kontrolü komutu (kaynak ve sinyaller dersi) | Hayır |
| `LABEL k=v` | Meta veri (sürüm, kaynak deposu) | Hayır |

> `ARG` ile gizli bilgi (token, parola) geçirme: değerler `docker history` ile görülebilir ve imajda kalır. Gizli bilgiler için BuildKit `--secret` kullanılır (bir sonraki ders).

### ADD ve COPY farkı

İkisi de build bağlamından imaja dosya kopyalar. `ADD`'in iki ek davranışı var:

```dockerfile
COPY app.tar.gz /opt/            # arşiv olduğu gibi kopyalanır
ADD  app.tar.gz /opt/            # yerel tar arşivi otomatik AÇILIR
ADD  https://ornek.com/x.bin /opt/   # URL'den indirir
```

Bu "sihirli" davranışlar sürprize yol açar: bir `.tar.gz` dosyasını olduğu gibi kopyalamak isterken açılmış hâlini bulursun. URL'den indirmede ise dosya her build'de kontrol edilir ve indirilen dosyanın bütünlüğü (sağlama toplamı) varsayılan olarak doğrulanmaz. Kural: **her zaman `COPY`.** İndirme gerekiyorsa `RUN curl ... && sha256sum -c` ile, açma gerekiyorsa `RUN tar` ile açıkça yap. (Yeni BuildKit sürümlerinde `ADD --checksum=sha256:... https://...` ile doğrulama ve `ADD git@...` ile git deposu ekleme gibi kullanımlar da var. Bunları bilinçli olarak tercih ediyorsan uygundur.)

### ARG: build zamanı değişkenleri

`ARG`, build sırasında dışarıdan değer almayı sağlar:

```dockerfile
ARG PYTHON_VERSION=3.12
FROM python:${PYTHON_VERSION}-slim

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$APP_VERSION       org.opencontainers.image.revision=$GIT_SHA
ENV APP_VERSION=$APP_VERSION
```

```bash
docker build --build-arg PYTHON_VERSION=3.13 --build-arg APP_VERSION=1.4.0 --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t odeme:1.4.0 .
```

Bilinmesi gereken kurallar:

- **`FROM`'dan önceki `ARG`** sadece `FROM` satırında kullanılabilir. Aşamanın içinde de kullanmak için `FROM`'dan sonra değer vermeden yeniden bildirilir: `ARG PYTHON_VERSION`.
- `ARG` **sadece build sırasında** vardır, çalışan konteynerde yoktur. Değerin çalışma zamanında da gerekmesi için yukarıdaki gibi `ENV APP_VERSION=$APP_VERSION` ile aktarılır.
- Bir `ARG`'nin değeri değişince, onu kullanan ilk talimattan itibaren önbellek bozulur. Sık değişen `GIT_SHA` gibi değerleri Dockerfile'ın **sonuna yakın** bildir, yoksa her commit'te bağımlılık kurulumu da yeniden çalışır.
- Gizli bilgiler için `ARG` kullanma (aşağıdaki not ve bir sonraki dersteki `--secret`).

### CMD ve ENTRYPOINT

İki biçim vardır ve fark önemlidir:

```dockerfile
CMD gunicorn -b 0.0.0.0:8000 app:app          # kabuk biçimi: /bin/sh -c "gunicorn ..."
CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:app"]   # exec biçimi: doğrudan gunicorn
```

**Exec biçiminde** (JSON dizisi) uygulama doğrudan PID 1 olur ve `docker stop`'un SIGTERM'ini kendisi alır. **Kabuk biçiminde** PID 1 `sh` olur. `sh` sinyali çocuğuna iletmez, `docker stop` 10 saniye bekler ve SIGKILL ile öldürür. Açık istekler yarıda kesilir. **Her zaman exec biçimini kullan.**

`ENTRYPOINT` ile `CMD` birlikte:

- `ENTRYPOINT`: her zaman çalışan komut.
- `CMD`: `ENTRYPOINT`'e varsayılan **argümanlar** (ya da `ENTRYPOINT` yoksa komutun tamamı).
- `docker run imaj X Y` → `CMD`'yi `X Y` ile değiştirir. `ENTRYPOINT`'i değiştirmek için `--entrypoint`.

```dockerfile
ENTRYPOINT ["gunicorn", "-c", "gunicorn.conf.py"]
CMD ["app:app"]
```

Sık görülen bir kalıp, başlangıçta hazırlık yapan bir giriş betiği:

```bash
#!/bin/sh
set -eu
# ...hazırlık: ayar dosyası üret, migration bekle...
exec "$@"
```

Sondaki **`exec "$@"`** kritik: betik kendini CMD'deki komutla değiştirir, böylece uygulama PID 1 olur ve sinyalleri alır. `exec` olmadan betik PID 1 olarak kalır ve aynı sinyal sorunu yaşanır.

## Önbellek nasıl çalışır?

BuildKit her talimatı sırayla değerlendirir ve şu soruyu sorar: **"Bu talimatı, aynı girdilerle daha önce çalıştırdım mı?"**

- `RUN` için girdi: talimat metni + önceki katman.
- `COPY`/`ADD` için girdi: talimat metni + önceki katman + **kopyalanan dosyaların içeriğinin özeti**.

Bir talimatın önbelleği bozulursa, **ondan sonraki bütün talimatlar** yeniden çalışır. Bu yüzden Dockerfile'ı **en az değişenden en çok değişene** doğru sıralarız:

```text
FROM python:3.12-slim                ← neredeyse hiç değişmez
apt-get install sistem paketleri     ← nadiren
COPY requirements.txt                ← bağımlılık değişince
RUN pip install                      ← bağımlılık değişince
COPY . .                             ← her commit'te
```

> `RUN apt-get update` gibi bir talimat, metni değişmediği sürece önbellekten gelir, yani paket listesi haftalar önceki hâliyle kalabilir. `apt-get update` ile `install`'u **aynı `RUN`**'da yazmak, eski bir paket listesiyle olmayan bir sürümü kurmaya çalışma sorununu önler. Taze bir build gerektiğinde `docker build --no-cache` (ya da `--pull` ile temel imajı da güncelle).

### RUN içinde &&, ; ve satır bölme
Bir `RUN` talimatı, **son komutun** çıkış koduna göre başarılı ya da başarısız sayılır (`/bin/sh -c` ile çalışır). Komutları bağlama biçimi bu yüzden önemli (Linux kursu, akışlar dersi):

```dockerfile
RUN apt-get update ; apt-get install -y curl    # update başarısız olsa da devam eder
RUN apt-get update && apt-get install -y curl   # update başarısız olursa build durur
RUN curl -fsSL https://ornek.com/kur.sh | sh    # curl başarısız olsa bile sh boş girdiyle başarılı çıkabilir
```

Kural: komutları **`&&`** ile bağla, uzun satırları `\` ile böl. Borulu komutlarda hatanın yutulmaması için Dockerfile'da kabuğu değiştir: `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` (imajda bash varsa).

## İyi Dockerfile

```bash
cat > .dockerignore <<'EOF'
.git
.gitignore
**/__pycache__
*.pyc
.venv
.env
Dockerfile*
.dockerignore
*.md
EOF

cat > gunicorn.conf.py <<'EOF'
bind = "0.0.0.0:8000"
workers = 2
accesslog = "-"
errorlog = "-"
graceful_timeout = 20
EOF

cat > Dockerfile <<'EOF'
# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --system app && useradd --system --gid app --no-create-home app

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=app:app . .

USER app
EXPOSE 8000
ENTRYPOINT ["gunicorn", "-c", "gunicorn.conf.py"]
CMD ["app:app"]
EOF

time docker build -t odeme:1.0 .
```

Şimdi aynı kod değişikliğini dene:

```bash
echo "# yine değişiklik" >> app.py
time docker build -t odeme:1.1 . 2>&1 | grep -E 'CACHED|DONE|pip install'
docker images odeme
```

`pip install` satırı `CACHED`. Sadece son `COPY` ve sonrası yeniden çalıştı. Kod değişikliği build'i artık saniyeler sürüyor.

Satır satır:

- **`# syntax=docker/dockerfile:1`**: BuildKit'in en güncel Dockerfile sözdizimini kullan (`--mount=type=cache`, heredoc gibi özellikler için).
- **`python:3.12-slim`**: Sabit ana sürüm, Debian tabanlı küçük imaj. `alpine` Python için çoğu zaman sorun çıkarır (musl libc, derlenmiş paketler için wheel yok, build süresi uzar).
- **`PYTHONUNBUFFERED=1`**: Python stdout'u tamponlamaz, loglar `docker logs`'a hemen düşer. Bu olmadan loglar gecikmeli ya da çökmede hiç görünmeyebilir.
- **`PIP_NO_CACHE_DIR`**: pip önbelleği imaja girmez.
- **Kullanıcı ve `USER app`**: Konteyner root olarak çalışmaz. `COPY --chown` dosyaları bu kullanıcıya ait yapar. (Linux kursundaki ilke: uygulamanın kendi koduna yazabilmesi gerekmiyorsa `--chown` kullanmayıp root'a ait bırakmak daha da sıkı bir yaklaşımdır.)
- **Exec biçiminde ENTRYPOINT/CMD**.

Çalıştır ve doğrula:

```bash
docker run -d --name odeme -p 8000:8000 -e APP_VERSION=1.1 odeme:1.1
sleep 2
curl -s localhost:8000/health; echo
docker exec odeme id
docker top odeme
time docker stop odeme
docker logs odeme | tail -4
docker rm odeme
```

- `id` → `uid=...(app)`: root değil (sistem kullanıcısı olduğu için 1000'in altında bir UID).
- `docker top` → PID 1 gunicorn'un ana süreci, altında worker'lar.
- `docker stop` 10 saniye değil, yaklaşık 1 saniye sürdü. Loglarda gunicorn'un "Handling signal: term" ve "Shutting down" satırları var.

Kötü imajla karşılaştır:

```bash
docker run -d --name kotu -p 8001:8000 odeme:kotu; sleep 2
docker exec kotu ps -ef 2>/dev/null || docker top kotu
time docker stop kotu
docker rm kotu
```

PID 1 `/bin/sh -c gunicorn ...` ve `stop` tam 10 saniye sürdü (SIGKILL).

## Build bağlamı ve .dockerignore

`docker build .` komutundaki `.`, **build bağlamıdır**: o klasördeki her şey (`.dockerignore` hariç) BuildKit'e gönderilir. Bağlam büyükse (bir `node_modules`, veri dosyaları, `.git`) her build yavaşlar ve `COPY . .` bunları imaja koyar. Daha kötüsü, `.env` ya da bir anahtar dosyası imaja girer ve registry'ye gönderilir.

```bash
echo "SECRET_KEY=cok-gizli" > .env
mv .dockerignore /tmp/ && docker build -q -f Dockerfile.kotu -t odeme:sizinti . && docker run --rm odeme:sizinti cat /app/.env
mv /tmp/.dockerignore .
docker build -q -t odeme:temiz . && docker run --rm odeme:temiz ls -la /app
```

`.dockerignore` olmadan `.env` imaja girdi. Bir imaj registry'ye gönderildikten sonra içindeki her dosya, imajı çekebilen herkes tarafından okunabilir.

## Alıştırma (lab'da)

1. Aşağıdaki Dockerfile'daki sorunları bul ve düzelt:

```text
FROM node:latest
RUN apt-get update
RUN apt-get install -y curl
COPY . .
RUN npm install
CMD npm start
```

2. Düzelttiğin Dockerfile'da kaynak kodda bir değişiklik yapıldığında hangi adımlar önbellekten gelir?

<details><summary>Çözüm</summary>

```text
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
USER node
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

Düzeltilenler:

- `node:latest` → sabit ana sürüm ve slim varyant.
- `apt-get update` ve `install` aynı `RUN`'da, `--no-install-recommends` ile gereksiz paketler yok, apt listeleri aynı katmanda silindi.
- `WORKDIR` eklendi (yoksa dosyalar köke kopyalanır).
- Önce sadece `package*.json`, sonra bağımlılık kurulumu, en son kod: kod değişikliği `npm ci`'yi tetiklemez.
- `npm install` yerine `npm ci --omit=dev` (kilit dosyasına birebir uyar, geliştirme bağımlılıklarını kurmaz).
- Resmî node imajındaki hazır `node` kullanıcısı.
- `CMD npm start` yerine exec biçiminde doğrudan `node`. `npm start` npm'i PID 1 yapar ve npm sinyalleri uygulamaya güvenilir şekilde iletmez.
- `.dockerignore` dosyasına `node_modules` eklenmeli (yerel modüller bağlama girmesin, imajdakilerin üstüne yazılmasın).

2: `FROM`, `apt-get`, `WORKDIR`, `COPY package*.json` ve `npm ci` önbellekten gelir. Sadece `COPY . .` ve sonrası yeniden çalışır.

</details>

```quiz
Bir konteyner `docker stop` ile her seferinde 10 saniyede kapanıyor. Dockerfile'da `CMD python app.py` yazıyor. Düzeltme nedir?
- `STOPSIGNAL SIGKILL` eklemek
- [x] Exec biçimine geçmek: `CMD ["python", "app.py"]`
- `EXPOSE` eklemek
? Kabuk biçiminde PID 1 `sh` olur ve SIGTERM'i uygulamaya iletmez.
```

```quiz
Kodda bir satır değişti ve build `pip install` adımını yeniden çalıştırdı. En olası sebep?
- pip önbelleği kapalı
- [x] `COPY . .` bağımlılık kurulumundan önce geliyor
- `.dockerignore` yok
? Önbellek bir adımda bozulursa sonraki tüm adımlar yeniden çalışır. Önce `requirements.txt`'yi kopyalayıp kurulumu yap, kodu en son kopyala.
```

```quiz
`EXPOSE 8080` talimatı ne yapar?
- 8080 portunu host'a yayınlar
- Güvenlik duvarında portu açar
- [x] Sadece imajda belgeleme amaçlı bir meta veri ekler
? Portu yayınlamak için `docker run -p host:8080` gerekir.
```

```quiz
Giriş betiğinin son satırı neden `exec "$@"` olmalı?
- Betik daha hızlı çalışır
- [x] Betik süreci CMD'deki komutla değiştirilir, uygulama PID 1 olur ve sinyalleri alır
- Ortam değişkenleri aktarılır
? `exec` olmadan betik PID 1 olarak kalır ve SIGTERM uygulamaya ulaşmaz.
```

## Özet

- Talimatları en az değişenden en çok değişene sırala: bağımlılık dosyaları → kurulum → kod.
- `apt-get update && install && rm -rf /var/lib/apt/lists/*` tek `RUN`'da.
- `ENTRYPOINT`/`CMD` exec biçiminde, giriş betiğinde `exec "$@"`.
- Sabit etiketli, slim temel imaj. `USER` ile root olmayan kullanıcı.
- `.dockerignore`: `.git`, `.env`, `node_modules`, venv. Gizli bilgiler `ARG` ile değil `--secret` ile.
- `PYTHONUNBUFFERED=1` gibi ayarlarla loglar stdout'a anında düşer.
