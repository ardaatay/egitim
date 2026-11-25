# Konteyner sorun giderme: inspect, events, nsenter, debug

Linux kursundaki teşhis akışı konteynerlerde de geçerli, ama iki şey değişir: Sorunlu süreç bir namespace'in içinde olduğu için host'tan bakınca farklı görünür, ve imajlar genelde teşhis aracı içermez (distroless'ta kabuk bile yok). Bu derste konteynerleri **içine girmeden ya da içine araç taşıyarak** incelemeyi ve en sık karşılaşılan arızaları teşhis etmeyi göreceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## Akış

```text
1. Durum:     docker ps -a, docker compose ps / docker service ps --no-trunc
2. Neden çıktı?  docker inspect -f '{{json .State}}'  (ExitCode, OOMKilled, Error, Health)
3. Ne dedi?   docker logs --tail 100 (ya da --since)
4. Ne oldu?   docker events --since 30m
5. İçeride ne var?  exec / debug konteyneri / nsenter / docker cp
6. Host:      journalctl -u docker, dmesg, df -h /var/lib/docker
```

## 1-2. Konteyner neden durdu?

Önce çeşitli şekillerde ölen konteynerler üretelim:

```bash
docker run -d --name a-hata alpine sh -c 'echo "ayar bulunamadı: /etc/app.yml" >&2; exit 3'
docker run -d --name a-yok alpine /app/baslat.sh
docker run -d --name a-oom --memory 16m --memory-swap 16m alpine sh -c 'x=a; while :; do x=$x$x; done'
docker run -d --name a-izin -u 1000 alpine sh -c 'echo x > /etc/deneme'
docker run -d --name a-mimari --platform linux/arm64 alpine echo merhaba 2>/dev/null || true
sleep 3
docker ps -a --format 'table {{.Names}}\t{{.Status}}' | grep a-
```

Her biri için tek satırlık bir teşhis:

```bash
for c in a-hata a-yok a-oom a-izin a-mimari; do
  docker inspect $c --format "{{.Name}}: kod={{.State.ExitCode}} oom={{.State.OOMKilled}} hata='{{.State.Error}}'" 2>/dev/null
done
```

| Belirti | Sebep | Bakılacak |
|---|---|---|
| Kod uygulamaya özgü (1, 3...), `Error` boş | Uygulama kendi isteğiyle çıktı | `docker logs` |
| Kod 127, `Error`: "no such file or directory" | Komut ya da ENTRYPOINT imajda yok, yanlış yol, ya da betiğin shebang'indeki yorumlayıcı yok (Alpine'de `#!/bin/bash`) | `docker run --entrypoint sh imaj -c 'ls -l /app'` |
| Kod 126, "permission denied" | Çalıştırma izni yok (`chmod +x` unutulmuş), ya da noexec bir yerden çalıştırma | Dockerfile, izinler |
| Kod 137, `OOMKilled=true` | Bellek sınırı | Sınır, uygulamanın heap ayarı |
| Kod 137, `OOMKilled=false` | Dışarıdan SIGKILL: `docker kill`, `stop` süresi doldu, host OOM | `docker events`, `dmesg` |
| "exec format error" | Mimari uyuşmazlığı (arm64 imaj amd64 host'ta ya da tersi) | `docker image inspect --format '{{.Architecture}}'` |
| Uygulama "permission denied" diye loglayıp çıkıyor | UID ile dosya/volume sahipliği uyuşmuyor | `docker run --rm -u X ... id; ls -ln` |

Bunlara bir tane daha ekle: **"Konteyner hemen Exited (0) oluyor"**. Hata yok, ama ana süreç bitti: ön planda bir şey çalışmıyor (servis kendini arka plana atıyor, ya da `CMD` bir kabuk ve stdin yok). İkinci derste görmüştük.

### Açılmayan konteynerin içine bakmak

Konteyner açılışta çöktüğü için `docker exec` yapamazsın. Aynı imajı, **ENTRYPOINT'i değiştirerek** etkileşimli başlat:

```bash
docker run --rm -it --entrypoint sh alpine
```

İçeride dosyaları, ortamı, izinleri elle kontrol edebilirsin. Ana komutu da elle çalıştırıp hatayı doğrudan görürsün. Çöken konteynerin **kendi dosya sistemi** (yazılabilir katman dahil) için:

```bash
docker commit a-izin inceleme:1
docker run --rm -it --entrypoint sh inceleme:1
```

Ya da hiç çalıştırmadan dosya kopyala:

```bash
docker cp a-hata:/etc/os-release - | tar -xO | head -2
docker cp a-hata:/etc/hostname ./hostname-kopya && cat ./hostname-kopya
```

`docker cp` durmuş konteynerlerde de çalışır.

## 4. docker events

Docker daemon'u her olayı (oluşturma, başlatma, ölme, OOM, healthcheck sonucu, ağ bağlantısı, imaj çekme) bir olay akışına yazar. "Gece ne oldu?" sorusunun cevabı:

```bash
docker events --since 10m --until 0s --filter type=container --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}}' | tail -20
```

Canlı izlemek için `--until` olmadan çalıştır. Sık kullanılan filtreler: `--filter event=die`, `--filter event=oom`, `--filter event=health_status`, `--filter container=web`. Yeniden başlatma döngüsündeki bir konteyneri yakalamak için:

```bash
docker run -d --name dongu --restart always alpine sh -c 'sleep 2; exit 1'
timeout 15 docker events --filter container=dongu --filter event=die --format '{{.Time}} die exitCode={{.Actor.Attributes.exitCode}}'
docker inspect dongu --format 'restart sayısı: {{.RestartCount}}'
docker rm -f dongu
```

## 5. İçeride araç olmadan inceleme

Distroless ya da minimal imajlarda `sh`, `ps`, `curl`, `ss` yoktur. Üç yöntem:

### a) Namespace paylaşan bir hata ayıklama konteyneri

Araç dolu bir imajı, hedef konteynerin **ağ ve süreç namespace'lerine** katılarak başlat:

```bash
docker run -d --name hedef nginx:1.27-alpine
docker run --rm -it --network container:hedef --pid container:hedef nicolaka/netshoot sh -c 'ps aux; echo; ss -tlnp; echo; curl -sI localhost | head -1'
```

`ps` hedef konteynerin süreçlerini, `ss` onun portlarını, `curl localhost` onun nginx'ini gösterdi. Hedef konteynerin dosya sistemine de `/proc/1/root` üzerinden erişebilirsin:

```bash
docker run --rm --pid container:hedef alpine ls /proc/1/root/etc/nginx/conf.d
```

Kubernetes'teki `kubectl debug` ve "ephemeral container" kavramı aynı yöntemin otomatik hâlidir. Docker Desktop'taki (ve yeni Docker CLI'larındaki) `docker debug` komutu da benzer şekilde, imajı değiştirmeden konteynere araç dolu bir kabuk ekler.

### b) nsenter: host'un araçlarıyla

İlk derste gördüğümüz gibi, host'taki araçları konteynerin namespace'lerinde çalıştırabilirsin:

```bash
P=$(docker inspect -f '{{.State.Pid}}' hedef)
nsenter -t $P -n ss -tlnp
nsenter -t $P -n ip addr show eth0
nsenter -t $P -m -p ps aux 2>/dev/null || nsenter -t $P -p -r ps aux
```

`-n` ağ, `-m` mount, `-p` PID namespace'i. Özellikle ağ teşhisinde (`-n`) her zaman çalışır, çünkü dosya sistemi host'unki kalır.

### c) strace ve host'tan görülen süreç

Konteynerdeki süreç host'ta sıradan bir süreç olduğu için Linux kursundaki `strace`, `/proc/PID/...`, `lsof -p` doğrudan kullanılabilir:

```bash
apt-get install -y strace >/dev/null 2>&1
W=$(pgrep -f 'nginx: worker' | head -1)
timeout 5 strace -p $W -e trace=accept4,recvfrom,writev,openat 2>&1 & sleep 1; docker exec hedef wget -q -O /dev/null http://127.0.0.1/; wait
ls -l /proc/$W/root/etc/nginx/ | head -3
```

## Sık karşılaşılan durumlar

### Konteynerden DNS çözülmüyor

```bash
docker run --rm alpine nslookup github.com
docker run --rm alpine cat /etc/resolv.conf
```

Kontrol listesi: Varsayılan bridge'de konteyner host'un `/etc/resolv.conf`'undaki sunucuları kullanır. Host `127.0.0.53` (systemd-resolved) kullanıyorsa Docker bunu konteynere kopyalayamaz (konteynerin loopback'i farklı) ve gerçek üst sunuculara geçer. Şirket içi DNS gerekiyorsa `daemon.json`'da `"dns": ["10.0.0.2"]` ya da `--dns`. Kullanıcı tanımlı ağlarda `127.0.0.11` aracı olur ve dış adları host'un ayarına göre iletir.

### "no space left on device"

```bash
df -h /var/lib/docker
df -i /var/lib/docker
docker system df
du -sh /var/lib/docker/containers/*/*-json.log 2>/dev/null | sort -rh | head -3
```

Sırasıyla: konteyner logları (log sınırı yok mu?), kullanılmayan imajlar ve build önbelleği (`image prune -a`, `builder prune`), yetim volume'ler, ya da konteynerin yazılabilir katmanına yazılan büyük dosyalar (`docker ps -s` ile konteyner başına boyut). İnode dolması da (`df -i`) overlay ile çok küçük dosya üreten iş yüklerinde görülür.

### Daemon tarafı

```bash
systemctl status docker --no-pager | head -5
journalctl -u docker --since "1 hour ago" --no-pager | tail -20
docker info 2>&1 | grep -i -E 'warning|error'
```

Daemon açılmıyorsa genelde sebep `daemon.json`'daki bir hata, dolu bir disk ya da depolama sürücüsü sorunudur. `docker info` sonundaki `WARNING` satırları (swap sınırı desteklenmiyor, IP yönlendirme kapalı) da sık sorun kaynağıdır.

## Temizlik

```bash
docker rm -f a-hata a-yok a-oom a-izin a-mimari hedef 2>/dev/null
docker rmi inceleme:1 2>/dev/null
```

## Alıştırma (lab'da)

Aşağıdaki komut, açılışta bir şeyler ters giden bir uygulama başlatır. Sadece bu derste öğrendiğin araçlarla sorunları bul:

```bash
mkdir -p ~/gizem && cd ~/gizem
cat > Dockerfile <<'EOF'
FROM alpine:3.20
RUN adduser -D -u 1000 app && mkdir /veri
COPY baslat.sh /baslat.sh
USER app
ENTRYPOINT ["/baslat.sh"]
EOF
printf '#!/bin/bash\necho "başlıyorum"; echo ok > /veri/durum; exec sleep 3600\n' > baslat.sh
docker build -q -t gizem:1 . && docker run -d --name gizem gizem:1
sleep 2; docker ps -a --filter name=gizem
```

<details><summary>İpuçları ve çözüm</summary>

```bash
docker inspect gizem --format 'kod={{.State.ExitCode}} hata={{.State.Error}}'
docker logs gizem
docker run --rm --entrypoint sh gizem:1 -c 'ls -l /baslat.sh; head -1 /baslat.sh; ls /bin/bash; ls -ld /veri; id'
```

Üç sorun var, sırayla ortaya çıkar:

1. `baslat.sh` çalıştırma izni yok (`COPY` dosyanın host'taki iznini korur, `printf` ile oluşturulan dosya `644`): kod 126 ya da "permission denied". Düzeltme: `chmod +x baslat.sh` ya da Dockerfile'da `COPY --chmod=755`.
2. Shebang `#!/bin/bash` ama Alpine'de bash yok: "no such file or directory" (kod 127). Dosya var ama yorumlayıcısı yok. Düzeltme: `#!/bin/sh`.
3. `/veri` klasörü root'a ait, uygulama UID 1000 ile çalışıyor: "Permission denied". Düzeltme: Dockerfile'da `RUN adduser ... && mkdir /veri && chown app /veri`.

```bash
sed -i '1s|.*|#!/bin/sh|' baslat.sh
sed -i 's|RUN adduser -D -u 1000 app \&\& mkdir /veri|RUN adduser -D -u 1000 app \&\& mkdir /veri \&\& chown app /veri|; s|COPY baslat.sh /baslat.sh|COPY --chmod=755 baslat.sh /baslat.sh|' Dockerfile
docker rm -f gizem; docker build -q -t gizem:2 . && docker run -d --name gizem gizem:2
sleep 2; docker ps --filter name=gizem; docker logs gizem; docker exec gizem cat /veri/durum
docker rm -f gizem; cd ~
```

</details>

```quiz
Konteyner `exec /app/start.sh: no such file or directory` hatasıyla kapanıyor ama `docker run --entrypoint sh imaj -c 'ls -l /app/start.sh'` dosyayı gösteriyor. En olası sebep?
- Dosya bozuk
- [x] Betiğin shebang'indeki yorumlayıcı (örneğin /bin/bash) imajda yok, ya da dosyada Windows satır sonları (CRLF) var
- Konteyner root değil
? Çekirdek yorumlayıcıyı bulamayınca "no such file" der. CRLF'li bir shebang `bash\r` diye var olmayan bir program arar.
```

```quiz
Distroless bir konteynerin hangi portları dinlediğini görmek istiyorsun. Konteynerde kabuk yok. En pratik yöntem?
- İmaja `ss` ekleyip yeniden build etmek
- [x] `docker run --rm --network container:hedef nicolaka/netshoot ss -tlnp` ya da `nsenter -t PID -n ss -tlnp`
- `docker logs`
? Hedefin ağ namespace'ine katılan bir hata ayıklama konteyneri ya da host'un araçlarıyla nsenter.
```

```quiz
Konteyner gece yeniden başlamış. Ne zaman ve hangi çıkış koduyla durduğunu nasıl bulursun?
- `docker logs`
- [x] `docker events --since 12h --filter container=X --filter event=die`
- `docker ps`
? Olay akışı die, oom, restart ve health olaylarını zaman damgası ve çıkış koduyla tutar.
```

## Özet

- Önce `inspect` ile `State` (ExitCode, OOMKilled, Error), sonra `logs`, sonra `events`.
- 127 komut/yorumlayıcı yok, 126 izin, 137 + OOMKilled bellek, "exec format error" mimari.
- Açılmayan konteyner: `run --entrypoint sh`, `commit` + inceleme, `docker cp`.
- Araçsız konteyner: `--network/--pid container:X` ile netshoot, `nsenter`, host'tan `strace` ve `/proc/PID/root`.
- DNS, disk (`system df`, loglar, inode) ve daemon (`journalctl -u docker`) sorunları.
