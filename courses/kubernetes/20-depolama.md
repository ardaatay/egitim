# PersistentVolume, PVC ve StorageClass

Pod'lar geçicidir: silinir, başka node'a taşınır, yeniden oluşturulur. Konteynerin yazılabilir katmanı ve `emptyDir` Pod'la birlikte gider. Veritabanı, yüklenen dosyalar ya da bir kuyruğun verisi gibi kalıcı olması gereken her şey, Pod'dan **bağımsız yaşayan** bir depolamada durmalıdır. Docker kursunda volume'lerin Swarm'da node'lar arasında taşınmadığını görmüştük. Kubernetes bu sorunu bir soyutlama katmanıyla çözer: **PersistentVolume** (depolamanın kendisi), **PersistentVolumeClaim** (uygulamanın talebi) ve **StorageClass** (talep gelince depolamayı otomatik oluşturan tarif).

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## Volume türleri: geçiciden kalıcıya

| Tür | Ömrü | Kullanım |
|---|---|---|
| `emptyDir` | Pod ile | Konteynerler arası paylaşım, geçici önbellek (Pod dersi) |
| `configMap`, `secret`, `downwardAPI`, `projected` | Pod ile | Yapılandırma dosyaları (önceki ders) |
| `hostPath` | Node ile | Node'daki bir klasör. **Uygulamalar için kullanılmaz**: Pod başka node'a giderse veri orada kalır, ve host dosya sistemine erişim güvenlik riskidir. Log toplayıcı gibi DaemonSet'ler için |
| `persistentVolumeClaim` | **Pod'dan bağımsız** | Kalıcı uygulama verisi |

## Üç nesne

```text
 Uygulama ekibi                         Küme / depolama
 ──────────────                         ────────────────
 Pod ──kullanır──▶ PVC ──bağlanır──▶ PV ──temsil eder──▶ gerçek disk (EBS, Ceph RBD, NFS, yerel disk...)
                    │                 ▲
                    └── storageClassName ──▶ StorageClass ──(dinamik oluşturma)──┘
```

- **PersistentVolume (PV)**: Kümedeki bir depolama parçası (küme genelinde, namespace'siz). Ya bir yönetici elle oluşturur (statik) ya da StorageClass otomatik oluşturur (dinamik).
- **PersistentVolumeClaim (PVC)**: "Bana 10 GiB, tek node'dan okunup yazılabilen, `hizli` sınıfında bir depolama lazım" talebi (namespace'li). Kubernetes uygun bir PV bulur ya da oluşturur ve ikisini **bağlar** (bind).
- **StorageClass**: Hangi sağlayıcının (CSI sürücüsü), hangi parametrelerle (disk tipi, şifreleme, IOPS) disk oluşturacağının tarifi.

Bu ayrım, uygulamayı altyapıdan bağımsız kılar: Aynı Deployment + PVC manifest'i AWS'de EBS diski, Azure'da Managed Disk, kendi sunucularında Ceph ya da NFS ile çalışır. Değişen sadece StorageClass.

## StorageClass ve dinamik oluşturma

```bash
kubectl get storageclass
```

Killercoda'nın kubeadm kümesinde bir StorageClass olmayabilir (bulut kümelerinde ve kind/minikube'de hazır gelir). Yoksa node'un yerel diskini kullanan basit bir dinamik sağlayıcı kuralım, **local-path-provisioner** (k3s'in varsayılanı):

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl -n local-path-storage rollout status deploy/local-path-provisioner
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
kubectl get storageclass
```

`(default)` işaretli sınıf, `storageClassName` belirtmeyen PVC'ler için kullanılır.

```bash
kubectl get storageclass local-path -o yaml | grep -E 'provisioner|reclaimPolicy|volumeBindingMode'
```

| Alan | Anlamı |
|---|---|
| `provisioner` | Diski oluşturacak sürücü (`ebs.csi.aws.com`, `pd.csi.storage.gke.io`, `rancher.io/local-path`...) |
| `reclaimPolicy` | PVC silinince PV ve disk ne olsun: `Delete` (sil) ya da `Retain` (tut) |
| `volumeBindingMode` | `Immediate`: PVC oluşur oluşmaz disk açılır. `WaitForFirstConsumer`: Pod zamanlanana kadar bekle, sonra **Pod'un node'unda/bölgesinde** aç |
| `allowVolumeExpansion` | PVC büyütülebilir mi |
| `parameters` | Sürücüye özgü: disk tipi (`gp3`), IOPS, şifreleme |

> **`WaitForFirstConsumer` neden önemli?** Bulut diskleri tek bir availability zone'a bağlıdır. `Immediate` modda disk zone-a'da açılır, scheduler Pod'u zone-b'deki bir node'a koyarsa Pod diski bağlayamaz ve `Pending` kalır. Bekleme modunda önce Pod'un yeri seçilir, disk oraya açılır.

## PVC kullanmak

```bash
cat > pvc.yaml <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: veri
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
  # storageClassName: local-path     # verilmezse varsayılan sınıf
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: yazar
spec:
  replicas: 1
  strategy:
    type: Recreate                  # RWO disk aynı anda iki Pod'a bağlanamaz
  selector: { matchLabels: { app: yazar } }
  template:
    metadata: { labels: { app: yazar } }
    spec:
      containers:
        - name: yazar
          image: busybox:1.36
          command: ["sh", "-c", "echo \"$(date) $(hostname) başladı\" >> /veri/kayit.log; cat /veri/kayit.log; sleep 3600"]
          volumeMounts:
            - name: veri
              mountPath: /veri
      volumes:
        - name: veri
          persistentVolumeClaim:
            claimName: veri
EOF
kubectl apply -f pvc.yaml
kubectl get pvc veri -w &
sleep 20; kill %1
kubectl get pvc,pv
```

PVC önce `Pending` (bekleme modu: Pod henüz zamanlanmadı), Pod zamanlanınca bir PV oluşturuldu ve `Bound` oldu.

Verinin Pod'dan bağımsız yaşadığını görelim:

```bash
kubectl logs deploy/yazar
kubectl rollout restart deploy/yazar && kubectl rollout status deploy/yazar
kubectl logs deploy/yazar
kubectl delete pod -l app=yazar; sleep 15
kubectl logs deploy/yazar
```

Her yeni Pod bir satır ekledi ve öncekileri gördü.

### Erişim modları

| Mod | Kısaltma | Anlamı |
|---|---|---|
| `ReadWriteOnce` | RWO | **Tek node** tarafından okuma-yazma (o node'daki birden fazla Pod bağlayabilir). Blok diskler (EBS, Persistent Disk, Ceph RBD) |
| `ReadWriteOncePod` | RWOP | Tek **Pod** tarafından. En sıkı garanti |
| `ReadOnlyMany` | ROX | Çok node'dan salt okunur |
| `ReadWriteMany` | RWX | Çok node'dan okuma-yazma. Ağ dosya sistemleri: NFS, CephFS, EFS, Azure Files |

Erişim modu, **depolamanın yeteneğidir**, Kubernetes'in bir garantisi değildir. Bir blok diski RWX istersen PVC hiçbir zaman bağlanmaz. Birden fazla replikanın aynı dosyalara yazması gerekiyorsa (paylaşılan upload klasörü) RWX destekleyen bir depolama ya da daha iyisi bir nesne depolaması (S3) gerekir.

Yukarıdaki Deployment'ta `strategy: Recreate` kullanmamızın sebebi de bu: RWO bir diskle `RollingUpdate` yeni Pod'u başka bir node'a koyarsa yeni Pod diski bağlayamaz (`Multi-Attach error`) ve rollout takılır.

### Pod'u başka node'a taşımak

```bash
kubectl get pod -l app=yazar -o wide
kubectl get pv -o jsonpath='{.items[0].spec.nodeAffinity}{"\n"}'
```

local-path gibi **yerel** depolamalar node'a bağlıdır: PV'nin `nodeAffinity` alanı onu oluşturulduğu node'a kilitler ve Pod her zaman o node'a zamanlanır. O node ölürse veri de erişilemez. Yerel disk hızlıdır ama veriyi uygulamanın kendisi çoğaltmalıdır (veritabanı replikasyonu). Ağ üzerinden bağlanan depolamalar (bulut diskleri, Ceph, Longhorn) ise Pod ile başka node'a taşınabilir.

## Yaşam döngüsü ve reclaim policy

```text
PVC oluştu ──▶ PV oluştu/bağlandı (Bound) ──▶ Pod'lar kullanır ──▶ PVC silindi ──▶ reclaimPolicy
                                                                               ├─ Delete: PV ve disk silinir
                                                                               └─ Retain: PV "Released" kalır, disk durur
```

```bash
kubectl delete deploy yazar
kubectl get pvc,pv
kubectl delete pvc veri
sleep 10; kubectl get pv
```

`Delete` politikasında PVC silinince PV ve verisi de gitti. Dinamik oluşturulan PV'lerin çoğu varsayılan olarak `Delete`'tir.

> **Dikkat:** `kubectl delete namespace` içindeki bütün PVC'leri ve (Delete politikasında) **bütün verileri** siler. Üretim veritabanlarında StorageClass'ı ya da PV'yi `Retain` yap ve yedeği ayrı tut. Var olan bir PV'nin politikası sonradan değiştirilebilir:
>
> `kubectl patch pv <ad> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`

`Retain` ile `Released` kalan bir PV, yeni bir PVC'ye otomatik bağlanmaz (eski verinin kazara başkasına verilmemesi için). Veriyi kurtarmak için PV'nin `claimRef` alanı temizlenip yeni PVC ona açıkça (`volumeName`) bağlanır.

## Statik PV

Var olan bir NFS paylaşımını ya da diski Kubernetes'e tanıtmak için elle PV yazılır:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: arsiv-nfs
spec:
  capacity: { storage: 100Gi }
  accessModes: [ReadWriteMany]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""            # dinamik oluşturmayla karışmasın
  nfs:
    server: 10.0.0.20
    path: /export/arsiv
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: arsiv
spec:
  accessModes: [ReadWriteMany]
  storageClassName: ""
  volumeName: arsiv-nfs           # bu PV'ye bağlan
  resources: { requests: { storage: 100Gi } }
```

## Büyütme ve snapshot

```bash
kubectl apply -f pvc.yaml
kubectl patch pvc veri -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}' 2>&1 | tail -1
kubectl get storageclass local-path -o jsonpath='{.allowVolumeExpansion}{"\n"}'
kubectl delete -f pvc.yaml
```

local-path büyütmeyi desteklemez, bu yüzden hata alabilirsin. Bulut CSI sürücülerinde `allowVolumeExpansion: true` olan sınıflarda PVC'nin istenen boyutu artırılır, disk ve dosya sistemi çevrimiçi büyütülür. **Küçültme hiçbir zaman desteklenmez.**

CSI sürücüleri ayrıca **VolumeSnapshot** destekleyebilir: Bir PVC'nin anlık görüntüsünü almak ve ondan yeni bir PVC oluşturmak. Yedekleme araçları (Velero) ve test ortamı kopyalama bunu kullanır.

## Depolama seçenekleri

| Ortam | Yaygın seçim |
|---|---|
| AWS / GCP / Azure | Sağlayıcının CSI sürücüsü: EBS/gp3, Persistent Disk, Managed Disk (RWO). RWX için EFS, Filestore, Azure Files |
| Kendi sunucuların | **Longhorn** (basit, çoğaltmalı blok depolama), **Rook-Ceph** (güçlü, karmaşık), NFS (RWX, basit ama tek arıza noktası) |
| Geliştirme, tek node | local-path-provisioner, hostPath |

Pek çok ekip veritabanlarını Kubernetes'te çalıştırmak yerine **yönetilen veritabanı** (RDS, Cloud SQL) kullanmayı tercih eder: yedekleme, yükseltme ve yüksek erişilebilirlik sağlayıcının sorumluluğundadır. Kubernetes'te çalıştırılacaksa StatefulSet ve bir **operatör** (CloudNativePG, Percona, Zalando Postgres Operator) kullanılır (bir sonraki ders).

## Alıştırma (lab'da)

1. 500Mi'lık bir PVC ve onu kullanan bir `postgres:16-alpine` Deployment'ı oluştur (`POSTGRES_PASSWORD` ortam değişkeni, `PGDATA=/var/lib/postgresql/data/pgdata`). Bir tablo oluşturup bir satır ekle. Pod'u sil, yenisinde verinin durduğunu doğrula.
2. PV'nin reclaim politikasını `Retain` yap. Deployment'ı ve PVC'yi sil. PV ne durumda? Veri hâlâ node'da mı?

<details><summary>Çözüm</summary>

```bash
cat > pg.yaml <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: pgdata }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 500Mi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: pg }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: pg } }
  template:
    metadata: { labels: { app: pg } }
    spec:
      containers:
        - name: pg
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_PASSWORD, value: gizli }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          volumeMounts: [{ name: d, mountPath: /var/lib/postgresql/data }]
      volumes:
        - name: d
          persistentVolumeClaim: { claimName: pgdata }
EOF
kubectl apply -f pg.yaml && kubectl rollout status deploy/pg; sleep 5
kubectl exec deploy/pg -- psql -U postgres -c "CREATE TABLE t(x int); INSERT INTO t VALUES (42);"
kubectl delete pod -l app=pg; kubectl rollout status deploy/pg; sleep 5
kubectl exec deploy/pg -- psql -U postgres -c "SELECT * FROM t;"

PV=$(kubectl get pvc pgdata -o jsonpath='{.spec.volumeName}')
kubectl patch pv $PV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl delete -f pg.yaml
kubectl get pv $PV
kubectl get pv $PV -o jsonpath='{.spec.local.path}{.spec.hostPath.path}{"\n"}'
```

`PGDATA` alt klasörü, bazı depolamalarda bağlama noktasının kökünde bulunan `lost+found` klasörünün PostgreSQL'in açılmasını engellemesini önler.

2: PV `Released` durumda kalır, veri node'daki klasörde durur (`ssh node01` ile yolu kontrol edebilirsin). Yeni bir PVC'ye otomatik bağlanmaz.

</details>

```quiz
Bulut kümesinde PVC bağlandı ama Pod "volume node affinity conflict" ile Pending kaldı. En olası sebep?
- Disk dolu
- [x] Disk bir zone'da açıldı, Pod başka zone'daki bir node'a zamanlanmak istiyor. StorageClass'ta `WaitForFirstConsumer` kullanılmalı
- PVC'nin erişim modu yanlış
? Bekleme modunda disk, Pod'un yerleştiği zone'da oluşturulur.
```

```quiz
3 replikalı bir Deployment'ın Pod'ları aynı PVC'ye yazmak istiyor. PVC `ReadWriteOnce` ve bir bulut blok diski. Ne olur?
- Sorunsuz çalışır
- [x] Farklı node'lardaki Pod'lar diski bağlayamaz (Multi-Attach). RWX destekleyen depolama ya da nesne depolaması gerekir
- Kubernetes diski kopyalar
? RWO tek node demektir. Paylaşılan dosyalar için NFS/EFS gibi RWX ya da S3 gibi nesne depolaması kullanılır.
```

```quiz
Namespace'i silmek, `Delete` reclaim politikalı PVC'lerin verisine ne yapar?
- Verilere dokunmaz
- [x] PVC'ler silinir, PV'ler ve altlarındaki diskler de silinir
- Veriler yedeklenir
? Kritik veriler için Retain politikası ve ayrı yedek şart.
```

## Özet

- PVC (talep, namespace'li) ↔ PV (depolama, küme geneli) ↔ StorageClass (dinamik oluşturma tarifi, CSI sürücüsü).
- `WaitForFirstConsumer` ile disk Pod'un zone'unda açılır.
- Erişim modları depolamanın yeteneğidir: RWO (blok disk), RWX (ağ dosya sistemi), RWOP.
- RWO + Deployment: `strategy: Recreate`. Yerel depolama node'a kilitlidir.
- `reclaimPolicy`: Delete (varsayılan, veri gider) / Retain. Namespace silmek verileri silebilir.
- Büyütme (`allowVolumeExpansion`), küçültme yok. VolumeSnapshot ile anlık görüntü.
