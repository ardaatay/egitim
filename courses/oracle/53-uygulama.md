# Uygulamadan bağlanmak: pool'lar, bind'lar, migration'lar

Kursun son dersi, veritabanı ile uygulama arasındaki sınırda: Bağlantıların nasıl açılıp yönetildiği, sorguların ağ üzerinden nasıl taşındığı, şema değişikliklerinin nasıl sürümlendiği ve uygulamanın veritabanı sorunlarına nasıl dayanıklı hale getirildiği. Önceki derslerdeki birçok ilke (bind değişkenleri, kısa transaction'lar, `MODULE` bilgisi, API paketleri) burada uygulama koduna dönüşüyor.

Ölçümler, ağ gecikmesi olmayan bir ortamda (konteynerin içinden `localhost`'a) alındı. Gerçek bir ağda farklar **daha büyük** olur. Node.js örnekleri `node-oracledb` sürücüsüyle yazıldı: Örnek koddur, bu kursun ortamında çalıştırılmadı. JDBC, Python (`python-oracledb`) ve Go sürücülerinde aynı kavramların karşılıkları var.

## Bağlantı açmak pahalıdır

Her Oracle bağlantısı, sunucuda bir **işletim sistemi süreci** (dedicated server) ve kimlik doğrulama, oturum oluşturma, bellek ayırma demektir. Ölçelim:

```bash
C="egitim/egitim@localhost:1521/FREEPDB1"
# 50 kez: bağlan, bir sorgu çalıştır, kapat
docker exec ora-egitim sh -c "s=\$(date +%s%N); for i in \$(seq 1 50); do echo 'SELECT 1 FROM dual;' | sqlplus -s -L $C >/dev/null; done; e=\$(date +%s%N); echo \"50 yeni bağlantı: \$(( (e-s)/1000000 )) ms\""
# tek bağlantıda 50 sorgu
docker exec ora-egitim sh -c "s=\$(date +%s%N); (for i in \$(seq 1 50); do echo 'SELECT 1 FROM dual;'; done; echo EXIT) | sqlplus -s -L $C >/dev/null; e=\$(date +%s%N); echo \"tek bağlantıda 50 sorgu: \$(( (e-s)/1000000 )) ms\""
```

```text
50 yeni bağlantı: 2517 ms
tek bağlantıda 50 sorgu: 62 ms
```

**40 kat.** (Ölçüm SQL\*Plus sürecinin başlamasını da içeriyor, ama sunucu tarafındaki süreç oluşturma ve oturum açma maliyeti bunun büyük kısmıdır.) Her HTTP isteğinde yeni bir veritabanı bağlantısı açan bir uygulama, her isteğe onlarca milisaniye ekler ve yük altında veritabanı sunucusunu süreç oluşturmakla meşgul eder.

### Yavaş bağlantının sinsi bir sebebi: isim çözümleme

Bu ölçümü hazırlarken, bağlantılar aniden 16–25 saniye sürmeye başladı. Sebep:

```bash
docker exec ora-egitim sh -c 'for c in "egitim/egitim@FREEPDB1" "egitim/egitim@localhost:1521/FREEPDB1"; do
  s=$(date +%s%N); echo "SELECT 1 FROM dual;" | sqlplus -s -L "$c" >/dev/null; e=$(date +%s%N)
  echo "$c: $(( (e-s)/1000000 )) ms"; done'
```

```text
egitim/egitim@FREEPDB1: 16332 ms
egitim/egitim@localhost:1521/FREEPDB1: 62 ms
```

`FREEPDB1` takma adı, imajın `tnsnames.ora` dosyasında `(HOST=)` (boş) olarak tanımlı: İstemci makinenin kendi adını çözümlemeye çalışıyor, ve konteynerin isim çözümlemesi (Docker Desktop'ın saat kaymasından sonra) yavaşlamıştı. Alert log'da tam o sırada bir uyarı vardı:

```text
--ATTENTION--
Time stall, backward drift ended at 1795685604 with drift 1000000
```

Üretimde aynı belirti şöyle görünür: "Bağlantılar bazen 5 ya da 30 saniye sürüyor ama veritabanı boşta." Bakılacak yerler: DNS çözümleme süresi (istemci ve sunucu tarafında), `sqlnet.ora`'daki ayarlar, `ORA-12170` zaman aşımları. Sunucu tarafında Oracle bağlanan istemcinin adını ters DNS ile çözümlemeye çalışırsa da aynı gecikme olur. Bağlantı dizgelerinde doğrudan çözümlenebilir host adları ya da IP'ler kullan, ve bağlantı açma süresini bir metrik olarak izle.

## Bağlantı havuzu

Uygulama, açılışta bir **havuz** (pool) oluşturur ve her istekte havuzdan bir bağlantı ödünç alıp hemen geri verir:

```js
// node-oracledb (örnek kod)
import oracledb from "oracledb";

const havuz = await oracledb.createPool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: "db.ornek.com:1521/deploy_svc",
  poolMin: 4,
  poolMax: 10,
  poolIncrement: 2,
  poolTimeout: 60,              // boşta kalan fazla bağlantıları 60 sn sonra kapat
  queueTimeout: 5000,           // havuz doluysa en fazla 5 sn bekle, sonra hata
  stmtCacheSize: 50,            // istemci tarafı ifade önbelleği
});

async function deployBaslat(uygulama, sunucu, surum) {
  const conn = await havuz.getConnection();
  try {
    conn.module = "deploy-servisi";        // V$SESSION.MODULE
    conn.action = "baslat";
    conn.clientId = istekKullanicisi;     // V$SESSION.CLIENT_IDENTIFIER, denetim, VPD
    conn.callTimeout = 10_000;            // tek bir çağrı en fazla 10 sn
    const r = await conn.execute(
      `BEGIN :id := deploy_api.baslat(:u, :s, :v); END;`,
      { id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }, u: uygulama, s: sunucu, v: surum },
      { autoCommit: true });
    return r.outBinds.id;
  } finally {
    await conn.close();                    // bağlantıyı havuza geri verir, kapatmaz
  }
}
```

### Havuz boyutu: küçük olmalı

Sezgiye aykırı ama önemli bir kural: **Havuzlar küçük olmalı.** Veritabanının aynı anda gerçekten çalıştırabileceği iş, CPU çekirdeği ve disk sayısıyla sınırlıdır. 8 çekirdekli bir veritabanında 500 eşzamanlı aktif oturum, işi hızlandırmaz: Oturumlar CPU kuyruğunda, kilit ve latch beklemelerinde birbirini bekler, her şey yavaşlar.

Hesap: 20 uygulama podu × 50'lik havuz = 1.000 bağlantı. İzleme dersindeki `processes = 200` sınırıyla, bu veritabanına bu kadar bağlantı **açılamaz** bile:

```sql
SELECT resource_name, current_utilization, max_utilization, limit_value
FROM v$resource_limit WHERE resource_name IN ('processes', 'sessions');
```

```text
RESOURCE_NAME  CURRENT_UTILIZATION MAX_UTILIZATION LIMIT_VALUE
-------------- ------------------- --------------- -----------
processes                       92             101         200
sessions                       120             134         322
```

Sınır aşılınca yeni bağlantılar `ORA-00020: maximum number of processes exceeded` ya da listener'dan `ORA-12516` alır. Kubernetes'te otomatik ölçekleme (HPA) yeni podlar eklediğinde, her pod kendi havuzunu açar ve bu sınıra sessizce yaklaşılır. Kural: **Pod sayısı × poolMax**, veritabanının kaldırabileceği bağlantı sayısının altında kalmalı. Ölçeklemenin üst sınırı (`maxReplicas`) buna göre belirlenir.

Pratik başlangıç: Pod başına `poolMax` 5–20 arası. Havuz sık doluyorsa (istekler `queueTimeout`'a çarpıyorsa), önce sorguların neden uzun sürdüğüne bak (izleme dersi): Bağlantılar uzun süre tutuluyorsa havuzu büyütmek sorunu sadece veritabanına taşır.

Bağlantı sayısı gerçekten çok yüksekse (yüzlerce mikroservis, serverless fonksiyonlar), Oracle'ın sunucu tarafı havuzu **DRCP** (Database Resident Connection Pooling) kullanılır: Uygulamalar çok sayıda hafif bağlantı açar, veritabanı onları az sayıda sunucu sürecine eşler (`connectString: "host:1521/deploy_svc:pooled"`). 23ai'nin **implicit connection pooling** özelliği, DRCP'yi uygulama değişikliği olmadan kullanmayı kolaylaştırır.

### Havuzla ilgili tuzaklar

- **Bağlantıyı geri vermeyi unutmak:** `finally` içinde `close()` olmayan bir hata yolu, her hatada bir bağlantı sızdırır. Havuz zamanla tükenir. Kendini nasıl gösterir: Uygulama tarafında `queueTimeout` hataları, veritabanı tarafında `INACTIVE` ve son çağrısı saatler önce olan oturumlar (izleme dersi).
- **Commit edilmemiş transaction'la geri vermek:** Önceki derslerin kilit zincirlerinin bir numaralı sebebi. Havuza geri dönen bağlantının transaction'ı, sürücüye göre ya geri alınır ya da bir sonraki kullanıcıya **açık olarak geçer**. Her işi açıkça commit ya da rollback et.
- **Oturum durumu sızıntısı:** `ALTER SESSION` ayarları, paket değişkenleri, `CLIENT_IDENTIFIER` havuzdaki bağlantıda kalır ve bir sonraki isteğe taşınır. VPD dersindeki uyarı buydu. Her istekte kendi değerlerini ayarla.
- **Ölü bağlantılar:** Bir güvenlik duvarı ya da load balancer, uzun süre boşta kalan TCP bağlantılarını sessizce düşürebilir. Uygulama havuzdan ölü bir bağlantı alır ve ilk sorguda `ORA-03113` ya da zaman aşımı yaşar. Çözümler: sunucu tarafında `SQLNET.EXPIRE_TIME` (TCP keepalive), havuzun bağlantıyı vermeden önce doğrulaması (`node-oracledb`'de `poolPingInterval`), ve `poolTimeout` ile uzun süre boşta kalanları kapatmak.

## Ağ gidiş-dönüşleri

Bir sorgunun süresi = veritabanındaki çalışma + **ağ gidiş-dönüşleri × gecikme**. İkinci kısım genellikle unutulur. 200.000 satırı farklı **fetch boyutlarıyla** (her gidiş-dönüşte kaç satır alınacağı) çekelim:

```sql
SET ARRAYSIZE 1
-- SQL*Net roundtrips to/from client istatistiği önce ve sonra
SELECT id, sunucu_id, seviye FROM olaylar;
SET ARRAYSIZE 500
SELECT id, sunucu_id, seviye FROM olaylar;
```

```text
arraysize 1:   100003 gidiş-dönüş     11018 ms
arraysize 500:    403 gidiş-dönüş       830 ms
```

Aynı veri, aynı sorgu: **13 kat** fark, hem de ağ gecikmesi **sıfırken** (istemci ve sunucu aynı makinede). Uygulama başka bir veri merkezindeyse ve gecikme 2 ms ise, 100.000 gidiş-dönüş tek başına 200 saniye ekler. Sürücülerdeki karşılıkları: `node-oracledb`'de `fetchArraySize` (varsayılan 100), JDBC'de `setFetchSize` (varsayılan **10**), `python-oracledb`'de `cursor.arraysize`. Çok satır çeken raporlar ve dışa aktarmalar için bu değeri büyüt (1.000 civarı). Tek satır çeken sorgular için önemsizdir.

Aynı ilke yazma tarafında da geçerli. 10.000 satırı döngüde tek tek eklemek 10.000 gidiş-dönüştür. Toplu bağlama (array bind) ile tek gidiş-dönüş:

```js
// tek tek: 10.000 gidiş-dönüş
for (const o of olaylar) {
  await conn.execute(`INSERT INTO olaylar (sunucu_id, zaman, seviye, mesaj) VALUES (:1, :2, :3, :4)`,
                     [o.sunucuId, o.zaman, o.seviye, o.mesaj]);
}

// toplu: tek gidiş-dönüş (PL/SQL'deki FORALL'ın istemci tarafı karşılığı)
await conn.executeMany(
  `INSERT INTO olaylar (sunucu_id, zaman, seviye, mesaj) VALUES (:1, :2, :3, :4)`,
  olaylar.map(o => [o.sunucuId, o.zaman, o.seviye, o.mesaj]),
  { autoCommit: true, batchErrors: true });     // batchErrors: hatalı satırları atla, raporla
```

Ve bir işi birden çok SQL ifadesiyle yapan uygulama kodu yerine tek bir PL/SQL çağrısı (deploy API paketi), dört gidiş-dönüşü bire indirir.

**İfade önbelleği** (`stmtCacheSize`): Sürücü, sık çalışan ifadelerin imlecini açık tutar, her çalışmada sunucuya yeniden ayrıştırma (soft parse) çağrısı yapmaz. Bind değişkenleriyle birlikte, optimizer dersindeki ayrıştırma maliyetini en aza indirir.

## Zaman aşımları ve dayanıklılık

Bir veritabanı sorunu (kilit, yavaş disk, ağ kesintisi) uygulamanın bütün iş parçacıklarını süresiz bekletmemeli:

- **Bağlantı alma zaman aşımı** (`queueTimeout`): Havuz doluysa sonsuza kadar bekleme.
- **Çağrı zaman aşımı** (`callTimeout`, JDBC'de `setQueryTimeout`): Tek bir veritabanı çağrısının en fazla süresi. Süre dolunca sürücü çağrıyı iptal eder, sunucu tarafında ifade durur ve geri alınır. Değeri, kullanıcının bekleyebileceği süreye göre seç: Bir API isteği için birkaç saniye, bir gece raporu için dakikalar.
- **Bağlantı kurma zaman aşımı:** `connectString` içinde ya da `tnsnames.ora`'da `CONNECT_TIMEOUT`, `TRANSPORT_CONNECT_TIMEOUT` (kurulum dersi). Varsayılanlar (dakikalar) bir API için çok uzundur.

**Yeniden deneme**, sadece güvenli olan hatalarda yapılır: `ORA-04068` (paket durumu, paketler dersi), bağlantı kopması (`ORA-03113`, `ORA-03135`) **ve** işlem idempotentse, `ORA-08177` (serializable), `ORA-00060` (deadlock, transaction geri alındıktan sonra). Bir `INSERT`'in bağlantı koptuğu anda commit edilip edilmediği belirsizdir. Körü körüne tekrarlamak çift kayıt üretir. Bunun için Oracle'ın **Transaction Guard** özelliği, bir transaction'ın sonucunu kesin olarak sorgulamayı sağlar, ve **Application Continuity** bu tekrarı sürücü seviyesinde güvenle yapar (RAC ve Data Guard geçişlerinde kesintisizlik için).

**Sağlık kontrolü** (Kubernetes kursundaki readiness probe): Uygulamanın `/healthz` ucu veritabanına basit bir sorgu (`SELECT 1 FROM dual`) gönderebilir, ama dikkatli ol. Veritabanı yavaşladığında **bütün** podlar aynı anda "hazır değil" olur ve load balancer'dan çıkarılır: Kısmi bir yavaşlık tam bir kesintiye dönüşür. Liveness probe asla veritabanına bağlı olmamalı (veritabanı sorunu podların sürekli yeniden başlatılmasına yol açar). Readiness için bağımlılık kontrolü, kısa zaman aşımı ve eşik değerleriyle yapılmalı.

## Şema değişiklikleri: migration'lar

Şema da kod gibi sürümlenir. Elle `ALTER TABLE` çalıştırmak yerine, sıralı ve sürüm kontrolündeki migration dosyaları bir araçla (Flyway, Liquibase; SQLcl'de dahili Liquibase var) uygulanır:

```text
db/migration/
├── V001__ornek_sema.sql
├── V002__kisiler_nobetler.sql
├── V003__deploylar_sure_kisiti.sql
└── R__deploy_api.sql            ← "repeatable": her değiştiğinde yeniden uygulanır (paketler, görünümler)
```

Araç, hangi migration'ların uygulandığını veritabanındaki bir tabloda tutar (`flyway_schema_history`, `DATABASECHANGELOG`) ve sadece yenilerini sırayla çalıştırır. CI/CD hattında uygulama deploy'undan önce bir adım olarak çalışır.

Oracle'a özgü dikkat noktaları:

- **DDL örtük commit yapar** (Oracle SQL farkları dersi). PostgreSQL'deki gibi bir migration'ı tek transaction'da çalıştırıp hata olursa geri almak mümkün değildir. Beş `ALTER TABLE` içeren bir migration üçüncüsünde hata verirse, ilk ikisi uygulanmış kalır ve araç migration'ı "başarısız" işaretler. Elle temizlik gerekir. Bu yüzden: **Her migration dosyasında tek bir DDL** (ya da birbirinden bağımsız küçük adımlar), ve betikleri **yeniden çalıştırılabilir** yaz (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD ... ` öncesi sözlük kontrolü). 23ai'nin `IF [NOT] EXISTS` desteği burada çok işe yarar.
- **Geriye uyumlu değişiklikler.** Uygulama sıfır kesintiyle (rolling) deploy ediliyorsa, bir süre eski ve yeni sürüm aynı anda çalışır. Şema değişikliği ikisiyle de uyumlu olmalı. Bir sütunu yeniden adlandırmak tek adımda yapılmaz:
  1. Yeni sütunu ekle (varsayılanlı sütun eklemek meta veridir, şema dersi), uygulamanın yeni sürümü iki sütuna da yazsın.
  2. Eski veriyi yeni sütuna taşı (büyük tabloda parti parti).
  3. Uygulama sadece yeni sütunu okusun.
  4. Bir sonraki sürümde eski sütunu kaldır (`SET UNUSED`, sonra `DROP`).
- **Kilitlenen DDL'ler.** Yoğun bir tabloda `ALTER TABLE`, tablo üzerinde kısa bir özel kilit ister. Tabloda uzun süren bir transaction varsa DDL onu bekler, ve DDL'in **arkasında** bütün yeni DML de bekler: Birkaç saniyelik bir migration, uygulamayı dakikalarca durdurabilir. `DDL_LOCK_TIMEOUT` ile bekleme süresini sınırla (transaction'lar dersi). Çevrimiçi seçenekleri kullan: `CREATE INDEX ... ONLINE`, `ALTER TABLE ... MOVE ONLINE`, `ENABLE NOVALIDATE` + sonra `VALIDATE`.
- **PL/SQL deploy'ları** paket durumu (`ORA-04068`) ve geçersizleşen nesneler (paketler dersi) yüzünden düşük trafikte yapılır, sonrasında `COMPILE_SCHEMA` çalıştırılır ve geçersiz nesne kalmadığı doğrulanır. Sıfır kesinti gerekiyorsa Edition-Based Redefinition.
- Migration'ı çalıştıran kullanıcı şema sahibidir (proxy ile), uygulama kullanıcısı değil (güvenlik dersi).

## Kursun özeti: üretim kontrol listesi

Bir Oracle veritabanını üretime alırken ya da devralırken bu kursun derslerinden bir kontrol listesi:

| Alan | Kontrol | Ders |
|---|---|---|
| Bağlantı | Uygulama ayrı kullanıcıyla, havuzla bağlanıyor; pod × poolMax < processes | Güvenlik, bu ders |
| Bağlantı | `MODULE`/`ACTION`/`CLIENT_IDENTIFIER` ayarlanıyor | İzleme |
| SQL | Bind değişkenleri; literal SQL yok (`FORCE_MATCHING_SIGNATURE`) | Optimizer |
| SQL | Uygun fetch boyutu, toplu yazma | Bu ders |
| Şema | Adlandırılmış kısıtlar, indeksli yabancı anahtarlar, `VARCHAR2(n CHAR)` | Şema, SQL farkları |
| İstatistik | Otomatik istatistik işi açık, toplu yüklemelerden sonra toplanıyor | Optimizer |
| Kilitler | Kısa transaction'lar, açık transaction'lı boşta oturum alarmı | Transaction, izleme |
| Depolama | Tablespace + disk doluluğu, FRA doluluğu izleniyor | Depolama |
| Redo | En az 3 grup, çoklanmış, uygun boyut | Depolama |
| Yedek | ARCHIVELOG açık, RMAN yedekleri başka yere, geri yükleme test ediliyor | Yedekleme |
| Güvenlik | En az yetki, `READ` rapor kullanıcıları, denetim politikaları, ağ şifreleme | Güvenlik |
| Zamanlanmış işler | Açık zaman dilimi, başarısızlık izleniyor | PL/SQL |
| Lisans | Kullanılan özellikler lisansla uyumlu (partitioning, ASH/AWR, TDE) | Çeşitli |

## Alıştırma

1. Bir API'nin p99 yanıt süresi her gün 09:00'da 5 saniyeye çıkıyor, veritabanı CPU'su düşük. Uygulama logunda `queueTimeout` hataları var. Hangi iki olasılığı araştırırsın ve hangi sorgularla?
2. Bir rapor ucunun 50.000 satır döndürmesi 40 saniye sürüyor, ama aynı sorgu SQL Developer'da 2 saniyede bitiyor. İlk şüphen ne?
3. `ALTER TABLE deploylar ADD (notlar VARCHAR2(500))` içeren bir migration üretimde 3 dakika boyunca uygulamayı durdurdu. Ne olmuş olabilir, nasıl önlenir?

<details><summary>Çözüm</summary>

1. Havuz tükenmesi, ve veritabanı CPU'su düşük olduğuna göre bağlantılar **bekliyor**, iş yapmıyor. (a) **Kilit:** 09:00'da başlayan bir toplu iş ya da bir yönetici işlemi satırları kilitliyor, API istekleri bekliyor. İzleme dersindeki kilit ağacı sorgusu ve ASH'de `enq: TX - row lock contention`. (b) **Bağlantı sızıntısı / uzun tutulan bağlantılar:** Sabah trafiği artınca, bağlantıyı geri vermeyen ya da uzun süre tutan bir kod yolu havuzu tüketiyor. `V$SESSION`'da `MODULE` bazında `INACTIVE` oturum sayısı ve `LAST_CALL_ET`, açık transaction'lı boşta oturumlar. Üçüncü bir olasılık da 09:00'da başlayan bir zamanlanmış işin (yanlış saat dilimi?) kaynakları kilitlemesi.

2. **Fetch boyutu.** SQL Developer büyük bir fetch boyutu kullanıyor olabilir, uygulama sürücüsü ise varsayılan küçük değerle (JDBC'de 10) 5.000 gidiş-dönüş yapıyor. Uygulama veritabanından uzaktaysa her gidiş-dönüş milisaniyeler ekler. `V$SQL`'de sorgunun `ELAPSED_TIME`'ı düşükse (veritabanı tarafı hızlı) ama uygulama tarafında yavaşsa, zaman ağda harcanıyor. Ayrıca ASH'de `SQL*Net more data to client` beklemesi görülür. Çözüm: fetch boyutunu büyüt ya da gereken sütunları ve satırları azalt (sayfalama).

3. `ADD COLUMN` kendisi meta veri işlemidir ve anında biter, ama tablo üzerinde kısa bir özel DDL kilidi ister. Tabloda uzun süren açık bir transaction vardı (örneğin commit edilmemiş bir toplu güncelleme). DDL onu bekledi, ve DDL kuyrukta beklerken `deploylar`'a gelen **bütün yeni DML** de DDL'in arkasında bekledi: Uygulama durdu. Önlem: Migration oturumunda `ALTER SESSION SET DDL_LOCK_TIMEOUT = 5` (beklemeyi sınırla, başarısız olursa tekrar dene), migration'dan önce tablodaki açık transaction'ları kontrol et, ve migration'ları düşük trafik saatlerinde çalıştır.

</details>

```quiz
20 uygulama podu, her biri poolMax = 50 ile çalışıyor. Veritabanında processes = 300. Ne olur?
- Sorun yok, havuzlar ihtiyaç kadar bağlantı açar
- [x] Yük altında toplam bağlantı 1.000'e çıkmaya çalışır, sınır aşılır ve yeni bağlantılar ORA-00020/ORA-12516 alır
- Oracle otomatik olarak processes değerini artırır
? Pod sayısı × poolMax veritabanının kapasitesinin altında kalmalı; havuzlar küçük olmalı.
```

```quiz
Bir sorgu veritabanında hızlı çalışıyor ama uygulamaya 100.000 satırın gelmesi çok uzun sürüyor. En olası sebep?
- Optimizer kötü plan seçti
- [x] Küçük fetch boyutu: her gidiş-dönüşte az satır, binlerce gidiş-dönüş × ağ gecikmesi
- Tablo istatistikleri eski
? arraysize 1 ile 100.003, 500 ile 403 gidiş-dönüş: aynı veri, 13 kat süre farkı.
```

```quiz
Oracle'da bir migration dosyasına neden birden fazla DDL koymaktan kaçınılır?
- Oracle bir dosyada tek DDL kabul eder
- [x] Her DDL örtük commit yapar; ortadaki bir DDL hata verirse öncekiler uygulanmış kalır ve migration geri alınamaz
- Migration araçları buna izin vermez
? Küçük, yeniden çalıştırılabilir adımlar ve IF [NOT] EXISTS kullan.
```

## Özet

- Bağlantı açmak pahalıdır (50 yeni bağlantı 2,5 sn, tek bağlantıda 50 sorgu 62 ms): havuz kullan. Yavaş bağlantıların sinsi sebebi isim çözümleme olabilir.
- Havuzlar küçük olmalı: pod × poolMax < processes. Çok sayıda istemci için DRCP.
- Havuz tuzakları: geri verilmeyen bağlantılar, commit edilmemiş transaction'lar, oturum durumu sızıntısı, ölü bağlantılar (keepalive, ping).
- Gidiş-dönüşler: fetch boyutu (13 kat fark, ağ gecikmesi sıfırken), toplu yazma (`executeMany`), PL/SQL API ile tek çağrı, ifade önbelleği.
- Zaman aşımları (bağlantı alma, çağrı, bağlantı kurma), güvenli yeniden deneme, Transaction Guard / Application Continuity. Readiness probe'u dikkatli tasarla, liveness'ı veritabanına bağlama.
- Migration'lar: sürüm kontrolünde, tek DDL'li ve yeniden çalıştırılabilir adımlar, geriye uyumlu değişiklikler, `DDL_LOCK_TIMEOUT`, PL/SQL deploy'undan sonra derleme.

Tebrikler, Oracle kursunu bitirdin. Mimariden SQL'e, PL/SQL'den performansa ve operasyona kadar, bir Oracle veritabanını geliştirip işletmek için gereken temel parçalar elinde.
