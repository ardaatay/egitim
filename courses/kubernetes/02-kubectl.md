# kubectl, kubeconfig, namespace ve YAML

`kubectl` Kubernetes'le çalışırken zamanının çoğunu geçireceğin araç. Bu derste hangi kümeye nasıl bağlandığını (kubeconfig), kaynakları nasıl gruplandırdığını (namespace), nesneleri YAML ile nasıl tanımladığını ve günlük işlerde en çok kullanılan `kubectl` kalıplarını göreceğiz. Amacın, ezberlemek değil, bir şeyi nasıl bulacağını bilmek: `kubectl explain`, `--dry-run` ve `-o jsonpath` bunun anahtarı.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## kubeconfig: hangi kümeye, kim olarak?

`kubectl` bağlantı bilgisini `~/.kube/config` dosyasından (ya da `KUBECONFIG` ortam değişkenindeki dosyalardan) okur:

```bash
kubectl config view
```

Dosyanın üç listesi var:

| Bölüm | İçerik |
|---|---|
| `clusters` | API sunucusunun adresi ve CA sertifikası |
| `users` | Kimlik: istemci sertifikası, token ya da bir komut (bulut CLI'ları kısa ömürlü token üretir) |
| `contexts` | Bir **küme + kullanıcı + varsayılan namespace** üçlüsü |

`current-context`, kubectl'in şu an hangi context'i kullandığını belirtir.

```bash
kubectl config get-contexts
kubectl config current-context
kubectl config set-context --current --namespace=kube-system
kubectl get pods            # artık kube-system'deki Pod'lar
kubectl config set-context --current --namespace=default
```

Birden fazla kümen olduğunda (staging, üretim) dosyaları birleştirebilirsin:

```text
export KUBECONFIG=~/.kube/config:~/.kube/uretim.yaml
kubectl config use-context uretim
```

> **Dikkat:** En pahalı Kubernetes hatalarından biri, yanlış context'te komut çalıştırmaktır: staging'i sanıp üretimde `kubectl delete`. Kabuk isteminde aktif context'i ve namespace'i gösteren bir araç (kube-ps1, starship) kullan, üretim context'ine geçişi zahmetli yap (ayrı bir kubeconfig dosyası, ayrı bir terminal profili). `kubectx` ve `kubens` araçları context ve namespace değiştirmeyi hızlandırır.

kubeconfig dosyası küme yöneticisi sertifikası içerebilir, yani kümenin **tam yetkili anahtarıdır**. İzinleri `600` olmalı ve hiçbir depoya girmemeli.

## Namespace'ler

Namespace, bir kümedeki kaynakları mantıksal olarak gruplar: takımlar, uygulamalar ya da ortamlar için. Aynı ad farklı namespace'lerde kullanılabilir, yetkiler (RBAC) ve kotalar namespace bazında verilir.

```bash
kubectl get namespaces
kubectl create namespace siparis
kubectl get pods -n kube-system
kubectl get pods -A | head
```

| Hazır namespace | İçerik |
|---|---|
| `default` | Namespace belirtilmeyen kaynaklar. Üretimde kullanılmamalı |
| `kube-system` | Kubernetes'in kendi bileşenleri |
| `kube-public` | Herkesin (kimlik doğrulamasız da) okuyabileceği az sayıda bilgi |
| `kube-node-lease` | Node'ların "hayattayım" sinyalleri (Lease nesneleri) |

Her kaynak namespace'li değildir:

```bash
kubectl api-resources --namespaced=true | head -8
kubectl api-resources --namespaced=false | head -12
```

Pod, Deployment, Service, ConfigMap, Secret namespace'li. Node, PersistentVolume, StorageClass, Namespace'in kendisi ve ClusterRole küme genelinde.

> Namespace bir **güvenlik sınırı değildir**. Farklı namespace'lerdeki Pod'lar varsayılan olarak birbirine ağ üzerinden ulaşabilir (NetworkPolicy dersi) ve aynı node'larda çalışır. İzolasyon için RBAC, NetworkPolicy ve Pod güvenlik ayarları birlikte kullanılır.

## YAML manifest'leri

Her Kubernetes nesnesi aynı iskelete sahiptir:

```yaml
apiVersion: apps/v1          # API grubu ve sürümü (kubectl api-resources'taki APIVERSION)
kind: Deployment             # nesne türü
metadata:
  name: web                  # namespace içinde benzersiz
  namespace: siparis
  labels:                    # seçim ve gruplama için: kısa anahtar-değer
    app: web
    takim: odeme
  annotations:               # araçlar ve insanlar için ek bilgi, seçimde kullanılmaz
    aciklama: "sipariş API'sinin önündeki nginx"
spec:                        # türüne özgü istenen durum
  ...
```

**Etiket (label)** ile **annotation** farkı önemli: Etiketler seçiciler (selector) tarafından kullanılır. Service hangi Pod'lara trafik göndereceğini, Deployment hangi Pod'ların kendisine ait olduğunu etiketlerle bulur. Annotation'lar ise seçilmez: değişiklik nedeni, sahip bilgisi, araçların ayarları (Ingress denetleyicisi ayarları, Prometheus kazıma ayarları) için.

### YAML'ı ezberleme, üret

Her alanı ezberlemek yerine iki araç kullanılır:

**1. `--dry-run=client -o yaml`**: Bir nesneyi kısa komutla oluşturuyormuş gibi yap, ama oluşturmak yerine YAML'ını yazdır:

```bash
kubectl create deployment web --image=nginx:1.27-alpine --replicas=2 -n siparis --dry-run=client -o yaml > web.yaml
kubectl create service clusterip web --tcp=80:80 -n siparis --dry-run=client -o yaml > web-svc.yaml
kubectl create configmap ayar --from-literal=LOG_LEVEL=info --dry-run=client -o yaml
cat web.yaml
```

Bu bir başlangıç iskeletidir: düzenleyip eksik alanları eklersin.

**2. `kubectl explain`**: Her alanın anlamı ve türü:

```bash
kubectl explain deployment.spec
kubectl explain pod.spec.containers.resources
kubectl explain deployment --recursive | head -40
```

### Bildirimsel çalışma: apply

```bash
{ cat web.yaml; echo "---"; cat web-svc.yaml; } > uygulama.yaml
kubectl apply -f uygulama.yaml
kubectl get deploy,svc,pods -n siparis
```

Birden fazla nesne tek dosyada `---` ile ayrılır. `kubectl apply -f klasor/` bir klasördeki bütün dosyaları uygular.

**İmperatif** (`create`, `run`, `scale`, `set image`) komutlar hızlıdır ama kayıt bırakmaz. **Bildirimsel** (`apply -f`) yöntemde istenen durum dosyalarda, dosyalar git'te durur: kim neyi ne zaman değiştirdi görünür, aynı ortam yeniden kurulabilir. Üretimde her zaman bildirimsel çalış. İmperatif komutları keşif, hata ayıklama ve YAML üretmek için kullan.

`apply` tekrarlanabilir (idempotent): Dosyayı değiştirip tekrar `apply` edersin, Kubernetes sadece farkı uygular. Uygulamadan önce farkı görmek için:

```bash
sed -i 's/replicas: 2/replicas: 3/' uygulama.yaml
kubectl diff -f uygulama.yaml
kubectl apply -f uygulama.yaml
```

> `kubectl apply --server-side` (server-side apply) alan sahipliğini API sunucusunda takip eder: hangi alanı hangi aracın (kubectl, Helm, bir denetleyici) yönettiği bilinir ve çakışmalar açıkça raporlanır. Birden fazla aracın aynı nesneye dokunduğu ortamlarda tercih edilir.

## Bilgi almak

### get

```bash
kubectl get pods -n siparis
kubectl get pods -n siparis -o wide
kubectl get pods -n siparis --show-labels
kubectl get pods -n siparis -l app=web
kubectl get pods -A --field-selector=status.phase!=Running
kubectl get pods -n kube-system --sort-by=.metadata.creationTimestamp
kubectl get all -n siparis
```

| Seçenek | İşlev |
|---|---|
| `-o wide` | Ek sütunlar: IP, node |
| `-o yaml` / `-o json` | Nesnenin tamamı (spec + status) |
| `-l anahtar=değer` | Etiket seçici (`-l 'app in (web,api)'`, `-l '!canary'`) |
| `--field-selector` | Alan seçici: `status.phase`, `spec.nodeName`, `metadata.name` |
| `-A` | Bütün namespace'ler |
| `-w` | Değişiklikleri izle |

`get all` aslında "hepsi" değildir: ConfigMap, Secret, Ingress, PVC gibi pek çok türü içermez.

### Çıktıyı biçimlendirmek: jsonpath ve custom-columns

Betiklerde ve hızlı sorgularda çok kullanılır:

```bash
kubectl get pods -n siparis -o jsonpath='{.items[*].metadata.name}{"\n"}'
kubectl get pods -n siparis -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\t"}{.status.podIP}{"\n"}{end}'
kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}{"\n"}'
kubectl get pods -A -o custom-columns='NS:.metadata.namespace,AD:.metadata.name,IMAJ:.spec.containers[*].image' | head
```

Daha karmaşık sorgular için `-o json | jq` de kullanılabilir. Bir alanın yolunu bulmak için önce `-o yaml` ile nesneye bakmak en kolayı.

### describe ve events

```bash
kubectl describe deployment web -n siparis | tail -15
kubectl describe pod -n siparis -l app=web | grep -A10 Events
kubectl get events -n siparis --sort-by=.lastTimestamp | tail
```

`describe`, nesneyi ve onunla ilgili **olayları** (events) okunur bir biçimde birleştirir. Bir şey çalışmadığında ilk bakılacak yer, çıktının en altındaki `Events` bölümüdür. Olaylar varsayılan olarak yaklaşık bir saat tutulur.

## Konteynerlerle çalışmak

```bash
P=$(kubectl get pod -n siparis -l app=web -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n siparis $P
kubectl logs -n siparis -l app=web --tail=5 --prefix
kubectl exec -n siparis $P -- nginx -v
kubectl exec -it -n siparis $P -- sh -c 'hostname; cat /etc/os-release | head -1'
kubectl cp -n siparis $P:/etc/nginx/conf.d/default.conf ./default.conf && head -5 default.conf
```

| Komut | Not |
|---|---|
| `logs -f` | Canlı takip |
| `logs --previous` | Konteyner yeniden başladıysa **önceki** örneğin logları. Çöken konteynerin son sözleri burada |
| `logs -c ad` | Pod'da birden fazla konteyner varsa hangisi |
| `logs -l app=web --prefix` | Etiketle seçilen bütün Pod'lar |
| `exec ... -- komut` | `--` sonrası konteynerde çalışacak komut |

### port-forward

Bir Pod'a ya da Service'e, dışa açmadan kendi makinenden erişmek için:

```bash
kubectl port-forward -n siparis svc/web 8080:80 >/dev/null 2>&1 &
sleep 2; curl -s localhost:8080 | head -4; kill %1
```

`port-forward` trafiği API sunucusu üzerinden tünellenir. Hata ayıklama ve veritabanına geçici erişim için idealdir, üretim trafiği için değil.

## Değiştirmek

```bash
kubectl scale deployment web -n siparis --replicas=1
kubectl set image deployment/web nginx=nginx:1.27.3-alpine -n siparis
kubectl label deployment web -n siparis surum=1.27
kubectl annotate deployment web -n siparis kubernetes.io/change-cause="nginx 1.27.3'e geçiş"
kubectl patch deployment web -n siparis -p '{"spec":{"replicas":2}}'
kubectl edit deployment web -n siparis
```

Bu imperatif değişiklikler canlı nesneyi değiştirir ama YAML dosyanı **değiştirmez**. Bir sonraki `apply -f uygulama.yaml` onları geri alır. Acil durumda yapılan imperatif bir değişikliği her zaman dosyaya da yansıt.

## Silmek

```bash
kubectl delete -f uygulama.yaml
kubectl delete namespace siparis
```

Namespace silmek içindeki her şeyi siler. Silme işlemi asenkrondur: Pod'lara SIGTERM gönderilir ve `terminationGracePeriodSeconds` (varsayılan 30 sn) beklenir (Docker kursundaki `stop` mantığı). Bir nesne `Terminating`'de takılı kalıyorsa genelde bir **finalizer** onu tutuyordur: bir denetleyici, nesne silinmeden önce yapması gereken temizliği henüz yapmamıştır.

## Verimlilik

```bash
source <(kubectl completion bash)
alias k=kubectl
complete -o default -F __start_kubectl k
k get po -n kube-system
```

Kısa adlar: `po` (pods), `deploy`, `rs`, `svc`, `cm` (configmap), `ns`, `no` (nodes), `pv`, `pvc`, `ing`, `sa`. Tam liste `kubectl api-resources`'ta. `krew` eklenti yöneticisiyle `kubectl` yeni komutlar kazanır (`kubectl tree`, `kubectl neat`, `kubectl ctx`).

## Alıştırma (lab'da)

1. `egitim` namespace'ini oluştur ve context'inin varsayılan namespace'ini ona çevir.
2. `--dry-run=client -o yaml` ile `redis:7-alpine` imajlı, 2 replikalı `cache` adında bir Deployment manifest'i üret, `takim: platform` etiketini ekleyip `apply` et.
3. `cache` Pod'larının adlarını, çalıştıkları node'u ve IP'lerini tek bir `kubectl` komutuyla tablo olarak yazdır.
4. Pod'lardan birinin içinde `redis-cli ping` çalıştır.
5. Context'ini `default`'a geri al ve namespace'i sil.

<details><summary>Çözüm</summary>

```bash
kubectl create namespace egitim
kubectl config set-context --current --namespace=egitim

kubectl create deployment cache --image=redis:7-alpine --replicas=2 --dry-run=client -o yaml > cache.yaml
sed -i '0,/    app: cache/s//    app: cache\n    takim: platform/' cache.yaml
kubectl apply -f cache.yaml
kubectl get deploy cache --show-labels

kubectl get pods -l app=cache -o custom-columns='AD:.metadata.name,NODE:.spec.nodeName,IP:.status.podIP'

kubectl exec $(kubectl get pod -l app=cache -o name | head -1) -- redis-cli ping

kubectl config set-context --current --namespace=default
kubectl delete namespace egitim
```

`sed` satırı, Deployment'ın `metadata.labels` bölümündeki ilk `app: cache` satırının altına yeni etiketi ekler. YAML'ı bir düzenleyicide açıp elle eklemek de olur.

</details>

```quiz
Etiket (label) ile annotation arasındaki temel fark nedir?
- Etiketler daha uzun olabilir
- [x] Etiketler seçiciler tarafından kullanılır (Service, Deployment), annotation'lar seçimde kullanılmaz
- Annotation'lar sadece Pod'larda olur
? Nesneleri birbirine bağlayan şey etiketler ve seçicilerdir. Annotation'lar araçlar ve insanlar için ek bilgidir.
```

```quiz
Konteyner sürekli yeniden başlıyor ve `kubectl logs` sadece yeni başlamış örneğin açılış satırlarını gösteriyor. Çökme sebebini nasıl görürsün?
- `kubectl describe node`
- [x] `kubectl logs --previous`
- `kubectl get events -A`
? `--previous`, bir önceki konteyner örneğinin loglarını gösterir.
```

```quiz
Acil durumda `kubectl edit` ile replika sayısını 10 yaptın. Ertesi gün biri aynı dosyayla `kubectl apply -f` çalıştırdı. Ne olur?
- Değişiklik korunur
- [x] Replika sayısı dosyadaki değere geri döner
- apply hata verir
? İstenen durumun kaynağı dosyadır. İmperatif değişiklikler dosyaya yansıtılmalı.
```

## Özet

- kubeconfig = clusters + users + contexts. Aktif context'e dikkat, dosya `600` ve gizli.
- Namespace mantıksal gruplama, güvenlik sınırı değil. Bazı kaynaklar küme geneli.
- Manifest: `apiVersion`, `kind`, `metadata` (labels, annotations), `spec`. YAML'ı `--dry-run=client -o yaml` ile üret, `explain` ile öğren.
- Üretimde bildirimsel: `apply -f`, `diff`. İmperatif değişiklikleri dosyaya yansıt.
- `get -o wide/yaml/jsonpath/custom-columns`, `-l`, `--field-selector`, `describe` + Events.
- `logs --previous/-c/-l`, `exec -it -- sh`, `port-forward`, `cp`.
