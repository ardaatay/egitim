# NetworkPolicy ile ağ izolasyonu

Kubernetes ağ modelinin temel kuralı, Pod dersinde gördüğümüz gibi: **Her Pod, her Pod'a ulaşabilir**. Farklı namespace'lerde olsalar bile. Bu, ele geçirilmiş tek bir Pod'un (bir açık barındıran bir frontend, kötü amaçlı bir bağımlılık) kümedeki veritabanına, iç API'lere ve yönetim panellerine doğrudan bağlanabilmesi demektir. Docker kursundaki `internal` ağların ve Linux kursundaki güvenlik duvarının küme içindeki karşılığı **NetworkPolicy**'dir.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Ön koşul: CNI desteği

NetworkPolicy, Kubernetes'in tanımladığı ama **uygulamadığı** bir API'dir. Kuralları ağ eklentisi (CNI) uygular. Calico, Cilium, Antrea, Weave destekler. **Flannel tek başına desteklemez**: NetworkPolicy nesneleri oluşturulur ama hiçbir etkisi olmaz, ve bu sessizce olur.

```bash
kubectl get pods -n kube-system -o name | grep -E -i 'calico|cilium|flannel|canal|weave|antrea'
```

Aşağıdaki "varsayılan reddet" adımından sonra trafik hâlâ geçiyorsa, kümendeki CNI NetworkPolicy uygulamıyor demektir. Yönetilen kümelerde bu genelde bir ayardır (EKS'te VPC CNI'ın network policy özelliği, GKE'de Dataplane V2, AKS'te Azure/Calico/Cilium seçeneği).

## Model

- NetworkPolicy, `podSelector` ile seçtiği Pod'lara uygulanır.
- Bir Pod'u seçen **hiçbir** politika yoksa: her şeye izin verilir (varsayılan).
- Bir Pod'u seçen en az bir politika varsa ve politika `Ingress` (gelen) yönünü içeriyorsa: o Pod'a **sadece politikaların izin verdiği** gelen trafik kabul edilir. `Egress` (giden) için de aynısı.
- Politikalar **sadece izin verir** ve **toplanır** (birleşimleri alınır). "Reddet" kuralı yazılmaz, reddetme izin verilmemiş olmaktan gelir.
- Kurallar bağlantı yönüne göredir: İzin verilen bir bağlantının cevap paketleri otomatik geçer.

## Hazırlık: üç katmanlı uygulama

```bash
kubectl create namespace magaza
kubectl -n magaza run frontend --image=nginx:1.27-alpine --labels="app=frontend,katman=web"
kubectl -n magaza run api --image=traefik/whoami:v1.10 --labels="app=api,katman=uygulama" --port=80
kubectl -n magaza run db --image=redis:7-alpine --labels="app=db,katman=veri" --port=6379
kubectl -n magaza expose pod api --port=80
kubectl -n magaza expose pod db --port=6379
kubectl create namespace baska
kubectl -n baska run yabanci --image=nginx:1.27-alpine
kubectl -n magaza wait --for=condition=Ready pod --all --timeout=60s
kubectl -n baska wait --for=condition=Ready pod --all --timeout=60s
```

`api` Pod'unda (whoami) kabuk ve `nc` yok. `api`'den giden bağlantıları test etmek için aynı etiketleri taşıyan bir test Pod'u açalım, sonra bağlantıları deneyen küçük bir fonksiyon tanımlayalım:

```bash
kubectl -n magaza run api-test --image=busybox:1.36 --labels="app=api,katman=uygulama" -- sleep 3600
kubectl -n magaza wait --for=condition=Ready pod/api-test
dene() {  # dene <namespace> <pod> <hedef> <port>
  if kubectl -n "$1" exec "$2" -- nc -z -w 2 "$3" "$4" >/dev/null 2>&1; then echo "✓ $1/$2 -> $3:$4"; else echo "✗ $1/$2 -> $3:$4"; fi
}
tara() {
  dene magaza frontend api.magaza 80
  dene magaza frontend db.magaza 6379
  dene magaza api-test db.magaza 6379
  dene baska yabanci api.magaza 80
  dene baska yabanci db.magaza 6379
}
tara
```

Başlangıçta hepsi ✓: Başka bir namespace'teki `yabanci` Pod'u bile veritabanına bağlanabiliyor.

## 1. Varsayılan reddet

İyi uygulama: Namespace'te önce **her şeyi kapat**, sonra gerekenleri tek tek aç.

```bash
cat > np-reddet.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: varsayilan-reddet
  namespace: magaza
spec:
  podSelector: {}          # namespace'teki BÜTÜN Pod'lar
  policyTypes: [Ingress]   # gelen trafiği kısıtla (egress henüz serbest)
EOF
kubectl apply -f np-reddet.yaml
sleep 3; tara
```

Hepsi ✗ (CNI destekliyorsa). `podSelector: {}` bütün Pod'ları seçer, `ingress` kuralı olmadığı için hiçbir gelen bağlantıya izin yok. Namespace içindeki Pod'lar bile birbirine ulaşamıyor.

## 2. Gerekenleri aç

```bash
cat > np-izinler.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-izin, namespace: magaza }
spec:
  podSelector:
    matchLabels: { app: api }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: frontend }
      ports:
        - port: 80
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: db-izin, namespace: magaza }
spec:
  podSelector:
    matchLabels: { app: db }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: api }
      ports:
        - port: 6379
EOF
kubectl apply -f np-izinler.yaml
sleep 3; tara
```

Beklenen:

```text
✓ magaza/frontend -> api.magaza:80
✗ magaza/frontend -> db.magaza:6379       frontend veritabanına ulaşamaz
✓ magaza/api-test -> db.magaza:6379        sadece api katmanı
✗ baska/yabanci -> api.magaza:80
✗ baska/yabanci -> db.magaza:6379
```

`from` içindeki `podSelector` (namespace belirtilmeden), **politikanın kendi namespace'indeki** Pod'ları seçer.

## Başka namespace'lerden izin vermek

Ingress denetleyicisi (önceki ders) genelde kendi namespace'inde çalışır ve frontend'e ulaşması gerekir. Namespace'ler, Kubernetes'in otomatik eklediği `kubernetes.io/metadata.name` etiketiyle seçilebilir:

```yaml
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: traefik
```

### En sık yapılan hata: VE mi, VEYA mı?

İki yazım arasındaki tek fark bir tire, ama anlamları tamamen farklı:

```yaml
# (A) TEK öğe: namespaceSelector VE podSelector
#     "izleme namespace'indeki, app=prometheus etiketli Pod'lar"
  - from:
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: izleme } }
        podSelector: { matchLabels: { app: prometheus } }

# (B) İKİ öğe: namespaceSelector VEYA podSelector
#     "izleme namespace'indeki BÜTÜN Pod'lar" VEYA "bu namespace'teki app=prometheus Pod'lar"
  - from:
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: izleme } }
      - podSelector: { matchLabels: { app: prometheus } }
```

(B), istenenden çok daha geniş bir izin verir. Politika yazdıktan sonra her zaman `kubectl describe networkpolicy` çıktısını okuyarak ve gerçek bağlantılarla test ederek doğrula.

## Egress: giden trafik

Ele geçirilmiş bir Pod'un dışarıya veri sızdırmasını ya da iç sistemlere yayılmasını kısıtlamak için giden trafik de sınırlanabilir:

```bash
cat > np-egress.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: frontend-cikis, namespace: magaza }
spec:
  podSelector:
    matchLabels: { app: frontend }
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector: { matchLabels: { app: api } }
      ports: [{ port: 80 }]
EOF
kubectl apply -f np-egress.yaml
sleep 3
dene magaza frontend api.magaza 80
kubectl -n magaza exec frontend -- nc -z -w 2 $(kubectl -n magaza get svc api -o jsonpath='{.spec.clusterIP}') 80 && echo "IP ile ✓"
```

İlk test **başarısız**, IP ile test başarılı. Neden? `api.magaza` adını çözmek için frontend'in **DNS'e** (kube-system'deki CoreDNS, 53/UDP+TCP) erişmesi gerekiyor ve egress politikası buna izin vermiyor. Egress kısıtlamalarında en sık unutulan şey:

```bash
cat > np-dns.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: dns-izin, namespace: magaza }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports:
        - { port: 53, protocol: UDP }
        - { port: 53, protocol: TCP }
EOF
kubectl apply -f np-dns.yaml
sleep 3
dene magaza frontend api.magaza 80
dene magaza frontend db.magaza 6379
```

Artık frontend `api`'ye adıyla ulaşıyor ama `db`'ye ulaşamıyor (hem db'nin ingress'i hem frontend'in egress'i izin vermiyor). Dikkat: `np-dns` politikası `podSelector: {}` ile bütün Pod'ları seçip `Egress` içerdiği için, namespace'teki **bütün Pod'ların** giden trafiği artık sadece DNS ile sınırlı oldu. `api-test -> db` bağlantısı da kesildi:

```bash
dene magaza api-test db.magaza 6379
```

Tam izolasyon istiyorsan api için de `db`'ye egress izni yazmalısın. Egress kısıtlamaları güçlüdür ama dikkat ister: Uygulamanın dış API'lere, metrik ve log sistemlerine, bulut sağlayıcısının meta veri servisine giden bütün bağlantılarını bilmen gerekir.

### Dış adresler: ipBlock

```yaml
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 169.254.169.254/32]   # iç ağ ve bulut meta veri servisi hariç
      ports: [{ port: 443 }]
```

"İnternete HTTPS ile çıkabilir, ama iç ağa ve meta veri servisine ulaşamaz" türünde kurallar. Bulut ortamlarında `169.254.169.254` (meta veri servisi) Pod'lardan erişilebilirse, bir SSRF açığı node'un bulut kimlik bilgilerinin çalınmasına yol açabilir.

Standart NetworkPolicy'nin sınırları: Alan adıyla kural yazılamaz (sadece IP), L7 (HTTP yolu, metot) kuralı yoktur, küme genelinde (bütün namespace'lere uygulanan) politika yoktur. Cilium ve Calico bunlar için kendi genişletilmiş nesnelerini sunar (`CiliumNetworkPolicy` ile FQDN ve HTTP kuralları, Calico `GlobalNetworkPolicy`). Kubernetes'te bunlar için standart bir API (AdminNetworkPolicy) da geliştiriliyor.

## Uygulama stratejisi

1. Her namespace'e **varsayılan reddet** (ingress) politikası koy. Egress'i ayrı ve daha sonra ele al.
2. Uygulamanın gerçek trafik akışını çıkar (hangi servis hangisine, hangi portta). Servis ağı ya da Cilium Hubble gibi araçlar mevcut trafiği gösterebilir.
3. İzinleri **etiketlerle** yaz, IP'lerle değil.
4. Politikaları uygulamanın manifest'leriyle aynı yerde (Helm chart, Kustomize) tut: uygulamayla birlikte gelsinler.
5. Her değişiklikten sonra bağlantıları test et. CNI'ın politikaları gerçekten uyguladığını doğrula.

## Temizlik

```bash
kubectl delete namespace magaza baska
```

## Alıştırma (lab'da)

1. Hazırlık bölümündeki uygulamayı yeniden kur. `magaza` namespace'ine varsayılan reddet politikasını ve sadece şu bağlantılara izin veren politikaları yaz: `traefik` namespace'inden frontend'e 80, frontend'den api'ye 80, api'den db'ye 6379.
2. Aşağıdaki politikanın neye izin verdiğini kendi cümlelerinle açıkla, sonra `describe` çıktısıyla karşılaştır:

```yaml
spec:
  podSelector: { matchLabels: { app: db } }
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { takim: odeme } }
        - podSelector: { matchLabels: { rol: yedek } }
```

<details><summary>Cevap</summary>

1: Varsayılan reddet + üç politika (`frontend` için `namespaceSelector` ile traefik, `api` için `podSelector: app=frontend`, `db` için `podSelector: app=api`). Ders içindeki `np-reddet.yaml` ve `np-izinler.yaml` ile frontend için şu eklenir:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: frontend-izin, namespace: magaza }
spec:
  podSelector: { matchLabels: { app: frontend } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: traefik } }
      ports: [{ port: 80 }]
```

2: `from` altında **iki ayrı öğe** var, yani VEYA: `takim=odeme` etiketli namespace'lerdeki **bütün** Pod'lar, VEYA politikanın kendi namespace'indeki `rol=yedek` etiketli Pod'lar `db`'ye bağlanabilir. Muhtemelen niyet "odeme takımının namespace'lerindeki yedek Pod'ları" idi, bunun için iki seçici tek öğede (tire olmadan) yazılmalıydı. `policyTypes` verilmediği için `ingress` alanı olduğundan `Ingress` varsayılır.

</details>

```quiz
NetworkPolicy oluşturdun ama trafik hiç kısıtlanmıyor. En olası sebep?
- Politika yanlış namespace'te
- [x] Kümenin CNI eklentisi (örneğin Flannel tek başına) NetworkPolicy uygulamıyor
- kube-proxy kapalı
? NetworkPolicy'yi CNI uygular. Desteklemeyen CNI'da nesneler sessizce etkisiz kalır.
```

```quiz
Bir namespace'teki bütün Pod'lara gelen trafiği kapatan politika hangisi?
- `podSelector: {}` ve `ingress: [{}]`
- [x] `podSelector: {}`, `policyTypes: [Ingress]` ve hiç ingress kuralı yok
- `podSelector` olmadan boş bir politika
? Boş seçici bütün Pod'ları seçer. Kural yoksa hiçbir gelen trafiğe izin verilmez. `ingress: [{}]` ise her şeye izin verir.
```

```quiz
Egress kısıtlaması ekledikten sonra Pod'lar Service adlarını çözemiyor. Neden?
- CoreDNS çöktü
- [x] kube-system'deki DNS Pod'larına 53/UDP+TCP egress izni verilmedi
- Service'ler silindi
? Egress kısıtlamalarında DNS izni ilk eklenmesi gereken kuraldır.
```

## Özet

- Varsayılan: her Pod her Pod'a ulaşır. NetworkPolicy bunu kısıtlar, ama CNI desteği şart.
- Politika seçtiği Pod'lar için izin listesi tanımlar. Politikalar toplanır, reddetme izinsizlikten gelir.
- Önce varsayılan reddet (`podSelector: {}` + `policyTypes`), sonra etiketlerle izinler.
- `from`/`to` içinde tek öğede iki seçici = VE, iki öğe = VEYA.
- Egress'te DNS iznini unutma. `ipBlock` ile dış adresler ve meta veri servisini dışlama.
- FQDN ve L7 kuralları için Cilium/Calico'nun genişletilmiş politikaları.
