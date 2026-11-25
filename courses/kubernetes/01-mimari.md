# Kubernetes mimarisi ve bildirimsel model

Kubernetes'i ilk kez kullanan birinin en çok zorlandığı şey komutlar değil, **zihinsel model**: Kubernetes'e "şunu yap" demezsin, "şu olsun" dersin. Sonra onlarca küçük denetleyici, gerçek durumu senin istediğin duruma yaklaştırmak için birbirinden habersiz çalışır. Bir Pod'un neden `Pending` kaldığını, neden silinince geri geldiğini, bir değişikliğin neden "hemen" olmadığını anlamak için bu modeli ve onu çalıştıran bileşenleri bilmek gerekir.

## Swarm'dan Kubernetes'e

Docker kursunun Swarm bölümünde gördüğün kavramların karşılıkları:

| Swarm | Kubernetes | Not |
|---|---|---|
| Manager | Control plane | API sunucusu, etcd, scheduler, denetleyiciler ayrı bileşenler |
| Worker | Node (worker node) | Üzerinde kubelet çalışır |
| Raft (manager'larda) | etcd (Raft) | Küme durumu etcd'de |
| Task / konteyner | **Pod** | Bir ya da birden fazla konteyner, aynı ağ namespace'i (Docker'daki `--network container:`) |
| Service (replicated) | **Deployment** + ReplicaSet | Rolling update, geri alma |
| Service (global) | **DaemonSet** | Her node'da bir Pod |
| Service'in VIP'i + DNS | **Service** | Ayrı bir nesne: Pod'lara etiketle bağlanır |
| Routing mesh / publish | NodePort, LoadBalancer, **Ingress / Gateway** | |
| Secret, Config | Secret, **ConfigMap** | |
| Stack (compose dosyası) | YAML manifest'leri, **Helm**, Kustomize | |
| `--constraint`, `--placement-pref` | nodeSelector, affinity, taint/toleration, topoloji yayılımı | |
| Volume (yerel) | **PersistentVolume / PVC**, StorageClass | Durumlu iş yükleri için çözülmüş bir model |

En büyük fark: Swarm'da bir "servis" hem çalıştırmayı hem ağ erişimini tanımlar. Kubernetes'te bunlar **ayrı nesnelerdir** ve birbirine **etiketlerle** (label) bağlanır. Bu, başta karmaşık görünür ama her parçanın bağımsız değiştirilebilmesini sağlar.

## Mimari

```text
                         ┌──────────────── Control plane ─────────────────┐
  kubectl ─── HTTPS ───▶ │  kube-apiserver ◀──▶ etcd                       │
  (ve diğer istemciler)  │       ▲   ▲   ▲                                 │
                         │       │   │   └── kube-scheduler                │
                         │       │   └────── kube-controller-manager       │
                         │       │           (cloud-controller-manager)    │
                         └───────┼─────────────────────────────────────────┘
                                 │ watch / status
             ┌───────────────────┼────────────────────┐
        ┌────┴─────── node01 ─────────┐     ┌──── node02 ────┐
        │ kubelet ──CRI──▶ containerd │     │ kubelet ...    │
        │ kube-proxy   CNI eklentisi  │     │ kube-proxy ... │
        │ [Pod] [Pod] [Pod]           │     │ [Pod] [Pod]    │
        └─────────────────────────────┘     └────────────────┘
```

### Control plane

| Bileşen | Görevi |
|---|---|
| **kube-apiserver** | Kümenin tek kapısı. Her istek (kubectl, denetleyiciler, kubelet'ler) buradan geçer: kimlik doğrulama, yetkilendirme (RBAC), kabul denetimi (admission), doğrulama, sonra etcd'ye yazma. **etcd ile konuşan tek bileşen** |
| **etcd** | Küme durumunun tamamı: her nesnenin istenen durumu (spec) ve gözlenen durumu (status). Raft ile çoğaltılan bir anahtar-değer deposu. etcd'yi kaybetmek kümeyi kaybetmektir |
| **kube-scheduler** | Henüz bir node'a atanmamış Pod'ları izler ve her biri için uygun node'u seçer (filtreleme + puanlama). Pod'u çalıştırmaz, sadece Pod'a `nodeName` yazar |
| **kube-controller-manager** | Onlarca denetleyiciyi (Deployment, ReplicaSet, Node, Job, EndpointSlice, ServiceAccount...) tek süreçte çalıştırır |
| **cloud-controller-manager** | Bulut sağlayıcısıyla entegrasyon: LoadBalancer tipli Service için bulutta yük dengeleyici açmak, node'ların bulut makineleriyle eşleşmesi |

### Node

| Bileşen | Görevi |
|---|---|
| **kubelet** | Node'daki ajan. API sunucusunu izler, bu node'a atanmış Pod'ları **CRI** üzerinden konteyner çalışma zamanına (containerd, CRI-O) çalıştırtır, probe'ları yürütür, durumu raporlar |
| **Konteyner çalışma zamanı** | containerd ya da CRI-O. Docker kursundaki containerd + runc'nin aynısı. Kubernetes 1.24'ten beri Docker Engine doğrudan desteklenmiyor, ama Docker ile build edilen imajlar (OCI) aynen çalışır |
| **kube-proxy** | Service'lerin sanal IP'lerini iptables, IPVS ya da nftables kurallarıyla Pod IP'lerine yönlendirir. Bazı ağ eklentileri (Cilium) bu işi eBPF ile kendisi yapıp kube-proxy'yi gereksiz kılar |
| **CNI eklentisi** | Pod ağını kurar: her Pod'a IP verir, node'lar arası Pod trafiğini taşır (Calico, Cilium, Flannel). Kubernetes ağı kendisi kurmaz, CNI eklentisine bırakır |

## Bildirimsel model ve uzlaştırma döngüsü

Her Kubernetes nesnesinin iki ana bölümü vardır:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:              # İSTENEN durum: sen yazarsın
  replicas: 3
  ...
status:            # GÖZLENEN durum: denetleyiciler yazar
  replicas: 3
  readyReplicas: 2
  ...
```

Her denetleyici aynı döngüyü çalıştırır:

```text
loop:
  istenen = API'den ilgili nesnelerin spec'i
  gercek  = API'den (ya da dünyadan) gözlenen durum
  if istenen != gercek: farkı kapatacak en küçük adımı at
```

Denetleyiciler sürekli sorgu yapmaz, API sunucusundaki değişiklikleri **izler** (watch) ve tepki verir. Önemli sonuçları:

- **Kendi kendini iyileştirme** ayrı bir özellik değil, modelin doğal sonucu: Bir Pod silinirse ReplicaSet denetleyicisi "3 istenmiş, 2 var" görür ve yenisini oluşturur.
- **Değişiklikler asenkron**: `kubectl apply` sadece istenen durumu etcd'ye yazar ve hemen döner. Gerçekleşmesi saniyeler sürebilir. Durumu `kubectl get`, `kubectl rollout status` ya da `kubectl wait` ile izlersin.
- **Bileşenler birbirini çağırmaz**: Her biri sadece API sunucusuyla konuşur. Scheduler çalışmıyorsa Pod'lar oluşturulur ama `Pending` kalır. Denetleyiciler çalışmıyorsa Deployment oluşturulur ama Pod'u olmaz. Hangi bileşenin çalışmadığını belirtilerden çıkarabilirsin.

### Bir Deployment'ın yolculuğu

`kubectl apply -f deployment.yaml` ile 3 replikalı bir Deployment oluşturduğunda:

```text
1. kubectl      → apiserver: Deployment nesnesini oluştur (doğrula, etcd'ye yaz)
2. Deployment denetleyicisi → yeni Deployment'ı gördü → bir ReplicaSet oluşturur
3. ReplicaSet denetleyicisi → "3 Pod istenmiş, 0 var" → 3 Pod nesnesi oluşturur (nodeName boş)
4. scheduler    → node'u olmayan 3 Pod gördü → her birine uygun node seçip nodeName yazar
5. kubelet (node01) → "bana atanmış bir Pod var" → containerd'ye imajı çektirir, konteyneri başlatır
6. kubelet      → Pod durumunu (Running, IP, Ready) apiserver'a yazar
7. EndpointSlice denetleyicisi → hazır Pod'ların IP'lerini ilgili Service'in uç noktalarına ekler
8. kube-proxy (her node) → Service kurallarını günceller
```

Bu derste bu yolculuğu canlı izleyeceğiz.

## Lab

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
kubeadm ile kurulmuş iki node'lu bir küme (controlplane + node01), kubectl hazır, root yetkili. Oturum yaklaşık 1 saat sürer.
```

### Kümeye bak

```bash
kubectl version
kubectl get nodes -o wide
kubectl cluster-info
```

`ROLES` sütununda `control-plane` olan node'da control plane bileşenleri çalışıyor. `CONTAINER-RUNTIME` sütununda `containerd://...`.

```bash
kubectl get pods -n kube-system -o wide
```

Listede `etcd-controlplane`, `kube-apiserver-controlplane`, `kube-scheduler-controlplane`, `kube-controller-manager-controlplane`, her node için bir `kube-proxy-...`, CoreDNS Pod'ları (küme DNS'i) ve ağ eklentisinin Pod'larını görürsün. Control plane bileşenleri de birer Pod olarak çalışıyor.

### Statik Pod'lar

Peki API sunucusunun kendisi bir Pod'sa, onu kim başlattı? kubeadm kümelerinde control plane bileşenleri **statik Pod**'dur: kubelet, belirli bir klasördeki manifest'leri API sunucusuna sormadan doğrudan çalıştırır.

```bash
ls /etc/kubernetes/manifests/
grep -E 'image:|--etcd-servers|--secure-port' /etc/kubernetes/manifests/kube-apiserver.yaml
cat /var/lib/kubelet/config.yaml | grep -i staticPodPath
```

Bu klasöre bir dosya koymak bir Pod başlatır, dosyayı kaldırmak Pod'u durdurur. Control plane bileşenlerinin yükseltilmesi ve ayarlarının değiştirilmesi bu dosyalar üzerinden yapılır (operasyon bölümü).

### Node tarafı

```bash
systemctl status kubelet --no-pager | head -5
crictl ps | head -8
```

`kubelet` sıradan bir systemd servisi (Linux kursu). `crictl`, CRI üzerinden konteyner çalışma zamanıyla konuşan araç: Docker kursundaki `docker ps`'in Kubernetes node'undaki karşılığı. Burada gördüğün konteynerler, Linux kursundan bildiğin cgroup'lar ve namespace'lerle izole edilmiş süreçler.

### Deployment'ın yolculuğunu izle

İkinci bir terminal sekmesi aç (Killercoda'da `+` ile) ve olayları canlı izle:

```bash
kubectl get events -w
```

İlk sekmede:

```bash
kubectl create deployment web --image=nginx:1.27-alpine --replicas=3
kubectl get deployment,replicaset,pod -o wide
```

Olay akışında yukarıdaki adımları sırayla görürsün: `ScalingReplicaSet` (Deployment denetleyicisi), `SuccessfulCreate` (ReplicaSet denetleyicisi), `Scheduled` (scheduler, hangi node'a), `Pulling`/`Pulled`/`Created`/`Started` (kubelet).

Nesneler arasındaki sahiplik zincirine bak:

```bash
kubectl get rs -l app=web -o jsonpath='{.items[0].metadata.ownerReferences[0].kind}/{.items[0].metadata.ownerReferences[0].name}{"\n"}'
P=$(kubectl get pod -l app=web -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $P -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}  node={.spec.nodeName}{"\n"}'
```

Pod'un sahibi ReplicaSet, ReplicaSet'in sahibi Deployment. Deployment silindiğinde bu zincir sayesinde altındakiler de silinir (garbage collection).

### Kendi kendini iyileştirme

```bash
kubectl delete pod $P
kubectl get pods -l app=web
```

Silinen Pod'un yerine **farklı adlı yeni bir Pod** oluşturuldu. Swarm'daki task mantığı: Aynı Pod "yeniden başlatılmadı", ReplicaSet denetleyicisi sayıyı tamamlamak için yenisini oluşturdu.

### Scheduler'ı durdur

Bileşenlerin birbirinden bağımsız çalıştığını görmek için scheduler'ın statik Pod manifest'ini geçici olarak kaldıralım:

```bash
mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/
sleep 20; kubectl get pods -n kube-system | grep scheduler || echo "scheduler yok"
kubectl scale deployment web --replicas=5
sleep 5; kubectl get pods -l app=web -o wide
```

Yeni iki Pod **oluşturuldu** (ReplicaSet denetleyicisi çalışıyor) ama `Pending` ve `NODE` sütunu `<none>`: onları bir node'a atayacak kimse yok.

```bash
kubectl describe pod $(kubectl get pods -l app=web --field-selector=status.phase=Pending -o name | head -1) | tail -5
mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/
sleep 30; kubectl get pods -l app=web -o wide
```

Scheduler geri gelince bekleyen Pod'lar hemen atandı ve çalıştı. Bir Pod'u `Pending`'de bulduğunda ilk soru: "Scheduler onu neden bir node'a koyamadı?" (`kubectl describe pod` → `Events`). Genelde cevap kaynak yetersizliği, uyuşmayan bir kısıt ya da bağlanamayan bir volume'dür. Scheduler'ın tamamen durması nadirdir.

### API'nin kendisi

```bash
kubectl api-resources | head -20
kubectl api-resources | wc -l
kubectl explain deployment.spec.strategy
kubectl get --raw /api/v1/namespaces/default/pods | head -c 300; echo
```

- `api-resources`: Kümenin bildiği bütün nesne türleri, kısa adları (`po`, `deploy`, `svc`) ve hangi API grubunda oldukları. Eklentiler (CRD'ler) yeni türler ekledikçe liste uzar.
- `explain`: Her alanın belgesi, kümenin kendi sürümüne göre. YAML yazarken en çok kullanacağın komutlardan biri.
- `get --raw`: kubectl'in arkasında sadece bir REST API var.

```bash
kubectl delete deployment web
```

## Kümeyi nereden alırım?

| Seçenek | Ne zaman |
|---|---|
| **kind**, **minikube**, **k3d** | Kendi bilgisayarında öğrenme ve geliştirme. kind, node'ları Docker konteynerleri olarak çalıştırır |
| **k3s** | Hafif, tek ikili dosyalık dağıtım. Küçük sunucular, uç (edge), ev laboratuvarları |
| **kubeadm** | Kendi sunucularında "vanilla" Kubernetes. Bu lab'daki küme. Kurulum ve yükseltmeleri sen yönetirsin |
| **Yönetilen** (EKS, GKE, AKS, DigitalOcean, Hetzner...) | Üretimde en yaygın. Control plane'i sağlayıcı işletir, sen node'ları ve iş yüklerini yönetirsin |

## Alıştırma (lab'da)

1. `kube-controller-manager` statik Pod'unu geçici olarak kaldır. Bir Deployment oluştur. Ne görüyorsun? Deployment nesnesi var mı? Pod var mı? Sonra geri al.
2. Bir Pod'u doğrudan (Deployment olmadan) oluştur: `kubectl run tekil --image=nginx:1.27-alpine`. Pod'u sil. Geri geliyor mu? Neden?

<details><summary>Cevap</summary>

```bash
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/
sleep 20
kubectl create deployment deneme --image=nginx:1.27-alpine
sleep 5
kubectl get deployment deneme; kubectl get rs,pods -l app=deneme
mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/
sleep 40; kubectl get rs,pods -l app=deneme
kubectl delete deployment deneme

kubectl run tekil --image=nginx:1.27-alpine
kubectl delete pod tekil
kubectl get pods
```

1: Deployment nesnesi oluşturuldu (API sunucusu ve etcd çalışıyor) ama `READY 0/1`, ReplicaSet de Pod da yok: Deployment'ı ReplicaSet'e, ReplicaSet'i Pod'a çevirecek denetleyiciler çalışmıyor. Geri gelince zincir tamamlandı.

2: Geri gelmez. Doğrudan oluşturulan Pod'un sahibi (ReplicaSet) yok, onu izleyip yeniden oluşturacak bir denetleyici de yok. Üretimde Pod'lar her zaman bir denetleyici (Deployment, StatefulSet, DaemonSet, Job) üzerinden oluşturulur.

</details>

```quiz
Yeni oluşturulan Pod'lar `Pending` durumunda ve `NODE` sütunu `<none>`. Hangi bileşenin işi tamamlanmamış?
- kubelet
- [x] kube-scheduler (Pod henüz bir node'a atanmamış)
- etcd
? Scheduler Pod'a nodeName yazar. Sebep genelde describe çıktısındaki Events'te: kaynak yetersiz, kısıt uyuşmuyor vb.
```

```quiz
etcd ile doğrudan konuşan tek bileşen hangisidir?
- kube-scheduler
- kubelet
- [x] kube-apiserver
? Bütün bileşenler API sunucusu üzerinden okur ve yazar. Doğrulama ve yetkilendirme orada yapılır.
```

```quiz
`kubectl apply` başarıyla döndü ama yeni Pod'lar henüz çalışmıyor. Bu bir hata mı?
- Evet, apply başarısız olmuş
- [x] Hayır, apply sadece istenen durumu kaydeder. Denetleyiciler bunu asenkron olarak gerçekleştirir
- Evet, kubelet çalışmıyor
? Durumu `kubectl rollout status` ya da `kubectl get -w` ile izlersin.
```

## Özet

- Control plane: apiserver (tek kapı) + etcd (durum) + scheduler (yerleşim) + controller-manager (uzlaştırma döngüleri).
- Node: kubelet (CRI ile containerd), kube-proxy (Service kuralları), CNI eklentisi (Pod ağı).
- Her nesne `spec` (istenen) ve `status` (gözlenen). Denetleyiciler farkı kapatır, değişiklikler asenkron.
- Deployment → ReplicaSet → Pod sahiplik zinciri. Silinen Pod yerine yenisi oluşturulur.
- kubeadm'de control plane statik Pod: `/etc/kubernetes/manifests`. `api-resources` ve `explain` ile API'yi keşfet.
