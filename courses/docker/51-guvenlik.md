# Güvenlik: kullanıcı, capability, salt okunur, rootless, secret

İlk derste gördük: Konteyner, host çekirdeğini paylaşan bir süreçtir. İzolasyon bir sanal makineninki kadar güçlü değildir ve varsayılan ayarlar **kullanışlılık** için seçilmiştir, güvenlik için değil. Bu derste bir konteyner ele geçirildiğinde saldırganın neler yapabileceğini somut olarak görüp, her bir riski kapatan ayarları katman katman ekleyeceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Bu dersteki saldırı örneklerini sadece kendi lab ortamında çalıştır.
```

## Tehdit modeli

Konteyner güvenliğinde üç soru sorulur:

1. **İmajda ne var?** Bilinen açıklar, gömülü gizli bilgiler, gereksiz araçlar. (İmajlar bölümü: multi-stage, distroless, tarama.)
2. **Konteyner ele geçirilirse içeride ne yapabilir?** Dosya yazma, araç indirme, ağda yayılma, yetki yükseltme.
3. **Konteynerden host'a kaçabilir mi?** Çekirdek açıkları, ayrıcalıklı ayarlar, Docker soketi, host dosya sistemi bağlamaları.

Her ayar bu sorulardan birini daraltır. Hiçbiri tek başına yeterli değildir: amaç **derinlemesine savunma**.

## 1. Root olarak çalışma

```bash
docker run --rm alpine id
docker run --rm alpine sh -c 'cat /proc/1/status | grep -E "^(Uid|CapEff)"'
```

Varsayılan konteyner **UID 0** ile çalışır ve user namespace kullanılmadığı için bu, host'taki root ile **aynı** UID'dir. Bir bind mount ya da çekirdek açığı üzerinden host'a ulaşan bir saldırgan root olarak ulaşır.

```bash
mkdir -p /tmp/host-dosya && echo "host'un gizli dosyası" > /tmp/host-dosya/gizli && chmod 600 /tmp/host-dosya/gizli
docker run --rm -v /tmp/host-dosya:/h alpine cat /h/gizli
docker run --rm -u 1000:1000 -v /tmp/host-dosya:/h alpine cat /h/gizli
```

Root konteyner host'taki 600 izinli dosyayı okudu, UID 1000 okuyamadı.

**Önlem:** Dockerfile'da `USER` (Dockerfile dersi), çalıştırırken `-u`, Compose'da `user:`. Uygulamanın gerçekten root gerektirdiği durumlar nadirdir: 1024 altı port için capability (aşağıda) ya da yüksek port + nginx yeterli.

## 2. Capability'ler

Linux, root'un yetkilerini yaklaşık 40 parçaya böler: `CAP_NET_BIND_SERVICE` (düşük port), `CAP_CHOWN`, `CAP_SYS_ADMIN` (neredeyse her şey), `CAP_NET_RAW` (ham soket, ping)... Docker varsayılan olarak root konteynere bunların **küçük bir alt kümesini** verir:

```bash
docker run --rm alpine grep CapEff /proc/1/status
capsh --decode=$(docker run --rm alpine grep CapEff /proc/1/status | cut -f2)
docker run --rm --cap-drop ALL alpine grep CapEff /proc/1/status
```

(`capsh` host'ta `libcap2-bin` paketinden gelir, yoksa `apt-get install -y libcap2-bin`.)

Varsayılan listede `chown`, `dac_override` (dosya izinlerini atlama), `setuid`, `net_raw`, `net_bind_service`, `kill` gibi yetkiler var. Uygulamanın bunların çoğuna ihtiyacı yok. En güvenli yaklaşım: **hepsini kaldır, sadece gerekeni ekle.**

```bash
docker run --rm --cap-drop ALL alpine sh -c 'chown nobody /tmp; ping -c1 -W1 127.0.0.1' 2>&1
docker run --rm --cap-drop ALL -u 1000 python:3.12-alpine sh -c "cat /proc/sys/net/ipv4/ip_unprivileged_port_start; python -c \"import socket; s=socket.socket(); s.bind(('0.0.0.0', 80)); print('80 portu bağlandı, root değilim, capability yok')\""
```

- `--cap-drop ALL` ile `chown` ve `ping` başarısız oldu: root olsa bile yapamadı.
- Root olmayan ve hiç capability'si olmayan bir kullanıcı 80 portunu açabildi. Sebep: Docker 20.10'dan beri konteynerin ağ namespace'inde `ip_unprivileged_port_start` değeri `0`. Konteynerin kendi ağında "düşük port" kısıtı yok, yani web sunucularını root olmadan çalıştırmak için capability bile gerekmiyor. `NET_BIND_SERVICE` sadece `--network host` gibi host'un ağ namespace'ini kullanan durumlarda gerekir.

Compose karşılığı:

```yaml
    cap_drop: [ALL]
    cap_add: [CHOWN]      # sadece gerçekten gerekiyorsa, tek tek
```

> **`--privileged` asla.** Bu seçenek bütün capability'leri verir, seccomp ve AppArmor'u kapatır ve host'un **bütün aygıtlarına** erişim sağlar. Yani konteyner, host'un disklerini bağlayıp okuyabilir.

```bash
docker run --rm alpine sh -c 'ls /dev | head; fdisk -l 2>&1 | head -2'
docker run --rm --privileged alpine sh -c 'ls /dev | wc -l; fdisk -l 2>/dev/null | grep -E "^Disk /dev" | head -3'
```

Ayrıcalıklı konteyner host'un disklerini gördü. Buradan `mount /dev/sda1 /mnt` ile host'un dosya sistemine yazmak bir adımdır. Belirli bir aygıt gerekiyorsa sadece onu ver: `--device /dev/ttyUSB0`.

## 3. no-new-privileges

Konteynerde root olmayan bir kullanıcı bile, imajda **setuid** bir program (`su`, `sudo`, `passwd`, ya da saldırganın bir şekilde koyduğu bir ikili) varsa onu çalıştırarak root olabilir. `no-new-privileges` bayrağı, bir sürecin `exec` ile yetki kazanmasını çekirdek seviyesinde engeller:

```bash
cat > /tmp/Dockerfile.suid <<'EOF'
FROM alpine:3.20
RUN cp /bin/busybox /usr/local/bin/kok && chmod 4755 /usr/local/bin/kok && adduser -D app
USER app
EOF
docker build -q -t suid-deneme -f /tmp/Dockerfile.suid /tmp
docker run --rm suid-deneme sh -c 'id; /usr/local/bin/kok sh -c id'
docker run --rm --security-opt no-new-privileges suid-deneme sh -c 'id; /usr/local/bin/kok sh -c id'
```

İlk çalıştırmada `app` kullanıcısı setuid ikili sayesinde `euid=0(root)` oldu. İkincide aynı ikili yetki kazanamadı. Compose: `security_opt: ["no-new-privileges:true"]`. Bütün konteynerler için varsayılan yapmak üzere `daemon.json`'a `"no-new-privileges": true`.

## 4. Salt okunur kök dosya sistemi

Ele geçirilmiş bir konteynerde saldırganın ilk işi genelde araç indirmek ya da bir dosyayı değiştirmektir (web kabuğu bırakmak, ayarı değiştirmek). Kök dosya sistemini salt okunur yaparsan bunların hepsi engellenir:

```bash
docker run --rm --read-only alpine sh -c 'echo x > /etc/x; echo x > /tmp/x' 2>&1
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m alpine sh -c 'echo x > /tmp/x && echo "/tmp yazılabilir"; cp /bin/busybox /tmp/bb && /tmp/bb echo calisti' 2>&1
```

- `/etc` ve `/tmp`'ye yazılamadı.
- `/tmp` tmpfs olarak yazılabilir yapıldı, ama `noexec` ile oradan **program çalıştırılamıyor**: indirilen bir aracı çalıştırma girişimi başarısız.

Uygulamanın yazması gereken yerler (upload klasörü, önbellek) volume ya da tmpfs olarak açıkça verilir. Bu, uygulamanın nereye yazdığını belgelemeye de zorlar.

## 5. seccomp ve AppArmor

Docker her konteynere varsayılan bir **seccomp** profili uygular: yaklaşık 40-50 tehlikeli sistem çağrısını (`mount`, `reboot`, `kexec_load`, çekirdek modülü yükleme, bazı `clone` bayrakları) engeller. Ubuntu'da ayrıca varsayılan bir **AppArmor** profili (`docker-default`) vardır.

```bash
docker info --format '{{json .SecurityOptions}}'
docker run --rm alpine sh -c 'grep Seccomp /proc/1/status'
docker run --rm alpine unshare -U id 2>&1 | head -1
```

`Seccomp: 2` filtre modunun aktif olduğunu gösterir. Varsayılan profil çoğu uygulama için doğru dengedir. Yapılmaması gereken: Bir şey çalışmadığında `--security-opt seccomp=unconfined` ile profili tamamen kapatmak. Gerekiyorsa varsayılan profilden türetilmiş, sadece eksik çağrıya izin veren özel bir profil yaz.

## 6. Docker soketi

Mimari dersinde söylediğimizi uygulamalı görelim. Docker soketine erişimi olan bir konteyner, host'ta **root**'tur:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock docker:cli \
  docker run --rm -v /:/host alpine sh -c 'cat /host/etc/shadow | head -2; echo "--- host hostname:"; cat /host/etc/hostname'
```

Sadece soketi bağlanmış "masum" bir konteyner, Docker'a host'un kök dizinini bağlayan yeni bir konteyner açtırdı ve host'un `/etc/shadow` dosyasını okudu. Bu konteyner ele geçirilirse sunucu da ele geçirilmiş demektir.

Soket gerçekten gerekiyorsa (CI çalıştırıcıları, Traefik gibi Docker'ı izleyen araçlar): sadece okuma işlemlerine izin veren bir **socket proxy** (örneğin `tecnativa/docker-socket-proxy`) kullan, aracın kendisini mümkünse rootless Docker ya da ayrı bir sunucuda çalıştır.

## 7. User namespace ve rootless Docker

Önceki önlemler konteynerdeki root'un **yapabileceklerini** kısıtlar. User namespace ise konteynerdeki root'u host'ta **yetkisiz bir kullanıcıya eşler**: Konteyner içinde UID 0 olan süreç, host'ta örneğin UID 100000'dir. Kaçış durumunda saldırgan yetkisiz bir kullanıcı olarak kalır.

İki yol:

- **`userns-remap`**: Daemon root olarak çalışmaya devam eder, konteynerler eşlenmiş UID'lerle çalışır (`daemon.json`: `"userns-remap": "default"`). Bütün daemon için geçerlidir, mevcut imaj ve volume'lerin sahiplikleri yeniden düzenlenir.
- **Rootless Docker**: **Daemon'un kendisi** de yetkisiz bir kullanıcı olarak çalışır (kurulum dersi). Docker soketine erişim de artık sadece o kullanıcının yetkisi demektir. Bedeli: bazı ağ ve depolama özelliklerinde sınırlamalar, 1024 altı portlar için ek ayar.

**Podman** varsayılan olarak daemon'suz ve rootless çalışır. Güvenlik öncelikli ortamlarda Docker'a alternatif olarak düşünülebilir.

## 8. Ağ, kaynaklar ve gizli bilgiler

Önceki derslerden güvenliği ilgilendirenler:

- **Ağ dersi**: Docker'ın ufw'yi atlaması. Dışa açılmaması gerekenleri yayınlama ya da `127.0.0.1:` ile yayınla. Veritabanını `internal` ağda tut.
- **Kaynak dersi**: `--memory`, `--pids-limit`. Ele geçirilmiş ya da hatalı bir konteyner sunucuyu kilitleyemesin (fork bombası, bellek tüketimi).
- **Ortam dersi ve Swarm**: Gizli bilgiler ortam değişkeninde değil, dosya ya da secret olarak.
- **İmaj dersleri**: Gizli bilgiler `ARG`/`ENV`/`COPY` ile imaja değil, BuildKit `--secret` ile.

## Hepsi bir arada

Önceki derslerdeki Go servisini (ya da herhangi bir web servisini) en sıkı ayarlarla çalıştırmak şöyle görünür:

```yaml
services:
  api:
    image: registry.ornek.com/api:1.4.0@sha256:...
    user: "65532:65532"
    read_only: true
    tmpfs: ["/tmp:rw,noexec,nosuid,size=32m"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 200
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 256M }
    networks: [on]
    # ports yok: önündeki proxy aynı ağdan erişiyor
```

## Denetim araçları

```bash
docker run --rm --net host --pid host --userns host --cap-add audit_control \
  -v /etc:/etc:ro -v /var/lib:/var/lib:ro -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --label docker_bench_security docker/docker-bench-security 2>/dev/null | grep -E '^\[WARN\]' | head -15
```

**docker-bench-security**, CIS Docker Benchmark'a göre host'u, daemon ayarlarını, imajları ve çalışan konteynerleri denetler. (Kendisi de denetim için host'a geniş erişimle çalışır, sadece güvendiğin ortamda kullan.) Çıktıdaki `[WARN]` satırları bu dersteki ayarlarla doğrudan eşleşir: root konteynerler, sınırsız bellek, `no-new-privileges` eksikliği, ayrıcalıklı konteynerler.

İmaj tedarik zinciri için:

- **Tarama**: Trivy, Grype, Docker Scout (multi-stage dersi).
- **SBOM** (yazılım malzeme listesi): `docker buildx build --sbom=true` ya da `syft imaj`. İmajda hangi paketin hangi sürümünün olduğunu belgeler. Yeni bir açık duyurulduğunda "hangi imajlarımız etkileniyor?" sorusunu saniyeler içinde cevaplar.
- **İmzalama**: `cosign` ile imajları imzalamak ve deploy sırasında imzayı doğrulamak, registry'deki bir imajın değiştirilmediğini garanti eder. CI dersinde değineceğiz.

## Temizlik

```bash
docker rmi suid-deneme 2>/dev/null; rm -rf /tmp/host-dosya
```

## Alıştırma (lab'da)

`nginx:1.27-alpine` imajını şu ayarlarla çalışır hâle getir: root olmayan kullanıcı, salt okunur kök dosya sistemi, bütün capability'ler kaldırılmış, `no-new-privileges`. İlk denemede hata alacaksın. Hata mesajlarını okuyup gereken en az ayarı ekle.

<details><summary>İpuçları ve çözüm</summary>

İlk deneme:

```bash
docker run --rm -u 101:101 --read-only --cap-drop ALL --security-opt no-new-privileges nginx:1.27-alpine 2>&1 | tail -3
```

Hatalar: `/var/cache/nginx` ve `/var/run/nginx.pid` için yazma yeri yok (salt okunur kök ve root olmayan kullanıcı), giriş betiği ayar dosyalarını değiştirmeye çalışıyor, ayrıca resmî imajın ayarı `user nginx;` satırıyla root olarak başlayıp kullanıcı değiştirmeyi bekliyor. (80 portu sorun değil: konteynerin ağında düşük port kısıtı yok.)

En temiz çözüm, root olmadan çalışmak için tasarlanmış resmî varyantı kullanmak: `nginxinc/nginx-unprivileged`. 8080 portunu dinler ve ayarları buna göre hazırdır. Geriye sadece yazılabilir klasörleri tmpfs olarak vermek kalır:

```bash
docker run -d --name sikin -p 8098:8080 \
  --read-only --tmpfs /tmp:rw,size=16m --tmpfs /var/cache/nginx:rw,size=16m \
  --cap-drop ALL --security-opt no-new-privileges \
  nginxinc/nginx-unprivileged:1.27-alpine
sleep 2; curl -s -o /dev/null -w '%{http_code}\n' localhost:8098
docker exec sikin id
docker inspect sikin --format 'readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}}'
docker rm -f sikin
```

Pek çok popüler yazılımın "unprivileged" ya da "rootless" imaj varyantı vardır. Kendi imajlarında da bu ayarlarla çalışmayı baştan hedeflemek, sonradan uyarlamaktan çok daha kolaydır.

</details>

```quiz
Bir CI aracı konteynerine `/var/run/docker.sock` bağlandı. Bu konteyner ele geçirilirse ne olur?
- Sadece diğer konteynerleri görebilir
- [x] Host'ta root yetkisi elde edebilir (host'un kökünü bağlayan yeni bir konteyner açarak)
- Hiçbir şey, soket salt okunur
? Docker API'sine erişim, host üzerinde root erişimine eşdeğerdir.
```

```quiz
Root olmayan bir kullanıcıyla çalışan konteynerde imajdaki setuid bir ikili ile root olunabildi. Bunu engelleyen ayar?
- `--read-only`
- `--cap-drop ALL`
- [x] `--security-opt no-new-privileges`
? no-new-privileges, exec ile yetki kazanmayı (setuid, dosya capability'leri) çekirdek seviyesinde engeller.
```

```quiz
Konteyner ele geçirildi ve saldırgan bir araç indirip `/tmp`'den çalıştırmaya çalışıyor. Hangi ayar kombinasyonu bunu engeller?
- `--privileged`
- [x] `--read-only` ve `--tmpfs /tmp:rw,noexec`
- `--network host`
? Kök dosya sistemi yazılamaz, yazılabilir tek yer olan /tmp'den program çalıştırılamaz.
```

```quiz
Bir uygulama konteynerde (bridge ağında) 443 portunu dinlemek zorunda. Root olarak çalışması gerekir mi?
- Evet, düşük portlar root ister
- `--privileged` gerekir
- [x] Hayır, Docker konteynerin ağında düşük port kısıtını kaldırır. Root olmayan kullanıcı ve `--cap-drop ALL` ile çalışabilir
? Docker 20.10+ konteynerlerde ip_unprivileged_port_start=0 ayarlar. Host ağında (`--network host`) ise NET_BIND_SERVICE gerekir.
```

## Özet

- Konteyner varsayılan olarak host root'uyla aynı UID'de çalışır: `USER`/`-u` ile root olmayan kullanıcı.
- `--cap-drop ALL` + sadece gerekenler. Konteyner ağında düşük port için capability gerekmez. `--privileged` asla.
- `no-new-privileges` (setuid'e karşı), `--read-only` + `tmpfs noexec` (araç indirmeye karşı).
- Varsayılan seccomp/AppArmor açık kalsın. `unconfined` değil, özel profil.
- Docker soketini konteynere bağlamak = host root'u. Gerekiyorsa socket proxy.
- userns-remap ya da rootless Docker ile konteyner root'u host'ta yetkisiz.
- docker-bench-security ile denetim. Tarama, SBOM, imzalama ile tedarik zinciri.
