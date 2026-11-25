# HPA, metrics-server, PDB ve küme ölçekleme

Şimdiye kadar replika sayısını elle verdik. Gerçek trafik ise gün içinde dalgalanır: Gece 2 replika yeterliyken öğlen 10 gerekebilir. Bu derste Kubernetes'in otomatik ölçekleme katmanlarını ve bunun tersini, yani planlı kesintilerde (node bakımı, küme yükseltmesi, ölçek küçültme) uygulamanın ayakta kalmasını sağlayan **PodDisruptionBudget**'ı göreceğiz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Ölçekleme katmanları

| Araç | Ne ölçekler | Neye göre |
|---|---|---|
| **HorizontalPodAutoscaler (HPA)** | Pod **sayısı** | CPU, bellek, özel metrikler |
| **VerticalPodAutoscaler (VPA)** | Pod başına **requests/limits** | Geçmiş kullanım |
| **KEDA** | Pod sayısı (sıfıra kadar) | Olaylar: kuyruk uzunluğu, Kafka gecikmesi, cron, HTTP |
| **Cluster Autoscaler / Karpenter** | **Node** sayısı | Zamanlanamayan (Pending) Pod'lar |

Katmanlar birlikte çalışır: Trafik artar → HPA Pod ekler → node'larda yer kalmaz, yeni Pod'lar `Pending` → küme ölçekleyici yeni node açar → Pod'lar oraya yerleşir. Trafik azalınca tersi.

## metrics-server

HPA'nın CPU ve bellek kararları için kaynak kullanımını bilmesi gerekir. Bunu **metrics-server** sağlar: Her node'daki kubelet'ten konteyner kullanımını toplayıp **Metrics API**'den sunar. `kubectl top` de aynı API'yi kullanır.

```bash
kubectl top nodes 2>&1 | head -3
```

Hata alırsan kur (kubeadm lab kümesinde kubelet sertifikaları kendinden imzalı olduğu için `--kubelet-insecure-tls` bayrağı gerekir, üretim kümelerinde kullanılmaz):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deploy metrics-server --type=json -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deploy/metrics-server --timeout=120s
sleep 30; kubectl top nodes; kubectl top pods -A | head
```

metrics-server sadece **anlık** değerleri tutar (geçmiş yok). Geçmiş ve grafikler için Prometheus (gözlem dersi).

## HPA

Biraz CPU harcayan bir uygulama:

```bash
cat > hpa-app.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: hesap }
spec:
  replicas: 1
  selector: { matchLabels: { app: hesap } }
  template:
    metadata: { labels: { app: hesap } }
    spec:
      containers:
        - name: hesap
          image: registry.k8s.io/hpa-example
          ports: [{ containerPort: 80 }]
          resources:
            requests: { cpu: 200m }
            limits: { cpu: 500m }
---
apiVersion: v1
kind: Service
metadata: { name: hesap }
spec:
  selector: { app: hesap }
  ports: [{ port: 80 }]
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: hesap }
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: hesap
  minReplicas: 1
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50     # requests'in %50'si
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 60  # (varsayılan 300) lab için kısaltıldı
EOF
kubectl apply -f hpa-app.yaml
kubectl rollout status deploy/hesap
kubectl get hpa hesap
```

`registry.k8s.io/hpa-example` her istekte CPU harcayan küçük bir PHP uygulaması (Kubernetes belgelerindeki HPA örneği).

**`averageUtilization: 50`, requests'e göredir**: Pod başına 200m request varsa hedef, Pod başına ortalama 100m kullanım. **requests verilmemiş bir Pod'da CPU yüzdesi hesaplanamaz** ve HPA çalışmaz (`<unknown>`). Probe ve kaynak dersindeki "requests'i gerçekçi ver" önerisinin bir sebebi daha.

Yük oluştur. İkinci bir terminal sekmesinde izle:

```bash
kubectl get hpa hesap -w
```

İlk sekmede:

```bash
kubectl run yuk --image=busybox:1.36 --restart=Never -- sh -c 'while true; do wget -q -O- http://hesap >/dev/null; done'
sleep 120
kubectl get hpa hesap
kubectl get pods -l app=hesap
```

CPU yüzdesi hedefin üstüne çıktı ve replika sayısı arttı. HPA'nın hesabı basit:

```text
istenen replika = ceil( mevcut replika × mevcut ortalama / hedef )
örnek: 1 × 250% / 50% = 5 replika
```

Yükü durdur:

```bash
kubectl delete pod yuk
sleep 120
kubectl get hpa hesap; kubectl get pods -l app=hesap
```

Ölçek küçültme, `stabilizationWindowSeconds` boyunca beklenir: Trafik bir anlığına düştü diye Pod'ları kapatıp hemen ardından yeniden açmak (flapping) önlenir. Varsayılan 5 dakika, ölçek büyütmede ise bekleme yok.

### behavior ile ince ayar

```yaml
  behavior:
    scaleUp:
      policies:
        - { type: Percent, value: 100, periodSeconds: 30 }   # 30 sn'de en fazla iki katına
        - { type: Pods, value: 4, periodSeconds: 30 }        # ya da en fazla 4 Pod
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - { type: Percent, value: 20, periodSeconds: 60 }    # dakikada en fazla %20 azalt
```

### Bellek ve özel metrikler

- **Bellek** de hedef olabilir, ama dikkat: Çoğu çalışma ortamı (JVM, Node) belleği geri vermez. Ölçek büyütür, ama kullanım hiç düşmediği için asla küçültmez. Bellek bazlı HPA'yı ancak bellek kullanımı yükle orantılı olan uygulamalarda kullan.
- **Özel metrikler**: İstek sayısı (RPS), kuyruk uzunluğu, gecikme. Prometheus Adapter ya da **KEDA** ile. CPU'nun yükü iyi temsil etmediği uygulamalarda (G/Ç beklemesi ağırlıklı API'ler, kuyruk tüketicileri) çok daha iyi sonuç verir. KEDA ayrıca iş olmadığında **sıfır replikaya** inebilir.

> HPA'nın yönettiği bir Deployment'ın manifest'inde `replicas` alanını sabit tutma: Her `kubectl apply` ya da GitOps senkronizasyonu HPA'nın kararını ezer (GitOps dersi). `replicas`'ı manifest'ten kaldır ya da `ignoreDifferences` kullan.

```bash
kubectl delete -f hpa-app.yaml
```

## VerticalPodAutoscaler

VPA, Pod'ların geçmiş kullanımına bakarak requests (ve oranlı olarak limits) önerir ya da uygular. Ayrıca kurulması gerekir. En güvenli kullanımı **öneri modudur** (`updateMode: "Off"`): Değerleri değiştirmez, sadece önerir. "requests'i neye göre vereyim?" sorusunun ölçüme dayalı cevabı. Aynı metrik (CPU) için HPA ile birlikte kullanılmaz: İkisi aynı sinyale zıt yönlerde tepki verir. Kubernetes 1.33+ ile gelen **yerinde Pod yeniden boyutlandırma** (in-place resize), requests değişikliği için Pod'u yeniden başlatma ihtiyacını azaltıyor.

## PodDisruptionBudget

Ölçeklemenin diğer yüzü: Planlı kesintiler. Bir node bakıma alınırken (`kubectl drain`), küme yükseltilirken ya da küme ölçekleyici bir node'u kapatırken Pod'lar **tahliye edilir**. 3 replikalı bir uygulamanın Pod'larının hepsi aynı node'daysa ya da iki node aynı anda boşaltılırsa uygulama tamamen durabilir.

**PodDisruptionBudget (PDB)** "bu uygulamadan aynı anda en fazla şu kadarı kesintiye uğrayabilir" der:

```bash
kubectl create deployment web --image=nginx:1.27-alpine --replicas=3
kubectl rollout status deploy/web
cat > pdb.yaml <<'EOF'
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: web }
spec:
  minAvailable: 2          # ya da: maxUnavailable: 1
  selector:
    matchLabels: { app: web }
EOF
kubectl apply -f pdb.yaml
kubectl get pdb web
```

`ALLOWED DISRUPTIONS: 1`: Şu an en fazla bir Pod tahliye edilebilir. Node'u boşaltmayı dene:

```bash
kubectl get pods -l app=web -o wide
kubectl drain node01 --ignore-daemonsets --delete-emptydir-data --timeout=60s
```

Lab kümesinde uygulama Pod'ları sadece `node01`'de çalışabildiği için (control plane taint'li), tahliye edilen Pod'un yerine yenisi hiçbir yere yerleşemez. PDB izin verilen bir tahliyeden sonra diğerlerini **reddeder**: `drain` "Cannot evict pod as it would violate the pod's disruption budget" diyerek tekrar dener ve süre dolunca durur. Uygulama 2 Pod ile ayakta kalmaya devam eder.

```bash
kubectl get pods -l app=web -o wide
kubectl uncordon node01
kubectl get pods -l app=web -o wide -w &
sleep 20; kill %1
```

Çok node'lu gerçek bir kümede `drain` tahliye edilen Pod'un başka bir node'da hazır olmasını bekler, sonra bir sonrakine geçer. PDB'ler bu yüzden yükseltmeler ve küme ölçekleyiciler için önemlidir.

Dikkat edilecekler:

- PDB **sadece gönüllü kesintileri** (tahliye API'si: drain, ölçekleyici, yükseltme) korur. Node'un çökmesi, OOM, `kubectl delete pod` PDB'ye bakmaz.
- `minAvailable: 100%` ya da tek replikalı bir Deployment'a `minAvailable: 1`: Hiçbir tahliyeye izin vermez, **node bakımını ve küme yükseltmelerini kilitler**. Tek replikalı uygulamalarda `maxUnavailable: 1` kullan ya da replikayı artır.
- PDB'nin işe yaraması için replikaların **farklı node'lara** dağılmış olması gerekir (bir sonraki ders: topoloji yayılımı).

```bash
kubectl delete -f pdb.yaml; kubectl delete deploy web
```

## Küme ölçekleme

Pod'lar `Pending` kaldığında (yer yok) yeni node açan ve boş kalan node'ları kapatan araçlar:

- **Cluster Autoscaler**: Bulut sağlayıcılarının node gruplarını (AWS Auto Scaling Group, GKE node pool) büyütüp küçültür. Her yerde çalışır.
- **Karpenter** (AWS'den çıktı, Azure'da da var): Node gruplarına bağlı kalmadan, bekleyen Pod'ların ihtiyacına en uygun makine tipini doğrudan açar. Daha hızlı ve daha verimli bin-packing.

Ölçekleyiciler **requests**'e bakar (scheduler gibi): requests'siz Pod'lar node ihtiyacı yaratmaz, aşırı yüksek requests ise boşa node açtırır. Ölçek küçültmede node'ları boşaltırken PDB'lere uyarlar.

## Alıştırma (lab'da)

1. `hesap` uygulamasını HPA ile yeniden kur, ama Deployment'tan `resources.requests` alanını kaldır. `kubectl get hpa` ne gösteriyor? `kubectl describe hpa` olaylarında ne yazıyor?
2. 1 replikalı bir Deployment'a `minAvailable: 1` PDB'si ekleyip `kubectl drain node01` dene. Ne oluyor ve nasıl düzeltirsin?

<details><summary>Cevap</summary>

1: Hedef sütunu `<unknown>/50%` gösterir. Olaylarda "missing request for cpu" ya da "failed to get cpu utilization". Yüzde, requests'e göre hesaplandığı için requests'siz Pod'lar ölçeklenemez.

2: `ALLOWED DISRUPTIONS: 0`. drain tek Pod'u tahliye edemez ve süre dolana kadar dener: node bakıma alınamaz. Çözüm: replika sayısını en az 2 yapmak, ya da PDB'yi `maxUnavailable: 1` yapmak (tek replikada kısa bir kesintiyi kabul etmek). Bu durumu kümede bulmak için: `kubectl get pdb -A` çıktısında `ALLOWED DISRUPTIONS` sütunu sürekli 0 olanlar.

</details>

```quiz
HPA hedefi `averageUtilization: 50` ama `kubectl get hpa` hedefte `<unknown>` gösteriyor. En olası sebep?
- Trafik yok
- [x] Pod'larda CPU requests tanımlı değil ya da metrics-server çalışmıyor
- maxReplicas çok düşük
? Kullanım yüzdesi requests'e göre hesaplanır ve Metrics API'den alınır.
```

```quiz
Trafik düştükten sonra HPA neden Pod sayısını hemen azaltmıyor?
- Bir hata
- [x] scaleDown stabilizasyon penceresi (varsayılan 5 dk) dalgalanmayı önlemek için bekler
- PDB izin vermiyor
? Ölçek büyütme hızlı, küçültme temkinlidir.
```

```quiz
Node bakımı sırasında 3 replikalı bir uygulamanın en fazla bir Pod'unun aynı anda gitmesini garanti eden nesne?
- HPA
- ResourceQuota
- [x] PodDisruptionBudget (`maxUnavailable: 1` ya da `minAvailable: 2`)
? PDB tahliye API'si üzerinden yapılan gönüllü kesintileri sınırlar.
```

## Özet

- Katmanlar: HPA (Pod sayısı), VPA (requests), KEDA (olay bazlı, sıfıra kadar), Cluster Autoscaler/Karpenter (node sayısı).
- metrics-server → Metrics API → `kubectl top` ve HPA. Geçmiş için Prometheus.
- HPA yüzdesi requests'e göre. requests yoksa çalışmaz. `behavior` ile hız ve stabilizasyon. Manifest'te `replicas` sabitleme.
- VPA'yı öneri modunda kullan, aynı metrikte HPA ile birleştirme.
- PDB gönüllü kesintileri sınırlar. Tek replikaya `minAvailable: 1` bakımları kilitler.
