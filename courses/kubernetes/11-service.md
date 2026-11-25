# Service, DNS, kube-proxy ve EndpointSlice

Pod IP'leri geçicidir: Pod yeniden oluşturulunca değişir, rollout sırasında Pod'lar sürekli gelip gider. **Service**, bir grup Pod'a (etiket seçicisiyle) sabit bir ad ve sanal IP verir, gelen bağlantıları **hazır** Pod'lara dağıtır. Swarm'daki VIP'in karşılığı, ama ayrı bir nesne. Bu derste Service türlerini, bir isteğin Service IP'sinden Pod'a nasıl ulaştığını ve en sık yapılan Service hatalarını göreceğiz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Hazırlık

```bash
kubectl create deployment api --image=traefik/whoami:v1.10 --replicas=3
kubectl rollout status deploy/api
kubectl get pods -l app=api -o wide
```

## ClusterIP

```bash
cat > svc.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: ClusterIP          # varsayılan
  selector:
    app: api               # bu etiketli HAZIR Pod'lar
  ports:
    - name: http
      port: 80             # Service'in portu
      targetPort: 80       # Pod'daki port (sayı ya da containerPort adı)
EOF
kubectl apply -f svc.yaml
kubectl get svc api
kubectl describe svc api | grep -E 'IP:|Port|Endpoints'
```

`CLUSTER-IP` sütununda sanal bir IP: Hiçbir arabirime atanmış değildir, sadece kube-proxy'nin kurallarında vardır. Sadece **küme içinden** erişilebilir.

Bir istemci Pod'dan deneyelim:

```bash
kubectl run istemci --image=curlimages/curl:8.10.1 --restart=Never -- sleep 3600
kubectl wait --for=condition=Ready pod/istemci
for i in 1 2 3 4 5 6; do kubectl exec istemci -- curl -s http://api/ | grep Hostname; done
```

İstekler üç Pod'a dağıldı. `port` ile `targetPort` farklı olabilir: Service 80'den dinleyip Pod'un 8080'ine iletebilir. `targetPort`'a containerPort'un **adını** yazmak (`targetPort: http`) Pod'lardaki port numarası değişse bile Service'i değiştirmemeyi sağlar.

## DNS

CoreDNS her Service için bir DNS kaydı oluşturur:

```text
<servis>.<namespace>.svc.cluster.local
api.default.svc.cluster.local
```

```bash
kubectl exec istemci -- nslookup api
kubectl exec istemci -- cat /etc/resolv.conf
kubectl exec istemci -- curl -s -o /dev/null -w '%{http_code}\n' http://api.default.svc.cluster.local/
kubectl exec istemci -- curl -s -o /dev/null -w '%{http_code}\n' http://api.default/
```

`/etc/resolv.conf`'taki `search` satırı sayesinde:

- Aynı namespace'ten: `api`
- Başka namespace'ten: `api.siparis` (ya da tam adıyla `api.siparis.svc.cluster.local`)

> `resolv.conf`'taki `ndots:5` ayarı yüzünden, içinde 5'ten az nokta olan her ad (örneğin `api.github.com`) önce bütün `search` uzantılarıyla denenir: `api.github.com.default.svc.cluster.local`, `...svc.cluster.local`, `...cluster.local`, sonra kendisi. Dış adlara çok istek atan uygulamalarda bu, DNS trafiğini birkaç kat artırır. Çözüm: dış adları sonuna nokta koyarak tam ad yazmak (`api.github.com.`) ya da Pod'un `dnsConfig`'inde `ndots`'u düşürmek.

## İstek Pod'a nasıl ulaşıyor?

```text
istemci Pod ── 10.96.45.12:80 ──▶ (node'daki kube-proxy kuralları: DNAT)
                                     ├─▶ 192.168.1.14:80  (api Pod 1)
                                     ├─▶ 192.168.1.15:80  (api Pod 2)
                                     └─▶ 192.168.2.8:80   (api Pod 3, başka node'da, CNI üzerinden)
```

1. **EndpointSlice denetleyicisi**, Service'in seçicisine uyan ve **hazır (Ready)** olan Pod'ların IP'lerini EndpointSlice nesnelerine yazar.
2. Her node'daki **kube-proxy** bu listeyi izler ve Service IP'sine gelen bağlantıları rastgele bir Pod IP'sine çeviren kuralları yazar (iptables, IPVS ya da nftables modu).
3. Paket Pod IP'sine gider. Pod başka bir node'daysa CNI eklentisi taşır.

```bash
kubectl get endpointslices -l kubernetes.io/service-name=api
kubectl get endpointslices -l kubernetes.io/service-name=api -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]} ready={.conditions.ready}{"\n"}{end}'
```

Kuralların kendisi (iptables modunda):

```bash
CIP=$(kubectl get svc api -o jsonpath='{.spec.clusterIP}')
iptables -t nat -S KUBE-SERVICES 2>/dev/null | grep "$CIP" | head -2
iptables -t nat -S 2>/dev/null | grep -A0 "KUBE-SVC" | grep api | head -5
```

Her Pod için bir `KUBE-SEP-...` zinciri ve `--probability` değerleriyle rastgele seçim. Linux kursundaki NAT bilgisi aynen geçerli. (kube-proxy IPVS ya da nftables modundaysa ya da Cilium gibi eBPF tabanlı bir CNI kube-proxy'nin yerini aldıysa kurallar farklı yerde olur.)

### Hazır olmayan Pod trafik almaz

```bash
P=$(kubectl get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
kubectl label pod $P app=bakim --overwrite
kubectl get endpointslices -l kubernetes.io/service-name=api -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"\n"}{end}'
kubectl delete pod $P
```

Etiketi değişen Pod uç noktalardan anında çıktı. Aynı şey readinessProbe başarısız olduğunda da olur: Pod çalışır ama trafik almaz (probe dersi).

## Service türleri

| Tür | Kimden erişilir | Nasıl |
|---|---|---|
| `ClusterIP` | Sadece küme içi | Sanal IP + DNS |
| `NodePort` | Her node'un IP'si + 30000-32767 aralığında bir port | ClusterIP + her node'da bir port |
| `LoadBalancer` | Dış dünya | NodePort + bulut sağlayıcısının (ya da MetalLB'nin) açtığı dış yük dengeleyici |
| `ExternalName` | Küme içi | Sadece DNS CNAME: `db` → `prod-db.abc.rds.amazonaws.com` |
| Headless (`clusterIP: None`) | Küme içi | Sanal IP yok, DNS doğrudan Pod IP'lerini döner |

### NodePort

```bash
kubectl expose deployment api --name=api-np --type=NodePort --port=80
kubectl get svc api-np
NP=$(kubectl get svc api-np -o jsonpath='{.spec.ports[0].nodePort}')
curl -s http://localhost:$NP/ | grep Hostname
curl -s http://$(kubectl get node node01 -o jsonpath='{.status.addresses[0].address}'):$NP/ | grep Hostname
```

Port, Pod'un olmadığı node'larda da açıktır (Swarm'daki routing mesh gibi): trafik doğru node'a yönlendirilir. Bedeli aynı: ek bir atlama ve istemci IP'sinin kaybolması. `externalTrafficPolicy: Local` ile sadece o node'daki Pod'lara gönderilir ve istemci IP'si korunur, ama Pod'u olmayan node'lar trafiği reddeder.

NodePort doğrudan internete açmak için pek kullanılmaz: garip port aralığı, node IP'lerinin değişmesi. Asıl kullanımı, bir dış yük dengeleyicinin ya da Ingress denetleyicisinin arka ucu olmaktır.

### LoadBalancer

Bulutta (EKS, GKE, AKS) `type: LoadBalancer` bir Service oluşturmak, sağlayıcının yük dengeleyicisini otomatik açar ve `EXTERNAL-IP` sütununa adresini yazar (cloud-controller-manager, mimari dersi). Lab'da ya da kendi sunucularında bir bulut yoksa `EXTERNAL-IP` `<pending>` kalır. Fiziksel sunucularda bu görevi **MetalLB** ya da **kube-vip** üstlenir.

Her uygulama için ayrı bir LoadBalancer açmak pahalıdır. Genelde **tek** bir LoadBalancer bir **Ingress/Gateway denetleyicisinin** önüne konur, o da alan adı ve yola göre trafiği ClusterIP Service'lere dağıtır (Ingress dersi).

### Headless Service

```bash
kubectl create service clusterip api-hl --clusterip=None --tcp=80:80 --dry-run=client -o yaml | sed 's/app: api-hl/app: api/' | kubectl apply -f -
kubectl exec istemci -- nslookup api-hl
```

DNS üç Pod'un IP'sini ayrı ayrı döndü. Kullanım alanları: istemcinin kendi yük dağıtımını yaptığı durumlar (gRPC istemcileri, bazı veritabanı sürücüleri) ve **StatefulSet**: Her Pod'a sabit bir DNS adı verilir (`db-0.db`, `db-1.db`), durumlu iş yükleri dersinde.

### ExternalName ve seçicisiz Service

Küme dışındaki bir servise küme içinden sabit bir adla ulaşmak:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: veritabani
spec:
  type: ExternalName
  externalName: prod-db.abc123.eu-central-1.rds.amazonaws.com
```

Uygulama `veritabani:5432`'ye bağlanır. Veritabanı küme içine taşındığında sadece Service değişir, uygulama ayarı değişmez. (Dış adres bir IP ise seçicisiz bir Service ve elle yazılmış bir EndpointSlice kullanılır.)

## Sık yapılan hatalar

Service'e bağlanınca cevap gelmiyorsa sırayla:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=api      # 1. uç nokta var mı?
kubectl get pods -l app=api --show-labels                         # 2. seçici Pod'ların etiketlerine uyuyor mu?
kubectl get pods -l app=api -o wide                               # 3. Pod'lar Ready mi?
kubectl exec istemci -- curl -s -m 2 http://<POD_IP>:80/           # 4. Pod'a doğrudan ulaşılıyor mu?
kubectl exec istemci -- nslookup api                              # 5. DNS çözülüyor mu?
```

| Belirti | Sebep |
|---|---|
| EndpointSlice boş | Seçici etiketlere uymuyor (yazım hatası, farklı etiket) ya da hiçbir Pod Ready değil |
| Uç nokta var, bağlantı reddediliyor | `targetPort` yanlış ya da uygulama `127.0.0.1` dinliyor (Docker kursundaki tuzak) |
| Pod IP'sine ulaşılıyor, Service adına ulaşılmıyor | DNS (CoreDNS) ya da kube-proxy sorunu |
| Bazı istekler başarılı, bazıları değil | Pod'lardan biri sağlıksız ama readinessProbe yok, hâlâ trafik alıyor |

Bir tanesini üretelim: Seçicide yazım hatası.

```bash
kubectl create service clusterip apii --tcp=80:80
kubectl get endpointslices -l kubernetes.io/service-name=apii
kubectl exec istemci -- curl -s -m 3 http://apii/ || echo "bağlantı başarısız"
kubectl delete svc apii
```

`kubectl create service` seçiciyi Service'in adından (`app: apii`) üretti. Böyle bir Pod olmadığı için uç nokta listesi boş: Service var, DNS çözülüyor, ama arkasında kimse yok.

## Temizlik

```bash
kubectl delete svc api api-np api-hl
kubectl delete deploy api
kubectl delete pod istemci
```

## Alıştırma (lab'da)

1. `nginx:1.27-alpine` imajıyla bir Deployment oluştur. Container portuna `web` adını ver. Service'in `targetPort`'unu bu adla yaz ve Service'in 8080 portundan erişilebilir olduğunu doğrula.
2. Farklı bir namespace'teki (`test`) bir Pod'dan bu Service'e hangi DNS adıyla ulaşırsın? Dene.
3. Deployment'ın Pod'larından birinin içinde nginx'i durdur (`nginx -s stop`). Konteyner yeniden başlayana kadar o Pod'a giden isteklere ne olur? Bunu önleyen şey nedir?

<details><summary>Çözüm</summary>

```bash
cat > web.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          ports: [{ name: web, containerPort: 80 }]
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  selector: { app: web }
  ports: [{ port: 8080, targetPort: web }]
EOF
kubectl apply -f web.yaml && kubectl rollout status deploy/web
kubectl create namespace test
kubectl run -n test t --image=curlimages/curl:8.10.1 --restart=Never --rm -it -- curl -s -o /dev/null -w '%{http_code}\n' http://web.default:8080/

P=$(kubectl get pod -l app=web -o jsonpath='{.items[0].metadata.name}')
kubectl exec $P -- nginx -s stop
kubectl get pods -l app=web
kubectl delete -f web.yaml; kubectl delete ns test
```

2: `web.default` (ya da `web.default.svc.cluster.local`).

3: nginx durunca konteynerin ana süreci biter, kubelet konteyneri yeniden başlatır (`RESTARTS` artar). Arada geçen kısa sürede o Pod'a yönlendirilen istekler hata alabilir, çünkü Pod hâlâ uç nokta listesinde olabilir. Bu Deployment'ta readinessProbe olmadığı için Kubernetes Pod'un hazır olmadığını bilmiyor. readinessProbe olsaydı Pod hızlıca uç noktalardan çıkarılır, sağlıklı olunca geri eklenirdi (bir sonraki ders).

</details>

```quiz
Service var, DNS adı çözülüyor ama bağlantı zaman aşımına uğruyor ve EndpointSlice boş. En olası sebep?
- CoreDNS çalışmıyor
- [x] Service'in seçicisi hiçbir hazır Pod'un etiketiyle eşleşmiyor
- kube-proxy kapalı
? Uç nokta listesi, seçiciye uyan ve Ready olan Pod'lardan oluşur.
```

```quiz
`siparis` namespace'indeki bir Pod, `odeme` namespace'indeki `api` Service'ine hangi adla ulaşır?
- `api`
- [x] `api.odeme` (ya da `api.odeme.svc.cluster.local`)
- `odeme/api`
? Kısa ad sadece aynı namespace içinde çalışır.
```

```quiz
Bir StatefulSet'in her Pod'una ayrı ayrı DNS adıyla ulaşmak için hangi Service türü kullanılır?
- NodePort
- LoadBalancer
- [x] Headless (`clusterIP: None`)
? Headless Service sanal IP oluşturmaz, DNS Pod IP'lerini döner ve StatefulSet Pod'larına sabit adlar verir.
```

## Özet

- Service = seçici + port. Hazır Pod'ların IP'leri EndpointSlice'a yazılır, kube-proxy (ya da eBPF) Service IP'sini onlara çevirir.
- DNS: `servis` (aynı namespace), `servis.namespace`, `servis.namespace.svc.cluster.local`. `ndots:5`'e dikkat.
- ClusterIP (iç), NodePort (her node'da port), LoadBalancer (bulut/MetalLB), ExternalName (CNAME), headless (Pod IP'leri).
- `targetPort` için containerPort adı kullan.
- Hata ayıklama sırası: EndpointSlice → etiketler → Ready → Pod IP'ye doğrudan → DNS.
