# Zamanlama: affinity, taint/toleration, topoloji yayılımı

Mimari dersinde scheduler'ın her Pod için bir node seçtiğini gördük. Varsayılan davranış çoğu zaman yeterli, ama şu sorular için ona yol göstermek gerekir: GPU isteyen Pod'lar sadece GPU'lu node'lara gitsin, veritabanı replikaları aynı node'a düşmesin, üç replika üç farklı availability zone'a dağılsın, sadece belirli ekibin Pod'ları belirli node'ları kullanabilsin. Bu derste scheduler'ın nasıl karar verdiğini ve bu kararı etkilemenin yollarını göreceğiz. Swarm'daki `--constraint` ve `--placement-pref`'in çok daha esnek karşılıkları.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
İki node'lu lab kümesinde bazı davranışlar (zone'lara yayılım gibi) sınırlı gözlemlenebilir. Node'lara etiketler ekleyerek senaryoları taklit edeceğiz.
```

## Scheduler nasıl karar verir?

Her Pod için iki aşama:

1. **Filtreleme**: Pod'u çalıştıramayacak node'ları ele: yeterli requests kapasitesi yok, `nodeSelector`/zorunlu affinity uymuyor, tolere edilmeyen bir taint var, gereken port dolu, volume o zone'da değil.
2. **Puanlama**: Kalanları puanla: kaynakları dengeli kullanma, tercih edilen affinity'ler, yayılım kuralları, imajın node'da zaten olması. En yüksek puanlı node seçilir.

Hiçbir node filtreden geçemezse Pod `Pending` kalır ve olaylarda sebebi yazılır:

```bash
kubectl run sigmaz --image=nginx:1.27-alpine --overrides='{"spec":{"nodeSelector":{"disk":"nvme"}}}'
sleep 5; kubectl describe pod sigmaz | tail -3
kubectl delete pod sigmaz
```

`0/2 nodes are available: 1 node(s) didn't match Pod's node affinity/selector, 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }`. Bu mesajı okuyabilmek, zamanlama sorunlarının yarısını çözer.

## nodeSelector ve node etiketleri

En basit yöntem: Pod'u belirli etiketli node'lara kısıtla.

```bash
kubectl get nodes --show-labels | tr ',' '\n' | grep -E 'kubernetes.io/(hostname|arch|os)|topology' | sort -u
kubectl label node node01 disk=ssd bolge=istanbul
kubectl run ssd-istiyor --image=nginx:1.27-alpine --overrides='{"spec":{"nodeSelector":{"disk":"ssd"}}}'
sleep 5; kubectl get pod ssd-istiyor -o wide
kubectl delete pod ssd-istiyor
```

Hazır etiketler: `kubernetes.io/hostname`, `kubernetes.io/arch` (`amd64`/`arm64`, Docker kursundaki çok mimarili imajlar), `kubernetes.io/os`, bulutta `topology.kubernetes.io/zone` ve `region`, `node.kubernetes.io/instance-type`.

## Node affinity

nodeSelector'ın güçlü hâli: operatörler (`In`, `NotIn`, `Exists`, `Gt`, `Lt`) ve **zorunlu** ile **tercih edilen** kurallar.

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:     # zorunlu (filtre)
        nodeSelectorTerms:
          - matchExpressions:
              - { key: kubernetes.io/arch, operator: In, values: [amd64, arm64] }
              - { key: disk, operator: In, values: [ssd, nvme] }
      preferredDuringSchedulingIgnoredDuringExecution:    # tercih (puan)
        - weight: 80
          preference:
            matchExpressions:
              - { key: bolge, operator: In, values: [istanbul] }
```

Uzun adın son kısmı önemli: **IgnoredDuringExecution**. Kural sadece zamanlama anında uygulanır. Pod çalışırken node'un etiketi değişse bile Pod oradan taşınmaz.

- `nodeSelectorTerms` altındaki terimler **VEYA**, bir terimin içindeki ifadeler **VE** ile bağlanır.
- Tercih edilen kurallar zorunlu değildir: Uyan node yoksa Pod yine de başka bir yere yerleşir.

## Pod affinity ve anti-affinity

Node'un kendi özelliklerine değil, **üzerinde hangi Pod'ların çalıştığına** göre karar:

- **podAffinity**: "Şu Pod'larla aynı yere koy" (önbellek ile uygulamayı aynı node'a, gecikmeyi azaltmak için).
- **podAntiAffinity**: "Şu Pod'larla aynı yere koyma" (bir uygulamanın replikalarını farklı node'lara).

```bash
cat > anti.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: db-benzeri }
spec:
  replicas: 3
  selector: { matchLabels: { app: db-benzeri } }
  template:
    metadata: { labels: { app: db-benzeri } }
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels: { app: db-benzeri }
              topologyKey: kubernetes.io/hostname
      containers:
        - name: c
          image: nginx:1.27-alpine
          resources: { requests: { cpu: 10m, memory: 16Mi } }
EOF
kubectl apply -f anti.yaml
sleep 10; kubectl get pods -l app=db-benzeri -o wide
```

Sadece bir Pod çalıştı, diğer ikisi `Pending`: Zorunlu anti-affinity kuralı "aynı `hostname`'e (aynı node'a) iki replika koyma" diyor ve uygulama Pod'larını alabilen tek node var. **`topologyKey`** "aynı yer" kavramını tanımlar: `kubernetes.io/hostname` aynı node, `topology.kubernetes.io/zone` aynı zone demektir.

Zorunlu anti-affinity bu yüzden tehlikelidir: Node sayısı replika sayısının altına düşerse (bakım, arıza) Pod'lar zamanlanamaz. Çoğu durumda **tercih edilen** sürümü daha doğrudur:

```bash
kubectl patch deploy db-benzeri --type=json -p '[{"op":"replace","path":"/spec/template/spec/affinity","value":{"podAntiAffinity":{"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":100,"podAffinityTerm":{"labelSelector":{"matchLabels":{"app":"db-benzeri"}},"topologyKey":"kubernetes.io/hostname"}}]}}}]'
sleep 15; kubectl get pods -l app=db-benzeri -o wide
kubectl delete -f anti.yaml
```

Artık üçü de çalışıyor (tek node'da, çünkü başka seçenek yok). Daha fazla node olsaydı farklı node'lara dağılırlardı. Pod anti-affinity büyük kümelerde scheduler için pahalı bir hesaptır. Yayılım için çoğu zaman aşağıdaki **topologySpreadConstraints** daha iyi bir araçtır.

## Topoloji yayılımı

"Replikaları zone'lara (ya da node'lara) **eşit** dağıt, aradaki fark en fazla 1 olsun":

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: ScheduleAnyway      # ya da DoNotSchedule (zorunlu)
      labelSelector:
        matchLabels: { app: siparis }
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels: { app: siparis }
```

6 replika, 3 zone: her zone'a 2. Bir zone giderse uygulama kapasitesinin üçte ikisiyle ayakta kalır. Önceki dersteki PDB'nin anlamlı olması için replikaların bu şekilde dağılmış olması gerekir. Yönetilen kümelerde kümenin varsayılan yayılım kuralları zaten node ve zone'a göre hafif bir yayılım uygular, ama üretim iş yüklerinde açıkça yazmak öngörülebilirlik sağlar.

## Taint ve toleration

Affinity, Pod'un "nereye gitmek istediğini" söyler. **Taint** ise node'un "kimi kabul etmediğini" söyler. Bir node'a taint konunca, o taint'i **tolere etmeyen** Pod'lar oraya yerleşemez.

Lab kümesinde zaten bir örnek var:

```bash
kubectl describe node controlplane | grep -A2 Taints
```

`node-role.kubernetes.io/control-plane:NoSchedule`: Uygulama Pod'ları control plane node'una gitmesin. DaemonSet dersinde bu taint'i tolere ederek ajanımızı oraya da koymuştuk.

Kendi taint'imizi deneyelim: `node01`'i GPU'lu node gibi ayıralım.

```bash
kubectl taint node node01 gpu=var:NoSchedule
kubectl run normal --image=nginx:1.27-alpine
sleep 5; kubectl get pod normal; kubectl describe pod normal | tail -2

cat > gpu-pod.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: gpu-isi }
spec:
  tolerations:
    - key: gpu
      operator: Equal
      value: var
      effect: NoSchedule
  nodeSelector:
    kubernetes.io/hostname: node01
  containers:
    - name: c
      image: nginx:1.27-alpine
EOF
kubectl apply -f gpu-pod.yaml
sleep 5; kubectl get pods -o wide
```

`normal` Pod'u hiçbir yere yerleşemedi (control plane da taint'li). `gpu-isi` taint'i tolere ettiği için node01'e yerleşti.

Önemli bir ayrım: **Toleration "gidebilirsin" der, "git" demez.** Bir Pod'un **sadece** GPU node'larına gitmesi için toleration'a ek olarak nodeSelector ya da node affinity gerekir. Tipik desen: GPU node'larına taint (başka iş yükü gelmesin) + GPU iş yüklerine toleration ve nodeSelector (sadece oraya gitsinler).

| Etki (effect) | Anlamı |
|---|---|
| `NoSchedule` | Tolere etmeyen yeni Pod'lar yerleşmez, mevcutlar kalır |
| `PreferNoSchedule` | Mümkünse yerleşmez |
| `NoExecute` | Tolere etmeyen **mevcut** Pod'lar da tahliye edilir (`tolerationSeconds` ile gecikmeli) |

Kubernetes `NoExecute`'u kendisi de kullanır: Bir node erişilemez olunca `node.kubernetes.io/unreachable:NoExecute` taint'i eklenir ve Pod'lar varsayılan 300 saniye sonra başka node'lara taşınır. Bu süre Pod'larda `tolerationSeconds` ile kısaltılabilir.

```bash
kubectl taint node node01 gpu=var:NoSchedule-
sleep 10; kubectl get pod normal -o wide
kubectl delete pod normal gpu-isi
kubectl label node node01 disk- bolge-
```

Taint'in sonundaki `-` onu kaldırır. Bekleyen Pod hemen yerleşti.

## Öncelik ve önalım

Küme doluyken kritik bir Pod gelirse ne olur? **PriorityClass** ile Pod'lara öncelik verilir: Yer yoksa scheduler daha düşük öncelikli Pod'ları **çıkararak** (preemption) yer açar.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata: { name: kritik }
value: 100000
globalDefault: false
description: "Ödeme ve sipariş servisleri"
---
# Pod spec'inde:
#   priorityClassName: kritik
```

Kümenin kendi bileşenleri `system-cluster-critical` ve `system-node-critical` sınıflarını kullanır. Öncelikleri dikkatli kullan: Yüksek öncelikli hatalı bir iş yükü (sonsuz ölçeklenen bir HPA) diğer her şeyi kümeden atabilir. ResourceQuota ile öncelik sınıfı başına sınır konabilir.

## Alıştırma (lab'da)

1. `node01`'e `takim=odeme:NoSchedule` taint'i ve `takim=odeme` etiketi ekle. Sadece ödeme ekibinin Pod'larının bu node'a gideceği ve onların da **sadece** bu node'a gideceği bir Deployment yaz. Taint'i ve etiketi geri al.
2. Bir Pod'un `Pending` kalmasının üç farklı sebebini (kaynak, taint, affinity) sırayla üret ve her biri için `kubectl describe` olay mesajını not et.

<details><summary>Çözüm</summary>

```bash
kubectl taint node node01 takim=odeme:NoSchedule
kubectl label node node01 takim=odeme
cat > odeme.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: odeme }
spec:
  replicas: 2
  selector: { matchLabels: { app: odeme } }
  template:
    metadata: { labels: { app: odeme } }
    spec:
      tolerations:
        - { key: takim, operator: Equal, value: odeme, effect: NoSchedule }
      nodeSelector: { takim: odeme }
      containers:
        - { name: c, image: nginx:1.27-alpine }
EOF
kubectl apply -f odeme.yaml; sleep 10; kubectl get pods -l app=odeme -o wide
kubectl delete -f odeme.yaml; kubectl taint node node01 takim=odeme:NoSchedule-; kubectl label node node01 takim-

kubectl run p1 --image=nginx:1.27-alpine --overrides='{"spec":{"containers":[{"name":"p1","image":"nginx:1.27-alpine","resources":{"requests":{"cpu":"64"}}}]}}'
kubectl taint node node01 deneme=1:NoSchedule; kubectl run p2 --image=nginx:1.27-alpine
kubectl run p3 --image=nginx:1.27-alpine --overrides='{"spec":{"nodeSelector":{"yok":"yok"}}}'
sleep 5; for p in p1 p2 p3; do echo "== $p"; kubectl describe pod $p | grep FailedScheduling | tail -1; done
kubectl delete pod p1 p2 p3; kubectl taint node node01 deneme=1:NoSchedule-
```

2: p1 `Insufficient cpu`, p2 `untolerated taint {deneme: 1}`, p3 `didn't match Pod's node affinity/selector`.

</details>

```quiz
GPU node'larına sadece GPU iş yüklerinin gitmesi ve GPU iş yüklerinin sadece oraya gitmesi için ne gerekir?
- Sadece toleration
- Sadece nodeSelector
- [x] Node'lara taint + iş yüklerine hem toleration hem nodeSelector/node affinity
? Toleration "gidebilirsin" der, "git" demez. Taint diğerlerini dışarıda tutar, nodeSelector bu iş yüklerini oraya yönlendirir.
```

```quiz
3 replikalı bir Deployment'a `kubernetes.io/hostname` için **zorunlu** podAntiAffinity verdin. Kümede 2 node kaldı. Ne olur?
- 3 Pod 2 node'a dağılır
- [x] Üçüncü Pod Pending kalır
- Kural otomatik gevşetilir
? Zorunlu anti-affinity node sayısı replikadan azsa zamanlamayı engeller. Çoğu durumda tercih edilen sürüm ya da topologySpreadConstraints daha uygundur.
```

```quiz
Pod'ların çalışırken, node'un etiketi değişince taşınmamasının sebebi?
- Bir hata
- [x] Affinity kuralları `IgnoredDuringExecution`: sadece zamanlama anında uygulanır
- Etiketler değiştirilemez
? Çalışan Pod'ları tahliye eden mekanizma NoExecute taint'leridir.
```

## Özet

- Scheduler: filtreleme (requests, seçiciler, taint, port, volume) → puanlama. `Pending` sebebi olaylarda.
- nodeSelector ve node affinity (zorunlu/tercih, `In/NotIn/Exists`). IgnoredDuringExecution.
- Pod (anti-)affinity ve `topologyKey`. Zorunlu anti-affinity tehlikeli, yayılım için topologySpreadConstraints.
- Taint (node "kabul etmem" der) + toleration (Pod "katlanırım" der). NoSchedule, PreferNoSchedule, NoExecute.
- Ayrılmış node'lar: taint + toleration + nodeSelector.
- PriorityClass ve önalım: dikkatli ve kotalarla.
