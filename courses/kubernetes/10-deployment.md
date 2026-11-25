# ReplicaSet, Deployment, etiketler ve rollout

Durumsuz (stateless) uygulamaların neredeyse hepsi Kubernetes'te bir **Deployment** olarak çalışır: web servisleri, API'ler, worker'lar. Deployment, istenen sayıda Pod'u ayakta tutar, yeni sürüme kesintisiz geçer, sürüm geçmişini saklar ve geri alınabilir. Bu derste Deployment'ın altındaki ReplicaSet'i, her şeyi birbirine bağlayan etiket ve seçicileri ve rollout mekanizmasını ayrıntılı göreceğiz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Etiketler ve seçiciler

Kubernetes'te nesneler birbirini **ad ile değil, etiketle** bulur. Bir ReplicaSet "benim Pod'larım hangileri?" sorusunu seçicisiyle cevaplar:

```bash
kubectl run a --image=nginx:1.27-alpine --labels="app=web,surum=1"
kubectl run b --image=nginx:1.27-alpine --labels="app=web,surum=2"
kubectl run c --image=nginx:1.27-alpine --labels="app=api"
kubectl get pods --show-labels
kubectl get pods -l app=web
kubectl get pods -l 'app=web,surum!=1'
kubectl get pods -l 'app in (web,api)'
kubectl get pods -L app,surum
kubectl delete pod a b c
```

İki tür seçici var:

| Tür | Yazım | Kim kullanır |
|---|---|---|
| Eşitlik tabanlı | `app=web`, `surum!=1` | Service (`spec.selector`), eski nesneler |
| Küme tabanlı | `matchLabels` + `matchExpressions` (`In`, `NotIn`, `Exists`) | Deployment, ReplicaSet, Job, DaemonSet, NetworkPolicy |

Yaygın bir etiket kümesi: `app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/version`, `app.kubernetes.io/component`, `app.kubernetes.io/part-of`. Helm ve pek çok araç bunları kullanır. Sadeliği korumak için bu derste `app` kullanacağız.

## ReplicaSet

ReplicaSet'in tek işi: seçicisine uyan **tam N tane** Pod olmasını sağlamak.

```bash
cat > rs.yaml <<'EOF'
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-rs
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-rs
  template:                 # yeni Pod'lar bu şablondan üretilir
    metadata:
      labels:
        app: web-rs         # seçiciye UYMALI
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
EOF
kubectl apply -f rs.yaml
kubectl get rs,pods -l app=web-rs
```

Etiketlerin gücünü (ve tehlikesini) göster: Bir Pod'un etiketini değiştir.

```bash
P=$(kubectl get pod -l app=web-rs -o jsonpath='{.items[0].metadata.name}')
kubectl label pod $P app=karantina --overwrite
kubectl get pods -L app
```

Etiketi değişen Pod ReplicaSet'in seçicisinden **çıktı** ve çalışmaya devam ediyor, ReplicaSet "2 Pod var, 3 istenmiş" diyerek yenisini oluşturdu. Bu, sorunlu bir Pod'u inceleme için trafikten ve denetleyiciden **ayırmanın** bir yoludur: Service'in seçicisine uymadığı için trafik almaz, ama silinmez.

Tersi de olur: Seçiciye uyan etiketle elle bir Pod oluşturursan ReplicaSet onu sahiplenir ve fazla olduğu için bir Pod'u siler. **Seçicilerin çakışmaması** bu yüzden önemli.

```bash
kubectl delete pod $P
kubectl delete -f rs.yaml
```

ReplicaSet'i doğrudan kullanmazsın: güncelleme stratejisi yoktur. Şablondaki imajı değiştirsen bile var olan Pod'lara dokunmaz, sadece **yeni** oluşturulanlar yeni şablonu kullanır. Sürüm geçişini **Deployment** yönetir.

## Deployment

```bash
cat > deploy.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 4
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: traefik/whoami:v1.10
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet: { path: /health, port: 80 }
            periodSeconds: 2
EOF
kubectl apply -f deploy.yaml
kubectl rollout status deployment/web
kubectl get deploy,rs,pods -l app=web
```

`kubectl get deploy` sütunları:

| Sütun | Anlamı |
|---|---|
| `READY` | Hazır Pod / istenen |
| `UP-TO-DATE` | Güncel şablonla oluşturulmuş Pod sayısı |
| `AVAILABLE` | `minReadySeconds` boyunca hazır kalmış Pod sayısı |

ReplicaSet'in adında bir karma (`web-7c9d...`) var: Pod şablonunun özeti. Şablon her değiştiğinde **yeni bir ReplicaSet** oluşur.

> `spec.selector` Deployment oluşturulduktan sonra **değiştirilemez**. Etiket şemanı baştan düşün.

## Rolling update

Şablonda herhangi bir değişiklik (imaj, ortam değişkeni, kaynak sınırı, etiket) bir rollout başlatır. İzlemek için ikinci bir sekmede ReplicaSet'leri izle:

```bash
kubectl get rs -l app=web -w
```

İlk sekmede imajı değiştir:

```bash
kubectl set image deployment/web web=traefik/whoami:v1.10.1
kubectl annotate deployment/web kubernetes.io/change-cause="whoami v1.10.1"
kubectl rollout status deployment/web
```

İzleme sekmesinde yeni ReplicaSet'in birer birer büyüdüğünü, eskisinin birer birer küçüldüğünü görürsün. Deployment denetleyicisi iki ReplicaSet'in replika sayılarını, aşağıdaki iki parametreye uyarak ayarlıyor:

| Parametre | Anlamı | Bizdeki değer |
|---|---|---|
| `maxSurge` | Geçiş sırasında istenen sayının **üstüne** en fazla kaç Pod | 1: en fazla 5 Pod |
| `maxUnavailable` | Geçiş sırasında istenen sayının **altına** en fazla kaç hazır olmayan Pod | 0: hiçbir an 4'ün altına düşme |

Varsayılan değerler `25%` / `25%`. `maxUnavailable: 0` + `maxSurge: 1`, Swarm'daki `start-first` gibi: önce yeni Pod hazır olur, sonra eskisi kapatılır. Bunun çalışması için **readinessProbe** şart: Kubernetes yeni Pod'un "hazır" olduğunu probe'dan anlar. Probe yoksa konteyner başlar başlamaz hazır sayılır ve henüz istek alamayan Pod'lara trafik gönderilir (probe dersi).

Diğer strateji `Recreate`: önce bütün eski Pod'ları siler, sonra yenilerini başlatır. Kesinti olur. İki sürümün aynı anda çalışamadığı durumlar için (veritabanı şemasıyla uyumsuz eski kod, tek yazıcılı bir volume).

### Rollout sırasında kesinti var mı?

```bash
kubectl expose deployment web --port=80
kubectl run yuk --image=curlimages/curl:8.10.1 --restart=Never -- sh -c 'for i in $(seq 1 200); do curl -s -o /dev/null -w "%{http_code} " http://web/; sleep 0.1; done'
kubectl set image deployment/web web=traefik/whoami:v1.10.2
kubectl rollout status deployment/web
sleep 5; kubectl logs yuk | tr ' ' '\n' | sort | uniq -c
kubectl delete pod yuk
```

Bütün yanıtlar `200` olmalı (`expose` ile oluşturulan Service bir sonraki dersin konusu).

## Geçmiş ve geri alma

```bash
kubectl rollout history deployment/web
kubectl rollout history deployment/web --revision=2
kubectl get rs -l app=web
```

Eski ReplicaSet'ler 0 replikayla saklanır (`revisionHistoryLimit` kadar): Geri alma, eski bir ReplicaSet'i yeniden büyütmektir.

Bozuk bir sürüm deploy edelim:

```bash
kubectl set image deployment/web web=traefik/whoami:boyle-bir-surum-yok
kubectl rollout status deployment/web --timeout=30s
kubectl get pods -l app=web
```

`rollout status` zaman aşımına uğradı. `maxUnavailable: 0` sayesinde **eski 4 Pod çalışmaya devam ediyor**: Yeni Pod `ImagePullBackOff`'ta ve hiçbir zaman hazır olmadığı için Kubernetes eskileri kapatmadı. Kullanıcılar hiçbir şey fark etmedi.

```bash
kubectl rollout undo deployment/web
kubectl rollout status deployment/web
kubectl rollout history deployment/web
kubectl rollout undo deployment/web --to-revision=1      # belirli bir revizyona
```

### İlerleme zaman aşımı

```bash
kubectl get deployment web -o jsonpath='{.spec.progressDeadlineSeconds}{"\n"}'
kubectl describe deployment web | grep -A4 Conditions
```

`progressDeadlineSeconds` (varsayılan 600) içinde rollout ilerlemezse Deployment'ın `Progressing` koşulu `False` (`ProgressDeadlineExceeded`) olur. Kubernetes **otomatik geri almaz** (Swarm'daki `failure_action: rollback`'ten farkı): sadece durumu raporlar. Otomatik geri alma CI/CD hattının işidir: `kubectl rollout status --timeout` başarısız olursa `rollout undo` çalıştırmak, ya da Argo Rollouts gibi ileri araçlar (GitOps dersi).

### Duraklatma

Birden fazla değişikliği tek bir rollout'ta toplamak için:

```bash
kubectl rollout pause deployment/web
kubectl set image deployment/web web=traefik/whoami:v1.10.3
kubectl set env deployment/web SURUM=3
kubectl rollout resume deployment/web
kubectl rollout status deployment/web
```

Ortam değişkeni değişmeden imajı aynı tutup Pod'ları yeniden başlatmak için (ConfigMap güncellendikten sonra sık kullanılır):

```bash
kubectl rollout restart deployment/web
```

Bu, şablona bir zaman damgası annotation'ı ekler ve normal bir rolling update başlatır.

## Ölçekleme

```bash
kubectl scale deployment web --replicas=6
kubectl get pods -l app=web -o wide
```

Elle ölçekleme. Yük bazlı otomatik ölçekleme (HPA) ölçekleme dersinde. Dikkat: HPA kullanan bir Deployment'ın YAML'ında `replicas` alanını sabit tutarsan her `apply` HPA'nın kararını ezer.

## İleri dağıtım stratejileri

Deployment sadece rolling update ve recreate bilir. Diğer stratejiler bu yapı taşlarıyla ya da ek araçlarla kurulur:

| Strateji | Nasıl |
|---|---|
| **Blue-green** | İki Deployment (`web-blue`, `web-green`), Service seçicisini birinden ötekine çevirmek |
| **Canary** | Aynı etiketi taşıyan küçük ikinci bir Deployment (1 replika yeni sürüm, 9 replika eski): trafiğin yaklaşık %10'u yeni sürüme. Hassas yüzdeler için Ingress/Gateway ağırlıkları ya da servis ağı |
| **Otomatik analizli canary** | Argo Rollouts, Flagger: metrikleri izleyip adım adım ilerler ya da geri alır |

## Temizlik

```bash
kubectl delete deployment web
kubectl delete service web
```

## Alıştırma (lab'da)

1. `nginx:1.26-alpine` imajıyla 3 replikalı, `maxSurge: 0`, `maxUnavailable: 1` stratejili bir Deployment oluştur. `nginx:1.27-alpine`'a güncellerken Pod sayısının hiç 3'ün üstüne çıkmadığını izle. Bu strateji ne zaman tercih edilir?
2. Bir Pod'un etiketini değiştirerek onu Deployment'tan ayır. Deployment ne yapar? Ayrılan Pod'u nasıl temizlersin?
3. Üç farklı imaj sürümüyle üç rollout yap, `change-cause` annotation'larını ekle, `rollout history` çıktısını gör ve 1. revizyona dön.

<details><summary>Çözüm</summary>

```bash
kubectl create deployment n --image=nginx:1.26-alpine --replicas=3 --dry-run=client -o yaml > n.yaml
sed -i 's/  strategy: {}/  strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxSurge: 0\n      maxUnavailable: 1/' n.yaml
kubectl apply -f n.yaml && kubectl rollout status deploy/n
kubectl get pods -l app=n -w &
kubectl set image deploy/n nginx=nginx:1.27-alpine && kubectl rollout status deploy/n
kill %1

P=$(kubectl get pod -l app=n -o jsonpath='{.items[0].metadata.name}')
kubectl label pod $P app=ayrik --overwrite
kubectl get pods -L app
kubectl delete pod -l app=ayrik

for v in 1.27.1-alpine 1.27.2-alpine 1.27.3-alpine; do
  kubectl set image deploy/n nginx=nginx:$v
  kubectl annotate deploy/n kubernetes.io/change-cause="nginx $v" --overwrite
  kubectl rollout status deploy/n
done
kubectl rollout history deploy/n
kubectl rollout undo deploy/n --to-revision=1
kubectl delete deploy n
```

1: Fazladan Pod açılmaz, geçici olarak bir Pod eksik çalışılır. Ek kaynak yokken (küme dolu, lisans ya da kota sınırı) ya da fazladan kopyanın sorun yaratacağı durumlarda tercih edilir.

2: Deployment (ReplicaSet üzerinden) eksik Pod'u tamamlamak için yenisini oluşturur. Ayrılan Pod artık kimseye ait değildir ve elle silinmesi gerekir.

3: Sürümleri bilerek daha önce kullanılmamış imajlardan seçtik. Daha önce kullanılmış bir şablona dönersen Kubernetes yeni ReplicaSet oluşturmaz, eski ReplicaSet'i yeniden kullanır ve onun revizyon numarası en yeniye taşınır: eski numara geçmişten kaybolur.

</details>

```quiz
Deployment'ın Pod şablonundaki imajı değiştirdiğinde ne olur?
- Var olan Pod'lar yerinde güncellenir
- [x] Yeni bir ReplicaSet oluşturulur ve eski ReplicaSet'ten yeniye kademeli geçilir
- Bütün Pod'lar aynı anda silinip yeniden oluşturulur
? Her şablon değişikliği yeni bir ReplicaSet üretir. Eskiler geri alma için 0 replikayla saklanır.
```

```quiz
`maxUnavailable: 0` ve `maxSurge: 1` ile bozuk bir imaja güncelleme yaptın. Kullanıcılar etkilenir mi?
- Evet, Pod'lar tek tek bozulur
- [x] Hayır, yeni Pod hiç hazır olmadığı için eski Pod'lar kapatılmaz
- Kubernetes otomatik geri alır
? Rollout takılır ve eski sürüm çalışmaya devam eder. Geri alma (rollout undo) elle ya da CI tarafından yapılır.
```

```quiz
Bir Pod'un `app` etiketini değiştirdin ve Deployment'ın seçicisinden çıktı. Ne olur?
- Pod silinir
- [x] Pod çalışmaya devam eder ama artık Deployment'a ait değildir. Deployment eksik sayıyı tamamlamak için yeni Pod oluşturur
- Deployment hata verir
? Sahiplik etiketlerle belirlenir. Bu yöntem sorunlu bir Pod'u inceleme için ayırmakta kullanılır.
```

## Özet

- Nesneler birbirine etiket + seçiciyle bağlanır. Seçiciler çakışmamalı. Deployment seçicisi değiştirilemez.
- ReplicaSet: tam N Pod. Deployment: ReplicaSet'leri yöneterek rollout ve geçmiş.
- `RollingUpdate` (`maxSurge`, `maxUnavailable`) ve `Recreate`. Kesintisiz geçiş için readinessProbe şart.
- `rollout status/history/undo/pause/resume/restart`. Kubernetes otomatik geri almaz, `progressDeadlineSeconds` ile raporlar.
- Blue-green ve canary, Deployment + Service seçicileriyle ya da Argo Rollouts gibi araçlarla.
