# Ters vekil: yük dengeleme, HTTP önbelleği ve nginx

Uygulamanın önündeki ters vekil (nginx, Envoy, HAProxy, bir bulut yük dengeleyicisi ya da Kubernetes ingress'i) sadece istekleri iletmez. Yüksek trafikte en çok iş yapan bileşenlerden biridir:

- yükü kopyalar arasında dağıtır
- ölü kopyaları devreden çıkarır
- yanıtları önbelleğe alır
- kötüye kullanımı sınırlar
- bağlantıları yönetir

Bu derste bunların her birini nginx ile ölçüyoruz.

## Deney düzeneği

- **Arka uçlar:** Ana makinede üç Node kopyası çalışıyor. 4021 ve 4022 sağlıklı (20 ms), 4023 ise "yavaşlamış" (300 ms). Gerçek hayatta bunun nedeni gürültülü bir komşu, GC baskısı ya da bozuk bir disk olabilir.
- **Vekil:** Docker'daki `nginx:alpine` (1.31). Arka uçlara `host.docker.internal` üzerinden ulaşıyor. Docker Desktop bu adı ana makinenin loopback'ine yönlendirir, bu yüzden arka uçlar sadece `127.0.0.1`'i dinliyor.

```js
// arka.mjs — gecikmesi ayarlanabilir, çağrı sayan, ETag destekleyen arka uç
import http from "node:http";
import crypto from "node:crypto";
import { setTimeout as bekle } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 4021);
const GECIKME = Number(process.env.GECIKME_MS ?? 20);
let cagri = 0;

http.createServer(async (req, res) => {
  if (req.url === "/sayac") { res.end(JSON.stringify({ port: PORT, cagri }) + "\n"); cagri = 0; return; }
  cagri++;
  await bekle(GECIKME);
  if (req.url.startsWith("/urun/")) {
    const govde = JSON.stringify({ id: req.url.split("/")[2], fiyat: 149, sunucu: PORT });
    const etag = `"${crypto.createHash("sha1").update(govde).digest("base64url").slice(0, 16)}"`;
    res.setHeader("etag", etag);
    res.setHeader("cache-control", "public, max-age=0, s-maxage=1, stale-while-revalidate=10");
    if (req.headers["if-none-match"] === etag) { res.statusCode = 304; return res.end(); }
    res.setHeader("content-type", "application/json");
    return res.end(govde);
  }
  res.setHeader("x-sunucu", String(PORT));
  res.end(`merhaba ${PORT}\n`);
}).listen(PORT, "127.0.0.1", () => console.log(`arka uç ${PORT} gecikme=${GECIKME}ms`));
```

```nginx
# nginx.conf
worker_processes auto;
events { worker_connections 4096; }

http {
  log_format zaman '$remote_addr "$request" $status ust=$upstream_addr ust_sure=$upstream_response_time onbellek=$upstream_cache_status';
  access_log /var/log/nginx/access.log zaman;

  # Üç kopya: ikisi sağlıklı (20 ms), biri yavaşlamış (300 ms)
  upstream havuz_rr {
    zone havuz_rr 64k;
    server host.docker.internal:4021 max_fails=3 fail_timeout=5s;
    server host.docker.internal:4022 max_fails=3 fail_timeout=5s;
    server host.docker.internal:4023 max_fails=3 fail_timeout=5s;
    keepalive 64;                                   # vekil -> arka uç bağlantılarını yeniden kullan
  }
  upstream havuz_lc {
    least_conn;
    zone havuz_lc 64k;                              # durumu worker süreçleri arasında paylaş
    server host.docker.internal:4021 max_fails=3 fail_timeout=5s;
    server host.docker.internal:4022 max_fails=3 fail_timeout=5s;
    server host.docker.internal:4023 max_fails=3 fail_timeout=5s;
    keepalive 64;
  }

  proxy_http_version 1.1;                           # upstream keepalive için gerekli
  proxy_set_header Connection "";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_connect_timeout 1s;
  proxy_read_timeout 5s;
  proxy_next_upstream error timeout http_502 http_503;
  proxy_next_upstream_tries 2;

  proxy_cache_path /var/cache/nginx/mikro levels=1:2 keys_zone=mikro:10m max_size=100m inactive=60s use_temp_path=off;
  limit_req_zone $binary_remote_addr zone=istemci:10m rate=10r/s;

  server { listen 8080; location / { proxy_pass http://havuz_rr; } }
  server { listen 8081; location / { proxy_pass http://havuz_lc; } }

  # Mikro önbellek: yanıtı 1 sn sakla, aynı anahtarın ıskasında tek istek, yenilerken bayatı sun
  server {
    listen 8082;
    location / {
      proxy_pass http://havuz_lc;
      proxy_cache mikro;
      proxy_cache_key $scheme$host$request_uri;
      proxy_cache_valid 200 1s;
      proxy_cache_lock on;                          # tekil uçuş
      proxy_cache_lock_timeout 2s;
      proxy_cache_use_stale updating error timeout http_500 http_502 http_503;
      proxy_cache_background_update on;             # stale-while-revalidate
      add_header X-Onbellek $upstream_cache_status always;
    }
  }

  # Hız sınırlama: istemci başına 10 istek/sn, 20'lik ani yük payı
  server {
    listen 8083;
    location / {
      limit_req zone=istemci burst=20 nodelay;
      limit_req_status 429;
      proxy_pass http://havuz_lc;
    }
  }
}
```

```bash
PORT=4021 node arka.mjs & PORT=4022 node arka.mjs & PORT=4023 GECIKME_MS=300 node arka.mjs &
docker run -d --rm --name egitim-nginx -p 127.0.0.1:18080-18083:8080-8083 \
  -v "$PWD/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:alpine
docker exec egitim-nginx nginx -t
```

```text
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

Ana makinede 8080 portu başka bir uygulama tarafından kullanılıyordu (`port is already allocated`), bu yüzden dış portlar 18080–18083. Portların sadece `127.0.0.1`'e yayımlandığına dikkat et.

## Yük dengeleme algoritmaları

Saniyede 300 istek gönderip her iki havuzda gecikmeyi ve isteklerin kopyalara dağılımını ölçüyoruz:

```js
// vekil-test.mjs
for (const [ad, port] of [["round-robin", 18080], ["least_conn", 18081]]) {
  const r = await yukle({ url: `http://127.0.0.1:${port}/`, hiz: 300, sure: 15, tohum: 8 });
  // ... her arka ucun /sayac değerinden dağılımı hesapla
}
```

İlk denemede `upstream` bloklarında `zone` satırı yoktu:

```text
round-robin  p50=  29.4  p90= 308.7  p99= 316.2 ms  dağılım: 4021=%33 4022=%33 4023(yavaş)=%33
least_conn   p50=  26.8  p90= 305.9  p99= 315.9 ms  dağılım: 4021=%43 4022=%42 4023(yavaş)=%14
```

`zone` eklenip `nginx -s reload` yapıldıktan sonra:

```text
round-robin  p50=  28.4  p90= 308.0  p99= 314.9 ms  dağılım: 4021=%33 4022=%33 4023(yavaş)=%33
least_conn   p50=  26.4  p90=  34.6  p99= 314.9 ms  dağılım: 4021=%47 4022=%47 4023(yavaş)=%6
```

Bu iki tablo üç şey söylüyor:

- **Round-robin yavaş kopyayı görmez.** İsteklerin üçte biri 300 ms'lik kopyaya gidiyor, p90 300 ms'nin üstünde. Tek bir hasta kopya, kullanıcıların yüzde 33'ünü etkiliyor. Ağırlıklı round-robin de bunu çözmez, çünkü ağırlıklar statiktir.
- **`least_conn` geri bildirim kullanır.** Yavaş kopyadaki istekler daha uzun sürdüğü için o kopyada açık bağlantı sayısı birikir ve yeni istekler hızlı kopyalara gider. Yavaş kopyanın payı yüzde 6'ya, p90 35 ms'ye indi. p99 hâlâ 315 ms, çünkü isteklerin yüzde 6'sı hâlâ oraya gidiyor.
- **`zone` olmadan least_conn yarım çalışır.** nginx, çekirdek sayısı kadar (burada 16) worker süreci çalıştırır. Her worker kendi bağlantı sayaçlarını tutar. Paylaşılan bellek bölgesi (`zone`) olmadan her worker kararını sadece kendi gördüğü 1/16'lık trafiğe göre verir. Yük dağılımı ve sağlık durumu (`max_fails`) worker'lar arasında paylaşılmaz. Yavaş kopyanın payı sadece yüzde 14'e inebildi. Tek bir satır, p90'ı 306 ms'den 35 ms'ye düşürdü.

Dağıtık bir sistemde (her biri kendi sayaçlarını tutan çok sayıda vekil kopyası) aynı sorun büyük ölçekte tekrarlanır. "İki rastgele seç, azını al" (power of two choices) algoritması bu yüzden yaygındır: Rastgele iki kopya seçilir ve daha az yüklü olana gönderilir. Az bilgiyle neredeyse en iyi dağılımı verir, sürü davranışını (herkesin aynı "en boş" kopyaya saldırması) önler. Envoy'un `LEAST_REQUEST` politikası varsayılan olarak bu yöntemle çalışır. nginx'te `random two least_conn` olarak bulunur.

**Gecikmeye duyarlı dengeleme ve aykırı değer ayıklama** bir adım daha ileri gider. Envoy'un outlier detection özelliği ve Linkerd'in EWMA tabanlı dengelemesi, gecikmesi ya da hata oranı diğerlerinden belirgin biçimde kötü olan kopyayı **geçici olarak devreden çıkarır**. Bu durumda yavaş kopyanın payı yüzde 0'a iner ve p99 düzelir. nginx'in açık kaynak sürümündeki pasif kontrol (`max_fails`) sadece hataları ve zaman aşımlarını sayar, yavaşlığı saymaz.

## Ölü kopya ve yeniden deneme

Saniyede 200 istek gönderilirken, 4. saniyede 4022 numaralı kopya öldürülüyor:

```bash
node olu-test.mjs &           # 18081'e 200/sn, 10 sn
sleep 4; kill <4022'nin PID'i>
```

```text
4022 öldürüldü (t≈4 sn)
istek=1931 hata=0 durumlar={"200":1931} p50=26.0 p99=316.2 ms
```

```text
[error] 81#81: *783 connect() failed (111: Connection refused) while connecting to upstream, ... upstream: "http://192.168.65.254:4022/"
```

İstemci **tek bir hata görmedi**. nginx, 4022'ye bağlanamayınca (`proxy_next_upstream error`) aynı isteği başka bir kopyaya gönderdi. `max_fails=3 fail_timeout=5s` ayarıyla da kopyayı bir süre devre dışı bıraktı. Logda yalnızca bir bağlantı hatası var, ama bu bir dağıtım ya da çökme anında kullanıcıya 502 yerine başarılı bir yanıt demek. Yeniden denemenin kuralları:

- **Sadece güvenli olanı yeniden dene.** nginx varsayılan olarak, istek arka uca **gönderildikten sonra** başarısız olursa POST gibi idempotent olmayan istekleri yeniden denemez (`non_idempotent` belirtilmedikçe). Bağlanma hatası güvenlidir, çünkü istek hiç ulaşmamıştır. Okuma zaman aşımı ise güvenli değildir: Ödeme isteği arka uçta işlenmiş, sadece yanıtı gecikmiş olabilir.
- **Deneme sayısını sınırla** (`proxy_next_upstream_tries 2`). Sınırsız yeniden deneme, zaten zorlanan bir sistemde yükü katlar. Bu, dayanıklılık dersindeki "yeniden deneme fırtınası"nın vekildeki biçimidir.
- **Zaman aşımları kısa olsun.** `proxy_connect_timeout 1s`: Aynı veri merkezinde bağlantı kurmak milisaniyeler sürer. 60 saniyelik varsayılan bir bağlantı zaman aşımı, ölü bir kopyaya giden her isteği 60 saniye bekletir.

Pasif kontrolün yanında **aktif sağlık kontrolü** de gerekir. Bunu Kubernetes'te readiness probe yapar: Hazır olmayan pod, Service uç noktalarından çıkarılır. Dağıtımda sıra şöyledir: Pod `SIGTERM` alır, readiness başarısız olmaya başlar, yeni istekler kesilir, süren istekler tamamlanır, süreç çıkar. Node uygulaması `SIGTERM`'de `server.close()` çağırmalı ve keep-alive bağlantılarını kapatmalıdır (`server.closeIdleConnections()`). Ayrıca uç noktaların güncellenmesi için birkaç saniyelik bir `preStop` beklemesi gerekir. Aksi halde her dağıtımda bir avuç 502 görülür.

## HTTP önbelleği ve mikro önbellekleme

Önceki dersteki önbellek uygulamanın içindeydi. HTTP önbelleği yanıtın kendisini, uygulamaya hiç ulaşmadan saklar:

- tarayıcıda (`max-age`)
- CDN'de ya da ters vekilde (`s-maxage`)

**Mikro önbellekleme**, yanıtı sadece 1 saniye saklamak demektir. Kulağa önemsiz gelir, ama yüksek trafikte etkisi büyüktür:

```js
// vekil-test2.mjs — aynı ürün sayfasına saniyede 1000 istek
for (const [ad, port] of [["önbelleksiz (least_conn)", 18081], ["mikro önbellek 1 sn", 18082]]) {
  const r = await yukle({ url: `http://127.0.0.1:${port}/urun/1`, hiz: 1000, sure: 10, tohum: 4 });
  ...
}
```

```text
önbelleksiz (least_conn)   istek=9902  arka uca giden= 9902  p50=24.7  p99=313.9 ms
mikro önbellek 1 sn        istek=9902  arka uca giden=    6  p50=1.1  p99=2.3 ms
```

10 saniyede 9902 istek, arka uca **6** istek olarak ulaştı. Popüler bir ürün sayfası, ana sayfa ya da bir kampanya duyurusu için 1 saniyelik bayatlık neredeyse her zaman kabul edilebilir. Karşılığında arka uç yükü, trafikten bağımsız olarak "saniyede bir istek"e iner. Bu sonucu üç direktif sağlıyor. Önceki dersin kalıplarıyla birebir aynılar:

| nginx | Önceki dersteki karşılığı |
|---|---|
| `proxy_cache_lock on` | Tekil uçuş: Aynı anahtarın ıskasında arka uca tek istek gider, diğerleri bekler |
| `proxy_cache_use_stale updating` + `proxy_cache_background_update on` | Stale-while-revalidate: Yenileme sürerken bayat yanıt sunulur, yenileme arka planda yapılır |
| `proxy_cache_use_stale error timeout http_502...` | Arka uç çöktüğünde son iyi yanıtı sun: önbellek bir **dayanıklılık** aracı olur |

Önbellek durumlarını tek tek görebiliriz:

```bash
for i in 1 2 3; do curl -s -o /dev/null -D - http://127.0.0.1:18082/urun/7 | grep -i x-onbellek; done
sleep 1.5; curl -s -o /dev/null -D - http://127.0.0.1:18082/urun/7 | grep -i x-onbellek
sleep 0.3; curl -s -o /dev/null -D - http://127.0.0.1:18082/urun/7 | grep -i x-onbellek
```

```text
X-Onbellek: MISS
X-Onbellek: HIT
X-Onbellek: HIT
X-Onbellek: STALE
X-Onbellek: HIT
```

Süresi dolduktan sonraki ilk istek bayat yanıtı **hemen** aldı (`STALE`) ve arka planda yenileme başladı. Bir sonraki istek yeni yanıtı buldu (`HIT`). Hiçbir kullanıcı arka ucun 20 ms'sini beklemedi.

### Önbellek başlıkları

Önbelleğin ne yapacağını mümkün olduğunca **yanıtın kendisi** söylemelidir. Arka ucumuz şu başlığı gönderiyor:

```text
Cache-Control: public, max-age=0, s-maxage=1, stale-while-revalidate=10
```

| Direktif | Anlamı |
|---|---|
| `public` / `private` | Paylaşılan önbellekler (CDN, vekil) saklayabilir mi? Kişiye özel yanıtlar **mutlaka** `private` olmalıdır |
| `max-age=N` | Tarayıcı N saniye boyunca sunucuya sormadan kullanır |
| `s-maxage=N` | Paylaşılan önbellekler için ayrı süre (burada 1 sn mikro önbellek) |
| `stale-while-revalidate=N` | Süre dolduktan sonra N saniye boyunca bayatı sun, arka planda yenile |
| `stale-if-error=N` | Arka uç hata verirse N saniye boyunca bayatı sun |
| `no-cache` | Saklayabilirsin, ama her kullanımdan önce doğrula (ETag ile) |
| `no-store` | Hiç saklama (hassas veri) |
| `immutable` | Bu URL'nin içeriği asla değişmez. İçerik özetli statik dosyalar (`app.3f9a1c.js`) için `max-age=31536000, immutable` |

`Vary` başlığı, yanıtın hangi istek başlıklarına göre değiştiğini söyler (`Vary: Accept-Encoding, Accept-Language`). Önbellek anahtarına bu başlıklar da eklenir. `Vary: Cookie` ya da `Vary: Authorization` pratikte "paylaşma" demektir. Bir CDN'de `Vary` ve `Cache-Control: private` yanlış ayarlanırsa bir kullanıcının sayfası başka bir kullanıcıya sunulabilir. Bu gerçek ve tekrar eden bir veri sızıntısı biçimidir.

### Koşullu istekler: ETag ve 304

Önbellekteki kopyanın süresi dolduğunda, tamamını yeniden indirmek yerine "değişti mi?" diye sorulabilir:

```bash
E=$(curl -s -D - -o /dev/null http://127.0.0.1:4021/urun/7 | grep -i etag | tr -d '\r' | cut -d' ' -f2); echo "etag=$E"
curl -s -o /dev/null -w "koşullu istek: %{http_code}, gövde=%{size_download} bayt\n" -H "If-None-Match: $E" http://127.0.0.1:4021/urun/7
```

```text
etag="pJD9bqBQ4dYw9vK7"
koşullu istek: 304, gövde=0 bayt
```

`304 Not Modified` gövde taşımaz. Büyük yanıtlarda bant genişliği kazancı ciddidir. Ama dikkat: Bu arka uç ETag'i **yanıtı oluşturduktan sonra** hesaplıyor, yani veritabanı işi yine yapılıyor. Asıl kazanç için ETag ucuz bir kaynaktan, örneğin kaydın sürüm numarasından ya da `updated_at` alanından türetilmeli ve pahalı iş başlamadan karşılaştırılmalıdır.

### CDN

Aynı ilkeler coğrafi ölçekte CDN'de uygulanır. Statik dosyalar özetli adlarla sonsuza kadar önbelleğe alınır. Sayfalar ve API yanıtları kısa `s-maxage` ve `stale-while-revalidate` ile sunulur. Geçersizleştirme için CDN'in purge API'si ya da "surrogate key" etiketleri kullanılır: Bir ürün değişince `urun-42` etiketli bütün yanıtlar tek çağrıyla silinir. CDN'in bir faydası daha var: Kullanıcıya en yakın noktada TLS sonlandırması yapar. Kıtalar arası bir gidiş-dönüş 150 ms sürer, TLS el sıkışması da birkaç gidiş-dönüş gerektirir, bu yüzden kazanç büyüktür.

## Hız sınırlama

Tek bir istemci saniyede 50 istek gönderiyor. Sınır istemci başına saniyede 10, ani yük payı 20:

```text
hız sınırı (10/sn, burst 20), 50/sn x 5 sn: durum kodları {"200":70,"429":174}
```

Kabul edilen istek sayısı hesapla birebir tutuyor: `5 sn × 10/sn + 20 (burst) = 70`. Geri kalan 174 istek, arka uca hiç ulaşmadan `429 Too Many Requests` ile döndü. nginx'in `limit_req` direktifi bir "sızdıran kova" (leaky bucket) uygular. `burst` ani yük payıdır. `nodelay` ise bu payın içindeki istekleri bekletmeden geçirir. `nodelay` olmadan bu istekler kuyrukta tutulup düzgün bir hızla iletilir, bu da gecikme ekler.

Vekildeki hız sınırlamanın sınırları var:

- **Anahtar seçimi:** `$binary_remote_addr` IP adresidir. Bir şirket ağının NAT'ının arkasındaki yüzlerce kullanıcı tek bir IP olarak görünür. Bir botnet ise binlerce IP'ye yayılır. Kimliği doğrulanmış API'lerde anahtar kullanıcı ya da API anahtarı olmalıdır. Vekil önündeki bir yük dengeleyici varsa gerçek IP `X-Forwarded-For`'dan alınır. Bu durumda `set_real_ip_from` ile **sadece güvenilen** vekillerin başlığına güvenilmelidir, aksi halde istemci kendi IP'sini uydurur.
- **Dağıtık sayım:** Her nginx kopyası kendi sayacını tutar. 4 vekil kopyası varsa fiilî sınır 4 katıdır. Paylaşılan bir sayaçla dağıtık hız sınırlamayı dayanıklılık bölümünde yazacağız.

## Vekilin kendi sınırları

Vekil de bir sistemdir ve kapasitesi vardır:

- **Dosya tanımlayıcıları ve bağlantılar:** Her istemci bağlantısı ve her arka uç bağlantısı bir tanımlayıcıdır. `worker_connections` ve `worker_rlimit_nofile` değerleri, beklenen eşzamanlılığa göre ayarlanır. Little yasası burada da geçerlidir.
- **Arka uç keep-alive:** `keepalive 64`, `proxy_http_version 1.1` ve boş `Connection` başlığı birlikte olmadan nginx her istekte arka uca yeni bağlantı açar. Node dersinde bunun maliyetini ölçmüştük. Arka ucun `keepAliveTimeout` değeri, vekilin boşta tutma süresinden uzun olmalıdır.
- **Tamponlama:** nginx yanıtı varsayılan olarak tamponlar. Yavaş bir istemci (mobil ağ) arka uç bağlantısını değil, sadece nginx'i meşgul eder. Bu "yavaş istemci koruması", ters vekilin en eski ve en değerli işlevlerinden biridir. Server-Sent Events ya da akış yanıtlarında ise `proxy_buffering off` gerekir.

```quiz
{
  "question": "Bir nginx yapılandırmasında `least_conn` kullanılıyor ama bir kopya yavaşladığında yük beklendiği kadar uzaklaşmıyor. Yapılandırmada `worker_processes auto` var, upstream bloğunda `zone` yok. Neden?",
  "options": [
    "least_conn yavaşlığı hiç dikkate almaz.",
    "Her nginx worker süreci kendi bağlantı sayaçlarını tutar. zone olmadan upstream durumu (bağlantı sayıları, başarısızlık sayaçları) worker'lar arasında paylaşılmaz, her worker trafiğin küçük bir kısmına göre karar verir. `zone` eklendiğinde bu derste yavaş kopyanın payı %14'ten %6'ya, p90 306 ms'den 35 ms'ye indi.",
    "worker_processes 1 yapılmalıdır, başka çözüm yoktur.",
    "keepalive direktifi least_conn'u devre dışı bırakır."
  ],
  "answer": 1,
  "explanation": "Paylaşılan bellek bölgesi, upstream durumunun bütün worker'larda ortak olmasını sağlar. Dağıtık vekil kopyalarında da aynı sorun vardır. 'İki rastgele seç, azını al' algoritması az bilgiyle iyi dağılım verir."
}
```

```quiz
{
  "question": "Bir API, giriş yapmış kullanıcının sepetini döndürüyor. Ekip performans için CDN'de `Cache-Control: public, s-maxage=30` ayarlıyor. Risk nedir?",
  "options": [
    "Risk yok. CDN her kullanıcı için ayrı kopya tutar.",
    "Yanıt kişiye özel olduğu halde paylaşılan önbelleklerde saklanabilir. Bir kullanıcının sepeti 30 saniye boyunca aynı URL'yi isteyen başka kullanıcılara sunulabilir. Kişiye özel yanıtlar `private` (ya da `no-store`) olmalıdır, paylaşılan önbellek sadece kişiden bağımsız yanıtlarda kullanılmalıdır.",
    "Sadece 30 saniyelik bayatlık sorunu olur.",
    "CDN, Authorization başlığı olan istekleri her zaman önbelleğe almaz, risk yoktur."
  ],
  "answer": 1,
  "explanation": "Önbellek anahtarı varsayılan olarak URL'dir. Cookie ya da Authorization'a göre değişen bir yanıtın public olarak işaretlenmesi, veri sızıntısına yol açan yaygın bir hatadır. CDN'lerin varsayılanları farklıdır, bu yüzden açıkça belirtmek gerekir."
}
```

```lab
{
  "title": "nginx'i yük altında ayarla",
  "steps": [
    "Bu dersteki düzeneği kur. `random two least_conn` ile üçüncü bir upstream ekle ve round-robin, least_conn ve random two ile p90/p99 değerlerini karşılaştır.",
    "Yavaş kopyanın gecikmesini 300 ms'den 3 sn'ye çıkar ve `proxy_read_timeout 1s` yap. Pasif sağlık kontrolünün kopyayı ne zaman devre dışı bıraktığını ve GET isteklerinin yeniden denenip denenmediğini gözlemle. Aynı testi POST isteğiyle tekrarla.",
    "Mikro önbellekte `proxy_cache_lock`'u kapat ve süresi dolan anahtarın arka uca kaç istek gönderdiğini ölç. Ardından `proxy_cache_use_stale updating`'i de kapat.",
    "Bütün arka uçları durdur ve 18082'ye istek göndermeye devam et. `proxy_cache_use_stale error` sayesinde kullanıcıların ne kadar süre hata görmediğini ölç.",
    "Kendi ingress ya da yük dengeleyici yapılandırmanı incele: Hangi algoritma kullanılıyor, arka uca keep-alive var mı, zaman aşımları ne, yeniden deneme hangi durumlarda yapılıyor?"
  ]
}
```

## Özet

- Round-robin hasta kopyayı görmez. `least_conn` açık bağlantı sayısı üzerinden geri bildirim alır. Bu derste yavaş kopyanın payını %33'ten %6'ya, p90'ı 308 ms'den 35 ms'ye indirdi.
- nginx'te `zone` olmadan upstream durumu worker'lar arasında paylaşılmaz ve least_conn yarım çalışır. Dağıtık vekillerde "iki rastgele seç" ve aykırı değer ayıklama kullanılır.
- Bağlanma hataları güvenle yeniden denenir: Kopya öldürüldüğünde istemci tek hata görmedi. Yeniden denemeyi sınırla, idempotent olmayan istekleri gönderildikten sonra tekrarlama. Bağlantı zaman aşımlarını kısa tut. Dağıtımda readiness ve `preStop` ile bağlantıları boşalt.
- Mikro önbellek (1 sn), 9902 isteği arka uçta 6 isteğe indirdi. `proxy_cache_lock` tekil uçuşun, `use_stale updating` ve background update ise SWR'nin vekildeki karşılığıdır. `use_stale error`, arka uç çöktüğünde son iyi yanıtı sunar.
- Önbellek davranışını yanıt başlıkları belirler: `public`/`private`, `s-maxage`, `stale-while-revalidate`, `immutable`, `Vary`. Kişiye özel yanıtı public işaretlemek veri sızıntısıdır. ETag ucuz bir kaynaktan türetilmelidir.
- `limit_req` tam hesaplandığı gibi davrandı (70 kabul, 174 reddedildi). Anahtar seçimine (NAT, X-Forwarded-For) ve kopyalar arası sayaç paylaşımına dikkat et.
