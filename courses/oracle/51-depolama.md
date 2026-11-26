# Tablespace'ler, datafile'lar, redo, undo ve temp

"Disk doldu" olayları, veritabanı kesintilerinin en sık ve en önlenebilir sebebidir. Bu derste Oracle'ın depolama katmanını operasyon gözüyle ele alıyoruz: Bir tablespace dolunca ne olur ve nasıl önlenir, hangi segment ne kadar yer kaplıyor, silinen satırlar neden yer açmıyor (high water mark), ve izleme dersinde gördüğümüz `log file switch` beklemelerini redo log'ları büyüterek nasıl düzelteceğimiz. Komutlar `system` olarak (PDB'de), redo log işlemleri ise CDB'de `SYS` olarak çalıştırılır (`docker exec -it ora-egitim sqlplus / as sysdba`).

## Mantıksal ve fiziksel yapı

```text
Tablespace (mantıksal kap: USERS)
 └── Datafile'lar (diskteki dosyalar: users01.dbf, users02.dbf ...)
      └── Segment'ler (her tablo, indeks, bölüm bir segment: OLAYLAR, OLAYLAR_ZAMAN_IX)
           └── Extent'ler (segmentin ardışık blok grupları)
                └── Bloklar (8 KB, okuma/yazmanın birimi)
```

Bir tablo bir tablespace'te yaşar, ama hangi datafile'da olduğunu bilmez: Oracle extent'leri tablespace'in datafile'larına dağıtır.

```sql
SELECT tablespace_name, file_name, ROUND(bytes/1024/1024) AS mb, autoextensible AS auto,
       ROUND(maxbytes/1024/1024/1024) AS max_gb, increment_by * 8 / 1024 AS artis_mb
FROM dba_data_files ORDER BY tablespace_name;

SELECT tablespace_name, bigfile, block_size FROM dba_tablespaces ORDER BY 1;
```

```text
TABLESPACE FILE_NAME                                          MB AUT  MAX_GB ARTIS_MB
---------- ---------------------------------------------- ------ --- ------- --------
SYSAUX     /opt/oracle/oradata/FREE/FREEPDB1/sysaux01.dbf    373 YES   32768       10
SYSTEM     /opt/oracle/oradata/FREE/FREEPDB1/system01.dbf    310 YES   32768       10
UNDOTBS1   /opt/oracle/oradata/FREE/FREEPDB1/undotbs01.dbf   241 YES   32768       10
USERS      /opt/oracle/oradata/FREE/FREEPDB1/users01.dbf     121 YES      32       10

TABLESPACE BIG BLOCK_SIZE
---------- --- ----------
SYSAUX     YES       8192
SYSTEM     YES       8192
TEMP       NO        8192
UNDOTBS1   YES       8192
USERS      NO        8192
```

- **AUTOEXTEND:** Dosya dolunca `ARTIS_MB` kadar otomatik büyür, `MAX_GB`'a kadar. Hiçbir zaman sınırsız (`UNLIMITED`) bırakma: Kaçak bir işlem diski tamamen doldurur ve sadece bu tablespace değil, aynı diskteki her şey (redo log'lar, arşiv, işletim sistemi) durur.
- **Smallfile ve bigfile:** Smallfile tablespace'lerde her datafile en fazla 4 milyon blok olabilir (8 KB blokla 32 GB, yukarıdaki `USERS`'ın `MAX_GB = 32`'si bu sınır), büyümek için dosya eklenir. Bigfile tablespace tek bir dev dosyadır (8 KB blokla 32 TB). 23ai'den beri `SYSTEM`, `SYSAUX` ve undo tablespace'leri varsayılan olarak bigfile oluşturuluyor. Bigfile yönetimi basitleştirir (bir dosya, bir büyüme ayarı), ama tek bir dosyanın geri yüklenmesi de o kadar büyük olur.
- Oracle Free sürümünde kullanıcı verisi toplam **12 GB** ile sınırlıdır. Bunu aşınca `ORA-12954: The request exceeds the maximum allowed database size of 12 GB` alırsın.

## Bir tablespace dolunca

10 MB'lık, otomatik büyümeyen bir tablespace'e 20 MB veri yazmayı deneyelim:

```sql
CREATE TABLESPACE kucuk_ts DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/kucuk01.dbf' SIZE 10M AUTOEXTEND OFF;
ALTER USER egitim QUOTA UNLIMITED ON kucuk_ts;
CREATE TABLE egitim.dolan (id NUMBER, veri VARCHAR2(1000)) TABLESPACE kucuk_ts;
INSERT INTO egitim.dolan SELECT level, RPAD('x', 1000, 'x') FROM dual CONNECT BY level <= 20000;
SELECT COUNT(*) FROM egitim.dolan;
```

```text
ORA-01653: unable to increase tablespace KUCUK_TS by 1MB during insert or update on table EGITIM.DOLAN

  COUNT(*)
----------
         0
```

İfade geri alındı, hiçbir satır eklenmedi. (5 MB verilirse `ORA-03214: The specified file size is smaller than the minimum blocks 784` alınır: Bu sürümde en küçük datafile yaklaşık 6 MB.) Üretimde bu hata, bir tablonun ya da indeksin bir sonraki extent'i alamadığı anda bütün eklemelerin durması demektir. Olay sırasında hızlı çözümler:

```sql
-- mevcut dosyaya otomatik büyüme ver
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/kucuk01.dbf' AUTOEXTEND ON NEXT 10M MAXSIZE 100M;
-- ya da dosyayı büyüt
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/kucuk01.dbf' RESIZE 50M;
-- ya da yeni dosya ekle
ALTER TABLESPACE kucuk_ts ADD DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/kucuk02.dbf' SIZE 50M AUTOEXTEND ON MAXSIZE 1G;
```

```sql
INSERT INTO egitim.dolan SELECT level, RPAD('x', 1000, 'x') FROM dual CONNECT BY level <= 20000;
COMMIT;
-- 20000 rows created.
```

Kalıcı çözüm ise izleme. Tablespace doluluğunu, **otomatik büyüme sınırına göre** hesaplayan görünüm:

```sql
SELECT tablespace_name, ROUND(used_space * 8 / 1024) AS kullanilan_mb, ROUND(used_percent, 2) AS yuzde
FROM dba_tablespace_usage_metrics ORDER BY used_percent DESC;
```

```text
TABLESPACE  KULLANILAN_MB      YUZDE
----------- ------------- ----------
USERS                  86        .26
SYSAUX                307        .03
SYSTEM                300        .03
UNDOTBS1              158          0
TEMP                    0          0
```

`USED_PERCENT`, dosyaların **azami** boyutuna göre hesaplanır. Sadece mevcut boyuta göre bakan bir izleme, otomatik büyüyen bir tablespace'i sürekli "%99 dolu" gösterir ve yanlış alarm üretir. İki eşik tanımla: tablespace doluluğu (örneğin %85 uyarı, %95 kritik) ve **altındaki diskin** doluluğu (Linux kursundaki `df`). Otomatik büyüme, disk dolarsa işe yaramaz. Oracle'ın kendi sunucu taraflı uyarıları (`DBA_OUTSTANDING_ALERTS`, varsayılan %85/%97 eşikleri) da bu metrikleri kullanır.

Kullanıcı seviyesinde bir sınır daha var: **quota.** Bir kullanıcı bir tablespace'te kota olmadan nesne oluşturabilir, ama satır ekleyemez (`ORA-01950: no privileges on tablespace`). Uygulama şemalarına sınırsız kota yerine makul bir kota vermek, kaçak bir şemanın bütün tablespace'i doldurmasını önler.

## Ne yer kaplıyor?

```sql
SELECT owner, segment_name, segment_type, ROUND(bytes/1024/1024, 1) AS mb, extents
FROM dba_segments WHERE owner = 'EGITIM' ORDER BY bytes DESC FETCH FIRST 8 ROWS ONLY;
```

```text
OWNER    SEGMENT_NAME             SEGMENT_TYPE          MB    EXTENTS
-------- ------------------------ ---------------- ------- ----------
EGITIM   OLAYLAR                  TABLE                 12         27
EGITIM   OLAYLAR_P                TABLE PARTITION        8          1
EGITIM   OLAYLAR_P                TABLE PARTITION        8          1
EGITIM   OLAYLAR_P                TABLE PARTITION        8          1
EGITIM   OLAYLAR_P                TABLE PARTITION        8          1
EGITIM   OLAYLAR_ZAMAN_IX         INDEX                  5         20
EGITIM   OLAYLAR_SUNUCU_ZAMAN_IX  INDEX                  5         20
EGITIM   DEPLOYLAR                TABLE                  4         19
```

Dikkat çekici bir ayrıntı: Bölümlenmiş tablonun her bölümü **8 MB** yer kaplıyor, ama içlerinde sadece 30.000 satır var (bölümsüz tablonun tamamı, 200.000 satırla, 12 MB). Bölümlenmiş tablolarda her bölüm büyük bir ilk extent ile başlar. Binlerce küçük bölüm, verinin kendisinden çok daha fazla boş alan ayırabilir. Bu, partitioning dersindeki "çok sayıda küçük bölüm" uyarısının depolama tarafıdır.

İndeksler toplamda tabloların kendisinden fazla yer kaplayabilir: Yukarıdaki iki indeks, tablonun boyutunun yaklaşık yarısı kadar. Gereksiz indeksleri temizlemenin (indeksler dersi) bir faydası da budur.

## High water mark: silinen satırlar yer açmaz

```sql
SELECT ROUND(bytes/1024/1024) AS mb FROM dba_segments WHERE segment_name = 'DOLAN';
DELETE FROM egitim.dolan WHERE id > 2000;     -- satırların %90'ını sil
COMMIT;
SELECT COUNT(*) FROM egitim.dolan;
SELECT ROUND(bytes/1024/1024) AS mb_delete_sonrasi FROM dba_segments WHERE segment_name = 'DOLAN';
```

```text
        MB
----------
        23

  COUNT(*)
----------
      2000

MB_DELETE_SONRASI
-----------------
               23
```

Satırların %90'ı gitti, segment hâlâ 23 MB. Silinen satırların bıraktığı boşluk **aynı tablonun** yeni satırları için yeniden kullanılır, ama segment küçülmez ve başka tablolara verilmez. Daha önemlisi, segmentin "kullanılmış" sınırı (**high water mark**, HWM) yerinde kalır: Tam tarama HWM'ye kadar **bütün blokları** okur, boş olsalar bile. Bir log tablosunun %99'unu silip "neden hâlâ yavaş?" diye sormanın cevabı budur.

Segmenti küçültmenin iki yolu:

```sql
ALTER TABLE egitim.dolan ENABLE ROW MOVEMENT;
ALTER TABLE egitim.dolan SHRINK SPACE;
SELECT ROUND(bytes/1024/1024, 1) AS mb_shrink_sonrasi FROM dba_segments WHERE segment_name = 'DOLAN';
-- 2.4

ALTER TABLE egitim.dolan MOVE ONLINE TABLESPACE users;
SELECT tablespace_name, ROUND(bytes/1024/1024, 1) AS mb FROM dba_segments WHERE segment_name = 'DOLAN';
-- USERS  3
```

- `SHRINK SPACE`: Satırları segmentin başına taşır, HWM'yi indirir, boşalan alanı tablespace'e geri verir. Satırların ROWID'leri değişir (`ENABLE ROW MOVEMENT` bu yüzden gerekir). Yerinde ve çevrimiçi çalışır. Sadece ASSM tablespace'lerde (varsayılan) desteklenir.
- `MOVE ONLINE` (12.2+): Tabloyu yeni bir segmente kopyalar (aynı ya da başka bir tablespace'e). DML devam edebilir, indeksler otomatik güncellenir. Kopyalama süresince iki kat alan gerekir. Tabloyu başka bir tablespace'e taşımak, sıkıştırmak (`COMPRESS`) ya da yeniden düzenlemek için.

Ama önce sor: Bu tablo gerçekten küçülmeli mi? Sürekli büyüyüp silinen bir tablo (bir kuyruk tablosu), boşalan alanı zaten yeniden kullanır. Onu küçültmek, bir saat sonra yeniden büyümesi için gereksiz iş demektir. Küçültme, bir defalık büyük temizliklerden sonra mantıklıdır. Düzenli olarak eski veri silinen tablolar için doğru çözüm partitioning ve `DROP PARTITION`'dır.

Temizlik:

```sql
DROP TABLE egitim.dolan PURGE;
DROP TABLESPACE kucuk_ts INCLUDING CONTENTS AND DATAFILES;
```

`PURGE` olmadan silinen tablolar **geri dönüşüm kutusuna** (recycle bin) gider ve yer kaplamaya devam eder. Bu, yanlışlıkla silmeye karşı bir korumadır (`FLASHBACK TABLE ... TO BEFORE DROP`, yedekleme dersinde), ama yer açmak için silindiyse `PURGE` kullan ya da `DBA_RECYCLEBIN`'i kontrol et.

## Redo log'ları boyutlandırmak

İzleme dersinde en çok beklenen ikinci olay `log file switch (checkpoint incomplete)` idi: 106 kez, ortalama 134 ms. Mimari dersinde gördüğümüz redo yapısı bu imajda iki adet 10 MB'lık gruptan oluşuyor. CDB'de, `SYS` olarak:

```sql
SELECT l.group#, ROUND(l.bytes/1024/1024) AS mb, l.members, l.status, f.member
FROM v$log l JOIN v$logfile f ON f.group# = l.group# ORDER BY 1;

SELECT TO_CHAR(first_time, 'YYYY-MM-DD HH24') AS saat, COUNT(*) AS gecis
FROM v$log_history WHERE first_time > SYSDATE - 1
GROUP BY TO_CHAR(first_time, 'YYYY-MM-DD HH24') ORDER BY 1;
```

```text
    GROUP#         MB    MEMBERS STATUS           MEMBER
---------- ---------- ---------- ---------------- -----------------------------------
         1         10          1 CURRENT          /opt/oracle/oradata/FREE/redo01.log
         2         10          1 INACTIVE         /opt/oracle/oradata/FREE/redo02.log

SAAT               GECIS
------------- ----------
2026-11-26 05          9
2026-11-26 06         12
2026-11-26 07         48
2026-11-26 08         60
```

Saat 08'de **60 log geçişi**: dakikada bir. Hedef, normal yükte saatte birkaç geçiştir (yaygın kural: geçişler 15–30 dakikada bir olsun). Çok sık geçiş, her seferinde bir checkpoint tetikler, ve sadece iki grup olduğunda LGWR bir sonraki gruba geçmek istediğinde onun checkpoint'i henüz bitmemiş olabilir: O an **bütün yazma işlemleri durur**.

Redo log'lar yerinde büyütülemez. Yeni, büyük gruplar eklenir ve eskiler düşürülür:

```sql
ALTER DATABASE ADD LOGFILE GROUP 3 ('/opt/oracle/oradata/FREE/redo03.log') SIZE 200M;
ALTER DATABASE ADD LOGFILE GROUP 4 ('/opt/oracle/oradata/FREE/redo04.log') SIZE 200M;
ALTER DATABASE ADD LOGFILE GROUP 5 ('/opt/oracle/oradata/FREE/redo05.log') SIZE 200M;

ALTER SYSTEM SWITCH LOGFILE;     -- eski gruplardan çık
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM CHECKPOINT;          -- eski grupları INACTIVE yap
SELECT group#, ROUND(bytes/1024/1024) AS mb, status FROM v$log ORDER BY 1;
```

```text
    GROUP#         MB STATUS
---------- ---------- ----------------
         1         10 INACTIVE
         2         10 INACTIVE
         3        200 INACTIVE
         4        200 CURRENT
         5        200 UNUSED
```

Sadece `INACTIVE` gruplar düşürülebilir (`CURRENT` olan yazılıyor, `ACTIVE` olanın içeriği henüz checkpoint edilmedi ve çökmede gerekebilir):

```sql
ALTER DATABASE DROP LOGFILE GROUP 1;
ALTER DATABASE DROP LOGFILE GROUP 2;
```

```text
    GROUP#         MB    MEMBERS STATUS           MEMBER
---------- ---------- ---------- ---------------- -----------------------------------
         3        200          1 INACTIVE         /opt/oracle/oradata/FREE/redo03.log
         4        200          1 CURRENT          /opt/oracle/oradata/FREE/redo04.log
         5        200          1 UNUSED           /opt/oracle/oradata/FREE/redo05.log
```

Oracle düşürülen grupların **dosyalarını silmez** (Oracle'ın kendi yönettiği OMF dosyaları hariç). İşletim sisteminden sil:

```bash
docker exec ora-egitim rm /opt/oracle/oradata/FREE/redo01.log /opt/oracle/oradata/FREE/redo02.log
```

Üretim kuralları:

- En az **üç** grup: İkiden fazla grup, checkpoint ve arşivlemenin yetişmesi için tampon sağlar.
- Her grupta, **farklı disklerde** en az iki üye (multiplexing): `ALTER DATABASE ADD LOGFILE MEMBER '/u02/redo03b.log' TO GROUP 3`. Tek üyeli bir grubun diski bozulursa, commit edilmiş ama henüz datafile'a yazılmamış veriler kaybolabilir. Buradaki tek üyeli yapı bir geliştirme ortamı içindir.
- Boyutu, yoğun saatteki redo üretimine göre ayarla. `V$LOG_HISTORY`'deki geçiş sıklığı ve izleme dersindeki `log file switch` beklemeleri doğru göstergelerdir.
- Redo diski **düşük gecikmeli** olmalı: `log file sync` (commit) süresi doğrudan bu diskin yazma gecikmesidir.

## Undo ve temp

Undo tablespace'i transaction'lar dersinde gördük: Boyutu, en uzun sorgunun ve `UNDO_RETENTION`'ın ihtiyacına göre seçilir. `V$UNDOSTAT` ölçüm verir.

TEMP, sıralama ve hash işlemleri PGA'ya sığmadığında kullanılır:

```sql
SELECT tablespace_name, ROUND(tablespace_size/1024/1024) AS mb,
       ROUND(allocated_space/1024/1024) AS ayrilan_mb, ROUND(free_space/1024/1024) AS bos_mb
FROM dba_temp_free_space;
```

```text
TABLESPACE         MB AYRILAN_MB     BOS_MB
---------- ---------- ---------- ----------
TEMP               10          6          9
```

TEMP **paylaşılır**: Tek bir kötü sorgu (milyarlarca satırı sıralayan bir kartezyen çarpım) bütün TEMP'i tüketebilir ve diğer oturumların sıralamaları `ORA-01652: unable to extend temp segment` alır. Bu küçük TEMP (10 MB) bu kurs için yeterli, ama üretimde TEMP, en büyük raporların ihtiyacına göre boyutlandırılır. Dolduğunda kimin kullandığı izleme dersindeki `V$TEMPSEG_USAGE` sorgusuyla bulunur. 18c'den beri **local temp tablespace** ve 12c'den beri `TEMP_UNDO_ENABLED` gibi ayarlar, geçici tablolarla çok çalışan uygulamalar için ek seçenekler sunar.

## Fast Recovery Area ve arşiv

```sql
SELECT name, value FROM v$parameter
WHERE name IN ('db_recovery_file_dest', 'db_recovery_file_dest_size', 'log_archive_dest_1');
SELECT log_mode, flashback_on FROM v$database;
```

```text
NAME                           VALUE
------------------------------ -----
log_archive_dest_1
db_recovery_file_dest
db_recovery_file_dest_size     0

LOG_MODE     FLASHBACK_ON
------------ ------------
NOARCHIVELOG NO
```

Bu geliştirme veritabanında arşiv kapalı ve **Fast Recovery Area** (FRA) tanımlı değil. Üretimde FRA, arşiv log'ların, RMAN yedeklerinin ve flashback log'larının tutulduğu, Oracle'ın kendisinin yönettiği bir alandır: Boyutu dolmak üzereyken eski ve artık gerekmeyen dosyaları otomatik siler. Ama gerekenler (yedeklenmemiş arşiv log'lar) silinemez, ve FRA tamamen dolarsa:

```text
ORA-00257: Archiver error. Connect AS SYSDBA only until resolved.
```

Bu, ARCHIVELOG modundaki bir veritabanında **bütün yazma işlemlerinin durması** demektir: Dolan redo log arşivlenemiyor, LGWR bir sonraki gruba geçemiyor. Üretimde en sık görülen tam kesinti sebeplerinden biridir. FRA doluluğu (`V$RECOVERY_AREA_USAGE`), izlenmesi gereken ilk metriklerden biridir. Bir sonraki derste ARCHIVELOG'u açıp FRA'yı yapılandıracak ve RMAN ile yedekleyip geri yükleyeceğiz.

## Alıştırma

1. `egitim` şemasının toplam kapladığı alanı segment türüne göre (TABLE, INDEX, TABLE PARTITION, LOBSEGMENT...) gruplayarak listele.
2. Bir izleme sistemine eklenecek, "otomatik büyüme sınırına göre %85'i geçen tablespace'leri" döndüren bir sorgu yaz. Altındaki disk dolarsa bu sorgu neyi kaçırır?

<details><summary>Çözüm</summary>

```sql
SELECT segment_type, COUNT(*) AS segment, ROUND(SUM(bytes)/1024/1024, 1) AS mb
FROM dba_segments WHERE owner = 'EGITIM'
GROUP BY segment_type ORDER BY mb DESC;
```

```text
SEGMENT_TYPE        SEGMENT         MB
---------------- ---------- ----------
TABLE PARTITION           4         32
INDEX                    26       27.1
TABLE                    13       16.8
INDEX PARTITION           8        9.9
LOBSEGMENT                1         .3
LOBINDEX                  1         .1
```

İndeksler (27,1 + 9,9 MB) tablolardan (16,8 MB) daha fazla yer kaplıyor, ve 4 bölüm 32 MB tutuyor. Bu kursun derslerinde eklenen indekslerin ve bölümlerin depolama faturası. `LOBSEGMENT`, `ci_olaylari`'ndaki JSON sütunundan geliyor.

```sql
SELECT tablespace_name, ROUND(used_percent, 1) AS yuzde
FROM dba_tablespace_usage_metrics
WHERE used_percent > 85;
```

`DBA_TABLESPACE_USAGE_METRICS`, dosyaların otomatik büyüyebileceğini **varsayar**. Ama `MAXSIZE` 32 GB olan bir dosyanın bulunduğu diskte sadece 2 GB boş yer varsa, dosya 2 GB sonra büyüyemez ve `ORA-01653` alınır, oysa metrik hâlâ "%10 dolu" gösterir. Bu yüzden veritabanı metriği ile işletim sistemi disk metriği (`df`, node exporter) **birlikte** izlenmeli. Alternatif olarak, otomatik büyümeye güvenmek yerine dosyaları önceden boyutlandırıp `AUTOEXTEND OFF` ile kullanan ekipler de var: O zaman `DBA_FREE_SPACE` ile gerçek boş alan izlenir.

</details>

```quiz
Bir tablodan satırların %90'ı silindiğinde segmentin boyutu ve tam tarama süresi ne olur?
- İkisi de %90 azalır
- [x] Segment küçülmez ve tam tarama high water mark'a kadar bütün blokları okumaya devam eder
- Segment küçülür ama tarama süresi aynı kalır
? SHRINK SPACE ya da MOVE ONLINE ile küçült; düzenli silmeler için partitioning.
```

```quiz
Redo log grupları çok küçükse hangi bekleme olayı görülür?
- db file sequential read
- [x] log file switch (checkpoint incomplete): LGWR bir sonraki gruba geçemez, yazmalar bekler
- enq: TX - row lock contention
? Hedef: normal yükte 15–30 dakikada bir geçiş, en az 3 grup, gruplarda çok üye.
```

```quiz
ARCHIVELOG modundaki bir veritabanında Fast Recovery Area tamamen dolarsa ne olur?
- Eski arşivler otomatik silinir ve devam edilir
- [x] Redo log'lar arşivlenemez, LGWR beklemeye geçer ve bütün yazmalar durur (ORA-00257)
- Sadece yedekleme başarısız olur
? FRA doluluğunu izle; yedeklenmemiş arşivler otomatik silinemez.
```

## Özet

- Tablespace → datafile → segment → extent → blok. AUTOEXTEND ver ama MAXSIZE ile sınırla. 23ai'de sistem tablespace'leri varsayılan bigfile. Free'de 12 GB veri sınırı.
- `ORA-01653`: tablespace dolu. Hızlı çözüm resize/autoextend/yeni dosya; kalıcı çözüm `DBA_TABLESPACE_USAGE_METRICS` + disk izleme.
- `DBA_SEGMENTS` ile ne yer kaplıyor; çok sayıda küçük bölüm boş alan ayırır.
- High water mark: DELETE segmenti küçültmez, tam tarama HWM'ye kadar okur. `SHRINK SPACE`, `MOVE ONLINE`. Recycle bin ve `PURGE`.
- Redo: geçiş sıklığı `V$LOG_HISTORY`, büyütmek için yeni grup ekle + eskileri düşür + dosyayı sil. En az 3 grup, çok üye, hızlı disk.
- TEMP paylaşılır; `ORA-01652`. FRA dolarsa ARCHIVELOG veritabanı durur (`ORA-00257`).
