# CPU/bellek sınırları, stats/top, PID 1, sinyaller, healthcheck

Varsayılan olarak bir konteynerin **hiçbir kaynak sınırı yoktur**: sızıntı yapan tek bir konteyner sunucunun bütün belleğini tüketebilir ve OOM killer'ın komşu konteynerleri ya da Docker'ın kendisini öldürmesine yol açabilir. Bu derste kaynak sınırlarını, kaynak kullanımını izlemeyi, konteynerin düzgün kapanmasını ve sağlık kontrolünü göreceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## İzleme: stats ve top

```bash
docker run -d --name yuk alpine sh -c 'while :; do :; done'
docker run -d --name sakin alpine sleep 3600
docker stats --no-stream
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}'
docker top yuk
```

| Sütun | Anlamı |
|---|---|
| `CPU %` | Bir çekirdeğe göre yüzde. 4 çekirdekte en fazla %400 olabilir |
| `MEM USAGE / LIMIT` | Kullanılan / sınır. Sınır yoksa host'un toplam belleği görünür |
| `NET I/O`, `BLOCK I/O` | Ağ ve disk trafiği |
| `PIDS` | Konteynerdeki süreç + iş parçacığı sayısı |

`docker stats` (`--no-stream` olmadan) canlı güncellenir. `docker top` konteynerdeki süreçleri **host'taki PID'leriyle** gösterir.

> `MEM USAGE`, Linux kursundaki `free` mantığıyla aynı değildir: Docker bu değerden sayfa önbelleğinin geri alınabilir kısmını düşer. Yine de dosya yoğun çalışan bir konteynerde değer, uygulamanın gerçek kullanımından yüksek görünebilir.

## Bellek sınırı

```bash
docker run -d --name bellek --memory 64m alpine sleep 3600
docker stats --no-stream bellek --format '{{.Name}} {{.MemUsage}}'
docker exec bellek cat /sys/fs/cgroup/memory.max
docker rm -f bellek
```

Sınırı aşınca ne olur? Belleği sürekli büyüten bir süreç:

```bash
docker run --name oom --memory 32m --memory-swap 32m alpine sh -c 'x=a; while true; do x=$x$x; done'
docker inspect oom --format 'çıkış={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}'
dmesg -T 2>/dev/null | grep -i -E 'killed process|memory cgroup' | tail -2
docker rm oom
```

Çıkış kodu **137** (SIGKILL) ve `OOMKilled=true`. Çekirdeğin cgroup OOM'u süreci öldürdü. Host'ta başka hiçbir şey etkilenmedi: sınır tam olarak bunun için var.

| Seçenek | Anlamı |
|---|---|
| `--memory 512m` | Sert sınır. Aşılınca OOM |
| `--memory-swap 512m` | Bellek + swap toplamı. `--memory` ile eşit verilirse **swap kullanılmaz**. Verilmezse swap'ı olan host'ta varsayılan olarak bellek sınırının iki katı kadar (bellek + aynı miktar swap) kullanılabilir |
| `--memory-reservation 256m` | Yumuşak sınır: host bellek sıkıntısındayken çekirdek konteyneri bu seviyeye çekmeye çalışır |
| `--oom-score-adj` | OOM killer'ın bu konteyneri seçme önceliği |

### Uygulama sınırı biliyor mu?

Konteyner içinde `free` ya da `/proc/meminfo` hâlâ **host'un** toplam belleğini gösterir (namespace'ler belleği sanallaştırmaz). Kendi bellek yönetimini yapan çalışma ortamlarında bu önemli:

- **Java (JDK 10+)**: cgroup sınırını otomatik tanır. Heap'i `-XX:MaxRAMPercentage=75` gibi oranla vermek, sabit `-Xmx`'ten daha doğrudur.
- **Node.js**: V8 heap sınırını kullanılabilir belleğe göre seçer. Güncel sürümler cgroup sınırını hesaba katar, ama sürümden sürüme davranış değişti. Sınırlı konteynerde `--max-old-space-size` (MB) ile, örneğin bellek sınırının %75'i, açıkça vermek öngörülebilir sonuç verir.
- **Python**: Çöp toplayıcı sınırı bilmez. gunicorn'da worker sayısı × worker başına bellek < sınır olmalı.
- **Worker sayısını CPU'dan hesaplayan uygulamalar** (`cpu_count()`): Host'un CPU sayısını görür. 64 çekirdekli host'ta, `--cpus 2` sınırlı bir konteyner 129 gunicorn worker'ı açmaya çalışabilir. Worker sayısını ortam değişkeniyle açıkça ver.

```bash
docker run --rm --memory 128m --cpus 1 alpine sh -c 'echo "free toplam: $(free -m | awk "/Mem/ {print \$2}") MB"; echo "cgroup sınırı: $(( $(cat /sys/fs/cgroup/memory.max) / 1048576 )) MB"; echo "nproc: $(nproc)"; echo "cpu.max: $(cat /sys/fs/cgroup/cpu.max)"'
```

## CPU sınırı

```bash
docker update --cpus 0.5 yuk
sleep 3; docker stats --no-stream yuk --format '{{.Name}} {{.CPUPerc}}'
docker exec yuk cat /sys/fs/cgroup/cpu.max
```

`docker update` çalışan bir konteynerin sınırlarını yeniden başlatmadan değiştirir. CPU kullanımı %50 civarına indi.

| Seçenek | Anlamı |
|---|---|
| `--cpus 1.5` | En fazla 1.5 çekirdeklik zaman (CFS kotası: `cpu.max`). Sert sınır |
| `--cpu-shares 512` | **Göreli ağırlık** (varsayılan 1024). Sadece CPU için rekabet olduğunda etkili. Boş sunucuda sınırlamaz |
| `--cpuset-cpus 0,1` | Sadece belirli çekirdeklerde çalış |

Sert CPU sınırının bir yan etkisi **kısma (throttling)**: Sınır 100 ms'lik dönemlerde uygulanır. Kısa süre yoğun CPU kullanan bir uygulama kotasını dönemin başında bitirirse, dönemin geri kalanında bekletilir. Sonuç, ortalama CPU düşük görünürken yanıt sürelerinde sıçramalardır:

```bash
docker exec yuk cat /sys/fs/cgroup/cpu.stat
```

`nr_throttled` ve `throttled_usec` artıyorsa konteyner sınıra takılıyor. Gecikmeye duyarlı servislerde çok sıkı CPU sınırı yerine `--cpu-shares` ya da daha cömert bir `--cpus` tercih edilir.

### Diğer sınırlar

```bash
docker run --rm --pids-limit 50 alpine sh -c 'for i in $(seq 1 100); do sleep 30 & done; wait' 2>&1 | tail -2
docker run --rm --ulimit nofile=1024:2048 alpine sh -c 'ulimit -n'
```

- `--pids-limit`: Fork bombasına ve iş parçacığı sızıntısına karşı. Sınır aşılınca yeni süreç açılamaz ("can't fork").
- `--ulimit nofile=soft:hard`: Açık dosya sınırı (Linux kursundaki `LimitNOFILE` karşılığı).

Bütün sınırlar `daemon.json` üzerinden varsayılan olarak da verilebilir (`default-ulimits`). Compose'da `deploy.resources` altında yazılır.

## PID 1 ve sinyaller

Linux kursunda (süreçler dersi) gördük: Çekirdek PID 1'e özel davranır. Konteynerde ana süreç PID 1'dir ve iki sorumluluğu vardır:

1. **Sinyaller**: PID 1, işleyici tanımlamadığı sinyalleri **almaz**. Varsayılan "SIGTERM gelince öl" davranışı PID 1 için geçerli değildir. SIGTERM'i yakalamayan bir uygulama `docker stop` ile durmaz, 10 saniye sonra SIGKILL yer.
2. **Zombileri toplamak**: Yetim kalan süreçler PID 1'e devredilir. PID 1 onları `wait()` ile toplamazsa zombi olarak birikirler.

```bash
docker run -d --name inatci alpine sleep 3600
time docker stop inatci
docker inspect inatci --format 'çıkış={{.State.ExitCode}}'
docker rm inatci
```

`sleep` SIGTERM işleyicisi tanımlamaz ve PID 1 olduğu için sinyal görmezden gelinir. 10 saniye sonra SIGKILL: kod 137.

### --init

Docker'ın `--init` seçeneği, PID 1 olarak küçük bir init süreci (**tini**) başlatır. tini sinyalleri uygulamaya iletir ve zombileri toplar:

```bash
docker run -d --name nazik --init alpine sleep 3600
docker exec nazik ps
time docker stop nazik
docker inspect nazik --format 'çıkış={{.State.ExitCode}}'
docker rm nazik
```

PID 1 artık `/sbin/docker-init`, `sleep` onun çocuğu. `stop` anında bitti, çıkış kodu 143 (SIGTERM ile sonlandı).

Ne zaman gerekir?

- Uygulama SIGTERM'i kendisi düzgün işliyorsa (gunicorn, nginx, işleyicisi yazılmış Go/Node servisi) **gerekmez**, ama zararı da yoktur.
- Uygulama alt süreçler başlatıyorsa (kabuk betikleri, Chrome/Puppeteer, bazı build araçları) zombi birikimine karşı **gerekir**.
- Bunu imajda kalıcı yapmak için Dockerfile'da `tini` kur ve `ENTRYPOINT ["tini", "--", "uygulama"]` yaz. Compose'da `init: true`.

### STOPSIGNAL ve süre

Bazı uygulamalar düzgün kapanma için SIGTERM dışında bir sinyal bekler (nginx `SIGQUIT` ile "açık bağlantıları bitirip kapan" yapar). Dockerfile'da `STOPSIGNAL SIGQUIT`, ya da `docker run --stop-signal`. Kapanması 10 saniyeden uzun süren uygulamalar için `docker stop -t 30` ya da `--stop-timeout 30` (Compose: `stop_grace_period`).

## Healthcheck

Konteynerin **çalışıyor** olması, **sağlıklı** olduğu anlamına gelmez: süreç ayakta ama veritabanı bağlantısı kopmuş, kilitlenmiş ya da 500 dönüyor olabilir. `HEALTHCHECK` Docker'a düzenli olarak çalıştıracağı bir kontrol komutu verir:

```bash
mkdir -p ~/hc && cd ~/hc
cat > Dockerfile <<'EOF'
FROM nginx:1.27-alpine
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
EOF
docker build -q -t web:hc .
docker run -d --name hc web:hc
for i in 1 2 3 4; do docker ps --filter name=hc --format '{{.Names}} {{.Status}}'; sleep 3; done
```

Durum önce `(health: starting)`, sonra `(healthy)`. Şimdi bozalım:

```bash
docker exec hc rm /usr/share/nginx/html/index.html
sleep 20
docker ps --filter name=hc --format '{{.Names}} {{.Status}}'
docker inspect hc --format '{{json .State.Health}}' | head -c 600; echo
```

`(unhealthy)` ve `Health.Log` içinde son kontrollerin çıktıları (403 nedeniyle `wget` hatası).

| Seçenek | Anlamı |
|---|---|
| `--interval` | Kontroller arası süre |
| `--timeout` | Bir kontrolün en fazla süresi |
| `--start-period` | Açılış süresi. Bu sürede başarısızlıklar sayılmaz |
| `--retries` | Kaç ardışık başarısızlıktan sonra `unhealthy` |

Önemli bir nokta: **Tek başına Docker, `unhealthy` konteyneri yeniden başlatmaz.** Sağlık durumu bilgi amaçlıdır. Onu kullanan şeyler: Compose'daki `depends_on: condition: service_healthy` (Compose dersi), Swarm (sağlıksız görevleri değiştirir) ve izleme araçları. Kubernetes ise kendi probe mekanizmasını kullanır ve Docker `HEALTHCHECK`'ini yok sayar.

Healthcheck yazarken:

- Komut **imajda bulunmalı**. Distroless imajlarda `curl`/`wget` yoktur. Uygulamanın kendisine bir `-healthcheck` modu ekle ya da küçük bir statik ikili kullan.
- Kontrol **hafif** olmalı: her 5 saniyede ağır bir veritabanı sorgusu atmak, sağlık kontrolünü yük kaynağına çevirir.
- "Canlı mı?" (süreç cevap veriyor mu) ile "hazır mı?" (bağımlılıklarıyla birlikte istek alabilir mi) farklı sorulardır. Kubernetes kursunda ikisini ayrı göreceğiz.

```bash
docker rm -f hc yuk sakin; cd ~
```

## Alıştırma (lab'da)

1. `python:3.12-slim` ile 256 MB bellek ve 1 CPU sınırlı bir konteyner başlat. İçeride `os.cpu_count()` ne gösteriyor? cgroup'tan gerçek sınırları okuyan tek satırlık bir Python komutu yaz.
2. Çalışan bir konteynerin bellek sınırını `docker update` ile değiştir. Değişikliği `docker stats` ve `memory.max` ile doğrula.
3. `alpine sh -c 'trap "echo SIGTERM aldım; exit 0" TERM; while :; do sleep 1; done'` komutuyla bir konteyner başlat. `docker stop` ne kadar sürüyor? Neden `sleep 3600` ile başlatılan konteynerden farklı?

<details><summary>Çözüm</summary>

```bash
docker run --rm --memory 256m --cpus 1 python:3.12-slim python -c "
import os
print('os.cpu_count():', os.cpu_count())
q, p = open('/sys/fs/cgroup/cpu.max').read().split()
print('cpu sınırı:', 'yok' if q == 'max' else int(q) / int(p))
print('bellek sınırı MB:', int(open('/sys/fs/cgroup/memory.max').read()) // 2**20)
"

docker run -d --name g alpine sleep 3600
docker update --memory 100m --memory-swap 100m g
docker stats --no-stream g --format '{{.MemUsage}}'; docker exec g cat /sys/fs/cgroup/memory.max
docker rm -f g

docker run -d --name t alpine sh -c 'trap "echo SIGTERM aldım; exit 0" TERM; while :; do sleep 1; done'
time docker stop t; docker logs t; docker inspect t --format '{{.State.ExitCode}}'; docker rm t
```

1: `os.cpu_count()` host'un çekirdek sayısını verir. Gerçek sınır `cpu.max`'tan okunmalıdır (Python 3.13'te `os.process_cpu_count()` da var, ama o da cgroup kotasını değil, CPU affinity'yi dikkate alır).

3: Yaklaşık 1 saniye sürer ve çıkış kodu 0'dır. Kabuk PID 1 ama SIGTERM için bir **işleyici tanımladı** (`trap`). PID 1 korumasında işleyicisi olan sinyaller teslim edilir. `sleep 3600` ise işleyici tanımlamadığı için sinyal yok sayıldı. 1 saniyelik gecikme, kabuğun `sleep 1` bitmesini bekleyip sonra trap'i çalıştırmasından kaynaklanır.

</details>

```quiz
Konteynerin çıkış kodu 137 ve `OOMKilled=true`. Ne oldu?
- Uygulama kendi isteğiyle kapandı
- [x] Bellek sınırı aşıldı ve çekirdek süreci SIGKILL ile öldürdü
- docker stop çalıştırıldı
? 137 = 128 + 9 (SIGKILL). OOMKilled alanı sebebin bellek olduğunu doğrular.
```

```quiz
Konteyner `unhealthy` durumuna geçti. Docker (Compose/Swarm olmadan) ne yapar?
- Konteyneri yeniden başlatır
- Konteyneri siler
- [x] Hiçbir şey, sadece durumu raporlar
? Sağlık durumunu kullanan Swarm, Compose depends_on ve izleme araçlarıdır.
```

```quiz
`--cpus 2` sınırlı konteynerde uygulama `cpu_count()` ile 64 worker açıyor. Neden ve çözüm?
- CPU sınırı çalışmıyor
- [x] `cpu_count()` host'un çekirdek sayısını görür. Worker sayısını ortam değişkeniyle açıkça ver
- Konteyner yeniden başlatılmalı
? Namespace'ler CPU sayısını gizlemez. cgroup kotası cpu.max dosyasındadır.
```

```quiz
Konteyner bir kabuk betiğiyle alt süreçler başlatıyor ve zamanla `<defunct>` süreçler birikiyor. En basit çözüm?
- `--restart always`
- [x] `--init` (tini) ile çalıştırmak
- Bellek sınırını artırmak
? PID 1 yetimleri toplamakla yükümlüdür. tini bu işi yapar ve sinyalleri iletir.
```

## Özet

- Varsayılan sınır yok. `--memory` (+ `--memory-swap` eşit), `--cpus`, `--pids-limit`, `--ulimit`.
- OOM = 137 + `OOMKilled=true`. `docker update` ile canlı değişiklik. CPU kısması `cpu.stat`'ta.
- Uygulamalar host'un bellek/CPU sayısını görür: worker ve heap sınırlarını açıkça ver.
- PID 1 işleyicisiz sinyalleri almaz ve zombileri toplamalı: SIGTERM işle ya da `--init`.
- `HEALTHCHECK`: interval/timeout/start-period/retries. Docker tek başına unhealthy'i yeniden başlatmaz.
