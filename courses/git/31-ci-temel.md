# GitLab CI/CD temelleri: stage, job, rules, artifact ve cache

GitLab CI/CD, depodaki `.gitlab-ci.yml` dosyasını okuyup her push'ta, her merge request'te ya da her etikette bir **pipeline** çalıştırır. Pipeline'ı tanımlayan dosya kodla birlikte sürümlenir: Bir MR hem kodu hem onu test eden ve yayınlayan süreci birlikte değiştirebilir. Bu derste bir Node.js servisi için gerçekçi bir pipeline'ı adım adım kuruyoruz: stage'ler ve job'lar, ne zaman çalışacaklarını belirleyen kurallar, aralarında dosya taşıyan artifact'ler, hızlandıran cache, ve değişkenler.

> **Dikkat:** Bu dersteki pipeline dosyası canlı bir GitLab'da çalıştırılmadı. Job'ların çalıştırdığı komutlar (`npm ci`, `npm run lint`, `npm test`, sürüm dosyası üretimi) yerelde çalıştırılıp çıktıları alındı, ve YAML dosyası sözdizimi ile yapı (stage, `needs`, `extends` referansları) açısından bir betikle kontrol edildi. Kendi projende GitLab'ın **Build → Pipeline editor** ekranındaki doğrulayıcıyı ve "Validate" sekmesini kullan: Bütün kuralları GitLab'ın kendi yorumlayıcısıyla kontrol eder.

## Örnek servis

```text
deploy-api/
├── package.json
├── package-lock.json
├── src/app.js
├── src/server.js
└── test/app.test.js
```

```json
{
  "name": "deploy-api",
  "version": "1.4.0",
  "type": "module",
  "scripts": {
    "lint": "node --check src/app.js && node --check src/server.js",
    "test": "node --test --test-reporter=spec --test-reporter=junit --test-reporter-destination=stdout --test-reporter-destination=junit.xml",
    "start": "node src/server.js"
  }
}
```

```js
// src/app.js
export function saglik() {
  return { durum: "ok", surum: process.env.APP_SURUM ?? "dev" };
}
export function sureFormatla(sn) {
  if (sn < 60) return `${sn} sn`;
  return `${Math.floor(sn / 60)} dk ${sn % 60} sn`;
}
```

```js
// test/app.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { saglik, sureFormatla } from "../src/app.js";

test("sağlık ucu ok döner", () => {
  assert.equal(saglik().durum, "ok");
});
test("süre biçimi", () => {
  assert.equal(sureFormatla(45), "45 sn");
  assert.equal(sureFormatla(125), "2 dk 5 sn");
});
```

Job'ların yapacağı işi önce yerelde çalıştır:

```bash
npm ci
npm run lint
npm test
```

```text
✔ sağlık ucu ok döner (0.6895ms)
✔ süre biçimi (0.1483ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

Testler hem konsola (spec) hem `junit.xml` dosyasına yazıyor: GitLab bu dosyayı okuyup sonuçları MR sayfasında gösterecek. Kural: **CI'daki her adım yerelde de tek bir komutla çalışabilmeli.** Pipeline dosyasının içine 40 satırlık betikler yazmak, hata ayıklamayı "push et ve bekle" döngüsüne çevirir.

## Pipeline'ın anatomisi

```yaml
stages:          # sırayla çalışan aşamalar
  - kontrol
  - test
  - paket

lint:            # bir job
  stage: kontrol
  image: node:22-alpine
  script:
    - npm run lint
```

- **Job**: Bir **runner** üzerinde, belirtilen konteyner imajında (`image`) çalışan bir komut listesi (`script`). Her job **temiz** bir ortamda başlar: Depo klonlanır (ya da önceki klon güncellenir), önceki job'ların dosyaları yoktur (artifact ile taşınmadıkça). Komutlardan biri sıfırdan farklı çıkış koduyla biterse job başarısız olur.
- **Stage**: Varsayılan olarak bir stage'in bütün job'ları paralel çalışır, bir sonraki stage öncekinin bütün job'ları bitince başlar. Bir job başarısız olursa sonraki stage'ler çalışmaz.
- **`needs`**: Stage sırasını beklemeden, sadece belirtilen job'lar bitince başla. Pipeline bir sıralı aşamalar listesi yerine bir **bağımlılık çizgesine** (DAG) dönüşür ve hızlanır. `needs: []` "hiçbir şeyi bekleme" demektir.

## Tam pipeline

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_COMMIT_TAG

stages:
  - kontrol
  - test
  - paket

default:
  image: node:22-alpine
  interruptible: true
  retry:
    max: 2
    when: [runner_system_failure, stuck_or_timeout_failure]

variables:
  npm_config_cache: "$CI_PROJECT_DIR/.npm"

.node_onbellek:
  cache:
    key:
      files: [package-lock.json]
    paths: [.npm/]
    policy: pull

bagimliliklar:
  stage: kontrol
  extends: .node_onbellek
  cache:
    policy: pull-push
  script:
    - npm ci --prefer-offline
  artifacts:
    paths: [node_modules/]
    expire_in: 1 hour

lint:
  stage: kontrol
  needs: []
  script:
    - npm run lint

birim-test:
  stage: test
  needs: [bagimliliklar]
  script:
    - npm test
  artifacts:
    when: always
    reports:
      junit: junit.xml
    expire_in: 1 week
  timeout: 10m

surum-bilgisi:
  stage: paket
  needs: [birim-test]
  script:
    - echo "{\"surum\":\"${CI_COMMIT_TAG:-$CI_COMMIT_SHORT_SHA}\",\"commit\":\"$CI_COMMIT_SHA\"}" > version.json
    - cat version.json
  artifacts:
    paths: [version.json]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_COMMIT_TAG

yuk-testi:
  stage: test
  needs: [bagimliliklar]
  script:
    - echo "yük testi"
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        paths: [src/**/*]
      when: manual
      allow_failure: true
```

Parça parça inceleyelim.

### workflow:rules: pipeline ne zaman oluşur?

Kurallar olmadan, bir dala push edildiğinde **ve** o dalın bir MR'ı varsa, aynı commit için **iki** pipeline oluşur (biri dal için, biri MR için). Bu `workflow:rules` bloğu GitLab'ın önerdiği kalıptır:

1. MR olaylarında pipeline oluştur.
2. Bir dala push edildiyse ama o dalın açık bir MR'ı varsa, dal pipeline'ını **oluşturma** (`when: never`): MR pipeline'ı zaten çalışacak.
3. Varsayılan dala (`main`) push'larda oluştur.
4. Etiketlerde oluştur (yayın pipeline'ı).

MR'ı olmayan bir özellik dalına push edildiğinde hiçbir kural eşleşmez ve pipeline oluşmaz. İstersen ayrı bir kural ekle. Kurallar **yukarıdan aşağıya** değerlendirilir, ilk eşleşen kazanır.

### default ve şablonlar

- `default`: Bütün job'lara uygulanan varsayılanlar: imaj, `interruptible` (aynı dala yeni bir commit gelince eski, gereksiz pipeline'lar iptal edilsin; proje ayarlarındaki "auto-cancel redundant pipelines" ile birlikte çalışır), `retry` (sadece **altyapı** hatalarında yeniden dene: Test hatasında yeniden denemek kırılgan testleri gizler).
- `.node_onbellek`: Nokta ile başlayan anahtarlar **gizli job'lardır**: Çalışmazlar, `extends` ile başka job'lara kopyalanırlar. YAML çapaları (`&` ve `*`) da kullanılabilir, ama `extends` iç içe anahtarları birleştirdiği için daha esnektir: `bagimliliklar` cache ayarlarını alıp sadece `policy`'yi değiştirdi.

### Cache ve artifact: ikisi farklı şeyler

| | Cache | Artifact |
|---|---|---|
| Amaç | Hızlandırmak (indirilen bağımlılıklar) | Job'lar arasında **sonuç** taşımak, saklamak |
| Garantisi | Yok: olmayabilir, eski olabilir | Var: belirtilen job'lara mutlaka iletilir |
| Nerede | Runner'da ya da paylaşılan depolamada (S3) | GitLab'da, indirilebilir |
| Örnek | `~/.npm`, `.m2/`, `pip` önbelleği | `node_modules` (bu pipeline'da), `dist/`, `junit.xml`, `coverage/` |

- Cache anahtarı `package-lock.json`'un içeriğinden türetiliyor (`key: files:`): Bağımlılıklar değişince yeni bir cache oluşur, değişmedikçe aynısı kullanılır.
- `policy: pull`: Cache'i indir ama geri yükleme. Sadece `bagimliliklar` job'u `pull-push` yapıyor: Paralel çalışan onlarca job'un aynı cache'i aynı anda geri yüklemeye çalışması önleniyor.
- `bagimliliklar` `node_modules`'u **artifact** olarak yayınlıyor, ve `needs: [bagimliliklar]` olan job'lar onu otomatik alıyor. `expire_in: 1 hour`: Ara artifact'leri uzun süre saklamak depolama doldurur.
- `artifacts:reports:junit`: GitLab bu dosyayı ayrıştırır ve MR'da "2 test geçti, şu test yeni başarısız" gibi bir özet gösterir. `when: always`: Testler başarısız olsa bile rapor yüklensin (en çok başarısızlıkta lazım).

Bu kadar küçük bir projede `node_modules`'u artifact olarak taşımak yerine her job'da `npm ci` (cache ile birkaç saniye) daha basit olabilir. Büyük bağımlılık ağaçlarında, bir kez kurup taşımak toplam süreyi azaltır. Ölç ve seç.

### rules: job ne zaman çalışır?

- `surum-bilgisi`: Sadece `main`'de ve etiketlerde. MR pipeline'larında gereksiz. İçindeki `${CI_COMMIT_TAG:-$CI_COMMIT_SHORT_SHA}`: Etiket varsa etiket adı, yoksa kısa commit hash'i. Yerelde denendi:

```bash
CI_COMMIT_SHORT_SHA=a1b2c3d CI_COMMIT_SHA=a1b2c3d4e5f6 sh -c \
  'echo "{\"surum\":\"${CI_COMMIT_TAG:-$CI_COMMIT_SHORT_SHA}\",\"commit\":\"$CI_COMMIT_SHA\"}"'
CI_COMMIT_TAG=v1.4.0 CI_COMMIT_SHA=a1b2 sh -c \
  'echo "{\"surum\":\"${CI_COMMIT_TAG:-$CI_COMMIT_SHORT_SHA}\",\"commit\":\"$CI_COMMIT_SHA\"}"'
```

```text
{"surum":"a1b2c3d","commit":"a1b2c3d4e5f6"}
{"surum":"v1.4.0","commit":"a1b2"}
```

- `yuk-testi`: Sadece MR'larda, sadece `src/` altında bir değişiklik varsa, ve **elle** başlatılır (`when: manual`). `allow_failure: true`: Başlatılmasa ya da başarısız olsa bile pipeline başarılı sayılır (manuel job'larda varsayılan budur, açıkça yazmak okunurluğu artırır). Monorepo'larda `rules:changes`, sadece değişen servislerin job'larını çalıştırmanın temel aracıdır.
- Eski `only:`/`except:` anahtarları yerine her zaman `rules:` kullan. İkisi aynı job'da birlikte kullanılamaz.

## Değişkenler

GitLab her job'a yüzlerce **önceden tanımlı değişken** verir: `CI_COMMIT_SHA`, `CI_COMMIT_REF_NAME`, `CI_PIPELINE_SOURCE`, `CI_DEFAULT_BRANCH`, `CI_PROJECT_DIR`, `CI_REGISTRY_IMAGE`, `CI_JOB_TOKEN`, `CI_MERGE_REQUEST_IID`... Hata ayıklarken bir job'da `env | sort` (dikkat: maskelenmemiş gizli bilgileri loga yazar, sadece güvenli projelerde) ya da GitLab belgelerindeki listeye bak.

Kendi değişkenlerin:

- `.gitlab-ci.yml`'de `variables:`: Gizli olmayan yapılandırma (yukarıdaki `npm_config_cache`).
- **Settings → CI/CD → Variables**: Gizli bilgiler. Seçenekler:
  - **Protected**: Sadece korumalı dallarda ve etiketlerde çalışan pipeline'lara verilir. Bir geliştiricinin özellik dalına `echo $PROD_DB_PAROLASI` yazan bir commit push etmesi böylece işe yaramaz. Üretim kimlik bilgileri **her zaman** protected olmalı.
  - **Masked** / **Masked and hidden**: Değer job loglarında `[MASKED]` olarak görünür. Ama maskeleme bir güvenlik sınırı değildir: Değeri base64'e çevirip yazdırmak, bir dosyaya yazıp artifact yapmak maskelemeyi atlatır. Asıl koruma "protected" ve kimin hangi dala push edebildiğidir.
  - **File** türü: Değer bir dosyaya yazılır, değişken dosyanın yolunu tutar (kubeconfig, sertifikalar).
- Ortam kapsamı (environment scope): Aynı değişkenin `staging` ve `production` için farklı değerleri.

Uzun süreli statik anahtarlar yerine, bulut sağlayıcılarına ve Vault'a **OIDC kimlik jetonlarıyla** (`id_tokens:`) kimlik doğrulamak giderek standart oluyor: Job, kısa ömürlü bir jeton alır ve onu sağlayıcıda geçici kimlik bilgileriyle değiştirir. Saklanacak bir gizli bilgi kalmaz (ileri CI dersi).

## Pipeline'ları hızlı tutmak

Yavaş bir pipeline, küçük ve sık MR'ları (akışlar dersi) cezalandırır. Ölçütler ve araçlar:

- **Hedef:** MR pipeline'ı 10 dakikanın altında. Daha uzun süren kontroller (uçtan uca testler, büyük yük testleri) `main`'de, zamanlanmış pipeline'larda ya da manuel job'larda.
- `needs` ile DAG: Bağımsız job'lar birbirini beklemesin.
- Cache anahtarlarını doğru seç, `policy: pull` ile gereksiz yüklemeleri önle.
- `interruptible` + "auto-cancel redundant pipelines".
- Sığ klon (`GIT_DEPTH`, varsayılan 20, büyük depolar dersi), gereksiz büyük imajlardan kaçın.
- `parallel: 4` ile bir test job'unu dört parçaya böl (test çatısı bölmeyi destekliyorsa).
- Pipeline süresini ve başarısızlık oranını izle: GitLab'ın **CI/CD analytics** ekranı. Sık "yeniden dene ile geçen" job'lar kırılgan testlerdir, düzeltilmeli.

## Alıştırma

1. Bu pipeline'a, sadece `main`'de çalışan ve `npm audit --audit-level=high` çalıştıran bir `guvenlik` job'u ekle. Açık bulunursa pipeline kırılmalı mı? Gerekçelendir.
2. Bir geliştirici "pipeline'ım MR'da hiç çalışmadı" diyor. `workflow:rules`'a bakarak olası iki sebebi söyle.
3. `PROD_DEPLOY_TOKEN` adında bir değişken tanımlanacak. Hangi seçenekleri işaretlersin? Bir geliştirici bu değişkeni bir özellik dalından okuyabilir mi?

<details><summary>Çözüm</summary>

1.

```yaml
guvenlik:
  stage: test
  needs: [bagimliliklar]
  script:
    - npm audit --audit-level=high
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

Kırılmalı mı? `main`'de kırılırsa, kodla ilgisi olmayan ve **yeni yayınlanan** bir açık yüzünden herkesin pipeline'ı aniden durur ve acil bir düzeltme deploy edilemez. Yaygın çözüm: `main`'de ve MR'larda bilgilendirici (`allow_failure: true`) çalıştırıp sonucu bir rapor olarak göstermek, ama zamanlanmış (gecelik) bir pipeline'da kırıcı yapıp ekibe bildirim göndermek. Kritik açıklar için ayrıca bir süre sınırı (SLA) koymak. GitLab'ın dependency scanning şablonu bunu rapor olarak MR'da gösterir (bir sonraki ders).

2. (a) MR yeni açıldı ama son commit'ten sonra MR açıldığı için o commit'in pipeline'ı dal kuralıyla oluşmadı: Bir sonraki push MR pipeline'ını tetikler, ya da MR sayfasından "Run pipeline". (b) `workflow:rules`'da MR kuralı yok ya da yanlış yazılmış (örneğin `$CI_PIPELINE_SOURCE == "merge_request"`; doğrusu `merge_request_event`), ve dal kuralı da `$CI_OPEN_MERGE_REQUESTS` yüzünden `never` döndü. Hiçbir kural eşleşmezse pipeline sessizce oluşmaz. Pipeline editor'ün "Validate" sekmesi, bir olay için hangi job'ların oluşacağını simüle eder.

3. **Protected** (sadece korumalı dallar/etiketler), **Masked and hidden**, ve uygunsa ortam kapsamı `production`. Protected olduğu için özellik dalındaki bir pipeline bu değişkeni **almaz**: Geliştirici onu okuyamaz. Bir geliştiricinin korumalı bir dala push etme ya da korumalı etiket oluşturma yetkisi yoksa, bu değişkene giden yol da kapalıdır. Bu, Maintainer rolünü az kişiye vermenin (önceki ders) bir sebebi daha.

</details>

```quiz
Cache ile artifact arasındaki temel fark nedir?
- İkisi aynıdır
- [x] Cache hızlandırmak içindir ve garantisi yoktur; artifact job sonuçlarını taşır ve belirtilen job'lara mutlaka iletilir
- Artifact sadece testler içindir
? Bağımlılık önbellekleri cache'e, derleme çıktıları ve raporlar artifact'e.
```

```quiz
Bir dala push edildiğinde aynı commit için hem dal hem MR pipeline'ı oluşuyor. Çözüm?
- Bir job'u silmek
- [x] workflow:rules ile açık MR'ı olan dallarda dal pipeline'ını engellemek (`$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS` → `when: never`)
- `interruptible: true`
? Kurallar yukarıdan aşağı değerlendirilir, ilk eşleşen kazanır.
```

```quiz
Üretim kimlik bilgisi içeren bir CI değişkeni için en önemli seçenek hangisidir?
- Masked
- [x] Protected: sadece korumalı dallarda ve etiketlerde çalışan pipeline'lar alır
- File
? Maskeleme atlatılabilir; asıl koruma, kimin korumalı dallara push edebildiğidir.
```

## Özet

- `.gitlab-ci.yml` kodla birlikte sürümlenir. Job = temiz bir ortamda komut listesi; stage'ler sıralı, job'lar paralel; `needs` ile DAG.
- Her adım yerelde tek komutla çalışabilmeli; YAML'a uzun betikler yazma.
- `workflow:rules` ile çift pipeline'ları önle; job'larda `rules` (`if`, `changes`, `when: manual`, `allow_failure`), `only/except` değil.
- `default`, gizli job'lar ve `extends` ile tekrarı azalt. `interruptible`, sadece altyapı hatalarında `retry`.
- Cache (hız, garantisiz, `key:files`, `policy: pull`) ≠ artifact (sonuçlar, `expire_in`, `reports:junit`).
- Önceden tanımlı değişkenler; gizli bilgiler Settings'te, **protected** + masked; kısa ömürlü kimlik için OIDC `id_tokens`.
- MR pipeline'ı 10 dakikanın altında; analytics ile kırılgan ve yavaş job'ları izle.
