# Execution plan okumak

Oracle'da bir sorgunun **ne** döndüreceğini sen yazarsın, **nasıl** döndüreceğine optimizer karar verir: hangi tabloyu önce okuyacağı, indeks mi tam tarama mı kullanacağı, tabloları hangi yöntemle birleştireceği. Bu kararların sonucu **execution plan**'dır. Yavaş bir sorguyu hızlandırmanın ilk adımı tahmin yürütmek değil, planı okumaktır. Bu ders bir planı satır satır okumayı, gerçek çalışma istatistikleriyle tahminleri karşılaştırmayı ve en sık görülen işlemleri tanımayı öğretiyor.

İndeksler dersinde kullandığımız aracı burada derinleştiriyoruz. Gerekli yetki (`system` olarak bir kez): `GRANT SELECT_CATALOG_ROLE TO egitim;`. SQL\*Plus'ta `SET SERVEROUTPUT OFF` ve `SET LINESIZE 200`.

## Planı nereden alırsın?

| Yöntem | Ne gösterir | Ne zaman |
|---|---|---|
| `EXPLAIN PLAN FOR ...` + `DBMS_XPLAN.DISPLAY` | Optimizer'ın **şimdi** üreteceğini tahmin ettiği plan. Sorgu çalışmaz. | Hızlı bir bakış; çalıştırılamayacak kadar uzun sorgular |
| `DBMS_XPLAN.DISPLAY_CURSOR` | Bellekteki (shared pool) **gerçekten kullanılan** plan | Her zaman tercih edilen |
| `gather_plan_statistics` ipucu ya da `STATISTICS_LEVEL = ALL` + `DISPLAY_CURSOR('ALLSTATS LAST')` | Gerçek plan + her adımın gerçek satır sayısı, süresi, okunan blok sayısı | Ayar yaparken |
| SQL Monitor (`DBMS_SQL_MONITOR.REPORT_SQL_MONITOR`) | 5 saniyeden uzun ya da paralel sorgular için canlı, adım adım ilerleme | Uzun çalışan sorgular (Tuning Pack lisansı gerekir) |

### EXPLAIN PLAN yalan söyleyebilir

İndeksler dersindeki `VARCHAR2` sipariş kodu tablosunu bir **sayı** bind değişkeniyle sorgulayalım:

```sql
CREATE TABLE siparis_kod (kod VARCHAR2(10) PRIMARY KEY, tutar NUMBER);
INSERT INTO siparis_kod SELECT TO_CHAR(level), level FROM dual CONNECT BY level <= 50000;
COMMIT;
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'SIPARIS_KOD')

VARIABLE k NUMBER
EXEC :k := 4242

EXPLAIN PLAN FOR SELECT tutar FROM siparis_kod WHERE kod = :k;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'BASIC +PREDICATE'));

SELECT /*+ gather_plan_statistics */ tutar FROM siparis_kod WHERE kod = :k;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'BASIC +PREDICATE'));
```

```text
-- EXPLAIN PLAN
---------------------------------------------------
| Id  | Operation                   | Name        |
---------------------------------------------------
|   0 | SELECT STATEMENT            |             |
|   1 |  TABLE ACCESS BY INDEX ROWID| SIPARIS_KOD |
|*  2 |   INDEX UNIQUE SCAN         | SYS_C009144 |
---------------------------------------------------
   2 - access("KOD"=:K)

-- gerçekte çalışan (DISPLAY_CURSOR)
-----------------------------------------
| Id  | Operation         | Name        |
-----------------------------------------
|   0 | SELECT STATEMENT  |             |
|*  1 |  TABLE ACCESS FULL| SIPARIS_KOD |
-----------------------------------------
   1 - filter(TO_NUMBER("KOD")=:K)
```

`EXPLAIN PLAN`, bind değişkenlerinin tipini ve değerini **bilmez**: Hepsini `VARCHAR2` varsayar. Bu yüzden indeks kullanılacak gibi görünen bir plan gösterdi. Gerçek çalışmada bind bir `NUMBER`'dı, sütun `TO_NUMBER`'a sarıldı ve tablo tarandı. Uygulamada yavaş çalışan ama "planı iyi görünen" sorgunun klasik açıklaması budur. Kural: **Gerçek planı `DISPLAY_CURSOR` ile, bellekten oku.**

Uygulamanın çalıştırdığı bir sorgunun planına bakmak için önce `SQL_ID`'sini bul:

```sql
SELECT sql_id, child_number, executions, ROUND(elapsed_time/1000) AS ms, buffer_gets,
       SUBSTR(sql_text, 1, 60) AS sql_text
FROM v$sql
WHERE sql_text LIKE '%olaylar o JOIN sunucular%' AND sql_text NOT LIKE '%v$sql%';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('33safbyuahbr6', 0, 'ALLSTATS LAST'));
```

`ALLSTATS LAST` sadece sorgu `gather_plan_statistics` ile (ya da `STATISTICS_LEVEL = ALL` oturumunda) çalıştıysa gerçek değerleri gösterir. Uygulamanın sorgusunda bu yoksa yine de planı ve `V$SQL`'deki toplam istatistikleri (çalışma sayısı, toplam süre, okunan blok) görürsün.

## Planı okuma kuralı

Plan bir ağaçtır. Girinti, ebeveyn-çocuk ilişkisini gösterir. Okuma kuralı:

1. Bir işlem, çocuklarından veri alır. **En içteki** (en sağa girintili) işlemler önce çalışır.
2. Aynı ebeveynin çocukları **yukarıdan aşağıya** sırayla çalışır: ilk çocuk önce.
3. Join işlemlerinde ilk çocuk **sürücü** (driving, outer) tablodur, ikinci çocuk **iç** (inner, probe) tablodur.

Üç tabloyu birleştiren bir rapor:

```sql
SELECT /*+ gather_plan_statistics */ e.ad AS ekip, COUNT(*) AS basarisiz
FROM deploylar d
JOIN uygulamalar u ON u.id = d.uygulama_id
JOIN ekipler e ON e.id = u.ekip_id
WHERE d.durum = 'basarisiz'
GROUP BY e.ad ORDER BY e.ad;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST'));
```

```text
--------------------------------------------------------------------------------------------------------
| Id  | Operation                      | Name             | Starts | E-Rows | A-Rows | Buffers | Used-Mem |
--------------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT               |                  |      1 |        |      4 |      53 |          |
|   1 |  SORT GROUP BY                 |                  |      1 |      4 |      4 |      53 | 2048  (0)|
|*  2 |   HASH JOIN                    |                  |      1 |    217 |    217 |      53 | 1187K (0)|
|   3 |    MERGE JOIN                  |                  |      1 |    217 |    217 |      47 |          |
|   4 |     TABLE ACCESS BY INDEX ROWID| UYGULAMALAR      |      1 |      8 |      8 |       2 |          |
|   5 |      INDEX FULL SCAN           | SYS_C008928      |      1 |      8 |      8 |       1 |          |
|*  6 |     SORT JOIN                  |                  |      8 |    217 |    217 |      45 |12288  (0)|
|*  7 |      TABLE ACCESS FULL         | DEPLOYLAR        |      1 |    217 |    217 |      45 |          |
|   8 |    VIEW                        | index$_join$_004 |      1 |      4 |      4 |       6 |          |
|*  9 |     HASH JOIN                  |                  |      1 |        |      4 |       6 | 1162K (0)|
|  10 |      INDEX FAST FULL SCAN      | SYS_C008924      |      1 |      4 |      4 |       3 |          |
|  11 |      INDEX FAST FULL SCAN      | SYS_C008925      |      1 |      4 |      4 |       3 |          |
--------------------------------------------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------
   2 - access("E"."ID"="U"."EKIP_ID")
   6 - access("U"."ID"="D"."UYGULAMA_ID")
       filter("U"."ID"="D"."UYGULAMA_ID")
   7 - filter("D"."DURUM"='basarisiz')
   9 - access(ROWID=ROWID)
```

Çalışma sırası:

1. **5 → 4:** Uygulamalar birincil anahtar indeksi sırasıyla okunur (8 satır). Bu, satırları `id` sırasıyla verir: sıralama gerekmez.
2. **7 → 6:** Deploylar tam taranır, `durum = 'basarisiz'` filtresi uygulanır (217 satır), sonra `uygulama_id`'ye göre sıralanır (`SORT JOIN`).
3. **3 MERGE JOIN:** İki sıralı küme fermuar gibi birleştirilir. Optimizer bunu seçti çünkü uygulamalar zaten sıralı geliyordu.
4. **10, 11 → 9 → 8:** Ekipler tablosunun kendisi hiç okunmadı. `ekipler`'in iki indeksi (`id` için PK ve `ad` için UNIQUE) ROWID üzerinden birleştirildi (**index join**): Gereken iki sütun (`id`, `ad`) indekslerde vardı.
5. **2 HASH JOIN:** 217 deploy satırı ekiplerle birleştirildi.
6. **1 SORT GROUP BY:** Ekibe göre gruplandı ve sıralandı (aynı anda `ORDER BY`'ı da karşıladı).

Bu kadar küçük bir sorgu için plan karmaşık görünebilir. Ama okuma kuralı her plan için aynı, ve 50 satırlık bir planda da işe yarar.

### Sütunlar

- `Starts`: işlemin kaç kez çalıştırıldığı. Nested loop'un iç tarafında ve skaler alt sorgularda 1'den büyüktür.
- `E-Rows`: optimizer'ın tahmini, **bir çalıştırma başına**. `A-Rows`: gerçek, **bütün çalıştırmaların toplamı**. Karşılaştırırken `E-Rows × Starts` ile `A-Rows`'u karşılaştır.
- `Buffers`: o adım ve altındakilerin okuduğu blok sayısı (kümülatif). Bir adımın kendi maliyeti, kendi değeri eksi çocuklarınınkidir.
- `A-Time`: gerçek süre, kümülatif.
- `OMem` / `1Mem` / `Used-Mem`: Sıralama ve hash işlemlerinin bellek ihtiyacı. Parantez içindeki sayı, işlemin diske taşma sayısıdır: `(0)` bellekte bitti demek. `(1)` ya da daha büyükse işlem TEMP tablespace'e yazdı ve yavaşladı.

### Predicate bilgisi: access ve filter

Planın altındaki `Predicate Information` bölümü genellikle tablonun kendisinden daha önemlidir:

- `access`: Koşul, veriye **erişmek** için kullanıldı: bir indeks aralığının başlangıcını bulmak ya da bir join anahtarını eşlemek.
- `filter`: Koşul, satırlar okunduktan **sonra** eleme için uygulandı.

Bir indeks taramasında önemli koşulun `filter` olarak görünmesi, indeksin o koşul için kullanılamadığını gösterir (sütun sırası yanlış, fonksiyon, tip dönüşümü). Bir `TABLE ACCESS FULL`'un `filter`'ında `TO_NUMBER(...)` ya da `INTERNAL_FUNCTION(...)` görmek, bir tip uyuşmazlığına işaret eder.

## Join yöntemleri

### Nested loops

Küçük bir sürücü küme için, her satır başına iç tabloda bir arama:

```sql
SELECT /*+ gather_plan_statistics */ s.ad, d.surum, d.durum
FROM sunucular s JOIN deploylar d ON d.sunucu_id = s.id
WHERE s.ad = 'srv-005' AND d.ortam = 'staging'
  AND d.baslangic >= TIMESTAMP '2026-11-01 00:00:00';
```

```text
------------------------------------------------------------------------------------
| Id  | Operation                    | Name        | Starts | E-Rows | A-Rows | Buffers |
------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT             |             |      1 |        |      2 |      48 |
|   1 |  NESTED LOOPS                |             |      1 |      2 |      2 |      48 |
|   2 |   TABLE ACCESS BY INDEX ROWID| SUNUCULAR   |      1 |      1 |      1 |       2 |
|*  3 |    INDEX UNIQUE SCAN         | SYS_C008942 |      1 |      1 |      1 |       1 |
|*  4 |   TABLE ACCESS FULL          | DEPLOYLAR   |      1 |      2 |      2 |      46 |
------------------------------------------------------------------------------------
```

Sürücü küme tek bir sunucu (`srv-005`, benzersiz indeksle bulundu), bu yüzden iç taraf bir kez çalıştı (`Starts = 1`). Optimizer, 45 bloklık küçük `deploylar` tablosunu indeks yerine tam taramayı seçti. Nested loops; az satırlı sürücü kümeler, iç tarafta iyi bir indeks ve "ilk satırları hızlı getir" (sayfalama, `FETCH FIRST`) durumları için en iyi yöntemdir.

### Hash join

Büyük kümeler için: Küçük taraftan bellekte bir hash tablosu oluşturulur (ilk çocuk, **build**), büyük taraf bir kez okunup her satır hash tablosunda aranır (ikinci çocuk, **probe**):

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*)
FROM olaylar o JOIN sunucular s ON s.id = o.sunucu_id
WHERE s.bolge = 'ist';
```

```text
---------------------------------------------------------------------------------------
| Id  | Operation              | Name              | Starts | E-Rows | A-Rows |   A-Time   | Buffers |
---------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT       |                   |      1 |        |      1 |00:00:00.02 |     404 |
|   1 |  SORT AGGREGATE        |                   |      1 |      1 |      1 |00:00:00.02 |     404 |
|   2 |   HASH JOIN            |                   |      1 |  65000 |  66667 |00:00:00.01 |     404 |
|   3 |    TABLE ACCESS FULL   | SUNUCULAR         |      1 |     20 |     20 |00:00:00.01 |       6 |
|   4 |    INDEX FAST FULL SCAN| OLAYLAR_SUNUCU_IX |      1 |    200K|    200K|00:00:00.64 |     398 |
---------------------------------------------------------------------------------------
Note
-----
   - this is an adaptive plan
```

İstanbul'daki 20 sunucudan bir hash tablosu kuruldu, 200.000 olay girişi bir kez okundu (tabloya bile gitmeden, indeksten), toplam 404 blok. `Note` bölümündeki **adaptive plan**: Optimizer, çalışma sırasında gerçek satır sayısını gördükten sonra nested loops ile hash join arasında seçim yapabileceği bir plan hazırladı.

Aynı sorguyu nested loops'a **zorlarsak** (yanlış sürücü sırasıyla):

```sql
SELECT /*+ gather_plan_statistics LEADING(o) USE_NL(s) */ COUNT(*)
FROM olaylar o JOIN sunucular s ON s.id = o.sunucu_id
WHERE s.bolge = 'ist';
```

```text
-------------------------------------------------------------------------------------------------
| Id  | Operation                     | Name              | Starts | E-Rows | A-Rows |   A-Time   | Buffers |
-------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT              |                   |      1 |        |      1 |00:00:00.15 |     200K|
|   1 |  SORT AGGREGATE               |                   |      1 |      1 |      1 |00:00:00.15 |     200K|
|   2 |   NESTED LOOPS                |                   |      1 |  65000 |  66667 |00:00:00.06 |     200K|
|   3 |    NESTED LOOPS               |                   |      1 |    200K|    200K|00:00:00.22 |     402 |
|   4 |     INDEX FAST FULL SCAN      | OLAYLAR_SUNUCU_IX |      1 |    200K|    200K|00:00:00.15 |     398 |
|   5 |     INDEX UNIQUE SCAN         | SYS_C008941       |    200K|      1 |    200K|00:00:00.04 |       4 |
|   6 |    TABLE ACCESS BY INDEX ROWID| SUNUCULAR         |    200K|      1 |  66667 |00:00:00.06 |     200K|
-------------------------------------------------------------------------------------------------
```

`Starts = 200K`: Sunucular tablosuna 200.000 kez gidildi, toplam **200.000 blok** okundu (404'e karşı, yaklaşık 500 kat). Süre bu küçük veride hâlâ 0,15 saniye çünkü bütün bloklar bellekte. Ama okunan blok sayısı CPU ve çekişme olarak her zaman bir bedeldir, ve veri bellekten taşınca saniyeler dakikalara dönüşür.

Bu, "yavaş sorgu" vakalarının en tipik görüntüsüdür: Büyük bir sürücü kümesi üzerinde nested loops, iç tarafta yüksek `Starts`. Sebebi neredeyse her zaman optimizer'ın sürücü kümenin boyutunu **yanlış tahmin etmesidir**: Az satır bekleyip nested loops seçer, ama gerçekte yüz binlerce satır gelir.

### Merge join

İki sıralı kümeyi birleştirir. Girdilerden biri zaten sıralıysa (indeks sırasıyla geliyorsa) ya da eşitsizlik join'lerinde (`a.tarih BETWEEN b.bas AND b.bit`) görülür. İlk örnekteki plan bunu gösteriyordu.

## Tahmin hataları

Planın kalitesi, satır sayısı **tahminlerinin** kalitesine bağlıdır. Optimizer, sütunlar arasındaki ilişkiyi varsayılan olarak bilmez:

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar
WHERE seviye = 'ERROR' AND mesaj LIKE 'disk dolu%';
```

```text
----------------------------------------------------------------------------
| Id  | Operation          | Name    | Starts | E-Rows | A-Rows | Buffers |
----------------------------------------------------------------------------
|   0 | SELECT STATEMENT   |         |      1 |        |      1 |    1451 |
|   1 |  SORT AGGREGATE    |         |      1 |      1 |      1 |    1451 |
|*  2 |   TABLE ACCESS FULL| OLAYLAR |      1 |      5 |    687 |    1451 |
----------------------------------------------------------------------------
```

Tahmin 5, gerçek 687: **137 kat** hata. Optimizer iki koşulu bağımsız saydı: "ERROR olma olasılığı" × "'disk dolu' ile başlama olasılığı". Ama gerçekte "disk dolu" mesajlarının hepsi zaten ERROR. Koşullar **ilişkili** (correlated). Bu sorgu tek tablo üzerinde olduğu için zararsız, ama bu tahmin bir join'in sürücü tarafında olsaydı, optimizer 5 satır için nested loops seçer ve 687 satırda (gerçek veride 687.000 satırda) yukarıdaki felaketi yaşardı.

Tahmin hatalarının yaygın sebepleri ve çözümleri bir sonraki derste: eksik ya da eski istatistikler, çarpık veri ve histogramlar, ilişkili sütunlar için **genişletilmiş istatistikler** (`DBMS_STATS.CREATE_EXTENDED_STATS`), fonksiyonlu koşullar.

Teşhis kuralı: Planda `E-Rows` ile `A-Rows` arasında 10 kattan fazla fark olan **ilk** (en içteki) adımı bul. Sorunun kaynağı genellikle oradadır, ondan sonraki kötü kararlar bu hatanın sonucudur.

## Diğer sık görülen işlemler

```sql
SELECT /*+ gather_plan_statistics */ uygulama_id, surum FROM (
  SELECT uygulama_id, surum,
         ROW_NUMBER() OVER (PARTITION BY uygulama_id ORDER BY baslangic DESC) rn
  FROM deploylar WHERE ortam = 'production')
WHERE rn = 1;
```

```text
-------------------------------------------------------------------------------------
| Id  | Operation                | Name      | Starts | E-Rows | A-Rows | Buffers | Used-Mem |
-------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT         |           |      1 |        |      8 |      45 |          |
|   1 |  VIEW                    |           |      1 |      8 |      8 |      45 |          |
|   2 |   WINDOW SORT PUSHED RANK|           |      1 |   1666 |      8 |      45 |43008  (0)|
|   3 |    TABLE ACCESS FULL     | DEPLOYLAR |      1 |   1666 |   1666 |      45 |          |
-------------------------------------------------------------------------------------
```

`WINDOW SORT PUSHED RANK`: Optimizer `rn = 1` koşulunu sıralamanın içine itti. Bütün 1.666 satırı sıralayıp sonra filtrelemek yerine, her grup için sadece en iyi satırı tuttu (`A-Rows = 8`).

Kısa sözlük:

| İşlem | Anlamı |
|---|---|
| `TABLE ACCESS FULL` | Tablonun bütün blokları (çoklu blok okuma) |
| `TABLE ACCESS BY INDEX ROWID [BATCHED]` | İndeksten gelen ROWID'lerle tablodan satır alma |
| `INDEX UNIQUE SCAN` | Benzersiz indekste tek değer |
| `INDEX RANGE SCAN [DESCENDING]` | İndekste aralık (ya da eşit olmayan değerler) |
| `INDEX FULL SCAN` | İndeksin tamamı, sıralı (tek blok okuma) |
| `INDEX FAST FULL SCAN` | İndeksin tamamı, sırasız, çoklu blok: tablodan küçük bir kopya gibi |
| `INDEX SKIP SCAN` | Bileşik indekste baştaki sütun olmadan arama (baştaki sütunun az değeri varsa) |
| `HASH GROUP BY` / `SORT GROUP BY` | Gruplama (sıralamalı ya da sırasız) |
| `SORT ORDER BY [STOPKEY]` | Sıralama (`FETCH FIRST` ile ilk N'de durma) |
| `COUNT STOPKEY` | `ROWNUM` / `FETCH FIRST` sınırı |
| `FILTER` | Bir alt sorgunun her satır için çalıştırılması (dikkat: Starts'a bak) |
| `VIEW` | Alt sorgu ya da görünüm sonucu |
| `PARTITION RANGE SINGLE/ITERATOR/ALL` | Bölüm budama (partitioning dersi) |
| `PX ...` | Paralel çalışma |

## Teşhis adımları

Yavaş bir sorgu geldiğinde:

1. **Gerçek planı al:** `V$SQL`'den `SQL_ID`, `DISPLAY_CURSOR`. Mümkünse sorguyu `gather_plan_statistics` ile bir kez çalıştır.
2. **Okunan blokların nereye gittiğini bul:** `Buffers` sütununda en büyük artışın olduğu adım.
3. **Tahmin hatası ara:** `E-Rows × Starts` ile `A-Rows` arasında büyük fark olan en içteki adım.
4. **Predicate'lere bak:** Beklenen koşul `access` yerine `filter`'da mı? Fonksiyon ya da tip dönüşümü var mı?
5. **Bellek ve TEMP:** `Used-Mem`'de taşma (`(1)`, `(2)`...) var mı?

Düzeltme her zaman ipucu (hint) yazmak değildir. Çoğu zaman doğru indeks, düzeltilmiş istatistik ya da yeniden yazılmış bir koşul yeterlidir. İpuçları son çare ve kalıcı çözüm değildir; bir sonraki derste plan kararlılığı araçlarını göreceğiz.

## Alıştırma

1. Şu sorgunun planını al ve okuma sırasını yaz: "Her bölgede, Kasım ayında ERROR olayı yaşamış sunucu sayısı."

```sql
SELECT /*+ gather_plan_statistics */ s.bolge, COUNT(DISTINCT s.id) AS sunucu
FROM sunucular s
WHERE EXISTS (SELECT 1 FROM olaylar o
              WHERE o.sunucu_id = s.id AND o.seviye = 'ERROR'
                AND o.zaman >= TIMESTAMP '2026-11-01 00:00:00')
GROUP BY s.bolge;
```

2. Planda `FILTER` işlemi ve iç tarafta `Starts = 60` görürsen bu ne anlama gelir? Bu durumda optimizer'ın daha iyi bir seçeneği var mı?

<details><summary>Çözüm</summary>

```text
------------------------------------------------------------------------------------------------
| Id  | Operation                     | Name        | Starts | E-Rows | A-Rows | Buffers | Used-Mem |
------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT              |             |      1 |        |      3 |    1453 |          |
|   1 |  HASH GROUP BY                |             |      1 |      3 |      3 |    1453 |          |
|   2 |   MERGE JOIN SEMI             |             |      1 |     60 |     60 |    1453 |          |
|   3 |    TABLE ACCESS BY INDEX ROWID| SUNUCULAR   |      1 |     60 |     60 |       2 |          |
|   4 |     INDEX FULL SCAN           | SYS_C008941 |      1 |     60 |     60 |       1 |          |
|*  5 |    SORT UNIQUE                |             |     60 |    681 |     60 |    1451 | 4096  (0)|
|*  6 |     TABLE ACCESS FULL         | OLAYLAR     |      1 |    681 |    681 |    1451 |          |
------------------------------------------------------------------------------------------------

   5 - access("O"."SUNUCU_ID"="S"."ID")
   6 - filter(("O"."SEVIYE"='ERROR' AND "O"."ZAMAN">=TIMESTAMP' 2026-11-01 00:00:00.000000000'))
```

Okuma sırası: (4 → 3) sunucular birincil anahtar sırasıyla okunur (60 satır, sıralı); (6) olaylar tam taranır, ERROR ve Kasım filtresi uygulanır (681 satır); (5) bu satırlar `sunucu_id`'ye göre sıralanıp tekilleştirilir (`SORT UNIQUE`); (2) iki sıralı küme **yarı join** (`MERGE JOIN SEMI`) ile birleştirilir: Her sunucu için bir eşleşme bulmak yeter, eşleşen olay sayısı önemli değil; (1) bölgeye göre gruplanır. `EXISTS` bir yarı join'e çevrildi, alt sorgu her sunucu için ayrı çalıştırılmadı: `SORT UNIQUE`'in `Starts = 60` değeri sıralanmış kümede 60 kez **arama** yapıldığını gösterir, tablonun 60 kez okunduğunu değil (tablo erişiminin `Starts`'ı 1). Bütün maliyet (1.451 blok) olayların tam taramasında. `olaylar (seviye, zaman)` üzerinde bir indeks, 681 satırı birkaç blokta bulurdu.

2. `FILTER` ve iç tarafta `Starts = 60`, alt sorgunun dış sorgunun **her satırı için** (60 sunucu) ayrı ayrı çalıştırıldığı anlamına gelir. 60 satır için sorun değil, 1 milyon satır için bir felakettir. Optimizer genellikle `EXISTS`'i bir **yarı join**'e (`HASH JOIN SEMI` / `NESTED LOOPS SEMI`) çevirir ve alt sorguyu bir kez çalıştırır. Bunu yapamıyorsa (örneğin alt sorguda `ROWNUM`, karmaşık `OR` koşulları ya da birleştirilmesini engelleyen bir yapı varsa) `FILTER` görürsün. O zaman sorguyu yeniden yazmak (join'e çevirmek ya da alt sorguyu önce gruplamak) gerekir.

</details>

```quiz
`EXPLAIN PLAN` ile alınan plan neden gerçekte çalışan plandan farklı olabilir?
- EXPLAIN PLAN istatistikleri kullanmaz
- [x] Bind değişkenlerinin tipini ve değerini bilmez, hepsini VARCHAR2 varsayar; gerçek çalışmada tip dönüşümü ve bind peeking farklı plan üretebilir
- EXPLAIN PLAN sadece SELECT için çalışır
? Gerçek planı DBMS_XPLAN.DISPLAY_CURSOR ile bellekten oku.
```

```quiz
Bir nested loops planında iç taraftaki işlemin `Starts` değeri 200.000 ise bu neyi gösterir?
- İşlem 200.000 satır döndürdü
- [x] İç tablo sürücü kümenin her satırı için bir kez, toplam 200.000 kez arandı
- İşlem 200.000 blok okudu
? Büyük bir sürücü kümede nested loops genellikle kötü bir tahminin sonucudur.
```

```quiz
Plan teşhisinde ilk bakılması gereken tahmin hatası hangisidir?
- En üstteki satırdaki
- [x] E-Rows ile A-Rows arasında büyük fark olan en içteki (ilk çalışan) adımdaki
- En çok buffer okuyan adımdaki
? Sonraki kötü kararlar genellikle bu ilk hatanın sonucudur.
```

## Özet

- Gerçek planı `DISPLAY_CURSOR` ile al; `EXPLAIN PLAN` bind tiplerini bilmez ve yanılabilir. `gather_plan_statistics` + `ALLSTATS LAST` ile gerçek değerler.
- Okuma: en içteki önce, kardeşler yukarıdan aşağıya, join'de ilk çocuk sürücü.
- `Starts`, `E-Rows` (çalıştırma başına), `A-Rows` (toplam), `Buffers` (kümülatif), `Used-Mem` (taşma sayısı).
- `access` ağaçta gezinme, `filter` sonradan eleme. Filter'da fonksiyon ya da tip dönüşümü bir uyarıdır.
- Nested loops: küçük sürücü küme + iyi indeks. Hash join: büyük kümeler. Merge join: sıralı girdiler.
- En yaygın felaket: kötü tahmin → büyük sürücü kümede nested loops → iç tarafta yüksek Starts. İlişkili koşullar tahmin hatası üretir.
