# Multi-stage build, küçük ve güvenli imajlar

Bir imajın içinde ne varsa, onu çalıştıran herkes ve imajı ele geçiren her saldırgan için de oradadır: derleyiciler, paket yöneticileri, kabuk, test araçları, kaynak kodu. Küçük imaj sadece daha hızlı çekilen imaj değildir. Daha az bileşen, tarayıcıların raporladığı daha az güvenlik açığı ve ele geçirilmesi durumunda saldırganın elinde daha az araç demektir.

Bu derste **multi-stage build** ile "derleme ortamı" ile "çalışma ortamını" ayırmayı, BuildKit'in önbellek ve secret özelliklerini, temel imaj seçimini ve imaj taramayı göreceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## Problem: derleme araçları çalışma zamanında gereksiz

Basit bir Go web servisi:

```bash
mkdir -p ~/go-api && cd ~/go-api
cat > main.go <<'EOF'
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "{\"durum\":\"ok\",\"surum\":\"%s\"}\n", os.Getenv("APP_VERSION"))
	})
	srv := &http.Server{Addr: ":8080", Handler: mux}
	go srv.ListenAndServe()
	fmt.Println("dinleniyor :8080")

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop
	fmt.Println("SIGTERM alındı, kapanıyor")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}
EOF
cat > go.mod <<'EOF'
module ornek/go-api

go 1.23
EOF
```

Tek aşamalı Dockerfile:

```bash
cat > Dockerfile.tek <<'EOF'
FROM golang:1.23
WORKDIR /src
COPY . .
RUN go build -o /api .
CMD ["/api"]
EOF
docker build -q -f Dockerfile.tek -t api:tek .
docker images api
```

Yaklaşık **850 MB**. İçinde Go derleyicisi, Debian'ın tam kullanıcı alanı, git, gcc... Çalışan program ise birkaç MB'lık tek bir ikili dosya.

## Multi-stage build

Bir Dockerfile'da birden fazla `FROM` olabilir. Her biri bir **aşamadır**. Son aşama imajı oluşturur, önceki aşamalardan sadece `COPY --from` ile alınan dosyalar oraya geçer:

```bash
cat > Dockerfile <<'EOF'
# syntax=docker/dockerfile:1

# --- 1. aşama: derleme ---
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api .

# --- 2. aşama: çalışma ---
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/api"]
EOF
docker build -q -t api:1.0 .
docker images api
```

Sonuç birkaç MB. Derleyici, kaynak kod ve ara dosyalar imajda yok.

- **`CGO_ENABLED=0`**: C kütüphanelerine bağımlı olmayan, **statik** bir ikili üretir. Böylece çalışma imajında libc bile gerekmez.
- **`-ldflags="-s -w"`**: hata ayıklama sembollerini çıkarır, ikiliyi küçültür.
- **`distroless/static`**: Google'ın sadece CA sertifikaları, saat dilimi verisi ve `/etc/passwd` içeren minimal imajı. **Kabuk ve paket yöneticisi yok.** `:nonroot` etiketi varsayılan kullanıcıyı UID 65532 yapar.

Çalıştır ve dene:

```bash
docker run -d --name api -p 8080:8080 -e APP_VERSION=1.0 api:1.0
sleep 1; curl -s localhost:8080/health
docker exec api sh 2>&1 | head -2
time docker stop api
docker logs api
docker rm api
```

`docker exec api sh` başarısız oldu: imajda kabuk yok. Saldırgan bir açık bulsa bile içeride çalıştırabileceği araç yok. Teşhis için önceki dersteki `nsenter` ya da `docker debug` gibi araçlar kullanılır (teşhis dersi).

### Aşamalar önbellek açısından bağımsızdır

Yukarıdaki derleme aşamasında da önceki dersin kuralı uygulandı: önce `go.mod`, sonra `go mod download`, en son kod. Kod değişince bağımlılık indirme önbellekten gelir.

Belirli bir aşamaya kadar build etmek için `--target`:

```bash
docker build -q --target build -t api:build-ortami .
docker run --rm api:build-ortami go version
```

Bu, CI'da testleri derleme aşamasında çalıştırmak için kullanılır:

```dockerfile
FROM build AS test
RUN go test ./...
```

`docker build --target test .` testleri çalıştırır, `docker build .` (son aşama) testleri atlar. BuildKit sadece hedefe gereken aşamaları çalıştırır, hatta bağımsız aşamaları **paralel** build eder.

## Yorumlanan diller: Python ve Node

Go gibi tek bir ikili üretmeyen dillerde de multi-stage işe yarar: derleme araçları (gcc, başlık dosyaları) ilk aşamada kalır, sadece kurulmuş paketler son aşamaya geçer.

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /venv
ENV PATH=/venv/bin:$PATH
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home app
COPY --from=build /venv /venv
ENV PATH=/venv/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /app
COPY . .
USER app
ENTRYPOINT ["gunicorn", "-b", "0.0.0.0:8000", "app:app"]
```

İlk aşamada `psycopg` gibi C eklentili paketler `build-essential` ile derlenir. Son aşamada derleyici yok, sadece çalışma zamanı kütüphanesi (`libpq5`) ve hazır venv var. venv'in **aynı yolda** (`/venv`) kopyalanması önemli: venv'ler içlerindeki betiklere mutlak yol yazar.

Node için aynı mantık: ilk aşamada `npm ci` ve `npm run build` (TypeScript derleme, frontend paketleme), son aşamada sadece `dist/` ve `npm ci --omit=dev` ile üretim bağımlılıkları.

## BuildKit özellikleri

### Önbellek mount'ları

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
RUN --mount=type=cache,target=/root/.npm npm ci
RUN --mount=type=cache,target=/go/pkg/mod go mod download
```

Paket yöneticisinin önbellek klasörü build'ler arasında korunur ama **imaja girmez**. `requirements.txt` değişip katman önbelleği bozulduğunda bile, daha önce indirilmiş paketler yeniden indirilmez.

### Secret'lar

Build sırasında özel bir paket deposuna erişmek için token gerektiğinde:

```bash
echo "gizli-token-123" > /tmp/npm_token
cat > Dockerfile.secret <<'EOF'
# syntax=docker/dockerfile:1
FROM alpine:3.20
RUN --mount=type=secret,id=npm_token \
    echo "token uzunluğu: $(wc -c < /run/secrets/npm_token)"
EOF
docker build --progress=plain --no-cache --secret id=npm_token,src=/tmp/npm_token -f Dockerfile.secret -t secret-deneme . 2>&1 | grep 'token uzunluğu'
docker history --no-trunc secret-deneme | grep -c gizli-token || echo "imaj geçmişinde token yok"
```

Secret, sadece o `RUN` süresince `/run/secrets/` altında bir dosya olarak görünür. Katmanlara, `docker history`'ye ve imaja girmez. `ARG` ya da `ENV` ile geçirilen değerler ise imajın meta verisinde kalır ve imajı çekebilen herkes görebilir.

SSH ile özel git deposu klonlamak için de benzeri vardır: `RUN --mount=type=ssh git clone ...` ve `docker build --ssh default`.

## Temel imaj seçimi

| Temel | Boyut | Kabuk / paket yöneticisi | Ne zaman |
|---|---|---|---|
| `debian:bookworm`, `ubuntu:24.04` | ~80-120 MB | Var / apt | Çok sistem bağımlılığı olan uygulamalar |
| `*-slim` (`python:3.12-slim`, `node:22-bookworm-slim`) | Tam sürümün yarısından azı | Var / apt | **Çoğu uygulama için iyi varsayılan** |
| `alpine` | ~8 MB | Var (BusyBox) / apk | Küçük araçlar. musl libc yüzünden Python/Node yerel eklentilerinde ve DNS davranışında farklılıklar çıkabilir |
| `distroless` | 2-50 MB | **Yok** | Statik ikililer (Go, Rust) ya da distroless'ın dil imajları (Java, Python, Node) |
| `scratch` | 0 | Hiçbir şey | Tamamen statik ikili. CA sertifikaları, saat dilimi ve kullanıcı bilgisini kendin eklemelisin |

Kabuksuz imajın bedeli: içeride `sh`, `curl` ya da `ps` yok. Sağlık kontrolünü uygulamanın kendi komutuyla yaz (`HEALTHCHECK CMD ["/api", "-healthcheck"]`), teşhiste `nsenter` ya da geçici bir hata ayıklama konteyneri kullan.

## Güvenlik taraması

İmajdaki paketlerin bilinen açıklarını (CVE) tarayan araçlar: **Trivy**, **Grype**, **Docker Scout**.

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image --severity HIGH,CRITICAL --quiet api:tek 2>/dev/null | tail -15
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image --severity HIGH,CRITICAL --quiet api:1.0 2>/dev/null | tail -15
```

(Burada Trivy'nin kendisini Docker soketiyle çalıştırdık. Mimari dersinde gördüğümüz gibi soket erişimi root demektir. Güvendiğin bir aracın resmî imajı olduğu için kabul edilebilir.)

Tek aşamalı `golang` imajında onlarca, distroless imajında genelde sıfıra yakın bulgu çıkar. Bulguların çoğu uygulamanın hiç kullanmadığı paketlerden gelir, ama denetimlerde ve güvenlik süreçlerinde her biri açıklama ister. En etkili çözüm, o paketleri imaja hiç koymamak.

CI'da taramayı bir kalite kapısı olarak kullan: `trivy image --exit-code 1 --severity CRITICAL imaj` kritik bulgu varsa build'i başarısız yapar. Bulgular zamanla artar (imaj değişmese de yeni CVE'ler yayınlanır), bu yüzden imajları düzenli olarak yeniden build et ki temel imajın yamalarını alsın.

## Alıştırma (lab'da)

1. Go servisini `scratch` temel imajıyla build et. Çalışıyor mu? HTTPS ile dışarıya istek atsaydı ne eksik olurdu?
2. Go servisinin Dockerfile'ına bir `test` aşaması ekle ve `--target test` ile çalıştır. Son imajın boyutu değişti mi?

<details><summary>Çözüm</summary>

```bash
cd ~/go-api
cat > Dockerfile.scratch <<'EOF'
# syntax=docker/dockerfile:1
FROM golang:1.23 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /api .

FROM scratch
COPY --from=build /api /api
USER 65532:65532
ENTRYPOINT ["/api"]
EOF
docker build -q -f Dockerfile.scratch -t api:scratch .
docker run -d --name s -p 8082:8080 api:scratch; sleep 1; curl -s localhost:8082/health; docker rm -f s
docker images api
```

Çalışır ve imaj neredeyse sadece ikili dosya kadar. Ama `scratch`'te `/etc/ssl/certs` yok: HTTPS ile dışarı istek atan bir program "x509: certificate signed by unknown authority" hatası verir. Ayrıca saat dilimi verisi (`/usr/share/zoneinfo`) ve `/etc/passwd` da yok. Bu yüzden genelde `scratch` yerine bunları içeren `distroless/static` tercih edilir, ya da derleme aşamasından bu dosyalar da kopyalanır.

```bash
cat >> Dockerfile <<'EOF'

FROM build AS test
RUN go vet ./... && go test ./...
EOF
docker build --target test .
docker build -q -t api:1.1 . && docker images api
```

`docker images api` çıktısına bak: `api:1.1` birkaç MB değil, yüzlerce MB. Sebep: `docker build .` dosyadaki **son** aşamayı hedefler ve son aşama artık `test`. Yani `--target` kullanmadan build edince test aşamasının imajı (derleme ortamı) üretildi. Çalışma aşamasının en sonda kalması ya da build'in her zaman `--target` ile yapılması gerekir. Test aşamasını Dockerfile'da çalışma aşamasından önceye koymak bu tuzağı önler.

</details>

```quiz
Multi-stage build'de son imaja hangi dosyalar girer?
- Bütün aşamalardaki dosyalar
- [x] Son aşamanın temel imajı ve oraya `COPY --from` ile alınanlar
- Sadece ilk aşamanın dosyaları
? Önceki aşamalar sadece build sırasında vardır. Derleyici ve kaynak kod son imaja geçmez.
```

```quiz
Build sırasında özel bir depo için token gerekiyor. En güvenli yöntem?
- `ARG NPM_TOKEN` ve `--build-arg`
- `ENV NPM_TOKEN=...`
- [x] `RUN --mount=type=secret,id=npm_token` ve `docker build --secret`
? ARG ve ENV değerleri imaj meta verisinde ve geçmişinde kalır. Secret mount sadece o RUN süresince vardır.
```

```quiz
Distroless bir imajda çalışan konteynerde `docker exec -it api sh` hata veriyor. Neden?
- Konteyner root değil
- [x] İmajda kabuk yok
- exec devre dışı
? Distroless imajlar kabuk ve paket yöneticisi içermez. Teşhis için nsenter ya da hata ayıklama konteyneri kullanılır.
```

## Özet

- Multi-stage: derleme aşaması (büyük, araçlı) ve çalışma aşaması (küçük). `COPY --from=build`.
- Go/Rust: statik ikili + `distroless/static` ya da `scratch`. Python/Node: derleme araçları ilk aşamada, venv/`dist` son aşamada.
- `--target` ile belirli aşama (test), `RUN --mount=type=cache` ile paket önbelleği, `--mount=type=secret` ile gizli bilgi.
- Temel imaj: varsayılan `*-slim`, kabuksuz çalışabiliyorsan `distroless`.
- Trivy/Grype ile tara, CI'da kritik bulguda durdur, imajları düzenli yeniden build et.
