# Sorun giderme: events, describe, kubectl debug

Linux kursundaki teşhis akışı ve Docker kursundaki konteyner teşhisi burada da geçerli, ama Kubernetes iki katman ekler: Sorun, **denetleyicilerin** (scheduler, Deployment, kubelet) bir şeyi yapamamasından da kaynaklanabilir, ve hepsinin izi **olaylarda** (events) ve nesnelerin **status** alanlarındadır. Bu derste katman katman bir teşhis yöntemi ve en sık arızaları bilerek üretip çözeceğiz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Yöntem: yukarıdan aşağıya

```text
Kullanıcı "çalışmıyor" diyor
  │
  ├─ 1. Giriş: Ingress/Gateway → doğru Service'e mi gidiyor?     kubectl get ingress,httproute; describe
  ├─ 2. Service: uç noktası var mı?                              kubectl get endpointslices -l kubernetes.io/service-name=X
  ├─ 3. Deployment/ReplicaSet: istenen sayıda hazır Pod var mı?  kubectl get deploy,rs; rollout status; describe rs
  ├─ 4. Pod: durumu ne? neden?                                   kubectl get pod; describe pod (Events, Last State)
  ├─ 5. Konteyner: ne diyor?                                     kubectl logs [--previous]; kubectl debug
  └─ 6. Node / küme: node hazır mı? kaynak var mı? DNS çalışıyor mu?  kubectl get nodes; describe node; kube-system Pod'ları
```

Bir **yanıt kodu** ipucu verir: Ingress denetleyicisinden gelen `404` genelde rota yok, `503` hiç hazır uç nokta yok, `502` uç nokta var ama bağlantı reddediliyor demektir (Linux kursundaki nginx hata kodları).

## Araçlar

```bash
kubectl get events -A --sort-by=.lastTimestamp | tail -20
kubectl get events -n default --field-selector type=Warning
kubectl events --for pod/<ad> 2>/dev/null || true
```

Olaylar yaklaşık bir saat tutulur ve sadece `Warning`'ler bile çoğu sorunun yerini gösterir. Kalıcı olarak saklamak için (olay incelemesi için) bir olay toplayıcı (kubernetes-event-exporter) ya da gözlem yığınına aktarma gerekir.

```bash
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
kubectl get pods -A -o wide | awk '$5 > 3'        # 3'ten fazla yeniden başlayanlar (RESTARTS sütunu)
kubectl get deploy -A | awk 'NR==1 || $3 != $4'    # hazır != istenen
```

## Arızaları üretip teşhis edelim

Bilerek bozulmuş bir uygulama seti kuralım. Hangi parçanın neden bozuk olduğu söylenmeyecek, yukarıdaki yöntemle bulacaksın:

```bash
kubectl create namespace ariza
cat > ariza.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ariza }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports: [{ containerPort: 80 }]
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: ariza }
spec:
  selector: { app: wep }
  ports: [{ port: 80, targetPort: 80 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: ariza }
spec:
  replicas: 1
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.10
          envFrom:
            - configMapRef: { name: api-ayar }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: worker, namespace: ariza }
spec:
  replicas: 1
  selector: { matchLabels: { app: worker } }
  template:
    metadata: { labels: { app: worker } }
    spec:
      containers:
        - name: worker
          image: busybox:1.36
          command: ["sh", "-c", "echo 'DATABASE_URL tanımlı değil' >&2; exit 1"]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: rapor, namespace: ariza }
spec:
  replicas: 1
  selector: { matchLabels: { app: rapor } }
  template:
    metadata: { labels: { app: rapor } }
    spec:
      containers:
        - name: rapor
          image: busybox:1.36
          command: ["sleep", "3600"]
          resources:
            requests: { memory: 500Gi }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: cache, namespace: ariza }
spec:
  replicas: 1
  selector: { matchLabels: { app: cache } }
  template:
    metadata: { labels: { app: cache } }
    spec:
      containers:
        - name: cache
          image: redis:7.9-alpine-yok
EOF
kubectl apply -f ariza.yaml
sleep 45
kubectl -n ariza get deploy,pods
```

Şimdi teşhis et. Kullanabileceğin komutlar:

```bash
kubectl -n ariza get pods
kubectl -n ariza describe pod <ad> | tail -20
kubectl -n ariza logs <ad> --previous
kubectl -n ariza get endpointslices
kubectl -n ariza get events --field-selector type=Warning --sort-by=.lastTimestamp
```

<details><summary>Arızalar ve çözümleri (önce kendin dene)</summary>

**1. `web` Service'inin uç noktası yok.** Pod'lar `Running` ve `Ready`, ama `kubectl -n ariza get endpointslices` boş. Service'in seçicisi `app: wep` (yazım hatası). Service dersindeki ilk kontrol.

```bash
kubectl -n ariza patch svc web -p '{"spec":{"selector":{"app":"web"}}}'
kubectl -n ariza get endpointslices -l kubernetes.io/service-name=web
```

**2. `api` `CreateContainerConfigError`.** `describe` olaylarında `configmap "api-ayar" not found`. Bağlanan ConfigMap yok (ConfigMap dersi).

```bash
kubectl -n ariza create configmap api-ayar --from-literal=LOG_LEVEL=info
sleep 10; kubectl -n ariza get pods -l app=api
```

**3. `worker` `CrashLoopBackOff`.** `kubectl logs --previous` "DATABASE_URL tanımlı değil" diyor, `describe` → `Last State: Terminated, Exit Code: 1`. Uygulama eksik yapılandırmayla açılışta bilerek çıkıyor (Docker kursundaki "zorunlu ayar eksikse açılışta dur" ilkesi). Çözüm: eksik ortam değişkenini vermek.

**4. `rapor` `Pending`.** `describe` → `FailedScheduling ... Insufficient memory`. 500Gi bellek isteği hiçbir node'a sığmıyor (kaynak dersi). Çözüm: gerçekçi requests.

**5. `cache` `ImagePullBackOff`.** `describe` → `Failed to pull image ... not found`. Var olmayan imaj etiketi. Çözüm: doğru etiket (`redis:7-alpine`).

```bash
kubectl -n ariza set image deploy/cache cache=redis:7-alpine
kubectl -n ariza patch deploy rapor --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/resources/requests/memory","value":"16Mi"}]'
kubectl -n ariza set env deploy/worker DATABASE_URL=postgres://db/x --containers=worker
kubectl -n ariza patch deploy worker --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["sh","-c","echo calisiyorum; sleep 3600"]}]'
sleep 30; kubectl -n ariza get pods
```

</details>

## kubectl debug

Docker kursunda distroless konteynerleri incelemek için namespace paylaşan bir hata ayıklama konteyneri kullanmıştık. Kubernetes bunun yerleşik hâlini sunar: **geçici konteyner** (ephemeral container).

### Çalışan bir Pod'a araç eklemek

```bash
kubectl -n ariza get pod -l app=api -o name
P=$(kubectl -n ariza get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
kubectl -n ariza exec $P -- sh 2>&1 | head -1
kubectl -n ariza debug -it $P --image=nicolaka/netshoot --target=api -- sh -c 'ps aux; ss -tlnp; curl -s localhost | head -3'
```

`whoami` imajında kabuk yok, `exec` başarısız. `kubectl debug` aynı Pod'a, aynı ağ namespace'inde ve `--target` ile hedef konteynerin **süreç namespace'inde** geçici bir konteyner ekledi: `ps` hedefin süreçlerini, `ss` portlarını gösterdi. Hedefin dosya sistemine `/proc/<pid>/root` üzerinden ulaşılabilir. Geçici konteyner Pod'un tanımına eklenir ve Pod silinene kadar kalır (durduktan sonra yeniden başlatılmaz).

### Çöken bir Pod'un kopyasını incelemek

CrashLoopBackOff'taki bir konteynere `exec` yapılamaz, çünkü sürekli ölüyor. Pod'un **kopyasını**, komutunu değiştirerek oluştur:

```bash
kubectl -n ariza run kirik --image=busybox:1.36 -- sh -c 'exit 3'
sleep 10
kubectl -n ariza debug kirik -it --copy-to=kirik-inceleme --container=kirik -- sh -c 'echo "kopya içindeyim"; env | head -5; ls /'
kubectl -n ariza delete pod kirik kirik-inceleme
```

`--copy-to` Pod'un birebir kopyasını (aynı volume'ler, ortam, ServiceAccount) oluşturur ve komutu senin verdiğinle değiştirir: Docker kursundaki `docker run --entrypoint sh` yöntemi.

### Node'da hata ayıklama

```bash
kubectl debug node/node01 -it --image=busybox:1.36 -- sh -c 'chroot /host sh -c "hostname; df -h / | tail -1; crictl ps 2>/dev/null | head -5"'
```

Node'un kök dosya sistemi `/host` altına bağlanmış, node'un ağı ve süreç namespace'inde çalışan bir Pod. SSH erişimin olmayan node'larda (yönetilen kümeler) kubelet loglarına, disklere ve konteyner çalışma zamanına ulaşmanın yolu. Çok güçlü bir yetkidir, RBAC ile sınırlanmalıdır.

## Sık görülen diğer durumlar

### Node NotReady

```bash
kubectl get nodes
kubectl describe node node01 | grep -A10 Conditions
```

`Conditions` bölümünde `MemoryPressure`, `DiskPressure`, `PIDPressure` ya da `Ready: False` ve sebebi. Node tarafında: `systemctl status kubelet`, `journalctl -u kubelet` (Linux kursu), konteyner çalışma zamanı (`systemctl status containerd`), disk doluluğu. `DiskPressure`'da kubelet önce kullanılmayan imajları siler, sonra Pod'ları tahliye eder: `kubectl get pods -A | grep Evicted`.

### DNS

```bash
kubectl run dnstest --image=busybox:1.36 --restart=Never --rm -it -- nslookup kubernetes.default
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=20
```

Service adı çözülmüyor ama IP'ye erişilebiliyorsa: CoreDNS Pod'ları çalışıyor mu, NetworkPolicy DNS egress'ini engelliyor mu (NetworkPolicy dersi), Pod'un `dnsPolicy` ayarı.

### Terminating'de takılan nesneler

```bash
kubectl get ns ariza -o jsonpath='{.spec.finalizers}{.status.conditions}{"\n"}'
```

Namespace ya da bir nesne silinmiyorsa bir **finalizer** onu tutuyordur: genelde artık çalışmayan bir denetleyicinin (silinmiş bir operatör, CRD'si kaldırılmış bir kaynak) temizlik yapması bekleniyordur. Önce o denetleyiciyi düzelt. Finalizer'ı elle silmek (`kubectl patch ... -p '{"metadata":{"finalizers":null}}'`) son çaredir: dış kaynaklar (bulut yük dengeleyicisi, disk) yetim kalabilir.

### "Rollout bitmiyor"

```bash
kubectl rollout status deploy/X --timeout=60s
kubectl describe deploy X | grep -A5 Conditions
kubectl get rs -l app=X
kubectl describe rs <yeni-rs> | tail -10
```

Yeni ReplicaSet'in Pod'ları hazır olmuyorsa sebep Pod'larda (imaj, probe, config). Yeni ReplicaSet hiç Pod oluşturamıyorsa sebep ReplicaSet olaylarında: ResourceQuota aşıldı ya da Pod Security reddetti (güvenlik dersi).

## Temizlik

```bash
kubectl delete namespace ariza
```

## Alıştırma (lab'da)

Aşağıdaki manifest uygulandığında `curl` başarısız oluyor. Hata nerede? (İpucu: birden fazla.)

```bash
kubectl create namespace gizem
cat > gizem.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: site, namespace: gizem }
spec:
  replicas: 2
  selector: { matchLabels: { app: site } }
  template:
    metadata: { labels: { app: site } }
    spec:
      containers:
        - name: site
          image: nginx:1.27-alpine
          readinessProbe:
            httpGet: { path: /hazir, port: 80 }
            periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata: { name: site, namespace: gizem }
spec:
  selector: { app: site }
  ports: [{ port: 80, targetPort: 8080 }]
EOF
kubectl apply -f gizem.yaml; sleep 20
kubectl -n gizem run t --image=curlimages/curl:8.10.1 --restart=Never --rm -it -- curl -s -m 3 http://site/ || echo "başarısız"
```

<details><summary>Çözüm</summary>

```bash
kubectl -n gizem get pods
kubectl -n gizem describe pod -l app=site | grep -i 'readiness probe failed' | head -1
kubectl -n gizem get endpointslices -o yaml | grep -E 'ready|port:'
```

1. readinessProbe `/hazir` yoluna bakıyor ama nginx'te böyle bir sayfa yok (404): Pod'lar hiç `Ready` olmuyor, uç noktalar `ready=false`, Service trafik gönderecek Pod bulamıyor.
2. Service'in `targetPort`'u `8080`, nginx `80` dinliyor: Probe düzeltilse bile bağlantı reddedilir.

```bash
kubectl -n gizem patch deploy site --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/"}]'
kubectl -n gizem patch svc site -p '{"spec":{"ports":[{"port":80,"targetPort":80}]}}'
kubectl -n gizem rollout status deploy/site
kubectl -n gizem run t --image=curlimages/curl:8.10.1 --restart=Never --rm -it -- curl -s -o /dev/null -w '%{http_code}\n' http://site/
kubectl delete namespace gizem
```

</details>

```quiz
Pod `CreateContainerConfigError` durumunda. İlk nereye bakarsın?
- `kubectl logs`
- [x] `kubectl describe pod` olaylarına: genelde eksik bir ConfigMap, Secret ya da anahtar
- Node'un diskine
? Konteyner hiç başlamadığı için log yoktur. Sebep, yapılandırmanın hazırlanmasında.
```

```quiz
Kabuksuz (distroless) bir konteynerin hangi portları dinlediğini görmek için Kubernetes'te en pratik yol?
- İmajı yeniden build etmek
- [x] `kubectl debug -it <pod> --image=nicolaka/netshoot --target=<konteyner>` ile geçici konteyner
- `kubectl exec -- ss`
? Geçici konteyner aynı ağ ve (target ile) süreç namespace'ine katılır.
```

```quiz
Bir namespace dakikalardır `Terminating` durumunda. En olası sebep?
- etcd dolu
- [x] Bir finalizer, artık çalışmayan bir denetleyicinin temizliğini bekliyor
- Namespace'te çok Pod var
? Önce finalizer'ın sahibi olan denetleyiciyi düzelt. Elle kaldırmak dış kaynakları yetim bırakabilir.
```

## Özet

- Yukarıdan aşağıya: giriş → Service uç noktaları → Deployment/ReplicaSet → Pod → konteyner → node.
- Olaylar (`get events --field-selector type=Warning`) ve `describe` (Events, Conditions, Last State) her katmanda ilk durak.
- STATUS'a göre: CreateContainerConfigError (config), ImagePullBackOff (imaj), CrashLoopBackOff (`logs --previous`), Pending (FailedScheduling).
- `kubectl debug`: geçici konteyner (`--target`), Pod kopyası (`--copy-to`), node (`node/<ad>`, `/host`).
- Node koşulları, DNS (CoreDNS, NetworkPolicy), finalizer'lar, takılan rollout'lar.
