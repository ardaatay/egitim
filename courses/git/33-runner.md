# GitLab Runner: kurulum, executor'lar ve güvenlik

Pipeline'lar GitLab'ın kendisinde değil, **runner**'larda çalışır: GitLab'a bağlanıp iş bekleyen, gelen job'u bir ortamda (bir konteyner, bir pod, bir sanal makine) çalıştırıp sonucu geri gönderen ajanlar. GitLab.com'un paylaşılan runner'ları başlamak için yeterlidir, ama kendi runner'ın şunlar için gerekir: dakika sınırı ve maliyet, iç ağdaki kaynaklara erişim (veritabanı, iç registry, kümeler), özel donanım (GPU, ARM), ve güvenlik izolasyonu. Bu derste runner'ın mimarisini, executor seçimini, Linux ve Kubernetes üzerine kurulumu, ve en önemlisi runner güvenliğini ele alıyoruz.

> **Dikkat:** Bu dersteki yapılandırma dosyaları (`config.toml` ve Helm values) sözdizimi açısından TOML ve YAML ayrıştırıcılarıyla doğrulandı, ama bu ortamda bir runner kurulup bir GitLab'a bağlanmadı. Kurulum komutları GitLab'ın belgelendirdiği yöntemlerdir; kendi ortamında sürüm numaralarını güncel belgelere göre kontrol et.

## Mimari

```text
GitLab ◀──── HTTPS (runner bağlanır, iş ister) ──── gitlab-runner (Linux servisi ya da pod)
  │                                                     │
  │  job: script, imaj, değişkenler, CI_JOB_TOKEN        ▼
  └──────────────────────────────────────────────▶ executor: job'u çalıştıran ortam
                                                     (docker konteyneri, Kubernetes pod'u, VM, kabuk)
```

Runner, GitLab'a **dışarıya doğru** bağlanır ve iş ister (polling). GitLab'dan runner'a gelen bir bağlantı yoktur: Runner'ı bir güvenlik duvarının arkasına, iç ağa koyabilirsin, sadece GitLab'a HTTPS ile çıkabilmesi yeterli. Job sırasında runner, kaynak kodu klonlar, artifact'leri ve cache'i indirip yükler, ve logları GitLab'a akıtır.

Runner'lar üç kapsamda olabilir: **instance** (bütün projeler; GitLab.com'da paylaşılan runner'lar), **grup** (bir grubun bütün projeleri), **proje**. Job'lar runner'larla **etiketler** (tags) üzerinden eşleşir: `tags: [docker, iç-ağ]` diyen bir job, bu etiketlere sahip bir runner'da çalışır.

## Executor seçimi

| Executor | Job nerede çalışır | Ne zaman |
|---|---|---|
| **Shell** | Runner makinesinde, runner kullanıcısıyla doğrudan | Neredeyse hiç: job'lar birbirinden izole değil, makinede iz bırakır |
| **Docker** | Her job için yeni bir konteyner | Tek makinede genel amaçlı CI, en yaygın başlangıç |
| **Kubernetes** | Her job için yeni bir pod | Zaten Kubernetes varsa; yatay ölçekleme, kaynak sınırları, namespace izolasyonu |
| **Docker Autoscaler / Instance** | Bulutta talebe göre açılıp kapanan VM'ler (fleeting eklentileri) | Yüksek ve değişken yük, job başına tam VM izolasyonu |
| VirtualBox, Parallels, SSH, Custom | Özel durumlar | macOS build'leri, eski sistemler |

Eski `docker+machine` executor'u (Docker Machine tabanlı otomatik ölçekleme) kullanımdan kaldırılıyor. Yerini Docker Autoscaler ve Instance executor'ları aldı.

## Linux'ta Docker executor ile kurulum

```bash
# GitLab'ın paket deposunu ekle ve kur (Debian/Ubuntu)
curl -L "https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh" | sudo bash
sudo apt-get install gitlab-runner
gitlab-runner --version
```

(Güvenlik kursunun ilkesiyle: Bir betiği doğrudan `bash`'e boru ile vermeden önce içeriğini indirip incelemek daha güvenlidir.)

**Kayıt.** GitLab 16'dan beri runner'lar arayüzde oluşturulur: **Settings → CI/CD → Runners → New project runner** (ya da grup/instance seviyesinde). Burada etiketleri, korumalı olup olmadığını ve açıklamayı seçersin, GitLab bir **runner kimlik doğrulama jetonu** (`glrt-` ile başlar) verir. Eski "registration token" akışı kullanımdan kaldırıldı. Sunucuda:

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url https://gitlab.com \
  --token glrt-XXXXXXXXXXXXXXXXXXXX \
  --executor docker \
  --docker-image alpine:3.22 \
  --description ci-docker-01
sudo gitlab-runner verify
sudo systemctl status gitlab-runner
```

Linux kursundaki systemd bilgisi burada geçerli: `gitlab-runner` bir systemd servisidir, logları `journalctl -u gitlab-runner -f` ile izlenir. Docker executor için makinede Docker kurulu olmalı ve `gitlab-runner` kullanıcısı Docker'a erişebilmelidir.

### config.toml

Kayıttan sonra yapılandırma `/etc/gitlab-runner/config.toml` dosyasındadır. Üretime uygun bir örnek:

```toml
concurrent = 4                 # bu süreçte aynı anda en fazla kaç job
check_interval = 3             # GitLab'a kaç saniyede bir iş sorulacak
shutdown_timeout = 300         # kapanışta çalışan job'ları bekleme süresi

[[runners]]
  name = "ci-docker-01"
  url = "https://gitlab.com"
  token = "glrt-XXXXXXXXXXXXXXXXXXXX"
  executor = "docker"
  limit = 4                    # bu runner girdisi için en fazla job
  output_limit = 8192          # log boyutu sınırı (KB)
  [runners.cache]
    Type = "s3"                # dağıtık cache: birden çok runner aynı cache'i paylaşsın
    Shared = true
    [runners.cache.s3]
      ServerAddress = "s3.eu-central-1.amazonaws.com"
      BucketName = "sirket-gitlab-runner-cache"
      BucketLocation = "eu-central-1"
      AuthenticationType = "iam"   # anahtar değil, makinenin IAM rolü
  [runners.docker]
    image = "alpine:3.22"
    privileged = false
    volumes = ["/cache"]
    pull_policy = ["if-not-present"]
    allowed_pull_policies = ["always", "if-not-present"]
    allowed_images = ["registry.gitlab.com/sirket/**", "node:*-alpine", "moby/buildkit:*-rootless", "alpine:*"]
    cpus = "2"
    memory = "4g"
```

Önemli ayarlar:

- **`concurrent` ve `limit`**: Makinenin kaynaklarına göre. Her job'a `cpus` ve `memory` sınırı ver: Sınırsız bir job (bir bellek sızıntısı, sonsuz döngüdeki bir test) makinedeki diğer job'ları da öldürür (Docker kursundaki kaynak sınırları dersi).
- **`privileged = false`**: Varsayılan değeri koru. Bir sonraki bölümde neden.
- **`allowed_images`**: Job'ların hangi imajları kullanabileceği. Bir job'un rastgele bir Docker Hub imajını (belki ele geçirilmiş, belki bir kripto madencisi) çalıştırmasını önler.
- **`pull_policy`**: `always` her job'da imajı çeker (güncel ama yavaş, Docker Hub hız sınırlarına takılır), `if-not-present` yerel önbelleği kullanır. `allowed_pull_policies` job'ların hangi politikayı isteyebileceğini sınırlar.
- **Dağıtık cache** (S3, GCS, Azure): Runner'lar geçiciyse ya da birden çoksa, cache'in her job'da kaybolmaması için.
- `token` bu dosyada düz metin: Dosya izinleri `600`, sahibi root. Yapılandırma yönetimi (Ansible) ile dağıtılıyorsa jeton bir secret deposundan gelmeli.

Yapılandırma değişikliklerinden sonra runner dosyayı kendisi yeniden yükler (birkaç saniye içinde), yeniden başlatma gerekmez.

## Kubernetes executor

Kubernetes kümesi zaten varsa, runner'ı resmi Helm chart'ıyla kurmak en esnek yoldur. Her job, `gitlab-ci` namespace'inde ayrı bir pod olarak çalışır:

```yaml
# runner-values.yaml
gitlabUrl: https://gitlab.com/
concurrent: 10
checkInterval: 3
rbac:
  create: true
serviceAccount:
  create: true
runners:
  secret: gitlab-runner-token          # jeton bir Kubernetes Secret'ta
  config: |
    [[runners]]
      [runners.kubernetes]
        namespace = "gitlab-ci"
        image = "alpine:3.22"
        privileged = false
        cpu_request = "500m"
        memory_request = "512Mi"
        cpu_limit = "2"
        memory_limit = "4Gi"
        helper_cpu_request = "100m"
        helper_memory_request = "128Mi"
        service_account = "ci-job"
        poll_timeout = 600
        [runners.kubernetes.pod_security_context]
          run_as_non_root = true
          run_as_user = 1000
        [runners.kubernetes.node_selector]
          "node-role/ci" = "true"
        [[runners.kubernetes.node_tolerations]]
          key = "ci"
          operator = "Equal"
          value = "true"
          effect = "NoSchedule"
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    memory: 256Mi
metrics:
  enabled: true
```

```bash
kubectl create namespace gitlab-ci
kubectl -n gitlab-ci create secret generic gitlab-runner-token \
  --from-literal=runner-token=glrt-XXXXXXXXXXXXXXXXXXXX --from-literal=runner-registration-token=""
helm repo add gitlab https://charts.gitlab.io
helm upgrade --install gitlab-runner gitlab/gitlab-runner -n gitlab-ci -f runner-values.yaml
```

Kubernetes kursuyla bağlantılar:

- **Ayrı düğüm havuzu** (`node_selector` + `tolerations`, zamanlama dersi): CI job'ları üretim pod'larıyla aynı düğümlerde çalışmasın. Ağır bir build, üretim servisinin CPU'sunu çalmasın, ve ele geçirilmiş bir job üretim pod'larıyla aynı makinede olmasın.
- **Kaynak istekleri ve sınırları** her job pod'unda (`cpu_request`, `memory_limit`), namespace'te `ResourceQuota` (aynı anda en fazla ne kadar CI).
- **Job'un servis hesabı** (`service_account = "ci-job"`): Varsayılan olarak hiçbir yetkisi olmamalı (RBAC dersi). Kümeye deploy edecek job'lar ayrı, dar yetkili bir hesap ya da GitLab agent kullanır (bir önceki ders).
- `pod_security_context` ile root olmayan kullanıcı, ve namespace'te Pod Security Admission `restricted` (güvenlik dersi).
- `metrics: enabled`: Runner, Prometheus metrikleri sunar (`gitlab_runner_jobs`, `gitlab_runner_concurrent`, hata sayıları): Gözlem dersindeki izleme yığınına eklenir. Bekleyen job sayısı sürekli yüksekse kapasite yetmiyordur.

## Runner güvenliği

Bir runner, ona job gönderen **her** projenin kodunu çalıştırır. O kod bir MR'dan geliyorsa, ona dış katkıcılar ya da ele geçirilmiş bir bağımlılık dokunmuş olabilir. Runner'ın bulunduğu ortamın neye erişebildiği, potansiyel olarak **her projenin** neye erişebildiğidir.

**1. Privileged mod yok.** `privileged = true`, job konteynerine çekirdek seviyesinde neredeyse sınırsız yetki verir: Konteynerden ana makineye kaçmak (cgroup'lar, cihazlar, mount'lar üzerinden) iyi bilinen tekniklerle mümkündür. Paylaşılan bir runner'da bu, bir projenin diğerlerinin job'larını, cache'lerini, gizli bilgilerini okuyabilmesi demektir. İmaj build'leri için bir önceki dersteki rootless BuildKit kullan. Privileged gerçekten gerekiyorsa, o projeye ayrılmış ve her job'da yeniden oluşturulan (ephemeral) bir runner.

**2. Docker soketini job'lara bağlama.** `volumes = ["/var/run/docker.sock:/var/run/docker.sock"]`, job'a makinedeki Docker daemon'unun tam kontrolünü verir: root'a eşdeğer. Linux kursundaki "docker grubu root demektir" uyarısının CI'daki karşılığı.

**3. Korumalı runner'lar.** Arayüzde "Protected" işaretlenen bir runner **sadece korumalı dallarda ve etiketlerde** çalışan job'ları alır. Production'a deploy eden, üretim ağına ya da gizli bilgilere erişen runner'lar her zaman korumalı olmalı: Bir özellik dalına push edilen bir commit, bu runner'a hiç ulaşamaz. Korumalı CI değişkenleriyle (CI temelleri dersi) birlikte, iki katmanlı bir koruma oluşur.

**4. Ayrı runner'lar, ayrı güven seviyeleri.** Tek bir "her şeyi yapan" runner yerine:

| Runner | Etiket | Korumalı | Erişim |
|---|---|---|---|
| Genel CI (test, lint, build) | `docker` | Hayır | Sadece internet ve registry |
| Staging deploy | `deploy-staging` | Hayır (ya da evet) | Staging ağı |
| Production deploy | `deploy-production` | **Evet** | Production ağı, sadece etiket pipeline'ları |
| Fork MR'ları (açık kaynak projeler) | `public` | Hayır | Hiçbir iç kaynak, tek kullanımlık VM |

**5. Tek kullanımlık ortamlar.** Docker ve Kubernetes executor'larında her job yeni bir konteyner/pod'dur, ama makine ve önbellek paylaşılır. En yüksek izolasyon için Autoscaler/Instance executor'larıyla job başına yeni bir VM: Bir job'un bıraktığı hiçbir şey sonrakine ulaşmaz.

**6. Runner'ı güncel tut.** Runner ve helper imajı güvenlik güncellemeleri alır. Runner sürümünün GitLab sürümüyle uyumlu olması gerekir (aynı ana ve ara sürüm önerilir). Güncellemeler bir bakım işi olarak planlanmalı.

**7. İzle.** Runner makinesinde beklenmeyen süreçler, yüksek ağ çıkışı (kripto madenciliği ya da veri sızdırma), job sürelerindeki ani artışlar.

## Sorun giderme

| Belirti | Bakılacak yer |
|---|---|
| Job "pending" kalıyor, "no runners that match all of the job's tags" | Job'un `tags`'i ile runner'ın etiketleri; runner korumalı mı ve dal korumasız mı; runner "paused" mı; "Run untagged jobs" ayarı |
| Runner arayüzde gri/çevrimdışı | `systemctl status gitlab-runner`, `journalctl -u gitlab-runner`, GitLab'a çıkış (proxy, DNS: Oracle kursundaki yavaş isim çözümleme dersini hatırla), jeton iptal edilmiş mi |
| Job `ERROR: Job failed: exit code 137` | Bellek sınırı aşıldı (OOM killer; Docker kursu). Job'un `memory` sınırını ya da testin bellek kullanımını incele |
| "toomanyrequests" imaj çekerken | Docker Hub hız sınırı: `if-not-present`, bir registry önbelleği (pull-through cache), ya da imajları kendi registry'ne kopyala |
| Kubernetes job pod'u "Pending" | `kubectl -n gitlab-ci describe pod`: yetersiz kaynak, toleration eksik, ResourceQuota dolu |

## Alıştırma

1. Ekibinin şu ihtiyaçları var: MR'larda test ve build (saatte yaklaşık 40 job), main'den staging'e deploy, etiketlerden production'a deploy, ve iç ağdaki bir Oracle veritabanına karşı entegrasyon testleri. Kaç runner, hangi etiketler, hangileri korumalı?
2. `concurrent = 20` olan tek bir 8 çekirdekli makinede job'ların bazen yavaşladığı, bazen 137 koduyla öldüğü şikâyet ediliyor. Ne yaparsın?
3. Açık kaynak bir projeye dışarıdan bir MR geldi ve `.gitlab-ci.yml`'i değiştiriyor. Bu MR'ın pipeline'ı hangi runner'da, hangi değişkenlerle çalışmalı?

<details><summary>Çözüm</summary>

1. Üç runner (ya da runner grubu): (a) **Genel CI**, Docker ya da Kubernetes executor, etiket `docker`, korumasız, sadece internet/registry erişimi; MR yüküne göre `concurrent`. (b) **Entegrasyon testi runner'ı**, etiket `ic-ag`, iç ağa (Oracle'a) erişimi olan, korumasız ama sadece bu grubun projelerine atanmış, ve test veritabanına sadece test kullanıcısıyla (Oracle güvenlik dersi) erişen. Dışarıdan katkı alan projelere atanmamalı. (c) **Deploy runner'ı**, etiketler `deploy-staging` ve `deploy-production`; production için ayrı ve **korumalı** bir runner, sadece etiket pipeline'larını alır, ağ erişimi sadece kümenin API'sine (ya da GitLab agent kullanılıyorsa hiçbir küme erişimi gerekmez).

2. 8 çekirdekte 20 eşzamanlı job, CPU çekişmesi ve bellek yetersizliği demek. `concurrent`'i makinenin kaldırabileceği seviyeye indir (örneğin job başına 2 CPU / 4 GB varsayımıyla 4), her job'a `cpus` ve `memory` sınırı koy (137 alan job'un hangisi olduğu belli olsun, diğerlerini öldürmesin), ve gerçek ihtiyaç için yatay ölçekle: ikinci bir makine ya da Kubernetes/Autoscaler executor. Runner metriklerinden bekleyen job sayısını izleyip kapasiteyi ona göre ayarla.

3. Fork'tan gelen MR'ların pipeline'ları varsayılan olarak **fork projesinin** bağlamında, fork'un runner'larında ve fork'un değişkenleriyle çalışır: Ana projenin gizli bilgilerini almaz. Bir Maintainer, kodu inceledikten sonra pipeline'ı ana projede çalıştırmayı seçebilir. Bu durumda pipeline ana projenin runner'larını ve değişkenlerini kullanır, ve MR `.gitlab-ci.yml`'i değiştiriyorsa **o değişikliği** çalıştırır (örneğin değişkenleri dışarı gönderen bir adım). Bu yüzden önce `.gitlab-ci.yml` ve betik değişiklikleri incelenmeli. Ana projede çalıştırılacaksa, iç kaynaklara erişimi olmayan, tek kullanımlık ve korumasız bir runner'da; korumalı değişkenler zaten verilmez (dal korumalı değil).

</details>

```quiz
Bir runner GitLab'a nasıl bağlanır?
- GitLab, runner'ın açık bir portuna bağlanır
- [x] Runner GitLab'a dışarıya doğru HTTPS ile bağlanıp iş ister; runner iç ağda, bir güvenlik duvarının arkasında olabilir
- SSH ile
? GitLab'dan runner'a gelen bir bağlantı gerekmez.
```

```quiz
Production'a deploy eden runner neden "Protected" olmalıdır?
- Daha hızlı çalışır
- [x] Sadece korumalı dallarda ve etiketlerde çalışan job'ları alır; bir özellik dalındaki commit bu runner'a ve onun erişimlerine ulaşamaz
- Paylaşılan runner'lar korumalı olamaz
? Korumalı CI değişkenleriyle birlikte iki katmanlı koruma sağlar.
```

```quiz
Paylaşılan bir runner'da `privileged = true` neden tehlikelidir?
- Job'lar yavaşlar
- [x] Job konteyneri ana makineye kaçabilir; aynı runner'daki diğer projelerin job'larına, cache'lerine ve gizli bilgilerine erişebilir
- Docker imajları çekilemez
? İmaj build için rootless araçlar kullan; privileged gerekiyorsa ayrılmış, tek kullanımlık runner.
```

## Özet

- Runner GitLab'a dışarıya doğru bağlanıp iş ister; instance/grup/proje kapsamı; job'lar etiketlerle eşleşir.
- Executor'lar: shell (izolasyon yok), Docker (en yaygın), Kubernetes (ölçekleme, namespace), Docker Autoscaler/Instance (job başına VM). Docker Machine kullanımdan kalkıyor.
- Kurulum: paket deposu, arayüzde runner oluştur, `glrt-` jetonuyla `register`, systemd servisi. `config.toml`: `concurrent`, `limit`, job başına `cpus`/`memory`, `allowed_images`, `pull_policy`, dağıtık cache, `privileged = false`.
- Kubernetes: Helm chart, ayrı düğüm havuzu, kaynak sınırları ve kotalar, yetkisiz servis hesabı, root olmayan pod'lar, Prometheus metrikleri.
- Güvenlik: privileged ve Docker soketi yok, production için korumalı runner, güven seviyesine göre ayrı runner'lar, tek kullanımlık ortamlar, güncel tut ve izle.
- Sorun giderme: pending (etiket/korumalı/paused), çevrimdışı (journalctl, ağ, DNS), 137 (bellek), hız sınırı (pull policy, önbellek).

Tebrikler, Git ve GitLab kursunu bitirdin. Git'in iç modelinden ekip akışlarına, merge request'lerden bir kodu test edip imaja çeviren ve kümeye yayınlayan pipeline'lara kadar bütün zincir elinde.
