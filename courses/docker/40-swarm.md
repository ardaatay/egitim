# Orkestrasyon ve Swarm: init, manager ve worker node

Şimdiye kadar her şey tek sunucudaydı. Sunucu çökerse uygulama da çöker, trafik artarsa ölçekleyebileceğin yer o sunucunun kaynaklarıyla sınırlıdır, deploy sırasında kısa bir kesinti kaçınılmazdır. **Orkestratör**, birden fazla sunucuyu tek bir havuz gibi yönetir ve "bu uygulamadan 5 kopya çalışsın" dediğinde nerede, nasıl çalışacaklarına kendisi karar verir.

Bu bölümde Docker'ın yerleşik orkestratörü **Swarm mode**'u kullanacağız. Kurulum gerektirmez (Docker Engine'in parçası), Compose dosyalarını neredeyse aynen kullanır ve orkestrasyonun temel kavramlarını Kubernetes'ten çok daha az karmaşıklıkla öğretir. Burada öğrendiğin her kavramın Kubernetes'te bir karşılığı var.

## Orkestratör ne yapar?

| Yetenek | Anlamı | Swarm | Kubernetes |
|---|---|---|---|
| **İstenen durum** | "5 replika çalışsın" dersin, gerçek durumu sürekli buna yaklaştırır | Service | Deployment |
| **Zamanlama** | Konteyneri hangi sunucuda çalıştıracağına karar verir (kaynak, kısıt) | Scheduler | Scheduler |
| **Kendi kendini iyileştirme** | Konteyner ya da sunucu ölürse yenisini başka yerde başlatır | Var | Var |
| **Servis keşfi ve yük dağıtma** | Replikalara tek bir adla ulaşılır | VIP + DNS | Service |
| **Rolling update / rollback** | Kesintisiz sürüm geçişi, sorunda geri alma | Var | Var |
| **Sırlar ve ayarlar** | Şifreli dağıtılan gizli bilgiler | Secret, Config | Secret, ConfigMap |

Compose bunların hiçbirini yapmaz: tek sunucuda, verdiğin konteynerleri çalıştırır ve konteyner ölünce sadece restart politikasıyla yeniden başlatır.

### Swarm mı, Kubernetes mi?

- **Kubernetes** endüstri standardı. Ekosistemi (Helm, operatörler, servis ağları, otomatik ölçekleme) çok geniş, ama öğrenme eğrisi ve işletme maliyeti yüksek. Bulut sağlayıcılarının yönetilen sürümleri (EKS, GKE, AKS) işletme yükünü azaltır.
- **Swarm** basit, Docker'la birlikte gelir, küçük ekipler ve birkaç sunuculuk kurulumlar için hâlâ pratik bir seçim. Mirantis tarafından bakımı sürüyor, ama yeni özellik geliştirme yavaş ve ekosistemi küçük.

Bu bölümün amacı, orkestrasyon kavramlarını somut olarak öğrenmek ve gerektiğinde küçük bir Swarm kümesi işletebilmek. Kubernetes kursuna geçtiğinde aynı kavramları tanıyacaksın.

## Mimari

```text
               ┌──────────── manager'lar (Raft) ─────────────┐
               │  manager1 (lider)  manager2  manager3        │   küme durumu, zamanlama, API
               └──────────────┬───────────────────────────────┘
                              │ görev (task) atamaları
         ┌────────────────────┼────────────────────┐
      worker1              worker2              worker3            konteynerleri çalıştırır
```

- **Node**: Swarm'a katılmış bir Docker host'u.
- **Manager**: Küme durumunu tutar, API'yi sunar, zamanlama yapar. Varsayılan olarak konteyner de çalıştırabilir.
- **Worker**: Sadece kendisine atanan görevleri çalıştırır.
- **Service**: İstenen durum tanımı ("nginx:1.27, 3 replika, 80 portu").
- **Task**: Bir servisin tek bir kopyası. Bir node'a atanır ve bir konteyner olarak çalışır. Task ölürse yerine **yeni** bir task oluşturulur (aynı konteyner yeniden başlatılmaz).

### Raft ve quorum

Manager'lar küme durumunu **Raft** uzlaşma algoritmasıyla çoğaltır. Bir değişikliğin kabul edilmesi için manager'ların **çoğunluğunun** (quorum) onayı gerekir. Bunun sonuçları önemli:

| Manager sayısı | Quorum | Kaybedilebilecek manager |
|---|---|---|
| 1 | 1 | 0 (manager ölürse küme yönetilemez) |
| 2 | 2 | **0** (2 manager, 1'den daha iyi değil!) |
| 3 | 2 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

- Manager sayısı **tek** olmalı: 3 ya da 5. Çift sayı ek dayanıklılık getirmez.
- 7'den fazlası önerilmez: her yazma işleminin daha fazla manager'a çoğaltılması gerekir.
- Quorum kaybedilirse **çalışan konteynerler çalışmaya devam eder**, ama yeni deploy, ölçekleme ve kendi kendini iyileştirme durur.
- Manager'ları farklı arıza bölgelerine (farklı fiziksel sunucu, raf, bulutta farklı availability zone) dağıt.

## Lab: üç node'lu küme

Bu bölümün lab'ı için **birden fazla sunucu** gerekiyor. Play with Docker bunu ücretsiz verir:

```lab
Play with Docker
https://labs.play-with-docker.com/
Docker Hub hesabıyla gir, "Start"a bas. Soldaki "+ ADD NEW INSTANCE" ile üç node aç (node1, node2, node3). Oturum 4 saat sürer. Tek sunuculu denemeler için Killercoda Ubuntu da olur, ama node ekleme ve node kaybı adımlarını yapamazsın.
```

Her node'un IP'sini öğren (Play with Docker'da her pencerenin başında yazar):

```bash
hostname -i
```

### Kümeyi başlat

`node1`'de:

```bash
docker swarm init --advertise-addr $(hostname -i)
```

Çıktı, worker eklemek için bir `docker swarm join --token SWMTKN-1-... IP:2377` komutu verir. `--advertise-addr`, diğer node'ların bu manager'a hangi adresten ulaşacağını belirtir. Birden fazla ağ arabirimi olan sunucularda mutlaka verilmeli.

```bash
docker info --format 'Swarm: {{.Swarm.LocalNodeState}}, manager: {{.Swarm.ControlAvailable}}'
docker node ls
```

### Node ekle

Katılma token'larını istediğin zaman tekrar alabilirsin:

```bash
docker swarm join-token worker
docker swarm join-token manager
```

`node2` ve `node3`'te, `join-token worker` çıktısındaki komutu çalıştır:

```bash
docker swarm join --token SWMTKN-1-... 192.168.0.X:2377
```

`node1`'e dön:

```bash
docker node ls
```

```text
ID          HOSTNAME   STATUS   AVAILABILITY   MANAGER STATUS   ENGINE VERSION
abc... *    node1      Ready    Active         Leader           27.x
def...      node2      Ready    Active                          27.x
ghi...      node3      Ready    Active                          27.x
```

`MANAGER STATUS` boş olanlar worker. Yönetim komutları (`docker service`, `docker node`) **sadece manager'larda** çalışır.

Gerekli portlar (güvenlik duvarında node'lar arasında açık olmalı):

| Port | Ne için |
|---|---|
| `2377/tcp` | Küme yönetimi (manager'lar) |
| `7946/tcp+udp` | Node'lar arası iletişim (gossip) |
| `4789/udp` | Overlay ağ trafiği (VXLAN) |

### Yüksek erişilebilirlik: manager'ları artır

Tek manager'lı küme, manager ölünce yönetilemez. node2 ve node3'ü de manager yapalım (üretimde 3 manager + ayrı worker'lar tipik bir düzendir):

```bash
docker node promote node2 node3
docker node ls
```

`MANAGER STATUS` sütununda `Leader` ve iki `Reachable` görürsün. Manager kaybını dersin sonundaki alıştırmada deneyeceğiz.

### Bakım: node'u boşaltmak

node1'i bakıma almak istediğini düşün. Artık node2 de manager olduğu için komutu **node2**'de çalıştır:

```bash
docker node update --availability drain node1
docker node ls
```

`drain`, o node'daki görevlerin başka node'lara taşınmasını sağlar ve yeni görev atanmasını engeller. Bakım (çekirdek güncellemesi, yeniden başlatma) öncesi yapılan budur:

```text
docker node update --availability drain node1    # görevleri boşalt
# ... bakım ...
docker node update --availability active node1   # geri al
```

Üç durum: `active` (normal), `pause` (yeni görev alma, mevcutlar kalsın), `drain` (mevcutları da taşı).

```bash
docker node update --availability active node1
```

### Node etiketleri

Görevlerin nerede çalışacağını kontrol etmek için node'lara etiket verilir (bir sonraki derste `placement` kısıtlarında kullanacağız):

```bash
docker node update --label-add bolge=istanbul --label-add disk=ssd node2
docker node update --label-add bolge=ankara node3
docker node inspect node2 --format '{{json .Spec.Labels}}'
```

## İlk servis

```bash
docker service create --name web --replicas 3 --publish 8080:80 nginx:1.27-alpine
docker service ls
docker service ps web
```

`service ps`, her task'ın hangi node'da çalıştığını gösterir. Swarm üç replikayı node'lara dağıttı. Herhangi bir node'un IP'sine 8080'den bağlanabilirsin, hatta o node'da `web` task'ı olmasa bile (routing mesh, bir sonraki ders):

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080
```

### Kendi kendini iyileştirme

Bir task'ın konteynerini öldür ve Swarm'ın ne yaptığını izle. `docker service ps web` çıktısında node1'deki task'ı bul, o node'da:

```bash
docker ps --filter name=web -q | head -1 | xargs docker rm -f
sleep 5
docker service ps web
```

Ölen task'ın yerine **yeni bir task** başlatıldı. Eski task `Shutdown`/`Failed` olarak geçmişte görünür. Replika sayısı yine 3. Sen hiçbir şey yapmadın: gerçek durum istenen duruma döndürüldü.

## Kümenin bakımı

### Manager yedeği

Küme durumu (servisler, secret'lar, ağlar, node'lar) manager'larda `/var/lib/docker/swarm` altında tutulur. Bütün manager'ları kaybetmek, kümeyi kaybetmek demektir. Yedek almak için **bir** manager'da Docker durdurulup bu klasör kopyalanır (diğer manager'lar quorum'u korurken):

```text
systemctl stop docker
tar czf swarm-yedek-$(date +%F).tgz -C /var/lib/docker swarm
systemctl start docker
```

Felaket durumunda yedek yeni bir sunucuya açılıp `docker swarm init --force-new-cluster` ile tek manager'lı yeni bir küme olarak başlatılır.

### Autolock

Swarm secret'ları manager'larda şifreli saklar, ama şifreleme anahtarı da varsayılan olarak diskte durur. **Autolock** ile anahtar ayrı bir kilit açma anahtarıyla korunur ve Docker yeniden başlayınca manager, bu anahtar girilene kadar kilitli kalır:

```text
docker swarm update --autolock=true      # kilit açma anahtarını verir, güvenli bir yerde sakla
docker swarm unlock                      # yeniden başlatmadan sonra
```

Bedeli: manager yeniden başladığında birinin anahtarı girmesi gerekir. Güvenlik ile otomasyon arasında bir tercih.

### Node'u çıkarmak

```text
docker node update --availability drain node3     # önce görevleri boşalt
docker node demote node3                          # manager ise önce worker yap
# node3'te:
docker swarm leave
# manager'da:
docker node rm node3
```

## Temizlik

```bash
docker service rm web
```

Kümeyi bir sonraki ders için açık tut. Play with Docker oturumu kapanırsa baştan kurman gerekir.

## Alıştırma (lab'da)

1. 3 manager'lı kümede, bir manager'ı kaybetmeyi simüle et: node3'te `docker swarm leave --force` çalıştır. node1'de `docker node ls` ne gösteriyor? Küme hâlâ yönetilebiliyor mu (`docker service create` çalışıyor mu)?
2. Bir manager daha kaybedersen (node2'de de `leave --force`) ne olur?

<details><summary>Cevap</summary>

1: node3 `Down` / `Unreachable` görünür. 3 manager'dan 2'si ayakta, quorum (2) sağlanıyor: servis oluşturma, ölçekleme çalışır.

2: 3 manager'dan sadece 1'i kaldı ve quorum (2) kayboldu. `docker node ls` ve `docker service create` "The swarm does not have a leader" hatası verir. Çalışan konteynerler çalışmaya devam eder, ama küme yönetilemez. Kurtarmak için kalan manager'da `docker swarm init --force-new-cluster --advertise-addr ...` çalıştırılır: mevcut durumu koruyarak tek manager'lı yeni bir küme başlatır, sonra diğer node'lar yeniden katılır.

Not: `leave --force` ile ayrılan manager'lar listede `Down` olarak kalır ve quorum hesabında sayılmaya devam eder. Kalıcı olarak çıkarmak için `docker node demote` ve `docker node rm`.

</details>

```quiz
Swarm kümesinde 4 manager var. Kaç manager kaybedilirse küme yönetilemez hâle gelir?
- 1
- [x] 2
- 3
? 4 manager için quorum 3'tür. 2 manager kaybedilince 2 kalır, quorum sağlanamaz. 3 manager da 1 kayba dayanır: 4. manager dayanıklılığı artırmaz.
```

```quiz
Swarm'da quorum kaybedildi. Çalışan konteynerlere ne olur?
- Hepsi durur
- [x] Çalışmaya devam eder, ama yeni deploy, ölçekleme ve kendi kendini iyileştirme durur
- Worker'lar otomatik manager olur
? Veri düzlemi (konteynerler) çalışır, kontrol düzlemi (yönetim) durur.
```

```quiz
Bir sunucuya çekirdek güncellemesi yapacaksın ve üzerindeki görevlerin başka sunuculara taşınmasını istiyorsun. Hangi komut?
- `docker node rm`
- [x] `docker node update --availability drain <node>`
- `docker swarm leave`
? drain görevleri taşır ve yeni görev atanmasını engeller. Bakım sonrası `--availability active`.
```

## Özet

- Orkestratör: istenen durum, zamanlama, kendi kendini iyileştirme, servis keşfi, rolling update.
- Swarm: manager'lar (Raft, quorum, tek sayı: 3/5) ve worker'lar. Service → task → konteyner.
- `swarm init --advertise-addr`, `join-token`, `node ls/promote/demote/update`, portlar 2377, 7946, 4789.
- Bakım: `drain` / `active`. Etiketler: `--label-add`.
- Yedek: `/var/lib/docker/swarm`, kurtarma `--force-new-cluster`. Autolock ile anahtar koruması.
