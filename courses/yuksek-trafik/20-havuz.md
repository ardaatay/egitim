# Bağlantılar ve sorgular: havuz boyutu, N+1 ve pgbench

Uygulama sunucuları yatay ölçeklenir. Pod eklemek kolaydır. Veritabanı ise çoğu sistemde **tek bir birincil** sunucudur ve uygulama kopyalarının hepsi aynı yere bağlanır. Önceki derslerdeki paylaşılan durum sorununun en somut hali budur. Bu derste PostgreSQL'in kendi yük aracı `pgbench` ile üç soruyu ölçüyoruz:

- Kaç bağlantı ideal?
- Bağlantı kurmanın maliyeti ne?
- Sorgu desenleri verimi nasıl etkiler?

## Düzenek

Veritabanı, 4 CPU ile sınırlanmış bir konteyner. Yük üreticisi (`pgbench`) veritabanıyla aynı CPU'ları paylaşmasın diye **ayrı** bir konteynerde çalışıyor:

```bash
docker run -d --rm --name egitim-pg --cpus 4 --memory 2g -e POSTGRES_PASSWORD=egitim -e POSTGRES_DB=egitim \
  postgres:17-alpine -c max_connections=500 -c shared_buffers=256MB
docker network create egitim-ag && docker network connect egitim-ag egitim-pg
docker exec egitim-pg pgbench -U postgres -i -s 20 -q egitim       # 2 milyon satırlık pgbench_accounts

# pgbench'i ayrı bir konteynerden çalıştıran yardımcı
PB() { docker run --rm --network egitim-ag -e PGPASSWORD=egitim postgres:17-alpine \
         pgbench -h egitim-pg -U postgres "$@" egitim; }
```

```text
done in 2.60 s (drop tables 0.00 s, create tables 0.01 s, client-side generate 1.88 s, vacuum 0.12 s, primary keys 0.58 s).
```

## Kaç bağlantı?

`pgbench -S`, birincil anahtarla tek satır okuyan bir "select-only" yüküdür. Bu yük tamamen bellekte çalışır (veri `shared_buffers`'a sığıyor), yani CPU'ya bağlıdır. İstemci sayısını artırarak:

```bash
for c in 1 4 8 16 32 64 128 256; do PB -S -M prepared -c $c -j $(( c<8 ? c : 8 )) -T 10; done
```

```text
istemci  tps       ort_ms
1        6008      0.166
4        22401     0.179
8        29033     0.276
16       29084     0.550
32       28830     1.110
64       27084     2.363
128      24162     5.298
256      21982     11.646
```

Bu tablo, kapasite dersindeki eğrinin bir veritabanındaki halidir:

- **1 → 8 istemci:** Verim neredeyse doğrusal arttı. 4 çekirdek ve ağdaki bekleme süresi, 8 istemciyi meşgul tutmaya yetiyor.
- **8 → 32 istemci:** Verim **düz** kaldı (yaklaşık 29.000), gecikme ise her ikiye katlamada **ikiye katlandı**. Little yasasının tam karşılığı: λ sabitken L iki katına çıkarsa, W de iki katına çıkar. Fazladan bağlantılar iş yapmıyor, sadece kuyrukta bekliyor.
- **32 → 256 istemci:** Verim **düştü** (29.000'den 22.000'e). USL'deki tutarlılık maliyeti: Daha fazla süreç, daha fazla bağlam değiştirme, kilit çekişmesi (`ProcArray`, buffer kilitleri) ve CPU önbelleği kaybı. Sunucu, işi yapmaktan çok sırayı yönetmeye zaman harcıyor.

Pratik sonuç sezgiye terstir: **Veritabanına giden aktif bağlantı sayısı küçük olmalıdır.** Yaygın başlangıç noktası `çekirdek sayısı × 2` civarıdır, disk G/Ç ağırlıklı yüklerde biraz fazlası (HikariCP'nin önerisi). Bu deneyde en iyi gecikme ve verim 8–16 bağlantıdaydı. Sonrası sadece daha kötü gecikme demek.

### Uygulama tarafındaki toplam

Toplam bağlantı sayısı, **kopya sayısı × havuz boyutu**dur. 40 pod'un her birinde 20 bağlantılık havuz varsa, veritabanına 800 bağlantı açılır. PostgreSQL'de her bağlantı ayrı bir süreçtir. Her biri birkaç MB bellek, sorgu sırasında da `work_mem` kadar ek bellek kullanır. HPA pod sayısını artırdıkça bağlantı sayısı da artar. Bir noktada `max_connections` sınırına (`FATAL: sorry, too many clients already`) ya da yukarıdaki tablonun sağ tarafına ulaşılır. "Yük arttı, pod eklendi, veritabanı yavaşladı, gecikme arttı, HPA daha çok pod ekledi" döngüsü bilinen bir kesinti biçimidir.

Çözüm, uygulama ile veritabanı arasında bir **bağlantı havuzlayıcıdır** (PgBouncer, pgcat, RDS Proxy). Binlerce istemci bağlantısını, birkaç düzine sunucu bağlantısına çoklar:

| Kip | İstemciye sunucu bağlantısı ne zaman verilir | Kısıt |
|---|---|---|
| `session` | Bağlantı boyunca | Çoklama yok, havuzlamanın faydası azdır |
| `transaction` | Sadece işlem (transaction) süresince | Oturum durumu kullanılamaz: `SET`, oturum seviyesi advisory lock, `LISTEN`. Hazırlanmış ifadeler (prepared statements) PgBouncer 1.21'den beri `max_prepared_statements` ile destekleniyor |
| `statement` | Tek bir sorgu süresince | Çok ifadeli işlemlere izin verilmez |

`transaction` kipi, yüksek trafikteki standart seçimdir. Uygulamanın oturum durumuna güvenmemesi gerekir. Örneğin arama yolu ya da zaman dilimi gibi ayarlar `SET LOCAL` ile işlem içinde verilmelidir.

Havuz boyutu kadar **havuzdan bağlantı bekleme süresi** de önemlidir. Havuz doluysa istek beklemelidir, ama sonsuza kadar değil. Kısa bir zaman aşımı (örneğin 1–2 sn) ve bu durumda hızlı başarısızlık (503), veritabanı zorlandığında isteklerin uygulamada birikip belleği doldurmasını önler. Bunu dayanıklılık bölümünde yük atma ile birlikte ele alacağız. Bekleme süresini mutlaka bir metrik olarak yayımla (`pool.waitingCount`, `hikaricp_connections_pending`). Havuz doygunluğu, veritabanı darboğazının en erken göstergesidir.

## Bağlantı kurmanın maliyeti ve sorgu protokolü

```bash
PB -S -M prepared    -c 8 -j 8 -T 10
PB -S -M simple      -c 8 -j 8 -T 10
PB -S -M prepared -C -c 8 -j 8 -T 10      # -C: her işlem için yeni bağlantı
```

```text
-M prepared      tps=29275   ort=0.273 ms
-M simple        tps=22982   ort=0.348 ms
-M prepared -C   tps=278     ort=28.815 ms
average connection time = 26.256 ms
```

- **Hazırlanmış ifadeler** (`prepared`): Sorgu bir kez ayrıştırılır ve planlanır, sonra sadece parametrelerle çalıştırılır. Basit sorgu protokolüne göre yüzde 27 daha fazla verim. Güvenlik kursundaki bind değişkenleri ve Oracle kursundaki paylaşılan imleçlerle aynı fikir. Bu sefer performans tarafından.
- **Her işlemde yeni bağlantı:** Verim **100 kat** düştü. Ortalama bağlantı kurma süresi 26 ms. Bu süre, PostgreSQL 14'ten beri varsayılan olan **SCRAM-SHA-256** kimlik doğrulamasının parola türetme (PBKDF2, 4096 yineleme) maliyetinden ve her bağlantı için yeni bir sunucu süreci başlatılmasından geliyor. Kimlik doğrulama dersindeki argon2id gibi, bu da bilinçli olarak pahalıdır. Kısa ömürlü bağlantılar (havuzsuz serverless fonksiyonlar, her istekte bağlanan betikler, yanlış yapılandırılmış havuzlar) bu maliyeti her istekte öder.

## Sorgu desenleri

### N+1

Bir sipariş listesinde, her siparişin ürününü ayrı bir sorguyla çekmek: 1 sorgu liste için, N sorgu satırlar için. ORM'lerin tembel yükleme (lazy loading) özelliği bunu görünmez kılar. 20 rastgele hesabı **20 ayrı sorguyla** ve **tek bir `= ANY` sorgusuyla** çekelim:

```sql
-- n1.sql (pgbench betiği, kısaltılmış): 20 rastgele kimlik, 20 ayrı sorgu
\set a0 random(1, 2000000)
\set a1 random(1, 2000000)
-- ... a19'a kadar
SELECT abalance FROM pgbench_accounts WHERE aid = :a0;
SELECT abalance FROM pgbench_accounts WHERE aid = :a1;
-- ... 20 sorgu

-- toplu.sql: aynı 20 kimlik, tek sorgu
SELECT aid, abalance FROM pgbench_accounts WHERE aid = ANY (ARRAY[:a0, :a1, ..., :a19]::int[]);
```

```bash
PB -n -M prepared -f /s/n1.sql    -c 8 -j 8 -T 10
PB -n -M prepared -f /s/toplu.sql -c 8 -j 8 -T 10
```

```text
n1     işlem/sn=1504    satır/sn=30081    işlem başına ort=5.319 ms
toplu  işlem/sn=15701   satır/sn=314014   işlem başına ort=0.510 ms
```

Aynı satırlar, **10 kat** daha hızlı ve 10 kat daha az veritabanı kaynağıyla geldi. Fark, her sorgunun sabit maliyetinden geliyor: ağ gidiş-dönüşü, protokol mesajları, yürütücünün başlatılması. Bu deneyde ağ, aynı makinedeki bir Docker ağı (gidiş-dönüş yaklaşık 0,05 ms). Gerçek bir ağda (aynı veri merkezinde yaklaşık 0,5 ms) N+1 deseni her istekte **20 × 0,5 = 10 ms** ağ beklemesi ekler. Ayrıca uygulama sunucusunda 20 kez havuzdan bağlantı alıp bırakır. İlk denemede `ARRAY[...]` ifadesi parametreleri metin olarak aldı ve `operator does not exist: integer = text` hatası verdi. `::int[]` dönüşümü gerekti. ORM'lerin `IN (...)` desteği bunu genellikle kendisi yapar.

N+1'i bulmanın yolları:

- **İstek başına sorgu sayısını** bir metrik ya da iz (trace) özelliği olarak yayımla. Bir uç noktanın istek başına 50 sorgu çalıştırdığı, gecikmesinden önce bu sayıda görünür.
- **`pg_stat_statements`:** En çok **çağrılan** sorgular listesinin tepesinde, birincil anahtarla tek satır okuyan bir sorgu varsa, N+1 şüphesi doğar.
- **ORM'de istekli yükleme:** `include`/`JOIN FETCH`/`select_related`/DataLoader kullan. GraphQL çözücülerinde DataLoader deseni standarttır: Aynı olay döngüsü turundaki tekil istekler, tek bir toplu sorguya dönüştürülür.

### Sorgu süresi ve kilitler

Havuz boyutu kadar bağlantının **ne kadar süre tutulduğu** da önemlidir. Little yasası burada da geçerli: Saniyede 2000 istek ve işlem başına 15 ms, ortalama 30 meşgul bağlantı demektir. İşlem süresini iki katına çıkaran her şey, gereken bağlantı sayısını da iki katına çıkarır:

- **İşlem içinde dış çağrı:** `BEGIN; UPDATE ...; await odemeServisi(); COMMIT;` Ödeme servisi 2 saniye sürerse, bağlantı ve satır kilitleri 2 saniye tutulur. Dış çağrıları işlemin **dışına** taşı. Gerekirse outbox deseni kullan (kuyruk dersi).
- **`idle in transaction`:** Uygulama `BEGIN` deyip bir hata yüzünden `COMMIT` ya da `ROLLBACK` yapmadan bağlantıyı havuza iade ederse, bağlantı kilitleri tutarak bekler. Ayrıca VACUUM'un ölü satırları temizlemesini engeller. Korumalar: `idle_in_transaction_session_timeout` (örneğin 30 sn), `statement_timeout` (uç nokta başına makul bir üst sınır) ve `lock_timeout`.
- **Sıcak satırlar:** Her siparişte aynı `stok` satırını ya da aynı sayacı güncellemek, bütün işlemleri o satırın kilidinde sıraya sokar. Amdahl'ın seri kısmı tam olarak budur. Çözümler: sayacı parçalara bölmek (N satıra dağıtıp toplamı okurken almak), artışları toplu yazmak (write-behind) ya da kuyruğa almak.

### İndeksler ve planlar

Bu konuyu Oracle kursunda ayrıntılı işledik: yürütme planları, istatistikler, bileşik indeksler. Burada sadece yüksek trafik açısından iki not:

- Tek bir yavaş sorgu, düşük çağrı sıklığında bile **bağlantı havuzunu tüketerek** bütün sistemi yavaşlatabilir. `pg_stat_statements` tablosunu `total_exec_time`'a göre sırala: Toplam veritabanı zamanının çoğu genellikle birkaç sorgudan gelir.
- İndeksin bir **yazma maliyeti** vardır. Her `INSERT` ve `UPDATE`, ilgili indeksleri de günceller. Yazma ağırlıklı tablolarda kullanılmayan indeksleri (`pg_stat_user_indexes.idx_scan = 0`) kaldırmak da bir performans iyileştirmesidir.

```quiz
{
  "question": "Bir servis 30 pod'a ölçeklenmiş, her pod'da 25 bağlantılık havuz var. Veritabanı 16 çekirdekli. Yoğun saatlerde veritabanı CPU'su %100 ve sorgu gecikmeleri 10 katına çıkıyor. Ekip havuz boyutunu 50'ye çıkarmayı öneriyor. Doğru değerlendirme hangisi?",
  "options": [
    "Doğru. Daha fazla bağlantı, daha fazla paralellik demektir.",
    "Yanlış. Veritabanının azami verimi aktif bağlantı sayısıyla değil çekirdek sayısıyla sınırlıdır. 750 olası bağlantı zaten doygunluk noktasının çok üstünde. Fazla bağlantılar kuyrukta bekler, çekişme yüzünden verim düşer (bu derste 256 istemcide verim %25 düştü). Bir bağlantı havuzlayıcıyla (transaction kipi) sunucu bağlantılarını 30–50 civarında tutmak, pahalı sorguları bulup kısaltmak ve havuz bekleme süresini sınırlamak gerekir.",
    "Havuz boyutunun veritabanı performansına etkisi yoktur.",
    "max_connections'ı 5000'e çıkarmak yeterlidir."
  ],
  "answer": 1,
  "explanation": "Toplam bağlantı = kopya sayısı × havuz boyutu. CPU'ya bağlı bir yükte çekirdek sayısının birkaç katından fazla aktif bağlantı sadece gecikmeyi artırır. Havuzlayıcı, uygulamanın yatay ölçeklenmesini veritabanı bağlantı sayısından ayırır."
}
```

```quiz
{
  "question": "Bir uç noktanın p50 gecikmesi 120 ms. İzlemede (tracing) her istekte 1 'liste' sorgusu ve ardından 40 adet `SELECT * FROM urunler WHERE id = $1` sorgusu görülüyor. Her biri 0,3 ms sürüyor ve ağ gidiş-dönüşü 1 ms. En etkili düzeltme hangisi?",
  "options": [
    "urunler.id üzerine indeks eklemek.",
    "N+1 desenini tek bir toplu sorguyla (`WHERE id = ANY($1)` ya da JOIN, ORM'de istekli yükleme) değiştirmek. 40 × (1 ms + 0,3 ms) ≈ 52 ms'lik beklemenin çoğu ağ gidiş-dönüşüdür ve tek sorguyla bir gidiş-dönüşe iner.",
    "Veritabanı sunucusunu büyütmek.",
    "Sorguları paralel çalıştırmak için havuzu 40 bağlantıya çıkarmak."
  ],
  "answer": 1,
  "explanation": "Birincil anahtar zaten indekslidir. Maliyet sorgu başına sabit giderlerden (gidiş-dönüş, protokol, havuz) gelir. Paralel çalıştırmak gecikmeyi azaltır, ama veritabanı yükünü ve bağlantı ihtiyacını katlar."
}
```

```lab
{
  "title": "Kendi veritabanının doygunluk eğrisini çıkar",
  "steps": [
    "Bu dersteki düzeneği kur ve istemci sayısı tablosunu kendi makinende üret. Konteynerin CPU sınırını 2 ve 8 yaparak tekrarla. Doygunluk noktası çekirdek sayısıyla nasıl değişiyor?",
    "`pgbench` varsayılan TPC-B yüküyle (yazma ağırlıklı, `-S` olmadan) aynı tabloyu çıkar. Yazma yükünde doygunluk noktası ve en iyi bağlantı sayısı değişiyor mu? `pg_stat_activity`'deki `wait_event` sütununa bakarak bağlantıların neyi beklediğini incele.",
    "`-C` ile bağlantı maliyetini ölç, sonra pg_hba.conf'ta yöntemi geçici olarak `md5`'e ve `trust`'a çevirip tekrarla. Bağlantı süresinin ne kadarının kimlik doğrulamadan geldiğini hesapla. (trust'ı sadece bu yalıtılmış test konteynerinde kullan.)",
    "n1.sql'deki sorgu sayısını 5, 20 ve 100 yaparak toplu sorguyla karşılaştır. Aradaki farkı, 0,5 ms'lik gerçek bir ağ gidiş-dönüşü için hesapla.",
    "`pg_stat_statements` uzantısını aç (`shared_preload_libraries`), birkaç dakika yük çalıştır ve en çok toplam zaman harcayan ile en çok çağrılan 5 sorguyu listele."
  ]
}
```

## Özet

- Veritabanı verimi aktif bağlantı sayısıyla değil, çekirdeklerle sınırlıdır. 4 çekirdekte verim 8 bağlantıda doydu. Sonrasında gecikme Little yasasıyla doğrusal arttı, 256 bağlantıda verim %25 düştü. Başlangıç noktası çekirdek × 2.
- Toplam bağlantı = kopya × havuz. Uygulama yatay ölçeklenince veritabanını korumak için transaction kipinde bir havuzlayıcı (PgBouncer, pgcat, RDS Proxy) kullan. Havuz bekleme süresini sınırla ve metrik olarak yayımla.
- Yeni bağlantı pahalıdır: Her işlemde bağlanmak verimi 29.000'den 278'e düşürdü (bağlantı başına 26 ms, SCRAM ve süreç oluşturma). Hazırlanmış ifadeler %27 verim kazandırdı.
- N+1: 20 tekil sorgu yerine tek bir `= ANY` sorgusu 10 kat hızlı. Gerçek ağda fark daha büyüktür. İstek başına sorgu sayısını izle, istekli yükleme ve DataLoader kullan.
- Bağlantının tutulma süresi de kapasitedir: İşlem içinde dış çağrı yapma, `idle_in_transaction_session_timeout`, `statement_timeout` ve `lock_timeout` ayarla, sıcak satırları dağıt.
