# İmaj build, registry, Kubernetes'e deploy ve güvenlik taramaları

Bir önceki derste kodu test eden bir pipeline kurduk. Bu ders onu bir **teslimat hattına** dönüştürüyor: Testi geçen her commit'ten bir konteyner imajı üretmek, GitLab'ın container registry'sine koymak, güvenlik taramalarından geçirmek, önce staging'e otomatik, sonra production'a onaylı olarak deploy etmek. Docker ve Kubernetes kurslarındaki parçalar burada birleşiyor.

> **Dikkat:** Bu dersteki pipeline canlı bir GitLab'da, Dockerfile ise bir build'de çalıştırılmadı. Bu ortamda GitLab ve Node.js imajı yok, ve büyük imajları indirmek yerine şu doğrulamalar yapıldı: YAML sözdizimi ve yapısı (stage, `needs`, `extends`), `main` ve etiket pipeline'larında hangi job'ların oluşacağının bir betikle simülasyonu (bu simülasyon gerçek bir hatayı yakaladı, aşağıda), ve job'ların içindeki kabuk komutlarının yerelde çalıştırılması. Kendi projende GitLab'ın Pipeline editor doğrulayıcısını kullan.

## İmaj: Dockerfile

Docker kursundaki ilkelerle, önceki dersin Node servisi için:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS bagimliliklar
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:22-alpine
ARG APP_SURUM=dev
ENV NODE_ENV=production APP_SURUM=${APP_SURUM} PORT=8080
WORKDIR /app
COPY --from=bagimliliklar /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.js"]
```

`APP_SURUM` build sırasında gömülür ve sağlık ucunda görünür (`saglik()` fonksiyonu onu okuyor): Çalışan bir pod'un hangi sürümü çalıştırdığı tek bir `curl` ile görülür.

## İmajı CI'da build etmek

CI'da imaj üretmenin üç yolu var, ve güvenlik açısından çok farklılar:

| Yöntem | Nasıl | Risk |
|---|---|---|
| Docker-in-Docker (`docker:dind` servisi) | Job'un içinde ayrı bir Docker daemon | Runner'ın **privileged** çalışmasını gerektirir: job konteyneri, runner makinesinin tamamına erişebilir |
| Docker soketini bağlamak | Runner'ın Docker soketi job'a verilir | Job, makinedeki bütün konteynerleri görür ve yönetir: root'a eşdeğer |
| **Daemonsuz, rootless build** (BuildKit rootless, Buildah) | Build aracı job'un içinde, ayrıcalıksız çalışır | En düşük risk |

Paylaşılan ya da birden çok projenin kullandığı runner'larda privileged mod ve soket bağlama, bir projenin diğerlerinin gizli bilgilerine ulaşabilmesi demektir (runner dersi). Burada BuildKit'in rootless sürümünü kullanıyoruz. (Uzun süre yaygın olan Kaniko projesi 2025'te Google tarafından arşivlendi; mevcut pipeline'larda görürsün, yenilerinde BuildKit ya da Buildah tercih et.)

```yaml
variables:
  IMAJ: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA

imaj:
  stage: paket
  image:
    name: moby/buildkit:v0.23.2-rootless
    entrypoint: [""]
  variables:
    BUILDKITD_FLAGS: --oci-worker-no-process-sandbox
  before_script:
    - mkdir -p ~/.docker
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"auth\":\"$(printf '%s:%s' "$CI_REGISTRY_USER" "$CI_REGISTRY_PASSWORD" | base64 | tr -d '\n')\"}}}" > ~/.docker/config.json
  script:
    - >
      buildctl-daemonless.sh build
      --frontend dockerfile.v0
      --local context=. --local dockerfile=.
      --opt build-arg:APP_SURUM=${CI_COMMIT_TAG:-$CI_COMMIT_SHORT_SHA}
      --export-cache type=registry,ref=$CI_REGISTRY_IMAGE/cache
      --import-cache type=registry,ref=$CI_REGISTRY_IMAGE/cache
      --output type=image,name=$IMAJ,push=true
  needs: [birim-test]
```

- `CI_REGISTRY`, `CI_REGISTRY_USER`, `CI_REGISTRY_PASSWORD`, `CI_REGISTRY_IMAGE`: GitLab'ın her job'a verdiği, sadece o job süresince geçerli registry kimlik bilgileri (`CI_REGISTRY_PASSWORD` aslında `CI_JOB_TOKEN`). Saklanacak bir parola yok.
- `before_script`, BuildKit'in okuyacağı Docker kimlik dosyasını yazıyor. Komutun ürettiği yapı (örnek değerlerle yerelde çalıştırıldı):

```text
{"auths":{"registry.gitlab.com":{"auth":"Z2l0bGFiLWNpLXRva2VuOm9ybmVrLWpldG9u"}}}
```

- `--export-cache` / `--import-cache`: Katman önbelleği registry'de tutulur. Runner'lar geçici olsa bile, `package.json` değişmedikçe `npm ci` katmanı yeniden çalışmaz.
- `entrypoint: [""]`: İmajın kendi giriş noktasını devre dışı bırakır, GitLab'ın betiği bir kabukta çalışabilsin.

### Etiketleme

İmaj etiketi **commit hash'i** (`$CI_COMMIT_SHORT_SHA`): Değişmez ve izlenebilir. Hangi kodun hangi imajda olduğu hiçbir zaman belirsiz değildir. Sürüm etiketlerinde (`v1.4.0`) aynı imaja ek bir etiket verilebilir (`crane tag` / `buildctl` ile yeniden build etmeden). `latest` asla deploy edilmez (Kubernetes kursundaki kural). Registry'de **cleanup policy** (Settings → Packages and registries) ile eski commit imajlarını otomatik sil, sürüm etiketlerini koru: Aksi halde registry her commit'le büyür.

## Güvenlik taramaları

GitLab, hazır CI şablonlarıyla taramalar sunar:

```yaml
include:
  - template: Jobs/Secret-Detection.gitlab-ci.yml
  - template: Jobs/SAST.gitlab-ci.yml
  - template: Jobs/Dependency-Scanning.gitlab-ci.yml
  - template: Jobs/Container-Scanning.gitlab-ci.yml

variables:
  CS_IMAGE: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA

container_scanning:
  needs: [imaj]
```

| Tarama | Ne arar |
|---|---|
| Secret Detection | Commit'lerdeki anahtarlar, jetonlar, parolalar (büyük depolar dersindeki hook'un sunucu tarafı) |
| SAST | Kaynak kodda bilinen güvensiz kalıplar (enjeksiyon, güvensiz fonksiyonlar) |
| Dependency Scanning | Bağımlılıklardaki bilinen açıklar (CVE), lock dosyalarından |
| Container Scanning | İmajın işletim sistemi paketlerindeki ve kütüphanelerindeki açıklar |

Şablonların getirdiği job'lar (`container_scanning` gibi) aynı adla tekrar tanımlanarak özelleştirilir: Burada sadece `needs` ekledik, imaj build edildikten sonra taransın diye. Taramaların çoğu ücretsiz katmanda çalışır ve sonuçlar artifact olarak indirilebilir. Bulguların MR sayfasında görünmesi, güvenlik paneli ve "yeni kritik açık varsa birleştirmeyi engelle" politikaları Ultimate katmanındadır. Ücretsiz katmanda eşdeğer bir kapı için tarayıcıyı doğrudan çalıştırıp çıkış koduyla job'u kırabilirsin (örneğin `trivy image --exit-code 1 --severity CRITICAL $IMAJ`).

Taramaların bir sınırı: Bilinen açıkları bulurlar, tasarım hatalarını bulmazlar. Bir sonraki kurs (Yazılım Güvenliği) bu konuyu genişletiyor.

## Deploy: ortamlar

GitLab'da bir **environment** (ortam), deploy edilen yerin kaydıdır: Hangi commit ne zaman hangi ortama gitti, kim başlattı, ortamın adresi ne. Bir job'a `environment:` vermek onu deploy job'u yapar:

```yaml
.deploy:
  stage: deploy
  image: $CI_REGISTRY/sirket/platform/arac-imajlari/kubectl:1.33   # ekibin kendi araç imajı
  resource_group: $CI_ENVIRONMENT_NAME
  script:
    - kubectl config use-context "$KUBE_CONTEXT"
    - kubectl -n "$NAMESPACE" set image deployment/deploy-api api="$IMAJ"
    - kubectl -n "$NAMESPACE" rollout status deployment/deploy-api --timeout=180s

staging:
  extends: .deploy
  needs: [imaj]
  variables:
    NAMESPACE: staging
    KUBE_CONTEXT: sirket/platform/kume-ajani:staging
  environment:
    name: staging
    url: https://deploy-api.staging.ornek.com
    deployment_tier: staging
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/

production:
  extends: .deploy
  needs: [imaj, staging]
  variables:
    NAMESPACE: production
    KUBE_CONTEXT: sirket/platform/kume-ajani:production
  environment:
    name: production
    url: https://deploy-api.ornek.com
    deployment_tier: production
  rules:
    - if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/
      when: manual
```

Akış:

- **`main`'e her birleştirme** → test → imaj → otomatik staging deploy.
- **Sürüm etiketi** (`v1.4.0`) → test → imaj → staging → production için **elle onay** (`when: manual`). Aynı imaj, staging'de doğrulanıp production'a terfi eder (React kursundaki "bir kez build et, her yere deploy et").
- Deploy imajı, ekibin **kendi registry'sinde** tuttuğu, `kubectl` ve bir kabuk içeren, sürümü sabit bir araç imajı. Pipeline'ları üçüncü parti imajların etiket politikalarına bağlamamak için iyi bir pratik: Örneğin Bitnami, 2025'te Docker Hub'daki ücretsiz sürüm etiketli imajlarının çoğunu yayınlamayı bıraktı ve onlara dayanan pipeline'lar bir gün aniden kırıldı. Araç imajları da imaj taramasından geçer ve düzenli güncellenir.
- `rollout status`: Deploy, pod'lar hazır olana kadar (readiness probe'ları geçene kadar) başarılı sayılmaz. Yeni sürüm çöküyorsa job başarısız olur ve ekip hemen görür.
- `resource_group`: Aynı ortama aynı anda iki deploy olmaz. Peş peşe iki birleştirme olduğunda ikinci deploy birincinin bitmesini bekler. Paralel `kubectl` komutlarının birbirini ezmesi önlenir.
- Ortam sayfasında her deploy listelenir, ve bir önceki deploy'a **tek tıkla geri dönüş** (rollback: önceki deploy job'unu yeniden çalıştırmak) vardır.
- **Protected environments** (Premium): production deploy'unu sadece belirli kişiler ya da gruplar başlatabilir/onaylayabilir.

### Simülasyonun yakaladığı hata

Bu pipeline'ın ilk halinde `staging` sadece `main`'de çalışıyordu:

```yaml
staging:
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH       # sadece main
production:
  needs: [imaj, staging]
  rules:
    - if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/
```

Etiket pipeline'ında `staging` job'u **oluşmaz**, ama `production` ona `needs` ile bağlı. GitLab böyle bir pipeline'ı oluşturmayı reddeder: "'production' job needs 'staging' job, but 'staging' is not in any previous stage". Yani sürüm etiketi atıldığında hiçbir şey çalışmaz. Bir betikle iki olayı simüle ettiğimizde:

```text
main {'birim-test': 'on_success', 'imaj': 'on_success', 'staging': 'on_success', 'production': None}
tag  {'birim-test': 'on_success', 'imaj': 'on_success', 'staging': 'on_success', 'production': 'manual'}
```

(düzeltilmiş hali) her iki olayda `needs` zinciri tam. Ders: `rules` ile `needs` birlikte kullanıldığında, **her olay türü için** hangi job'ların oluştuğunu kontrol et. Bir job'un başka bir pipeline türünde var olmayabileceği durumlar için `needs: [{job: staging, optional: true}]` de kullanılabilir, ama burada staging'i atlamak zaten istenmeyen bir şeydi.

### Kümeye erişim: GitLab agent ya da GitOps

`KUBE_CONTEXT: sirket/platform/kume-ajani:staging`, **GitLab agent for Kubernetes**'in sağladığı bir bağlamdır: Kümede çalışan bir ajan (`agentk`) GitLab'a **dışarıya doğru** bağlanır, ve izin verilen projelerin job'larına bir kubeconfig bağlamı verir. Kümenin API sunucusunu internete açmak ya da CI değişkenlerinde uzun süreli bir kubeconfig saklamak gerekmez. Ajanın yetkileri, Kubernetes RBAC ile (Kubernetes kursundaki RBAC dersi) sadece ilgili namespace'lerle sınırlanmalı.

Alternatif, **GitOps** (Kubernetes kursundaki Argo CD/Flux dersi): Pipeline kümeye hiç dokunmaz, sadece bir yapılandırma deposunda imaj etiketini günceller (`kustomize edit set image`, bir MR ya da commit), kümedeki GitOps aracı değişikliği görüp uygular. Avantajları: Kümenin istenen durumu her zaman Git'te, pipeline'ın küme kimlik bilgisi yok, ve geri dönüş bir `git revert`. Çok kümeli ya da düzenleyici gereksinimli ortamlarda genellikle tercih edilir.

## Büyük pipeline'ları düzenlemek

- **`include`**: Ortak job tanımlarını ayrı dosyalara ya da ortak bir "CI şablonları" projesine koy, her proje onları içersin:

```yaml
include:
  - project: sirket/platform/ci-sablonlari
    ref: v3.2.0                       # şablonları da sürümle: bir değişiklik bütün projeleri bozmasın
    file: [/node.yml, /deploy.yml]
```

- **CI/CD Components** ve **Catalog**: Girdi parametreleri (`spec:inputs`) olan, sürümlenen, yeniden kullanılabilir pipeline bileşenleri. Ortak şablonların modern yolu.
- **Parent-child pipeline'lar** (`trigger: include:`): Monorepo'da her servisin kendi pipeline'ı, `rules:changes` ile sadece değişen servisler tetiklenir.
- **Multi-project pipeline'lar** (`trigger: project:`): Bir projenin pipeline'ı başka bir projeninkini başlatır (örneğin bir kütüphane yayınlanınca onu kullanan servislerin testleri).
- **Zamanlanmış pipeline'lar** (Build → Pipeline schedules): Gecelik güvenlik taramaları, uzun testler, bağımlılık güncellemeleri.

## Alıştırma

1. Production deploy'undan sonra sağlık ucunu kontrol edip, dönen sürüm beklenen sürüm değilse job'u başarısız yapan bir adım ekle.
2. Ekip, staging deploy'unun MR'lar için de olmasını istiyor: Her MR kendi geçici ortamına (review app) deploy edilsin. Ortamın adı ve temizliği nasıl olmalı?
3. Bir geliştirici `docker:dind` ve `privileged = true` ile paylaşılan bir runner kullanmak istiyor. Riskini açıkla ve alternatif öner.

<details><summary>Çözüm</summary>

1. `.deploy`'un `script`'ine (ya da production'a `after_script` değil, `script`'in sonuna):

```yaml
    - |
      beklenen="${CI_COMMIT_TAG:-$CI_COMMIT_SHORT_SHA}"
      for i in 1 2 3 4 5 6; do
        gelen=$(wget -qO- "$CI_ENVIRONMENT_URL/healthz" | sed -n 's/.*"surum":"\([^"]*\)".*/\1/p')
        [ "$gelen" = "$beklenen" ] && echo "doğrulandı: $gelen" && exit 0
        echo "bekleniyor (gelen: $gelen)"; sleep 10
      done
      echo "sürüm doğrulanamadı" >&2; exit 1
```

`CI_ENVIRONMENT_URL`, `environment:url` değeridir. Birkaç kez denemek, ingress ve önbelleklerin yeni pod'lara geçmesine zaman tanır. Bu bir **duman testidir** (smoke test): Daha kapsamlı kontroller (React kursundaki Playwright duman testleri) aynı yerde çalışabilir.

2. Ortam adı dala göre dinamik: `environment: name: review/$CI_COMMIT_REF_SLUG`, `url: https://$CI_COMMIT_REF_SLUG.review.ornek.com`, ve `on_stop: review-durdur` ile bir durdurma job'u. Durdurma job'u (`environment: action: stop`, `when: manual`) namespace'i siler; MR birleşince ya da dal silinince GitLab onu otomatik çalıştırır. Ayrıca `auto_stop_in: 2 days`: Unutulan ortamlar kümeyi doldurmasın. Her review ortamı ayrı bir namespace'te, kaynak kotalarıyla (Kubernetes kursu).

3. `privileged = true`, job konteynerinin çekirdek seviyesinde neredeyse bütün yetkilere sahip olması demektir: Runner makinesine kaçabilir, aynı runner'da çalışan **başka projelerin** job'larını, önbelleklerini ve gizli bilgilerini okuyabilir. Paylaşılan bir runner'da bu, bir projedeki zararlı bir bağımlılığın (tedarik zinciri saldırısı) bütün projeleri ele geçirmesi demektir. Alternatifler: BuildKit rootless ya da Buildah ile ayrıcalıksız build (bu dersteki gibi), ya da privileged gerçekten gerekiyorsa o projeye **ayrılmış**, tek kullanımlık (her job'da yeniden oluşturulan) bir runner.

</details>

```quiz
CI'da konteyner imajı build ederken en düşük riskli yöntem hangisidir?
- Runner'ın Docker soketini job'a bağlamak
- Privileged Docker-in-Docker
- [x] BuildKit rootless ya da Buildah gibi daemonsuz, ayrıcalıksız bir build aracı
? Privileged mod ve soket bağlama, job'a runner makinesinin tamamına erişim verir.
```

```quiz
`production` job'u `needs: [staging]` içeriyor ama staging sadece main'de çalışıyor. Etiket pipeline'ında ne olur?
- production staging'i beklemeden çalışır
- [x] Pipeline oluşturulamaz: production'ın ihtiyaç duyduğu job bu pipeline'da yok
- staging otomatik eklenir
? rules ile needs birlikte kullanıldığında her olay türü için job listesini kontrol et; gerekirse `optional: true`.
```

```quiz
GitOps ile deploy'un pipeline'dan doğrudan kubectl ile deploy'a göre bir avantajı?
- Daha hızlıdır
- [x] Pipeline'ın küme kimlik bilgisine ihtiyacı yoktur, istenen durum Git'te durur ve geri dönüş bir git revert'tür
- Test gerekmez
? Pipeline sadece yapılandırma deposundaki imaj etiketini günceller; kümedeki araç uygular.
```

## Özet

- Dockerfile: çok aşamalı, root olmayan kullanıcı, sürüm bilgisi gömülü, healthcheck.
- CI'da build: rootless BuildKit/Buildah; privileged dind ve soket bağlamadan kaçın. Registry kimlik bilgileri job'a özel (`CI_REGISTRY_*`), katman önbelleği registry'de.
- İmaj etiketi commit hash'i, `latest` deploy edilmez, registry cleanup policy.
- Hazır güvenlik şablonları: secret detection, SAST, dependency ve container scanning; MR entegrasyonu ve engelleme politikaları üst katmanlarda.
- Ortamlar: `environment:name/url/deployment_tier`, `rollout status`, `resource_group`, elle production onayı, tek tıkla geri dönüş.
- `rules` + `needs`: her olay türünde zincirin tam olduğunu kontrol et.
- Kümeye erişim: GitLab agent (dışarıya bağlantı, RBAC ile sınırlı) ya da GitOps.
- Büyük kurulumlar: sürümlü `include`, CI/CD components, parent-child ve multi-project pipeline'lar, zamanlanmış pipeline'lar.
