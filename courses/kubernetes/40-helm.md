# Helm: chart kullanmak ve yazmak

Bir uygulamanın Kubernetes'te çalışması için şimdiye kadar gördüğümüz nesnelerin çoğu gerekir: Deployment, Service, ConfigMap, Secret, Ingress/HTTPRoute, PVC, NetworkPolicy, ServiceAccount... Aynı uygulamayı staging ve üretime, farklı replika sayıları, alan adları ve kaynak sınırlarıyla kurmak istediğinde, bu YAML dosyalarını kopyalayıp elle düzenlemek hızla yönetilemez hâle gelir. **Helm**, Kubernetes'in paket yöneticisidir: bir grup şablonlaştırılmış manifest'i (**chart**) değerlerle (**values**) birleştirip kümeye kurar, sürümlerini (**release**) takip eder, yükseltir ve geri alır.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
Helm yoksa: curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

## Kavramlar

| Kavram | Anlamı |
|---|---|
| **Chart** | Şablonlar + varsayılan değerler + meta veri. Bir klasör ya da `.tgz` paketi |
| **Values** | Şablonlara verilen ayarlar (`values.yaml`, `-f ortam.yaml`, `--set`) |
| **Release** | Bir chart'ın kümeye belirli bir adla kurulmuş örneği. Aynı chart birden fazla release olarak kurulabilir |
| **Revision** | Release'in her `install`/`upgrade`/`rollback` işleminde artan sürüm numarası |
| **Repository** | Chart'ların yayınlandığı yer: HTTP sunucusu ya da OCI registry (ghcr.io, Docker Hub) |

Helm 3'te kümede bir sunucu bileşeni yoktur: `helm` istemcisi şablonları yerelde işler, sonucu API sunucusuna gönderir ve release bilgisini o namespace'te bir Secret olarak saklar.

## Hazır chart kullanmak

```bash
helm version
helm repo add podinfo https://stefanprodan.github.io/podinfo
helm repo update
helm search repo podinfo
helm show values podinfo/podinfo | head -40
```

`helm show values` chart'ın ayarlanabilir bütün değerlerini ve varsayılanlarını gösterir: Bir chart'ı kurmadan önce okunacak ilk şey. (podinfo, Kubernetes demoları için yazılmış küçük bir web uygulaması ve chart'ı.)

Kendi değer dosyanla kur:

```bash
cat > podinfo-degerler.yaml <<'EOF'
replicaCount: 2
ui:
  message: "Helm ile kuruldum"
resources:
  requests: { cpu: 10m, memory: 32Mi }
  limits: { memory: 64Mi }
EOF
helm install demo podinfo/podinfo -n demo --create-namespace -f podinfo-degerler.yaml --wait
helm list -n demo
kubectl get all -n demo
```

> Hazır bir chart kullanmadan önce imajlarının erişilebilir ve güncel olduğunu kontrol et. Örneğin Docker Hub'daki Bitnami imajlarının dağıtım modeli 2025'te değişti ve ücretsiz imaj seti daraldı: bu imajlara dayanan eski kurulumlar `ImagePullBackOff`'a düşebilir. Pek çok yazılımın kendi resmî chart'ı vardır.

```bash
helm status demo -n demo
helm get values demo -n demo
helm get manifest demo -n demo | head -30
kubectl -n demo run t --image=curlimages/curl:8.10.1 --restart=Never --rm -it -- curl -s http://demo-podinfo:9898/ | head -8
```

- `helm get values`: Bu release'e verilen (varsayılanların üzerine yazılan) değerler.
- `helm get manifest`: Kümeye gönderilen gerçek YAML. "Bu chart aslında ne kurdu?" sorusunun cevabı.

### Yükseltme ve geri alma

```bash
helm upgrade demo podinfo/podinfo -n demo -f podinfo-degerler.yaml --set replicaCount=3 --set ui.message="ikinci sürüm"
helm history demo -n demo
helm rollback demo 1 -n demo
helm history demo -n demo
kubectl get deploy -n demo
```

Her işlem yeni bir revizyon üretir, `rollback` da dahil. Kubernetes'in Deployment rollout'undan farklı olarak Helm **bütün nesneleri birlikte** geri alır: ConfigMap, Service, Deployment, hepsi o revizyondaki hâline döner.

Üretimde sık kullanılan bayraklar:

```bash
helm upgrade --install demo podinfo/podinfo -n demo -f podinfo-degerler.yaml \
  --atomic --timeout 5m --wait
```

- `upgrade --install`: Yoksa kur, varsa yükselt. CI'da tek komut.
- `--wait`: Nesneler hazır olana kadar (Deployment'lar rollout'u bitirene, Pod'lar Ready olana kadar) bekle.
- `--atomic`: Başarısız olursa **otomatik geri al**. Kubernetes'in tek başına yapmadığı şey (Deployment dersi).

Kaldırmak:

```bash
helm uninstall demo -n demo
```

## Kendi chart'ını yazmak

```bash
helm create siparis
tree siparis
```

```text
siparis/
├── Chart.yaml          # ad, sürüm, uygulama sürümü, bağımlılıklar
├── values.yaml         # varsayılan değerler
├── charts/             # bağımlı chart'lar
└── templates/
    ├── _helpers.tpl    # tekrar kullanılan şablon parçaları
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── hpa.yaml
    ├── serviceaccount.yaml
    ├── NOTES.txt       # kurulumdan sonra ekrana basılan not
    └── tests/
```

`helm create` çalışan bir iskelet üretir. Şablonlara bakalım:

```bash
sed -n '1,45p' siparis/templates/deployment.yaml
head -30 siparis/values.yaml
```

Şablonlar Go'nun `text/template` dili + Sprig fonksiyonlarıyla yazılır:

| Yazım | Anlamı |
|---|---|
| `{{ .Values.replicaCount }}` | values'tan değer |
| `{{ .Release.Name }}`, `{{ .Release.Namespace }}` | Release bilgisi |
| `{{ .Chart.AppVersion }}` | Chart.yaml'dan |
| `{{ include "siparis.fullname" . }}` | `_helpers.tpl`'deki bir şablonu çağır |
| `{{- if .Values.ingress.enabled }} ... {{- end }}` | Koşul (`-` boşlukları kırpar) |
| `{{- range .Values.env }} ... {{- end }}` | Döngü |
| `{{ .Values.x \| default "y" \| quote }}` | Boru ile fonksiyonlar |
| `{{- toYaml .Values.resources \| nindent 12 }}` | Bir YAML bloğunu doğru girintiyle yerleştir |
| `{{ required "image.tag gerekli" .Values.image.tag }}` | Zorunlu değer |

Değerleri değiştirip **kurmadan** sonucu gör:

```bash
helm template ornek ./siparis --set replicaCount=3 --set image.repository=traefik/whoami --set image.tag=v1.10 | grep -E 'replicas:|image:'
helm lint ./siparis
```

`helm template` şablonları yerelde işleyip YAML'ı basar. Chart geliştirirken en çok kullanılan komut.

### Kendi değişikliklerimiz

Chart'ı sipariş API'mize uyarlayalım: ConfigMap'ten ayar, ConfigMap değişince otomatik rollout (ConfigMap dersindeki checksum kalıbı), probe'lar.

```bash
cat > siparis/templates/configmap.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "siparis.fullname" . }}
  labels:
    {{- include "siparis.labels" . | nindent 4 }}
data:
  {{- range $anahtar, $deger := .Values.ayarlar }}
  {{ $anahtar }}: {{ $deger | quote }}
  {{- end }}
EOF

python3 - <<'PY'
p='siparis/templates/deployment.yaml'; s=open(p).read()
s=s.replace("""  template:
    metadata:
      {{- with .Values.podAnnotations }}""","""  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
      {{- with .Values.podAnnotations }}""",1)
s=s.replace("""          ports:""","""          envFrom:
            - configMapRef:
                name: {{ include "siparis.fullname" . }}
          ports:""",1)
open(p,'w').write(s)
PY

cat >> siparis/values.yaml <<'EOF'

ayarlar:
  LOG_LEVEL: info
  ORTAM: dev
EOF
sed -i 's#repository: nginx#repository: traefik/whoami#; s#tag: ""#tag: "v1.10"#' siparis/values.yaml
helm lint ./siparis
helm template t ./siparis | grep -A6 'kind: ConfigMap'
helm template t ./siparis | grep -E 'checksum|envFrom' -A1 | head -6
```

(`helm create` iskeletinin ayrıntıları Helm sürümüne göre biraz değişebilir. Python betiği eşleşme bulamazsa `deployment.yaml`'ı bir düzenleyicide açıp aynı iki eklemeyi elle yapabilirsin.)

### Ortam başına değerler

```bash
cat > staging.yaml <<'EOF'
replicaCount: 1
ayarlar:
  ORTAM: staging
  LOG_LEVEL: debug
EOF
cat > uretim.yaml <<'EOF'
replicaCount: 3
ayarlar:
  ORTAM: uretim
resources:
  requests: { cpu: 100m, memory: 64Mi }
  limits: { memory: 128Mi }
EOF
helm upgrade --install siparis ./siparis -n staging --create-namespace -f staging.yaml --wait
helm upgrade --install siparis ./siparis -n uretim --create-namespace -f uretim.yaml --wait
kubectl get deploy -A -l app.kubernetes.io/name=siparis
kubectl -n uretim exec deploy/siparis -- env 2>/dev/null | grep ORTAM || kubectl -n uretim get cm siparis -o jsonpath='{.data}{"\n"}'
```

Değer öncelik sırası (yüksekten düşüğe): `--set` → sonraki `-f` dosyaları → önceki `-f` dosyaları → chart'ın `values.yaml`'ı. Haritalar birleştirilir (`ayarlar.LOG_LEVEL` uretim'de chart'tan `info` olarak geldi), listeler değiştirilir.

Checksum kalıbını gör:

```bash
helm upgrade siparis ./siparis -n staging -f staging.yaml --set ayarlar.YENI=1 --wait
kubectl -n staging rollout history deploy/siparis
```

Sadece ConfigMap değiştiği hâlde Deployment yeni bir revizyon aldı: Pod'lar yeni ayarla yeniden başladı.

### Hook'lar: migration

Helm, belirli anlarda çalışan nesneler tanımlamaya izin verir. Kubernetes bölümündeki migration Job'ı için:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "siparis.fullname" . }}-migrate
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["python", "migrate.py"]
```

`pre-upgrade` hook'u Deployment güncellenmeden **önce** çalışır ve başarısız olursa yükseltme durur. Docker kursundaki `service_completed_successfully` koşulunun Helm karşılığı.

### Paketleme ve yayınlama

```bash
sed -i 's/^version: .*/version: 0.2.0/' siparis/Chart.yaml
helm package ./siparis
ls *.tgz
# OCI registry'ye gönderme (örnek):
# helm push siparis-0.2.0.tgz oci://ghcr.io/ardaatay/charts
# helm install siparis oci://ghcr.io/ardaatay/charts/siparis --version 0.2.0
```

`Chart.yaml`'daki iki sürüm farklı şeylerdir: `version` chart'ın kendi sürümü (şablonlar değişince artar), `appVersion` içindeki uygulamanın sürümü. Chart'lar artık genelde imajlarla aynı OCI registry'de yayınlanır.

## Helm'in zayıf yanları

- **Şablon karmaşıklığı**: YAML üreten metin şablonları, girinti hataları ve okunması zor `{{- if }}` blokları üretir. Büyük chart'larda values.yaml yüzlerce satıra çıkar.
- **CRD'ler**: Helm CRD'leri kurar ama yükseltmez ve silmez (veri kaybını önlemek için). CRD güncellemeleri ayrıca yönetilir.
- **Değerlere gizli bilgi koymak**: `--set password=...` değeri release Secret'ında ve kabuk geçmişinde kalır. Gizli bilgiler için ConfigMap dersindeki External Secrets / Sealed Secrets.

Bir sonraki ders, şablon yerine **yama** (patch) yaklaşımını kullanan Kustomize. İkisi birlikte de kullanılabilir.

## Temizlik

```bash
helm uninstall siparis -n staging; helm uninstall siparis -n uretim
kubectl delete ns staging uretim demo --ignore-not-found
```

## Alıştırma (lab'da)

1. Chart'a bir `values.yaml` anahtarı ekle: `httproute.enabled` (varsayılan `false`) ve `httproute.host`. Etkin olduğunda önceki dersteki `ana-giris` Gateway'ine bağlanan bir HTTPRoute üretsin. `helm template` ile hem açık hem kapalı hâlini doğrula.
2. Bir yükseltmeyi bilerek boz (`--set image.tag=yok`) ve `--atomic --timeout 60s` ile çalıştır. Ne oldu? `helm history` ne gösteriyor?

<details><summary>Çözüm</summary>

```bash
cat > siparis/templates/httproute.yaml <<'EOF'
{{- if .Values.httproute.enabled }}
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ include "siparis.fullname" . }}
  labels:
    {{- include "siparis.labels" . | nindent 4 }}
spec:
  parentRefs:
    - name: {{ .Values.httproute.gateway | default "ana-giris" }}
  hostnames:
    - {{ required "httproute.host gerekli" .Values.httproute.host | quote }}
  rules:
    - backendRefs:
        - name: {{ include "siparis.fullname" . }}
          port: {{ .Values.service.port }}
{{- end }}
EOF
cat >> siparis/values.yaml <<'EOF'

httproute:
  enabled: false
  host: ""
EOF
helm template t ./siparis | grep -c HTTPRoute
helm template t ./siparis --set httproute.enabled=true --set httproute.host=siparis.local | grep -A12 'kind: HTTPRoute'
helm template t ./siparis --set httproute.enabled=true 2>&1 | tail -1

helm upgrade --install s ./siparis -n deneme --create-namespace --wait
helm upgrade s ./siparis -n deneme --set image.tag=yok --atomic --timeout 60s; echo "kod: $?"
helm history s -n deneme
helm uninstall s -n deneme; kubectl delete ns deneme
```

2: Yükseltme 60 saniyede hazır olamadığı için başarısız oldu ve `--atomic` otomatik olarak önceki revizyona geri döndü. `helm history`'de başarısız revizyon (`failed`) ve ardından geri alma revizyonu (`deployed`, "Rollback to 1") görünür. Uygulama boyunca eski Pod'lar çalışmaya devam etti.

</details>

```quiz
`helm template` ile `helm install --dry-run` arasındaki temel fark?
- Aynı şeydir
- [x] `helm template` kümeye hiç bağlanmadan yerelde şablonları işler. `--dry-run` kümeyle konuşup doğrulama yapar ama kurmaz
- `helm template` kurulum yapar
? Chart geliştirirken `helm template` ve `helm lint` en hızlı geri bildirimi verir.
```

```quiz
Bir chart'ta sadece ConfigMap şablonu değişti. Pod'ların yeni ayarla yeniden başlaması için yaygın Helm kalıbı?
- `helm rollback`
- [x] Pod şablonuna ConfigMap içeriğinin sha256'sını `checksum/config` annotation'ı olarak koymak
- Her upgrade'de `--force` kullanmak
? İçerik değişince Pod şablonu değişir ve Deployment rolling update yapar.
```

```quiz
Helm yükseltmesi başarısız olduğunda otomatik geri almak için hangi bayrak?
- `--wait`
- [x] `--atomic`
- `--install`
? `--atomic`, `--wait` ile birlikte başarısızlıkta önceki revizyona döner.
```

## Özet

- Chart (şablonlar + values) → release (kurulu örnek) → revision. Release bilgisi namespace'te Secret olarak.
- Hazır chart: `repo add`, `show values`, `install -f`, `get values/manifest`, `upgrade`, `history`, `rollback`, `uninstall`.
- CI'da `upgrade --install --atomic --wait --timeout`.
- Chart yazmak: `helm create`, Go şablonları (`.Values`, `include`, `toYaml | nindent`, `required`), `helm template` ve `lint`.
- Ortam başına `-f` dosyaları, checksum annotation'ı, `pre-upgrade` hook'u ile migration.
- `version` ≠ `appVersion`. Chart'lar OCI registry'de.
