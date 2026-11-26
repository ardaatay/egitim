# WITH, hiyerarşik sorgular, MERGE ve toplu DML

Bu ders iki yarıdan oluşuyor. İlkinde sorguları okunur parçalara bölmeyi (`WITH`), eksik günleri doldurmak için takvim üretmeyi ve ağaç/çizge verisinde gezinmeyi (`CONNECT BY` ve özyinelemeli `WITH`) ele alıyoruz. Örnek olarak bir **servis bağımlılık grafiği** kullanacağız: "auth çökerse kim etkilenir?" İkinci yarıda veri değiştirmenin üretimde işe yarayan yolları var: `MERGE` ile upsert, tek geçişte birden çok tabloya yazma, `RETURNING`, hatalı satırları atlayan yükleme ve büyük silmeleri parçalara bölmek.

## WITH: sorguyu adlandırılmış parçalara bölmek

```sql
WITH
basarisiz AS (
  SELECT uygulama_id, COUNT(*) AS adet FROM deploylar
  WHERE durum = 'basarisiz' GROUP BY uygulama_id
),
toplam AS (
  SELECT uygulama_id, COUNT(*) AS adet FROM deploylar GROUP BY uygulama_id
)
SELECT u.ad AS uygulama, t.adet AS toplam, b.adet AS basarisiz,
       ROUND(100 * b.adet / t.adet, 2) AS yuzde
FROM uygulamalar u
JOIN toplam t    ON t.uygulama_id = u.id
JOIN basarisiz b ON b.uygulama_id = u.id
WHERE u.ekip_id = 1
ORDER BY u.ad;
```

```text
UYGULAMA         TOPLAM  BASARISIZ      YUZDE
------------ ---------- ---------- ----------
api-gateway         625         27       4.32
auth                625         27       4.32
```

`WITH` (common table expression, CTE) iç içe alt sorguları yukarıdan aşağı okunan adımlara çevirir. Her parça kendinden önceki parçalara başvurabilir. Performans açısından Oracle bir CTE'yi ya ana sorguya **gömer** (inline, alt sorgu gibi), ya da birden çok kez kullanılıyorsa geçici bir tabloya **yazar** (materialize). Bunu ipuçlarıyla zorlayabilirsin (`/*+ MATERIALIZE */`, `/*+ INLINE */`), ama genellikle optimizer'ın kararı doğrudur. Performans bölümünde planlarda bunu göreceğiz.

### Eksik günleri doldurmak: takvim üretmek

Analitik fonksiyonlar dersinde fark ettiğimiz sorun: `GROUP BY` sadece var olan satırlardan grup üretir, deploy olmayan günler grafikte **kaybolur**. Çözüm, önce bir gün listesi üretip veriyi ona `LEFT JOIN` etmek:

```sql
WITH gunler (gun) AS (
  SELECT DATE '2026-11-03' FROM dual
  UNION ALL
  SELECT gun + 1 FROM gunler WHERE gun < DATE '2026-11-12'
),
gunluk AS (
  SELECT TRUNC(baslangic) AS gun, COUNT(*) AS adet FROM deploylar
  WHERE uygulama_id = 1 AND ortam = 'production'
  GROUP BY TRUNC(baslangic)
)
SELECT TO_CHAR(g.gun, 'YYYY-MM-DD') AS gun, NVL(d.adet, 0) AS prod_deploy
FROM gunler g LEFT JOIN gunluk d ON d.gun = g.gun
ORDER BY g.gun;
```

```text
GUN        PROD_DEPLOY
---------- -----------
2026-11-03           1
2026-11-04           1
2026-11-05           0
2026-11-06           1
2026-11-07           1
2026-11-08           0
2026-11-09           1
2026-11-10           0
2026-11-11           0
2026-11-12           0
```

`gunler` **özyinelemeli** bir CTE: Bir başlangıç satırı (`anchor`), `UNION ALL`, ve kendine başvuran bir adım. Adım, koşul yanlış olana kadar tekrarlanır. Oracle'da aynı listeyi daha kısa yoldan, `CONNECT BY` ile üretmek de yaygındır ve eski kodlarda sık görürsün:

```sql
SELECT DATE '2026-11-03' + level - 1 AS gun FROM dual CONNECT BY level <= 10;
```

Örnek şemayı oluşturan betik de bu yöntemi kullanıyordu (`FROM dual CONNECT BY level <= 200000`). Sayı ve tarih dizileri üretmek, test verisi oluşturmak ve "boşlukları doldurmak" için standart kalıptır.

## Hiyerarşik veri: bağımlılık grafiği

Uygulamalar arası bağımlılıklar için bir tablo oluşturalım. "mobil-bff, api-gateway'i çağırır" gibi:

```sql
CREATE TABLE bagimliliklar (
  uygulama_id     NUMBER NOT NULL REFERENCES uygulamalar,
  bagimli_oldugu  NUMBER NOT NULL REFERENCES uygulamalar,
  PRIMARY KEY (uygulama_id, bagimli_oldugu)
);
INSERT INTO bagimliliklar VALUES
  (7, 1),           -- mobil-bff → api-gateway
  (1, 2), (1, 3), (1, 5),   -- api-gateway → auth, odeme-api, arama-api
  (3, 4), (3, 2),   -- odeme-api → fatura, auth
  (4, 8),           -- fatura → bildirim
  (5, 6),           -- arama-api → indeksleyici
  (8, 2);           -- bildirim → auth
COMMIT;
```

### CONNECT BY

Oracle'ın özel hiyerarşik sorgu sözdizimi: "mobil-bff çalışmak için nelere ihtiyaç duyar?"

```sql
SELECT LPAD(' ', 2 * (LEVEL - 1)) || u.ad AS agac,
       LEVEL AS seviye,
       SYS_CONNECT_BY_PATH(u.ad, ' > ') AS yol
FROM bagimliliklar b JOIN uygulamalar u ON u.id = b.bagimli_oldugu
START WITH b.uygulama_id = 7
CONNECT BY NOCYCLE PRIOR b.bagimli_oldugu = b.uygulama_id
ORDER SIBLINGS BY u.ad;
```

```text
AGAC                     SEVIYE YOL
-------------------- ---------- ------------------------------------------------
api-gateway                   1  > api-gateway
  arama-api                   2  > api-gateway > arama-api
    indeksleyici              3  > api-gateway > arama-api > indeksleyici
  auth                        2  > api-gateway > auth
  odeme-api                   2  > api-gateway > odeme-api
    auth                      3  > api-gateway > odeme-api > auth
    fatura                    3  > api-gateway > odeme-api > fatura
      bildirim                4  > api-gateway > odeme-api > fatura > bildirim
        auth                  5  > api-gateway > odeme-api > fatura > bildirim > auth
```

- `START WITH`: kök satırlar.
- `CONNECT BY PRIOR üst = alt`: Bir satırın çocukları, `PRIOR` (önceki seviyedeki) satırın `bagimli_oldugu` değerinin, kendi `uygulama_id`'sine eşit olduğu satırlardır. `PRIOR`'un hangi tarafta olduğu yönü belirler.
- `LEVEL`, `SYS_CONNECT_BY_PATH`, `CONNECT_BY_ROOT sutun` (kökün değeri), `CONNECT_BY_ISLEAF` (yaprak mı) sözde sütunlar.
- `ORDER SIBLINGS BY`: ağaç yapısını bozmadan kardeşleri sıralar. Normal `ORDER BY` ağacı dağıtır.

`auth` üç kez görünüyor: Bu bir ağaç değil, bir **yönlü çizge** (DAG). Aynı düğüme farklı yollardan ulaşılıyor. Toplam bağımlılık listesi istiyorsan `DISTINCT` ile tekilleştir.

**Ters yön**, yani etki analizi: "auth çökerse kimler etkilenir?" Sadece `PRIOR`'u diğer tarafa al:

```sql
SELECT u.ad AS etkilenen, MIN(LEVEL) AS mesafe
FROM bagimliliklar b JOIN uygulamalar u ON u.id = b.uygulama_id
START WITH b.bagimli_oldugu = 2
CONNECT BY NOCYCLE PRIOR b.uygulama_id = b.bagimli_oldugu
GROUP BY u.ad
ORDER BY mesafe, etkilenen;
```

```text
ETKILENEN        MESAFE
------------ ----------
api-gateway           1
bildirim              1
odeme-api             1
fatura                2
mobil-bff             2
```

Auth'a doğrudan bağımlı 3 servis, dolaylı olarak 2 servis daha var. Bir değişiklik ya da bakım penceresi planlarken bu, "kimi haberdar etmeliyim" listesidir.

### Döngüler

Gerçek bağımlılık grafiklerinde döngüler olur (A → B → A). Döngülü veride `NOCYCLE` olmadan sorgu hata verir:

```sql
INSERT INTO bagimliliklar VALUES (2, 7);   -- auth → mobil-bff: döngü oluşturur
SELECT COUNT(*) FROM bagimliliklar b
START WITH b.uygulama_id = 7
CONNECT BY PRIOR b.bagimli_oldugu = b.uygulama_id;
```

```text
ORA-01436: CONNECT BY loop in user data
```

`NOCYCLE` ile döngü noktasında durur ve `CONNECT_BY_ISCYCLE` döngüyü kapatan satırı işaretler. Bu, döngüleri **bulmak** için de kullanılır:

```sql
SELECT SYS_CONNECT_BY_PATH(b.uygulama_id, '->') || '->' || b.bagimli_oldugu AS dongu
FROM bagimliliklar b
WHERE CONNECT_BY_ISCYCLE = 1
START WITH b.uygulama_id = 7
CONNECT BY NOCYCLE PRIOR b.bagimli_oldugu = b.uygulama_id;
ROLLBACK;
```

```text
DONGU
----------------------
->7->1->2->7
->7->1->3->2->7
->7->1->3->4->8->2->7
```

### Özyinelemeli WITH

Aynı etki analizi standart SQL ile. Daha uzun ama daha esnek: Her adımda hesaplama yapabilir (mesafe, toplam gecikme, yol), PostgreSQL ve SQL Server'da da aynen çalışır:

```sql
WITH etki (id, ad, mesafe, yol) AS (
  SELECT u.id, u.ad, 0, CAST(u.ad AS VARCHAR2(400))
  FROM uygulamalar u WHERE u.ad = 'auth'
  UNION ALL
  SELECT u.id, u.ad, e.mesafe + 1, e.yol || ' <- ' || u.ad
  FROM etki e
  JOIN bagimliliklar b ON b.bagimli_oldugu = e.id
  JOIN uygulamalar u   ON u.id = b.uygulama_id
)
SEARCH DEPTH FIRST BY ad SET sira
CYCLE id SET dongu TO 'E' DEFAULT 'H'
SELECT mesafe, yol FROM etki ORDER BY sira;
```

```text
    MESAFE YOL
---------- ---------------------------------------------------------------
         0 auth
         1 auth <- api-gateway
         2 auth <- api-gateway <- mobil-bff
         1 auth <- bildirim
         2 auth <- bildirim <- fatura
         3 auth <- bildirim <- fatura <- odeme-api
         4 auth <- bildirim <- fatura <- odeme-api <- api-gateway
         5 auth <- bildirim <- fatura <- odeme-api <- api-gateway <- mobil-bff
         1 auth <- odeme-api
         2 auth <- odeme-api <- api-gateway
         3 auth <- odeme-api <- api-gateway <- mobil-bff
```

- `SEARCH DEPTH FIRST BY ad SET sira`: Sonucu ağaç gibi (derinlik öncelikli) sıralamak için bir `sira` sütunu üretir. `BREADTH FIRST` seviye seviye sıralar.
- `CYCLE id SET dongu TO 'E' DEFAULT 'H'`: Bir yolda aynı `id` tekrar görülürse o satırı işaretler ve oradan devam etmez. Bu olmadan döngülü veri sonsuz özyineleme ve `ORA-32044` ile sonuçlanır.
- Özyinelemeli sütun tiplerini ilk satırda sabitle (`CAST(... AS VARCHAR2(400))`), yoksa yol büyüdükçe "değer çok büyük" hatası alırsın.

Mesafe 5'teki yol, etki zincirinin ne kadar uzayabildiğini gösteriyor: mobil-bff, auth'a hem 2 adımda hem 5 adımda bağlı.

## MERGE: upsert

Bir izleme ajanı her dakika sunucu metriklerini gönderiyor. Satır varsa güncelle, yoksa ekle:

```sql
CREATE TABLE sunucu_metrik (
  sunucu_id   NUMBER PRIMARY KEY REFERENCES sunucular,
  cpu_yuzde   NUMBER(5,1) NOT NULL,
  guncelleme  DATE NOT NULL
);
INSERT INTO sunucu_metrik VALUES
  (1, 40, DATE '2026-11-26' - 1/24), (2, 55, DATE '2026-11-26' - 1/24), (3, 70, DATE '2026-11-26' - 1/24);
COMMIT;

MERGE INTO sunucu_metrik h
USING (SELECT * FROM (VALUES (1, 40, DATE '2026-11-26'),
                             (2, 91, DATE '2026-11-26'),
                             (4, 12, DATE '2026-11-26'))
       AS v (sunucu_id, cpu_yuzde, zaman)) k
ON (h.sunucu_id = k.sunucu_id)
WHEN MATCHED THEN
  UPDATE SET h.cpu_yuzde = k.cpu_yuzde, h.guncelleme = k.zaman
  WHERE h.cpu_yuzde <> k.cpu_yuzde
WHEN NOT MATCHED THEN
  INSERT (sunucu_id, cpu_yuzde, guncelleme) VALUES (k.sunucu_id, k.cpu_yuzde, k.zaman);

SELECT * FROM sunucu_metrik ORDER BY sunucu_id;
```

```text
2 rows merged.

 SUNUCU_ID  CPU_YUZDE GUNCELLEME
---------- ---------- ----------------
         1         40 2026-11-25 23:00
         2         91 2026-11-26 00:00
         3         70 2026-11-25 23:00
         4         12 2026-11-26 00:00
```

Kaynakta 3 satır vardı ama "2 rows merged": Sunucu 1'in değeri değişmediği için `WHEN MATCHED ... WHERE` koşulu onu atladı. Değişmeyen satırı güncellememek gereksiz redo, undo ve kilit üretmez; trigger'lar ve değişiklik yakalama (CDC) sistemleri sahte olaylar görmez. Sunucu 4 yoktu, eklendi.

`MERGE`'ün diğer özellikleri: `WHEN MATCHED THEN UPDATE ... DELETE WHERE ...` güncellenen satırlardan koşulu sağlayanları siler; her iki dal da isteğe bağlıdır (sadece `WHEN NOT MATCHED` "yoksa ekle" demektir).

### ORA-30926: kaynakta tekrar

```sql
MERGE INTO sunucu_metrik h
USING (SELECT * FROM (VALUES (1, 50, DATE '2026-11-26'), (1, 60, DATE '2026-11-26'))
       AS v (sunucu_id, cpu_yuzde, zaman)) k
ON (h.sunucu_id = k.sunucu_id)
WHEN MATCHED THEN UPDATE SET h.cpu_yuzde = k.cpu_yuzde;
```

```text
ORA-30926: The operation attempted to update the same row (rowid: 'AAASAgAAYAAAAlOAAA') twice.
```

Kaynakta aynı anahtar için iki satır var: Hangisinin kazanacağı belirsiz olduğu için Oracle reddediyor. Gerçek hayatta bu, aynı partide aynı sunucudan iki ölçüm geldiğinde olur. Kaynağı önce tekilleştir: genellikle `ROW_NUMBER() OVER (PARTITION BY sunucu_id ORDER BY zaman DESC) = 1` ile en yenisini al.

### Eşzamanlılık notu

İki oturum aynı anda, henüz var olmayan aynı anahtar için `MERGE` çalıştırırsa ikisi de "yok" görüp eklemeye çalışabilir: Biri `ORA-00001: unique constraint violated` alır. `MERGE` atomik bir "kilitle ve kontrol et" değildir. Birincil anahtar seni yanlış veriden korur ama uygulama bu hatayı yakalayıp yeniden denemeli (ikinci denemede satır vardır ve güncellenir).

## Join ile UPDATE ve DELETE

23ai'den beri `UPDATE` ve `DELETE` doğrudan join yapabilir:

```sql
UPDATE sunucu_metrik m
SET m.cpu_yuzde = m.cpu_yuzde + 1
FROM sunucular s
WHERE s.id = m.sunucu_id AND s.bolge = 'fra';
-- 1 row updated.
ROLLBACK;
```

Eski sürümlerde aynı iş ilişkili alt sorgu (`WHERE EXISTS` ve `SET x = (SELECT ...)`) ya da `MERGE` ile yapılırdı. Eski kodlarda bu kalıpları görürsün. `SET x = (SELECT ...)` kullanırken `WHERE EXISTS` eklemeyi unutmak, eşleşmeyen satırları sessizce **NULL'a** çevirir: klasik bir veri kaybı hatası.

## RETURNING: değiştirdiğin satırı geri al

Bir satır ekledikten sonra oluşan kimliği almak için ikinci bir sorgu atmak hem yavaş hem de eşzamanlılıkta yanlıştır:

```sql
VARIABLE yeni_id NUMBER
INSERT INTO deploylar (uygulama_id, sunucu_id, surum, ortam, baslangic, sure_sn, durum)
VALUES (3, 1, 'v6.0.0', 'staging', SYSTIMESTAMP, 0, 'basarili')
RETURNING id INTO :yeni_id;
PRINT yeni_id
```

```text
   YENI_ID
----------
     22221
```

Kimlik değeri 5.001 değil: Identity sütunları sequence'ler gibi önbellekli değerler ayırır, ve geri alınan (`ROLLBACK`) işlemler ya da yeniden başlatmalar boşluk bırakır. Kimliklerin ardışık olacağına asla güvenme.

26ai'de `UPDATE` hem eski hem yeni değeri döndürebilir:

```sql
VARIABLE eski NUMBER
VARIABLE yeni NUMBER
UPDATE sunucular SET cpu = cpu * 2 WHERE id = 2
RETURNING OLD cpu, NEW cpu INTO :eski, :yeni;
PRINT eski yeni
ROLLBACK;
-- ESKI 8, YENI 16
```

Uygulama sürücülerinde `RETURNING`, bind değişkenleriyle aynı şekilde kullanılır (`node-oracledb`'de `{ dir: oracledb.BIND_OUT }`).

## Tek geçişte birden çok tabloya: INSERT ALL / FIRST

```sql
CREATE TABLE kritik_olaylar AS SELECT * FROM olaylar WHERE 1 = 0;   -- yapıyı kopyala, veriyi değil
CREATE TABLE uyari_olaylar  AS SELECT * FROM olaylar WHERE 1 = 0;

INSERT FIRST
  WHEN seviye = 'ERROR' THEN INTO kritik_olaylar
  WHEN seviye = 'WARN'  THEN INTO uyari_olaylar
SELECT * FROM olaylar WHERE zaman >= TIMESTAMP '2026-11-15 00:00:00';

SELECT (SELECT COUNT(*) FROM kritik_olaylar) AS kritik,
       (SELECT COUNT(*) FROM uyari_olaylar)  AS uyari;
```

```text
484 rows created.

    KRITIK      UYARI
---------- ----------
        57        427
```

Kaynak bir kez okunur, satırlar koşullara göre dağıtılır. `INSERT FIRST` ilk uyan koşulda durur, `INSERT ALL` uyan her koşulun tablosuna yazar. Bir staging tablosundan birden çok hedefe yükleme yapan ETL işlerinde kullanışlıdır.

## Hatalı satırları atlayarak yüklemek: LOG ERRORS

100.000 satırlık bir yükleme 99.999. satırdaki tek bir hatalı değer yüzünden tamamen geri alınır. DML hata günlüğü, hatalı satırları ayrı bir tabloya yazıp geri kalanını yükler:

```sql
EXEC DBMS_ERRLOG.CREATE_ERROR_LOG('SUNUCU_METRIK', 'SUNUCU_METRIK_HATA');

INSERT INTO sunucu_metrik (sunucu_id, cpu_yuzde, guncelleme)
SELECT * FROM (VALUES (10, 33, SYSDATE),      -- geçerli
                      (1, 44, SYSDATE),       -- 1 zaten var
                      (999, 10, SYSDATE),     -- böyle bir sunucu yok
                      (11, NULL, SYSDATE),    -- NOT NULL
                      (12, 12345, SYSDATE))   -- NUMBER(5,1)'e sığmaz
       AS v (a, b, c)
LOG ERRORS INTO sunucu_metrik_hata ('yukleme-1') REJECT LIMIT UNLIMITED;

SELECT ora_err_number$, sunucu_id, ora_err_mesg$ FROM sunucu_metrik_hata ORDER BY sunucu_id;
```

```text
1 row created.

ORA_ERR_NUMBER$ SUNUCU_ID ORA_ERR_MESG$
--------------- --------- -----------------------------------------------------------------
              1 1         ORA-00001: unique constraint (EGITIM.SYS_C008972) violated ...
           1400 11        ORA-01400: cannot insert NULL into ("EGITIM"."SUNUCU_METRIK"."CPU_YUZDE")
           1438 12        ORA-01438: value 12345 greater than specified precision (5, 1) for column
           2291 999       ORA-02291: integrity constraint (EGITIM.SYS_C008973) violated - parent key not found
```

Beş satırdan biri yüklendi, dördü sebepleriyle birlikte hata tablosunda. `'yukleme-1'` etiketi hangi yüklemeden geldiğini işaretler. `REJECT LIMIT` kaç hataya kadar devam edileceğini belirler; `UNLIMITED` yerine makul bir sayı vermek, tamamen bozuk bir dosyanın sessizce "yüklenmesini" engeller.

Kısıt adlarına dikkat: `SYS_C008972` gibi sistem adları hata mesajlarında hiçbir şey anlatmaz. Kısıtları adlandır (`CONSTRAINT sunucu_metrik_pk PRIMARY KEY`); şema dersinde konuşacağız.

## Büyük silmeleri parçalamak

Olay tablosundan 60.000 eski satırı silmek. Tek bir `DELETE` bütün satırları tek transaction'da siler: Büyük miktarda undo üretir, satırları silme bitene kadar kilitli tutar, ve iş yarıda kesilirse geri alma da bir o kadar sürer. Üretimde, özellikle replikasyon olan sistemlerde, silmeyi parçalara bölmek yaygındır:

```sql
CREATE TABLE olay_arsiv AS SELECT * FROM olaylar;   -- denemek için kopya
SET SERVEROUTPUT ON
DECLARE
  v_toplam PLS_INTEGER := 0;
  v_tur    PLS_INTEGER := 0;
BEGIN
  LOOP
    DELETE FROM olay_arsiv
    WHERE zaman < TIMESTAMP '2026-10-15 00:00:00'
      AND ROWNUM <= 20000;
    EXIT WHEN SQL%ROWCOUNT = 0;
    v_toplam := v_toplam + SQL%ROWCOUNT;
    v_tur    := v_tur + 1;
    COMMIT;
  END LOOP;
  DBMS_OUTPUT.PUT_LINE('silinen: ' || v_toplam || ', tur: ' || v_tur);
END;
/
```

```text
silinen: 60479, tur: 4
```

`DELETE` içinde `FETCH FIRST` desteklenmez (`ORA-03049`), bu yüzden burada `ROWNUM` doğru araçtır: Hangi satırların silineceği önemli değil, sadece sayının sınırlı olması önemli. Her turda `zaman` koşulunu karşılayan satırları bulmak için bir indeks olmalı, yoksa her tur bütün tabloyu tarar.

Parçalı silme her derde deva değildir. Veritabanı genelinde tutarlılık kaybolur (iş yarıda kesilirse silme de yarım kalır, bu yüzden iş **yeniden çalıştırılabilir** olmalı) ve toplam süre uzayabilir. Tablonun büyük bir kısmı silinecekse daha iyi yollar var: Kalacak satırları yeni bir tabloya kopyalayıp tabloları değiştirmek (`CREATE TABLE ... AS SELECT` + yeniden adlandırma) ya da zamana göre bölümlenmiş tablolarda bölümü bir anda düşürmek (`ALTER TABLE ... DROP PARTITION`). Partitioning dersinde göreceğiz.

## Alıştırma

1. `odeme-api` (id 3) bakıma alınacak. Bunu çağıran **ve** son 30 günde (veri 9 Kasım'da bitiyor, 10 Ekim'den sonrasını al) production'a deploy almış servisleri listele.
2. Günlük bir rapor tablosu (`gunluk_deploy(gun DATE, uygulama_id NUMBER, adet NUMBER, basarisiz NUMBER, PRIMARY KEY (gun, uygulama_id))`) oluştur ve `MERGE` ile doldur. Aynı `MERGE`'ü ikinci kez çalıştırdığında "0 rows merged" almalısın.

<details><summary>Çözüm</summary>

```sql
WITH etkilenen AS (
  SELECT DISTINCT b.uygulama_id AS id
  FROM bagimliliklar b
  START WITH b.bagimli_oldugu = 3
  CONNECT BY NOCYCLE PRIOR b.uygulama_id = b.bagimli_oldugu
)
SELECT u.ad
FROM etkilenen e JOIN uygulamalar u ON u.id = e.id
WHERE EXISTS (SELECT 1 FROM deploylar d
              WHERE d.uygulama_id = e.id AND d.ortam = 'production'
                AND d.baslangic >= TIMESTAMP '2026-10-10 00:00:00')
ORDER BY u.ad;
```

```text
AD
------------
api-gateway
mobil-bff
```

`odeme-api`'yi doğrudan çağıran api-gateway, onu da çağıran mobil-bff. İkisi de son dönemde production'a deploy almış, yani aktif olarak geliştiriliyorlar ve bakım penceresinden haberdar edilmeleri gerekiyor.

```sql
CREATE TABLE gunluk_deploy (
  gun DATE, uygulama_id NUMBER, adet NUMBER NOT NULL, basarisiz NUMBER NOT NULL,
  CONSTRAINT gunluk_deploy_pk PRIMARY KEY (gun, uygulama_id)
);

MERGE INTO gunluk_deploy h
USING (SELECT TRUNC(baslangic) AS gun, uygulama_id, COUNT(*) AS adet,
              COUNT(CASE WHEN durum = 'basarisiz' THEN 1 END) AS basarisiz
       FROM deploylar GROUP BY TRUNC(baslangic), uygulama_id) k
ON (h.gun = k.gun AND h.uygulama_id = k.uygulama_id)
WHEN MATCHED THEN
  UPDATE SET h.adet = k.adet, h.basarisiz = k.basarisiz
  WHERE h.adet <> k.adet OR h.basarisiz <> k.basarisiz
WHEN NOT MATCHED THEN
  INSERT VALUES (k.gun, k.uygulama_id, k.adet, k.basarisiz);
COMMIT;
```

```text
2504 rows merged.
Commit complete.

-- ikinci çalıştırma:
0 rows merged.
```

İkinci çalıştırmada her satır eşleşir ama hiçbir değer değişmediği için `WHERE` koşulu güncellemeleri atlar. Bu, işi **yeniden çalıştırılabilir** (idempotent) yapar: Bir zamanlanmış iş yarıda kesilirse ya da iki kez çalışırsa veri bozulmaz. Burada `adet` ve `basarisiz` `NOT NULL` olduğu için `<>` karşılaştırması güvenli. NULL olabilen sütunlarda `DECODE(h.x, k.x, 0, 1) = 1` kullan: `DECODE` iki NULL'u eşit sayar. `h.x <> k.x` ise değerlerden biri NULL olduğunda doğru değil bilinmez döner ve değişikliği kaçırır. (Oracle'da standart `IS DISTINCT FROM` yoktur.)

</details>

```quiz
`GROUP BY TRUNC(tarih)` ile günlük sayım yapınca kaydı olmayan günler neden görünmez?
- TRUNC NULL döndürür
- [x] GROUP BY sadece var olan satırlardan grup üretir; boşlukları doldurmak için üretilmiş bir gün listesine LEFT JOIN gerekir
- COUNT sıfırları saymaz
? Gün listesi özyinelemeli WITH ya da `CONNECT BY level <= n` ile üretilir.
```

```quiz
`MERGE` sırasında `ORA-30926` hatası ne anlama gelir?
- Hedef tabloda birincil anahtar yok
- [x] Kaynakta aynı hedef satırla eşleşen birden çok satır var
- MERGE eşzamanlı çalıştırılamaz
? Kaynağı önce tekilleştir: örneğin ROW_NUMBER ile en yeni kaydı seç.
```

```quiz
`UPDATE t SET x = (SELECT y FROM s WHERE s.id = t.id)` sorgusunda WHERE EXISTS unutulursa ne olur?
- Hata verir
- [x] s'de eşleşmesi olmayan t satırlarında x sessizce NULL olur
- Sadece eşleşen satırlar güncellenir
? Ya `WHERE EXISTS (...)` ekle ya da 23ai'deki `UPDATE ... FROM` ile join kullan.
```

## Özet

- `WITH` sorguyu adımlara böler. Özyinelemeli `WITH` ya da `CONNECT BY level` ile sayı ve tarih dizileri; boşlukları doldurmak için takvime `LEFT JOIN`.
- `CONNECT BY`: `START WITH`, `PRIOR` yönü, `LEVEL`, `SYS_CONNECT_BY_PATH`, `ORDER SIBLINGS BY`. Döngüler için `NOCYCLE` ve `CONNECT_BY_ISCYCLE`.
- Özyinelemeli `WITH`: standart, esnek; `SEARCH` ve `CYCLE` maddeleri.
- `MERGE`: upsert; değişmeyeni güncellememek için `WHEN MATCHED ... WHERE`; kaynağı tekilleştir (`ORA-30926`).
- 23ai/26ai: `UPDATE ... FROM` ile join, `RETURNING OLD/NEW`.
- `INSERT FIRST/ALL`, `LOG ERRORS ... REJECT LIMIT`, parçalı silme (`ROWNUM`, commit, yeniden çalıştırılabilir).
