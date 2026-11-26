# Okuma replikaları, replikasyon gecikmesi ve parçalama

Tek bir veritabanı sunucusu dikey olarak (daha çok çekirdek, daha çok bellek, daha hızlı disk) şaşırtıcı ölçüde büyüyebilir. Bugün tek bir PostgreSQL sunucusu saniyede on binlerce işlem taşır. Ölçeklemenin ilk adımı bu yüzden çoğunlukla dikey büyüme ve önceki dersteki sorgu iyileştirmeleridir. Bir noktada iki sınırdan biri aşılır:

- **Okuma** yükü, **yazma** yükünden çok fazladır ve birincil sunucu okumalara yetişemez. Çözüm **replikalardır**.
- **Yazma** yükü ya da veri boyutu tek sunucuyu aşar. Çözüm **parçalamadır** (sharding).

İkisinin de bedeli tutarlılıktır. Bu derste bu bedeli ölçüyoruz.

## Akışlı replikasyon kurmak

Önceki dersteki birincil sunucunun (`egitim-pg`) yanına, aynı imajdan bir **sıcak bekleme** (hot standby) replikası kuruyoruz. Replika, birincilin WAL kaydını ağ üzerinden alıp uyguluyor:

```bash
# birincilde: replikasyon kullanıcısı ve pg_hba kuralı
docker exec egitim-pg psql -U postgres -c "CREATE ROLE repl REPLICATION LOGIN PASSWORD 'repl'"
docker exec egitim-pg sh -c 'echo "host replication repl all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
docker exec egitim-pg psql -U postgres -c "select pg_reload_conf()"

# replika: birincilin temel yedeğini al (-R: standby.signal + bağlantı bilgisi), sonra postgres'i başlat
docker run -d --rm --name egitim-pg-r --network egitim-ag --cpus 2 --memory 1g -e PGPASSWORD=repl \
  --entrypoint sh postgres:17-alpine -c '
  mkdir -p /var/lib/postgresql/data && chown postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data &&
  gosu postgres pg_basebackup -h egitim-pg -U repl -D /var/lib/postgresql/data -R -X stream -c fast &&
  exec gosu postgres postgres -D /var/lib/postgresql/data -c max_connections=500'

docker exec egitim-pg-r psql -U postgres -d egitim -Atc "select pg_is_in_recovery(), count(*) from pgbench_accounts"
docker exec egitim-pg psql -U postgres -Atc "select application_name, state, sync_state from pg_stat_replication"
```

```text
t|2000000
walreceiver|streaming|async
```

Kurulumda iki hata yaşandı, ikisi de öğretici:

1. Konteyner hemen kapandı. Bunun nedeni, güncel `postgres:17-alpine` imajının ayrıcalık düşürmek için artık `su-exec` değil `gosu` kullanmasıydı (`su-exec: not found`). İmajların iç detaylarına dayanan betikler kırılgandır.
2. Replika şu hatayla durdu:

   ```text
   FATAL:  recovery aborted because of insufficient parameter settings
   ```

   Birincilde `max_connections=500` vardı, replika ise varsayılan değerle (100) açılıyordu. Bazı parametreler (`max_connections`, `max_worker_processes`, `max_locks_per_transaction` ve diğerleri) replikada en az birincildeki kadar olmalıdır. Birincilde bu değerleri **artırırken** önce replikalarda artırmak gerekir.

## Replikasyon gecikmesi

Replikasyon varsayılan olarak **asenkrondur**. Birincil, işlemi kendi diskine yazdığı anda `COMMIT`'i onaylar. Replikanın yazmayı alıp uygulaması biraz sonra olur. Gecikmeyi `pg_stat_replication` ile izleyelim. Birincilde 16 istemcili yazma yükü (pgbench TPC-B) var:

```bash
docker run -d --rm --name egitim-yaz --network egitim-ag -e PGPASSWORD=egitim postgres:17-alpine \
  pgbench -h egitim-pg -U postgres -c 16 -j 8 -T 30 -n egitim
docker exec egitim-pg psql -U postgres -Atc "select to_char(now(),'HH24:MI:SS'), pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), write_lag, replay_lag from pg_stat_replication"
```

```text
zaman     gecikme_bayt  write_lag        replay_lag
12:12:07  67624         00:00:00.000534  00:00:00.001534
12:12:11  54184         00:00:00.000509  00:00:00.001793
12:12:15  44624         00:00:00.000597  00:00:00.001524
12:12:19  52984         00:00:00.000228  00:00:00.001252
12:12:22  29912         00:00:00.000504  00:00:00.003111
```

Aynı makinede, yazma yükü altında gecikme 1–3 ms ve birkaç on KB. Ağ, disk ve replikanın kendi yükü bunu büyütür. Ama milisaniyeler bile, aşağıda göreceğimiz gibi, uygulamanın mantığını bozmaya yeter.

### Uzun sorgular replikayı durdurur

Gerçek sistemlerde saniyeler, hatta dakikalar süren gecikmenin en yaygın nedeni ağ değil, **replikadaki uzun sorgulardır**. Replikada bir analitik sorgu (raporlama) çalışırken birincilde VACUUM, o sorgunun hâlâ görmesi gereken eski satır sürümlerini temizler. Replika bu temizliği uygularsa sorgunun verisi bozulur, uygulamazsa geride kalır. PostgreSQL bir süre (`max_standby_streaming_delay`, varsayılan 30 sn) **bekler**, sonra sorguyu iptal eder:

```bash
# replikada: 45 saniye süren bir REPEATABLE READ işlemi (anlık görüntüyü tutar)
docker exec egitim-pg-r psql -U postgres -d egitim -c "BEGIN ISOLATION LEVEL REPEATABLE READ;
  SELECT count(*) FROM pgbench_accounts; SELECT pg_sleep(45); SELECT count(*) FROM pgbench_accounts; COMMIT;" &
# birincilde: güncellemeler ve ardından VACUUM; sonra 5 sn arayla gecikmeyi ölç
PB -N -c 8 -j 4 -T 8 -n && docker exec egitim-pg psql -U postgres -d egitim -c "VACUUM pgbench_accounts"
```

```text
zaman     replay_lag        gecikme_bayt
12:13:04 00:00:09.181559 21773672
12:13:09 00:00:15.190274 21773840
12:13:15 00:00:15.822868 21773952
12:13:21 00:00:21.79916 21774064
12:13:27 00:00:04.927068 0
12:13:33 00:00:00.007371 0
```

```text
ERROR:  canceling statement due to conflict with recovery
DETAIL:  User query might have needed to see row versions that must be removed.
```

Replika yaklaşık 21 saniye boyunca **hiçbir şey uygulamadı** (21 MB geride kaldı). Bu sürede replikadan okuyan bütün istekler 21 saniye eski veri gördü. Ardından PostgreSQL uzun sorguyu iptal etti ve replika birkaç saniyede yetişti. Bu bir ikilemdir:

| Seçenek | Bedeli |
|---|---|
| `max_standby_streaming_delay` büyük | Uzun sorgular tamamlanır, ama replika dakikalarca geride kalabilir |
| `max_standby_streaming_delay` küçük | Replika güncel kalır, uzun sorgular iptal edilir |
| `hot_standby_feedback = on` | Replika, birincile "bu satırları temizleme" der. Sorgular iptal edilmez, ama birincilde tablo şişkinliği (bloat) birikir |

Pratik çözüm, iş yüklerini ayırmaktır: Uygulamanın okuma replikaları kısa sorgular için ve düşük gecikme toleransıyla çalışır. Raporlama ve analitik ise ayrı bir replikaya ya da bir veri ambarına gider.

## Kendi yazdığını okumak

En sık görülen replika hatası şudur: Kullanıcı profilini günceller (birincile yazılır), sayfa yenilenir (replikadan okunur) ve **eski** profili görür. Bunu birincilde bir döngüyle ölçelim. Döngüde birincile yazılıyor, `COMMIT` yapılıyor, hemen ardından `dblink` üzerinden replikadan okunuyor:

```sql
-- ryw.sql
DO $$
DECLARE i int; r bigint; bayat int := 0; lsn pg_lsn; bekleme interval := '0'; t0 timestamptz; mod text := current_setting('ryw.mod');
BEGIN
  PERFORM dblink_connect('rep', 'host=egitim-pg-r dbname=egitim user=postgres password=egitim');
  FOR i IN 1..500 LOOP
    UPDATE ryw SET v = i WHERE id = 1;
    COMMIT;
    IF mod = 'lsn-bekle' THEN                     -- replika bu yazmayı uygulayana kadar bekle
      lsn := pg_current_wal_lsn(); t0 := clock_timestamp();
      WHILE (SELECT x FROM dblink('rep', 'SELECT pg_last_wal_replay_lsn()') AS t(x pg_lsn)) < lsn LOOP
        PERFORM pg_sleep(0.0005);
      END LOOP;
      bekleme := bekleme + (clock_timestamp() - t0);
    END IF;
    SELECT x INTO r FROM dblink('rep', 'SELECT v FROM ryw WHERE id = 1') AS t(x bigint);
    IF r <> i THEN bayat := bayat + 1; END IF;
  END LOOP;
  RAISE NOTICE 'mod=%: 500 okumanın % tanesi bayat, toplam bekleme % ms', mod, bayat, round(extract(epoch FROM bekleme) * 1000);
  PERFORM dblink_disconnect('rep');
END $$;
```

```bash
docker exec egitim-pg psql -U postgres -d egitim -c "CREATE EXTENSION dblink; CREATE TABLE ryw(id int primary key, v bigint); INSERT INTO ryw VALUES (1, 0);"
for m in dogrudan lsn-bekle; do docker exec -e PGOPTIONS="-c ryw.mod=$m" egitim-pg psql -U postgres -d egitim -q -f /tmp/ryw.sql; done
```

```text
mod=dogrudan: 500 okumanın 499 tanesi bayat, toplam bekleme 0 ms
mod=lsn-bekle: 500 okumanın 0 tanesi bayat, toplam bekleme 769 ms
```

Yük olmadan, gecikme 1–2 ms iken bile, yazmanın hemen ardından yapılan okumaların **500'de 499'u** eski değeri gördü. "Replikasyon gecikmesi çok küçük, sorun olmaz" varsayımı burada çöküyor. Bir yazmadan sonraki ilk okuma neredeyse her zaman o küçük pencerenin içine düşer.

İkinci modda, yazmanın WAL konumu (LSN) alındı ve replika bu konuma ulaşana kadar beklendi. Bayat okuma sıfıra indi. Bunun bedeli yazma başına ortalama 1,5 ms bekleme. Birincilde yazma yükü varken aynı test 1454 ms toplam bekleme verdi (yazma başına yaklaşık 3 ms). Bekleme, gecikmeyle birlikte büyüyor.

Uygulamadaki çözümler, ucuzdan pahalıya:

1. **Yazandan sonra birincilden oku:** Kullanıcı yazdıktan sonra kısa bir süre (örneğin 5 sn) **onun** okumalarını birincile yönlendir. Bu bilgi bir çerezde ya da oturumda tutulur. Basittir ve çoğu durumda yeterlidir.
2. **LSN ile oturum tutarlılığı:** Yazmanın LSN'i istemciye döndürülür (çerez, başlık). Sonraki okumada, replika o LSN'e ulaşmadıysa ya beklenir ya da birincile gidilir. Bu deneydeki yöntemin uygulama düzeyindeki karşılığıdır.
3. **Kritik okumalar her zaman birincilden:** Ödeme sonrası bakiye, stok kontrolü, yetki değişikliği. Replika "yaklaşık doğru" okumalar içindir: listeler, aramalar, raporlar.
4. **Senkron replikasyon** (`synchronous_commit = remote_apply`): Birincil, replika uygulamadan `COMMIT`'i onaylamaz. Tutarlılık güçlenir, ama her yazma en yavaş senkron replikayı bekler ve replika düşerse yazmalar durur (`ANY 1 (r1, r2)` ile çoğunluk seçilerek hafifletilir). Genellikle okuma tutarlılığı için değil, **veri kaybını önlemek** (RPO=0) için kullanılır.

Replikanın gecikmesini uygulamanın göreceği şekilde izle. Uygulama gecikmesi belli bir eşiği (örneğin 5 sn) aşan replikayı okuma havuzundan çıkarmalıdır. Kendi kendine iyileşen bir sistem, geride kalan replikaya trafik göndermeye devam etmez.

## Parçalama

Yazma yükü ya da veri hacmi tek bir birincili aştığında veri **parçalara** bölünür. Her parça (shard), verinin bir alt kümesini taşıyan bağımsız bir birincildir. Yönlendirme ise bir **parça anahtarıyla** yapılır, örneğin `musteri_id`.

### Anahtarı yerleştirmek

En basit yöntem `hash(anahtar) mod N`'dir. N değiştiğinde ne olduğuna bakalım. 100.000 anahtar var, 4 parçadan 5 parçaya geçiliyor:

```js
// parcala.mjs — düğüm eklenince kaç anahtar yer değiştirir? mod-N ile tutarlı özetleme (sanal düğümlü halka)
import crypto from "node:crypto";
const h32 = (s) => crypto.createHash("md5").update(s).digest().readUInt32BE(0);
const ANAHTAR = Array.from({ length: 100_000 }, (_, i) => `musteri:${i}`);

const modN = (n) => (k) => h32(k) % n;
function halka(n, sanal = 200) {
  const noktalar = [];
  for (let d = 0; d < n; d++) for (let v = 0; v < sanal; v++) noktalar.push([h32(`dugum${d}#${v}`), d]);
  noktalar.sort((a, b) => a[0] - b[0]);
  return (k) => {                                     // saat yönünde ilk nokta (ikili arama)
    const x = h32(k); let a = 0, b = noktalar.length;
    while (a < b) { const m = (a + b) >> 1; noktalar[m][0] < x ? (a = m + 1) : (b = m); }
    return noktalar[a % noktalar.length][1];
  };
}
function karsilastir(ad, f4, f5) {
  let tasinan = 0; const yuk = new Array(5).fill(0);
  for (const k of ANAHTAR) { const a = f4(k), b = f5(k); if (a !== b) tasinan++; yuk[b]++; }
  const ort = ANAHTAR.length / 5;
  console.log(`${ad.padEnd(28)} taşınan=%${(tasinan / ANAHTAR.length * 100).toFixed(1).padStart(4)}  5 düğümde yük (en az/en çok, ortalamaya göre): ` +
    `${(Math.min(...yuk) / ort).toFixed(2)} / ${(Math.max(...yuk) / ort).toFixed(2)}`);
}
karsilastir("mod N (4 -> 5)", modN(4), modN(5));
karsilastir("tutarlı halka, 1 sanal", halka(4, 1), halka(5, 1));
karsilastir("tutarlı halka, 200 sanal", halka(4, 200), halka(5, 200));
```

```text
mod N (4 -> 5)               taşınan=%79.9  5 düğümde yük (en az/en çok, ortalamaya göre): 0.99 / 1.01
tutarlı halka, 1 sanal       taşınan=% 4.1  5 düğümde yük (en az/en çok, ortalamaya göre): 0.21 / 1.66
tutarlı halka, 200 sanal     taşınan=%20.0  5 düğümde yük (en az/en çok, ortalamaya göre): 0.99 / 1.01
```

- **mod N:** Bir parça eklemek, anahtarların **%80**'inin yer değiştirmesi demektir. Veritabanında bu, verinin neredeyse tamamının taşınması anlamına gelir. Önbellek kümesinde ise anlık bir önbellek kaybı ve önceki derste gördüğümüz fırtına demektir.
- **Tutarlı halka, düğüm başına tek nokta:** Sadece %4 taşındı, ama dağılım çok dengesiz: Bir parça ortalamanın %166'sını, yeni parça sadece %21'ini aldı. Yeni parça neredeyse boş kaldı.
- **Tutarlı halka, düğüm başına 200 sanal nokta:** Taşınan oran tam olarak ideal olan `1/5 = %20`, dağılım da mod N kadar düzgün.

Veritabanlarında çoğunlukla bunun pratik bir çeşidi kullanılır: **sabit sayıda mantıksal parça**. Örneğin 4096 parça baştan oluşturulur ve parçalar fiziksel sunuculara bir eşleme tablosuyla atanır. Sunucu eklendiğinde bazı mantıksal parçalar bütün halinde taşınır. Citus, Vitess ve Cassandra'nın token aralıkları bu yaklaşımı kullanır.

### Parça anahtarı ve bedeli

Parçalamanın asıl zorluğu algoritma değil, **anahtar seçimidir**:

- **Erişim desenine uymalı:** İsteklerin büyük çoğunluğu **tek bir parçaya** gitmelidir. Çok kiracılı bir SaaS'ta `kiraci_id` doğal bir anahtardır: Bir kiracının bütün verisi aynı parçadadır, join ve işlemler parça içinde kalır.
- **Dengeli olmalı:** Çok büyük bir kiracı tek bir parçayı ezer ("sıcak parça"). Büyük kiracılar kendi parçalarına taşınır ya da alt anahtarla bölünür.
- **Parçalar arası işler pahalıdır:** Bütün parçaları gezen sorgular (dağıt-topla), parçalar arası join'ler ve parçalar arası işlemler (iki aşamalı commit ya da saga) hem yavaş hem karmaşıktır. Raporlama genellikle parçalardan beslenen ayrı bir analitik depoda yapılır.
- **Benzersiz kimlikler:** Otomatik artan bir sayaç, parçalar arasında çakışır. UUIDv7 ya da Snowflake tarzı kimlikler (zaman + düğüm + sıra) kullanılır. UUIDv7 zamanla sıralı olduğu için B-tree indeksinde rastgele UUIDv4'e göre çok daha az sayfa bölünmesine yol açar.

Bu yüzden sıra genellikle şöyledir:

1. Sorgu ve indeks iyileştirme
2. Önbellek
3. Okuma replikaları
4. Dikey büyüme
5. Fonksiyonel bölme (sipariş ve katalog gibi farklı servislerin farklı veritabanları)
6. Bölümleme (aynı sunucuda tabloyu bölmek, Oracle kursundaki partition)
7. En son, gerçekten gerektiğinde parçalama

Parçalama tersine çevrilmesi en zor mimari karardır.

```quiz
{
  "question": "Bir uygulama bütün okumaları replikaya, yazmaları birincile gönderiyor. İzlemede replikasyon gecikmesi ortalama 2 ms. Yine de kullanıcılar 'kaydettim ama eski hali görünüyor' diye şikâyet ediyor. Neden ve ne yapılmalı?",
  "options": [
    "2 ms ihmal edilebilir. Sorun tarayıcı önbelleğindedir.",
    "Kaydetmenin hemen ardından yapılan okuma tam o birkaç milisaniyelik pencereye düşer. Bu derste yük yokken bile yazmadan hemen sonraki 500 okumanın 499'u bayattı. Yazan kullanıcının okumalarını kısa bir süre birincile yönlendirmek ya da yazma LSN'ini taşıyıp replika ona ulaşana kadar beklemek gerekir.",
    "Senkron replikasyon her durumda en iyi çözümdür.",
    "Replikasyon gecikmesini 0'a indirmek mümkündür ve sorun çözülür."
  ],
  "answer": 1,
  "explanation": "Ortalama gecikmenin küçük olması, yazmadan hemen sonraki okumanın güncel olacağı anlamına gelmez. Kendi yazdığını okuma tutarlılığı uygulama tarafında sağlanmalıdır. Ayrıca uzun sorgular gibi nedenlerle gecikme ara sıra saniyelere çıkabilir."
}
```

```quiz
{
  "question": "Okuma replikasında çalışan gece raporları ara sıra 'canceling statement due to conflict with recovery' hatasıyla iptal ediliyor. Bir ekip üyesi `hot_standby_feedback = on` öneriyor. Bu değişikliğin yan etkisi nedir?",
  "options": [
    "Yan etkisi yoktur.",
    "Replika, birincildeki VACUUM'un raporun ihtiyaç duyduğu satır sürümlerini temizlemesini engeller. Rapor iptal edilmez, ama birincilde ölü satırlar birikir, tablolar ve indeksler şişer, birincilin performansı düşebilir. Uzun raporlar için ayrı bir replika ya da veri ambarı daha iyidir.",
    "Replikasyon senkron hale gelir.",
    "Replika yazılabilir hale gelir."
  ],
  "answer": 1,
  "explanation": "Replikadaki uzun sorgu ya replay'i durdurur (gecikme), ya iptal edilir, ya da birincilde temizliği geciktirir (şişkinlik). Üçünden birini seçmek gerekir. İş yüklerini ayırmak ikilemi ortadan kaldırır."
}
```

```lab
{
  "title": "Replikayı ve parçalamayı dene",
  "steps": [
    "Bu dersteki replikayı kur. Replikayı `docker pause egitim-pg-r` ile 20 saniye durdur, birincilde yazma yükü çalıştır, sonra `docker unpause` et. pg_stat_replication'daki gecikmenin birikip erimesini 2 saniyede bir ölçerek grafiğe dök.",
    "ryw.sql'deki 'lsn-bekle' modunu, uygulamada kullanılacak bir 'en fazla 50 ms bekle, olmazsa birincilden oku' politikasına çevir. Replika duraklatılmışken bu politikanın kaç okumayı birincile yönlendirdiğini ölç.",
    "`ALTER SYSTEM SET synchronous_standby_names = '*'` ve `synchronous_commit = remote_apply` ile senkron replikasyonu aç. pgbench TPC-B verimini ve gecikmesini asenkronla karşılaştır. Ardından replikayı durdurup birincile yazmayı dene: Ne oluyor?",
    "parcala.mjs'e 'sabit 4096 mantıksal parça + eşleme tablosu' yöntemini ekle. 4'ten 5 sunucuya geçerken hangi parçaların taşınacağını seçen ve taşınan veri oranını raporlayan bir fonksiyon yaz.",
    "Kendi sistemindeki en büyük tabloyu düşün: Bir gün parçalanması gerekse parça anahtarı ne olurdu? Hangi sorgular parçalar arası hale gelirdi?"
  ]
}
```

## Özet

- Önce dikey büyü ve sorguları iyileştir. Okuma ağırlıklı yükte replika, yazma ya da veri hacmi sınırında parçalama gelir.
- Akışlı replikasyon `pg_basebackup -R` ile kurulur. Replikada bazı parametreler (örneğin `max_connections`) en az birincil kadar olmalıdır.
- Asenkron gecikme normalde milisaniyelerdir. Ama yazmadan hemen sonraki okumalarda 500'de 499 bayat okuma ölçtük. Kendi yazdığını okumak için yazandan sonra birincile yönlendirme ya da LSN ile bekleme kullan. Kritik okumalar birincilden yapılır.
- Replikadaki uzun bir sorgu, replay'i 21 saniye durdurdu ve sonra iptal edildi. Gecikme, sorgu iptali ya da birincilde şişkinlik arasında seçim yapmak gerekir. Raporlamayı ayrı bir replikaya ya da veri ambarına taşı. Geride kalan replikayı okuma havuzundan çıkar.
- mod N ile parça eklemek anahtarların %80'ini taşır. Sanal düğümlü tutarlı halka ideal %20'yi taşır ve dengeli kalır. Veritabanlarında sabit mantıksal parçalar kullanılır.
- Parçalamada asıl karar anahtardır: erişim desenine uygun (çoğunlukla `kiraci_id`), dengeli, parçalar arası işlemleri azaltan. Kimlikler için UUIDv7. Parçalama en son ve en zor geri alınan adımdır.
