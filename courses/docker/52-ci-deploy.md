# CI ile imaj üretme, registry ve sunucuya deploy

Kursun son dersinde bütün parçaları bir **teslimat hattına** bağlıyoruz: Kod bir depoya gönderildiğinde CI imajı build eder, test eder, tarar, değişmez bir etiketle registry'ye gönderir, sonra sunucuya deploy eder ve sağlık kontrolü başarısızsa geri alır. Örnekler **GitHub Actions** ve **GitHub Container Registry (ghcr.io)** üzerinden. Kavramlar GitLab CI, Jenkins ya da başka bir CI aracında da aynı.

## Hedef akış

```text
git push
   │
   ▼
┌─────────────────────────── CI ────────────────────────────┐
│ 1. build (BuildKit, önbellekli, gerekirse çok mimarili)    │
│ 2. test  (Dockerfile'daki test aşaması)                    │
│ 3. tara  (Trivy: kritik açık varsa dur)                    │
│ 4. etiketle: commit SHA (değişmez) + sürüm/branch          │
│ 5. push → ghcr.io/kullanici/siparis-api:sha-4f9c2e1        │
└───────────────────────────┬───────────────────────────────┘
                            │ (main branch ya da sürüm etiketi)
                            ▼
┌──────────────────────── Deploy ───────────────────────────┐
│ ssh sunucu: API_IMAGE=...:sha-4f9c2e1                      │
│   docker compose pull && docker compose up -d --wait       │
│   başarısızsa önceki etikete geri dön                      │
└────────────────────────────────────────────────────────────┘
```

## Etiketleme stratejisi

İmajlar dersinden: Deploy edilen imaj **değişmez** bir etiketle tanınmalı.

| Etiket | Örnek | Amaç |
|---|---|---|
| Commit SHA | `sha-4f9c2e1` | **Deploy bununla yapılır.** Hangi kodun çalıştığı kesin |
| Sürüm | `1.4.0`, `1.4`, `1` | İnsanlar ve sürüm notları için (git etiketi `v1.4.0` ile) |
| Branch | `main`, `staging` | Ortamın "en son" imajı, sadece bilgi amaçlı |
| `latest` | | Kullanma, ya da sadece belgeleme için |

Aynı imaj (aynı digest) birden fazla etiket taşır. "Staging'de test edilen imaj, üretime giden imajdır" ilkesi: Üretim için **yeniden build etme**, staging'de doğrulanan aynı digest'i deploy et.

## Dockerfile: test aşaması

Multi-stage dersindeki gibi test aşaması CI'da hedeflenir, üretim imajına girmez:

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

FROM base AS test
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY . .
RUN python -m pytest -q

FROM base AS production
RUN useradd --system --no-create-home app
COPY . .
USER app
ARG GIT_SHA=unknown
ENV APP_VERSION=$GIT_SHA
CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:app"]
```

`production` en sonda, yani `--target` verilmeden build edilen aşama o. `GIT_SHA` sona yakın, önbelleği gereksiz bozmuyor.

## GitHub Actions iş akışı

Deponun kökünde `.github/workflows/docker.yml`:

```yaml
name: docker

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:

env:
  IMAGE: ghcr.io/${{ github.repository_owner }}/siparis-api

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write          # ghcr.io'ya push için
    outputs:
      digest: ${{ steps.push.outputs.digest }}
      sha_tag: ${{ steps.vars.outputs.sha_tag }}
    steps:
      - uses: actions/checkout@v4

      - id: vars
        run: echo "sha_tag=sha-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        if: github.event_name != 'pull_request'
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE }}
          tags: |
            type=sha,prefix=sha-
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}

      - name: Test
        uses: docker/build-push-action@v6
        with:
          context: ./api
          target: test
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build (taramak için yerelde)
        uses: docker/build-push-action@v6
        with:
          context: ./api
          target: production
          load: true
          tags: siparis-api:tara
          build-args: GIT_SHA=${{ github.sha }}
          cache-from: type=gha

      - name: Güvenlik taraması
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: siparis-api:tara
          severity: CRITICAL,HIGH
          ignore-unfixed: true
          exit-code: "1"

      - name: Push
        id: push
        if: github.event_name != 'pull_request'
        uses: docker/build-push-action@v6
        with:
          context: ./api
          target: production
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: GIT_SHA=${{ github.sha }}
          cache-from: type=gha
          provenance: true
          sbom: true
```

Öne çıkanlar:

- **`GITHUB_TOKEN` + `packages: write`**: ghcr.io'ya push için ayrı bir parola ya da kişisel token gerekmez. Token sadece o iş akışı süresince geçerlidir.
- **`metadata-action`**: Etiketleri olaydan türetir. `main`'e push: `sha-4f9c2e1` ve `main`. `v1.4.0` etiketi: `1.4.0`, `1.4` ve SHA.
- **`cache-from/to: type=gha`**: BuildKit katman önbelleği GitHub Actions önbelleğinde tutulur. Kod değişmeyen katmanlar (bağımlılık kurulumu) her çalıştırmada yeniden build edilmez.
- **Pull request'lerde push yok**: Dışarıdan gelen PR'lar registry'ye yazamaz, sadece test ve tarama çalışır.
- **Tarama push'tan önce**: Kritik açıklı imaj registry'ye hiç ulaşmaz. `ignore-unfixed`: henüz yaması olmayan açıklar için build'i durdurma (yapabileceğin bir şey yok), ama raporda görünür.
- **`platforms`**: Hem amd64 sunucular hem arm64 (Graviton, Apple Silicon) için tek etiket (imajlar dersi, manifest listesi). Farklı mimari için build QEMU ile yavaş olabilir. Gerekmiyorsa kaldır.
- **`provenance` ve `sbom`**: İmajın hangi depodan, hangi commit'ten, hangi iş akışıyla üretildiğini (SLSA provenance) ve içindeki paket listesini (SBOM) imajla birlikte registry'ye ekler.

> GitHub Actions'taki üçüncü taraf eylemleri (`uses:`) sürüm etiketi yerine **commit SHA'sıyla** sabitlemek, tedarik zinciri saldırılarına karşı daha güvenlidir (`uses: aquasecurity/trivy-action@<40 karakterlik SHA>`). Bir eylemin etiketi değiştirilip kötü amaçlı koda yönlendirilebilir. Dependabot bu SHA'ları güncel tutabilir.

### İmzalama (isteğe bağlı)

```yaml
      - uses: sigstore/cosign-installer@v3
      - name: İmzala
        if: github.event_name != 'pull_request'
        env:
          DIGEST: ${{ steps.push.outputs.digest }}
        run: cosign sign --yes ${{ env.IMAGE }}@${DIGEST}
```

İş akışına `id-token: write` izni eklendiğinde cosign, GitHub'ın OIDC kimliğiyle **anahtarsız** imzalar. Sunucu tarafında `cosign verify` ile imajın bu depodaki iş akışı tarafından üretildiği doğrulanabilir.

## Deploy işi

Build başarılıysa ve `main`'e push yapıldıysa sunucuya deploy:

```yaml
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production        # GitHub'da onay ve gizli değişkenler
    concurrency: production        # aynı anda tek deploy
    steps:
      - name: Sunucuya deploy
        env:
          SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          HOST: ${{ secrets.DEPLOY_HOST }}
          TAG: ${{ needs.build.outputs.sha_tag }}
        run: |
          mkdir -p ~/.ssh
          echo "$SSH_KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "$HOST" >> ~/.ssh/known_hosts
          ssh deploy@"$HOST" "sudo /usr/local/bin/compose-deploy $TAG"
```

- **`environment: production`**: GitHub'da bu ortam için "onay gerekli" kuralı konursa deploy bir kişinin onayını bekler. Ortama özel gizli değişkenler (`DEPLOY_HOST`) sadece bu işe verilir.
- **`concurrency`**: İki push art arda gelirse deploy'lar üst üste binmez (Linux kursundaki `flock`'un CI karşılığı).
- `ssh-keyscan`'ı her seferinde çalıştırmak yerine sunucunun host anahtarını bir gizli değişkende sabitlemek, ortadaki adam saldırısına karşı daha güvenlidir.

### Sunucudaki betik

Linux kursundaki deploy betiğinin Compose'lu hâli. Deploy kullanıcısının sudo yetkisi **sadece bu betikle** sınırlı (izinler dersi):

```bash
#!/bin/sh
# /usr/local/bin/compose-deploy <etiket>
set -eu
TAG=${1:?Kullanım: compose-deploy <etiket>}
case "$TAG" in sha-[0-9a-f]*|[0-9]*.[0-9]*.[0-9]*) ;; *) echo "geçersiz etiket: $TAG" >&2; exit 2 ;; esac

DIR=/srv/siparis
IMG=ghcr.io/ardaatay/siparis-api
cd "$DIR"
exec 9> "$DIR/.deploy.lock"; flock -n 9 || { echo "başka bir deploy çalışıyor" >&2; exit 1; }

ONCEKI=$(cat "$DIR/.aktif-etiket" 2>/dev/null || true)

echo "deploy: ${ONCEKI:-yok} -> $TAG"
API_IMAGE="$IMG:$TAG" docker compose -f compose.yaml -f compose.prod.yaml pull --quiet
if API_IMAGE="$IMG:$TAG" docker compose -f compose.yaml -f compose.prod.yaml up -d --wait --wait-timeout 120 --remove-orphans; then
  echo "$TAG" > "$DIR/.aktif-etiket"
  echo "$(date -Is) $TAG" >> "$DIR/deploy-gecmisi.log"
  docker image prune -f --filter "until=168h" >/dev/null
  echo "deploy başarılı: $TAG"
else
  echo "sağlık kontrolü başarısız, geri alınıyor: $ONCEKI" >&2
  [ -n "$ONCEKI" ] && API_IMAGE="$IMG:$ONCEKI" docker compose -f compose.yaml -f compose.prod.yaml up -d --wait
  exit 1
fi
```

- **Etiket doğrulaması** (`case`): Betik sudo ile çalıştığı için argüman kabuk komutuna dönüşebilecek bir şey olmamalı.
- **`pull` önce**: İndirme sırasında eski sürüm çalışır.
- **`up -d --wait`**: Compose dersindeki sağlık kontrollerini bekler. Migration servisi de bu adımda çalışır.
- **Geri alma**: Önceki etiket dosyada tutulur. Sağlık kontrolü başarısızsa önceki imajla tekrar `up`. Bütün geri alma bir `pull` gerektirmez, çünkü eski imaj sunucuda duruyor (`image prune` sadece 7 günden eskileri siler).
- **Geçmiş**: Hangi sürümün ne zaman deploy edildiği. Linux kursundaki "sorun ne zaman başladı, o anda ne değişti" sorusunun cevabı.

Sunucunun ghcr.io'dan çekebilmesi için (özel paketse) bir kez: `docker login ghcr.io -u <kullanici>` ve sadece `read:packages` yetkili bir token.

## Swarm'a deploy

Swarm kümesine deploy daha da basit: Rolling update ve otomatik geri alma Swarm'ın kendisinde (`update_config.failure_action: rollback`):

```bash
ssh deploy@manager "cd /srv/siparis && API_TAG=$TAG docker stack deploy -c stack.yaml --with-registry-auth siparis"
```

`--with-registry-auth`, manager'daki registry kimlik bilgisini worker'lara iletir. Böylece her node özel registry'den çekebilir.

## Push mu, pull mu?

Yukarıdaki yöntem **push tabanlı**: CI, sunucuya bağlanıp deploy eder. CI'ın sunucuya SSH erişimi olması gerekir. Alternatif **pull tabanlı** (GitOps) yaklaşımda sunucudaki bir ajan, istenen durumun tutulduğu bir depoyu izler ve değişikliği kendisi uygular. CI'ın sunucuya erişimi olmaz, sadece depodaki imaj etiketini günceller. Kubernetes dünyasında Argo CD ve Flux bu modeli kullanır.

> **Watchtower** gibi "registry'de yeni imaj varsa otomatik çek ve yeniden başlat" araçları ev laboratuvarları için pratiktir, ama üretimde önerilmez: hangi sürümün ne zaman deploy edildiği kontrolsüz olur, sağlık kontrolü ve geri alma yoktur ve genelde `latest` gibi değişken etiketlere dayanır.

## Registry bakımı

Her commit bir imaj üretir ve registry zamanla dolar. Bir saklama politikası belirle:

- Sürüm etiketli imajları (`1.4.0`) tut.
- `sha-` etiketli imajlardan son N tanesini ya da son 30 günü tut.
- Etiketsiz (untagged) imajları sil.

GHCR'de GitHub Actions ile (`actions/delete-package-versions`), Harbor ve bulut registry'lerinde yerleşik saklama kurallarıyla yapılır. Silmeden önce, üretimde ve geri alma için gereken sürümlerin listede kalmadığından emin ol.

## Kursun sonu ve sonraki adım

Bu kursta konteynerin çekirdekteki karşılığından başlayıp üretime kadar geldik:

| Bölüm | Kazanım |
|---|---|
| Temeller | Konteynerin namespace ve cgroup'la izole edilmiş bir süreç olduğu, Docker'ın parçaları |
| İmajlar | Katmanlar, önbellek, iyi Dockerfile, multi-stage, küçük ve taranmış imajlar |
| Çalıştırma | Ağ, depolama, kaynaklar, sinyaller, healthcheck, yapılandırma, loglar |
| Compose | Çok servisli uygulama, ortamlar, bağımlılıklar, tek sunucuda deploy |
| Swarm | Orkestrasyon kavramları, kesintisiz güncelleme, secret'lar |
| Üretim | Teşhis, güvenlik, CI ile teslimat hattı |

Sıradaki doğal adım **Kubernetes**: Swarm'da öğrendiğin istenen durum, rolling update, servis keşfi ve secret kavramları orada Pod, Deployment, Service ve Secret olarak karşına çıkacak. Bu kursta yazdığın imajlar Kubernetes'te değişmeden çalışır.

## Alıştırma

Kendi GitHub hesabında (örneğin bu eğitim deposunun yanında açacağın ayrı bir test deposunda) yukarıdaki iş akışını kur:

1. Compose dersindeki `api` klasörünü depoya koy, Dockerfile'a basit bir test aşaması ekle (`RUN python -c "import app"` yeterli).
2. İş akışını `.github/workflows/docker.yml` olarak ekle (deploy işi olmadan). Push et ve Actions sekmesinde çalışmasını izle.
3. Depoya `v0.1.0` git etiketi gönder. ghcr.io'da paketin hangi etiketleri aldığına bak.
4. Bilerek bir test hatası ekleyip push et. İmaj registry'ye gönderildi mi?

<details><summary>Beklenen sonuçlar</summary>

2: `main`'e push sonrası paket sayfasında (GitHub profilin → Packages) `sha-xxxxxxx` ve `main` etiketli bir imaj görünür. İkinci çalıştırma, `gha` önbelleği sayesinde belirgin şekilde daha hızlıdır.

3: `v0.1.0` etiketi sonrası aynı imaja `0.1.0` ve `0.1` etiketleri de eklenir.

4: Test aşaması başarısız olduğu için iş akışı "Test" adımında durur, push adımı hiç çalışmaz: registry'de bozuk imaj yok. Pull request açarak denersen, PR sayfasında başarısız kontrol görünür ve (dal koruma kuralı varsa) birleştirme engellenir.

Not: GHCR paketleri varsayılan olarak **özel** oluşturulur. Sunucudan çekmek için `docker login ghcr.io` gerekir ya da paket ayarlarından görünürlüğü herkese açık yapabilirsin.

</details>

```quiz
Staging'de test edilen sürümü üretime almak için en doğru yaklaşım?
- Aynı commit'ten üretim için yeniden build etmek
- [x] Staging'de doğrulanan aynı imajı (aynı digest/SHA etiketi) üretime deploy etmek
- `latest` etiketini çekmek
? Yeniden build farklı bağımlılık sürümleri ya da temel imaj güncellemeleri içerebilir. Test edilen şey deploy edilen şey olmalı.
```

```quiz
Güvenlik taramasını CI'da push adımından önce koymanın faydası?
- Build daha hızlı olur
- [x] Kritik açıklı imaj registry'ye hiç ulaşmaz ve deploy edilemez
- Tarama daha doğru sonuç verir
? Tarama bir kalite kapısıdır. Başarısız olursa sonraki adımlar çalışmaz.
```

```quiz
Sunucudaki deploy betiği sudo ile çalışıyor ve CI'dan bir etiket argümanı alıyor. Neden argüman doğrulanmalı?
- Betik daha okunur olur
- [x] Doğrulanmamış argüman kabuk komutuna enjekte edilip root olarak çalışabilir
- Docker etiketleri büyük harf kabul etmez
? sudo ile çalışan her betik, girdisini beklenen biçimle (örneğin sha-[0-9a-f]+) sınırlamalı.
```

## Özet

- Etiketler: deploy SHA ile, insanlar için sürüm. Test edilen imaj = deploy edilen imaj.
- CI: test aşaması → build → Trivy → push (sadece main/etiket). `gha` önbelleği, `metadata-action`, `GITHUB_TOKEN`.
- Çok mimari, provenance, SBOM, cosign ile imzalama. Eylemleri SHA ile sabitle.
- Deploy: `environment` onayı, `concurrency`, sudo ile sınırlı betik, `pull` + `up -d --wait`, önceki etikete geri alma, geçmiş kaydı.
- Swarm: `stack deploy --with-registry-auth`. Pull tabanlı GitOps alternatifi. Registry saklama politikası.
