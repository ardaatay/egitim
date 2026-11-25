# Ingress, Gateway API ve cert-manager ile TLS

Service dersinde dışarıya açılmanın iki yolunu gördük: NodePort (garip port aralığı, node IP'leri) ve LoadBalancer (her uygulama için ayrı ve ücretli bir yük dengeleyici). Gerçek kümelerde bunun yerine tek bir giriş noktası kurulur: Linux kursundaki nginx reverse proxy'nin küme içindeki karşılığı. Alan adına ve yola göre trafiği doğru Service'e yönlendirir, TLS'i sonlandırır. Kubernetes'te bunun iki API'si var: eski ve yaygın **Ingress**, yeni ve daha güçlü **Gateway API**.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Kavramlar

| | Ingress | Gateway API |
|---|---|---|
| Nesneler | `IngressClass`, `Ingress` | `GatewayClass`, `Gateway`, `HTTPRoute` (ve `GRPCRoute`, `TLSRoute`...) |
| Durum | Kararlı ama **dondurulmuş**: yeni özellik eklenmiyor | Kubernetes'in önerdiği yeni standart (v1, GA) |
| Gelişmiş özellikler | Denetleyiciye özgü **annotation**'larla (taşınabilir değil) | API'nin kendisinde: ağırlıklı yönlendirme, başlık eşleme, yönlendirme, URL yeniden yazma |
| Rol ayrımı | Tek nesne | Altyapı ekibi `Gateway`'i, uygulama ekipleri kendi `HTTPRoute`'larını yönetir |

Her ikisi de sadece bir **tanımdır**: Trafiği gerçekten işleyen bir **denetleyici** (controller) kurulu olmalıdır. Denetleyiciler, Ingress/Gateway nesnelerini izleyip kendi proxy'lerinin (nginx, Envoy, Traefik, HAProxy) ayarlarını üretir.

> **ingress-nginx hakkında:** Uzun yıllar en yaygın denetleyici olan topluluk projesi **ingress-nginx**, Kubernetes projesinin Kasım 2025'teki duyurusuyla Mart 2026'da emekliye ayrıldı: artık güvenlik yaması da almıyor. İnternetteki örneklerin çoğu onu kullanır, ama yeni kurulumlarda başka bir denetleyici seçilmeli ve mevcut kurulumlar taşınmalıdır. (F5'in ayrı bir ürünü olan "NGINX Ingress Controller" bu duyurudan etkilenmedi.) Yaygın alternatifler: **Traefik**, **Envoy Gateway**, **Cilium**, **NGINX Gateway Fabric**, **HAProxy**, **Kong**, **Istio**. Çoğu hem Ingress hem Gateway API destekler.

Bu derste ikisini de destekleyen **Traefik**'i kullanacağız.

## Kurulum

Helm (bir sonraki bölümün konusu) ile Traefik'i kuralım. Önce Helm ve Gateway API'nin nesne tanımları (CRD):

```bash
command -v helm >/dev/null || curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
kubectl get crd | grep gateway
```

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm install traefik traefik/traefik -n traefik --create-namespace \
  --set service.type=NodePort \
  --set ports.web.nodePort=30080 \
  --set ports.websecure.nodePort=30443 \
  --set providers.kubernetesGateway.enabled=true
kubectl -n traefik rollout status deploy/traefik
kubectl get ingressclass,gatewayclass
kubectl -n traefik get svc traefik
```

Bulutta `service.type` varsayılan değerinde (`LoadBalancer`) bırakılır ve sağlayıcı tek bir dış yük dengeleyici açar. Lab'da bulut olmadığı için NodePort kullanıyoruz: Her node'un 30080 portu Traefik'in HTTP girişi.

Örnek uygulamalar:

```bash
kubectl create deployment siparis --image=traefik/whoami:v1.10 --replicas=2
kubectl create deployment odeme --image=traefik/whoami:v1.10 --replicas=2
kubectl expose deployment siparis --port=80
kubectl expose deployment odeme --port=80
kubectl rollout status deploy/siparis && kubectl rollout status deploy/odeme
```

## Ingress

```bash
cat > ingress.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: magaza
spec:
  ingressClassName: traefik
  rules:
    - host: magaza.local
      http:
        paths:
          - path: /siparis
            pathType: Prefix
            backend:
              service: { name: siparis, port: { number: 80 } }
          - path: /odeme
            pathType: Prefix
            backend:
              service: { name: odeme, port: { number: 80 } }
    - host: odeme.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: odeme, port: { number: 80 } }
EOF
kubectl apply -f ingress.yaml
kubectl get ingress magaza
sleep 3
curl -s -H 'Host: magaza.local' localhost:30080/siparis | grep -E 'Hostname|GET'
curl -s -H 'Host: magaza.local' localhost:30080/odeme | grep -E 'Hostname|GET'
curl -s -H 'Host: odeme.local' localhost:30080/ | grep Hostname
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: bilinmeyen.local' localhost:30080/
```

Linux kursundaki `curl -H 'Host: ...'` yöntemiyle DNS ayarlamadan alan adlarını test ettik. Bilinmeyen alan adı için 404.

| Alan | Anlamı |
|---|---|
| `ingressClassName` | Hangi denetleyici işlesin (bir kümede birden fazla olabilir) |
| `rules[].host` | Alan adı (boşsa her alan adı). `*.magaza.local` gibi joker karakter olabilir |
| `pathType: Prefix` | `/siparis` ile başlayan her yol (`/siparis/42` dahil, `/siparisler` hariç: öğe bazlı eşleşme) |
| `pathType: Exact` | Sadece tam yol |
| `backend.service` | Hedef Service ve port |

Dikkat: Uygulamaya giden yol **değişmez**: `/siparis/42` isteği Pod'a `/siparis/42` olarak gider (whoami çıktısındaki `GET /siparis` satırı). Linux kursundaki nginx `proxy_pass` sondaki `/` farkı burada yok. Öneki atmak gibi işlemler Ingress'te standart değildir, her denetleyici kendi annotation'ı ya da ek nesnesiyle yapar (Traefik'te `Middleware`). Bu taşınabilirlik sorunu, Gateway API'nin ortaya çıkış sebeplerinden biri.

## Gateway API

```bash
cat > gateway.yaml <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ana-giris
spec:
  gatewayClassName: traefik
  listeners:
    - name: http
      protocol: HTTP
      port: 8000            # Traefik'te listener portu, Traefik'in "web" giriş noktasının konteyner portu olmalı
      allowedRoutes:
        namespaces: { from: Same }
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
spec:
  parentRefs:
    - name: ana-giris
  hostnames: ["api.local"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /v1/siparis }
      filters:
        - type: URLRewrite
          urlRewrite:
            path: { type: ReplacePrefixMatch, replacePrefixMatch: / }
      backendRefs:
        - name: siparis
          port: 80
    - matches:
        - headers:
            - name: X-Kanal
              value: beta
      backendRefs:
        - name: odeme
          port: 80
    - backendRefs:
        - name: siparis
          port: 80
          weight: 90
        - name: odeme
          port: 80
          weight: 10
EOF
kubectl apply -f gateway.yaml
sleep 5
kubectl get gateway,httproute
kubectl describe httproute api | grep -A8 'Status:' | head -12
```

Üç kural:

1. `/v1/siparis` öneki **standart bir filtreyle** kaldırılıp `siparis`'e gönderiliyor.
2. `X-Kanal: beta` başlığı olan istekler `odeme`'ye.
3. Geri kalanlar **ağırlıklı**: %90 `siparis`, %10 `odeme`. Deployment dersindeki canary, ek araç olmadan.

```bash
curl -s -H 'Host: api.local' localhost:30080/v1/siparis/42 | grep -E 'GET|Hostname'
curl -s -H 'Host: api.local' -H 'X-Kanal: beta' localhost:30080/ | grep Hostname
for i in $(seq 1 50); do curl -s -H 'Host: api.local' localhost:30080/ | grep Hostname | cut -d- -f1; done | sort | uniq -c
```

İlk istek uygulamaya `GET /42` olarak ulaştı (önek kaldırıldı). Son döngüde yaklaşık 45/5 dağılım.

### Rol ayrımı

Gateway API'nin tasarımındaki en önemli fikir sorumlulukların ayrılması:

```text
 GatewayClass   ← altyapı sağlayıcısı (hangi denetleyici)
     │
 Gateway        ← platform ekibi: dinlenecek portlar, TLS sertifikaları, hangi namespace'lerin rota bağlayabileceği
     │
 HTTPRoute(lar) ← uygulama ekipleri, kendi namespace'lerinde: kendi alan adı ve yolları
```

`allowedRoutes.namespaces.from` (`Same`, `All`, ya da etiket seçicili `Selector`), hangi namespace'lerdeki rotaların bu Gateway'e bağlanabileceğini belirler. Ingress'te herkes aynı alan adına rota yazabildiği için ekipler birbirinin trafiğini kazara ele geçirebilir.

## TLS: cert-manager

**cert-manager**, sertifikaları Kubernetes nesneleri olarak yönetir: Let's Encrypt (ACME), şirket içi CA, Vault gibi kaynaklardan sertifika alır, Secret'a yazar ve süresi dolmadan **otomatik yeniler**. Linux kursundaki certbot + deploy hook düzeninin küme içi karşılığı.

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=120s
```

Lab'da gerçek bir alan adımız olmadığı için kendinden imzalı bir CA kuralım (gerçek kümede aşağıdaki Let's Encrypt örneği):

```bash
cat > issuer.yaml <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: kendinden-imzali }
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: lab-ca, namespace: cert-manager }
spec:
  isCA: true
  commonName: lab-ca
  secretName: lab-ca
  issuerRef: { name: kendinden-imzali, kind: ClusterIssuer }
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: lab-ca }
spec:
  ca: { secretName: lab-ca }
EOF
kubectl apply -f issuer.yaml
sleep 10; kubectl get clusterissuer
```

Ingress'e TLS ekle. `cert-manager.io/cluster-issuer` annotation'ı sayesinde cert-manager sertifikayı kendisi oluşturur:

```bash
cat > ingress-tls.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: magaza-tls
  annotations:
    cert-manager.io/cluster-issuer: lab-ca
spec:
  ingressClassName: traefik
  tls:
    - hosts: [guvenli.local]
      secretName: guvenli-local-tls
  rules:
    - host: guvenli.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: siparis, port: { number: 80 } } }
EOF
kubectl apply -f ingress-tls.yaml
sleep 15
kubectl get certificate
kubectl get secret guvenli-local-tls -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject -issuer -enddate -ext subjectAltName
curl -sk --resolve guvenli.local:30443:127.0.0.1 https://guvenli.local:30443/ | grep Hostname
```

cert-manager bir `Certificate` nesnesi oluşturdu, CA'dan imzalı sertifikayı aldı ve `guvenli-local-tls` Secret'ına yazdı. Traefik o Secret'ı okuyup HTTPS sundu. Sertifika süresinin üçte biri kalınca cert-manager yeniler, Traefik yeni Secret'ı otomatik yükler: Linux kursundaki "nginx'i yeniden yüklemeyi unuttuk" sorunu yok.

Gerçek bir alan adıyla Let's Encrypt:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@ornek.com
    privateKeySecretRef: { name: letsencrypt-hesap }
    solvers:
      - http01:
          ingress: { ingressClassName: traefik }
```

Denemelerde önce staging sunucusunu (`https://acme-staging-v02.api.letsencrypt.org/directory`) kullan (Linux kursundaki hız sınırları). Wildcard sertifikalar için `dns01` çözücüsü ve DNS sağlayıcısının API anahtarı gerekir.

Sorun gidermede zincir: `kubectl describe certificate` → `certificaterequest` → `order` → `challenge`. Takılan sertifikaların sebebi genelde `challenge` nesnesinin olaylarındadır (80 portu erişilemiyor, DNS yanlış yeri gösteriyor).

## Temizlik

```bash
kubectl delete -f ingress.yaml -f ingress-tls.yaml -f gateway.yaml
kubectl delete deploy siparis odeme; kubectl delete svc siparis odeme
```

Traefik ve cert-manager'ı bir sonraki derslerde kullanmak istersen bırakabilirsin.

## Alıştırma (lab'da)

1. `whoami` imajıyla `v1` ve `v2` adında iki Deployment ve Service oluştur. Bir HTTPRoute ile `app.local` için trafiğin %80'ini `v1`'e, %20'sini `v2`'ye gönder, 100 istekle dağılımı doğrula. Sonra ağırlıkları 0/100 yaparak geçişi tamamla.
2. Ingress ile `/eski` yoluna gelen istekleri `siparis` Service'ine gönder. Uygulamaya hangi yol ulaşıyor? Gateway API'de aynı isteğin uygulamaya `/` olarak ulaşmasını sağla.

<details><summary>Çözüm</summary>

```bash
for v in v1 v2; do kubectl create deployment $v --image=traefik/whoami:v1.10; kubectl expose deployment $v --port=80; done
cat > canary.yaml <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: canary }
spec:
  parentRefs: [{ name: ana-giris }]
  hostnames: ["app.local"]
  rules:
    - backendRefs:
        - { name: v1, port: 80, weight: 80 }
        - { name: v2, port: 80, weight: 20 }
EOF
kubectl apply -f gateway.yaml -f canary.yaml; sleep 5
for i in $(seq 1 100); do curl -s -H 'Host: app.local' localhost:30080/ | grep Hostname | cut -d' ' -f2 | cut -d- -f1; done | sort | uniq -c
sed -i 's/weight: 80/weight: 0/; s/weight: 20/weight: 100/' canary.yaml && kubectl apply -f canary.yaml; sleep 3
for i in $(seq 1 20); do curl -s -H 'Host: app.local' localhost:30080/ | grep Hostname | cut -d' ' -f2 | cut -d- -f1; done | sort | uniq -c
```

2: Ingress ile uygulamaya `/eski` ulaşır. Gateway API'de `URLRewrite` filtresi ve `ReplacePrefixMatch: /` ile `/` olarak ulaşır (derste `/v1/siparis` için yaptığımız gibi).

</details>

```quiz
Kümede Ingress nesnesi oluşturdun ama hiçbir şey olmuyor, ADDRESS boş. En olası sebep?
- Service yanlış
- [x] Kurulu bir Ingress denetleyicisi yok ya da `ingressClassName` hiçbir denetleyiciyle eşleşmiyor
- DNS ayarlanmamış
? Ingress sadece bir tanımdır. Trafiği işleyen denetleyicidir.
```

```quiz
Trafiğin %10'unu yeni sürüme göndermenin taşınabilir yolu?
- Ingress annotation'ı
- [x] Gateway API HTTPRoute'unda `backendRefs` ağırlıkları
- NodePort
? Ağırlıklı yönlendirme Gateway API'nin standart parçasıdır. Ingress'te denetleyiciye özgüdür.
```

```quiz
cert-manager ile alınan sertifika yenilendiğinde ne yapmak gerekir?
- Ingress denetleyicisini yeniden başlatmak
- [x] Hiçbir şey: cert-manager Secret'ı günceller, denetleyici yeni sertifikayı otomatik yükler
- Certificate nesnesini silip yeniden oluşturmak
? Yenileme ve dağıtım otomatiktir. Takılan sertifikalar için describe certificate → challenge zinciri.
```

## Özet

- Ingress (dondurulmuş, annotation'lar) ve Gateway API (yeni standart, ağırlık, başlık eşleme, URL yeniden yazma, rol ayrımı). İkisi de bir denetleyici ister.
- ingress-nginx emekliye ayrıldı: Traefik, Envoy Gateway, Cilium, NGINX Gateway Fabric gibi alternatifler.
- Ingress: `ingressClassName`, `host`, `pathType`, backend Service. Yol değiştirilmeden iletilir.
- Gateway → HTTPRoute: `parentRefs`, `hostnames`, `matches`, `filters`, `backendRefs.weight`.
- cert-manager: Issuer/ClusterIssuer, Certificate (ya da Ingress annotation'ı), otomatik yenileme. Sorun: certificate → order → challenge.
