# Ortam değişkenleri, yapılandırma, stdin/stdout/stderr ve loglar

Aynı imaj geliştirmede, testte ve üretimde çalışır. Değişen sadece **yapılandırmadır**: veritabanı adresi, log seviyesi, özellik bayrakları. Bu derste yapılandırmanın konteynere nasıl verildiğini (ve gizli bilgilerin neden ortam değişkeninde durmaması gerektiğini), konteynerin standart akışlarını ve Docker'ın log sistemini göreceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## Ortam değişkenleri

Linux kursunda gördüğümüz gibi her sürecin bir ortamı vardır ve çocuk süreçlere kopyalanır. Konteynerin ana sürecinin ortamı üç kaynaktan oluşur:

```bash
docker run --rm alpine env
docker run --rm -e LOG_LEVEL=debug -e BOLGE=tr alpine env | sort
```

| Kaynak | Örnek | Öncelik |
|---|---|---|
| Dockerfile `ENV` | `ENV LOG_LEVEL=info` | En düşük (imajın varsayılanı) |
| `--env-file` | `--env-file prod.env` | Orta |
| `-e` / `--env` | `-e LOG_LEVEL=debug` | En yüksek |

Değeri vermeden sadece adı yazarsan değer **host'un ortamından** alınır:

```bash
export DB_HOST=db.ornek.local
docker run --rm -e DB_HOST alpine sh -c 'echo $DB_HOST'
```

### env dosyaları

```bash
mkdir -p ~/cfg && cd ~/cfg
cat > app.env <<'EOF'
# yorum satırları atlanır
LOG_LEVEL=info
DB_HOST=db
GREETING="merhaba dünya"
BOS=
EOF
docker run --rm --env-file app.env alpine sh -c 'env | grep -E "LOG|DB|GREETING|BOS"'
```

Dikkat: `docker run --env-file` dosyayı **kabuk gibi yorumlamaz**: `GREETING="merhaba dünya"` satırındaki tırnaklar **değerin parçası** olur, değişken genişletme (`$HOME`) yapılmaz. Compose'un `.env` dosyası ise tırnakları ve genişletmeyi destekler. İki biçim arasında dosya taşırken bu fark hataya yol açar. Docker için env dosyalarında tırnak kullanma.

### Uygulama tarafı: 12-factor

Uygulama yapılandırmayı ortamdan okumalı, mantıklı varsayılanları olmalı ve **eksik zorunlu ayarda açılışta açık bir hatayla durmalıdır** (Linux kursundaki `${VAR:?}` kalıbı). Zorunlu bir ayar eksikse saatler sonra ilk istekte çökmek yerine açılışta çökmek, deploy'u hemen başarısız yapar ve geri almayı tetikler.

### Ayar dosyası gerektiğinde

Bazı uygulamalar (nginx, Prometheus, eski Java uygulamaları) yapılandırmayı dosyadan okur. Seçenekler:

- **Bind mount ile dosya**: `-v ./nginx.conf:/etc/nginx/nginx.conf:ro` (depolama dersi).
- **Giriş betiğinde şablondan üretmek**: Resmî nginx imajı `/etc/nginx/templates/*.template` dosyalarındaki `${DEGISKEN}` ifadelerini açılışta `envsubst` ile doldurur:

```bash
mkdir -p tpl && cat > tpl/default.conf.template <<'EOF'
server {
    listen ${NGINX_PORT};
    location / { return 200 "ortam: ${ORTAM}\n"; }
}
EOF
docker run -d --name ng -p 8087:8080 -e NGINX_PORT=8080 -e ORTAM=staging -v $PWD/tpl:/etc/nginx/templates:ro nginx:1.27-alpine
sleep 1; curl -s localhost:8087
docker exec ng cat /etc/nginx/conf.d/default.conf
docker rm -f ng
```

## Gizli bilgiler ortam değişkeninde olmamalı

Ortam değişkenleri pratik ama gizli bilgi (parola, API anahtarı) için zayıf bir yer:

```bash
docker run -d --name sizinti -e DB_PASSWORD=cok-gizli alpine sleep 3600
docker inspect sizinti --format '{{.Config.Env}}'
docker exec sizinti cat /proc/1/environ | tr '\0' '\n' | grep PASS
```

- `docker inspect` yetkisi olan herkes (yani Docker soketine erişen herkes) değeri düz metin görür.
- Süreç içinde `/proc/PID/environ` ile okunabilir ve **bütün çocuk süreçlere** aktarılır.
- Uygulamalar hata raporlarında, hata ayıklama sayfalarında ve log satırlarında ortamı sıklıkla döker.

Daha güvenli yol: Gizli bilgiyi **dosya olarak** vermek (izinleri kısıtlı bir bind mount, ya da Swarm/Compose secrets: `/run/secrets/db_password`). Pek çok resmî imaj bunu `_FILE` sonekiyle destekler:

```bash
echo -n "cok-gizli" > ~/cfg/db_password && chmod 600 ~/cfg/db_password
docker run -d --name pg -e POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  -v ~/cfg/db_password:/run/secrets/db_password:ro postgres:16-alpine
sleep 4
docker inspect pg --format '{{.Config.Env}}' | tr ' ' '\n' | grep -i pass
docker rm -f pg sizinti
```

`inspect` çıktısında sadece dosyanın **yolu** var, parolanın kendisi yok. Kendi uygulamalarında da aynı kalıbı destekle: `DB_PASSWORD_FILE` verilmişse dosyadan oku. Swarm bölümünde secret'ları ayrıntılı göreceğiz.

## stdin, stdout, stderr

Linux kursundaki fd 0/1/2 konteynerde de aynıdır. Docker bunları şöyle bağlar:

| Seçenek | Etki |
|---|---|
| (hiçbiri, `-d` yok) | stdout ve stderr senin terminaline aktarılır, stdin bağlı değil |
| `-d` | Akışlar terminale bağlanmaz, log sürücüsüne gider |
| `-i` | stdin açık tutulur (konteynere veri **gönderebilirsin**) |
| `-t` | Sözde terminal (TTY) ayrılır: renkler, satır düzenleme, Ctrl+C |

`-i` ile konteynere boru üzerinden veri gönderebilirsin. Host'ta kurulu olmayan araçları kullanmanın pratik bir yolu:

```bash
echo '{"ad":"arda","rol":"admin"}' | docker run --rm -i ghcr.io/jqlang/jq:latest '.rol'
docker run --rm -i alpine sort < /etc/passwd | head -3
docker run --rm -i postgres:16-alpine psql --version
```

**Borularla kullanırken `-t` verme.** TTY, satır sonlarını `\r\n`'e çevirir ve stdout ile stderr'i tek akışta birleştirir. `docker run -t ... > dosya` ile oluşturulan dosyalarda garip `^M` karakterleri görürsün. Kural: etkileşimli kabuk için `-it`, boru ve betikler için sadece `-i` (ya da hiçbiri).

### attach ve detach

```bash
docker run -d --name sayac alpine sh -c 'i=0; while true; do i=$((i+1)); echo "satır $i"; sleep 1; done'
timeout 3 docker attach --no-stdin sayac; echo
docker rm -f sayac
```

`docker attach` çalışan konteynerin **ana sürecinin** akışlarına bağlanır (`docker exec`'ten farklı olarak yeni süreç başlatmaz). Dikkat: `-it` ile attach olduğun bir konteynerde Ctrl+C, sinyali **konteynerin ana sürecine** gönderir ve konteyneri durdurur. Durdurmadan ayrılmak için **Ctrl+P, Ctrl+Q** tuş dizisi kullanılır.

## Loglar

Konteynerin stdout ve stderr'i **log sürücüsüne** gider. `docker logs` bu kayıtları okur:

```bash
docker run -d --name app alpine sh -c 'while true; do echo "INFO istek işlendi"; echo "ERROR bağlantı hatası" >&2; sleep 2; done'
sleep 5
docker logs app
docker logs app 2>/dev/null | head -3
docker logs --tail 4 -t app
docker logs --since 3s app
docker logs -f --tail 0 app &
sleep 5; kill %1
```

| Seçenek | İşlev |
|---|---|
| `-f` | Canlı takip (`tail -f`) |
| `--tail N` | Son N satır (`--tail 0` ile sadece yeniler) |
| `-t` | Her satıra Docker'ın zaman damgası |
| `--since`, `--until` | `10m`, `1h` ya da `2026-11-25T10:30:00` |

`docker logs` stdout'u stdout'a, stderr'i stderr'e yazar. Bu yüzden `2>/dev/null` hata satırlarını gizledi. Hepsini `grep`'lemek için `docker logs app 2>&1 | grep ERROR`.

### Log sürücüleri

```bash
docker info --format '{{.LoggingDriver}}'
docker inspect app --format '{{.HostConfig.LogConfig}}'
docker inspect app --format '{{.LogPath}}'
```

| Sürücü | Nereye | Not |
|---|---|---|
| `json-file` | `/var/lib/docker/containers/<id>/<id>-json.log` | Varsayılan. **Sınırsız büyür** (`max-size` ver) |
| `local` | Aynı klasörde, sıkıştırılmış ikili biçim | Varsayılan döndürme ile. Tek sunucu için önerilen |
| `journald` | systemd journal | `journalctl CONTAINER_NAME=app` ile sorgulanır. Linux kursundaki bütün journal bilgisi geçerli |
| `syslog`, `gelf`, `fluentd`, `awslogs`, `gcplogs`, `splunk` | Uzak log sistemleri | Merkezi loglama |
| `none` | Hiçbir yer | |

Docker 20.10'dan beri uzak sürücüler kullanılsa bile **"dual logging"** sayesinde `docker logs` çalışmaya devam eder (yerel bir önbellek tutulur). Kurulum dersinde `daemon.json` ile varsayılanı ayarlamıştık. Konteyner bazında da verilebilir:

```bash
docker run -d --name jlog --log-driver journald alpine sh -c 'echo "journal kaydı"; sleep 300'
sleep 1; journalctl CONTAINER_NAME=jlog --no-pager -n 3 2>/dev/null || echo "journald yok"
docker run -d --name sinirli --log-opt max-size=1m --log-opt max-file=3 alpine sh -c 'yes "log satırı" | head -200000; sleep 300'
sleep 3; ls -lh $(dirname $(docker inspect sinirli --format '{{.LogPath}}'))
docker rm -f app jlog sinirli
```

`sinirli` konteynerinin log klasöründe en fazla 3 dosya ve her biri 1 MB'tan küçük.

### Engelleyici ve engellemeyen loglama

Log sürücüsü yazamadığında (uzak sunucu yavaş ya da erişilemez) varsayılan **blocking** modda uygulamanın stdout'a yazma çağrısı **bekler**. Uzak bir log sunucusundaki sorun, uygulamanın kilitlenmesine dönüşebilir. `--log-opt mode=non-blocking --log-opt max-buffer-size=4m` ile loglar bir tamponda tutulur ve tampon dolarsa satırlar atılır: uygulama hiç beklemez, bedeli olası log kaybıdır. Uzak sürücülerde non-blocking düşünülmelidir.

### İyi log pratikleri

- Uygulama logları **stdout/stderr**'e yazar, dosyaya değil. Döndürme ve taşıma Docker'ın işidir.
- **Tamponlamayı kapat**: Python'da `PYTHONUNBUFFERED=1`, aksi hâlde loglar gecikir ve çökmede kaybolur (Dockerfile dersi).
- **Yapılandırılmış (JSON) loglar**: Merkezi log sistemlerinde alan bazlı arama ve filtreleme sağlar (`{"level":"error","msg":"...","order_id":42}`).
- Log seviyesi ortam değişkeniyle ayarlanabilir olsun, ama üretimde debug'ı açık bırakma: Linux kursundaki "disk doldu" ve journald hız sınırı senaryoları hatırla.

## Alıştırma (lab'da)

1. Dockerfile'da `ENV MOD=imaj` olan bir imaj üret. `--env-file` ile `MOD=dosya`, `-e MOD=komut` ile çalıştırıp hangi değerin kazandığını göster. Sonra sadece `--env-file` ile çalıştır.
2. Bir konteyneri `json-file` sürücüsü, `max-size=100k`, `max-file=2` ile başlatıp çok miktarda log yazdır. Log klasöründeki dosyaları ve `docker logs | wc -l` sonucunu karşılaştır. Neden bütün satırlar görünmüyor?

<details><summary>Çözüm</summary>

```bash
mkdir -p ~/envtest && cd ~/envtest
printf 'FROM alpine:3.20\nENV MOD=imaj\nCMD ["sh","-c","echo MOD=$MOD"]\n' > Dockerfile
docker build -q -t envtest .
echo "MOD=dosya" > m.env
docker run --rm envtest
docker run --rm --env-file m.env envtest
docker run --rm --env-file m.env -e MOD=komut envtest

docker run -d --name lg --log-driver json-file --log-opt max-size=100k --log-opt max-file=2 alpine sh -c 'seq 1 100000; sleep 300'
sleep 3
ls -lh $(dirname $(docker inspect lg --format '{{.LogPath}}'))
docker logs lg | wc -l
docker logs lg | head -1
docker rm -f lg; cd ~
```

1: `imaj` → `dosya` → `komut`. `-e` en yüksek önceliğe sahip.

2: Toplam log en fazla yaklaşık 200 KB tutulur, eski satırlar döndürmede silinir. `docker logs` sadece diskte kalanları gösterir. `head -1` çıktısı 1 değil, çok daha büyük bir sayıdır. Log sınırı koymak, eski logları kaybetmeyi kabul etmektir. Uzun süre saklanması gereken loglar merkezi bir sisteme gönderilmelidir.

</details>

```quiz
`docker run --env-file` ile verilen dosyada `API_URL="https://x"` satırı var. Uygulama URL'yi geçersiz buluyor. Neden?
- Dosya okunmadı
- [x] `docker run --env-file` tırnakları yorumlamaz, tırnaklar değerin parçası oldu
- HTTPS desteklenmiyor
? Compose .env dosyaları tırnakları işler, docker run --env-file işlemez.
```

```quiz
Veritabanı parolasını konteynere vermenin en güvenli yolu hangisi?
- `-e DB_PASSWORD=...`
- Dockerfile'da `ENV DB_PASSWORD=...`
- [x] Kısıtlı izinli bir dosya olarak bağlayıp `*_FILE` değişkeniyle yolunu vermek (ya da Swarm/Compose secrets)
? Ortam değişkenleri `docker inspect` ve `/proc/PID/environ` ile okunabilir, çocuk süreçlere geçer ve hata raporlarına sızar.
```

```quiz
`docker run -t imaj komut > cikti.txt` ile oluşan dosyada satır sonlarında `^M` var. Sebep?
- Dosya Windows'ta açıldı
- [x] `-t` sözde terminal ayırdı ve satır sonlarını `\r\n`'e çevirdi
- İmaj bozuk
? Boru ve dosya yönlendirmelerinde `-t` kullanılmaz, gerekirse sadece `-i`.
```

```quiz
Uzak log sunucusu yavaşladığında uygulama da yavaşlıyor. Ne yapılabilir?
- Log seviyesini kapatmak
- [x] Log sürücüsünü `mode=non-blocking` ve bir `max-buffer-size` ile ayarlamak
- Konteyneri yeniden başlatmak
? Varsayılan blocking modda stdout'a yazma, sürücü yazana kadar bekler.
```

## Özet

- Ortam önceliği: Dockerfile `ENV` < `--env-file` < `-e`. `--env-file` tırnak ve genişletme yapmaz.
- Zorunlu ayar eksikse uygulama açılışta açık bir hatayla durmalı.
- Gizli bilgiler ortam değişkeninde değil, dosyada (`*_FILE`, secrets).
- `-i` stdin, `-t` TTY. Borularda `-t` yok. attach'tan ayrılmak Ctrl+P, Ctrl+Q.
- `docker logs -f --tail --since -t`. Sürücüler: `local`/`json-file` (sınır ver), `journald`, uzak sürücüler (non-blocking düşün).
- Uygulama stdout'a, tamponsuz, tercihen JSON yazar.
