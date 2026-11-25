# Konteyner nedir: namespace, cgroup, imaj

## Neden Docker?

Linux kursunda bir uygulamayı sunucuya koymak için yaptıklarını hatırla: doğru Python/Node sürümünü kur, venv oluştur, sistem kütüphanelerini (`libpq`, `libssl`) yükle, servis kullanıcısı aç, systemd birimi yaz. Bunu her sunucuda, her ortamda (geliştirici bilgisayarı, test, üretim) aynı şekilde tekrarlamak gerekir ve en küçük fark "benim makinemde çalışıyordu" sorununa dönüşür.

Docker bunu tersine çevirir: Uygulamayı **bütün bağımlılıklarıyla birlikte** (dil çalışma zamanı, kütüphaneler, ayarlar) tek bir **imaja** paketlersin. O imaj geliştirici bilgisayarında, CI'da ve üretimde **bit bit aynı** çalışır. Sunucunun bilmesi gereken tek şey konteyner çalıştırmaktır.

| Sorun | Docker'sız | Docker ile |
|---|---|---|
| Ortam farkları | Her sunucuda elle/Ansible ile kurulum | Aynı imaj her yerde |
| Aynı sunucuda farklı sürümler | Python 3.9 ve 3.12'yi birlikte kurmak zahmetli | Her uygulama kendi imajında |
| Deploy ve geri alma | Dosya kopyala, bağımlılık kur, symlink çevir | Yeni imajı çalıştır, eskisine dön |
| Yeni geliştiricinin ortamı | Yarım gün kurulum | `docker compose up` |
| Ölçekleme | Yeni sunucuyu baştan hazırla | Aynı imajdan bir konteyner daha |

Bedeli de var: bir katman daha (imaj, registry, ağ, depolama kavramları), çekirdek paylaşımından gelen daha zayıf izolasyon ve hatalı kullanıldığında (root konteynerler, sırlar imajda) yeni güvenlik riskleri. Kurs boyunca bunların doğru yönetimini göreceğiz.

## Konteyner aslında ne?

"Konteyner hafif bir sanal makinedir" tanımı kullanışlı ama yanıltıcıdır ve Docker'da karşılaşacağın pek çok sürprizin kaynağıdır. Sanal makinede ayrı bir çekirdek çalışır. Konteynerde ise **çekirdek yoktur**: konteyner, host'un çekirdeği üzerinde çalışan, üç çekirdek özelliğiyle kısıtlanmış **sıradan bir Linux sürecidir**:

| Bileşen | Ne sağlar | Linux kursundaki karşılığı |
|---|---|---|
| **Namespace** | Sürecin ne **gördüğünü** kısıtlar: kendi PID'leri, kendi ağı, kendi dosya sistemi, kendi hostname'i | `/proc/PID/ns` |
| **cgroup** | Sürecin ne kadar **kullanabileceğini** kısıtlar: bellek, CPU, süreç sayısı, G/Ç | systemd `MemoryMax`, `CPUQuota` |
| **İmaj** | Sürecin göreceği kök dosya sistemi: bir dağıtımın kullanıcı alanı + uygulama | Release klasörü + bağımlılıklar |

Bunlara güvenlik katmanları da eklenir: **capability**'ler (root'un yetkilerini parçalara bölmek), **seccomp** (izin verilen sistem çağrıları), **AppArmor/SELinux**. Hepsini güvenlik dersinde göreceğiz.

## Namespace'ler

Her süreç bir dizi namespace'e üyedir. Tarayıcıdaki Linux'ta kendi kabuğunun üyeliklerine bak:

```terminal
ls -l /proc/$$/ns
ls -l /proc/1/ns
```

İki çıktıda numaralar aynı: kabuk da PID 1 de aynı namespace'lerde, yani aynı "dünyayı" görüyorlar. Bir konteynerdeki süreç için bu numaralar host'takilerden farklı olur.

| Namespace | İzole ettiği | Konteynerde sonucu |
|---|---|---|
| `pid` | Süreç numaraları | Konteynerin içindeki uygulama kendini **PID 1** görür, host'taki diğer süreçleri göremez |
| `mnt` | Bağlama noktaları | Konteynerin kendi kök dosya sistemi (imaj) olur |
| `net` | Ağ arabirimleri, IP, portlar, rotalar | Konteynerin kendi `eth0`'ı, kendi `127.0.0.1`'i olur. 8080 portunu birden çok konteyner aynı anda dinleyebilir |
| `uts` | Hostname | Konteynerin kendi hostname'i |
| `ipc` | Paylaşılan bellek, semaforlar | |
| `user` | UID/GID eşlemesi | İçerideki root, dışarıda yetkisiz bir kullanıcı olabilir (rootless) |
| `cgroup` | cgroup hiyerarşisinin görünümü | |

`net` namespace'inin önemli bir sonucu: Konteynerin içindeki `127.0.0.1`, **host'un** `127.0.0.1`'i değildir. Konteynerde `127.0.0.1:8080` dinleyen bir uygulama, port yayınlansa bile dışarıdan erişilemez. Uygulama konteynerde `0.0.0.0` dinlemelidir. Ağ dersinde ayrıntılı göreceğiz.

## Elle bir "konteyner" kuralım

Tarayıcıdaki küçük Linux'ta namespace oluşturan `unshare` aracı yok, ama en eski izolasyon aracı olan `chroot` var. `chroot`, bir sürecin **kök klasörünü** değiştirir. Bu, `mnt` namespace + imajın ilkel bir karşılığıdır.

Önce bir "imaj" hazırlayalım: içinde sadece BusyBox ve kütüphaneleri olan minik bir kök dosya sistemi.

```terminal
R=/tmp/imaj
rm -rf $R && mkdir -p $R/bin $R/proc $R/tmp $R/etc
cp /bin/busybox $R/bin/
cp -a /lib $R/
for a in sh ls ps cat echo hostname mount umount id head; do ln -s busybox $R/bin/$a; done
echo "konteyner-imajı v1" > $R/etc/surum
tree $R | head -20
du -sh $R
```

Bu klasör, Docker'ın bir imajdan oluşturduğu kök dosya sisteminin en sade hâli: 2 MB'lık bir "dağıtım". Şimdi bir süreci bu klasörü kök sanacak şekilde başlatalım:

```terminal
chroot $R /bin/sh -c '
echo "--- kök dizin:"; ls /
echo "--- sürüm:"; cat /etc/surum
echo "--- host dosyası /etc/os-release görünüyor mu?"; cat /etc/os-release 2>&1
'
```

Süreç kendi küçük dünyasının içinde: `/` onun için `/tmp/imaj`, host'un `/etc/os-release` dosyası yok. Bir Docker konteynerinin içinde `ls /` yaptığında gördüğün şey de budur: imajın içeriği.

Ama izolasyon burada bitiyor. Süreç listesine ve hostname'e bakalım:

```terminal
ESKI_AD=$(hostname)
chroot $R /bin/sh -c '
mount -t proc proc /proc
echo "--- içeriden görülen süreçler:"; ps | head -6
echo "--- benim PID numaram: $$"
hostname yeni-ad 2>&1; echo "--- hostname: $(hostname)"
umount /proc
'
echo "--- host'taki hostname: $(hostname)"
```

Burada üç sorun görüyoruz:

1. **Bütün süreçleri görüyor.** PID 1 `init`, host'un süreci. Konteynerdeki süreç kendini PID 1 değil, sıradan bir PID olarak görüyor. Docker bunu `pid` namespace ile çözer.
2. **Hostname'i değiştirince host'unki de değişti.** `uts` namespace olmadığı için.
3. **Root hâlâ root.** İçeriden `mount` yapabildi. Gerçek bir konteynerde root'un yetkileri capability'lerle kırpılır, istenirse `user` namespace ile host'ta yetkisiz bir kullanıcıya eşlenir.

Ayrıca hiçbir **kaynak sınırı** yok: bu süreç host'un bütün belleğini ve CPU'sunu kullanabilir. Bunu cgroup'lar çözer.

Hostname'i geri alalım:

```terminal
hostname "$ESKI_AD"
hostname
```

Docker'ın `docker run` ile yaptığı şey, kabaca bu adımların tamamının otomatik ve eksiksiz hâlidir:

```text
1. İmaj katmanlarını birleştirip bir kök dosya sistemi hazırla (overlayfs)
2. Yeni pid, mnt, net, uts, ipc (istenirse user) namespace'leri oluştur
3. Bir cgroup oluştur, bellek/CPU/pids sınırlarını yaz
4. Ağı kur: bir veth çifti, köprüye bağla, IP ver, port yönlendirmesi için NAT kuralları
5. Capability'leri kırp, seccomp profilini uygula
6. Kök dosya sistemine pivot_root yap, /proc, /dev, /sys'i bağla
7. İmajdaki komutu exec et: bu süreç konteynerin PID 1'i olur
```

Gerçek bir Linux'ta `unshare` ile bunun bir kısmını elle yapabilirsin. Lab'da deneyeceğiz.

## Lab: konteyner host'tan nasıl görünür?

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker kurulu değilse bu dersin ilk bloğu kurar. Alternatif: Play with Docker (labs.play-with-docker.com), Docker Hub hesabıyla 4 saatlik ücretsiz ortam.
```

Docker yoksa kur ve sürümü kontrol et:

```bash
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
docker version --format '{{.Server.Version}}'
```

> `get.docker.com` betiği deneme ortamları için pratiktir. Üretim sunucularında Docker'ın belgelerindeki paket deposu yöntemiyle kurulum yapılır, böylece sürüm sabitlenip kontrollü güncellenebilir.

### Konteyner = süreç

Bir konteyner başlat ve host'tan bak:

```bash
docker run -d --name uyku alpine sleep 3600
ps -ef | grep 'sleep 3600' | grep -v grep
docker top uyku
docker inspect -f '{{.State.Pid}}' uyku
```

`ps` çıktısında konteynerdeki `sleep`'i **host'un sıradan bir süreci** olarak görüyorsun. Ayrı bir çekirdek ya da sanal makine yok. `docker inspect` bu sürecin host'taki PID'ini verir.

Namespace'leri karşılaştır:

```bash
P=$(docker inspect -f '{{.State.Pid}}' uyku)
ls -l /proc/$P/ns | awk '{print $9, $11}'
echo "--- host:"
ls -l /proc/1/ns | awk '{print $9, $11}'
```

`pid`, `mnt`, `net`, `uts`, `ipc` numaraları farklı. `user` aynı: varsayılan Docker, user namespace kullanmaz. Yani konteynerdeki root, host'taki root ile aynı UID'dir (0). Bu yüzden konteynerde root olarak çalışmak risklidir.

İçeriden bakış:

```bash
docker exec uyku ps
docker exec uyku hostname
docker exec uyku cat /etc/os-release | head -2
```

İçeriden bakınca `sleep` **PID 1**, süreç listesinde başka bir şey yok, hostname konteyner kimliği, dağıtım Alpine. Host Ubuntu olsa bile.

### nsenter: konteynerin namespace'ine girmek

`docker exec` aslında konteynerin namespace'lerine katılan yeni bir süreç başlatır. Aynı şeyi Docker'sız, sadece çekirdek araçlarıyla yapabiliriz:

```bash
nsenter -t $P -u hostname
nsenter -t $P -n ip addr
```

İkinci komut, **host'un** `ip` aracını konteynerin ağ namespace'inde çalıştırdı: konteynerin `eth0`'ını ve IP'sini görüyorsun. İçinde hiçbir araç olmayan minimal imajlarda (distroless) ağ sorununu teşhis etmenin yolu budur. Teşhis dersinde tekrar kullanacağız.

### cgroup

```bash
docker run -d --name sinirli --memory 64m --cpus 0.5 alpine sleep 3600
CG=$(cat /proc/$(docker inspect -f '{{.State.Pid}}' sinirli)/cgroup | cut -d: -f3)
echo $CG
cat /sys/fs/cgroup$CG/memory.max
cat /sys/fs/cgroup$CG/cpu.max
```

`memory.max` 67108864 (64 MB), `cpu.max` `50000 100000` (100 ms'de 50 ms, yani yarım çekirdek). Bunlar systemd'nin `MemoryMax` ve `CPUQuota` için yazdığı dosyaların aynısı. Docker ile systemd aynı çekirdek mekanizmasını kullanıyor.

Temizlik:

```bash
docker rm -f uyku sinirli
```

## Konteyner ve sanal makine

| | Sanal makine | Konteyner |
|---|---|---|
| Çekirdek | Her VM'in kendi çekirdeği | Host'un çekirdeği paylaşılır |
| Açılış | Saniyeler-dakikalar (işletim sistemi açılır) | Milisaniyeler (süreç başlar) |
| Boyut | GB'lar | MB'lar |
| İzolasyon | Donanım seviyesinde, güçlü | Çekirdek seviyesinde, çekirdek açığı tüm konteynerleri etkiler |
| Farklı işletim sistemi | Linux üstünde Windows çalışır | Linux konteyneri Linux çekirdeği ister |

Son satırın bir sonucu: Windows ve macOS'taki Docker Desktop, arka planda **küçük bir Linux sanal makinesi** çalıştırır ve konteynerler onun içinde çalışır. Bilgisayarındaki `docker` komutu o sanal makinedeki daemon ile konuşur.

## Kısa tarihçe

Konteyner fikri Docker'dan çok eskidir. Docker'ın katkısı, var olan çekirdek özelliklerini **kullanışlı bir araç ve taşınabilir bir imaj biçimiyle** birleştirmek oldu:

| Yıl | Gelişme |
|---|---|
| 1979 | Unix'te `chroot`: sürecin kök klasörünü değiştirmek (yukarıda kullandığımız) |
| 2000 | FreeBSD Jails: dosya sistemi, ağ ve süreç izolasyonu |
| 2004 | Solaris Zones |
| 2006-2008 | Linux'a cgroups (Google) ve namespace'ler eklendi. **LXC** bunları birleştirdi |
| 2013 | **Docker** (dotCloud şirketinin iç aracı) açık kaynak oldu: Dockerfile, katmanlı imaj, Docker Hub |
| 2015 | **OCI** (Open Container Initiative): imaj ve çalışma zamanı standartları. `runc` Docker'dan ayrılıp bağışlandı |
| 2016-2017 | **containerd** Docker'dan ayrıldı ve CNCF'e bağışlandı |
| 2014-2017 | Kubernetes çıktı ve orkestrasyonda standart oldu |
| 2022 | Kubernetes, Docker Engine'i doğrudan desteklemeyi bıraktı (dockershim). containerd ya da CRI-O kullanıyor. Docker ile build edilen imajlar OCI standardında olduğu için aynen çalışmaya devam ediyor |

Bugün "Docker" kelimesi üç şeyi ifade eder: **Docker Inc.** (şirket), **Docker Engine** (açık kaynak daemon ve CLI) ve **Docker Desktop** (Mac/Windows için ticari uygulama). Kurulum dersinde farklarını göreceğiz. Podman, containerd/nerdctl, Buildah gibi araçlar da aynı OCI imajlarıyla çalışır.

## Windows konteynerleri

Konteynerler çekirdeği paylaştığı için **Linux konteyneri Linux çekirdeği, Windows konteyneri Windows çekirdeği ister**. Windows Server ve Windows 10/11'de iki tür Windows konteyneri vardır:

- **Process isolation**: Linux'taki gibi, host'un Windows çekirdeğini paylaşan süreçler. Host ile konteynerin Windows sürümlerinin uyumlu olması gerekir.
- **Hyper-V isolation**: Her konteyner çok küçük bir sanal makinede kendi çekirdeğiyle çalışır. Daha güçlü izolasyon, daha yavaş açılış.

Windows konteyner imajları (`mcr.microsoft.com/windows/servercore`, `nanoserver`) gigabaytlar boyutundadır ve genelde eski .NET Framework uygulamaları için kullanılır. Modern .NET (Core) uygulamaları Linux konteynerlerinde çalışır. Bilgisayarındaki Docker Desktop, Windows'ta varsayılan olarak **Linux konteynerleri** çalıştırır (WSL2 içindeki bir Linux çekirdeğiyle). Windows konteynerleri modu ayrıca seçilir. Bu kursun tamamı Linux konteynerleri üzerinedir.

## Alıştırma

Tarayıcıda:

1. `/tmp/imaj` "imajına" `date` ve `uname` komutlarını ekle (BusyBox'a link). `chroot` ile içeride çalıştır. `uname -r` hangi çekirdeği gösteriyor ve neden?

Lab'da:

2. `docker run --rm alpine uname -r` ile host'ta `uname -r` çıktısını karşılaştır. Aynı mı?

<details><summary>Cevap</summary>

```terminal
for a in date uname; do ln -sf busybox /tmp/imaj/bin/$a; done
chroot /tmp/imaj /bin/sh -c 'date; uname -r'
uname -r
```

İki çıktı da aynı çekirdek sürümünü gösterir. chroot'ta da Docker'da da (lab'daki 2. adım) konteynerdeki süreç **host'un çekirdeğini** kullanır. "Konteyner içinde Alpine var" demek, Alpine'in kullanıcı alanı araçları ve kütüphaneleri var demektir, Alpine çekirdeği değil. Bu yüzden bir konteyner, host çekirdeğinin desteklemediği bir özelliği (yeni bir sistem çağrısı gibi) kullanamaz.

</details>

```quiz
Konteyner içindeki uygulama `ps` çıktısında kendini PID 1 görüyor. Bunu sağlayan nedir?
- cgroup
- [x] PID namespace
- chroot
? PID namespace, süreç numaralarını izole eder. Host'tan bakınca aynı süreç farklı (büyük) bir PID'e sahiptir.
```

```quiz
Konteynere `--memory 512m` verdin. Bu sınırı hangi çekirdek mekanizması uygular?
- Namespace
- [x] cgroup
- seccomp
? Namespace'ler ne görüldüğünü, cgroup'lar ne kadar kullanıldığını sınırlar.
```

```quiz
Ubuntu host'ta `docker run alpine uname -r` ne gösterir?
- Alpine'in çekirdek sürümü
- [x] Host'un (Ubuntu'nun) çekirdek sürümü
- Hata verir
? Konteynerlerin kendi çekirdeği yoktur, host çekirdeğini paylaşırlar.
```

## Özet

- Konteyner = namespace'lerle izole, cgroup'larla sınırlı, imajdan gelen kök dosya sistemini gören **sıradan bir süreç**.
- `pid`, `mnt`, `net`, `uts`, `ipc`, `user` namespace'leri. Konteynerin `127.0.0.1`'i kendine aittir.
- Çekirdek paylaşılır: farklı çekirdek, farklı işletim sistemi yok. İzolasyon VM'den zayıftır.
- `docker inspect -f '{{.State.Pid}}'`, `nsenter`, `/sys/fs/cgroup/...` ile konteynere host'tan bakılabilir.
