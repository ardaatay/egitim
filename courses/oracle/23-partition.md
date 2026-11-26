# Partitioning ve büyük tabloları yönetmek

Olay, log, ölçüm, sipariş gibi tablolar sürekli büyür. 200.000 satırda her şey hızlıdır. 2 milyar satırda ise üç sorun ortaya çıkar: Sorgular son günün verisi için bütün tabloyu taramaya başlar, eski veriyi silmek saatler süren ve gigabaytlarca redo üreten bir işe dönüşür, ve bakım işlemleri (indeks yeniden oluşturma, istatistik toplama) bakım pencerelerine sığmaz. **Partitioning**, bir tabloyu uygulamanın gözünde tek tablo olarak bırakıp diskte bağımsız parçalara (bölümlere) ayırır. Her bölüm kendi segmentidir: ayrı taranabilir, ayrı silinebilir, ayrı sıkıştırılabilir, ayrı indekslenebilir.

> **Dikkat:** Partitioning, Oracle Enterprise Edition'da **ayrı lisanslanan** bir seçenektir; Standard Edition 2'de yoktur. Oracle Database Free ve Autonomous Database'de dahildir. Bir üretim sisteminde kullanmadan önce lisans durumunu kontrol et. Lisanssız kullanım denetimde ciddi maliyet çıkarır.

## Aralık (range) ve interval partitioning

Olay tablosunun bölümlenmiş bir kopyası. Her hafta için bir bölüm:

```sql
CREATE TABLE olaylar_p (
  id         NUMBER NOT NULL,
  sunucu_id  NUMBER NOT NULL,
  zaman      TIMESTAMP NOT NULL,
  seviye     VARCHAR2(5) NOT NULL,
  mesaj      VARCHAR2(200) NOT NULL
)
PARTITION BY RANGE (zaman) INTERVAL (NUMTODSINTERVAL(7, 'DAY'))
(PARTITION p_baslangic VALUES LESS THAN (TIMESTAMP '2026-10-01 00:00:00'));

INSERT INTO olaylar_p SELECT id, sunucu_id, zaman, seviye, mesaj FROM olaylar;
COMMIT;
EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'OLAYLAR_P')

SELECT partition_name, high_value, num_rows
FROM user_tab_partitions WHERE table_name = 'OLAYLAR_P' ORDER BY partition_position;
```

```text
PARTITION_NAME HIGH_VALUE                          NUM_ROWS
-------------- --------------------------------- ----------
P_BASLANGIC    TIMESTAMP' 2026-10-01 00:00:00'            0
SYS_P673       TIMESTAMP' 2026-10-08 00:00:00'        30239
SYS_P674       TIMESTAMP' 2026-10-15 00:00:00'        30240
SYS_P675       TIMESTAMP' 2026-10-22 00:00:00'        30240
SYS_P676       TIMESTAMP' 2026-10-29 00:00:00'        30240
SYS_P677       TIMESTAMP' 2026-11-05 00:00:00'        30240
SYS_P678       TIMESTAMP' 2026-11-12 00:00:00'        30240
SYS_P679       TIMESTAMP' 2026-11-19 00:00:00'        18561
```

Sadece bir başlangıç bölümü tanımladık. `INTERVAL` maddesi sayesinde Oracle, veri geldikçe yeni haftalar için bölümleri **kendisi** oluşturdu (`SYS_P...` adlarıyla; adlar senin ortamında farklı olacaktır). Klasik range partitioning'de gelecek bölümleri önceden oluşturman gerekirdi, ve unutulursa ay başında "`ORA-14400: inserted partition key does not map to any partition`" ile eklemeler dururdu. Interval bu riski ortadan kaldırır.

Bölümlere adla değil **değerle** başvurmak, otomatik oluşturulan adlardan bağımsız çalışmanı sağlar: `PARTITION FOR (TIMESTAMP '2026-10-02 00:00:00')` "bu değeri içeren bölüm" demektir.

## Bölüm budama (partition pruning)

Bölümlemenin sorgu tarafındaki faydası: Optimizer, sorgunun koşullarına bakıp **hangi bölümlerin** okunması gerektiğine karar verir:

```sql
SET SERVEROUTPUT OFF
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar_p
WHERE zaman >= TIMESTAMP '2026-11-10 00:00:00' AND zaman < TIMESTAMP '2026-11-12 00:00:00';
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST +PARTITION -PREDICATE'));
```

```text
---------------------------------------------------------------------------------------------------
| Id  | Operation               | Name      | Starts | E-Rows | Pstart| Pstop | A-Rows | Buffers |
---------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT        |           |      1 |        |       |       |      1 |     276 |
|   1 |  SORT AGGREGATE         |           |      1 |      1 |       |       |      1 |     276 |
|   2 |   PARTITION RANGE SINGLE|           |      1 |   8640 |     7 |     7 |   8640 |     276 |
|   3 |    TABLE ACCESS FULL    | OLAYLAR_P |      1 |   8640 |     7 |     7 |   8640 |     276 |
---------------------------------------------------------------------------------------------------
```

`PARTITION RANGE SINGLE`, `Pstart = Pstop = 7`: Sadece 7. bölüm (5–12 Kasım haftası) tam tarandı, 276 blok. İndeks yok, ama tablonun sadece ilgili kısmı okundu. Milyarlarca satırlık bir log tablosunda "son bir saatin hataları" sorgusu, bu sayede sadece son bölümü okur.

Budamayı bozan şeyler, indekslerdeki kurallarla aynı:

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar_p WHERE TRUNC(zaman) = DATE '2026-11-10';
-- PARTITION RANGE ALL, Pstart 1, Pstop 1048575, Starts 8, Buffers 1820

SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar_p WHERE sunucu_id = 5;
-- PARTITION RANGE ALL, Buffers 1820
```

Bölüm anahtarı bir fonksiyona sarıldığında (`TRUNC(zaman)`) ya da sorguda hiç geçmediğinde (`sunucu_id = 5`), **bütün bölümler** okunur (`Starts = 8`: sekiz bölümün her biri). `Pstop = 1048575` interval tablolarda "olası en son bölüm"dür. Dikkat: Tam tarama bölümsüz tablodan (1.451 blok) daha pahalı oldu (1.820 blok). Her bölüm kendi segmenti olduğu için, bölümlere bölünmüş tablonun toplamı biraz daha fazla yer kaplar ve bütün bölümleri okumak tek bir segmenti okumaktan pahalıdır.

Ders: **Bölüm anahtarı, sorguların neredeyse hepsinde filtre olarak geçen sütun olmalı.** Log ve olay tabloları için bu neredeyse her zaman zamandır. Bölüm anahtarını içermeyen sorgular için yine indeks gerekir.

## Yerel ve global indeksler

Bölümlenmiş bir tabloda indeks iki türlü olabilir:

- **Yerel (LOCAL) indeks:** Tablonun her bölümü için ayrı bir indeks bölümü. Bir tablo bölümü silinince indeksin o bölümü de gider, diğerleri etkilenmez.
- **Global indeks:** Bütün tabloyu kapsayan tek bir indeks (ya da tablodan farklı şekilde bölümlenmiş). Bir tablo bölümünü silmek, bu indeksteki o bölüme ait girişleri geçersiz kılar.

```sql
CREATE INDEX olaylar_p_sunucu_zaman_ix ON olaylar_p (sunucu_id, zaman) LOCAL;
ALTER TABLE olaylar_p ADD CONSTRAINT olaylar_p_pk PRIMARY KEY (id);
```

Birincil anahtar `(id)` global bir indeks oldu: Benzersizlik kontrolü bütün tabloda yapılmalı, ve `id` bölüm anahtarını (`zaman`) içermediği için Oracle bunu bölüm başına kontrol edemez.

### Bölüm silmek ve global indeksler

Bölümlemenin en büyük operasyonel faydası, eski veriyi silmek. İlk haftayı düşürelim:

```sql
SET TIMING ON
ALTER TABLE olaylar_p DROP PARTITION FOR (TIMESTAMP '2026-10-02 00:00:00') UPDATE GLOBAL INDEXES;
SET TIMING OFF
SELECT index_name, status, orphaned_entries FROM user_indexes WHERE table_name = 'OLAYLAR_P' ORDER BY 1;
```

```text
Table altered.
Elapsed: 00:00:00.04

INDEX_NAME                 STATUS   ORP
-------------------------- -------- ---
OLAYLAR_P_PK               VALID    YES
OLAYLAR_P_SUNUCU_ZAMAN_IX  N/A      NO
```

30.000 satırlık bir hafta 0,04 saniyede gitti. `UPDATE GLOBAL INDEXES` ile global indeks geçerli kaldı. 12c'den beri bu, global indeksteki silinen girişleri hemen temizlemez: Onları "sahipsiz" (`ORPHANED_ENTRIES = YES`) olarak işaretler ve sonra bir bakım işi (`PMO_DEFERRED_GIDX_MAINT_JOB`) arka planda temizler. Bu yüzden komut hızlı döner.

`UPDATE GLOBAL INDEXES` unutulursa:

```sql
ALTER TABLE olaylar_p DROP PARTITION FOR (TIMESTAMP '2026-10-09 00:00:00');
SELECT index_name, status FROM user_indexes WHERE table_name = 'OLAYLAR_P' ORDER BY 1;
INSERT INTO olaylar_p VALUES (999999, 1, SYSTIMESTAMP, 'INFO', 'deneme');
```

```text
INDEX_NAME                 STATUS
-------------------------- --------
OLAYLAR_P_PK               UNUSABLE
OLAYLAR_P_SUNUCU_ZAMAN_IX  N/A

ORA-01502: index 'EGITIM.OLAYLAR_P_PK' or partition of such index is in unusable state
```

Birincil anahtar indeksi **kullanılamaz** hale geldi ve tabloya ekleme yapılamıyor: Benzersizlik kontrol edilemediği için Oracle eklemeyi reddediyor. Yeni olayların yazıldığı bir tabloda bu bir kesintidir, ve indeksi yeniden oluşturmak (`ALTER INDEX ... REBUILD ONLINE`) büyük bir tabloda saatler sürer. Gece çalışan bir "eski bölümleri sil" işinin `UPDATE GLOBAL INDEXES` olmadan yazılması, sabah gelen bir kesinti çağrısı demektir.

### Daha iyisi: yerel benzersiz indeks

Global indekslerden tamamen kaçınmanın yolu, benzersiz anahtara **bölüm anahtarını eklemek**. Böylece benzersizlik her bölüm içinde kontrol edilebilir ve indeks yerel olabilir:

```sql
ALTER TABLE olaylar_p DROP CONSTRAINT olaylar_p_pk;
ALTER TABLE olaylar_p ADD CONSTRAINT olaylar_p_pk PRIMARY KEY (id, zaman) USING INDEX LOCAL;
SELECT index_name, partitioned, status FROM user_indexes WHERE table_name = 'OLAYLAR_P' ORDER BY 1;
```

```text
INDEX_NAME                 PAR STATUS
-------------------------- --- --------
OLAYLAR_P_PK               YES N/A
OLAYLAR_P_SUNUCU_ZAMAN_IX  YES N/A
```

Bedeli: `id` artık tek başına benzersiz olarak garanti edilmez (teorik olarak aynı `id` iki farklı zamanda olabilir). `id` bir sequence'ten geliyorsa pratikte sorun yoktur. Ama başka tabloların bu tabloya yabancı anahtarla `id` üzerinden başvurması gerekiyorsa, onların da `(id, zaman)` taşıması gerekir. Log ve olay tablolarına genellikle başka tablolardan FK ile başvurulmaz, bu yüzden bu tasarım onlar için standarttır.

## DELETE ile DROP PARTITION karşılaştırması

Aynı haftalık veriyi (30.240 satır) iki yoldan silelim ve ürettikleri **redo** miktarını ölçelim. Redo, yedekleme, arşiv log'lar ve Data Guard replikasyonu için taşınması gereken veridir. SQL\*Plus'ın `NEW_VALUE` özelliğiyle oturumun redo sayacını önce ve sonra okuyoruz:

```sql
COLUMN r0 NEW_VALUE r0 NOPRINT
COLUMN r1 NEW_VALUE r1 NOPRINT
SET VERIFY OFF

CREATE TABLE olaylar_kopya AS SELECT * FROM olaylar_p;          -- bölümsüz kopya
CREATE INDEX olaylar_kopya_ix ON olaylar_kopya (sunucu_id, zaman);

SELECT value AS r0 FROM v$mystat JOIN v$statname USING (statistic#) WHERE name = 'redo size';
DELETE FROM olaylar_kopya WHERE zaman < TIMESTAMP '2026-10-22 00:00:00';
COMMIT;
SELECT value AS r1 FROM v$mystat JOIN v$statname USING (statistic#) WHERE name = 'redo size';
SELECT ROUND((&r1 - &r0)/1024/1024, 1) AS delete_redo_mb FROM dual;
DROP TABLE olaylar_kopya PURGE;

SELECT value AS r0 FROM v$mystat JOIN v$statname USING (statistic#) WHERE name = 'redo size';
ALTER TABLE olaylar_p DROP PARTITION FOR (TIMESTAMP '2026-10-16 00:00:00');
SELECT value AS r1 FROM v$mystat JOIN v$statname USING (statistic#) WHERE name = 'redo size';
SELECT ROUND((&r1 - &r0)/1024, 1) AS drop_redo_kb FROM dual;
```

```text
30240 rows deleted.
Elapsed: 00:00:00.30

DELETE_REDO_MB
--------------
          15.7

Table altered.
Elapsed: 00:00:00.01

DROP_REDO_KB
------------
        32.6
```

`DELETE` her satır ve her indeks girişi için undo ve redo üretti: 15,7 MB. `DROP PARTITION` bir meta veri işlemidir: sözlükte segmenti kaldırır, satırlara dokunmaz. 32,6 KB, yani **yaklaşık 500 kat** daha az redo. Fark satır sayısıyla büyür: Günde 100 milyon log satırı olan bir sistemde bir günü `DELETE` ile silmek, saatler süren ve onlarca GB redo üreten bir işken, `DROP PARTITION` her zaman saniyelerdir. Yerel indeksli tabloda (`UPDATE GLOBAL INDEXES` gerekmeden) iki indeks de geçerli kaldı.

Saklama politikası (retention) bu yüzden bölümlemenin en yaygın sebebidir: "Olayları 90 gün tut" kuralı, her gece en eski bölümü düşüren basit bir iş olur. Arşivlemek gerekiyorsa, bölüm düşürülmeden önce bir arşiv tablosuyla değiş tokuş edilir (sonraki bölüm).

## EXCHANGE PARTITION: anında yükleme ve arşivleme

Bir bölüm ile aynı yapıdaki bölümsüz bir tablo, **veri taşınmadan** yer değiştirebilir: Sadece sözlükteki segment işaretçileri değişir. Toplu yüklemede kullanım: Veriyi ayrı bir tabloya yükle, doğrula, indeksle, sonra tek bir anlık işlemle bölüme koy:

```sql
CREATE TABLE yukleme (
  id NUMBER NOT NULL, sunucu_id NUMBER NOT NULL, zaman TIMESTAMP NOT NULL,
  seviye VARCHAR2(5) NOT NULL, mesaj VARCHAR2(200) NOT NULL,
  CONSTRAINT yukleme_pk PRIMARY KEY (id, zaman));
INSERT INTO yukleme
SELECT 300000 + level, MOD(level, 60) + 1,
       TIMESTAMP '2026-12-01 00:00:00' + NUMTODSINTERVAL(level * 30, 'SECOND'), 'INFO', 'aralik verisi'
FROM dual CONNECT BY level <= 1000;
COMMIT;
CREATE INDEX yukleme_sunucu_zaman_ix ON yukleme (sunucu_id, zaman);

-- interval tablosunda hedef bölüm henüz yok: LOCK TABLE ... PARTITION FOR onu oluşturur
LOCK TABLE olaylar_p PARTITION FOR (TIMESTAMP '2026-12-01 00:00:00') IN SHARE MODE;
COMMIT;

SET TIMING ON
ALTER TABLE olaylar_p EXCHANGE PARTITION FOR (TIMESTAMP '2026-12-01 00:00:00')
  WITH TABLE yukleme INCLUDING INDEXES WITHOUT VALIDATION;
SET TIMING OFF

SELECT COUNT(*) AS bolumde FROM olaylar_p PARTITION FOR (TIMESTAMP '2026-12-01 00:00:00');
SELECT COUNT(*) AS yukleme_kalan FROM yukleme;
```

```text
Table altered.
Elapsed: 00:00:00.02

   BOLUMDE
----------
      1000

YUKLEME_KALAN
-------------
            0
```

1.000 satır (ya da 1 milyar, süre aynı) bölüme geçti, `yukleme` tablosu artık bölümün eski (boş) içeriğini tutuyor. `INCLUDING INDEXES`, yükleme tablosundaki indeksleri bölümün yerel indeksleriyle değiştirdi. `WITHOUT VALIDATION`, satırların bölümün aralığına uyduğunu kontrol etmedi: Hızlıdır ama verinin doğru olduğunu **senin** garanti etmen gerekir. Emin değilsen `WITH VALIDATION` kullan.

Değiş tokuşun koşulları sıkıdır ve hata mesajları yol gösterir. Bu dersi hazırlarken karşılaşılanlar:

- `ORA-14130: UNIQUE constraints mismatch`: Bölümlenmiş tabloda benzersiz bir kısıt var, yükleme tablosunda karşılığı yok.
- `ORA-14098: index mismatch for tables in ALTER TABLE EXCHANGE PARTITION`: Yükleme tablosundaki indeksler, bölümlenmiş tablonun **yerel** indeksleriyle birebir eşleşmiyor. Global bir PK (`(id)`) varken yükleme tablosuna PK koymak bu hatayı verir: Global indeksin yerel bir karşılığı olamaz. Yerel PK tasarımı bu sorunu da çözdü.

Arşivleme bunun tersidir: Eski bölümü boş bir arşiv tablosuyla değiştir (veri anında arşiv tablosuna geçer), sonra boşalan bölümü düşür. Arşiv tablosu Data Pump ile dışa aktarılabilir ya da daha ucuz bir depolamaya taşınabilir.

## Yerel indeks ve budama birlikte

```sql
SELECT /*+ gather_plan_statistics */ COUNT(*) FROM olaylar_p
WHERE sunucu_id = 5 AND zaman >= TIMESTAMP '2026-11-10 00:00:00';
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(format => 'ALLSTATS LAST +PARTITION -PREDICATE'));
```

```text
---------------------------------------------------------------------------------------------------------------
| Id  | Operation                 | Name                      | Starts | E-Rows | Pstart| Pstop | A-Rows | Buffers |
---------------------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT          |                           |      1 |        |       |       |      1 |       7 |
|   1 |  SORT AGGREGATE           |                           |      1 |      1 |       |       |      1 |       7 |
|   2 |   PARTITION RANGE ITERATOR|                           |      1 |    972 |     7 |1048575|    470 |       7 |
|   3 |    INDEX RANGE SCAN       | OLAYLAR_P_SUNUCU_ZAMAN_IX |      3 |    972 |     7 |1048575|    470 |       7 |
---------------------------------------------------------------------------------------------------------------
```

`PARTITION RANGE ITERATOR`: 7. bölümden başlayıp sonrakiler okundu (`Starts = 3`: üç bölümün yerel indeksi). Her birinde indeks aralık taraması yapıldı, toplam 7 blok. `sunucu_id` filtresi indeksle, `zaman` filtresi hem budamayla hem indeksle karşılandı.

Yerel indekslerin bir bedeli var: Sorgu bölüm anahtarını içermiyorsa (`WHERE sunucu_id = 5` tek başına), Oracle **her bölümün** yerel indeksine ayrı ayrı bakmak zorundadır. 1.000 bölümlü bir tabloda bu, 1.000 indeks araması demektir. Bölüm anahtarı olmadan sık çalışan bir sorgu için global bir indeks daha uygun olabilir. Tasarım her zaman sorgu desenlerine göre yapılır.

## Diğer bölümleme türleri

- **List:** Ayrık değerlere göre (`bolge`, `ulke`, `ortam`). Bir bölgeyi ayrı bir tablespace'e koymak ya da ayrı yönetmek için.
- **Hash:** Bir anahtarın hash'ine göre N eşit bölüme (2'nin kuvveti seçilir). Budama için değil, **çekişmeyi dağıtmak** için kullanılır: Çok yoğun eklenen bir tabloda, sağdaki indeks yaprağında oluşan çekişme (`enq: TX - index contention`, `buffer busy waits`) hash bölümlemeyle birden çok segmente yayılır.
- **Bileşik (composite):** Örneğin önce zamana göre range/interval, her bölümün içinde müşteriye göre hash. Hem saklama politikası hem dağıtım için.
- **Reference:** Çocuk tablo, ebeveynin bölümlemesini yabancı anahtar üzerinden miras alır (sipariş kalemleri, siparişlerin aylık bölümlemesine göre).

### Mevcut tabloyu çevrimiçi bölümlemek

12.2'den beri bölümsüz bir tablo, uygulamalar çalışırken bölümlenmiş hale getirilebilir:

```sql
CREATE TABLE deploy_kopya AS SELECT * FROM deploylar;
SET TIMING ON
ALTER TABLE deploy_kopya MODIFY
  PARTITION BY LIST (ortam) (PARTITION p_staging VALUES ('staging'), PARTITION p_prod VALUES ('production'))
  ONLINE;
SET TIMING OFF
SELECT partition_name, high_value FROM user_tab_partitions WHERE table_name = 'DEPLOY_KOPYA';
DROP TABLE deploy_kopya PURGE;
```

```text
Table altered.
Elapsed: 00:00:02.54

PARTITION_NAME HIGH_VALUE
-------------- ------------
P_PROD         'production'
P_STAGING      'staging'
```

`ONLINE` ile işlem sırasında tabloya DML devam edebilir. Arka planda veri yeni segmentlere kopyalanır ve sonunda kısa bir kilitle geçiş yapılır. Büyük bir tabloda bu saatler sürer ve kopyalama süresince **iki kat** alan gerekir. Yine de bir bakım penceresinde tabloyu kapatıp yeniden oluşturmaktan çok daha güvenlidir.

## Ne zaman bölümlemeli?

Bölümleme her büyük tablo için otomatik bir cevap değildir. Mantıklı olduğu durumlar:

- Veri **zamanla birikiyor** ve eski veri düzenli olarak siliniyor ya da arşivleniyor (log, olay, ölçüm, denetim kaydı, işlem geçmişi). En güçlü sebep budur.
- Sorguların neredeyse hepsi bölüm anahtarıyla filtreliyor ("son 24 saat", "bu ay").
- Toplu yükleme yapılıyor (exchange).
- Bakım işleri (istatistik, sıkıştırma, indeks yeniden oluşturma) bölüm bölüm yapılmalı. Örneğin eski bölümler sıkıştırılıp salt okunur bir tablespace'e taşınır.

Mantıksız olduğu durumlar: Sorguların çoğu bölüm anahtarını içermiyorsa (her sorgu bütün bölümleri tarar), tablo birkaç GB'tan küçükse, ya da bölüm sayısı çok fazlaysa (yüz binlerce küçük bölüm sözlüğü ve planlamayı yavaşlatır). Kötü seçilmiş bir bölüm anahtarı, bölümlenmemiş bir tablodan daha yavaştır.

## Alıştırma

1. `olaylar_p` tablosunda verisi tamamen 30 günden eski olan bölümleri düşüren bir PL/SQL bloğu yaz. `USER_TAB_PARTITIONS.HIGH_VALUE` bir `LONG` sütunudur ve doğrudan karşılaştırılamaz. Bunu nasıl aşarsın?
2. Bir müşteri tablosunu `ulke` sütununa göre list partitioning ile bölmek istiyorsun ama sorguların %90'ı `WHERE musteri_id = :id`. Bu tasarım ne kazandırır, ne kaybettirir?

<details><summary>Çözüm</summary>

1. 23ai/26ai'de sözlükte `HIGH_VALUE_JSON` sütunu var: Üst sınırı JSON olarak verir, `JSON_VALUE` ile tarihe çevrilir. Böylece `LONG` ile uğraşmadan, **gerçekten var olan** bölümler üzerinde dolaşırız:

```sql
SET SERVEROUTPUT ON
DECLARE
  v_sinir TIMESTAMP := TRUNC(SYSTIMESTAMP) - 30;
BEGIN
  FOR b IN (SELECT partition_name,
                   JSON_VALUE(high_value_json, '$.high_value' RETURNING TIMESTAMP) AS ust_sinir
            FROM user_tab_partitions
            WHERE table_name = 'OLAYLAR_P' AND interval = 'YES'
            ORDER BY partition_position) LOOP
    EXIT WHEN b.ust_sinir > v_sinir;
    EXECUTE IMMEDIATE 'ALTER TABLE olaylar_p DROP PARTITION '
      || DBMS_ASSERT.ENQUOTE_NAME(b.partition_name) || ' UPDATE GLOBAL INDEXES';
    DBMS_OUTPUT.PUT_LINE('düşürüldü: ' || b.partition_name
      || ' (üst sınır ' || TO_CHAR(b.ust_sinir, 'YYYY-MM-DD') || ')');
  END LOOP;
END;
/
```

```text
düşürüldü: SYS_P696 (üst sınır 2026-10-08)
düşürüldü: SYS_P697 (üst sınır 2026-10-15)
düşürüldü: SYS_P698 (üst sınır 2026-10-22)
```

(Kendi ortamında bölüm adları ve hangi haftaların düşürüleceği, bu dersi çalıştırdığın tarihe ve daha önce düşürdüğün bölümlere göre değişir.) Bir bölümün **üst sınırı** saklama sınırının gerisindeyse bütün verisi eskidir ve düşürülebilir. Üst sınırı sınırın ötesindeki bölümde hâlâ saklanması gereken satırlar vardır. `interval = 'YES'` filtresi, ilk (range) bölüme dokunmamayı garanti eder. Eski sürümlerde `HIGH_VALUE_JSON` yoksa, klasik yöntem `LONG` değeri bir PL/SQL değişkenine okuyup `EXECUTE IMMEDIATE 'SELECT ' || high_value || ' FROM dual' INTO v_ust` ile değerlendirmektir.

> **Dikkat:** Bu ders hazırlanırken denenen ilk yöntem, tarihleri döngüyle artırıp `DROP PARTITION FOR (TIMESTAMP '...')` çalıştırmaktı. Tablonun ilk (range) bölümünden **daha eski** bir değer verildiğinde `PARTITION FOR` hata vermedi, **en alttaki bölümü** düşürdü. Sonra döngünün her adımı yine "en alttaki bölümü" buldu ve bütün haftalar silindi. `PARTITION FOR (değer)`, "bu değerin gireceği bölüm" demektir. Değer var olan bir aralığa girmiyorsa sonuç beklediğin bölüm olmayabilir. Veri silen otomatik işlerde bölümleri sözlükten adlarıyla ve sınırlarıyla oku, her adımı logla, ve önce bir kopya tabloda dene.

Bu iş her gece çalıştırılır (zamanlanmış işler PL/SQL bölümünde). `UPDATE GLOBAL INDEXES`, tabloda ileride global bir indeks oluşturulursa da güvenli kalmak için var.

2. Kazanç: Ülke bazlı yönetim (bir ülkenin verisini ayrı bir tablespace'e koymak, ayrı yedeklemek, veri yerelleştirme gereksinimleri) ve ülkeye göre filtreleyen raporlar için budama. Kayıp: `WHERE musteri_id = :id` sorgusu `ulke`'yi içermediği için budama yapılamaz. Yerel bir `musteri_id` indeksiyle her bölümün indeksine ayrı ayrı bakılır, ya da global bir indeks gerekir (bölüm işlemlerinde `UPDATE GLOBAL INDEXES` disiplini ister). Ayrıca bir müşterinin ülkesi değiştiğinde satır bölümler arasında taşınmalıdır (`ENABLE ROW MOVEMENT` gerekir ve satırın ROWID'i değişir). Sorguların %90'ı birincil anahtarla geliyorsa bu tabloda bölümleme büyük ihtimalle gereksizdir: İyi bir birincil anahtar indeksi zaten birkaç blokta cevap verir.

</details>

```quiz
Zaman aralığına göre bölümlenmiş bir tabloda `WHERE TRUNC(zaman) = :gun` sorgusu neden bütün bölümleri okur?
- TRUNC bölümlenmiş tablolarda çalışmaz
- [x] Bölüm anahtarı fonksiyona sarıldığı için optimizer hangi bölümlerin gerektiğini çıkaramaz (budama yapılamaz)
- İndeks olmadığı için
? Yarı açık aralık kullan: `zaman >= :gun AND zaman < :gun + 1`.
```

```quiz
Global indeksli bir tablodan `UPDATE GLOBAL INDEXES` olmadan bölüm düşürülürse ne olur?
- Hiçbir şey, global indeks otomatik güncellenir
- [x] Global indeks UNUSABLE olur; benzersiz bir indeksse tabloya ekleme yapılamaz (ORA-01502)
- Bölüm düşürülemez
? Ya UPDATE GLOBAL INDEXES kullan ya da benzersiz anahtara bölüm anahtarını ekleyip indeksi yerel yap.
```

```quiz
30 günden eski log verisini silmenin bölümlenmiş tablodaki en verimli yolu?
- `DELETE FROM loglar WHERE zaman < SYSDATE - 30`
- [x] Eski bölümleri `ALTER TABLE ... DROP PARTITION` ile düşürmek
- Tabloyu `TRUNCATE` edip son 30 günü yeniden yüklemek
? DROP PARTITION meta veri işlemidir: satır başına undo/redo üretmez, süresi veri miktarından bağımsızdır.
```

## Özet

- Partitioning EE'de ayrı lisanslıdır; Free ve Autonomous'ta dahildir.
- Interval partitioning gelecek bölümleri otomatik oluşturur. Bölümlere değerle başvur: `PARTITION FOR (...)`.
- Budama (pruning): Bölüm anahtarı sorguda çıplak olarak filtrelenmeli. `PARTITION RANGE SINGLE/ITERATOR/ALL`, `Pstart/Pstop`.
- Yerel indeksler bölüm işlemlerinden etkilenmez. Global indeksler için `UPDATE GLOBAL INDEXES` şart. Benzersiz anahtara bölüm anahtarını ekleyerek yerel PK.
- `DROP PARTITION`: anında, neredeyse redo'suz (15,7 MB'a karşı 32,6 KB). Saklama politikasının temel aracı.
- `EXCHANGE PARTITION`: veri taşımadan yükleme ve arşivleme; indeks ve kısıt eşleşmesi gerekir.
- List, hash (çekişme dağıtma), bileşik, reference. `MODIFY PARTITION BY ... ONLINE` ile çevrimiçi dönüşüm.
- Bölüm anahtarı sorgu desenlerine göre seçilir; yanlış anahtar, bölümsüz tablodan kötüdür.
