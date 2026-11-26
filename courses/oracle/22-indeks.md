# İndeksler: B-tree, bileşik, fonksiyon tabanlı, bitmap

İndeksler bir veritabanında performansın en büyük kaldıracıdır: Doğru bir indeks bir sorguyu 1.000 kat hızlandırabilir. Yanlış ya da gereksiz indeksler ise her `INSERT`, `UPDATE` ve `DELETE`'i yavaşlatır, disk ve bellek tüketir. Bu derste bir indeksin ne zaman kullanıldığını ve ne zaman kullanılmadığını **ölçerek** göreceğiz: her sorgu için okunan blok sayısı (buffer), tahmin edilen ve gerçek satır sayısı.

## Ölçüm aracı: gerçek çalışma istatistikleri

Performans bölümünde execution plan'ları ayrıntılı işleyeceğiz. Şimdilik bir araç yeterli: Sorguya `gather_plan_statistics` ipucunu ekle, hemen ardından `DBMS_XPLAN.DISPLAY_CURSOR` ile son çalışan sorgunun planını ve gerçek değerlerini göster. Bunun için kullanıcının sözlük görünümlerini okuyabilmesi gerekir (`system` olarak bir kez):

```sql
GRANT SELECT_CATALOG_ROLE TO egitim;
```

SQL\*Plus'ta `SET SERVEROUTPUT OFF` yap (açıkken "son sorgu" DBMS_OUTPUT çağrısı olur), sonra:

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar
WHERE zaman >= TIMESTAMP '2026-11-16 00:00:00';
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST -PREDICATE'));
```

```text
----------------------------------------------------------------------------------------
| Id  | Operation          | Name    | Starts | E-Rows | A-Rows |   A-Time   | Buffers |
----------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT   |         |      1 |        |      1 |00:00:00.03 |    1451 |
|   1 |  SORT AGGREGATE    |         |      1 |      1 |      1 |00:00:00.03 |    1451 |
|   2 |   TABLE ACCESS FULL| OLAYLAR |      1 |   1281 |   1281 |00:00:00.03 |    1451 |
----------------------------------------------------------------------------------------
```

- `E-Rows`: optimizer'ın **tahmini** satır sayısı. `A-Rows`: **gerçek**. İkisi arasında büyük fark, kötü planların bir numaralı sebebidir.
- `Buffers`: okunan blok sayısı (bellekten ya da diskten). Bir sorgunun maliyetinin en güvenilir ölçüsüdür, çünkü zaman ölçümü önbelleğe ve yüke göre değişir, blok sayısı değişmez.
- `TABLE ACCESS FULL`: tablonun bütün blokları (1.451) okundu, 1.281 satır bulmak için.

## B-tree indeks

```sql
CREATE INDEX olaylar_zaman_ix ON olaylar (zaman);
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar
WHERE zaman >= TIMESTAMP '2026-11-16 00:00:00';
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST -PREDICATE'));
```

```text
---------------------------------------------------------------------------------------
| Id  | Operation         | Name             | Starts | E-Rows | A-Rows |   A-Time   | Buffers |
---------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT  |                  |      1 |        |      1 |00:00:00.01 |       5 |
|   1 |  SORT AGGREGATE   |                  |      1 |      1 |      1 |00:00:00.01 |       5 |
|   2 |   INDEX RANGE SCAN| OLAYLAR_ZAMAN_IX |      1 |   1281 |   1281 |00:00:00.01 |       5 |
---------------------------------------------------------------------------------------
```

1.451 bloktan **5** bloğa. B-tree bir sıralı ağaçtır: kök blok, dal blokları ve en altta **yaprak bloklar**. Yapraklar, anahtar değerlerini sıralı olarak ve her birinin satır adresini (**ROWID**) tutar. Aralık sorgusu, ağaçtan inerek aralığın başını bulur ve yaprakları sırayla okur. `COUNT(*)` sadece indeksle cevaplanabildiği için tabloya hiç gidilmedi.

Ağacın derinliği:

```sql
SELECT index_name, blevel, leaf_blocks, distinct_keys, clustering_factor
FROM user_indexes WHERE table_name = 'OLAYLAR' ORDER BY index_name;
SELECT blocks, num_rows FROM user_tables WHERE table_name = 'OLAYLAR';
```

```text
INDEX_NAME             BLEVEL LEAF_BLOCKS DISTINCT_KEYS CLUSTERING_FACTOR
------------------ ---------- ----------- ------------- -----------------
OLAYLAR_SUNUCU_IX           1         391            60             84367
OLAYLAR_ZAMAN_IX            1         531        200000              1407
SYS_C008963                 1         374        200000              1407

    BLOCKS   NUM_ROWS
---------- ----------
      1504     200000
```

`BLEVEL = 1`: kökten yaprağa bir seviye. B-tree'ler çok geniş olduğu için yavaş derinleşir: Milyarlarca satırlık bir tabloda bile `BLEVEL` genellikle 3 ya da 4'tür. Bir değeri bulmak her zaman birkaç blok okumaktır. `SYS_C008963` birincil anahtarın otomatik indeksi.

## Clustering factor: indeks neden bazen işe yaramaz

`CLUSTERING_FACTOR`, indeksi sırayla okurken **tablo bloğunun kaç kez değiştiğini** gösterir:

- Tablonun blok sayısına yakınsa (`zaman`: 1.407 / 1.504 blok): Tablodaki satırlar indeks sırasıyla aynı düzende. Ardışık indeks girişleri aynı tablo bloğunu gösterir. Olaylar zaman sırasıyla eklendiği için böyle.
- Satır sayısına yakınsa (`sunucu_id`: 84.367 / 200.000 satır): Satırlar dağınık. Aynı sunucunun olayları tablonun her yerine yayılmış, her indeks girişi muhtemelen farklı bir blok.

Sonucu: "sunucu 5'in son olayı":

```sql
SELECT /*+ gather_plan_statistics */ MAX(zaman) FROM olaylar WHERE sunucu_id = 5;
-- optimizer'ın seçimi: TABLE ACCESS FULL, Buffers: 1451

SELECT /*+ gather_plan_statistics INDEX(o olaylar_sunucu_ix) */ MAX(zaman) FROM olaylar o WHERE sunucu_id = 5;
```

```text
--------------------------------------------------------------------------------------------------------------------
| Id  | Operation                            | Name              | Starts | E-Rows | A-Rows |   A-Time   | Buffers |
--------------------------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT                     |                   |      1 |        |      1 |00:00:00.01 |    1414 |
|   1 |  SORT AGGREGATE                      |                   |      1 |      1 |      1 |00:00:00.01 |    1414 |
|   2 |   TABLE ACCESS BY INDEX ROWID BATCHED| OLAYLAR           |      1 |   3333 |   3333 |00:00:00.01 |    1414 |
|   3 |    INDEX RANGE SCAN                  | OLAYLAR_SUNUCU_IX |      1 |   3333 |   3333 |00:00:00.01 |       8 |
--------------------------------------------------------------------------------------------------------------------
```

Optimizer indeksi kullanmadı, `INDEX` ipucuyla zorladık. İndeks taraması sadece 8 blok sürdü, ama 3.333 satırı tablodan almak 1.406 blok daha okudu: neredeyse bütün tablo. Toplam 1.414 blok, tam taramanın 1.451 bloğundan pek farklı değil. Üstelik tek blok okumaları (indeks yolu) tam taramanın çoklu blok okumalarından genellikle daha pahalıdır. **Optimizer haklıydı.**

Ders: "İndeks var ama kullanılmıyor" her zaman bir sorun değildir. Dağınık satırlarda indeks yolu, satırların yüzde birkaçından fazlası için tam taramadan yavaştır. İpucuyla indeks zorlamadan önce ölç.

## Bileşik indeks ve sütun sırası

Aynı sorgu için doğru araç, **filtre sütununu ve gereken sütunu** birlikte içeren bir indeks:

```sql
CREATE INDEX olaylar_sunucu_zaman_ix ON olaylar (sunucu_id, zaman);
SELECT /*+ gather_plan_statistics */ MAX(zaman) FROM olaylar WHERE sunucu_id = 5;
```

```text
---------------------------------------------------------------------------------------------------------
| Id  | Operation                    | Name                    | Starts | E-Rows | A-Rows | Buffers |
---------------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT             |                         |      1 |        |      1 |       3 |
|   1 |  SORT AGGREGATE              |                         |      1 |      1 |      1 |       3 |
|   2 |   FIRST ROW                  |                         |      1 |      1 |      1 |       3 |
|   3 |    INDEX RANGE SCAN (MIN/MAX)| OLAYLAR_SUNUCU_ZAMAN_IX |      1 |      1 |      1 |       3 |
---------------------------------------------------------------------------------------------------------
```

**3 blok.** İndekste girişler önce `sunucu_id`'ye, sonra `zaman`'a göre sıralı: Sunucu 5'in girişleri bir arada ve zamana göre sıralı, en büyüğü son giriş. Oracle ağaçtan inip doğrudan oraya gitti (`MIN/MAX`, `FIRST ROW`). Tabloya hiç gitmedi, çünkü gereken her şey indekste vardı: Buna **kapsayan indeks** (covering index) denir.

Eşitlik ve aralık birlikte:

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar
WHERE sunucu_id = 5 AND zaman >= TIMESTAMP '2026-11-10 00:00:00';
```

```text
|*  2 |   INDEX RANGE SCAN| OLAYLAR_SUNUCU_ZAMAN_IX |      1 |    453 |    453 |       5 |

   2 - access("SUNUCU_ID"=5 AND "ZAMAN">=TIMESTAMP' 2026-11-10 00:00:00.000000000')
```

`access` satırı, **iki koşulun da** indeks ağacında gezinmek için kullanıldığını gösteriyor. Bileşik indeks tasarımının temel kuralı:

1. **Eşitlikle aranan sütunlar önce**, aralıkla aranan sütun sonra. `(sunucu_id, zaman)` hem `sunucu_id = 5` hem de `sunucu_id = 5 AND zaman > ...` sorgularını karşılar. `(zaman, sunucu_id)` ise ikinci sorguda zaman aralığındaki **bütün sunucuların** girişlerini okuyup `sunucu_id`'ye göre filtreler.
2. İndeks, **baştaki sütunları** kullanan sorgularda işe yarar. `(sunucu_id, zaman)` indeksi sadece `zaman` ile filtreleyen bir sorgu için doğrudan kullanılamaz (Oracle'ın "index skip scan" adlı bir çözümü var, ama baştaki sütunun az sayıda değeri varsa işe yarar).
3. Sıralama ve gruplama da bir indeks sırasıyla karşılanabilir: `WHERE sunucu_id = :s ORDER BY zaman DESC FETCH FIRST 20 ROWS ONLY` bu indeksle **sıralama yapmadan** ve sadece 20 giriş okuyarak çalışır. "Bir kullanıcının son 20 bildirimi", "bir sunucunun son logları" gibi sayfalı listeler için en önemli indeks deseni budur.

### Gereksiz indeksler

Artık `olaylar_sunucu_ix (sunucu_id)` gereksiz: `(sunucu_id, zaman)` indeksi, baştaki sütun olarak `sunucu_id`'yi zaten içeriyor. Silmeden önce güvenle denemek için **görünmez** yap:

```sql
ALTER INDEX olaylar_sunucu_ix INVISIBLE;
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar WHERE sunucu_id = 5;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'BASIC'));
```

```text
-----------------------------------------------------
| Id  | Operation         | Name                    |
-----------------------------------------------------
|   0 | SELECT STATEMENT  |                         |
|   1 |  SORT AGGREGATE   |                         |
|   2 |   INDEX RANGE SCAN| OLAYLAR_SUNUCU_ZAMAN_IX |
-----------------------------------------------------
```

Görünmez bir indeks optimizer tarafından **yok sayılır**, ama DML ile güncel tutulmaya devam eder. Bir sorun çıkarsa `ALTER INDEX ... VISIBLE` ile anında geri alınır; silinmiş bir indeksi büyük bir tabloda yeniden oluşturmak ise saatler sürebilir. Birkaç gün (ay sonu raporları dahil) sorun çıkmazsa silebilirsin.

Dikkat: Yabancı anahtarın indeksi olarak bu indekse güveniyorsan, onu karşılayan başka bir indeks (baştaki sütunu aynı) olduğundan emin ol. Burada bileşik indeks bu görevi de üstlenir.

Hangi indekslerin kullanıldığı `DBA_INDEX_USAGE` görünümünde izlenir (12.2+). İstatistikler yaklaşık 15 dakikada bir yazılır, bu yüzden yeni oluşturduğun bir indeks hemen görünmeyebilir:

```sql
SELECT name, total_access_count, total_exec_count, last_used
FROM dba_index_usage WHERE owner = 'EGITIM' ORDER BY name;
```

Haftalarca hiç kullanılmamış bir indeks, silme adayıdır.

## İndeksi devre dışı bırakan yazımlar

### Sütunu fonksiyona sarmak

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar WHERE TRUNC(zaman) = DATE '2026-11-15';
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST'));
```

```text
-------------------------------------------------------------------------------------------
| Id  | Operation             | Name             | Starts | E-Rows | A-Rows | Buffers |
-------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT      |                  |      1 |        |      1 |     538 |
|   1 |  SORT AGGREGATE       |                  |      1 |      1 |      1 |     538 |
|*  2 |   INDEX FAST FULL SCAN| OLAYLAR_ZAMAN_IX |      1 |   2000 |   4320 |     538 |
-------------------------------------------------------------------------------------------

   2 - filter(TRUNC(INTERNAL_FUNCTION("ZAMAN"))=TO_DATE(' 2026-11-15 00:00:00', ...))
```

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar
WHERE zaman >= DATE '2026-11-15' AND zaman < DATE '2026-11-16';
```

```text
|*  2 |   INDEX RANGE SCAN| OLAYLAR_ZAMAN_IX |      1 |   4321 |   4320 |      14 |

   2 - access("ZAMAN">=TIMESTAMP' 2026-11-15 00:00:00' AND "ZAMAN"<TIMESTAMP' 2026-11-16 00:00:00')
```

Aynı sonuç, **538 bloğa karşı 14 blok**. İlk sorguda indeks bir ağaç olarak değil, tablodan daha küçük bir kopya olarak baştan sona okundu (`INDEX FAST FULL SCAN`) ve her girişe `TRUNC` uygulandı. `filter` ile `access` farkına dikkat: `access` ağaçta gezinmek için kullanılır, `filter` okunan her satıra sonradan uygulanır.

İkinci bir sorun daha var: İlk sorguda `E-Rows = 2000`, `A-Rows = 4320`. Optimizer `TRUNC(zaman)`'ın seçiciliğini bilemediği için varsayılan bir tahmin (%1) kullandı. Daha karmaşık sorgularda bu yanlış tahmin, yanlış join yöntemi ve sırasına yol açar.

Fonksiyonu kaldıramıyorsan (örneğin `UPPER(eposta) = :x` gibi büyük/küçük harf duyarsız arama), **fonksiyon tabanlı indeks** oluşturursun: `CREATE INDEX kisiler_eposta_upper_ix ON kisiler (UPPER(eposta))`. Sorgudaki ifade indeksteki ifadeyle aynı olmalı.

### Örtük tip dönüşümü

Sipariş kodlarını `VARCHAR2` saklayan bir tablo:

```sql
CREATE TABLE siparis_kod (kod VARCHAR2(10) PRIMARY KEY, tutar NUMBER);
INSERT INTO siparis_kod SELECT TO_CHAR(level), level FROM dual CONNECT BY level <= 50000;
COMMIT;
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'SIPARIS_KOD')

SELECT /*+ gather_plan_statistics */ tutar FROM siparis_kod WHERE kod = 4242;    -- sayı
SELECT /*+ gather_plan_statistics */ tutar FROM siparis_kod WHERE kod = '4242';  -- metin
```

```text
-- kod = 4242
|*  1 |  TABLE ACCESS FULL| SIPARIS_KOD |      1 |      1 |      1 |     114 |
   1 - filter(TO_NUMBER("KOD")=4242)

-- kod = '4242'
|   1 |  TABLE ACCESS BY INDEX ROWID| SIPARIS_KOD |      1 |      1 |      1 |       3 |
|*  2 |   INDEX UNIQUE SCAN         | SYS_C009027 |      1 |      1 |      1 |       2 |
   2 - access("KOD"='4242')
```

Metin sütunu bir sayıyla karşılaştırınca Oracle **sütunu** sayıya çevirir (`TO_NUMBER("KOD")`): Bu da sütunu fonksiyona sarmakla aynıdır. Birincil anahtar indeksi kullanılmadı, tablo tarandı. 50.000 satırda fark 114'e 3 blok, 50 milyonda ise milisaniyeye karşı dakikalar. Ayrıca tabloda `'A-17'` gibi sayı olmayan bir kod varsa, sorgu `ORA-01722: invalid number` ile **patlar**.

Bu hata en çok uygulama katmanında yapılır: ORM bir parametreyi yanlış tiple bağlar (Java'da `setLong` ile `VARCHAR2` sütun, ya da `NVARCHAR2` ile `VARCHAR2` karşılaştırması). Plandaki `filter` satırında `TO_NUMBER`, `INTERNAL_FUNCTION` ya da `SYS_OP_C2C` görüyorsan, tip uyuşmazlığından şüphelen.

### LIKE ve joker karakter

```text
WHERE ad LIKE 'srv-05%'   → INDEX RANGE SCAN    (önek biliniyor, ağaçta aranabilir)
WHERE ad LIKE '%05%'      → INDEX FULL SCAN     (her giriş okunup kontrol edilir)
```

Baştaki `%`, sıralı bir yapıda aranacak bir başlangıç noktası bırakmaz. Metin içinde arama gerekiyorsa Oracle Text (`CONTAINS`) ya da JSON dersindeki search index kullanılır.

### NULL değerler ve B-tree

Tek sütunlu bir B-tree indeksi, sütunun **NULL olduğu satırları içermez**. "Tamamlanmamış görevler" (`bitti IS NULL`) gibi sorgular bu yüzden indeksi kullanamaz:

```sql
CREATE TABLE gorevler AS
SELECT level AS id, CASE WHEN MOD(level, 1000) = 0 THEN NULL ELSE SYSDATE END AS bitti
FROM dual CONNECT BY level <= 100000;
CREATE INDEX gorevler_bitti_ix ON gorevler (bitti);
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'GOREVLER')

SELECT /*+ gather_plan_statistics */ COUNT(*) FROM gorevler WHERE bitti IS NULL;
-- TABLE ACCESS FULL, Buffers: 251

CREATE INDEX gorevler_bitti_null_ix ON gorevler (bitti, 0);
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM gorevler WHERE bitti IS NULL;
-- INDEX RANGE SCAN GOREVLER_BITTI_NULL_IX, Buffers: 3

SELECT index_name, num_rows FROM user_indexes WHERE table_name = 'GOREVLER';
```

```text
INDEX_NAME               NUM_ROWS
---------------------- ----------
GOREVLER_BITTI_IX           99900      ← NULL olan 100 satır yok
GOREVLER_BITTI_NULL_IX     100000
```

Bileşik bir indekste bütün sütunlar NULL değilse satır indekse girer. Sabit `0` hiçbir zaman NULL olmadığı için her satır indekslenir. Tersi de kullanışlıdır: **Sadece belirli satırları** indekslemek için `CREATE INDEX ... ON gorevler (CASE WHEN bitti IS NULL THEN 1 END)`. Bu, milyonlarca tamamlanmış görevi değil, sadece bekleyen birkaç yüz görevi indeksler ve sorgu bu ifadeyi kullanmalıdır. İş kuyrukları ve "işlenmemiş kayıtlar" için çok küçük ve hızlı bir indeks olur.

## Bitmap indeksler

Bitmap indeks, sütunun her farklı değeri için bir bit dizisi tutar ("bu satır `ERROR` mı?"). Az farklı değeri olan sütunlar (`seviye`, `durum`, `bolge`) için çok küçüktür ve birden çok koşul (`seviye = 'ERROR' AND bolge = 'ist'`) bit işlemleriyle çok hızlı birleştirilir. Veri ambarlarında ve raporlama tablolarında yaygındır.

> **Dikkat:** Bitmap indeksler **eşzamanlı DML ile uyumsuzdur.** Bir bitmap girişi birçok satırı kapsadığı için, bir satırı güncellemek o girişin kapsadığı bütün satırları kilitler. Yoğun yazılan bir OLTP tablosuna (sipariş, olay, oturum) bitmap indeks koymak, birbirini bekleyen oturumlar ve deadlock'larla sonuçlanır. Bitmap indeksler toplu yüklenen ve sonra sadece okunan tablolar içindir.

## İndekslerin bedeli

Her indeks, her `INSERT`'te güncellenir, `UPDATE`'te indekslenen sütun değişirse güncellenir, `DELETE`'te girişi silinir. Olay tablosunun boş iki kopyasına aynı 200.000 satırı ekleyelim, birinde indeks yok, diğerinde beş indeks var:

```sql
CREATE TABLE ix_yok AS SELECT * FROM olaylar WHERE 1 = 0;
CREATE TABLE ix_var AS SELECT * FROM olaylar WHERE 1 = 0;
CREATE INDEX ix_var_1 ON ix_var (sunucu_id);
CREATE INDEX ix_var_2 ON ix_var (zaman);
CREATE INDEX ix_var_3 ON ix_var (sunucu_id, zaman);
CREATE INDEX ix_var_4 ON ix_var (seviye, zaman);
CREATE INDEX ix_var_5 ON ix_var (mesaj);
SET TIMING ON
INSERT INTO ix_yok SELECT * FROM olaylar;
INSERT INTO ix_var SELECT * FROM olaylar;
```

```text
Elapsed: 00:00:00.38     ← indekssiz
Elapsed: 00:00:09.54     ← beş indeksle
```

**25 kat** yavaş. Rastgele sıralı değerlere sahip indeksler (`sunucu_id`, `mesaj`) özellikle pahalıdır, çünkü her ekleme ağacın farklı bir yaprağına gider. Zaman sıralı indeksler ise hep en sağdaki yaprağa ekler. Ayrıca her indeks değişikliği redo ve undo üretir; yedekleme ve replikasyon da bu yükü taşır.

Pratik kurallar:

- İndeksi, var olan **sorgu desenleri** için oluştur, "belki lazım olur" diye değil.
- Önce mevcut indeksleri genişletmeyi düşün: Yeni bir `(a, b)` indeksi eklemek yerine mevcut `(a)` indeksini `(a, b)` yapmak.
- Büyük toplu yüklemelerde indeksleri önce `UNUSABLE` yapıp yüklemeden sonra yeniden oluşturmak (`ALTER INDEX ... REBUILD`), satır satır güncellemekten çok daha hızlıdır.
- Üretimde indeks oluştururken tabloyu kilitlememek için `CREATE INDEX ... ONLINE`.

## Alıştırma

1. "Bir sunucudaki son 24 saatin ERROR olayları, en yeniden eskiye" sorgusu için en iyi indeksi tasarla. Sorguyu yaz, planını ve okunan blok sayısını göster.
2. `deploylar` tablosunda `WHERE uygulama_id = :u AND ortam = 'production' ORDER BY baslangic DESC FETCH FIRST 10 ROWS ONLY` sorgusu sık çalışıyor. Mevcut `deploylar_uygulama_ix (uygulama_id)` indeksi ile ne kadar blok okunuyor? Daha iyi bir indeks önerip ölç.
3. Bir geliştirici `olaylar` tablosundaki **her sütuna** ayrı indeks koymayı öneriyor. İki somut itiraz yaz.

<details><summary>Çözüm</summary>

```sql
CREATE INDEX olaylar_sunucu_seviye_zaman_ix ON olaylar (sunucu_id, seviye, zaman);
SELECT /*+ gather_plan_statistics */ id, zaman, mesaj FROM olaylar
WHERE sunucu_id = 5 AND seviye = 'ERROR'
  AND zaman >= TIMESTAMP '2026-11-15 06:50:00'
ORDER BY zaman DESC;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST'));
```

```text
        ID ZAMAN                          MESAJ
---------- ------------------------------ ---------------------------------
    198268 15-NOV-26 09.29.20.000000 PM   veritabani baglantisi zaman asimi

----------------------------------------------------------------------------------------------------
| Id  | Operation                    | Name                           | E-Rows | A-Rows | Buffers |
----------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT             |                                |        |      1 |       5 |
|   1 |  TABLE ACCESS BY INDEX ROWID | OLAYLAR                        |      1 |      1 |       5 |
|*  2 |   INDEX RANGE SCAN DESCENDING| OLAYLAR_SUNUCU_SEVIYE_ZAMAN_IX |      1 |      1 |       4 |
----------------------------------------------------------------------------------------------------

   2 - access("SUNUCU_ID"=5 AND "SEVIYE"='ERROR' AND "ZAMAN">=TIMESTAMP' 2026-11-15 06:50:00.000000000')
```

İki eşitlik sütunu (`sunucu_id`, `seviye`) önce, aralık ve sıralama sütunu (`zaman`) sonra. Plan, indeksi geriye doğru okuyor (`DESCENDING`), sıralama adımı yok. `mesaj` indekste olmadığı için her satır için tabloya gidiliyor, ama sadece birkaç satır olduğu için önemsiz. Okuma çok sıksa `mesaj`'ı da indekse eklemek tabloya gitmeyi tamamen kaldırır; ama 200 karakterlik bir sütun indeksi şişirir, değmez.

```sql
SELECT /*+ gather_plan_statistics */ id, surum, durum FROM deploylar
WHERE uygulama_id = 3 AND ortam = 'production'
ORDER BY baslangic DESC FETCH FIRST 10 ROWS ONLY;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST -PREDICATE'));

CREATE INDEX deploylar_uyg_ortam_bas_ix ON deploylar (uygulama_id, ortam, baslangic);
-- aynı sorguyu tekrar çalıştır
```

```text
-- mevcut indekslerle
--------------------------------------------------------------------------
| Id  | Operation               | Name      | E-Rows | A-Rows | Buffers |
--------------------------------------------------------------------------
|   0 | SELECT STATEMENT        |           |        |     10 |      45 |
|   1 |  COUNT STOPKEY          |           |        |     10 |      45 |
|   2 |   VIEW                  |           |    208 |     10 |      45 |
|   3 |    SORT ORDER BY STOPKEY|           |    208 |     10 |      45 |
|   4 |     TABLE ACCESS FULL   | DEPLOYLAR |    208 |    208 |      45 |
--------------------------------------------------------------------------

-- yeni indeksle
------------------------------------------------------------------------------------------
| Id  | Operation                      | Name                       | E-Rows | A-Rows | Buffers |
------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT               |                            |        |     10 |       6 |
|   1 |  COUNT STOPKEY                 |                            |        |     10 |       6 |
|   2 |   VIEW                         |                            |     11 |     10 |       6 |
|   3 |    TABLE ACCESS BY INDEX ROWID | DEPLOYLAR                  |    208 |     10 |       6 |
|   4 |     INDEX RANGE SCAN DESCENDING| DEPLOYLAR_UYG_ORTAM_BAS_IX |     11 |     10 |       6 |
------------------------------------------------------------------------------------------
```

Mevcut `deploylar_uygulama_ix` kullanılmadı bile: Uygulamanın 625 deploy'u tabloya dağılmış (clustering factor), optimizer tam taramayı seçti, sonra 208 production satırını sıraladı (`SORT ORDER BY STOPKEY`). Yeni indeksle sıralama adımı yok, indeks geriye doğru okunup 10. satırda durdu: 45 bloktan 6 bloğa. Tablo büyüdükçe fark da büyür: İlk plan tablo boyutuyla, ikincisi sadece istenen satır sayısıyla orantılıdır. Artık `deploylar_uygulama_ix` de gereksiz (yeni indeksin önekidir), ama `uygulamalar`'a giden yabancı anahtarı karşıladığı için yerine yeni indeksin geçtiğinden emin olarak silinmeli.

3. (a) **Yazma maliyeti:** Yukarıdaki ölçümde beş indeks eklemeyi 25 kat yavaşlattı. Olay tablosu en çok yazılan tablodur, ve her yazma her indeksi güncellemek zorundadır. (b) **Yanlış yapı:** Tek sütunlu indeksler, gerçek sorguların çoğunu (birden çok koşul ve sıralama) karşılayamaz. `sunucu_id` ve `zaman` için iki ayrı indeks, `(sunucu_id, zaman)` bileşik indeksinin yaptığını yapamaz. `seviye` gibi az değerli bir sütundaki indeks ise neredeyse hiç kullanılmaz (`INFO` satırların %91'i). Üçüncü bir itiraz da depolama ve bellek: İndeksler buffer cache'te yer kaplar ve tablodan daha fazla yer tutabilir.

</details>

```quiz
`WHERE TRUNC(olusturma) = DATE '2026-11-15'` sorgusu `olusturma` üzerindeki indeksi neden verimli kullanamaz?
- TRUNC sadece DATE'te çalışır
- [x] Sütun bir fonksiyona sarıldığı için indeks ağacında aranamaz; her giriş okunup fonksiyon uygulanır
- İndeks NULL değerleri içermez
? Yarı açık aralık kullan ya da TRUNC(olusturma) üzerinde fonksiyon tabanlı indeks oluştur.
```

```quiz
`(sunucu_id, zaman)` bileşik indeksi hangi sorguyu doğrudan karşılayamaz?
- `WHERE sunucu_id = 5`
- `WHERE sunucu_id = 5 AND zaman > :t`
- [x] `WHERE zaman > :t` (baştaki sütun yok)
? İndeks önce sunucu_id'ye göre sıralıdır; sadece zaman ile arama yapılacaksa ayrı bir indeks gerekir.
```

```quiz
`VARCHAR2` bir `kod` sütununda `WHERE kod = 4242` yazmanın iki sorunu nedir?
- Sorun yok, Oracle otomatik çevirir
- [x] Oracle sütunu TO_NUMBER ile çevirir (indeks kullanılamaz) ve sayı olmayan bir kod varsa sorgu ORA-01722 ile patlar
- Sadece performans sorunu vardır
? Bind değişkenlerinin tipini sütunun tipiyle eşleştir.
```

```quiz
Yoğun yazılan bir sipariş tablosundaki `durum` sütununa bitmap indeks koymak neden kötü bir fikirdir?
- Bitmap indeksler az farklı değeri olan sütunlarda çalışmaz
- [x] Bir bitmap girişi birçok satırı kapsar; eşzamanlı güncellemeler birbirini kilitler ve deadlock'lar oluşur
- Bitmap indeksler sadece Enterprise Edition'da var
? Bitmap indeksler toplu yüklenen ve sonra okunan tablolar içindir.
```

## Özet

- Ölç: `gather_plan_statistics` + `DISPLAY_CURSOR('ALLSTATS LAST')`. `Buffers` maliyet ölçüsü, `E-Rows` ile `A-Rows` farkı kötü tahmin göstergesi.
- B-tree: sıralı, sığ (BLEVEL 1–4). `access` ağaçta gezinme, `filter` sonradan eleme.
- Clustering factor dağınıksa indeks, birkaç yüzdeden fazla satır için tam taramadan iyi değildir. Optimizer'a güven, ipucuyla zorlamadan önce ölç.
- Bileşik indeks: eşitlik sütunları önce, aralık/sıralama sütunu sonra. Kapsayan indeks tabloya gitmez. `WHERE x = :v ORDER BY t DESC FETCH FIRST n` için `(x, t)`.
- İndeksi bozanlar: sütunu fonksiyona sarmak, örtük tip dönüşümü, baştaki `%`, `IS NULL` (tek sütunlu indeks).
- Görünmez indeksle güvenli silme, `DBA_INDEX_USAGE` ile kullanım takibi, gereksiz (önek) indeksleri temizle.
- Bitmap OLTP'de kullanılmaz. Her indeksin yazma bedeli var: Sorgu desenlerine göre tasarla.
