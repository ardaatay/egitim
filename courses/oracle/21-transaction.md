# Transaction'lar, okuma tutarlılığı, undo ve kilitler

"Uygulama donuyor ama CPU boşta", "bazı istekler 30 saniye sonra zaman aşımına uğruyor", "iki kullanıcı aynı anda kaydedince biri kayboluyor". Bu şikâyetlerin çoğu veritabanında **eşzamanlılık** sorunlarıdır: kilit beklemeleri, kayıp güncellemeler, deadlock'lar. Bu derste Oracle'ın eşzamanlılık modelini (okuyucular yazarları beklemez, yazarlar okuyucuları beklemez), kilitlerin nasıl alındığını ve izlendiğini, iş kuyruğu kurmanın doğru yolunu ve izolasyon seviyelerini ele alıyoruz.

Bu dersteki örneklerin bir kısmı **iki ya da üç oturum** gerektirir. İki terminal aç, ikisinde de `docker exec -it ora-egitim sqlplus egitim/egitim@FREEPDB1` ile bağlan. İzleme sorguları için üçüncü bir terminalde `system` olarak bağlan. Çıktılar, oturumlar gerçekten eşzamanlı çalıştırılarak alındı.

## Transaction'ın sınırları

Oracle'da `BEGIN TRANSACTION` yoktur. İlk DML ifadesi (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `SELECT ... FOR UPDATE`) bir transaction başlatır; `COMMIT` ya da `ROLLBACK` bitirir. DDL ifadeleri örtük commit yapar (Oracle SQL farkları dersinde gördük). Oturum normal kapanırsa (SQL\*Plus'ta `EXIT`) bekleyen işler **commit edilir**; bağlantı koparsa ya da süreç ölürse **geri alınır**. Bu farka güvenme, her zaman açıkça bitir.

### İfade seviyesinde geri alma

Bir ifade hata verirse sadece **o ifade** geri alınır, transaction'ın geri kalanı yerinde durur:

```sql
INSERT INTO nobetler (kisi_id, baslangic, bitis)
VALUES (3, TIMESTAMP '2026-11-27 09:00:00', TIMESTAMP '2026-11-27 21:00:00');   -- başarılı
INSERT INTO nobetler (kisi_id, baslangic, bitis)
VALUES (3, TIMESTAMP '2026-11-28 09:00:00', TIMESTAMP '2026-11-28 08:00:00');   -- hata
SELECT COUNT(*) AS bekleyen FROM nobetler WHERE kisi_id = 3;
```

```text
1 row created.
ORA-02290: check constraint (EGITIM.NOBETLER_ARALIK_CK) violated

  BEKLEYEN
----------
         1
```

İlk ekleme hâlâ transaction'da, commit bekliyor. Uygulama kodunda bunun anlamı: Bir hata yakaladığında transaction'ı **açıkça** geri al (`ROLLBACK`) ya da bilinçli olarak devam et. Hatayı yakalayıp hiçbir şey yapmadan sonraki işleme geçen ve en sonda `COMMIT` eden kod, yarım işi kalıcı hale getirir. PostgreSQL'de bir hatadan sonra transaction "aborted" durumuna geçer ve başka ifade kabul etmez; Oracle'da etmez, devam eder. Bu farkı bilmeyen geliştiriciler için tehlikelidir.

### Savepoint

```sql
SAVEPOINT once;
DELETE FROM nobetler;                 -- 3 rows deleted.
ROLLBACK TO SAVEPOINT once;           -- sadece savepoint'ten sonrası geri alınır
SELECT COUNT(*) FROM nobetler;        -- 3
ROLLBACK;                             -- hepsi
```

Savepoint'ler, uzun bir işlemin bir adımı başarısız olduğunda o adımı geri alıp alternatif bir yol denemek için kullanılır. ORM'lerdeki "iç içe transaction" kavramı genellikle savepoint'lerle uygulanır.

## Okuma tutarlılığı: undo

Oracle'ın eşzamanlılık modelinin merkezinde **çoklu sürüm okuma tutarlılığı** (multi-version read consistency) vardır:

1. Bir sorgu başladığında o anın sistem değişiklik numarası (**SCN**) kaydedilir.
2. Sorgu bir blok okurken, blokta o SCN'den sonra commit edilmiş (ya da hiç commit edilmemiş) bir değişiklik görürse, bloğun eski halini **undo** kayıtlarından yeniden oluşturur.
3. Sonuç: Sorgu, verinin **başladığı andaki** tutarlı bir görüntüsünü görür. Sorgu 10 dakika sürse ve bu sırada tablo değişse bile.

Pratik sonuçları:

- **Kirli okuma yoktur:** Commit edilmemiş değişiklikleri başka oturumlar asla görmez.
- **Okuyucular yazarları beklemez, yazarlar okuyucuları beklemez:** `SELECT` hiçbir zaman satır kilidi almaz ve bir kilit yüzünden beklemez. SQL Server'ın varsayılan ayarlarındaki "okuma kilidi" sorunları Oracle'da yoktur.
- **Yazarlar yazarları bekler:** Aynı satırı değiştirmek isteyen ikinci oturum, birincisi commit ya da rollback yapana kadar bekler.

İki oturumla görelim. A oturumu satırı değiştirir ve commit etmeden bekler, B önce okur, sonra aynı satırı değiştirmeye çalışır:

```sql
-- A oturumu
UPDATE sunucular SET durum = 'bakimda' WHERE id = 5;
-- (commit yok)
```

```sql
-- B oturumu
SET TIMING ON
SELECT durum FROM sunucular WHERE id = 5;
UPDATE sunucular SET cpu = cpu WHERE id = 5;
```

```text
DURUM
----------
calisiyor                  ← A'nın commit edilmemiş değişikliğini görmez, beklemez
Elapsed: 00:00:00.07

1 row updated.             ← A commit edene kadar bekledi
Elapsed: 00:00:07.25
```

B'nin okuması anında döndü ve eski değeri gösterdi. Güncellemesi ise A commit edene kadar **7 saniye** bekledi. Beklerken B'nin tarafında hiçbir hata ya da uyarı yoktur: Sadece "takılır". Uygulama tarafında bu, isteğin yavaşlaması ya da bağlantı havuzunun tükenmesi olarak görünür.

A'nın değişikliğini geri al: `UPDATE sunucular SET durum = 'calisiyor' WHERE id = 5; COMMIT;`

### Kim kimi bekliyor?

Kilitlenme yaşanırken üçüncü bir oturumdan (`system` olarak):

```sql
SELECT s.sid, s.username, s.status, s.blocking_session AS engelleyen,
       s.event, s.seconds_in_wait AS bekleme_sn,
       SUBSTR(q.sql_text, 1, 45) AS sql_text
FROM v$session s
LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number
WHERE s.username = 'EGITIM'
ORDER BY s.sid;
```

```text
 SID USERNAME STATUS   ENGELLEYEN EVENT                          BEKLEME_SN SQL_TEXT
---- -------- -------- ---------- ------------------------------ ---------- ---------------------------------------------
  20 EGITIM   ACTIVE              PL/SQL lock timer                       2 BEGIN DBMS_SESSION.SLEEP(8); END;
 216 EGITIM   ACTIVE           20 enq: TX - row lock contention           2 UPDATE sunucular SET cpu = cpu WHERE id = 5
```

- `BLOCKING_SESSION`: Bekleyen oturumu (216) engelleyen oturum (20).
- `enq: TX - row lock contention`: satır kilidi beklemesi. Operasyonda en sık görülen bekleme olaylarından biri.
- Engelleyen oturum burada `ACTIVE` çünkü test için uyutuldu. **Gerçek hayatta engelleyen genellikle `INACTIVE`'dir:** Bir uygulama transaction açmış, bir satırı güncellemiş, sonra commit etmeyi unutmuş (ya da bir HTTP çağrısı bekliyor, ya da bir hata yolunda bağlantıyı havuza commit etmeden geri vermiş). Oturum boşta ama kilidi tutuyor. `SQL_TEXT` de o an çalışan bir şey olmadığı için boştur; o oturumun son çalıştırdığı sorgu `PREV_SQL_ID`'dedir.

Hangi satırı bekliyor, ve engelleyenin transaction'ı ne zamandan beri açık?

```sql
SELECT s.sid, o.object_name AS nesne,
       DBMS_ROWID.ROWID_CREATE(1, s.row_wait_obj#, s.row_wait_file#, s.row_wait_block#, s.row_wait_row#) AS satir_rowid
FROM v$session s JOIN dba_objects o ON o.object_id = s.row_wait_obj#
WHERE s.blocking_session IS NOT NULL;

SELECT s.sid, s.status, s.prev_sql_id, t.start_time, t.used_urec AS undo_kayit
FROM v$session s JOIN v$transaction t ON t.addr = s.taddr
WHERE s.username = 'EGITIM';
```

```text
 SID NESNE      SATIR_ROWID
---- ---------- ------------------
 216 SUNUCULAR  AAASAFAAYAAAAA+AAE

 SID STATUS   PREV_SQL_ID   START_TIME           UNDO_KAYIT
---- -------- ------------- -------------------- ----------
  20 ACTIVE   6m1uapk1ydykj 11/26/26 07:00:25             1
```

`SELECT * FROM egitim.sunucular WHERE ROWID = 'AAASAFAAYAAAAA+AAE'` beklenen satırı gösterir. `V$TRANSACTION.START_TIME` ve `USED_UREC` (ürettiği undo kaydı sayısı) uzun süredir açık kalan ve büyüyen transaction'ları bulmak için kullanılır. Saatlerdir açık bir transaction neredeyse her zaman bir hatadır.

Engelleyeni sonlandırmak, son çare olarak:

```sql
ALTER SYSTEM KILL SESSION '20,<serial#>' IMMEDIATE;   -- serial#: v$session.serial#
```

Sonlandırılan oturumun transaction'ı **geri alınır**. Büyük bir transaction'ın geri alınması, ilerlemesi kadar sürebilir. Öldürmeden önce engelleyenin ne yaptığını ve kime ait olduğunu (`MACHINE`, `PROGRAM`, `MODULE`, `CLIENT_IDENTIFIER` sütunları) öğren: Asıl düzeltme, commit etmeyi unutan koddadır.

### Bekleme süresini sınırlamak

Varsayılan olarak bir oturum kilidi **sonsuza kadar** bekler. Etkileşimli işlemlerde (kullanıcı bir butona bastı) bu kabul edilemez:

```sql
SELECT id FROM isler WHERE id = 1 FOR UPDATE NOWAIT;    -- kilitliyse hemen hata
SELECT id FROM isler WHERE id = 1 FOR UPDATE WAIT 2;    -- en fazla 2 saniye bekle
```

```text
ORA-00054: Failed to acquire a lock (Type: "TX", Name: "Transaction", ...)
           because it is currently held by another session.
ORA-40097: Failure to acquire row lock, currently held by transaction ID 3.29.728
Elapsed: 00:00:02.00   (WAIT 2 için)
```

Uygulama `ORA-00054`'ü yakalayıp "bu kayıt şu an başka biri tarafından düzenleniyor" diyebilir. DDL için `DDL_LOCK_TIMEOUT` oturum parametresi aynı işi görür: Yoğun bir tabloya `ALTER TABLE` yaparken DDL'in sonsuza kadar beklememesi (ve arkasında bütün DML'i kuyruğa sokmaması) için.

## Kayıp güncelleme ve SELECT FOR UPDATE

Klasik eşzamanlılık hatası: İki istek bir sunucunun CPU değerini okur (8), ikisi de uygulamada 1 ekler (9) ve geri yazar. Sonuç 10 olmalıydı, 9 oldu.

```sql
-- yanlış: oku-değiştir-yaz, arada kilit yok
SELECT cpu FROM sunucular WHERE id = 2;          -- 8 (uygulama 9 hesaplar)
UPDATE sunucular SET cpu = 9 WHERE id = 2;
```

Üç çözüm var:

1. **Atomik güncelleme**: Hesaplamayı SQL'e bırak: `UPDATE sunucular SET cpu = cpu + 1 WHERE id = 2`. İkinci oturum birincinin commit'ini bekler ve **güncel** değerin üstüne ekler. Mümkünse her zaman bu.
2. **Kötümser kilitleme**: `SELECT ... FOR UPDATE` ile okurken kilitle, hesapla, yaz, commit et. İkinci okuyucu birincinin bitmesini bekler. Kilit süresi kısa olmalı: Kullanıcı arayüzde düşünürken asla kilit tutma.
3. **İyimser kilitleme**: Satırda bir sürüm sütunu tut; yazarken kontrol et:

```sql
UPDATE sunucular SET cpu = :yeni, surum = surum + 1
WHERE id = :id AND surum = :okunan_surum;
-- 0 satır güncellendiyse: araya biri girmiş, kullanıcıya "kayıt değişti" de
```

İyimser kilitleme, kullanıcının bir formu dakikalarca açık tuttuğu web uygulamaları için standart yöntemdir. JSON dersindeki Duality görünümlerinin etag'i bunun hazır bir uygulamasıdır. Hibernate/JPA'daki `@Version` da aynı şeydir.

## İş kuyruğu: SKIP LOCKED

Birden çok işçinin aynı tablodan iş aldığı bir kuyruk düşün: e-posta gönderimi, rapor üretimi, deploy görevleri. Her işçi "bekleyen ilk N işi" almalı ve iki işçi asla aynı işi almamalı. `FOR UPDATE` tek başına işçileri sıraya sokar (ikincisi birincinin kilitlediği satırları bekler). `SKIP LOCKED` kilitli satırları **atlar**:

```sql
CREATE TABLE isler (id NUMBER PRIMARY KEY, durum VARCHAR2(10) DEFAULT 'bekliyor' NOT NULL, isci VARCHAR2(5));
INSERT INTO isler (id) SELECT level FROM dual CONNECT BY level <= 6;
COMMIT;
```

Doğru kalıp bir imleçle (cursor) çalışır. A ve B işçileri eşzamanlı çalıştırıldı:

```sql
DECLARE
  CURSOR c IS SELECT id FROM isler WHERE durum = 'bekliyor' ORDER BY id FOR UPDATE SKIP LOCKED;
  TYPE t_ids IS TABLE OF isler.id%TYPE;
  v t_ids;
BEGIN
  OPEN c; FETCH c BULK COLLECT INTO v LIMIT 2; CLOSE c;
  FOR i IN 1 .. v.COUNT LOOP
    UPDATE isler SET durum = 'calisiyor', isci = 'A' WHERE id = v(i);   -- B'de 'B'
    DBMS_OUTPUT.PUT_LINE('[A] aldi: ' || v(i));
  END LOOP;
  COMMIT;
END;
/
```

```text
[A] aldi: 1
[A] aldi: 2
[B] aldi: 3
[B] aldi: 4

  ID DURUM      ISCI
---- ---------- -----
   1 calisiyor  A
   2 calisiyor  A
   3 calisiyor  B
   4 calisiyor  B
   5 bekliyor
   6 bekliyor
```

İki işçi aynı anda çalıştı, birbirini beklemedi, aynı işi almadı. Satırlar `FETCH` sırasında, birer birer kilitlenir; kilitli olanlar atlanır.

Yaygın bir hata: `ROWNUM` ile sınırlamak.

```sql
-- B işçisi, A ilk iki satırı kilitliyken:
SELECT id FROM isler WHERE durum = 'bekliyor' AND ROWNUM <= 2 FOR UPDATE SKIP LOCKED;
```

```text
no rows selected
```

`ROWNUM <= 2` kilitlemeden **önce** uygulanır: Oracle ilk iki satırı seçer (1 ve 2), sonra onları kilitlemeye çalışır, ikisi de kilitli olduğu için atlar ve elinde hiçbir şey kalmaz. 3, 4, 5, 6 hazırdayken işçi "iş yok" sonucuna varır.

23ai/26ai'de `FETCH FIRST` ise doğru çalışır: Satır sınırı, kilitli satırlar atlandıktan **sonra** uygulanır. 5 numaralı iş başka bir oturum tarafından kilitliyken:

```sql
SELECT id FROM isler WHERE durum = 'bekliyor'
ORDER BY id FETCH FIRST 1 ROWS ONLY FOR UPDATE SKIP LOCKED;
```

```text
        ID
----------
         6
```

Eski sürümlerde (19c ve öncesi) `FETCH FIRST` ile `FOR UPDATE` birlikte kullanılamıyordu, bu yüzden 19c'de de çalışması gereken kodda imleç + `LIMIT` kalıbını kullan. Uygulama dillerinde de aynı fikir geçerli: Sorguyu `FOR UPDATE SKIP LOCKED` ile çalıştır, sürücüden sadece ilk N satırı çek.

Daha büyük ölçekte Oracle'ın yerleşik kuyruk sistemi **Transactional Event Queues** (`DBMS_AQ`) kullanılır. Ama basit iş kuyrukları için `SKIP LOCKED` tablosu yaygın ve yeterli bir kalıptır.

## Deadlock

İki oturum birbirinin kilitlediği satırları isterse hiçbiri ilerleyemez. A satır 1'i, B satır 2'yi kilitler; sonra A 2'yi, B 1'i ister:

```text
-- A                                   -- B
UPDATE ... WHERE id = 1;  (kilitli)
                                        UPDATE ... WHERE id = 2;  (kilitli)
UPDATE ... WHERE id = 2;  (bekliyor)
                                        UPDATE ... WHERE id = 1;  (bekliyor)
```

```text
[A] 2 isteniyor
ORA-00060: deadlock detected while waiting for resource
Elapsed: 00:00:03.41

[B] 1 isteniyor
1 row updated.
Elapsed: 00:00:04.39
```

Oracle deadlock'u yaklaşık 3 saniye içinde tespit etti ve oturumlardan birinin **ifadesini** (`UPDATE ... id = 2`) geri aldı. Dikkat: B'nin güncellemesi 3,4 değil 4,4 saniye sürdü. Çünkü A'nın sadece son ifadesi geri alındı, **transaction'ı değil**: A hâlâ satır 1'in kilidini tutuyordu ve B, A testteki sonraki adımda `ROLLBACK` yapana kadar bekledi. Uygulama `ORA-00060` alınca transaction'ı **mutlaka geri almalı** (ve gerekiyorsa baştan denemeli). Hatayı yutup devam eden kod, karşı tarafı beklemeye devam ettirir.

Her deadlock alert log'a ve bir trace dosyasına yazılır. Trace dosyasında iki oturumun SQL'leri ve beklenen satırlar bulunur. Önleme:

- Satırları her zaman **aynı sırayla** kilitle (örneğin `ORDER BY id` ile `SELECT ... FOR UPDATE`). Yukarıdaki deadlock, iki oturum da önce 1'i sonra 2'yi isteseydi oluşmazdı.
- Transaction'ları kısa tut.
- İndekssiz yabancı anahtarlar (önceki ders) beklenmedik tablo kilitleri ve deadlock'ların sık bir kaynağıdır.

## İzolasyon seviyeleri

Oracle'da iki izolasyon seviyesi kullanılır:

- **READ COMMITTED** (varsayılan): Her **ifade**, kendi başladığı andaki commit edilmiş veriyi görür. Aynı transaction'daki iki sorgu arasında başka biri commit ederse, ikinci sorgu yeni değeri görür.
- **SERIALIZABLE**: Bütün **transaction**, başladığı andaki veriyi görür. Transaction'ın başladığından sonra başka biri tarafından değiştirilmiş bir satırı değiştirmeye çalışırsa hata alır.

```sql
-- A oturumu
ALTER SESSION SET ISOLATION_LEVEL = SERIALIZABLE;
SELECT cpu FROM sunucular WHERE id = 3;         -- 16

-- B oturumu (bu sırada)
UPDATE sunucular SET cpu = 32 WHERE id = 3;
COMMIT;

-- A oturumu
SELECT cpu FROM sunucular WHERE id = 3;         -- hâlâ 16: transaction başındaki görüntü
UPDATE sunucular SET cpu = cpu WHERE id = 3;
```

```text
       CPU
----------
        16

ORA-08177: can't serialize access for this transaction
```

`READ COMMITTED`'a dönüp tekrar okuyunca 32 görülür. `SERIALIZABLE`, birden çok sorgunun **birbiriyle tutarlı** olması gereken raporlar (bir bilançonun iki tarafı) ve "kontrol et, sonra yaz" mantığının araya giren değişikliklere karşı korunması gereken işlemler için kullanılır. Bedeli: Uygulama `ORA-08177`'yi yakalayıp transaction'ı **yeniden denemeye** hazır olmalı. Sadece okuma yapan tutarlı raporlar için daha basit bir seçenek: `SET TRANSACTION READ ONLY`. Hata riski olmadan transaction boyunca tek bir anın görüntüsünü verir.

B'nin değişikliğini geri al: `UPDATE sunucular SET cpu = 16 WHERE id = 3; COMMIT;`

Oracle'da `READ UNCOMMITTED` yoktur (kirli okuma hiçbir zaman mümkün değildir). `REPEATABLE READ` de yoktur, `SERIALIZABLE` onu kapsar.

## Undo yönetimi ve ORA-01555

Okuma tutarlılığı undo'ya bağlıdır: Uzun süren bir sorgu, başladığı andaki görüntüyü yeniden oluşturmak için gereken undo kayıtlarının **hâlâ** durmasına ihtiyaç duyar. Undo alanı sınırlıdır ve commit edilmiş transaction'ların undo'su zamanla üzerine yazılır. Gereken undo artık yoksa:

```text
ORA-01555: snapshot too old: rollback segment number 7 with name "_SYSSMU7_..." too small
```

Bu hata **sorguya** gelir, onu üreten değişikliğe değil: Gece çalışan 2 saatlik bir rapor, gündüz yoğun güncelleme yapılan bir tablo üzerinde başarısız olur. Ayarlar (`system` olarak):

```sql
SELECT name, display_value FROM v$parameter
WHERE name IN ('undo_retention', 'undo_management', 'undo_tablespace');

SELECT MAX(maxquerylen) AS en_uzun_sorgu_sn, SUM(ssolderrcnt) AS ora_01555,
       SUM(nospaceerrcnt) AS yer_yok, ROUND(MAX(tuned_undoretention)/60) AS ayarli_retention_dk
FROM v$undostat;
```

```text
NAME                   DISPLAY_VALUE
---------------------- -------------
undo_management        AUTO
undo_tablespace        UNDOTBS1
undo_retention         900

EN_UZUN_SORGU_SN  ORA_01555    YER_YOK AYARLI_RETENTION_DK
---------------- ---------- ---------- -------------------
               0          0          0                  15
```

- `UNDO_RETENTION = 900`: Commit edilmiş undo'yu **en az** 15 dakika tutmaya çalış. Bu bir hedeftir, garanti değildir: Undo alanı dolarsa yeni transaction'lar için eski undo'nun üzerine yazılır (`RETENTION GUARANTEE` ile garanti edilebilir, ama o zaman da yer kalmayınca **DML** hata verir).
- `V$UNDOSTAT`: 10 dakikalık aralıklarla undo kullanımı, en uzun sorgu süresi (`MAXQUERYLEN`) ve ORA-01555 sayısı (`SSOLDERRCNT`). En uzun sorgu süresi retention'dan büyükse risk vardır.
- Çözümler: undo tablespace'i ve `UNDO_RETENTION`'ı büyütmek, uzun sorguyu hızlandırmak, ya da raporu yoğun yazma saatlerinin dışına almak.

Bir başka klasik ORA-01555 sebebi: Büyük bir tabloyu bir imleçle okurken, **aynı tabloyu** döngü içinde güncelleyip sık sık commit etmek ("fetch across commit"). Her commit, imlecin ihtiyaç duyduğu undo'yu üzerine yazılabilir hale getirir. Bu yüzden toplu işlerde "her 1000 satırda commit" alışkanlığı hem bu hataya hem de yarım kalma riskine yol açar. Bir sonraki bölümde PL/SQL'de toplu işlemeyi doğru yapmayı göreceğiz.

### Flashback query: geçmişe bakmak

Aynı undo verisi, geçmişteki bir anı sorgulamak için de kullanılabilir. "Biri yanlışlıkla bir değeri değiştirdi, eskisi neydi?"

```sql
UPDATE sunucular SET bellek_gb = 999 WHERE id = 10;
COMMIT;
-- bir dakika sonra:
SELECT bellek_gb AS simdi FROM sunucular WHERE id = 10;
SELECT bellek_gb AS bir_dk_once FROM sunucular AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '1' MINUTE) WHERE id = 10;
```

```text
     SIMDI
----------
       999

BIR_DK_ONCE
-----------
         32
```

Ve geri yükleme, yine tek bir ifade:

```sql
UPDATE sunucular s
SET bellek_gb = (SELECT bellek_gb FROM sunucular AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '1' MINUTE) o
                 WHERE o.id = s.id)
WHERE id = 10;
COMMIT;
```

Flashback query, undo retention süresi kadar geriye gidebilir (burada yaklaşık 15 dakika). Zaman damgası, Oracle içinde yaklaşık 3 saniyelik bir hassasiyetle SCN'e çevrilir; kesin nokta gerekiyorsa `AS OF SCN` kullan. `VERSIONS BETWEEN TIMESTAMP ... AND ...` ise bir satırın bu aralıktaki bütün sürümlerini, işlem türüyle (`VERSIONS_OPERATION`: I/U/D) birlikte listeler. Daha eski veriye ve bütün bir tabloyu geri almaya yedekleme dersinde değineceğiz.

## Alıştırma

1. İki oturumla dene: A, bir nöbet satırını `FOR UPDATE` ile kilitlesin. B aynı satırı `WAIT 3` ile kilitlemeye çalışsın. Ne olur? Sonra A commit etsin ve B tekrar denesin.
2. Bir uygulama `ORA-00060` aldıktan sonra hatayı loglayıp aynı transaction'da işine devam ediyor ve en sonda commit ediyor. Bunun iki farklı kötü sonucu ne olabilir?
3. `isler` kuyruğunda bir işçi işi aldıktan sonra çöküyor. İş `calisiyor` durumunda kalıyor, kimse tekrar almıyor. Bunu nasıl önlersin?

<details><summary>Çözüm</summary>

1. B 3 saniye bekler ve `ORA-00054` alır. A commit ettikten sonra B'nin tekrar denemesi hemen başarılı olur. B'nin `FOR UPDATE` sorgusu kilitlenen satırı (A'nın değişiklikleriyle) okur.

2. (a) Deadlock'ta sadece son ifade geri alındığı için transaction yarım kalmıştır. Örneğin bir hesaptan para düşülmüş ama diğerine eklenmemiştir, ve commit bu yarım durumu kalıcı yapar. (b) Commit edene kadar transaction'ın tuttuğu kilitler durmaya devam eder, deadlock'un diğer tarafındaki oturum (ve onun arkasında bekleyenler) gereksiz yere bekler. Doğrusu: `ORA-00060`'ta `ROLLBACK`, sonra (idempotentse) bütün transaction'ı yeniden dene.

3. Birkaç kalıp birlikte kullanılır:
   - İşi alırken bir **kira süresi** yaz: `UPDATE isler SET durum = 'calisiyor', isci = :ben, kira_bitis = SYSTIMESTAMP + INTERVAL '5' MINUTE`. İşçiler bekleyenlere ek olarak kirası dolmuş işleri de alır: `WHERE durum = 'bekliyor' OR (durum = 'calisiyor' AND kira_bitis < SYSTIMESTAMP)`. Uzun işler kirayı düzenli olarak uzatır.
   - Ya da işi **commit etmeden** işle: işçi satırı `FOR UPDATE SKIP LOCKED` ile kilitler, işi yapar, `durum = 'bitti'` yazıp commit eder. İşçi çökerse oturumu kopar, transaction geri alınır, kilit kalkar ve iş otomatik olarak tekrar "bekliyor" görünür. Bedeli, iş süresince açık bir transaction ve veritabanı bağlantısıdır. Kısa işler için uygundur, dakikalarca süren işler için değil.
   - Her iki durumda da işler **idempotent** olmalı: Çöken bir işçi işi yarıda bırakıp tekrar çalıştırılabilir. Örneğin bir e-posta iki kez gönderilmemeli, yani gönderim kimliği kontrol edilmeli.

</details>

```quiz
A oturumu bir satırı güncelledi ama commit etmedi. B oturumu aynı satırı SELECT ile okursa ne olur?
- B, A commit edene kadar bekler
- B, A'nın commit edilmemiş değerini görür
- [x] B beklemeden, A'nın değişikliğinden önceki commit edilmiş değeri görür (undo ile)
? Okuyucular yazarları beklemez; kirli okuma Oracle'da yoktur.
```

```quiz
Bir uygulama ORA-00060 (deadlock) aldığında ne yapmalıdır?
- Hatayı yok sayıp devam etmeli, Oracle transaction'ı zaten geri aldı
- [x] Transaction'ı açıkça geri almalı (Oracle sadece son ifadeyi geri aldı) ve gerekiyorsa yeniden denemeli
- Oturumu kapatıp yeni bağlantı açmalı
? Transaction'ın önceki ifadelerinin kilitleri hâlâ tutuluyordur.
```

```quiz
Birden çok işçinin aynı tablodan iş aldığı bir kuyrukta neden `WHERE ROWNUM <= 10 FOR UPDATE SKIP LOCKED` kullanılmamalı?
- ROWNUM ile FOR UPDATE birlikte kullanılamaz
- [x] ROWNUM kilitlemeden önce uygulanır: ilk 10 satır kilitliyse işçi hiç iş alamaz, oysa ileride boş işler vardır
- SKIP LOCKED sadece PL/SQL'de çalışır
? İmleçle `FOR UPDATE SKIP LOCKED` sorgula ve `FETCH ... LIMIT 10` ile al; 23ai/26ai'de `FETCH FIRST 10 ROWS ONLY FOR UPDATE SKIP LOCKED` da doğru çalışır.
```

```quiz
ORA-01555 "snapshot too old" hatası hangi işleme gelir?
- Undo üreten büyük UPDATE'e
- [x] Uzun süren sorguya: başladığı andaki görüntüyü oluşturmak için gereken undo üzerine yazılmıştır
- COMMIT'e
? undo_retention, undo tablespace boyutu ve sorgu süresi birlikte ele alınır.
```

## Özet

- Transaction ilk DML ile başlar, COMMIT/ROLLBACK ile biter. Hata veren ifade tek başına geri alınır, transaction devam eder: Uygulama açıkça geri almalı.
- Okuma tutarlılığı undo ile: kirli okuma yok, okuyucular ve yazarlar birbirini beklemez, yazarlar yazarları bekler.
- Kilit izleme: `V$SESSION.BLOCKING_SESSION`, `enq: TX - row lock contention`, `ROW_WAIT_*`, `V$TRANSACTION`. Engelleyen genellikle commit etmeyi unutmuş `INACTIVE` bir oturumdur.
- `NOWAIT`, `WAIT n`, `DDL_LOCK_TIMEOUT` ile beklemeyi sınırla.
- Kayıp güncelleme: atomik `UPDATE`, `SELECT FOR UPDATE` ya da sürüm sütunuyla iyimser kilitleme.
- Kuyruk: `FOR UPDATE SKIP LOCKED` ile imleç + `LIMIT` ya da (26ai) `FETCH FIRST`; `ROWNUM` tuzağı.
- Deadlock: aynı sırayla kilitle; `ORA-00060`'ta transaction'ı geri al.
- `READ COMMITTED` (ifade tutarlılığı) ve `SERIALIZABLE` (`ORA-08177`, yeniden deneme). `READ ONLY` transaction tutarlı raporlar için.
- Undo: `UNDO_RETENTION`, `V$UNDOSTAT`, `ORA-01555`. Flashback query ile yakın geçmişe bakma ve geri yükleme.
