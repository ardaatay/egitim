# Oracle SQL'in farkları: veri tipleri, NULL, tarih ve DUAL

PostgreSQL, MySQL ya da SQL Server bilen biri Oracle'da çoğu sorguyu hemen yazar. Sorun, **neredeyse aynı** çalışan ama farklı sonuç veren yerlerdedir: boş string'in NULL olması, saat de içeren `DATE` tipi, Türkçe karakterlerde bayt ile karakter farkı, `ROWNUM`'un `ORDER BY`'dan önce uygulanması. Bu derste bunları gerçek çıktılarla tek tek inceliyoruz. Bunların hepsi üretimde sık görülen hataların kaynağıdır.

Örnekleri örnek şemanın kullanıcısıyla çalıştır: `docker exec -it ora-egitim sqlplus egitim/egitim@FREEPDB1`.

> **Dikkat:** Türkçe karakterlerin doğru görünmesi için istemcinin karakter setini belirt: `docker exec -it -e NLS_LANG=AMERICAN_AMERICA.AL32UTF8 ora-egitim sqlplus ...`. Uygulama sürücüleri (thin mode) bunu kendisi halleder.

## Boş string NULL'dır

Oracle'ın en meşhur farkı: `''` (sıfır uzunluklu string) **NULL**'dır.

```sql
SELECT CASE WHEN '' IS NULL THEN 'bos string NULL' ELSE 'degil' END AS sonuc;
SELECT LENGTH('') AS uzunluk, NVL('', 'yok') AS nvl FROM dual;
SELECT COUNT(*) AS bos_esit FROM sunucular WHERE '' = '';
```

```text
SONUC
---------------
bos string NULL

   UZUNLUK NVL
---------- ---
           yok

  BOS_ESIT
----------
         0
```

`LENGTH('')` sıfır değil NULL döndü, `'' = ''` bile doğru değil (NULL = NULL bilinmezdir). Pratik sonuçları:

- Bir uygulama "boş açıklama" ile "açıklama girilmemiş" arasında fark gözetiyorsa Oracle'da bunu ayırt edemezsin. Başka veritabanından taşınırken `WHERE aciklama = ''` sorguları sessizce **hiç satır döndürmez**.
- `NOT NULL` bir `VARCHAR2` sütuna `''` eklemeye çalışmak `ORA-01400: cannot insert NULL` verir.
- Doğru karşılaştırma: `WHERE aciklama IS NULL`.

NULL fonksiyonları: `NVL(x, varsayilan)`, `NVL2(x, null_degilse, nullsa)`, `COALESCE(a, b, c)` (standart, ilk NULL olmayanı döner ve gerekmeyen ifadeleri hesaplamaz), `NULLIF(a, b)` (eşitse NULL).

### NOT IN ve NULL tuzağı

```sql
-- alt sorgu 1 ve NULL döner
SELECT COUNT(*) AS not_in FROM ekipler
WHERE id NOT IN (SELECT 1 FROM dual UNION ALL SELECT NULL FROM dual);

SELECT COUNT(*) AS not_exists FROM ekipler e
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 AS x FROM dual UNION ALL SELECT NULL FROM dual) v
                  WHERE v.x = e.id);
```

```text
    NOT_IN
----------
         0

NOT_EXISTS
----------
         3
```

4 ekipten 1'i listede, kalan 3'ü dönmeli. `NOT IN` ise **hiçbir şey** döndürmedi: `id NOT IN (1, NULL)`, `id <> 1 AND id <> NULL` demektir ve `id <> NULL` her zaman bilinmezdir. Alt sorgunun döndürdüğü tek bir NULL bütün sonucu boşaltır. Bu standart SQL davranışıdır, sadece Oracle'a özgü değil. Ama Oracle'da boş string'ler de NULL olduğu için daha sık karşına çıkar. Kural: Alt sorgulu olumsuzlamalarda `NOT EXISTS` kullan, ya da alt sorguda `WHERE x IS NOT NULL` ekle.

## Karakter tipleri ve Türkçe

`VARCHAR2(n)` varsayılan olarak **n bayt** demektir, n karakter değil. Veritabanı karakter seti AL32UTF8 (UTF-8) olduğunda Türkçe karakterlerin çoğu (`ı ş ğ ü ö ç İ`) 2 bayt tutar:

```sql
CREATE TABLE t_ad (kisa VARCHAR2(5), kisa_char VARCHAR2(5 CHAR));
INSERT INTO t_ad (kisa_char) VALUES ('ışığı');
INSERT INTO t_ad (kisa) VALUES ('ışığı');
SELECT LENGTH('ışığı') AS karakter, LENGTHB('ışığı') AS bayt;
```

```text
1 row created.

INSERT INTO t_ad (kisa) VALUES ('ışığı')
                                *
ERROR at line 1:
ORA-12899: value too large for column "EGITIM"."T_AD"."KISA" (actual: 10, maximum: 5)

  KARAKTER       BAYT
---------- ----------
         5         10
```

5 karakterlik bir kelime 10 bayt tuttu. Test verisinde İngilizce isimler kullanan bir uygulama, üretimde "Çağrı Gündoğdu" gibi bir isimde `ORA-12899` almaya başlar. Çözüm: sütunları `VARCHAR2(100 CHAR)` olarak tanımla, ya da şema oluşturulmadan önce oturumda `ALTER SESSION SET NLS_LENGTH_SEMANTICS = CHAR`. Veritabanının karakter setini kontrol et:

```sql
SELECT parameter, value FROM nls_database_parameters
WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_LENGTH_SEMANTICS');
-- AL32UTF8, BYTE
```

`VARCHAR2` en fazla 4000 bayttır (`MAX_STRING_SIZE=EXTENDED` ile 32767). Daha uzun metin için `CLOB`. `CHAR(n)` sabit uzunluklu ve boşlukla doldurulur, neredeyse hiç kullanma. `NVARCHAR2` ise veritabanı karakter seti Unicode değilse anlamlıdır, AL32UTF8'de gerekmez.

### Büyük/küçük harf ve sıralama

Oracle'da `UPPER`/`LOWER` varsayılan olarak Türkçe kurallarını uygulamaz:

```sql
SELECT UPPER('istanbul') AS upper_, NLS_UPPER('istanbul', 'NLS_SORT=XTURKISH') AS nls_upper,
       LOWER('IŞIK') AS lower_, NLS_LOWER('IŞIK', 'NLS_SORT=XTURKISH') AS nls_lower;
```

```text
UPPER_   NLS_UPPER LOWER NLS_LOW
-------- --------- ----- -------
ISTANBUL İSTANBUL  işik  ışık
```

`LOWER('IŞIK')` sonucu "işik" oldu. Sıralamada da benzer bir durum var:

```sql
WITH k(ad) AS (VALUES ('çiğdem'),('cem'),('zeynep'),('ömer'),('osman'),('ışıl'),('irem'),('Ilgaz'),('şule'),('selin'))
SELECT LISTAGG(ad, ', ') WITHIN GROUP (ORDER BY ad) AS binary_sira,
       LISTAGG(ad, ', ') WITHIN GROUP (ORDER BY NLSSORT(ad, 'NLS_SORT=XTURKISH')) AS turkce_sira
FROM k;
```

```text
BINARY_SIRA:  Ilgaz, cem, irem, osman, selin, zeynep, çiğdem, ömer, ışıl, şule
TURKCE_SIRA:  cem, çiğdem, Ilgaz, ışıl, irem, osman, ömer, selin, şule, zeynep
```

Varsayılan `ORDER BY` **bayt değerine** göre sıralar: Büyük harfler önce, Türkçe karakterler sonda. Arayüzde alfabetik liste gösteriyorsan ya `NLSSORT(..., 'NLS_SORT=XTURKISH')` ile sırala ya da oturumda `NLS_SORT=XTURKISH` ayarla. Ama dikkat: Oturum ayarı indeks kullanımını da etkiler. `NLS_SORT` ikili (binary) değilse, normal bir B-tree indeksi `ORDER BY`'ı karşılayamaz. Gerekirse `NLSSORT` üzerinde fonksiyon tabanlı indeks oluşturulur (indeksler dersinde).

Büyük/küçük harf duyarsız arama için iki yol var ve Türkçe'de farklı sonuç verirler:

```sql
WITH k(ad) AS (VALUES ('İzmir'), ('izmir'), ('IZMIR'))
SELECT ad,
  CASE WHEN ad COLLATE BINARY_CI = 'izmir' THEN 'eslesir' ELSE '-' END AS binary_ci,
  CASE WHEN NLS_UPPER(ad, 'NLS_SORT=XTURKISH') = NLS_UPPER('izmir', 'NLS_SORT=XTURKISH')
       THEN 'eslesir' ELSE '-' END AS xturkish
FROM k;
```

```text
AD     BINARY_ XTURKIS
------ ------- -------
İzmir  eslesir eslesir
izmir  eslesir eslesir
IZMIR  eslesir -
```

`BINARY_CI` her üçünü eşleştirdi, Türkçe kuralı ise "IZMIR"ı eşleştirmedi (Türkçede "izmir"in büyüğü "İZMİR"dir). Hangisinin doğru olduğu uygulamaya bağlı: Kullanıcı arama kutusu için `BINARY_CI` (ya da `BINARY_AI`, aksanları da yok sayar) genelde daha kullanıcı dostudur; kimlik/eşsizlik kontrolleri için ise kuralı bilinçli seç. Sütun seviyesinde `ad VARCHAR2(50 CHAR) COLLATE BINARY_CI` tanımlanabilir (`MAX_STRING_SIZE=EXTENDED` gerektirir).

## Sayılar

`NUMBER(p, s)` ondalık tabanlı ve kesindir: Para için doğru tip. `NUMBER(10, 2)` toplam 10 basamak, 2'si virgülden sonra. Ölçeksiz `NUMBER` herhangi bir sayıyı tutar. `INTEGER` aslında `NUMBER(38)`'dir. Bilimsel hesaplama için `BINARY_DOUBLE` (IEEE 754, daha hızlı, yuvarlama hataları olur).

```sql
SELECT 10 / 4 AS bolme, TRUNC(10/4) AS tam, MOD(10, 4) AS kalan, ROUND(2.5) AS r1, ROUND(-2.5) AS r2;
```

```text
     BOLME        TAM      KALAN         R1         R2
---------- ---------- ---------- ---------- ----------
       2.5          2          2          3         -3
```

Tam sayı bölmesi yoktur (`10/4` 2 değil 2.5). `ROUND` sıfırdan uzağa yuvarlar.

Türkçe biçimli sayılar (binlik ayırıcı nokta, ondalık virgül) için biçim modelinde `G` ve `D` kullanılır, ayırıcılar açıkça verilir:

```sql
SELECT TO_CHAR(1234567.891, 'FM9G999G999D00', 'NLS_NUMERIC_CHARACTERS='',.''') AS tr_bicim,
       TO_NUMBER('1.234,56', '9G999D99', 'NLS_NUMERIC_CHARACTERS='',.''') AS tr_sayi;
-- 1.234.567,89    1234.56
```

Biçimlendirmeyi mümkünse uygulamaya bırak; veritabanından sayıyı sayı olarak al.

## DATE saat de içerir

Oracle'da `DATE` tipi **saniye hassasiyetinde tarih ve saat** tutar. Sadece varsayılan gösterim biçimi saati gizler:

```sql
ALTER SESSION SET NLS_DATE_FORMAT = 'DD-MON-RR';     -- birçok istemcinin varsayılanı
SELECT SYSDATE AS varsayilan_bicim FROM dual;
SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS simdi,
       TO_CHAR(TRUNC(SYSDATE), 'YYYY-MM-DD HH24:MI:SS') AS gun_basi;
```

```text
VARSAYILAN_BICIM
------------------
26-NOV-26

SIMDI               GUN_BASI
------------------- -------------------
2026-11-26 05:19:37 2026-11-26 00:00:00
```

Bu, "bugünün kayıtları"nı ararken en çok yapılan hatanın sebebi:

```sql
SELECT COUNT(*) AS esit      FROM deploylar WHERE baslangic = DATE '2026-03-01';
SELECT COUNT(*) AS trunc_ile FROM deploylar WHERE TRUNC(baslangic) = DATE '2026-03-01';
SELECT COUNT(*) AS aralik    FROM deploylar
WHERE baslangic >= DATE '2026-03-01' AND baslangic < DATE '2026-03-02';
```

```text
      ESIT
----------
         0

 TRUNC_ILE
----------
        16

    ARALIK
----------
        16
```

Eşitlik hiçbir şey bulmadı: `DATE '2026-03-01'` gece yarısıdır ve hiçbir deploy tam o saniyede başlamamış. `TRUNC` ve aralık aynı sonucu veriyor, ama **aralık tercih edilir**: `TRUNC(baslangic)` sütunu bir fonksiyona sardığı için `baslangic` üzerindeki indeksi kullanamaz. Aralık sorgusu kullanabilir. Bu "sütunu fonksiyona sarma" kuralını performans derslerinde tekrar göreceğiz.

Oturuma bağlı biçimlere güvenme. Tarih yazarken her zaman:

- **ANSI literal'leri**: `DATE '2026-03-01'`, `TIMESTAMP '2026-03-01 14:30:00'`
- ya da açık biçim modeli: `TO_DATE('01.03.2026 14:30', 'DD.MM.YYYY HH24:MI')`

`WHERE olusturma > '01-MAR-26'` gibi örtük dönüşümler, istemcinin `NLS_DATE_FORMAT`'ına göre çalışır ya da `ORA-01843: not a valid month` ile patlar. Aynı sorgu SQL Developer'da çalışıp uygulamada çalışmayabilir.

### Tarih aritmetiği

```sql
ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS';
SELECT DATE '2026-11-26' + 1                      AS yarin,
       DATE '2026-11-26' + 1/24                   AS bir_saat,
       DATE '2026-11-26' + INTERVAL '90' MINUTE   AS doksan_dk,
       ADD_MONTHS(DATE '2026-01-31', 1)           AS ay_sonu;
SELECT MONTHS_BETWEEN(DATE '2026-11-26', DATE '2026-01-01') AS ay,
       DATE '2026-11-26' - DATE '2026-01-01'                AS gun;
SELECT TIMESTAMP '2026-11-26 10:00:00' - TIMESTAMP '2026-11-25 08:30:00' AS fark;
```

```text
YARIN               BIR_SAAT            DOKSAN_DK           AY_SONU
------------------- ------------------- ------------------- -------------------
2026-11-27 00:00:00 2026-11-26 01:00:00 2026-11-26 01:30:00 2026-02-28 00:00:00

        AY        GUN
---------- ----------
10.8064516        329

FARK
-----------------------------
+000000001 01:30:00.000000000
```

- `DATE + sayı` gün ekler: `+ 1/24` bir saat, `+ 1/1440` bir dakika. `INTERVAL` literal'leri daha okunurdur.
- İki `DATE`'in farkı **gün sayısı** (ondalıklı) döner. İki `TIMESTAMP`'in farkı ise bir `INTERVAL DAY TO SECOND` döner: burada "1 gün 1 saat 30 dakika".
- `ADD_MONTHS` ay sonunu korur: 31 Ocak + 1 ay = 28 Şubat.
- Parçalar için `EXTRACT(HOUR FROM baslangic)` ya da `TO_CHAR(baslangic, 'HH24')`.

Türkçe ay ve gün adları için `NLS_DATE_LANGUAGE`, gereksiz boşlukları atmak için `FM`:

```sql
SELECT TO_CHAR(olusturma, 'FMDD Month YYYY, Day', 'NLS_DATE_LANGUAGE=TURKISH') AS tr
FROM sunucular WHERE id = 1;
-- 7 Şubat 2024, Çarşamba
```

### Zaman dilimleri

Tarih/saat tipleri:

| Tip | Ne tutar |
|---|---|
| `DATE` | Tarih ve saat, saniye, zaman dilimi yok |
| `TIMESTAMP(n)` | Kesirli saniye (varsayılan 6 basamak), zaman dilimi yok |
| `TIMESTAMP WITH TIME ZONE` | Zaman dilimini (ya da ofseti) de saklar |
| `TIMESTAMP WITH LOCAL TIME ZONE` | Veritabanı saatinde saklanır, okuyan oturumun dilimine çevrilerek gösterilir |

Konteynerde çalışan bir veritabanının saati genellikle **UTC**'dir. `SYSDATE` ve `SYSTIMESTAMP` **sunucunun işletim sistemi saatini**, `CURRENT_DATE` ve `CURRENT_TIMESTAMP` **oturumun zaman dilimini** kullanır:

```sql
ALTER SESSION SET TIME_ZONE = 'Europe/Istanbul';
SELECT TO_CHAR(SYSDATE, 'HH24:MI') AS sysdate_saat, TO_CHAR(CURRENT_DATE, 'HH24:MI') AS current_date_saat;
SELECT TO_CHAR(FROM_TZ(TIMESTAMP '2026-11-26 09:00:00', 'Europe/Istanbul') AT TIME ZONE 'UTC',
               'YYYY-MM-DD HH24:MI TZR') AS utc;
```

```text
SYSDA CURRE
----- -----
05:19 08:19

UTC
--------------------
2026-11-26 06:00 UTC
```

Aynı anda iki fonksiyon 3 saat farklı sonuç verdi. Sunucunun saat dilimi değiştiğinde (örneğin veritabanı bir buluta taşınınca) `SYSDATE` kullanan bütün raporlar kayar. Önerilen yaklaşım: Zamanı **UTC olarak sakla** (`TIMESTAMP` ve `SYS_EXTRACT_UTC(SYSTIMESTAMP)`, ya da `TIMESTAMP WITH TIME ZONE`), kullanıcıya gösterirken çevir.

## DUAL ve 23ai/26ai kolaylıkları

`DUAL`, tek satırlık özel bir tablodur. Eskiden Oracle'da `FROM` zorunlu olduğu için `SELECT SYSDATE FROM dual` yazılırdı. 23ai'den beri `FROM` isteğe bağlı: `SELECT SYSDATE;` çalışır. Eski kodlarda her yerde `FROM dual` görürsün.

23ai ile gelen ve günlük işi kolaylaştıran diğer yenilikler:

```sql
-- GROUP BY ve HAVING'de sütun takma adı
SELECT bolge, COUNT(*) AS adet FROM sunucular GROUP BY bolge HAVING adet > 19;

-- IF [NOT] EXISTS: betikler tekrar çalıştırılabilir olur
CREATE TABLE IF NOT EXISTS t_bool (id NUMBER, aktif BOOLEAN);

-- çok satırlı VALUES ve BOOLEAN tipi
INSERT INTO t_bool VALUES (1, TRUE), (2, FALSE), (3, NULL);
SELECT id, aktif FROM t_bool WHERE aktif;
SELECT id FROM t_bool WHERE aktif IS NOT TRUE;     -- FALSE ve NULL
DROP TABLE IF EXISTS t_bool PURGE;
```

```text
        ID AKTIF
---------- -----------
         1 TRUE

        ID
----------
         2
         3
```

Daha önce SQL'de boolean olmadığı için `CHAR(1)` ile `'Y'/'N'` ya da `NUMBER(1)` ile 0/1 kullanılırdı. Eski şemalarda bunlarla karşılaşırsın.

## Satır sınırlama: ROWNUM tuzağı

"En çok CPU'su olan 3 sunucu":

```sql
SELECT ad, cpu FROM sunucular WHERE ROWNUM <= 3 ORDER BY cpu DESC;
```

```text
AD             CPU
-------- ---------
srv-003         16
srv-002          8
srv-001          4
```

Yanlış! 16 CPU'lu 15 sunucu var. `ROWNUM` satırlar **okunurken** atanır: Oracle önce rastgele ilk 3 satırı aldı, sonra **sadece onları** sıraladı. Eski Oracle kodlarında doğru kullanım bir alt sorgu gerektirirdi (`SELECT * FROM (SELECT ... ORDER BY ...) WHERE ROWNUM <= 3`). 12c'den beri standart sözdizimi var:

```sql
SELECT ad, cpu FROM sunucular ORDER BY cpu DESC, ad FETCH FIRST 3 ROWS ONLY;
SELECT COUNT(*) FROM (SELECT ad FROM sunucular ORDER BY cpu DESC FETCH FIRST 3 ROWS WITH TIES);
SELECT ad FROM sunucular ORDER BY id OFFSET 20 ROWS FETCH NEXT 5 ROWS ONLY;     -- sayfalama
```

```text
AD             CPU
-------- ---------
srv-003         16
srv-007         16
srv-011         16

  COUNT(*)
----------
        15

AD
-------
srv-021
srv-022
srv-023
srv-024
srv-025
```

`WITH TIES` son sıradakilerle eşit olanları da getirir, bu yüzden 3 yerine 15 satır döndü. `ORDER BY`'a ikinci bir sütun (`ad`) eklemek sonucu **deterministik** yapar: Eşit değerlerde hangi satırın geleceği garanti değildir, sayfalamada aynı satır iki sayfada görünebilir ya da hiç görünmeyebilir.

Büyük tablolarda `OFFSET` sayfalama derin sayfalarda yavaşlar (100.000. sayfa için önceki bütün satırlar okunur). Bunun yerine **anahtar seti** (keyset) sayfalama: `WHERE id > :son_gorulen_id ORDER BY id FETCH FIRST 50 ROWS ONLY`.

## DDL örtük commit yapar

```sql
CREATE TABLE t_tx (x NUMBER);
INSERT INTO t_tx VALUES (1);
CREATE INDEX t_tx_ix ON t_tx (x);     -- DDL!
ROLLBACK;
SELECT COUNT(*) AS rollback_sonrasi FROM t_tx;
```

```text
ROLLBACK_SONRASI
----------------
               1
```

`ROLLBACK` ekleme işlemini geri almadı. Oracle'da her DDL komutu (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`) çalışmadan **önce ve sonra** commit yapar. PostgreSQL'deki gibi bir migration'ı tek bir transaction içinde çalıştırıp hata olursa geri alamazsın. Migration araçları (Flyway, Liquibase) bu yüzden Oracle'da her değişikliği ayrı adım olarak izler. Yarım kalmış bir migration elle temizlenir. Son derste bu konuya döneceğiz.

## Tanımlayıcılar büyük harfe çevrilir

`CREATE TABLE sunucular` yazınca tablo sözlükte `SUNUCULAR` olarak saklanır. Sorgularda büyük/küçük harf fark etmez. Ama çift tırnakla oluşturulan adlar (`CREATE TABLE "Sunucular"`) **tam olarak** öyle saklanır ve her seferinde tırnakla, aynı harflerle yazılmak zorundadır. Bazı ORM'ler ve göç araçları varsayılan olarak tırnaklı ad üretir. Bu, "tablo var ama `ORA-00942` alıyorum" sorununun sık bir sebebidir. Sözlükte kontrol et: `SELECT table_name FROM user_tables`.

## Alıştırma

1. 9–15 Kasım 2026 haftasında her gün için ERROR seviyesindeki olay sayısını, gün adı Türkçe olacak şekilde listele. (Örnek verideki olaylar 1 Ekim–16 Kasım 2026 arasını kapsıyor.) Sonuçta olayı olmayan günler de görünmeli mi? Neden?
2. `sunucular` tablosundan ekip adlarını ve her ekibin sunucularını, sunucu adları Türkçe kurallarına göre (`NLS_SORT=XTURKISH`) sıralanmış tek satırda listele.
3. Bir geliştirici şu sorguyu yazmış: `SELECT * FROM deploylar WHERE ortam <> 'production' OR ortam = ''`. Ne yapmaya çalışıyor, ne yapıyor, nasıl düzeltilir?

<details><summary>Çözüm</summary>

```sql
SELECT TO_CHAR(TRUNC(zaman), 'FMDD.MM.YYYY Day', 'NLS_DATE_LANGUAGE=TURKISH') AS gun,
       COUNT(*) AS hata
FROM olaylar
WHERE seviye = 'ERROR'
  AND zaman >= TIMESTAMP '2026-11-09 00:00:00'
  AND zaman <  TIMESTAMP '2026-11-16 00:00:00'
GROUP BY TRUNC(zaman)
ORDER BY TRUNC(zaman);
```

```text
GUN                          HATA
--------------------- ----------
9.11.2026 Pazartesi            45
10.11.2026 Salı                44
11.11.2026 Çarşamba            45
12.11.2026 Perşembe            45
13.11.2026 Cuma                44
14.11.2026 Cumartesi           45
15.11.2026 Pazar               44
```

Filtrede sütun çıplak (aralık), gruplamada `TRUNC` kullanıldı: Satırları bulmak için indeks kullanılabilir, gruplama sonra yapılır. Olayı olmayan bir gün sonuçta **görünmez**, çünkü `GROUP BY` sadece var olan satırlardan grup oluşturur. Grafiğe veri hazırlıyorsan bu boşluklar yanıltıcıdır; çözümü (bir gün listesi üretip `LEFT JOIN`) sonraki derslerde göreceğiz.

```sql
SELECT e.ad AS ekip,
       LISTAGG(s.ad, ', ') WITHIN GROUP (ORDER BY NLSSORT(s.ad, 'NLS_SORT=XTURKISH')) AS sunucular
FROM ekipler e JOIN sunucular s ON s.ekip_id = e.id
GROUP BY e.ad;
```

(Sunucu adları ASCII olduğu için burada sıra değişmez, ama kalıbı Türkçe veride aynen kullanırsın.)

3. Muhtemelen "production olmayanlar ve ortamı boş olanlar"ı istiyor. `ortam = ''` Oracle'da `ortam = NULL` demektir ve **hiçbir zaman** doğru olmaz; ortamı NULL olan satırlar `ortam <> 'production'` koşulunu da sağlamaz (NULL karşılaştırması bilinmez). Doğrusu: `WHERE ortam <> 'production' OR ortam IS NULL`, ya da `WHERE LNNVL(ortam = 'production')`. (Bu tabloda `ortam` NOT NULL olduğu için sonuç zaten aynıdır, ama alışkanlık olarak doğrusunu yaz.)

</details>

```quiz
`SELECT COUNT(*) FROM musteriler WHERE telefon = ''` Oracle'da ne döner?
- Telefonu boş olan müşteri sayısı
- [x] Her zaman 0: `''` NULL'dır ve `= NULL` hiçbir satırda doğru olmaz
- Hata verir
? Doğru sorgu `WHERE telefon IS NULL`.
```

```quiz
`VARCHAR2(20)` tanımlı bir sütuna 15 karakterlik Türkçe bir isim neden sığmayabilir?
- VARCHAR2 Türkçe desteklemez
- [x] Varsayılan uzunluk anlambilimi BYTE'tır ve AL32UTF8'de Türkçe harflerin çoğu 2 bayt tutar
- 20 karakterden fazla olamaz
? `VARCHAR2(20 CHAR)` ile karakter sayısı olarak tanımla.
```

```quiz
"1 Mart'taki deploy'lar" için en doğru filtre hangisi?
- `WHERE baslangic = DATE '2026-03-01'`
- `WHERE TRUNC(baslangic) = DATE '2026-03-01'`
- [x] `WHERE baslangic >= DATE '2026-03-01' AND baslangic < DATE '2026-03-02'`
? Eşitlik gece yarısını arar; TRUNC doğru sonuç verir ama indeksi kullanamaz.
```

```quiz
`SELECT ... WHERE ROWNUM <= 10 ORDER BY puan DESC` neden en yüksek 10 puanı vermez?
- ROWNUM 0'dan başlar
- [x] ROWNUM sıralamadan önce atanır: rastgele 10 satır alınıp sonra sıralanır
- ORDER BY ile ROWNUM birlikte kullanılamaz
? `ORDER BY puan DESC FETCH FIRST 10 ROWS ONLY` kullan.
```

## Özet

- `''` NULL'dır. `IS NULL` kullan. Alt sorgulu olumsuzlamada `NOT IN` yerine `NOT EXISTS`.
- `VARCHAR2(n CHAR)` ile Türkçe karakterlere yer aç. Türkçe büyük/küçük harf ve sıralama için `NLS_UPPER` / `NLSSORT` ile `XTURKISH`; harf duyarsız arama için `COLLATE BINARY_CI`.
- `NUMBER(p,s)` kesin ondalık; tam sayı bölmesi yok.
- `DATE` saat içerir. Gün filtresi için yarı açık aralık, literal'ler için `DATE '...'`/`TIMESTAMP '...'`. `SYSDATE` sunucu saati, `CURRENT_DATE` oturum saati; UTC sakla.
- 23ai/26ai: `FROM` isteğe bağlı, `GROUP BY` takma adları, `IF [NOT] EXISTS`, `BOOLEAN`, çok satırlı `VALUES`.
- `ROWNUM` yerine `FETCH FIRST`, deterministik `ORDER BY`. DDL örtük commit yapar. Tırnaklı adlar büyük/küçük harf duyarlıdır.
