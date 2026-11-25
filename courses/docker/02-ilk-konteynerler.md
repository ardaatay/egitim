# Docker mimarisi ve konteyner yaşam döngüsü

`docker run` yazdığında birkaç ayrı program devreye girer. Hangi parçanın ne yaptığını bilmek, "daemon yeniden başlayınca konteynerlerim ne oldu?", "neden konteyner hemen kapanıyor?", "loglar nerede?" gibi soruları cevaplamanı sağlar. Bu derste mimariyi ve bir konteynerin baştan sona yaşam döngüsünü göreceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## Parçalar

```text
docker (CLI)  ──REST API──▶  dockerd  ──gRPC──▶  containerd  ──▶  containerd-shim ──▶ runc ──▶ [süreç]
   istemci         /var/run/docker.sock      imaj, konteyner,     her konteyner için    namespace,
                                              snapshot yönetimi    küçük bir ebeveyn     cgroup kurar,
                                                                                         exec edip çıkar
```

| Parça | Görevi |
|---|---|
| **`docker` CLI** | Sadece bir istemci. Komutları daemon'un REST API'sine çevirir |
| **`dockerd`** | Docker daemon'u: API, imaj build, ağlar, volume'ler, loglar |
| **containerd** | Konteyner çalışma zamanı: imajları çeker, saklar, konteynerleri başlatır/durdurur. Kubernetes de doğrudan containerd kullanır |
| **containerd-shim** | Her konteynerin ebeveyni. dockerd ya da containerd yeniden başlasa bile konteyner çalışmaya devam eder |
| **runc** | OCI standardına uygun düşük seviyeli araç: önceki dersteki namespace/cgroup kurulumunu yapar, uygulamayı exec eder ve çıkar |

İki önemli sonuç:

1. **`/var/run/docker.sock`'a erişimi olan, root'tur.** Bu sokete yazabilen biri `docker run -v /:/host --privileged ...` ile host'un tamamına erişebilir. Bir kullanıcıyı `docker` grubuna eklemek, ona fiilen parolasız root yetkisi vermek demektir. Socket'i bir konteynere bağlamak (CI araçları, Portainer, Traefik) da aynı riski taşır.
2. **Uzak daemon.** CLI başka bir makinedeki daemon ile konuşabilir: `DOCKER_HOST=ssh://deploy@sunucu docker ps`. Docker Desktop da böyle çalışır: CLI senin bilgisayarında, daemon bir Linux VM'inde.

```bash
docker version            # istemci ve sunucu sürümleri ayrı ayrı
docker info | head -30    # depolama sürücüsü, cgroup sürümü, konteyner sayıları
systemctl status docker containerd --no-pager | grep -E 'Active|Main PID'
ps -ef | grep -E 'dockerd|containerd' | grep -v grep
```

## İlk konteyner ve ne olduğu

```bash
docker run hello-world
```

Çıktının kendisi bu adımları anlatır: CLI daemon'a bağlandı, daemon imajı yerelde bulamadı ve Docker Hub'dan çekti, imajdan bir konteyner oluşturdu, içindeki programı çalıştırdı, çıktıyı CLI'a aktardı. Program bitti, konteyner de durdu.

```bash
docker ps          # çalışan konteyner yok
docker ps -a       # durmuş olanlar dahil: hello-world "Exited (0)"
```

**Konteyner, ana süreci yaşadığı sürece yaşar.** PID 1 biterse konteyner durur. "Konteynerim başlayıp hemen kapanıyor" sorununun cevabı neredeyse her zaman budur: ana süreç ya hata verip çıktı ya da arka plana geçtiği (daemonize olduğu) için ön planda bir şey kalmadı.

## run'ın önemli seçenekleri

```bash
docker run -d --name web -p 8080:80 nginx:1.27-alpine
docker ps
curl -s localhost:8080 | head -4
```

| Seçenek | Anlamı |
|---|---|
| `-d` | Arka planda (detached) çalıştır, konteyner kimliğini yaz |
| `--name web` | İsim ver. Verilmezse rastgele bir isim (`brave_curie`) atanır |
| `-p 8080:80` | Host'un 8080'ini konteynerin 80'ine yönlendir (**host:konteyner**) |
| `-e KEY=val`, `--env-file` | Ortam değişkenleri |
| `-v`, `--mount` | Volume ve bind mount (depolama dersi) |
| `--rm` | Konteyner durunca otomatik sil (tek seferlik işler için) |
| `-it` | Etkileşimli terminal (`-i` stdin açık, `-t` sözde terminal) |
| `--restart` | Yeniden başlatma politikası (aşağıda) |
| `-u 1000:1000` | Hangi kullanıcıyla çalışacağı |
| `--memory`, `--cpus` | Kaynak sınırları |

İmajdan sonra yazılanlar konteynerin komutunu **değiştirir**:

```bash
docker run --rm alpine echo "merhaba"
docker run --rm alpine cat /etc/os-release
docker run --rm -it alpine sh        # içeride bir kabuk. exit ile çık
```

## Konteynerin içine bakmak

```bash
docker logs web                    # stdout/stderr
docker logs -f --tail 20 web       # canlı takip
curl -s localhost:8080 > /dev/null; docker logs --tail 1 web
docker exec web nginx -v
docker exec -it web sh             # çalışan konteynerde kabuk
docker inspect web | head -40      # tüm ayarlar, JSON
docker inspect -f '{{.NetworkSettings.IPAddress}} {{.State.Status}} {{.RestartCount}}' web
docker stats --no-stream           # CPU, bellek, ağ, G/Ç
docker top web                     # host'tan görülen süreçler
docker port web
docker diff web                    # imaja göre değişen dosyalar
```

- **`docker logs`**, uygulamanın **stdout ve stderr**'ini gösterir. Uygulama logunu bir dosyaya yazıyorsa `docker logs` boş kalır. Bu yüzden resmî nginx imajı `/var/log/nginx/access.log`'u `/dev/stdout`'a link'ler. Kendi imajlarında da logları stdout'a yaz (Linux kursundaki "12-factor" ilkesi).
- **`docker exec`**, konteynerin namespace'lerinde **yeni bir süreç** başlatır (önceki dersteki `nsenter`). Konteynerin ana süreci değildir. Bu kabukta yaptığın değişiklikler konteyner silinince kaybolur.
- **`docker diff`**: `A` eklenen, `C` değişen, `D` silinen dosyalar. Bir konteynerin çalışırken diske ne yazdığını görmek için.

## Yaşam döngüsü

```text
             create          start            (ana süreç biter / stop)
  imaj ──────────────▶ Created ──────▶ Running ─────────────────────▶ Exited ──── rm ───▶ (yok)
                                       │   ▲                          │
                                 pause │   │ unpause            start │ (aynı konteyner,
                                       ▼   │                          │  aynı dosya sistemi)
                                       Paused                         ▼
                                                                    Running
```

```bash
docker stop web          # SIGTERM, 10 sn sonra SIGKILL
docker ps -a --filter name=web
docker start web         # aynı konteyner, aynı yazılabilir katman
docker restart web
docker kill -s HUP web   # istediğin sinyali gönder (nginx: ayarları yeniden yükle)
docker rm -f web         # çalışıyorsa öldür ve sil
```

**`docker stop`** Linux kursundaki doğru kapanma sırasını uygular: önce SIGTERM, `-t` süresi (varsayılan 10 sn) dolunca SIGKILL. Konteyneriniz her `stop`'ta tam 10 saniye bekliyorsa, ana süreç SIGTERM'i işlemiyor demektir (PID 1 sorunu, kaynak ve sinyaller dersi).

`stop` + `start`, konteynerin **yazılabilir katmanını korur**. `rm` ise siler. Konteynerin içine yazılan her şey (`docker exec` ile kurulan paketler, uygulamanın ürettiği dosyalar) konteyner silinince gider. Kalıcı olması gereken veri **volume**'de durmalıdır.

### Çıkış kodları

```bash
docker run --name c1 alpine sh -c 'exit 3'; docker inspect -f '{{.State.ExitCode}}' c1
docker run -d --name c2 alpine sleep 300; docker kill c2; docker inspect -f '{{.State.ExitCode}}' c2
docker run --name c3 --memory 20m alpine sh -c 'x=a; while true; do x=$x$x; done'; docker inspect -f '{{.State.ExitCode}} OOM={{.State.OOMKilled}}' c3
docker rm c1 c2 c3
```

| Kod | Anlamı |
|---|---|
| `0` | Normal çıkış |
| `1`, `2`, ... | Uygulamanın kendi hata kodu |
| `125` | Docker'ın kendisi hata verdi (geçersiz seçenek) |
| `126` | Komut çalıştırılamadı (izin) |
| `127` | Komut bulunamadı (imajda yok, yanlış yol) |
| `137` | SIGKILL (128+9): `docker kill`, `stop` süresi doldu ya da **OOM** |
| `143` | SIGTERM (128+15) ile düzgün sonlandı |

`137` görünce `OOMKilled` alanına bak: `true` ise bellek sınırı aşıldı.

## Yeniden başlatma politikaları

```bash
docker run -d --name cokuyor --restart on-failure:3 alpine sh -c 'echo başladım; sleep 2; exit 1'
sleep 15
docker ps -a --filter name=cokuyor
docker inspect -f 'restart={{.RestartCount}} durum={{.State.Status}}' cokuyor
docker logs cokuyor
docker rm -f cokuyor
```

| Politika | Ne zaman yeniden başlatır |
|---|---|
| `no` (varsayılan) | Hiçbir zaman |
| `on-failure[:N]` | Sıfır olmayan kodla çıkınca, en fazla N kez |
| `always` | Her durumda. Elle `stop` edilse bile daemon yeniden başlayınca başlatır |
| `unless-stopped` | `always` gibi, ama elle durdurulduysa daemon yeniden başlayınca başlatmaz |

Tek sunucuda servis gibi çalışan konteynerler için genelde `unless-stopped` kullanılır. Docker, art arda çöküşlerde beklemeyi her seferinde iki katına çıkarır (100 ms, 200 ms, ...), systemd'nin başlangıç sınırına benzer şekilde sonsuz döngüyü yavaşlatır.

> **systemd mi, Docker restart politikası mı?** İkisini aynı konteyner için birlikte kullanma: `--restart always` olan bir konteyneri bir de systemd servisinden `docker run` ile başlatırsan iki yönetici birbirine karışır. Tek sunucuda Docker'ın kendi politikası ya da Compose yeterlidir. Docker'ı systemd ile yönetmek istiyorsan (bağımlılık sırası, journald entegrasyonu) **Podman + Quadlet** buna göre tasarlanmıştır.

## Temizlik

Konteynerler, imajlar ve build önbelleği zamanla diski doldurur (Linux kursundaki "disk doldu" senaryosunun sık bir sebebi):

```bash
docker system df                  # ne kadar yer kaplıyorlar
docker container prune -f         # durmuş konteynerler
docker image prune -f             # etiketsiz (dangling) imajlar
docker image prune -a --filter until=168h -f   # 7 günden eski, kullanılmayan tüm imajlar
docker builder prune -f           # build önbelleği
docker system prune -f            # hepsi (volume'ler hariç)
```

> **Dikkat:** `docker system prune --volumes` kullanılmayan **volume'leri de** siler. Durdurulmuş bir veritabanı konteynerinin volume'ü "kullanılmayan" sayılabilir. Volume silme işlemini her zaman bilerek ve tek tek yap.

## Alıştırma (lab'da)

1. `nginx:1.27-alpine` imajından `site` adında bir konteyneri arka planda, host'un 8081 portuna yayınlayarak başlat. İçine `docker exec` ile girip `/usr/share/nginx/html/index.html` dosyasını değiştir, `curl` ile doğrula.
2. Konteyneri durdurup başlat. Değişiklik duruyor mu? Sonra silip aynı komutla yeniden oluştur. Şimdi?
3. `docker run alpine` neden hemen `Exited (0)` oluyor? `docker run -d alpine sleep infinity` neden çalışmaya devam ediyor?

<details><summary>Çözüm</summary>

```bash
docker run -d --name site -p 8081:80 nginx:1.27-alpine
docker exec site sh -c 'echo "<h1>değişti</h1>" > /usr/share/nginx/html/index.html'
curl -s localhost:8081
docker stop site && docker start site && curl -s localhost:8081
docker rm -f site && docker run -d --name site -p 8081:80 nginx:1.27-alpine && sleep 1 && curl -s localhost:8081 | head -4
docker rm -f site
```

2: `stop`/`start` sonrası değişiklik durur, çünkü aynı konteynerin yazılabilir katmanı korunur. `rm` + yeni `run` sonrası gider, çünkü yeni konteyner imajın temiz hâlinden başlar. Sonuç: konteyner içinde elle değişiklik yapma. Değişiklik ya imajda (Dockerfile) ya da volume'de olmalı.

3: `alpine` imajının varsayılan komutu `/bin/sh`. Terminal bağlı değilken (`-it` yok) sh stdin'den okuyacak bir şey bulamaz ve hemen çıkar. Ana süreç bitince konteyner durur. `sleep infinity` ise hiç bitmeyen bir ön plan süreci.

</details>

```quiz
Bir kullanıcıyı `docker` grubuna eklemenin güvenlik anlamı nedir?
- Sadece konteynerleri listeleyebilir
- [x] Docker soketine erişebildiği için fiilen root yetkisi kazanır
- Hiçbir risk yoktur
? Soketi kullanan biri host'un köküne bağlı, ayrıcalıklı bir konteyner başlatabilir.
```

```quiz
Konteyner `docker stop` sonrası her seferinde tam 10 saniyede duruyor ve çıkış kodu 137. Ne oluyor?
- Disk yavaş
- [x] Ana süreç SIGTERM'i işlemiyor, Docker süre dolunca SIGKILL gönderiyor
- Ağ bağlantıları kapanıyor
? Düzgün kapanan bir süreç SIGTERM ile 0 ya da 143 koduyla çıkardı.
```

```quiz
Uygulama loglarını `/app/logs/app.log` dosyasına yazıyor. `docker logs` neden boş?
- Log sürücüsü kapalı
- [x] `docker logs` sadece ana sürecin stdout/stderr'ini gösterir
- Konteyner yeniden başlatılmalı
? Konteynerlerde loglar stdout/stderr'e yazılmalı. Gerekirse log dosyası /dev/stdout'a link'lenir.
```

```quiz
Konteyneri `stop` edip `start` ettin. Konteyner içinde oluşturduğun dosya hâlâ var mı?
- Hayır, her başlatmada imaj sıfırdan açılır
- [x] Evet, aynı konteynerin yazılabilir katmanı korunur. `rm` edilince kaybolur
- Sadece /tmp'dekiler kalır
? Kalıcı veri için volume kullanılmalı. Konteyner silinip yeniden oluşturulduğunda yazılabilir katman gider.
```

## Özet

- CLI → dockerd → containerd → shim → runc → süreç. Soket erişimi = root.
- Konteyner, ana süreci (PID 1) yaşadıkça yaşar.
- `run -d --name -p host:konteyner -e --rm`, `logs -f`, `exec -it`, `inspect -f`, `stats`, `diff`.
- `stop` = SIGTERM + 10 sn + SIGKILL. 137 = SIGKILL/OOM, 143 = SIGTERM.
- `stop/start` yazılabilir katmanı korur, `rm` siler. Kalıcı veri volume'de.
- `--restart unless-stopped`, `docker system df` ve `prune` ile temizlik.
