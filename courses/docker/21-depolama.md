# Depolama: volume (boş/dolu davranışı), bind mount, tmpfs

İmajlar dersinde gördük: konteynerin yazılabilir katmanı konteyner silinince gider ve overlay üzerinden yazmak yavaştır. Kalıcı olması gereken her şey (veritabanı dosyaları, kullanıcı yüklemeleri, uygulamanın ürettiği raporlar) konteynerin **dışında**, bir bağlama noktasında durmalıdır. Docker'da üç tür bağlama var ve her birinin davranışı farklı.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## Üç tür

```text
         Host                                          Konteyner
  /var/lib/docker/volumes/veri/_data  ── volume ──▶  /var/lib/postgresql/data
  /home/arda/proje                    ── bind ────▶  /app
  (RAM)                               ── tmpfs ───▶  /tmp
```

| Tür | Nerede | Kim yönetir | Ne zaman |
|---|---|---|---|
| **Volume** | `/var/lib/docker/volumes/<ad>/_data` | Docker (`docker volume`) | **Kalıcı uygulama verisi**: veritabanları, yüklemeler |
| **Bind mount** | Host'ta senin seçtiğin herhangi bir yol | Sen | Geliştirmede kaynak kod, host'tan verilen ayar dosyaları |
| **tmpfs** | Host'un belleği | Çekirdek | Diske hiç yazılmaması gereken geçici veri, hız |

## Söz dizimi: -v ve --mount

İki yazım da var:

```bash
docker run -v veri:/data ...                              # volume
docker run -v /home/arda/proje:/app ...                   # bind (yol / ile başlıyorsa)
docker run --mount type=volume,source=veri,target=/data ...
docker run --mount type=bind,source=/home/arda/proje,target=/app,readonly ...
docker run --mount type=tmpfs,target=/tmp,tmpfs-size=64m ...
```

`-v` kısadır ama bir tuzağı var: Bind mount için verdiğin host yolu yoksa `-v` onu **root sahipliğinde boş bir klasör olarak oluşturur** ve hiçbir hata vermez. Yazım hatalı bir yol, uygulamanın sessizce boş bir klasörle çalışmasına yol açar. `--mount` ise yol yoksa hata verir. Betiklerde ve üretimde `--mount` daha güvenlidir.

## Volume'ler

```bash
docker volume create veri
docker volume ls
docker volume inspect veri
docker run --rm -v veri:/data alpine sh -c 'echo "kalıcı kayıt $(date)" >> /data/kayit.txt'
docker run --rm -v veri:/data alpine sh -c 'echo "ikinci kayıt" >> /data/kayit.txt'
docker run --rm -v veri:/data alpine cat /data/kayit.txt
sudo ls -l /var/lib/docker/volumes/veri/_data
```

İki ayrı (ve `--rm` ile silinmiş) konteyner aynı veriye yazdı. Volume, konteynerden bağımsız yaşar.

Gerçek bir örnek: PostgreSQL'i volume ile çalıştır, konteyneri sil, yenisini aynı volume ile başlat:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=gizli -v pgdata:/var/lib/postgresql/data postgres:16-alpine
sleep 5
docker exec pg psql -U postgres -c "CREATE TABLE odeme(id int, tutar numeric); INSERT INTO odeme VALUES (1, 120.5);"
docker rm -f pg
docker run -d --name pg -e POSTGRES_PASSWORD=gizli -v pgdata:/var/lib/postgresql/data postgres:16-alpine
sleep 5
docker exec pg psql -U postgres -c "SELECT * FROM odeme;"
```

Veri yerinde. Veritabanı imajını güncellemek (16.3 → 16.4) de aynı şekilde yapılır: konteyneri sil, yeni imajla aynı volume'ü bağla. (Ana sürüm atlamalarında, örneğin 16 → 17, veri biçimi değiştiği için `pg_upgrade` ya da dump/restore gerekir.)

### İsimsiz volume'ler

Ad vermeden `-v /data` yazarsan ya da imajda `VOLUME /data` talimatı varsa, Docker rastgele adlı bir **isimsiz volume** oluşturur:

```bash
docker run -d --name pg2 -e POSTGRES_PASSWORD=x postgres:16-alpine
docker inspect pg2 --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{end}}'
docker rm -f pg2
docker volume ls
```

`postgres` imajının Dockerfile'ında `VOLUME /var/lib/postgresql/data` olduğu için, sen bir şey belirtmesen de veri isimsiz bir volume'e yazıldı. Konteyner silinince volume **yetim** kaldı: diskte duruyor ama kimse onu bilmiyor. Bunlar zamanla birikir.

- `docker rm -v konteyner` isimsiz volume'leri de siler. `docker run --rm` ile başlatılan konteynerlerin isimsiz volume'leri otomatik silinir.
- `docker volume prune` kullanılmayan **isimsiz** volume'leri siler (yeni sürümlerde varsayılan davranış). İsimli olanlar için `--all` gerekir.
- Kalıcı veriye **her zaman ad ver**.

## Boş ve dolu volume davranışı

Bu, Docker'ın en sık şaşırtan davranışlarından biri:

> **Boş bir volume**, imajın o klasördeki içeriğiyle bağlanırsa, Docker imajdaki dosyaları önce **volume'e kopyalar**. **Dolu bir volume** ise olduğu gibi bağlanır ve imajın içeriğini gizler. **Bind mount** hiçbir zaman kopyalama yapmaz: host klasörü ne içeriyorsa o görünür, imajın içeriği gizlenir.

Deneyelim. nginx imajında `/usr/share/nginx/html` içinde `index.html` ve `50x.html` var:

```bash
docker run --rm nginx:1.27-alpine ls /usr/share/nginx/html

# 1) Boş isimli volume: imaj içeriği volume'e kopyalanır
docker volume create html
docker run --rm -v html:/usr/share/nginx/html nginx:1.27-alpine ls /usr/share/nginx/html

# 2) Artık dolu volume: kendi içeriği görünür. Bir dosya ekleyelim
docker run --rm -v html:/usr/share/nginx/html alpine sh -c 'echo ozel > /usr/share/nginx/html/ozel.html'
docker run --rm -v html:/usr/share/nginx/html nginx:1.27-alpine ls /usr/share/nginx/html

# 3) Bind mount: boş host klasörü imaj içeriğini gizler
mkdir -p /tmp/bos-html
docker run --rm -v /tmp/bos-html:/usr/share/nginx/html nginx:1.27-alpine ls -la /usr/share/nginx/html
```

1. Boş volume, imajdaki iki dosyayla dolduruldu.
2. Volume artık dolu. İçeriği (eklediğimiz dosya dahil) kalıcı.
3. Bind mount'ta klasör boş: nginx'in varsayılan sayfaları **gizlendi**, kopyalanmadı.

Bunun iki pratik sonucu var:

- **Güncelleme tuzağı:** Bir imaj, kendi statik dosyalarını volume'e koyan bir uygulama ise (örneğin bir CMS'in eklentileri ya da bir frontend'in derlenmiş dosyaları), volume ilk çalıştırmada dolar. İmajın **yeni sürümünü** çalıştırdığında volume artık dolu olduğu için yeni dosyalar kopyalanmaz, uygulama eski dosyalarla çalışır. Kod ile veri aynı volume'de olmamalı.
- **"Ayar dosyam kayboldu":** Bir ayar dosyasını değiştirmek için bütün `/etc/nginx` klasörünü boş bir host klasörüyle bind mount edersen, imajdaki bütün ayar dosyaları gizlenir ve nginx açılmaz. Tek bir dosyayı bağla (`-v ./default.conf:/etc/nginx/conf.d/default.conf:ro`) ya da `conf.d` gibi alt klasörü kullan.

## Bind mount'lar

```bash
mkdir -p ~/site && echo "<h1>host'tan geliyor</h1>" > ~/site/index.html
docker run -d --name site -p 8085:80 --mount type=bind,source=$HOME/site,target=/usr/share/nginx/html,readonly nginx:1.27-alpine
curl -s localhost:8085
echo "<h1>değişti, yeniden başlatmadan</h1>" > ~/site/index.html
curl -s localhost:8085
docker exec site sh -c 'echo x > /usr/share/nginx/html/yaz.txt' || echo "salt okunur"
docker rm -f site
```

Bind mount, host'taki dosyaların **canlı** görünümüdür: host'ta yapılan değişiklik konteynerde anında görünür. Geliştirme ortamında kodu bağlayıp "kaydet, yenile" döngüsü böyle kurulur. Konteynerin yazması gerekmiyorsa her zaman **`readonly`** (ya da `-v ...:ro`) ekle.

Bilinen bir istisna: Tek bir **dosyayı** bind mount ettiysen ve host'ta o dosyayı `vim` gibi "yeni dosya yazıp yeniden adlandıran" bir editörle değiştirirsen, konteyner eski dosyayı görmeye devam eder. Linux kursundaki inode meselesi: bind mount dosya adını değil inode'u bağlar. Klasör bağlamak bu sorunu yaşamaz.

### İzinler: UID uyuşmazlığı

Bind mount'ta dosyaların sahipliği **sayısal UID/GID** üzerinden çalışır ve host'taki kullanıcı adlarının konteynerde bir anlamı yoktur:

```bash
mkdir -p /tmp/paylasim && chown 1000:1000 /tmp/paylasim && chmod 755 /tmp/paylasim
docker run --rm -v /tmp/paylasim:/veri alpine sh -c 'id; touch /veri/root-yazdi'
docker run --rm -u 1000:1000 -v /tmp/paylasim:/veri alpine sh -c 'id; touch /veri/1000-yazdi'
docker run --rm -u 2000:2000 -v /tmp/paylasim:/veri alpine sh -c 'id; touch /veri/2000-yazdi' || echo "2000 yazamadı"
ls -ln /tmp/paylasim
```

- Konteynerdeki root (UID 0) host'ta da root olduğu için her yere yazar ve oluşturduğu dosyalar host'ta **root'a ait** olur. Geliştirme ortamında "konteyner çalıştıktan sonra proje klasöründeki dosyaları silemiyorum" şikâyetinin sebebi budur.
- UID 1000 ile çalışan konteyner, sahibi UID 1000 olan klasöre yazabildi.
- UID 2000 yazamadı.

Çözümler: Konteyneri host kullanıcısının UID'siyle çalıştır (`-u $(id -u):$(id -g)`), imajdaki kullanıcının UID'sini host'takiyle eşleştir, ya da named volume kullan (volume'lerde imajdaki klasörün sahipliği de kopyalanır).

SELinux'lu sistemlerde (RHEL, Fedora) bind mount'lara ayrıca `:z` (paylaşımlı) ya da `:Z` (konteynere özel) etiketi eklenmesi gerekir, yoksa "Permission denied" alınır.

## tmpfs

```bash
docker run --rm --mount type=tmpfs,target=/cache,tmpfs-size=16m alpine sh -c 'df -h /cache; dd if=/dev/zero of=/cache/x bs=1M count=20 2>&1 | tail -1'
```

tmpfs RAM'de durur (Linux kursundaki sorun giderme dersinin 4. arızası), konteyner durunca kaybolur ve boyutu sınırlanabilir. Kullanım alanları: diske yazılmaması gereken geçici gizli dosyalar, salt okunur kök dosya sistemiyle çalışan konteynerlerin (güvenlik dersi) yazması gereken `/tmp` ve önbellek klasörleri.

## Volume yedekleme ve taşıma

Volume'ün içeriğini, volume'ü ve bir yedek klasörünü bağlayan geçici bir konteynerle tar'la:

```bash
mkdir -p ~/yedek
docker run --rm -v pgdata:/kaynak:ro -v ~/yedek:/yedek alpine tar czf /yedek/pgdata-$(date +%Y%m%d).tar.gz -C /kaynak .
ls -lh ~/yedek

docker volume create pgdata-geri
docker run --rm -v pgdata-geri:/hedef -v ~/yedek:/yedek alpine sh -c "tar xzf /yedek/pgdata-*.tar.gz -C /hedef"
docker run --rm -v pgdata-geri:/d alpine ls /d | head -5
```

> **Dikkat:** Çalışan bir veritabanının dosyalarını tar ile kopyalamak **tutarlı bir yedek değildir**: kopyalama sırasında yazılan sayfalar yarım kalabilir. Veritabanları için veritabanının kendi aracını kullan (`docker exec pg pg_dump -U postgres > yedek.sql`), ya da yedek öncesi konteyneri durdur. Dosya seviyesinde yedek, durmuş konteynerler ve statik veriler için uygundur.

## Volume sürücüleri

Volume'ler de sürücülerle çalışır. Varsayılan `local` sürücüsü, `mount` seçenekleriyle NFS gibi ağ depolamasını da bağlayabilir:

```bash
docker volume create --driver local \
  --opt type=nfs --opt o=addr=10.0.0.20,rw,nfsvers=4 --opt device=:/export/yuklemeler \
  yuklemeler
```

Bulut diskleri ve dağıtık depolama için üçüncü taraf eklentiler vardır. Birden fazla sunucuda çalışan konteynerlerin aynı veriye erişmesi gerektiğinde (Swarm bölümü) bu konu önem kazanır.

## Temizlik

```bash
docker rm -f pg 2>/dev/null
docker volume ls
docker volume rm veri html pgdata pgdata-geri
docker volume prune -f
```

## Alıştırma (lab'da)

1. `redis:7-alpine` imajının hangi klasörü volume olarak tanımladığını bul (`docker image inspect`).
2. Redis'i `redisdata` adlı volume ile başlat, bir anahtar yaz, `SAVE` komutuyla diske kaydet. Konteyneri silip yenisini aynı volume ile başlat ve anahtarı oku.
3. Bir nginx konteynerinde sadece `default.conf` dosyasını host'taki bir dosyayla salt okunur olarak değiştir ve `/health` adresinde `200 ok` döndür.

<details><summary>Çözüm</summary>

```bash
docker image inspect redis:7-alpine --format '{{json .Config.Volumes}}'

docker run -d --name r1 -v redisdata:/data redis:7-alpine
sleep 1; docker exec r1 redis-cli SET sayac 42; docker exec r1 redis-cli SAVE
docker rm -f r1
docker run -d --name r2 -v redisdata:/data redis:7-alpine
sleep 1; docker exec r2 redis-cli GET sayac
docker rm -f r2; docker volume rm redisdata

mkdir -p ~/ngx && cat > ~/ngx/default.conf <<'EOF'
server {
    listen 80;
    location = /health { return 200 "ok\n"; }
    location / { root /usr/share/nginx/html; }
}
EOF
docker run -d --name n -p 8086:80 -v ~/ngx/default.conf:/etc/nginx/conf.d/default.conf:ro nginx:1.27-alpine
sleep 1; curl -s localhost:8086/health; curl -s -o /dev/null -w '%{http_code}\n' localhost:8086/
docker rm -f n
```

1: `{"/data":{}}`. 3: Sadece tek dosya bağlandığı için `nginx.conf` ve diğer ayar dosyaları imajdakiler olarak kaldı.

</details>

```quiz
Boş bir **isimli volume**'ü, imajda dosyalar bulunan `/app/static` klasörüne bağladın. Ne olur?
- Klasör boş görünür
- [x] İmajdaki dosyalar önce volume'e kopyalanır, sonra bağlanır
- Hata verir
? Sadece boş volume'lerde ve sadece volume'lerde (bind mount'ta değil) bu kopyalama yapılır.
```

```quiz
`-v /opt/uygulma/ayar:/etc/app` yazdın ama yol yanlış (`uygulma`). Ne olur?
- Docker hata verir
- [x] Docker yoksa bu yolu boş bir klasör olarak oluşturur, uygulama boş ayar klasörüyle çalışır
- Docker imajdaki ayarları kopyalar
? `--mount type=bind` ise yol yoksa hata verir. Bu yüzden betiklerde --mount daha güvenlidir.
```

```quiz
Geliştirme ortamında konteyner çalıştıktan sonra proje klasöründe silemediğin root'a ait dosyalar oluşuyor. Sebep ve çözüm?
- Disk izinleri bozuk, fsck gerekir
- [x] Konteyner root (UID 0) olarak çalışıyor. `-u $(id -u):$(id -g)` ile host kullanıcısının UID'siyle çalıştır
- Bind mount yerine tmpfs kullan
? Bind mount'ta sahiplik sayısal UID ile taşınır. Konteynerdeki root host'ta da root'tur.
```

## Özet

- Volume: Docker'ın yönettiği kalıcı veri. Bind mount: host yolu, canlı görünüm. tmpfs: RAM.
- Kalıcı veriye her zaman ad ver. İsimsiz volume'ler `VOLUME` talimatından gelir ve yetim kalır.
- Boş volume imaj içeriğiyle dolar, dolu volume ve bind mount imaj içeriğini gizler.
- Bind mount'ta yazma gerekmiyorsa `readonly`. İzinler sayısal UID ile.
- `--mount` yol yoksa hata verir, `-v` sessizce oluşturur.
- Veritabanı yedeği veritabanının kendi aracıyla. Volume'ü tar'lamak durmuş veriler için.
