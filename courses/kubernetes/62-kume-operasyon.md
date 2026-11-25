# kubeadm, sürüm yükseltme, etcd yedeği, yönetilen kümeler

Kursun son dersi kümenin kendisi hakkında: Nasıl kurulur, nasıl güncel tutulur, kaybedildiğinde nasıl geri getirilir ve bütün bu yükü ne zaman bir bulut sağlayıcısına bırakmak mantıklıdır. Lab kümesi kubeadm ile kurulduğu için bu işlemlerin çoğunu doğrudan üzerinde görebiliriz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
Bu dersteki etcd geri yükleme ve yükseltme adımları kümeyi değiştirir. Lab ortamında rahatça dene, oturum bitince her şey sıfırlanır.
```

## kubeadm ile kurulum: neler oluyor?

`kubeadm init`, Linux kursunda öğrendiğin parçaları birleştirir:

```text
1. Ön kontroller: swap kapalı mı, çekirdek modülleri (overlay, br_netfilter), sysctl (ip_forward), konteyner çalışma zamanı
2. Sertifikalar: /etc/kubernetes/pki altında küme CA'sı ve her bileşenin sertifikaları
3. kubeconfig dosyaları: admin.conf, kubelet.conf, controller-manager.conf, scheduler.conf
4. Statik Pod manifest'leri: /etc/kubernetes/manifests (apiserver, etcd, scheduler, controller-manager)
5. kubelet bu manifest'leri görüp control plane'i başlatır
6. CoreDNS ve kube-proxy eklentileri kurulur
7. Node'ların katılması için bir token üretilir
```

Sonra bir CNI eklentisi kurulur (ağ eklentisi olmadan node'lar `NotReady` kalır) ve diğer node'lar `kubeadm join` ile katılır.

```bash
ls /etc/kubernetes/ /etc/kubernetes/pki/ | head -30
kubeadm certs check-expiration
kubeadm token list
kubeadm token create --print-join-command
```

### Sertifikaların süresi

kubeadm'in ürettiği bileşen sertifikaları **1 yıl** geçerlidir (CA 10 yıl). Süresi dolarsa API sunucusuna erişim kesilir. kubeadm, her **sürüm yükseltmesinde** sertifikaları otomatik yeniler: Kümeyi düzenli yükselten biri bu sorunu hiç yaşamaz. Yükseltilmeyen bir kümede:

```bash
kubeadm certs renew all --help | head -5
# kubeadm certs renew all   → sonra control plane statik Pod'larını yeniden başlat
```

Linux kursundaki "sertifika süresi takibi" ilkesi burada da geçerli: `kubeadm certs check-expiration` çıktısını bir izleme sistemine bağla.

## etcd yedeği

etcd kümenin tek doğruluk kaynağı: Bütün nesneler, Secret'lar, RBAC kuralları orada. Kaybedilirse küme yeniden kurulmalıdır. Yedek almak:

```bash
ETCDCTL_API=3 command -v etcdctl >/dev/null || { V=v3.5.16; curl -sL https://github.com/etcd-io/etcd/releases/download/$V/etcd-$V-linux-amd64.tar.gz | tar xz -C /tmp && cp /tmp/etcd-$V-linux-amd64/etcdctl /usr/local/bin/; }
grep -E 'listen-client-urls|cert-file|key-file|trusted-ca-file' /etc/kubernetes/manifests/etcd.yaml

export ETCDCTL_API=3
E="--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key"
etcdctl $E endpoint health
etcdctl $E snapshot save /opt/etcd-yedek.db
ls -lh /opt/etcd-yedek.db
etcdctl --write-out=table snapshot status /opt/etcd-yedek.db 2>/dev/null || etcdutl --write-out=table snapshot status /opt/etcd-yedek.db
```

Yedek dosyası **bütün Secret'ları** içerir (etcd şifrelemesi yoksa düz olarak). Şifreli ve erişimi kısıtlı bir yerde saklanmalı, düzenli alınmalı (Linux kursundaki systemd timer ya da bir CronJob) ve **geri yüklemesi denenmiş** olmalıdır. Test edilmemiş yedek, yedek değildir.

### Geri yükleme

Yedekten sonra bir değişiklik yapıp sonra yedeğe dönelim:

```bash
kubectl create namespace yedekten-sonra
kubectl get ns | grep yedekten

etcdutl snapshot restore /opt/etcd-yedek.db --data-dir /var/lib/etcd-geri 2>/dev/null || etcdctl snapshot restore /opt/etcd-yedek.db --data-dir /var/lib/etcd-geri
ls /var/lib/etcd-geri
```

Şimdi etcd statik Pod'unu yeni veri klasörüne çevir. Manifest'teki `hostPath` yolunu değiştirmek yeterli: kubelet değişikliği görüp etcd'yi yeniden başlatır.

```bash
cp /etc/kubernetes/manifests/etcd.yaml /root/etcd.yaml.yedek
sed -i 's#path: /var/lib/etcd$#path: /var/lib/etcd-geri#' /etc/kubernetes/manifests/etcd.yaml
grep -A1 'hostPath' /etc/kubernetes/manifests/etcd.yaml | grep path
sleep 60
kubectl get ns | grep yedekten || echo "yedekten sonra oluşturulan namespace yok: küme yedek anına döndü"
kubectl get nodes
```

API sunucusu etcd yeniden başlarken bir süre cevap vermeyebilir. Küme, yedeğin alındığı ana döndü.

Gerçek bir felakette (birden fazla control plane node'u olan kümelerde) geri yükleme her etcd üyesinde, yeni bir küme kimliğiyle yapılır ve daha dikkatli bir prosedür gerektirir. Yönetilen kümelerde etcd'yi sağlayıcı yedekler ve sen etcd'ye hiç erişmezsin.

### Nesne seviyesinde yedek: Velero

etcd anlık görüntüsü kümenin **tamamını** geri getirir. "Sadece `odeme` namespace'ini dünkü hâline döndür" ya da "kümeyi başka bir bölgeye taşı" için **Velero** kullanılır: Kubernetes nesnelerini (API üzerinden) ve PersistentVolume'leri (snapshot ya da dosya kopyalama ile) bir nesne deposuna (S3) yedekler, namespace ya da etiket bazında geri yükler. GitOps ile çalışan ekiplerde nesnelerin kendisi zaten git'tedir, Velero'nun asıl değeri **PV verileridir**.

## Sürüm yükseltme

Kubernetes yılda üç ana sürüm çıkarır ve her sürümü yaklaşık **14 ay** destekler. Bir küme bir yıldan fazla yükseltilmezse desteklenmeyen bir sürümde (güvenlik yaması yok) kalır. Yükseltme bu yüzden düzenli ve sıkıcı bir rutin olmalı.

Kurallar:

- **Birer ana sürüm** atlanır: 1.30 → 1.31 → 1.32. İki sürüm birden atlanamaz.
- Önce **control plane**, sonra **node'lar**. kubelet, API sunucusundan en fazla üç ana sürüm eski olabilir, asla daha yeni olamaz.
- Önce **sürüm notlarını** oku: Kaldırılan API'ler (deprecated API removals) en sık sorun kaynağı. Eski bir API sürümüyle yazılmış manifest'ler (`extensions/v1beta1` Ingress, `policy/v1beta1` PDB gibi tarihî örnekler) yeni sürümde reddedilir. `kubent` (kube-no-trouble) ya da `pluto` kümede ve manifest'lerde kaldırılacak API kullanımını bulur.
- Eklentiler (CNI, Ingress denetleyicisi, cert-manager, operatörler) yeni sürümle uyumlu mu? Uyumluluk tablolarına bak.

kubeadm akışı (lab'da paket deposu yapılandırmasına göre adımlar değişebilir, burada akışı ve kontrol komutlarını görüyoruz):

```bash
kubectl version
kubeadm version -o short
kubeadm upgrade plan 2>&1 | tail -25
```

`upgrade plan`, mevcut sürümü, yükseltilebilecek sürümü ve hangi bileşenlerin yükseltileceğini gösterir. Tam akış:

```text
# --- control plane node'u ---
1. kubeadm paketini hedef sürüme yükselt           (apt-mark unhold kubeadm && apt-get install kubeadm=1.32.x-* && apt-mark hold kubeadm)
2. kubeadm upgrade plan                            # kontrol
3. kubeadm upgrade apply v1.32.x                   # control plane bileşenleri + sertifika yenileme
4. kubectl drain controlplane --ignore-daemonsets  # node'u boşalt (PDB'ler burada devreye girer)
5. kubelet ve kubectl paketlerini yükselt, systemctl daemon-reload && systemctl restart kubelet
6. kubectl uncordon controlplane

# --- her worker node için, birer birer ---
7. kubeadm paketini yükselt, sonra: kubeadm upgrade node
8. kubectl drain node01 --ignore-daemonsets --delete-emptydir-data
9. kubelet'i yükselt ve yeniden başlat
10. kubectl uncordon node01
```

Ölçekleme dersindeki **PodDisruptionBudget**'lar ve zamanlama dersindeki **topoloji yayılımı** tam bu adımlar için vardır: Node'lar birer birer boşaltılırken uygulamalar ayakta kalır. Tek replikalı uygulamalar ve `minAvailable: 1` PDB'leri `drain`'i kilitler.

Pratik bir yaklaşım, mevcut node'ları yerinde yükseltmek yerine **yeni sürümle yeni node'lar** açıp eskileri boşaltarak kapatmaktır (immutable node'lar). Bulut kümelerinde ve Karpenter gibi araçlarla standart yöntem budur.

## Yönetilen kümeler

| | Kendi kurduğun (kubeadm, k3s, RKE2, Talos) | Yönetilen (EKS, GKE, AKS, DigitalOcean, Hetzner...) |
|---|---|---|
| Control plane | Sen işletirsin: etcd, yedek, yüksek erişilebilirlik, sertifikalar | Sağlayıcı işletir (genelde küçük bir saatlik ücretle) |
| Yükseltme | Sen, adım adım | Tek tık ya da otomatik (node'lar için yine planlama gerekir) |
| Entegrasyon | LoadBalancer, depolama, kimlik için ek araçlar (MetalLB, Longhorn) | Bulutun yük dengeleyicisi, diskleri, IAM'i hazır |
| Maliyet | Donanım + iş gücü | Bulut faturası |
| Kontrol | Tam | Sağlayıcının izin verdiği kadar |

Çoğu ekip için **yönetilen küme** doğru başlangıçtır: Control plane'i işletmek uzmanlık ve zaman ister, ve bu iş genelde ürüne değer katmaz. Kendi donanımında çalışman gerektiğinde (veri yerelliği, maliyet, uç konumlar) kubeadm yerine işletimi daha kolay dağıtımlar (k3s, RKE2, Talos Linux) değerlendirilebilir.

Yönetilen kümede bile senin sorumluluğunda kalanlar: Node'ların yükseltilmesi ve boyutlandırılması, eklentiler (CNI ayarları, Ingress/Gateway denetleyicisi, cert-manager, izleme), RBAC ve kimlik entegrasyonu, NetworkPolicy, Pod güvenliği, yedekleme (Velero), maliyet takibi. Bu kursun büyük kısmı bu sorumluluklar üzerineydi.

## Kursun sonu

| Bölüm | Kazanım |
|---|---|
| Temeller | Mimari ve uzlaştırma döngüsü, kubectl, Pod'un yaşamı |
| İş yükleri ve servisler | Deployment ve rollout, Service ve DNS, yapılandırma, probe'lar ve kaynaklar |
| Durumlu iş yükleri | PV/PVC/StorageClass, StatefulSet, DaemonSet, Job, CronJob |
| Dışa açma ve ağ | Ingress ve Gateway API, cert-manager, NetworkPolicy |
| Paketleme ve dağıtım | Helm, Kustomize, Argo CD ile GitOps |
| Güvenlik, ölçekleme, zamanlama | RBAC, Pod güvenliği, HPA ve PDB, affinity ve taint |
| Operasyon | Sorun giderme, gözlemlenebilirlik, kurulum, yükseltme, yedek |

Linux, Docker ve Kubernetes kurslarıyla bir uygulamayı tek bir sunucudaki süreçten çok node'lu, GitOps ile yönetilen, izlenen ve otomatik ölçeklenen bir kümeye kadar götürmenin bütün katmanlarını gördün. Sertifika hedefin varsa bu içerik **CKA** (Certified Kubernetes Administrator) ve **CKAD** (Application Developer) sınavlarının konularının büyük kısmını kapsıyor. Killercoda'nın CKA/CKAD senaryoları iyi bir pratik kaynağı.

## Alıştırma (lab'da)

1. etcd yedeğini bir CronJob'la (control plane node'unda, etcd sertifikalarını `hostPath` ile bağlayarak) her 6 saatte bir `/opt/etcd-yedekleri/` altına zaman damgalı dosya olarak alan bir manifest yaz. Hangi güvenlik riskleri var?
2. `kubeadm upgrade plan` çıktısına göre lab kümesi hangi sürüme yükseltilebilir? Yükseltmeden önce kümede kaldırılmış bir API kullanılıp kullanılmadığını nasıl kontrol edersin?

<details><summary>Cevap</summary>

1: CronJob, control plane'e `nodeSelector` ve control plane taint'ine toleration ile sabitlenir, `hostNetwork: true` ile etcd'nin `127.0.0.1:2379` adresine ulaşır, `/etc/kubernetes/pki/etcd` ve yedek klasörünü `hostPath` ile bağlar ve `etcdctl snapshot save /opt/etcd-yedekleri/etcd-$(date +%F-%H%M).db` çalıştırır. Eski dosyaları silmek için `find -mtime +3 -delete` eklenir.

Riskler: Bu Pod etcd istemci sertifikasına sahip, yani kümenin bütün verisine (Secret'lar dahil) okuma-yazma erişimi var. Çalıştığı namespace'e Pod oluşturma yetkisi olan herkes bu sertifikaya ulaşabilir. Pod Security `restricted` olamaz (hostPath, hostNetwork), bu yüzden ayrı ve erişimi kısıtlı bir namespace gerekir. Yedekler aynı node'da durursa node kaybında yedek de kaybolur: Dosyalar şifrelenip küme dışına (nesne deposu) kopyalanmalı. Yönetilen kümelerde bu işi sağlayıcı yapar.

2: `kubeadm upgrade plan` bir sonraki ara sürümü ve yama sürümünü gösterir. Kaldırılmış API kontrolü için: sürüm notlarındaki "API removals" bölümü, `kubent` ya da `pluto` araçları, ve API sunucusunun kendisinin sunduğu kullanım metriği: `kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis`.

</details>

```quiz
kubeadm ile kurulmuş, bir yıldan fazla yükseltilmemiş bir kümede kubectl aniden "certificate has expired" hatası veriyor. Sebep?
- etcd bozuldu
- [x] Bileşen sertifikaları 1 yıl geçerli, kubeadm onları sadece yükseltmelerde ya da `kubeadm certs renew` ile yeniler
- Node'lar NotReady
? Düzenli yükseltme sertifikaları otomatik yeniler. `kubeadm certs check-expiration` izlenmeli.
```

```quiz
Küme 1.29'da. 1.31'e geçmek istiyorsun. Doğru yol?
- Doğrudan 1.31'e yükseltmek
- [x] Önce 1.30'a, sonra 1.31'e. Her adımda önce control plane, sonra node'lar
- Önce node'ları 1.31'e yükseltmek
? Ana sürümler birer birer atlanır ve kubelet API sunucusundan yeni olamaz.
```

```quiz
etcd yedek dosyası neden hassas bir dosyadır?
- Çok büyüktür
- [x] Kümedeki bütün nesneleri, Secret'lar dahil (şifreleme yoksa düz olarak) içerir
- Sadece root okuyabilir
? Yedekler şifrelenmeli, erişimi kısıtlanmalı, küme dışında saklanmalı ve geri yüklemesi test edilmeli.
```

## Özet

- kubeadm: sertifikalar (`/etc/kubernetes/pki`, 1 yıl), kubeconfig'ler, statik Pod'lar, token ile katılma. CNI olmadan node'lar NotReady.
- etcd: `etcdctl snapshot save` ile yedek, `snapshot restore` + manifest'te yeni veri klasörü ile geri yükleme. Yedekler hassas ve test edilmeli. Nesne/PV seviyesinde Velero.
- Yükseltme: birer ana sürüm, önce control plane sonra node'lar, kaldırılan API'leri önceden kontrol et, drain/uncordon ve PDB'ler.
- Yönetilen kümeler control plane yükünü alır, node'lar, eklentiler, güvenlik ve yedek senin sorumluluğunda kalır.
