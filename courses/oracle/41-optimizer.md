# Optimizer, istatistikler, bind değişkenleri ve plan kararlılığı

Bir önceki dersin sonucu: Kötü planların çoğu, optimizer'ın satır sayılarını **yanlış tahmin etmesinden** gelir. Optimizer tahminlerini **istatistiklerden** yapar: tablodaki satır sayısı, sütunlardaki farklı değer sayısı, değerlerin dağılımı. Bu ders istatistiklerin nasıl toplandığını ve neden yanılttığını, bind değişkenlerinin hem performans hem plan seçimi üzerindeki etkisini, ve bir sorgunun planının bir gün aniden değişmesini (plan regresyonu) nasıl önleyeceğini ele alıyor.

## İstatistikler

```sql
SELECT table_name, num_rows, TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI') AS analiz, stale_stats
FROM user_tab_statistics WHERE table_name IN ('OLAYLAR', 'DEPLOYLAR', 'SUNUCULAR') ORDER BY 1;

SELECT column_name, num_distinct, num_nulls, histogram, num_buckets
FROM user_tab_col_statistics WHERE table_name = 'OLAYLAR' ORDER BY column_name;
```

```text
TABLE_NAME     NUM_ROWS ANALIZ           STALE_S
------------ ---------- ---------------- -------
DEPLOYLAR          5000 2026-11-26 06:00 NO
OLAYLAR          200000 2026-11-26 06:00 NO
SUNUCULAR            60 2026-11-26 06:00 YES

COLUMN_NAME  NUM_DISTINCT  NUM_NULLS HISTOGRAM       NUM_BUCKETS
------------ ------------ ---------- --------------- -----------
ID                 200000          0 NONE                      1
MESAJ                 405          0 HYBRID                  254
SEVIYE                  3          0 FREQUENCY                 3
SUNUCU_ID              60          0 FREQUENCY                60
ZAMAN              195632          0 NONE                      1
```

`SUNUCULAR` için `STALE_STATS = YES`: Önceki derslerde bu tabloda yaptığımız güncellemeler, satırların %10'unu aştı. Oracle istatistikleri **eski** sayıyor. Bir tablonun istatistikleri, değişen satırlar `STALE_PERCENT` eşiğini (varsayılan %10) aştığında eski kabul edilir ve gece bakım penceresinde çalışan otomatik istatistik işi (`auto optimizer stats collection`) onları yeniden toplar.

İstatistikleri elle toplamak:

```sql
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'SUNUCULAR')
EXEC DBMS_STATS.GATHER_SCHEMA_STATS(USER)
```

### Eski istatistiklerin bedeli

Boş bir tablo oluşturup istatistik toplayalım, sonra 200.000 satır yükleyelim. Toplu yükleme işlerinin tipik akışı:

```sql
CREATE TABLE yeni_tablo AS SELECT * FROM olaylar WHERE 1 = 0;
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'YENI_TABLO')     -- 0 satır
INSERT INTO yeni_tablo SELECT * FROM olaylar;
COMMIT;

SELECT /*+ gather_plan_statistics */ COUNT(*)
FROM yeni_tablo y JOIN sunucular s ON s.id = y.sunucu_id WHERE y.seviye = 'WARN';
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST -PREDICATE'));
```

```text
---------------------------------------------------------------------------------
| Id  | Operation           | Name        | Starts | E-Rows | A-Rows | Buffers |
---------------------------------------------------------------------------------
|   0 | SELECT STATEMENT    |             |      1 |        |      1 |    1480 |
|   1 |  SORT AGGREGATE     |             |      1 |      1 |      1 |    1480 |
|   2 |   NESTED LOOPS      |             |      1 |      1 |  15226 |    1480 |
|   3 |    TABLE ACCESS FULL| YENI_TABLO  |      1 |      1 |  15226 |    1476 |
|   4 |    INDEX UNIQUE SCAN| SYS_C008941 |  15226 |      1 |  15226 |       4 |
---------------------------------------------------------------------------------
```

İstatistiklere göre tablo boş, `E-Rows = 1`. Optimizer bir satır için nested loops seçti, iç taraf 15.226 kez çalıştı. Bu küçük örnekte zararsız (iç taraf küçük bir indeks), ama gerçek bir ETL işinde aynı hata bir sonraki adımın milyonlarca satırlık bir tabloya nested loops ile gitmesine yol açar.

Kural: **Toplu yüklemeden sonra istatistik topla**, ya da yükleme bir iş akışının parçasıysa akışın içinde topla. Gece çalışan otomatik iş, öğlen yüklenen bir tabloyu ancak ertesi gece görür. 12c'den beri `CREATE TABLE ... AS SELECT` ve boş tabloya doğrudan yol (`INSERT /*+ APPEND */`) yüklemeleri istatistikleri **otomatik** toplar. Ama normal `INSERT` ile doldurulan bir tablo için bu yapılmaz.

### Çarpık veri ve histogramlar

Olay seviyelerinin dağılımı çok çarpık:

```sql
SELECT seviye, COUNT(*) FROM olaylar GROUP BY seviye ORDER BY 2;
```

```text
SEVIY   COUNT(*)
----- ----------
ERROR       2061      ← %1
WARN       15226      ← %7,6
INFO      182713      ← %91,4
```

Histogram olmadan optimizer, 3 farklı değerin **eşit** dağıldığını varsayar: Her değer için 200.000 / 3 = 66.667 satır. Bir indeksle deneyelim. `no_invalidate => FALSE`'un anlamını aşağıda açıklıyoruz:

```sql
CREATE INDEX olaylar_seviye_ix ON olaylar (seviye);
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'OLAYLAR', method_opt => 'FOR ALL COLUMNS SIZE 1', no_invalidate => FALSE)
SELECT /*+ gather_plan_statistics */ SUM(LENGTH(mesaj)) FROM olaylar WHERE seviye = 'ERROR';
```

```text
-- histogram yok (SIZE 1)
--------------------------------------------------------------------
| Id  | Operation          | Name    | Starts | E-Rows | A-Rows | Buffers |
--------------------------------------------------------------------
|   2 |   TABLE ACCESS FULL| OLAYLAR |      1 |  66667 |   2061 |    1451 |
--------------------------------------------------------------------
```

66.667 satır bekleyen optimizer tam taramayı seçti. Histogram toplayınca:

```sql
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'OLAYLAR', method_opt => 'FOR ALL COLUMNS SIZE 1 FOR COLUMNS SIZE 254 seviye', no_invalidate => FALSE)
SELECT /*+ gather_plan_statistics */ SUM(LENGTH(mesaj)) FROM olaylar WHERE seviye = 'ERROR';
SELECT /*+ gather_plan_statistics */ SUM(LENGTH(mesaj)) FROM olaylar WHERE seviye = 'INFO';
```

```text
-- ERROR
------------------------------------------------------------------------------------------
| Id  | Operation                            | Name              | E-Rows | A-Rows | Buffers |
------------------------------------------------------------------------------------------
|   2 |   TABLE ACCESS BY INDEX ROWID BATCHED| OLAYLAR           |   2061 |   2061 |    1412 |
|   3 |    INDEX RANGE SCAN                  | OLAYLAR_SEVIYE_IX |   2061 |   2061 |       6 |
------------------------------------------------------------------------------------------

-- INFO
--------------------------------------------------------------------
|   2 |   TABLE ACCESS FULL| OLAYLAR |      1 |    182K|    182K|    1451 |
--------------------------------------------------------------------
```

Tahminler artık **tam** doğru (2061 ve 182K), ve iki değer için iki farklı, uygun plan seçildi. (Bu küçük veride ERROR için indeks yolu ile tam tarama arasındaki blok farkı küçük, çünkü 2.061 satır tabloya dağılmış; ama tahmin doğru olduğu için kararlar artık gerçeğe dayanıyor.)

`FREQUENCY` histogram, her farklı değerin tam sayısını tutar (254 farklı değere kadar). Daha fazla değer için `HYBRID` ya da `TOP-FREQUENCY` histogramlar kullanılır. Varsayılan `method_opt => 'FOR ALL COLUMNS SIZE AUTO'`, Oracle'ın sorgularda **gerçekten filtrelenen** sütunlara (`SYS.COL_USAGE$`) ve çarpıklığa bakarak histogram kararı vermesini sağlar. Neredeyse her zaman doğru seçimdir.

### İstatistik topladın, plan değişmedi: no_invalidate

Aynı denemeyi `no_invalidate` vermeden yapınca histogram toplandı (`HISTOGRAM = FREQUENCY`), ama ERROR sorgusu hâlâ `E-Rows = 66667` ve tam tarama gösterdi. Sebep: `DBMS_STATS`'ın varsayılanı `no_invalidate => DBMS_STATS.AUTO_INVALIDATE`. Yeni istatistikler, mevcut imleçleri **hemen** geçersiz kılmaz. Oracle onları yaklaşık 5 saatlik bir süreye (`_optimizer_invalidation_period`) yayarak yavaş yavaş yeniden ayrıştırır. Bu, yoğun bir sistemde istatistik toplandığı anda binlerce sorgunun aynı anda yeniden ayrıştırılmasını (hard parse fırtınasını) önlemek için tasarlanmıştır.

Pratik sonucu: "İstatistik topladım ama sorgu hâlâ yavaş" şikâyetinde, sorunlu sorgunun eski imleci kullanmaya devam ediyor olabilir. Tek bir tablo için hemen etki istiyorsan `no_invalidate => FALSE`. Ya da tek bir imleci bellekten atmak için `DBMS_SHARED_POOL.PURGE` (yönetici yetkisi gerekir).

### İlişkili sütunlar: genişletilmiş istatistikler

Bir önceki dersteki tahmin hatası: Optimizer, `seviye = 'ERROR'` ve `mesaj = '...'` koşullarını bağımsız sayıyordu. **Sütun grubu** istatistiği, iki sütunun birlikte kaç farklı değer aldığını öğretir:

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar
WHERE seviye = 'ERROR' AND mesaj = 'disk dolu: /var/lib/app';
-- E-Rows: 5, A-Rows: 687

SELECT DBMS_STATS.CREATE_EXTENDED_STATS(USER, 'OLAYLAR', '(seviye, mesaj)') AS extension_name FROM dual;
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'OLAYLAR', method_opt => 'FOR ALL COLUMNS SIZE AUTO FOR COLUMNS SIZE 254 seviye FOR COLUMNS SIZE 254 (seviye, mesaj)')

SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar
WHERE seviye = 'ERROR' AND mesaj = 'disk dolu: /var/lib/app';
-- E-Rows: 763, A-Rows: 687
```

```text
EXTENSION_NAME
------------------------------
SYS_STUGR1AKLSHFW0YRKE7EJMGJSP
```

Tahmin 5'ten 763'e çıktı (gerçek 687). Oracle, sütun grubu için gizli bir sanal sütun oluşturdu ve onun üzerinde istatistik topladı. Bu yöntem eşitlik koşulları için çalışır, `LIKE` ya da aralık koşulları için değil. Hangi sütun gruplarının gerekli olduğunu Oracle'a buldurmak da mümkün: `DBMS_STATS.SEED_COL_USAGE` ile bir süre iş yükünü izle, sonra `DBMS_STATS.REPORT_COL_USAGE` ile önerileri gör.

## Bind değişkenleri ve ayrıştırma

Bir SQL ifadesi çalıştırılmadan önce **ayrıştırılır** (parse): sözdizimi kontrol edilir, nesneler ve yetkiler çözümlenir, optimizer bir plan üretir. Bu işin pahalı kısmı (**hard parse**) shared pool'da aynı metne sahip bir imleç yoksa yapılır. Varsa imleç tekrar kullanılır (**soft parse**).

Aynı sorguyu 5.000 kez, bir kez değer metne gömülü (literal), bir kez bind değişkeniyle çalıştıralım. Oturumun hard parse sayacını önce ve sonra okuyoruz:

```sql
COLUMN h0 NEW_VALUE h0 NOPRINT
COLUMN h1 NEW_VALUE h1 NOPRINT
SET VERIFY OFF TIMING ON

SELECT value AS h0 FROM v$mystat JOIN v$statname USING (statistic#) WHERE name = 'parse count (hard)';
DECLARE v NUMBER;
BEGIN
  FOR i IN 1 .. 5000 LOOP
    EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM deploylar WHERE id = ' || i INTO v;     -- literal
  END LOOP;
END;
/
SELECT value AS h1 FROM v$mystat JOIN v$statname USING (statistic#) WHERE name = 'parse count (hard)';
SELECT &h1 - &h0 AS hard_parse_literal FROM dual;

-- aynısı bind ile
DECLARE v NUMBER;
BEGIN
  FOR i IN 1 .. 5000 LOOP
    EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM deploylar WHERE id = :i' INTO v USING i;
  END LOOP;
END;
/
```

```text
Elapsed: 00:00:02.76              ← literal
HARD_PARSE_LITERAL
------------------
              5009

Elapsed: 00:00:00.04              ← bind
HARD_PARSE_BIND
---------------
              2
```

**69 kat** fark. Literal sürümde her sorgu farklı bir metindi ve her biri baştan ayrıştırıldı. Bind sürümünde metin tek, bir kez ayrıştırıldı ve 5.000 kez çalıştırıldı. Shared pool'daki iz:

```sql
SELECT COUNT(*) AS literal_imleci FROM v$sql
WHERE sql_text LIKE 'SELECT COUNT(*) FROM deploylar WHERE id = %' AND sql_text NOT LIKE '%:i%';
SELECT COUNT(*) AS bind_imleci, MAX(executions) AS calisma FROM v$sql
WHERE sql_text = 'SELECT COUNT(*) FROM deploylar WHERE id = :i';
SELECT ROUND(SUM(sharable_mem)/1024/1024, 1) AS literal_mb FROM v$sql
WHERE sql_text LIKE 'SELECT COUNT(*) FROM deploylar WHERE id = %' AND sql_text NOT LIKE '%:i%';
```

```text
LITERAL_IMLECI
--------------
           824          ← 5.000'in geri kalanı bellekten atılmış bile

BIND_IMLECI    CALISMA
----------- ----------
          1       5000

LITERAL_MB
----------
      29.7
```

Tek kullanımlık 824 imleç shared pool'da 30 MB tutuyor, ve geri kalan 4.000'den fazlası, daha değerli imleçleri bellekten iterek atıldı. Yoğun bir sistemde literal SQL'in sonuçları: yüksek CPU (ayrıştırma), shared pool çekişmesi (`latch: shared pool`, `library cache` beklemeleri), ve sonunda `ORA-04031: unable to allocate shared memory`. Bonus olarak, literal SQL enjeksiyon riskidir (PL/SQL temelleri dersi).

Uygulama tarafında bu, **her zaman parametreli sorgu kullanmak** demektir: JDBC'de `PreparedStatement`, `node-oracledb`'de `connection.execute(sql, [deger])`, ORM'lerin varsayılanı. Kodunu değiştiremediğin bir uygulama için Oracle'ın bir yama ayarı var: `CURSOR_SHARING = FORCE`, literal'leri otomatik olarak bind değişkenine çevirir. Ama histogram kullanan sorgularda yanlış planlara yol açabilir, ve kalıcı çözüm değildir.

### Bind değişkenleri ve çarpık veri

Bind değişkenlerinin bir zorluğu var: Plan ilk ayrıştırmada, o andaki değere **bakılarak** (bind peeking) üretilir. `seviye = :s` sorgusu ilk kez `'ERROR'` ile çalışırsa indeks planı üretilir ve imleç paylaşıldığı için `'INFO'` ile gelen sonraki çağrılar da aynı planı kullanır. Ya da tersi.

11g'den beri **adaptive cursor sharing** bunu çözmeye çalışır: Histogramlı bir sütunda bind kullanan imleci **bind-sensitive** olarak işaretler. Farklı değerlerin çok farklı satır sayıları ürettiğini görürse imleci **bind-aware** yapar ve değer aralıkları için ayrı alt imleçler (farklı planlar) oluşturur:

```sql
SELECT child_number, executions, is_bind_sensitive AS sens, is_bind_aware AS aware, plan_hash_value
FROM v$sql WHERE sql_text = 'SELECT SUM(LENGTH(mesaj)) AS t FROM olaylar WHERE seviye = :s';
```

```text
CHILD_NUMBER EXECUTIONS S A PLAN_HASH_VALUE
------------ ---------- - - ---------------
           0          6 Y N      2179660273
```

Altı çalıştırma (ERROR ve INFO karışık) sonrasında imleç bind-sensitive (`Y`) ama henüz bind-aware değil (`N`). Bu küçük veri setinde iki plan neredeyse aynı sayıda blok okuduğu için (1.412'ye karşı 1.451) Oracle ayrı bir imlece gerek görmedi. Büyük ve dağınık tablolarda fark çok daha belirgin olur ve ikinci bir alt imleç ortaya çıkar. Adaptive cursor sharing her zaman ilk çalıştırmalarda hata yapar ve "öğrenmesi" birkaç çalıştırma sürer. Kritik sorgularda plan kararlılığı için başka araçlar gerekir.

## Plan kararlılığı: SQL plan baseline

Gece istatistikler toplandı, bir parametre değişti, veritabanı yükseltildi ya da veri dağılımı değişti. Sabah, yıllardır 10 ms süren bir sorgu 10 saniye sürüyor. **Plan regresyonu**, üretim veritabanlarında en sık görülen ani performans sorunlarından biridir. **SQL Plan Management** (SPM), bir sorgu için kabul edilmiş planları saklar ve optimizer'ın sadece onları kullanmasını sağlar.

Gerekli yetki (`system` olarak): `GRANT ADMINISTER SQL MANAGEMENT OBJECT TO egitim;`

```sql
SET SERVEROUTPUT OFF
VARIABLE u NUMBER
EXEC :u := 3
SELECT /* rapor-17 */ id, surum FROM deploylar
WHERE uygulama_id = :u AND ortam = 'production'
ORDER BY baslangic DESC FETCH FIRST 5 ROWS ONLY;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'BASIC +NOTE'));
```

```text
Plan hash value: 3478307514
-----------------------------------------------------------------
| Id  | Operation                      | Name                       |
-----------------------------------------------------------------
|   0 | SELECT STATEMENT               |                            |
|   1 |  COUNT STOPKEY                 |                            |
|   2 |   VIEW                         |                            |
|   3 |    TABLE ACCESS BY INDEX ROWID | DEPLOYLAR                  |
|   4 |     INDEX RANGE SCAN DESCENDING| DEPLOYLAR_UYG_ORTAM_BAS_IX |
-----------------------------------------------------------------
```

İndeksler dersinde tasarladığımız iyi plan. Şimdi bir "çevre değişikliğini" taklit edelim: Optimizer'ın indeksleri çok pahalı görmesini sağlayan bir oturum parametresi (gerçek hayatta bu, değişen istatistikler, bir yükseltme ya da birinin "deneme" amaçlı değiştirdiği bir parametre olur):

```sql
ALTER SESSION SET optimizer_index_cost_adj = 10000;
SELECT /* rapor-17 */ id, surum FROM deploylar
WHERE uygulama_id = :u AND ortam = 'production'
ORDER BY baslangic DESC FETCH FIRST 5 ROWS ONLY;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'BASIC +NOTE'));
ALTER SESSION SET optimizer_index_cost_adj = 100;
```

```text
Plan hash value: 3439096641
-------------------------------------------
| Id  | Operation               | Name      |
-------------------------------------------
|   0 | SELECT STATEMENT        |           |
|   1 |  COUNT STOPKEY          |           |
|   2 |   VIEW                  |           |
|   3 |    SORT ORDER BY STOPKEY|           |
|   4 |     TABLE ACCESS FULL   | DEPLOYLAR |
-------------------------------------------
```

Plan değişti: tam tarama ve sıralama. Şimdi iyi planı (bellekteki imleçten) bir **baseline** olarak kaydedelim:

```sql
-- iyi planın sql_id ve plan_hash_value'sunu bul (V$SQL'den)
VARIABLE n NUMBER
EXEC :n := DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE(sql_id => 'SQL_ID_BURAYA', plan_hash_value => 3478307514)

SELECT sql_handle, plan_name, enabled, accepted, fixed, origin
FROM dba_sql_plan_baselines WHERE sql_text LIKE 'SELECT /* rapor-17 */%';
```

```text
SQL_HANDLE             PLAN_NAME                        ENA ACC FIX ORIGIN
---------------------- -------------------------------- --- --- --- -----------------------------
SQL_a89202bb35a36a7d   SQL_PLAN_aj4h2rcuu6umx65e9b62e   YES YES NO  MANUAL-LOAD-FROM-CURSOR-CACHE
```

Aynı çevre değişikliğini tekrar yapalım:

```sql
ALTER SESSION SET optimizer_index_cost_adj = 10000;
SELECT /* rapor-17 */ id, surum FROM deploylar
WHERE uygulama_id = :u AND ortam = 'production'
ORDER BY baslangic DESC FETCH FIRST 5 ROWS ONLY;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'BASIC +NOTE'));
ALTER SESSION SET optimizer_index_cost_adj = 100;
```

```text
Plan hash value: 3478307514
-----------------------------------------------------------------
|   3 |    TABLE ACCESS BY INDEX ROWID | DEPLOYLAR                  |
|   4 |     INDEX RANGE SCAN DESCENDING| DEPLOYLAR_UYG_ORTAM_BAS_IX |
-----------------------------------------------------------------

Note
-----
   - SQL plan baseline SQL_PLAN_aj4h2rcuu6umx65e9b62e used for this statement (1 of 1 reproduced)
```

Optimizer tam taramayı tercih etse de **baseline'daki plan kullanıldı**. Baseline'lara bakalım:

```text
SQL_HANDLE             PLAN_NAME                        ENA ACC ORIGIN
---------------------- -------------------------------- --- --- -----------------------------
SQL_a89202bb35a36a7d   SQL_PLAN_aj4h2rcuu6umx1e09207b   YES NO  AUTO-CAPTURE
SQL_a89202bb35a36a7d   SQL_PLAN_aj4h2rcuu6umx65e9b62e   YES YES MANUAL-LOAD-FROM-CURSOR-CACHE
```

Optimizer'ın yeni bulduğu plan (tam tarama) da kaydedildi, ama **kabul edilmedi** (`ACCEPTED = NO`). SPM'in mantığı budur: Yeni planlar kendiliğinden kullanılmaz. Onlar önce **evrimleştirilir** (`DBMS_SPM.EVOLVE_SQL_PLAN_BASELINE` ya da otomatik SPM evolve görevi): Gerçekten daha iyi oldukları ölçülerek doğrulanırsa kabul edilirler. Bu, "iyi plan korunur, daha iyi plan doğrulanarak benimsenir" dengesidir.

Baseline'ın bilmen gereken sınırları:

- Baseline bir planı ancak **yeniden üretilebiliyorsa** zorlayabilir. Planın kullandığı indeks silinirse ya da görünmez yapılırsa, Oracle baseline'ı uygulayamaz ve başka bir plan kullanır (`Note` bölümünde "could not be reproduced" görürsün).
- Sorgu metni karakteri karakterine aynı olmalı (boşluklar normalleştirilir). Literal kullanan sorgularda her değer ayrı bir sorgu olduğu için baseline işe yaramaz: Bind değişkenleri burada da şarttır.
- Veritabanı yükseltmelerinde en yaygın kullanım: Yükseltmeden önce kritik sorguların planlarını baseline'a yükle (SQL Tuning Set ile), yükseltmeden sonra eski planlar korunur, yeni optimizer'ın önerdiği planlar evolve ile doğrulanır.

Temizlik:

```sql
DECLARE n PLS_INTEGER;
BEGIN
  FOR b IN (SELECT DISTINCT sql_handle FROM dba_sql_plan_baselines
            WHERE sql_text LIKE 'SELECT /* rapor-17 */%') LOOP
    n := DBMS_SPM.DROP_SQL_PLAN_BASELINE(sql_handle => b.sql_handle);
  END LOOP;
END;
/
DROP INDEX olaylar_seviye_ix;
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'OLAYLAR', no_invalidate => FALSE)
```

### İpuçları (hints) ne zaman?

`/*+ INDEX(...) */`, `/*+ LEADING(...) USE_NL(...) */` gibi ipuçları, optimizer'a ne yapacağını söyler. Sorunlar:

- Veri değiştikçe bugünün doğru ipucu yarının yanlışı olur, ve ipucu optimizer'ın uyum sağlamasını engeller.
- Yazım hatalı ya da geçersiz bir ipucu **sessizce yok sayılır**. 19c'den beri `DBMS_XPLAN.DISPLAY_CURSOR(format => '+HINT_REPORT')` hangi ipuçlarının kullanılıp kullanılmadığını gösterir.
- Uygulama kodundaki ipuçları, veritabanı tarafındaki bir ayar değişikliğinden daha zor değiştirilir.

İpuçları teşhis için (bir planın neden seçilmediğini görmek) ve son çare olarak kullanılır. Kalıcı çözüm sırası: doğru istatistikler (histogram, sütun grubu), doğru indeks, sorgunun yeniden yazılması, ve kritik sorgular için baseline.

## Alıştırma

1. `deploylar` tablosuna 50.000 satır ekle (mevcut satırları birkaç kez kopyalayarak), istatistik toplamadan `STALE_STATS` değerine ve bir sorgunun `E-Rows` tahminine bak. Sonra istatistik topla ve tekrar bak. (Eklediğin satırları sonra sil ve istatistikleri tekrar topla.)
2. Bir uygulamanın `V$SQL`'de aynı sorgu yapısından binlerce farklı imleç ürettiğini nasıl tespit edersin? İpucu: `FORCE_MATCHING_SIGNATURE` sütunu.

<details><summary>Çözüm</summary>

```sql
INSERT INTO deploylar (uygulama_id, sunucu_id, surum, ortam, baslangic, sure_sn, durum)
SELECT uygulama_id, sunucu_id, surum || '-k', ortam, baslangic, sure_sn, durum
FROM deploylar, (SELECT 1 FROM dual CONNECT BY level <= 10);
COMMIT;
SELECT num_rows, stale_stats FROM user_tab_statistics WHERE table_name = 'DEPLOYLAR';
```

```text
  NUM_ROWS STALE_S
---------- -------
      5000 YES          ← istatistikler hâlâ 5.000 satır diyor

-- SELECT COUNT(*) FROM deploylar WHERE ortam = 'production'
|   2 |   TABLE ACCESS FULL| DEPLOYLAR |      1 |   1666 |  18326 |     450 |
```

Tahmin 1.666 (5.000 satırın üçte biri), gerçek 18.326. İstatistikleri toplayınca:

```sql
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'DEPLOYLAR', no_invalidate => FALSE)
```

```text
  NUM_ROWS STALE_S
---------- -------
     55000 NO

|   2 |   INDEX FAST FULL SCAN| DEPLOYLAR_UYG_ORTAM_BAS_IX |      1 |  18326 |  18326 |     397 |
```

Tahmin doğru, ve optimizer artık sorguyu tablodan daha küçük olan indeksten karşılıyor. Temizlik:

```sql
DELETE FROM deploylar WHERE surum LIKE '%-k';
COMMIT;
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'DEPLOYLAR', no_invalidate => FALSE)
```

2. Literal kullanan sorgular, literal değerleri dışında aynı metne sahiptir. `FORCE_MATCHING_SIGNATURE`, literal'ler bind'a çevrilmiş gibi hesaplanan bir imzadır. Aynı imzaya sahip çok sayıda imleç, literal kullanan bir uygulamayı gösterir:

```sql
SELECT force_matching_signature, COUNT(*) AS imlec, MIN(SUBSTR(sql_text, 1, 60)) AS ornek
FROM v$sql
WHERE force_matching_signature > 0
GROUP BY force_matching_signature
HAVING COUNT(*) > 50
ORDER BY imlec DESC FETCH FIRST 10 ROWS ONLY;
```

```text
FORCE_MATCHING_SIGNATURE      IMLEC ORNEK
------------------------ ---------- ------------------------------------------------
              1.8128E+19        361 SELECT COUNT(*) FROM deploylar WHERE id = 4640
```

Bu dersteki literal deneyinden kalan 361 imleç, tek bir imza altında toplandı.

Bu sorgu, literal SQL ile dolu bir shared pool'u ilk bakışta ortaya çıkarır. Çözüm uygulamada parametreli sorgulara geçmek; acil durumda o sorgular için `CURSOR_SHARING = FORCE` (oturum ya da trigger ile hedefli olarak).

</details>

```quiz
Bir tabloya 1 milyon satır yükledikten sonra istatistik toplanmazsa ne olabilir?
- Hiçbir şey, Oracle satır sayısını her sorguda sayar
- [x] Optimizer eski istatistiklere (örneğin 0 satır) göre küçük küme planları seçer; büyük veride nested loops felaketleri olur
- Sorgular hata verir
? Toplu yükleme akışının sonunda DBMS_STATS.GATHER_TABLE_STATS çağır.
```

```quiz
İstatistik topladın ama sorgunun planı değişmedi. En olası sebep?
- İstatistikler yanlış toplandı
- [x] DBMS_STATS varsayılan olarak mevcut imleçleri hemen geçersiz kılmaz (AUTO_INVALIDATE); eski imleç kullanılmaya devam ediyor
- Optimizer istatistikleri kullanmaz
? Hemen etki için `no_invalidate => FALSE`.
```

```quiz
Literal değerlerle (`WHERE id = 42`) binlerce farklı sorgu çalıştıran bir uygulamanın veritabanına etkisi?
- Sadece biraz daha yavaştır
- [x] Her sorgu hard parse edilir: yüksek CPU, shared pool çekişmesi, bellekten itilen imleçler, sonunda ORA-04031
- Etkisi yoktur, Oracle otomatik bind'a çevirir
? Bind değişkeniyle 5.000 sorgu 0,04 sn, literal ile 2,76 sn sürdü.
```

```quiz
SQL plan baseline'da `ACCEPTED = NO` olan bir plan ne anlama gelir?
- Plan hatalıdır
- [x] Optimizer bu planı buldu ama kullanılmadan önce evolve ile daha iyi olduğunun doğrulanması gerekir
- Plan silinecek
? SPM yeni planları kendiliğinden kullanmaz; kabul edilmiş planlar korunur.
```

## Özet

- İstatistikler: `USER_TAB_STATISTICS` (`STALE_STATS`), `USER_TAB_COL_STATISTICS` (histogram). Otomatik iş gece toplar; toplu yüklemeden sonra elle topla.
- Histogramlar çarpık veride doğru tahmin verir. `SIZE AUTO` genellikle doğru seçimdir.
- `DBMS_STATS` imleçleri hemen geçersiz kılmaz (`AUTO_INVALIDATE`); hemen etki için `no_invalidate => FALSE`.
- İlişkili sütunlar için sütun grubu istatistikleri (`CREATE_EXTENDED_STATS`).
- Literal SQL: hard parse, shared pool şişmesi, enjeksiyon. Bind değişkenleri: 69 kat hızlı. `FORCE_MATCHING_SIGNATURE` ile tespit, `CURSOR_SHARING = FORCE` geçici yama.
- Bind peeking ve adaptive cursor sharing: çarpık verideki bind'lar için, öğrenmesi zaman alır.
- SQL plan baseline: kabul edilmiş planı korur, yeni planlar evolve ile doğrulanır; plan yeniden üretilebilir olmalı. İpuçları son çare, `+HINT_REPORT` ile doğrula.
