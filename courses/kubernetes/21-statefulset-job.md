# StatefulSet, DaemonSet, Job ve CronJob

Deployment, birbirinin yerine geçebilen (değiştirilebilir) Pod'lar içindir: hangi replikanın isteği karşıladığı önemli değildir, her birinin adı rastgeledir, hepsi aynı anda başlayıp kapanabilir. Ama her iş yükü böyle değildir. Bu derste Kubernetes'in diğer iş yükü denetleyicilerini göreceğiz:

| Denetleyici | Ne için | Swarm/Linux karşılığı |
|---|---|---|
| **StatefulSet** | Kimliği ve verisi olan replikalar: veritabanları, kuyruklar, kümelenmiş sistemler | (Swarm'da yok) |
| **DaemonSet** | Her node'da bir Pod: log/metrik ajanları, ağ ve depolama eklentileri | Swarm `--mode global` |
| **Job** | Bitene kadar çalışan iş: migration, toplu işlem | Tek seferlik konteyner |
| **CronJob** | Zamanlanmış Job | cron, systemd timer |

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
Önceki dersteki local-path-provisioner kurulu değilse o dersin "StorageClass ve dinamik oluşturma" bölümündeki komutları çalıştır.
```

## StatefulSet

StatefulSet her replikaya üç **kalıcı** özellik verir:

1. **Sabit, sıralı ad**: `db-0`, `db-1`, `db-2`. Pod yeniden oluşturulsa da aynı adı alır.
2. **Sabit DNS adı**: Headless bir Service üzerinden `db-0.db.<namespace>.svc.cluster.local`. Pod IP'si değişse de ad aynı kalır.
3. **Kendine ait kalıcı depolama**: `volumeClaimTemplates` ile her replikanın kendi PVC'si olur (`veri-db-0`, `veri-db-1`). `db-1` yeniden oluşturulursa **aynı** PVC'yi geri alır.

Ayrıca sıralı davranış: Pod'lar varsayılan olarak sırayla oluşturulur (`db-0` hazır olmadan `db-1` başlamaz) ve ters sırayla silinir. Birincil replikanın önce başlaması gereken veritabanları için önemlidir.

```bash
cat > sts.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: kayit
spec:
  clusterIP: None              # headless: StatefulSet Pod'larına DNS adı verir
  selector: { app: kayit }
  ports: [{ port: 80, name: http }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kayit
spec:
  serviceName: kayit           # yukarıdaki headless Service
  replicas: 3
  selector: { matchLabels: { app: kayit } }
  template:
    metadata: { labels: { app: kayit } }
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports: [{ containerPort: 80, name: http }]
          command: ["sh", "-c"]
          args:
            - |
              [ -f /usr/share/nginx/html/index.html ] || echo "ilk oluşturan: $(hostname) $(date +%T)" > /usr/share/nginx/html/index.html
              exec nginx -g 'daemon off;'
          volumeMounts:
            - { name: veri, mountPath: /usr/share/nginx/html }
  volumeClaimTemplates:
    - metadata: { name: veri }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 100Mi } }
EOF
kubectl apply -f sts.yaml
kubectl get pods -l app=kayit -w &
sleep 45; kill %1
kubectl get sts,pods,pvc -l app=kayit
```

İzleme çıktısında Pod'ların **sırayla** oluştuğunu gördün: `kayit-0` Ready olunca `kayit-1`, sonra `kayit-2`. Her biri için ayrı bir PVC: `veri-kayit-0`, `veri-kayit-1`, `veri-kayit-2`.

### Sabit DNS adları

```bash
kubectl run dns --image=busybox:1.36 --restart=Never --rm -it -- sh -c 'nslookup kayit; for i in 0 1 2; do wget -q -O - http://kayit-$i.kayit; done'
```

Headless Service adı (`kayit`) bütün Pod IP'lerini döner, ama her Pod'a ayrı ayrı da sabit adıyla ulaşılır. Bir veritabanı kümesinde "birincil `db-0.db`'dir, replikalar ona bağlanır" gibi yapılandırmalar bu sayede yazılabilir.

### Kimlik ve veri korunur

```bash
kubectl delete pod kayit-1
kubectl get pods -l app=kayit -w &
sleep 20; kill %1
kubectl exec kayit-1 -- cat /usr/share/nginx/html/index.html
```

Silinen Pod **aynı adla** (`kayit-1`, rastgele bir son ek değil) yeniden oluştu ve **aynı PVC**'yi bağladı: içindeki dosya ilk oluşturulduğu zamanı gösteriyor. Deployment'ta bu davranış yok.

### Ölçekleme ve PVC'ler

```bash
kubectl scale sts kayit --replicas=1
sleep 20
kubectl get pods,pvc -l app=kayit
```

Pod'lar ters sırayla (`kayit-2`, sonra `kayit-1`) silindi, ama **PVC'ler kaldı**. Tekrar ölçeklenince `kayit-1` ve `kayit-2` kendi eski verilerine kavuşur. Bu bilinçli bir güvenlik önlemi: Ölçek küçültmek veriyi silmemeli. Kubernetes 1.27+ ile `persistentVolumeClaimRetentionPolicy` alanında bu davranış değiştirilebilir (`whenScaled: Delete`, `whenDeleted: Delete`).

```bash
kubectl scale sts kayit --replicas=3
```

### Güncelleme stratejisi

```bash
kubectl get sts kayit -o jsonpath='{.spec.updateStrategy}{"\n"}'
```

Varsayılan `RollingUpdate`: Pod'lar **ters sırayla** (en büyük sıra numarasından başlayarak), her seferinde bir tane güncellenir ve her biri hazır olmadan bir sonrakine geçilmez. `partition` alanıyla canary yapılabilir: `partition: 2` sadece sıra numarası 2 ve üstündeki Pod'ları günceller, gerisi eski sürümde kalır.

`podManagementPolicy: Parallel` ile sıralı oluşturma ve silme kapatılabilir (Pod'lar arasında sıra bağımlılığı olmayan, ama sabit kimlik ve depolama isteyen sistemler için).

### StatefulSet ile veritabanı: gerçekçi beklenti

StatefulSet sabit ad ve depolama sağlar, ama **replikasyonu, yük devretmeyi (failover) ve yedeklemeyi sağlamaz**. Üç replikalı bir PostgreSQL StatefulSet'i, üç bağımsız ve birbirinden habersiz veritabanıdır. Birincil/ikincil yapılandırması, birincil ölünce terfi, yedekler ve yükseltmeler için veritabanını tanıyan bir **operatör** kullanılır:

| Sistem | Operatör örnekleri |
|---|---|
| PostgreSQL | CloudNativePG, Zalando Postgres Operator, Crunchy PGO |
| MySQL | Percona Operator, MySQL Operator, Vitess |
| Redis | Redis Operator (Spotahome, OT-Container-Kit) |
| Kafka | Strimzi |

Operatörler, Kubernetes API'sine yeni nesne türleri (CRD: `Cluster`, `Kafka`) ekleyen ve bu nesneleri uzlaştırma döngüsüyle yöneten denetleyicilerdir: Mimari dersindeki modelin, bir uzmanın bilgisiyle genişletilmiş hâli.

```bash
kubectl delete -f sts.yaml
kubectl delete pvc -l app=kayit
```

## DaemonSet

```bash
cat > ds.yaml <<'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-ajan
spec:
  selector: { matchLabels: { app: node-ajan } }
  template:
    metadata: { labels: { app: node-ajan } }
    spec:
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: ajan
          image: busybox:1.36
          command: ["sh", "-c", "while true; do echo \"$(date +%T) node=$NODE_ADI yük: $(cut -d' ' -f1 /host/proc/loadavg)\"; sleep 10; done"]
          env:
            - name: NODE_ADI
              valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
          volumeMounts:
            - { name: proc, mountPath: /host/proc, readOnly: true }
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
      volumes:
        - name: proc
          hostPath: { path: /proc }
EOF
kubectl apply -f ds.yaml
sleep 15
kubectl get ds,pods -l app=node-ajan -o wide
kubectl logs -l app=node-ajan --prefix --tail=1
```

Her node'da (control plane dahil) bir Pod. Yeni bir node kümeye katılınca DaemonSet ona da otomatik bir Pod yerleştirir.

Öne çıkanlar:

- **`tolerations`**: Control plane node'unun bir **taint**'i var (`NoSchedule`): normal Pod'lar oraya gitmez. DaemonSet'in oraya da gitmesi için bu taint'i tolere etmesi gerekir. Taint ve toleration'lar zamanlama dersinde.
- **`fieldRef: spec.nodeName`**: Downward API ile Pod kendi node'unun adını öğrendi. Aynı yöntemle Pod adı, namespace'i, IP'si, etiketleri ve kaynak sınırları da konteynere verilebilir.
- **`hostPath`**: Node'un `/proc`'unu salt okunur bağladı. DaemonSet'lerin meşru kullanım alanı budur: node metrikleri (node-exporter), log dosyaları (`/var/log`), CNI ve CSI eklentileri.

Kümende zaten DaemonSet'ler çalışıyor:

```bash
kubectl get ds -A
```

`kube-proxy` ve ağ eklentisinin Pod'ları (Calico, Flannel, Cilium) birer DaemonSet.

Belirli node'larla sınırlamak için Pod şablonuna `nodeSelector` (ya da affinity) eklenir: Örneğin sadece GPU'lu node'larda bir sürücü ajanı.

```bash
kubectl delete -f ds.yaml
```

## Job

```bash
cat > job.yaml <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: rapor
spec:
  completions: 6            # toplam kaç başarılı Pod
  parallelism: 2            # aynı anda kaç Pod
  backoffLimit: 3           # kaç başarısızlıktan sonra Job başarısız sayılır
  activeDeadlineSeconds: 300
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: is
          image: busybox:1.36
          command: ["sh", "-c", "echo \"parça işleniyor: $(hostname)\"; sleep 5; echo bitti"]
EOF
kubectl apply -f job.yaml
kubectl get pods -l job-name=rapor -w &
sleep 25; kill %1
kubectl get job rapor
kubectl logs -l job-name=rapor --prefix --tail=1
```

İkişer ikişer, toplam 6 Pod çalıştı. Job `Complete`.

| Alan | Anlamı |
|---|---|
| `completions` | Kaç başarılı tamamlanma gerekiyor (varsayılan 1) |
| `parallelism` | Aynı anda en fazla kaç Pod |
| `backoffLimit` | Başarısızlık sınırı (varsayılan 6). Yeniden denemeler artan bekleme süreleriyle |
| `activeDeadlineSeconds` | Job'ın toplam süre sınırı |
| `ttlSecondsAfterFinished` | Bittikten sonra Job ve Pod'larını otomatik sil (yoksa birikirler) |
| `restartPolicy` | `Never` (başarısız Pod'u bırak, yenisini oluştur) ya da `OnFailure` (aynı Pod'da konteyneri yeniden başlat) |

`completionMode: Indexed` ile her Pod'a 0'dan başlayan bir sıra numarası verilir (`JOB_COMPLETION_INDEX` ortam değişkeni): Büyük bir veri kümesini parçalara bölüp her Pod'un kendi parçasını işlemesi için.

### Başarısız Job

```bash
kubectl create job hata --image=busybox:1.36 -- sh -c 'echo deniyorum; exit 1'
sleep 60
kubectl get job hata
kubectl get pods -l job-name=hata
kubectl describe job hata | grep -A5 Events
kubectl delete job hata
```

`backoffLimit` (6) dolunca Job `Failed` olur ve olaylarda `BackoffLimitExceeded` görünür. Başarısız Pod'lar logları incelenebilsin diye silinmez (`restartPolicy: Never` ile).

### Migration için Job

Docker kursundaki "migration ayrı, tek seferlik servis" ilkesinin Kubernetes karşılığı bir Job'dır. Deploy sırasında: önce migration Job'ı çalıştırılır, `kubectl wait --for=condition=complete job/migrate --timeout=300s` ile beklenir, başarılıysa Deployment güncellenir. Helm'de `pre-upgrade` hook'u, Argo CD'de `PreSync` hook'u bunu otomatikleştirir (paketleme bölümü).

## CronJob

```bash
cat > cron.yaml <<'EOF'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: temizlik
spec:
  schedule: "*/1 * * * *"
  timeZone: "Europe/Istanbul"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 120
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: temizlik
              image: busybox:1.36
              command: ["sh", "-c", "echo \"$(date) eski kayıtlar temizlendi\""]
EOF
kubectl apply -f cron.yaml
sleep 130
kubectl get cronjob,jobs
kubectl logs -l job-name --tail=1 --prefix 2>/dev/null | tail -2
```

| Alan | Anlamı |
|---|---|
| `schedule` | Linux kursundaki cron biçimi |
| `timeZone` | Saat dilimi (verilmezse kube-controller-manager'ın saat dilimi, genelde UTC) |
| `concurrencyPolicy` | Önceki çalışma bitmeden yenisi geldiyse: `Allow` (varsayılan, paralel çalıştır), `Forbid` (atla), `Replace` (eskisini durdur, yenisini başlat) |
| `startingDeadlineSeconds` | Zamanında başlatılamazsa (denetleyici kapalıydı) en fazla ne kadar gecikmeyle başlatılabilir. Linux kursundaki `Persistent=true`'ya benzer |
| `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` | Kaç eski Job tutulsun |

`concurrencyPolicy: Forbid`, Linux kursundaki `flock -n`'in karşılığıdır: Uzun süren bir iş üst üste binmez.

Elle tetiklemek (cron ifadesini beklemeden test etmek):

```bash
kubectl create job --from=cronjob/temizlik elle-deneme
sleep 10; kubectl logs job/elle-deneme
kubectl delete -f cron.yaml; kubectl delete job elle-deneme
```

> Linux kursundaki "sessizce başarısız olan yedek" riski burada da geçerli. CronJob başarısızlıklarını izle: `kube_job_status_failed` metriği (kube-state-metrics) üzerinden alarm ya da işin sonunda bir "ölü adam" izleme servisine ping (gözlem dersi).

## Alıştırma (lab'da)

1. 2 replikalı bir StatefulSet oluştur (`redis:7-alpine`, `--appendonly yes`, `/data` için 100Mi'lık volumeClaimTemplate). `redis-0`'a bir anahtar yaz, Pod'u sil, yeniden oluşunca anahtarın durduğunu doğrula. `redis-1`'de o anahtar var mı? Neden?
2. `completionMode: Indexed`, `completions: 4`, `parallelism: 4` olan bir Job yaz. Her Pod `JOB_COMPLETION_INDEX`'i yazdırsın. Logları karşılaştır.
3. 2 dakika süren bir işi her dakika çalıştıran bir CronJob'ı önce `concurrencyPolicy: Allow`, sonra `Forbid` ile çalıştır. Aynı anda kaç Job çalıştığını karşılaştır.

<details><summary>Çözüm</summary>

```bash
cat > redis-sts.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata: { name: redis }
spec: { clusterIP: None, selector: { app: redis }, ports: [{ port: 6379 }] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: redis }
spec:
  serviceName: redis
  replicas: 2
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis } }
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          args: ["--appendonly", "yes"]
          volumeMounts: [{ name: data, mountPath: /data }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 100Mi } } }
EOF
kubectl apply -f redis-sts.yaml && kubectl rollout status sts/redis
kubectl exec redis-0 -- redis-cli SET anahtar deger
kubectl delete pod redis-0; kubectl rollout status sts/redis; sleep 3
kubectl exec redis-0 -- redis-cli GET anahtar
kubectl exec redis-1 -- redis-cli GET anahtar
kubectl delete -f redis-sts.yaml; kubectl delete pvc -l app=redis

cat > idx.yaml <<'EOF'
apiVersion: batch/v1
kind: Job
metadata: { name: idx }
spec:
  completionMode: Indexed
  completions: 4
  parallelism: 4
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: is
          image: busybox:1.36
          command: ["sh", "-c", "echo \"ben $JOB_COMPLETION_INDEX numaralı parçayı işliyorum\""]
EOF
kubectl apply -f idx.yaml; kubectl wait --for=condition=complete job/idx --timeout=60s
kubectl logs -l job-name=idx --prefix; kubectl delete -f idx.yaml
```

1: `redis-1`'de anahtar yok (`(nil)`). İki replika bağımsız Redis sunucuları, her birinin kendi PVC'si var. StatefulSet replikasyon yapmaz. Replikasyon için Redis'in kendi yapılandırması ya da bir operatör gerekir.

3: `Allow` ile her dakika yeni bir Job başlar ve 2 dakika süren işler üst üste biner (aynı anda 2-3 Job). `Forbid` ile önceki bitmeden gelen çalıştırmalar atlanır, aynı anda en fazla 1 Job.

</details>

```quiz
StatefulSet'teki `db-1` Pod'u silindi. Yeniden oluşturulan Pod hakkında hangisi doğru?
- Rastgele bir adla oluşur ve yeni boş bir PVC alır
- [x] Yine `db-1` adını ve aynı PVC'yi (`veri-db-1`) alır
- `db-3` adıyla oluşur
? StatefulSet replikalara sabit kimlik ve kendine ait depolama verir.
```

```quiz
3 replikalı bir PostgreSQL StatefulSet'i otomatik olarak birincil/ikincil replikasyon sağlar mı?
- Evet
- [x] Hayır, sadece sabit ad ve depolama sağlar. Replikasyon ve failover için veritabanı operatörü gerekir
- Sadece headless Service ile
? CloudNativePG gibi operatörler veritabanı bilgisini uzlaştırma döngüsüne ekler.
```

```quiz
Her gece çalışan bir yedek CronJob'u bazen 1 saatten fazla sürüyor ve bir sonraki çalışmayla çakışıyor. Çözüm?
- `parallelism: 1`
- [x] `concurrencyPolicy: Forbid`
- `backoffLimit: 0`
? Forbid, önceki Job bitmeden yenisinin başlamasını engeller (flock -n karşılığı).
```

## Özet

- StatefulSet: sabit sıralı ad, headless Service ile sabit DNS (`pod.servis`), `volumeClaimTemplates` ile replika başına PVC. Sıralı oluşturma/silme. Ölçek küçültmek PVC'leri silmez.
- Veritabanları için StatefulSet + operatör (replikasyon, failover, yedek).
- DaemonSet: her node'da bir Pod. Control plane için toleration, Downward API ile node adı, hostPath ile node verisi.
- Job: `completions`, `parallelism`, `backoffLimit`, `ttlSecondsAfterFinished`, Indexed mod. Migration'lar için.
- CronJob: `schedule`, `timeZone`, `concurrencyPolicy: Forbid`, `startingDeadlineSeconds`, geçmiş limitleri. `create job --from=cronjob/...` ile test.
