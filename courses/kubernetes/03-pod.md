# Pod: konteynerler, yaşam döngüsü, init ve sidecar

Kubernetes konteynerleri doğrudan çalıştırmaz: en küçük birim **Pod**'dur. Pod, aynı node'da birlikte çalışan, ağı ve isteğe bağlı olarak depolamayı paylaşan bir ya da birden fazla konteynerdir. Üretimde Pod'ları neredeyse hiç doğrudan oluşturmazsın (Deployment ve diğer denetleyiciler oluşturur), ama bir Pod'un nasıl başladığını, nasıl öldüğünü ve neden çalışmadığını anlamak, Kubernetes'te sorun gidermenin yarısıdır.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Pod nedir?

Docker kursunun ağ dersinde `--network container:X` ile iki konteynerin aynı ağ namespace'ini paylaşmasını görmüştük. Pod tam olarak budur:

- Pod'daki bütün konteynerler **aynı ağ namespace'ini** paylaşır: tek bir IP, birbirine `localhost` üzerinden ulaşma, aynı port alanı (iki konteyner aynı portu dinleyemez).
- Pod düzeyinde tanımlanan **volume**'leri istedikleri konteynere bağlayarak dosya paylaşabilirler.
- Birlikte zamanlanır (aynı node), birlikte başlatılır ve silinir.

Bunu sağlayan, her Pod'da gizlice çalışan küçük bir **pause** konteyneridir: namespace'leri o tutar, uygulama konteynerleri ona katılır.

```bash
kubectl run demo --image=nginx:1.27-alpine
kubectl get pod demo -o wide
ssh node01 'crictl pods --name demo; crictl ps --name nginx'
```

(Control plane node'u varsayılan olarak uygulama Pod'u almadığı için Pod `node01`'de çalışıyor. Killercoda'da `ssh node01` ile o node'a geçebilirsin. `crictl pods` Pod sandbox'ını, yani pause konteynerinin tuttuğu namespace'leri, `crictl ps` uygulama konteynerini gösterir.)

### Neden birden fazla konteyner?

Kural: **Bir Pod, bir uygulama örneği**. İki bağımsız uygulamayı (web + veritabanı) aynı Pod'a koymak yanlıştır: birlikte ölçeklenir, birlikte yeniden başlatılırlar. Birden fazla konteyner, **ana uygulamaya yardımcı** olan süreçler içindir:

| Kalıp | Örnek |
|---|---|
| **Sidecar** | Uygulamanın log dosyalarını okuyup merkezi sisteme gönderen ajan, servis ağı proxy'si (Envoy), sertifika yenileyici |
| **Adapter** | Uygulamanın metriklerini Prometheus biçimine çeviren dönüştürücü |
| **Ambassador** | Uygulamanın `localhost:5432`'ye bağlandığı, arkada doğru veritabanına yönlendiren proxy (Cloud SQL proxy) |
| **Init** | Uygulama başlamadan önce bir kez çalışan hazırlık işleri (aşağıda) |

## Pod manifest'i

```bash
cat > pod.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
    - name: nginx
      image: nginx:1.27-alpine
      ports:
        - containerPort: 80
          name: http
      volumeMounts:
        - name: icerik
          mountPath: /usr/share/nginx/html
    - name: yazar
      image: busybox:1.36
      command: ["sh", "-c"]
      args:
        - |
          while true; do
            echo "<h1>$(date) - $(hostname)</h1>" > /veri/index.html
            sleep 5
          done
      volumeMounts:
        - name: icerik
          mountPath: /veri
  volumes:
    - name: icerik
      emptyDir: {}
EOF
kubectl apply -f pod.yaml
kubectl get pod web -o wide
```

İki konteyner, `emptyDir` volume'ü üzerinden dosya paylaşıyor: `yazar` her 5 saniyede bir sayfa yazıyor, `nginx` onu sunuyor.

```bash
kubectl exec web -c nginx -- wget -q -O - localhost
kubectl exec web -c yazar -- wget -q -O - localhost:80
kubectl logs web -c yazar
```

`yazar` konteyneri de `localhost:80`'e erişebildi: aynı ağ namespace'i. `-c` ile hangi konteynerle çalışacağını seçtin.

- **`emptyDir`**: Pod oluşturulunca boş olarak açılan, Pod silinince silinen geçici volume. Konteyner yeniden başlasa da içeriği korunur (Pod yaşadığı sürece). `emptyDir: {medium: Memory}` ile tmpfs (RAM) olur.
- **`containerPort`**: Docker'daki `EXPOSE` gibi **bilgi amaçlıdır**, portu açmaz ya da yayınlamaz. Ama ad verilmiş portlar (`http`) Service ve probe'larda adıyla kullanılabilir.

### command ve args

Docker kursundaki ENTRYPOINT ve CMD'nin karşılıkları şaşırtıcı bir isimlendirmeyle:

| Kubernetes | Docker | |
|---|---|---|
| `command` | `ENTRYPOINT` | Verilirse imajın ENTRYPOINT'ini **ve** CMD'sini geçersiz kılar |
| `args` | `CMD` | Verilirse sadece CMD'yi geçersiz kılar |

```bash
kubectl run args-deneme --image=busybox:1.36 --restart=Never --command -- sh -c 'echo "command ile: $0 $@"' a b
sleep 3; kubectl logs args-deneme; kubectl delete pod args-deneme
```

## Yaşam döngüsü

### Pod fazları

```bash
kubectl get pod web -o jsonpath='{.status.phase}{"\n"}'
```

| Faz | Anlamı |
|---|---|
| `Pending` | Kabul edildi ama konteynerler henüz çalışmıyor: zamanlanmayı bekliyor ya da imaj çekiliyor |
| `Running` | Node'a bağlandı, en az bir konteyner çalışıyor (ya da başlıyor/yeniden başlıyor) |
| `Succeeded` | Bütün konteynerler başarıyla (0) bitti ve yeniden başlatılmayacak |
| `Failed` | Bütün konteynerler bitti, en az biri hatayla |
| `Unknown` | Node ile iletişim kurulamıyor |

Faz kaba bir özettir. Asıl bilgi her konteynerin **durumunda** (state) ve `kubectl get pods` çıktısının `STATUS` sütununda.

### Konteyner durumları ve sık görülen STATUS değerleri

Arızalı Pod'lar üretelim:

```bash
kubectl run imaj-yok --image=nginx:boyle-bir-surum-yok
kubectl run cokuyor --image=busybox:1.36 -- sh -c 'echo "başladım, şimdi çöküyorum"; exit 1'
cat > oom.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: oom
spec:
  containers:
    - name: ac
      image: busybox:1.36
      command: ["sh", "-c", "x=a; while true; do x=$x$x; done"]
      resources:
        limits:
          memory: 32Mi
EOF
kubectl apply -f oom.yaml
kubectl run tamam --image=busybox:1.36 --restart=Never -- sh -c 'echo iş bitti'
sleep 40
kubectl get pods
```

| STATUS | Anlamı | İlk bakılacak |
|---|---|---|
| `ContainerCreating` | İmaj çekiliyor ya da volume bağlanıyor | Uzun sürüyorsa `describe` → Events |
| `ErrImagePull` / `ImagePullBackOff` | İmaj çekilemedi: yanlış ad/etiket, özel registry için kimlik yok, Docker Hub hız sınırı | `describe pod` → Events'teki hata mesajı |
| `CrashLoopBackOff` | Konteyner başlıyor ve çöküyor, kubelet her seferinde daha uzun bekleyerek yeniden deniyor | `logs --previous`, `describe` → Last State, Exit Code |
| `OOMKilled` | Bellek sınırı aşıldı (Docker kursundaki 137) | `describe` → Last State: OOMKilled, `resources.limits.memory` |
| `Error` | Konteyner sıfır olmayan kodla çıktı (`restartPolicy: Never` ise) | `logs` |
| `Completed` | Konteyner 0 ile bitti | |
| `CreateContainerConfigError` | Bağlanan ConfigMap/Secret ya da bir anahtar yok | `describe` → Events |
| `Pending` (uzun süre) | Zamanlanamıyor: kaynak yetersiz, kısıt uyuşmuyor, PVC bağlanamıyor | `describe` → Events: `FailedScheduling` |

```bash
kubectl describe pod imaj-yok | grep -A6 Events
kubectl describe pod cokuyor | grep -E -A5 'Last State|Restart Count'
kubectl logs cokuyor --previous
kubectl describe pod oom | grep -E -A4 'Last State'
kubectl get pod tamam -o jsonpath='{.status.containerStatuses[0].state}{"\n"}'
```

**CrashLoopBackOff bir hata değil, bir bekleme durumudur**: kubelet çöken konteyneri 10 sn, 20 sn, 40 sn... en fazla 5 dakika bekleyerek yeniden başlatır (sonsuz çöküş döngüsünün sistemi yormaması için, Docker'daki gibi). Gerçek sebep her zaman konteynerin **kendi** çıkışındadır: `logs --previous` ve `Last State` içindeki çıkış kodu.

```bash
kubectl delete pod imaj-yok cokuyor oom tamam
```

### restartPolicy

Pod düzeyinde, bütün konteynerler için:

| Değer | Davranış | Kim kullanır |
|---|---|---|
| `Always` (varsayılan) | Konteyner nasıl biterse bitsin yeniden başlat | Deployment, StatefulSet, DaemonSet (zorunlu) |
| `OnFailure` | Sadece hatayla biterse | Job |
| `Never` | Hiç yeniden başlatma | Job, tek seferlik Pod'lar |

Önemli: Yeniden başlatma **aynı Pod içinde, aynı node'da** yapılır (`RESTARTS` sayacı artar). Pod'u başka bir node'a taşımak ya da silinen Pod'un yerine yenisini koymak kubelet'in değil, Deployment gibi denetleyicilerin işidir.

## Init konteynerleri

Uygulama konteynerlerinden **önce**, sırayla ve her biri **başarıyla bitene kadar** çalışan konteynerler. Kullanım alanları: bir bağımlılığın hazır olmasını beklemek, veritabanı şemasını hazırlamak, bir ayar dosyası üretmek, volume izinlerini düzeltmek.

```bash
cat > init.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: uygulama
spec:
  initContainers:
    - name: db-bekle
      image: busybox:1.36
      command: ["sh", "-c", "until nslookup veritabani.default.svc.cluster.local; do echo 'veritabanı bekleniyor'; sleep 3; done"]
    - name: ayar-uret
      image: busybox:1.36
      command: ["sh", "-c", "echo \"uretildi: $(date)\" > /ayar/uygulama.conf"]
      volumeMounts: [{ name: ayar, mountPath: /ayar }]
  containers:
    - name: uygulama
      image: busybox:1.36
      command: ["sh", "-c", "cat /ayar/uygulama.conf; sleep 3600"]
      volumeMounts: [{ name: ayar, mountPath: /ayar }]
  volumes:
    - name: ayar
      emptyDir: {}
EOF
kubectl apply -f init.yaml
sleep 10; kubectl get pod uygulama
kubectl logs uygulama -c db-bekle --tail=2
```

`STATUS` sütununda `Init:0/2`: ilk init konteyneri `veritabani` adlı Service'i bekliyor (henüz yok). Service'i oluşturalım (Service dersinde ayrıntılı göreceğiz):

```bash
kubectl create service clusterip veritabani --tcp=5432:5432
sleep 10; kubectl get pod uygulama
kubectl logs uygulama -c uygulama
```

İlk init bitti, ikincisi ayar dosyasını üretti, sonra uygulama başladı ve dosyayı okudu.

> Init konteynerinde "bağımlılığı bekle" kalıbı yaygındır, ama tek başına yeterli değildir: Bağımlılık daha sonra da gidebilir. Uygulama bağlantı hatalarında yeniden denemeyi her durumda bilmelidir (Docker kursundaki `depends_on` dersi).

## Sidecar konteynerleri

Uzun süre normal bir ikinci konteyner olarak tanımlanan sidecar'ların iki sorunu vardı: Ana uygulamadan önce başlayacakları garanti değildi (log ajanı ilk logları kaçırabilir) ve bir Job'da ana konteyner bitince sidecar çalışmaya devam ettiği için Job hiç tamamlanmıyordu.

Kubernetes 1.29'dan beri varsayılan olarak açık olan (1.33'te kararlı) **yerel sidecar** desteği bunu çözer: `initContainers` altında, `restartPolicy: Always` ile tanımlanan bir konteyner:

- Ana konteynerlerden **önce başlar** ve init aşamasının bitmesini beklemez (sürekli çalışır).
- Pod'un ömrü boyunca çalışır, çökerse yeniden başlatılır.
- Ana konteynerler bitince (Job) **otomatik olarak durdurulur** ve kapanışta ana konteynerlerden **sonra** durdurulur.

```bash
cat > sidecar.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: log-ornek
spec:
  restartPolicy: Never
  initContainers:
    - name: log-gonderici
      image: busybox:1.36
      restartPolicy: Always
      command: ["sh", "-c", "touch /log/app.log; tail -F /log/app.log | sed 's/^/[gönderildi] /'"]
      volumeMounts: [{ name: log, mountPath: /log }]
  containers:
    - name: is
      image: busybox:1.36
      command: ["sh", "-c", "for i in 1 2 3 4 5; do echo \"kayıt $i\" >> /log/app.log; sleep 2; done"]
      volumeMounts: [{ name: log, mountPath: /log }]
  volumes:
    - name: log
      emptyDir: {}
EOF
kubectl apply -f sidecar.yaml
sleep 20
kubectl get pod log-ornek
kubectl logs log-ornek -c log-gonderici
```

Ana konteyner (`is`) 10 saniyede bitti, Pod `Completed` oldu: sidecar onun ardından durduruldu. Eski yöntemle tanımlansaydı Pod `NotReady` olarak sonsuza kadar çalışmaya devam ederdi.

## Kapanış: SIGTERM, preStop ve grace period

Bir Pod silindiğinde (deploy sırasında, ölçek küçültmede, node boşaltılırken):

```text
1. Pod "Terminating" olarak işaretlenir. Aynı anda:
   a. EndpointSlice denetleyicisi Pod'u Service uç noktalarından çıkarır (yeni trafik gelmesin)
   b. kubelet kapanışı başlatır
2. Varsa preStop kancası (hook) çalışır
3. Konteynerin ana sürecine SIGTERM gönderilir
4. terminationGracePeriodSeconds (varsayılan 30 sn) dolana kadar beklenir (preStop süresi dahil)
5. Hâlâ çalışıyorsa SIGKILL
```

Docker kursundaki `stop` mantığının aynısı, bir ince farkla: 1a ve 1b **aynı anda** başlar. Uç noktalardan çıkarma bütün node'lardaki kube-proxy'lere ve Ingress denetleyicilerine yayılana kadar birkaç yüz milisaniye-birkaç saniye geçebilir. Bu sırada uygulama SIGTERM'i alıp hemen kapanırsa, hâlâ ona gönderilen istekler **hata alır**. Rolling update'lerde görülen rastgele 502'lerin klasik sebebidir.

Yaygın çözüm, SIGTERM'den önce kısa bir bekleme:

```yaml
spec:
  terminationGracePeriodSeconds: 45
  containers:
    - name: api
      lifecycle:
        preStop:
          sleep:
            seconds: 10        # Kubernetes 1.30+; eski sürümlerde: exec: {command: ["sleep", "10"]}
```

Görelim:

```bash
cat > kapanis.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: kapanis
spec:
  terminationGracePeriodSeconds: 20
  containers:
    - name: uygulama
      image: busybox:1.36
      command: ["sh", "-c", "trap 'echo \"$(date +%T) SIGTERM aldım, temizlik\"; sleep 2; echo \"$(date +%T) çıkıyorum\"; exit 0' TERM; echo \"$(date +%T) başladım\"; while true; do sleep 1; done"]
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "echo \"$(date +%T) preStop başladı\" > /proc/1/fd/1; sleep 5"]
EOF
kubectl apply -f kapanis.yaml
sleep 5
kubectl logs -f kapanis &
sleep 1
kubectl delete pod kapanis
wait
```

Log akışında sırayı göreceksin: `preStop başladı`, 5 sn sonra `SIGTERM aldım`, 2 sn sonra `çıkıyorum`. Uygulamanın SIGTERM işleyicisi yoksa (Docker kursundaki PID 1 sorunu) 20 saniye dolunca SIGKILL gelir.

## Pod'un kimliği

```bash
kubectl get pod web -o jsonpath='IP: {.status.podIP}  node: {.spec.nodeName}  QoS: {.status.qosClass}{"\n"}'
kubectl exec web -c nginx -- cat /etc/resolv.conf
kubectl exec web -c nginx -- env | grep -i kubernetes | head -3
```

- Her Pod kendi **IP**'sini alır (CNI eklentisi). Kümedeki bütün Pod'lar NAT olmadan birbirine bu IP'lerle ulaşabilir: Kubernetes ağ modelinin temel kuralı.
- Pod IP'leri **geçicidir**: Pod yeniden oluşturulunca değişir. Pod'lara IP ile değil, **Service** adıyla ulaşılır (bir sonraki bölüm).
- `/etc/resolv.conf` küme DNS'ini (CoreDNS) gösterir. `search` satırı sayesinde aynı namespace'teki Service'lere kısa adla (`veritabani`) ulaşılır.

## Temizlik

```bash
kubectl delete pod web demo uygulama log-ornek --ignore-not-found
kubectl delete service veritabani
```

## Alıştırma (lab'da)

1. İki konteynerli bir Pod yaz: `redis:7-alpine` ve her 3 saniyede bir `redis-cli -h localhost INCR sayac` çalıştıran bir `redis:7-alpine` konteyneri. 20 saniye sonra sayacın değerini oku.
2. `command` ile `exit 2` yapan bir Pod oluştur ve `CrashLoopBackOff`'a girdiğini, yeniden başlatmalar arasındaki sürenin arttığını `kubectl get pod -w` ile gözlemle. Çıkış kodunu `jsonpath` ile oku.
3. `restartPolicy: Never` ile aynı Pod'u oluşturursan STATUS ne olur?

<details><summary>Çözüm</summary>

```bash
cat > sayac.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: sayac
spec:
  containers:
    - name: redis
      image: redis:7-alpine
    - name: artirici
      image: redis:7-alpine
      command: ["sh", "-c", "while true; do redis-cli -h localhost INCR sayac; sleep 3; done"]
EOF
kubectl apply -f sayac.yaml; sleep 25
kubectl exec sayac -c redis -- redis-cli GET sayac
kubectl delete pod sayac

kubectl run hata2 --image=busybox:1.36 -- sh -c 'exit 2'
timeout 90 kubectl get pod hata2 -w
kubectl get pod hata2 -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}'
kubectl delete pod hata2

kubectl run hata3 --image=busybox:1.36 --restart=Never -- sh -c 'exit 2'
sleep 10; kubectl get pod hata3; kubectl delete pod hata3
```

2: `RESTARTS` artar, `STATUS` `Error` ile `CrashLoopBackOff` arasında değişir ve aralıklar uzar. Çıkış kodu 2.

3: STATUS `Error`, yeniden başlatma yok.

</details>

```quiz
Bir Pod'daki iki konteyner birbirine nasıl ulaşır?
- Pod IP'si ve farklı Service'ler üzerinden
- [x] `localhost` üzerinden: aynı ağ namespace'ini paylaşırlar
- Ulaşamazlar
? Pod'daki konteynerler tek IP ve port alanını paylaşır.
```

```quiz
Pod `CrashLoopBackOff` durumunda. Sebebi bulmak için ilk ne yaparsın?
- Pod'u silip yeniden oluştururum
- [x] `kubectl logs --previous` ve `kubectl describe pod` (Last State, Exit Code)
- Node'u yeniden başlatırım
? CrashLoopBackOff kubelet'in bekleme durumudur. Asıl sebep konteynerin önceki çıkışındadır.
```

```quiz
Pod manifest'inde `command` verildi ama `args` verilmedi. İmajın CMD'sine ne olur?
- Korunur ve command'a eklenir
- [x] Yok sayılır: `command` hem ENTRYPOINT'i hem CMD'yi geçersiz kılar
- Hata verir
? Sadece CMD'yi değiştirmek için `args` kullanılır.
```

```quiz
Rolling update sırasında kapanan Pod'lara giden istekler rastgele hata alıyor. En yaygın çözüm?
- terminationGracePeriodSeconds'ı 0 yapmak
- [x] Kısa bir `preStop` bekleme ekleyerek, Pod uç noktalardan çıkarılana kadar SIGTERM'i geciktirmek
- restartPolicy: Never
? Uç noktalardan çıkarma ile SIGTERM aynı anda başlar. preStop bu yarış koşulunu kapatır.
```

## Özet

- Pod = ortak ağ namespace'i (tek IP, localhost) + paylaşılan volume'ler. Bir Pod, bir uygulama örneği. Ek konteynerler yardımcı roller için.
- `command` = ENTRYPOINT, `args` = CMD. `containerPort` bilgi amaçlı.
- Fazlar: Pending, Running, Succeeded, Failed. STATUS: ImagePullBackOff, CrashLoopBackOff, OOMKilled, CreateContainerConfigError.
- `restartPolicy` aynı Pod içinde yeniden başlatır. Pod'u yeniden oluşturmak denetleyicilerin işi.
- Init konteynerleri sırayla ve başarıyla biter. Yerel sidecar: `initContainers` + `restartPolicy: Always`.
- Kapanış: uç noktadan çıkarma ve SIGTERM aynı anda. `preStop` + yeterli `terminationGracePeriodSeconds`.
