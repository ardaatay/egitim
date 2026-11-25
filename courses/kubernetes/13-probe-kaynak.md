# Probe'lar, requests/limits, QoS ve kotalar

Kubernetes'in "kendi kendini iyileştirmesi" ve kesintisiz rollout'u, iki bilgiye dayanır: Pod'un **sağlıklı ve hazır** olup olmadığı (probe'lar) ve **ne kadar kaynak** istediği (requests/limits). Bu ikisi yanlış ayarlanınca Kubernetes yardımcı olmak yerine zarar verir: sağlıklı Pod'ları öldürür, aşırı yüklenmiş node'lara Pod yerleştirir, en önemli uygulamayı ilk kurban yapar. Bu derste ikisini birden göreceğiz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Probe'lar

Docker kursundaki `HEALTHCHECK` tek bir soruydu. Kubernetes'te üç ayrı soru ve üç ayrı sonuç var:

| Probe | Soru | Başarısız olursa |
|---|---|---|
| **startupProbe** | Uygulama açılışını tamamladı mı? | Belirlenen süre içinde başarılı olmazsa konteyner yeniden başlatılır. Başarılı olana kadar diğer probe'lar çalışmaz |
| **livenessProbe** | Süreç hâlâ işini yapabiliyor mu, yoksa kilitlendi mi? | Konteyner **yeniden başlatılır** |
| **readinessProbe** | Şu an trafik alabilir mi? | Pod **Service uç noktalarından çıkarılır**. Yeniden başlatılmaz. Başarılı olunca geri eklenir |

Kontrol türleri: `httpGet` (2xx/3xx başarılı), `tcpSocket` (port açık mı), `exec` (komut 0 ile bitti mi), `grpc`.

Zamanlama alanları:

| Alan | Varsayılan | Anlamı |
|---|---|---|
| `initialDelaySeconds` | 0 | İlk kontrol öncesi bekleme (startupProbe varsa genelde gereksiz) |
| `periodSeconds` | 10 | Kontrol aralığı |
| `timeoutSeconds` | 1 | Kontrolün süresi |
| `failureThreshold` | 3 | Kaç ardışık başarısızlık "başarısız" sayılır |
| `successThreshold` | 1 | Kaç ardışık başarı "başarılı" sayılır (liveness ve startup için 1 olmak zorunda) |

### Readiness: trafiği koru

Durumu değiştirilebilen bir uygulama kullanalım: `traefik/whoami`'nin `/health` uç noktasına POST ile durum kodu yazılabiliyor.

```bash
cat > probe.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.10
          ports: [{ name: http, containerPort: 80 }]
          readinessProbe:
            httpGet: { path: /health, port: http }
            periodSeconds: 2
            failureThreshold: 2
          livenessProbe:
            tcpSocket: { port: http }
            periodSeconds: 5
            failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata: { name: api }
spec:
  selector: { app: api }
  ports: [{ port: 80, targetPort: http }]
EOF
kubectl apply -f probe.yaml && kubectl rollout status deploy/api
kubectl get pods -l app=api
```

Bir Pod'u "hazır değil" durumuna sok. `whoami` imajında kabuk ve araç yok (scratch tabanlı), bu yüzden isteği bir istemci Pod'undan hedef Pod'un IP'sine atacağız:

```bash
kubectl run istemci --image=curlimages/curl:8.10.1 --restart=Never -- sleep 3600
kubectl wait --for=condition=Ready pod/istemci
P=$(kubectl get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
PIP=$(kubectl get pod $P -o jsonpath='{.status.podIP}')
kubectl exec istemci -- curl -s -X POST -d 503 http://$PIP/health
sleep 6
kubectl get pods -l app=api
kubectl get endpointslices -l kubernetes.io/service-name=api -o jsonpath='{range .items[*].endpoints[*]}{.targetRef.name} ready={.conditions.ready}{"\n"}{end}'
```

Pod `READY 0/1` ama **çalışıyor** (`RESTARTS` artmadı) ve uç noktalarda `ready=false`: trafik almıyor. Geri al:

```bash
kubectl exec istemci -- curl -s -X POST -d 200 http://$PIP/health
sleep 5
kubectl get pods -l app=api
```

Readiness, uygulamanın kendini **geçici olarak** trafikten çekmesini sağlar: açılışta önbelleği doldururken, aşırı yüklendiğinde, bağımlı olduğu bir servise ulaşamadığında. Rollout'ta da yeni Pod'un trafiğe ne zaman alınacağını o belirler.

### Liveness: dikkatli kullan

Liveness başarısız olunca konteyner **öldürülür**. Yanlış yazılmış bir liveness probe, sağlıklı ama yavaşlamış bir uygulamayı tam yük altındayken öldürerek bir sorunu felakete çevirir:

- **Bağımlılıkları kontrol etme**: Liveness'ta veritabanına bağlanmayı kontrol edersen, veritabanı yavaşladığında **bütün** Pod'lar art arda yeniden başlatılır. Yeniden başlatma veritabanını düzeltmez, sadece daha fazla yük bindirir. Bağımlılık kontrolü readiness'a (dikkatli) ya da hiçbir probe'a ait değildir.
- **Hafif tut**: Sadece "süreç cevap veriyor mu?" (bir `/livez` uç noktası ya da TCP kontrolü).
- **Cömert eşikler**: `timeoutSeconds: 1` yoğun bir JVM'de GC duraklamasında kolayca aşılır.
- Uygulama kilitlenme (deadlock) yaşamıyorsa ve çökünce zaten çıkıyorsa, liveness probe'a **hiç ihtiyacın olmayabilir**: Süreç biterse kubelet zaten yeniden başlatır.

Ne olduğunu görelim: Liveness'ı bilerek kıralım.

```bash
kubectl patch deploy api --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe","value":{"httpGet":{"path":"/yok","port":"http"},"periodSeconds":3,"failureThreshold":2}}]'
sleep 30
kubectl get pods -l app=api
kubectl describe pod -l app=api | grep -E 'Liveness probe failed|Killing' | head -3
```

`whoami` `/yok` için 404 döndüğü için Pod'lar sürekli yeniden başlatılıyor, `RESTARTS` artıyor ve sonunda `CrashLoopBackOff`. Uygulamada hiçbir sorun yok, sorun probe'da.

```bash
kubectl apply -f probe.yaml && kubectl rollout status deploy/api
```

### Startup: yavaş açılan uygulamalar

Açılışı 2 dakika süren bir uygulamaya `livenessProbe` + `initialDelaySeconds: 120` vermek yerine startupProbe kullan: Açılış süresince sadece startup çalışır, sonra liveness devralır.

```yaml
startupProbe:
  httpGet: { path: /livez, port: http }
  periodSeconds: 5
  failureThreshold: 36       # 36 × 5 sn = en fazla 3 dakika açılış süresi
livenessProbe:
  httpGet: { path: /livez, port: http }
  periodSeconds: 10
  failureThreshold: 3
```

## Kaynaklar: requests ve limits

```yaml
resources:
  requests:
    cpu: 250m          # 0.25 çekirdek
    memory: 256Mi
  limits:
    memory: 512Mi
```

| | **requests** | **limits** |
|---|---|---|
| Kim kullanır | **Scheduler** | **Çekirdek** (cgroup, Docker kursundaki `--memory`/`--cpus`) |
| Anlamı | "Bu Pod için en az bu kadar ayır" | "Bundan fazlasına izin verme" |
| Etkisi | Pod sadece bu kadar **ayrılmamış** kapasitesi olan bir node'a yerleşir | Bellek aşılırsa OOMKilled. CPU aşılırsa kısma (throttling) |

Birimler: CPU için `1` = 1 çekirdek, `500m` = yarım çekirdek. Bellek için `Mi`, `Gi` (ikilik). `M` ve `G` (onluk) da geçerli ama karışıklığa yol açar.

```bash
kubectl describe node node01 | grep -A8 'Allocated resources'
```

Scheduler **gerçek kullanıma değil, requests toplamına** bakar. Requests'i hiç verilmemiş Pod'lar scheduler için "sıfır" yer kaplar: bir node'a sınırsız sayıda yerleştirilebilir ve node aşırı yüklenir.

### Bellek: OOM

Bellek sıkıştırılamaz bir kaynaktır: limitine ulaşan konteyner öldürülür.

```bash
cat > bellek.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: bellek }
spec:
  containers:
    - name: tuketici
      image: busybox:1.36
      command: ["sh", "-c", "x=a; i=0; while true; do x=$x$x; i=$((i+1)); echo $i; sleep 0.2; done"]
      resources:
        requests: { memory: 32Mi, cpu: 50m }
        limits: { memory: 48Mi }
EOF
kubectl apply -f bellek.yaml; sleep 20
kubectl get pod bellek
kubectl get pod bellek -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason} kod={.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}'
kubectl delete pod bellek
```

`OOMKilled`, kod 137: Docker kursundaki gibi.

### CPU: kısma

CPU sıkıştırılabilir: limitine ulaşan konteyner öldürülmez, **yavaşlatılır**. Docker kursundaki kısma (throttling) sorunu burada daha yaygındır, çünkü limitler genelde dar verilir:

```bash
kubectl run yogun --image=busybox:1.36 --restart=Never --overrides='{"spec":{"containers":[{"name":"yogun","image":"busybox:1.36","command":["sh","-c","while true; do :; done"],"resources":{"requests":{"cpu":"100m"},"limits":{"cpu":"200m"}}}]}}'
sleep 15
kubectl top pod yogun 2>/dev/null || echo "metrics-server kurulu değilse 'kubectl top' çalışmaz (ölçekleme dersi)"
kubectl exec yogun -- cat /sys/fs/cgroup/cpu.stat | grep -E 'nr_periods|nr_throttled|throttled_usec'
kubectl delete pod yogun
```

Pratikte sık önerilen yaklaşım:

- **Bellek**: requests ve limits ver. Limit, uygulamanın normal tepe kullanımının biraz üstü olsun. Bellek limitsiz bir Pod, node'un belleğini bitirip **başka** Pod'ların öldürülmesine yol açabilir.
- **CPU**: requests'i gerçekçi ver (zamanlama ve adil paylaşım bunun üzerinden). CPU limitini gecikmeye duyarlı servislerde ya hiç verme ya da cömert ver: Boşta duran CPU'yu kullanmasını engellemek kimseye fayda sağlamaz, kısma ise yanıt sürelerinde sıçramalara yol açar. (Bu konuda ekipler arasında farklı görüşler var. Çok kiracılı kümelerde limitler adil paylaşım için tercih edilebilir.)
- Değerleri tahmin etme, **ölç**: `kubectl top`, Prometheus metrikleri, Vertical Pod Autoscaler'ın öneri modu.

Docker kursundaki uyarı geçerli: Konteyner içindeki uygulamalar (JVM, Node, gunicorn worker sayısı) limitleri bilmeyebilir. Heap ve worker ayarlarını limitlere göre ver.

## QoS sınıfları

Node'un belleği bittiğinde kubelet Pod'ları **tahliye eder** (evict). Hangi Pod'un önce gideceği, requests ve limits'ten türetilen **QoS sınıfına** bağlıdır:

| Sınıf | Koşul | Tahliye önceliği |
|---|---|---|
| **Guaranteed** | Her konteynerde CPU ve bellek için `requests == limits` | En son |
| **Burstable** | En az bir requests ya da limits var, ama Guaranteed değil | Ortada (requests'i ne kadar aştığına göre) |
| **BestEffort** | Hiç requests/limits yok | **İlk** |

```bash
kubectl get pods -A -o custom-columns='NS:.metadata.namespace,AD:.metadata.name,QOS:.status.qosClass' | head -15
```

Kritik iş yüklerini (veritabanı, ödeme servisi) Guaranteed yap. Hiç kaynak tanımı olmayan Pod'lar, bir node sıkıştığında ilk gidenlerdir.

## Namespace düzeyinde varsayılanlar ve kotalar

Her geliştiricinin her Pod'a kaynak yazmasını beklemek yerine namespace düzeyinde kurallar konur:

```bash
kubectl create namespace takim-a
cat > kurallar.yaml <<'EOF'
apiVersion: v1
kind: LimitRange
metadata: { name: varsayilanlar, namespace: takim-a }
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 128Mi }   # requests verilmezse
      default: { memory: 256Mi }                     # limits verilmezse
      max: { memory: 1Gi }
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: kota, namespace: takim-a }
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.memory: 8Gi
    pods: "20"
    services.loadbalancers: "0"
EOF
kubectl apply -f kurallar.yaml
kubectl run -n takim-a deneme --image=nginx:1.27-alpine
kubectl get pod -n takim-a deneme -o jsonpath='{.spec.containers[0].resources}{"\n"}'
kubectl describe resourcequota -n takim-a kota
```

- **LimitRange**: Kaynak tanımı olmayan konteynerlere varsayılan değer verir, en az/en çok sınırları uygular. Pod'a hiçbir şey yazmadık ama requests ve limits eklendi.
- **ResourceQuota**: Namespace'in toplamını sınırlar. Kotayı aşacak bir Pod oluşturulmak istenirse API sunucusu reddeder (Deployment'ta Pod oluşturulamaz ve ReplicaSet olaylarında `exceeded quota` görünür).

```bash
kubectl run -n takim-a buyuk --image=nginx:1.27-alpine --overrides='{"spec":{"containers":[{"name":"buyuk","image":"nginx:1.27-alpine","resources":{"limits":{"memory":"2Gi"}}}]}}' 2>&1 | tail -1
kubectl delete namespace takim-a
```

`max: 1Gi` kuralı yüzünden reddedildi.

## Temizlik

```bash
kubectl delete -f probe.yaml
kubectl delete pod istemci
```

## Alıştırma (lab'da)

1. `nginx:1.27-alpine` için Guaranteed QoS sınıfında bir Pod yaz. `kubectl get pod -o jsonpath` ile sınıfını doğrula.
2. Bir Deployment'a, açılışta 20 saniye uyuyan (`sleep 20 && nginx -g 'daemon off;'`) bir komut ver. Sadece liveness probe (`initialDelaySeconds: 0`, `periodSeconds: 3`, `failureThreshold: 2`) ile ne olur? Sorunu startupProbe ile çöz.
3. node01'in ayrılabilir belleğinden (`kubectl describe node node01`, `Allocatable`) daha fazla bellek **request** eden bir Pod oluştur. Ne olur? Olaylarda ne yazıyor?

<details><summary>Çözüm</summary>

```bash
kubectl run garanti --image=nginx:1.27-alpine --overrides='{"spec":{"containers":[{"name":"garanti","image":"nginx:1.27-alpine","resources":{"requests":{"cpu":"100m","memory":"64Mi"},"limits":{"cpu":"100m","memory":"64Mi"}}}]}}'
sleep 5; kubectl get pod garanti -o jsonpath='{.status.qosClass}{"\n"}'; kubectl delete pod garanti

cat > yavas.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: yavas }
spec:
  replicas: 1
  selector: { matchLabels: { app: yavas } }
  template:
    metadata: { labels: { app: yavas } }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          command: ["sh", "-c", "sleep 20 && exec nginx -g 'daemon off;'"]
          livenessProbe:
            httpGet: { path: /, port: 80 }
            periodSeconds: 3
            failureThreshold: 2
EOF
kubectl apply -f yavas.yaml; sleep 45; kubectl get pods -l app=yavas

cat >> yavas.yaml <<'EOF'
          startupProbe:
            httpGet: { path: /, port: 80 }
            periodSeconds: 3
            failureThreshold: 15
EOF
kubectl apply -f yavas.yaml; sleep 40; kubectl get pods -l app=yavas
kubectl delete -f yavas.yaml

kubectl run dev --image=nginx:1.27-alpine --overrides='{"spec":{"containers":[{"name":"dev","image":"nginx:1.27-alpine","resources":{"requests":{"memory":"200Gi"}}}]}}'
sleep 5; kubectl get pod dev; kubectl describe pod dev | grep -A3 Events; kubectl delete pod dev
```

2: Sadece liveness ile uygulama 20 saniyede açılamadan liveness ~6 saniyede başarısız olur ve konteyner sürekli yeniden başlatılır: hiç açılamaz. startupProbe ile açılış için 45 saniyeye kadar süre tanınır, sonra liveness devreye girer.

3: Pod `Pending` kalır. Olaylarda `FailedScheduling ... Insufficient memory`. Scheduler requests'e bakar ve bu kadar ayrılabilir belleği olan bir node yoktur.

</details>

```quiz
readinessProbe başarısız olan bir Pod'a ne olur?
- Yeniden başlatılır
- [x] Service uç noktalarından çıkarılır, çalışmaya devam eder, başarılı olunca geri eklenir
- Silinip başka node'da oluşturulur
? Readiness trafiği, liveness yeniden başlatmayı kontrol eder.
```

```quiz
Veritabanı yavaşladığında bütün API Pod'ları art arda yeniden başlıyor. En olası sebep?
- Bellek sınırı düşük
- [x] livenessProbe veritabanı bağlantısını da kontrol ediyor
- readinessProbe yok
? Liveness sadece sürecin kendisini kontrol etmeli. Bağımlılık sorunlarını yeniden başlatma çözmez.
```

```quiz
Scheduler bir Pod'u yerleştirirken neye bakar?
- Node'ların anlık CPU ve bellek kullanımına
- [x] Node'un ayrılabilir kapasitesinden, üzerindeki Pod'ların **requests** toplamı düşüldükten sonra kalana
- Limits toplamına
? Gerçek kullanım değil, requests. Requests'siz Pod'lar zamanlama açısından yer kaplamaz.
```

```quiz
Node'un belleği bittiğinde kubelet hangi Pod'ları önce tahliye eder?
- Guaranteed
- [x] BestEffort (hiç requests/limits olmayanlar)
- En yeni oluşturulanlar
? Kaynak tanımı olmayan Pod'lar ilk gider. Kritik iş yükleri Guaranteed olmalı.
```

## Özet

- Probe'lar: startup (açılış), liveness (kilitlenme → yeniden başlat), readiness (trafik). Türler: httpGet, tcpSocket, exec, grpc.
- Liveness hafif, bağımlılıksız ve cömert olmalı. Gerekmiyorsa hiç koyma.
- requests → scheduler, limits → çekirdek. Bellek limitini aşan OOMKilled, CPU limitini aşan kısılır.
- Bellek için requests + limits, CPU için gerçekçi requests ve cömert (ya da hiç) limit. Değerleri ölç.
- QoS: Guaranteed > Burstable > BestEffort. Kritik iş yükleri Guaranteed.
- LimitRange (varsayılanlar, min/max), ResourceQuota (namespace toplamı).
