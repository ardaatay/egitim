# Kustomize ile ortam farkları

Helm, manifest'leri **şablonlarla** üretir: YAML'ın içine `{{ .Values.x }}` boşlukları açar. **Kustomize** tersini yapar: Şablon yok, düz ve geçerli Kubernetes YAML'ı yazarsın (**base**), her ortam için sadece **farkları** (**overlay**) yama olarak tanımlarsın. `kubectl`'in içinde yerleşik olarak gelir (`kubectl apply -k`), ayrı bir araç kurmak gerekmez.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Ne zaman Helm, ne zaman Kustomize?

| | Helm | Kustomize |
|---|---|---|
| Yaklaşım | Şablon + değerler | Düz YAML + yamalar |
| Okunabilirlik | Şablonlar büyüdükçe zorlaşır | Base her zaman geçerli, okunur YAML |
| Dağıtım | Paket olarak yayınlanır, başkaları kurar | Kendi uygulamalarını farklı ortamlara yaymak için |
| Sürüm/geri alma | Release geçmişi, `rollback` | Yok (git geçmişi ve GitOps aracı sağlar) |
| Mantık | Koşullar, döngüler | Yok (bilinçli olarak) |

Yaygın bir düzen: **Üçüncü taraf yazılımlar** (veritabanı operatörü, izleme yığını, Ingress denetleyicisi) **Helm chart**'larıyla, **kendi uygulamaların** **Kustomize** ile. Kustomize, Helm chart'larını da girdi olarak alıp üzerine yama yapabilir.

## Klasör düzeni

```text
siparis/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
└── overlays/
    ├── staging/
    │   ├── kustomization.yaml
    │   └── replika.yaml
    └── uretim/
        ├── kustomization.yaml
        ├── replika-kaynak.yaml
        └── uygulama.env
```

## Base

```bash
mkdir -p siparis/base siparis/overlays/staging siparis/overlays/uretim && cd siparis

cat > base/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: siparis
spec:
  replicas: 1
  selector:
    matchLabels: { app: siparis }
  template:
    metadata:
      labels: { app: siparis }
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.10
          ports: [{ name: http, containerPort: 80 }]
          envFrom:
            - configMapRef: { name: siparis-ayar }
          readinessProbe:
            httpGet: { path: /health, port: http }
EOF

cat > base/service.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: siparis
spec:
  selector: { app: siparis }
  ports: [{ port: 80, targetPort: http }]
EOF

cat > base/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
labels:
  - pairs:
      app.kubernetes.io/part-of: magaza
    includeSelectors: false
configMapGenerator:
  - name: siparis-ayar
    literals:
      - LOG_LEVEL=info
      - ORTAM=dev
EOF

kubectl kustomize base
```

`kubectl kustomize` sonucu yazdırır, kümeye bir şey göndermez (Helm'deki `helm template`). Çıktıda iki şeye dikkat:

1. Bütün nesnelere `app.kubernetes.io/part-of: magaza` etiketi eklendi.
2. ConfigMap'in adı `siparis-ayar-<karma>` oldu ve Deployment'taki referans **otomatik olarak** bu yeni adla güncellendi.

İkincisi, ConfigMap dersindeki "değişmez, sürümlü ConfigMap" yönteminin otomatik hâlidir: Ayar değişince ConfigMap'in adı değişir, Deployment şablonu değişir ve normal bir rolling update olur. Bozuk bir ayar geri alınabilir, eski Pod'lar eski ConfigMap'le çalışmaya devam eder.

## Overlay: staging

```bash
cat > overlays/staging/replika.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: siparis
spec:
  replicas: 2
EOF

cat > overlays/staging/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: staging
resources:
  - ../../base
patches:
  - path: replika.yaml
configMapGenerator:
  - name: siparis-ayar
    behavior: merge
    literals:
      - ORTAM=staging
      - LOG_LEVEL=debug
EOF

kubectl kustomize overlays/staging | grep -E 'namespace:|replicas:|ORTAM|LOG_LEVEL|name: siparis-ayar'
```

- `resources: [../../base]`: Base'i al.
- `namespace`: Bütün nesneleri bu namespace'e koy.
- `patches`: **Stratejik birleştirme yaması** (strategic merge patch): Base'teki nesneyle aynı `kind` ve `name`'e sahip kısmi bir YAML. Sadece yazdığın alanlar değişir.
- `configMapGenerator` + `behavior: merge`: Base'teki ConfigMap'e anahtar ekle ya da değiştir.

## Overlay: üretim

```bash
cat > overlays/uretim/replika-kaynak.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: siparis
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api                      # liste öğeleri "name" ile eşleşir
          resources:
            requests: { cpu: 100m, memory: 64Mi }
            limits: { memory: 128Mi }
EOF

cat > overlays/uretim/uygulama.env <<'EOF'
ORTAM=uretim
LOG_LEVEL=warn
EOF

cat > overlays/uretim/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: uretim
resources:
  - ../../base
patches:
  - path: replika-kaynak.yaml
  - target:
      kind: Deployment
      name: siparis
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/livenessProbe
        value:
          tcpSocket: { port: http }
          periodSeconds: 10
configMapGenerator:
  - name: siparis-ayar
    behavior: replace
    envs: [uygulama.env]
images:
  - name: traefik/whoami
    newTag: v1.10.1
EOF

kubectl kustomize overlays/uretim | grep -E 'replicas:|image:|livenessProbe|memory:|ORTAM'
```

Yeni araçlar:

- **JSON 6902 yaması** (`op: add/replace/remove` ve `path`): Stratejik birleştirmenin yetmediği yerler için, belirli bir yola cerrahi değişiklik.
- **`images`**: Base'e dokunmadan imaj adını ya da etiketini değiştir. CI'ın her deploy'da değiştirdiği tek alan genelde budur:

```bash
sed -i 's/newTag: v1.10.1/newTag: v1.10.2/' overlays/uretim/kustomization.yaml
grep -A2 images overlays/uretim/kustomization.yaml
```

(Ayrı kurulan `kustomize` aracında aynı iş `kustomize edit set image traefik/whoami=traefik/whoami:v1.10.2` ile yapılır. Docker kursundaki CI hattında imaj etiketi bu adımla overlay'e yazılıp git'e gönderilir. GitOps dersinde bu akışı tamamlayacağız.)

## Uygulamak

```bash
kubectl create namespace staging; kubectl create namespace uretim
kubectl apply -k overlays/staging
kubectl apply -k overlays/uretim
kubectl get deploy,cm -n staging; kubectl get deploy,cm -n uretim
kubectl diff -k overlays/uretim
```

Bir ayar değiştir ve sonucu izle:

```bash
sed -i 's/LOG_LEVEL=warn/LOG_LEVEL=error/' overlays/uretim/uygulama.env
kubectl apply -k overlays/uretim
kubectl -n uretim get cm
kubectl -n uretim rollout status deploy/siparis
kubectl -n uretim rollout history deploy/siparis
```

Yeni karmalı bir ConfigMap oluştu ve Deployment otomatik olarak rolling update yaptı. Eski ConfigMap hâlâ duruyor (rollback için), `kubectl apply --prune` ya da bir GitOps aracı kullanılmayan eski nesneleri temizler.

## Bileşenler ve diğer özellikler

| Özellik | Ne için |
|---|---|
| `components` | Birden fazla overlay'in seçerek kullanacağı yeniden kullanılabilir parçalar ("izleme sidecar'ı ekle", "HPA ekle") |
| `secretGenerator` | ConfigMap gibi Secret üretir (ama gizli değerler dosyada durur, git'e girmemeli) |
| `replicas` | Yama yazmadan replika sayısı: `replicas: [{name: siparis, count: 5}]` |
| `namePrefix` / `nameSuffix` | Bütün nesne adlarına önek/sonek (aynı namespace'te iki kopya) |
| `helmCharts` | Bir Helm chart'ını işleyip sonucuna yama uygula (`kustomize build --enable-helm`) |
| `replacements` | Bir nesnedeki değeri başka bir nesneye kopyala |

## Alıştırma (lab'da)

1. `overlays/uretim`'e, `minAvailable: 2` olan bir PodDisruptionBudget (ölçekleme dersinde ayrıntılı) ekle ve sonucu `kubectl kustomize` ile doğrula.
2. `overlays/onizleme` adında yeni bir overlay oluştur: `namePrefix: pr-42-`, `onizleme` namespace'i, 1 replika. Aynı namespace'te başka bir PR için ikinci bir kopya kurulabilir mi?

<details><summary>Çözüm</summary>

```bash
cat > overlays/uretim/pdb.yaml <<'EOF'
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: siparis }
spec:
  minAvailable: 2
  selector: { matchLabels: { app: siparis } }
EOF
sed -i 's|^resources:|resources:\n  - pdb.yaml|' overlays/uretim/kustomization.yaml
kubectl kustomize overlays/uretim | grep -A6 PodDisruptionBudget

mkdir -p overlays/onizleme
cat > overlays/onizleme/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: onizleme
namePrefix: pr-42-
resources: [../../base]
EOF
kubectl kustomize overlays/onizleme | grep -E 'name: pr-42|claimName|configMapRef' -A1 | head
```

2: Evet. `namePrefix` bütün nesne adlarını ve aralarındaki referansları (Deployment → ConfigMap) değiştirir. Ama dikkat: `namePrefix` **etiketleri ve seçicileri değiştirmez**, iki kopyanın Deployment'ları ve Service'leri aynı `app: siparis` etiketini seçer ve birbirinin Pod'larını görür. Her kopyaya ayrıca `labels` ile (`includeSelectors: true`) benzersiz bir etiket (örneğin `pr: "42"`) eklemek gerekir. Bu tür ince noktalar, `kubectl kustomize` çıktısını her zaman okumak için iyi bir neden.

</details>

```quiz
Kustomize'da base'teki bir ConfigMap'i `configMapGenerator` ile ürettin ve bir değeri değiştirdin. Ne olur?
- ConfigMap yerinde güncellenir, Pod'lar eski değeri kullanmaya devam eder
- [x] Yeni karmalı adla yeni bir ConfigMap oluşur, Deployment referansı güncellenir ve rolling update olur
- Hata verir
? Generator'lar ada içeriğin karmasını ekler. Bu, ayar değişikliklerini geri alınabilir rollout'lara çevirir.
```

```quiz
Kendi uygulamanı 3 ortama yayacaksın ve şablon mantığına ihtiyacın yok. Hangi araç daha uygun?
- Helm, her zaman
- [x] Kustomize: base + ortam overlay'leri, düz ve okunur YAML
- İkisi de olmaz
? Helm üçüncü taraf paketleri ve karmaşık parametrizasyon için, Kustomize kendi uygulamalarının ortam farkları için yaygın tercih.
```

## Özet

- Kustomize: şablonsuz. Base (geçerli YAML) + overlay (farklar). `kubectl kustomize` (yazdır), `kubectl apply -k` (uygula).
- `resources`, `namespace`, `labels`, `patches` (stratejik birleştirme ya da JSON 6902), `images`, `replicas`, `namePrefix`.
- `configMapGenerator`/`secretGenerator`: karmalı adlar, otomatik referans güncelleme, ayar değişikliğinde rollout.
- Üçüncü taraf yazılımlar için Helm, kendi uygulamaların için Kustomize yaygın bir ayrım.
