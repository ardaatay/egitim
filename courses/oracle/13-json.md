# Oracle'da JSON ve JSON Duality görünümleri

Uygulamalar dünyayı JSON olarak görür: API gövdeleri, webhook'lar, yapılandırmalar, olay yükleri. Bunları ya ayrıştırıp tablolara dağıtırsın (şema değişince göç gerekir), ya da olduğu gibi saklarsın (sorgulamak zorlaşır). Oracle ikisini de iyi yapar: Yerel bir `JSON` tipi, SQL içinden JSON'a yol ifadeleriyle erişim, JSON'u tabloya çeviren `JSON_TABLE`, JSON üreten fonksiyonlar, JSON indeksleri ve 23ai'den beri ilişkisel tabloları **JSON belgesi olarak** okuyup yazmayı sağlayan Duality görünümleri.

## JSON tipi ve örnek veri

Bir CI sisteminin deploy sonrası gönderdiği webhook'ları saklayalım. Veriyi `deploylar` tablosundan üretiyoruz:

```sql
CREATE TABLE ci_olaylari (
  id     NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alindi TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  veri   JSON NOT NULL
);

INSERT INTO ci_olaylari (veri)
SELECT JSON_OBJECT(
  'pipeline' VALUE 1000 + d.id,
  'uygulama' VALUE u.ad,
  'surum'    VALUE d.surum,
  'ortam'    VALUE d.ortam,
  'durum'    VALUE d.durum,
  'commit'   VALUE JSON_OBJECT(
                 'sha'   VALUE SUBSTR(STANDARD_HASH(d.id, 'SHA1'), 1, 8),
                 'yazar' VALUE CASE MOD(d.id, 4) WHEN 0 THEN 'ayse' WHEN 1 THEN 'mehmet'
                                                 WHEN 2 THEN 'zeynep' ELSE 'can' END,
                 'dal'   VALUE CASE WHEN MOD(d.id, 5) = 0 THEN 'hotfix' ELSE 'main' END),
  'adimlar'  VALUE JSON_ARRAY(
                 JSON_OBJECT('ad' VALUE 'build',  'sn' VALUE 60 + MOD(d.id * 7, 120)),
                 JSON_OBJECT('ad' VALUE 'test',   'sn' VALUE 30 + MOD(d.id * 11, 300)),
                 JSON_OBJECT('ad' VALUE 'deploy', 'sn' VALUE d.sure_sn)),
  'etiketler' VALUE CASE WHEN MOD(d.id, 7) = 0 THEN JSON_ARRAY('acil', 'guvenlik')
                         WHEN MOD(d.id, 3) = 0 THEN JSON_ARRAY('rutin')
                         ELSE JSON_ARRAY() END
  RETURNING JSON)
FROM deploylar d JOIN uygulamalar u ON u.id = d.uygulama_id
WHERE d.baslangic >= TIMESTAMP '2026-11-01 00:00:00';
COMMIT;

SELECT JSON_SERIALIZE(veri PRETTY) FROM ci_olaylari WHERE id = 1;
```

```json
{
  "pipeline" : 5864,
  "uygulama" : "api-gateway",
  "surum" : "v5.17.4",
  "ortam" : "staging",
  "durum" : "basarili",
  "commit" : { "sha" : "00192218", "yazar" : "ayse", "dal" : "main" },
  "adimlar" : [
    { "ad" : "build",  "sn" : 148 },
    { "ad" : "test",   "sn" : 134 },
    { "ad" : "deploy", "sn" : 446 }
  ],
  "etiketler" : [ ]
}
```

`JSON` tipi metin olarak değil, Oracle'ın ikili formatı **OSON** ile saklanır: Ekleme sırasında bir kez ayrıştırılır ve doğrulanır, sonra her okumada yeniden ayrıştırılmaz, alanlara doğrudan atlanır. 21c öncesinde JSON, `VARCHAR2`/`CLOB`/`BLOB` sütunlarda `CHECK (veri IS JSON)` kısıtıyla saklanıyordu. Eski şemalarda bu kalıbı görürsün; yeni tablolarda `JSON` tipini kullan.

## JSON'a erişmek

### Nokta gösterimi

```sql
SELECT c.veri.uygulama.string()     AS uygulama,
       c.veri.commit.yazar.string() AS yazar,
       c.veri.adimlar[2].sn.number() AS deploy_sn
FROM ci_olaylari c WHERE c.id <= 3 ORDER BY c.id;
```

```text
UYGULAMA      YAZAR       DEPLOY_SN
------------- ---------- ----------
api-gateway   ayse              446
auth          mehmet            565
odeme-api     zeynep             84
```

Nokta gösterimi **tablo takma adı gerektirir** (`c.veri...`; takma ad olmadan `ORA-00904` alırsın). Dizi indeksleri sıfırdan başlar: `adimlar[2]` üçüncü adımdır. Sondaki `.string()`, `.number()`, `.date()` öğe yöntemleri değeri SQL tipine çevirir. Bunlar olmadan sonuç yine JSON'dur (`"ayse"`, tırnaklarıyla).

### JSON_VALUE ve hata davranışı

`JSON_VALUE` tek bir skaler değer döndürür ve dönüş tipini, eksik ya da hatalı değerde ne olacağını açıkça belirtmeni sağlar:

```sql
SELECT JSON_VALUE(veri, '$.commit.dal') AS dal, COUNT(*) AS adet,
       ROUND(AVG(JSON_VALUE(veri, '$.adimlar[1].sn' RETURNING NUMBER))) AS ort_test_sn
FROM ci_olaylari
GROUP BY JSON_VALUE(veri, '$.commit.dal')
ORDER BY dal;
```

```text
DAL            ADET ORT_TEST_SN
-------- ---------- -----------
hotfix           28         180
main            109         179
```

Varsayılan davranış önemli bir tuzak içerir: **Hata olursa NULL döner.**

```sql
SELECT JSON_VALUE(veri, '$.olmayan' DEFAULT 'yok' ON EMPTY)               AS a FROM ci_olaylari WHERE id = 1;
SELECT JSON_VALUE(veri, '$.uygulama' RETURNING NUMBER)                    AS sessiz FROM ci_olaylari WHERE id = 1;
SELECT JSON_VALUE(veri, '$.uygulama' RETURNING NUMBER ERROR ON ERROR)     AS hatali FROM ci_olaylari WHERE id = 1;
```

```text
A
---
yok

    SESSIZ
----------
                         ← "api-gateway" sayıya çevrilemedi, sessizce NULL

ORA-03302: (ORA-01722 details) invalid string value: api-gateway
ORA-61724: unable to convert value selected by JSON path '$.uygulama'
```

Bir alanın adı yanlış yazıldığında, tipi değiştiğinde ya da üretici sistem formatı değiştirdiğinde, varsayılan davranışla sorgun hata vermez, sadece NULL'lar döner ve raporlar sessizce yanlışlaşır. Veri kalitesinin önemli olduğu yerlerde `ERROR ON ERROR` kullan; eksik alanlar normalse `NULL ON EMPTY` ya da `DEFAULT ... ON EMPTY` ile niyetini açıkça yaz.

### JSON_EXISTS: filtre ifadeleri

```sql
-- "acil" etiketi olanlar
SELECT COUNT(*) AS acil FROM ci_olaylari
WHERE JSON_EXISTS(veri, '$.etiketler?(@ == "acil")');

-- test adımı 300 saniyeden uzun sürenler
SELECT COUNT(*) AS yavas_test FROM ci_olaylari
WHERE JSON_EXISTS(veri, '$.adimlar?(@.ad == "test" && @.sn > 300)');
```

```text
      ACIL
----------
        20

YAVAS_TEST
----------
        82
```

`?( ... )` bir yol filtresidir: `@` o anki öğe, `&&` ve `||` mantıksal işleçler. İkinci sorgu "**aynı** adım nesnesinde hem `ad == "test"` hem `sn > 300`" der. Bunu iki ayrı `JSON_VALUE` ile yazmak, dizinin farklı öğelerini eşleştirebilirdi. Değişkenlerle: `JSON_EXISTS(veri, '$.adimlar?(@.sn > $esik)' PASSING 300 AS "esik")`. Bu, bind değişkeni kullanmanın JSON'daki yoludur.

### JSON_TABLE: JSON'u satırlara çevirmek

İç içe diziler, ilişkisel sorgulamada en zor kısımdır. `JSON_TABLE` bir JSON belgesini sanal bir tabloya çevirir, `NESTED PATH` dizileri satırlara açar:

```sql
SELECT c.id, j.*
FROM ci_olaylari c,
     JSON_TABLE(c.veri, '$'
       COLUMNS (uygulama VARCHAR2(20) PATH '$.uygulama',
                surum    VARCHAR2(10) PATH '$.surum',
                NESTED PATH '$.adimlar[*]'
                  COLUMNS (sira FOR ORDINALITY,
                           adim VARCHAR2(10) PATH '$.ad',
                           sn   NUMBER       PATH '$.sn'))) j
WHERE c.id <= 2
ORDER BY c.id, j.sira;
```

```text
        ID UYGULAMA             SURUM          SIRA ADIM             SN
---------- -------------------- -------- ---------- -------- ----------
         1 api-gateway          v5.17.4           1 build           148
         1 api-gateway          v5.17.4           2 test            134
         1 api-gateway          v5.17.4           3 deploy          446
         2 auth                 v5.17.5           1 build           155
         2 auth                 v5.17.5           2 test            145
         2 auth                 v5.17.5           3 deploy          565
```

Satırlara açılınca normal SQL'in bütün gücü kullanılabilir. Pipeline adımlarının süre dağılımı:

```sql
SELECT j.adim, COUNT(*) AS calisma, ROUND(AVG(j.sn)) AS ort_sn, MAX(j.sn) AS en_uzun
FROM ci_olaylari c,
     JSON_TABLE(c.veri, '$.adimlar[*]'
       COLUMNS (adim VARCHAR2(10) PATH '$.ad', sn NUMBER PATH '$.sn')) j
GROUP BY j.adim
ORDER BY ort_sn DESC;
```

```text
ADIM        CALISMA     ORT_SN    EN_UZUN
-------- ---------- ---------- ----------
deploy          137        331        629
test            137        179        329
build           137        119        179
```

`FROM tablo, JSON_TABLE(tablo.sutun ...)` yazımı aslında bir `LATERAL` join'dir: Her satırın JSON'u ayrı ayrı açılır. Sık sorgulanan bir `JSON_TABLE`'ı bir görünüm (view) olarak tanımlamak, raporlama araçlarına JSON'u düz bir tablo gibi sunmanın pratik yoludur.

## JSON üretmek

API yanıtlarını doğrudan veritabanında üretmek, uygulama katmanında nesne birleştirme döngülerini ve N+1 sorgu sorununu ortadan kaldırır:

```sql
SELECT JSON_SERIALIZE(
  JSON_OBJECT(
    'ekip' VALUE e.ad,
    'sunucular' VALUE (SELECT JSON_ARRAYAGG(JSON_OBJECT('ad' VALUE s.ad, 'cpu' VALUE s.cpu)
                                            ORDER BY s.ad RETURNING JSON)
                       FROM sunucular s
                       WHERE s.ekip_id = e.id AND s.durum <> 'calisiyor')
    RETURNING JSON) PRETTY)
FROM ekipler e WHERE e.id = 2;
```

```json
{
  "ekip" : "odeme",
  "sunucular" : [
    { "ad" : "srv-017", "cpu" : 4 },
    { "ad" : "srv-029", "cpu" : 4 }
  ]
}
```

- `JSON_OBJECT`, `JSON_ARRAY`: nesne ve dizi; `JSON_OBJECTAGG`, `JSON_ARRAYAGG`: satırları toplayarak. `JSON_ARRAYAGG` içindeki `ORDER BY` dizinin sırasını belirler.
- `JSON_OBJECT(*)`: satırın bütün sütunları, sütun adlarıyla: `{"ID":1,"AD":"platform"}`. Hızlı ama adlar büyük harf ve şemaya bağlı; API sözleşmesi için alan adlarını açıkça yaz.
- `RETURNING JSON` iç içe kullanımda önemlidir. Aksi halde iç sonuç bir **metin** olarak döner ve dış nesneye kaçış karakterleriyle gömülür (`"sunucular": "[{\"ad\"..."`).
- `ABSENT ON NULL` (varsayılan `NULL ON NULL`) NULL değerli alanları çıkarır.

## Belgenin bir kısmını değiştirmek: JSON_TRANSFORM

Bütün belgeyi uygulamaya okuyup değiştirip geri yazmak yerine:

```sql
UPDATE ci_olaylari
SET veri = JSON_TRANSFORM(veri,
             SET    '$.inceleme' = 'tamam',
             APPEND '$.etiketler' = 'incelendi',
             REMOVE '$.commit.dal')
WHERE id = 1;
```

```text
{"pipeline":5864,"uygulama":"api-gateway",...,"commit":{"sha":"00192218","yazar":"ayse"},
 ...,"etiketler":["incelendi"],"inceleme":"tamam"}
```

`SET`, `INSERT`, `APPEND`, `REMOVE`, `RENAME`, `KEEP` işlemleri tek bir ifadede zincirlenir. `JSON` tipinde Oracle sadece değişen kısmı yazabilir (kısmi güncelleme); büyük belgelerde redo miktarı ciddi şekilde azalır. Ayrıca iki oturum aynı belgenin **farklı** alanlarını değiştirirken birbirinin değişikliğini ezmez. Oku-değiştir-yaz yaklaşımında son yazan kazanır.

## JSON'u indekslemek

JSON sütun üzerinde filtre yapan bir sorgu, indeks yoksa her satırı okur ve her belgeyi açar. Üç seçenek:

```sql
-- 1) Tek bir skaler alan: fonksiyon tabanlı indeks
CREATE INDEX ci_uygulama_ix ON ci_olaylari (
  JSON_VALUE(veri, '$.uygulama' RETURNING VARCHAR2(40) ERROR ON ERROR NULL ON EMPTY));

-- 2) Dizi içindeki değerler: multivalue indeks (21c+)
CREATE MULTIVALUE INDEX ci_etiket_ix ON ci_olaylari c (c.veri.etiketler.string());

-- 3) Belgenin her yerinde arama: JSON search index
-- CREATE SEARCH INDEX ci_ara_ix ON ci_olaylari (veri) FOR JSON;
```

İndeksin kullanıldığını plandan görelim (execution plan'ları performans bölümünde ayrıntılı işleyeceğiz):

```sql
EXPLAIN PLAN FOR
SELECT COUNT(*) FROM ci_olaylari
WHERE JSON_VALUE(veri, '$.uygulama' RETURNING VARCHAR2(40) ERROR ON ERROR NULL ON EMPTY) = 'auth';
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'BASIC'));

EXPLAIN PLAN FOR
SELECT COUNT(*) FROM ci_olaylari c WHERE JSON_EXISTS(c.veri, '$.etiketler?(@ == "acil")');
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'BASIC'));
```

```text
--------------------------------------------
| Id  | Operation         | Name           |
--------------------------------------------
|   0 | SELECT STATEMENT  |                |
|   1 |  SORT AGGREGATE   |                |
|   2 |   INDEX RANGE SCAN| CI_UYGULAMA_IX |
--------------------------------------------

--------------------------------------------------------
| Id  | Operation                       | Name         |
--------------------------------------------------------
|   0 | SELECT STATEMENT                |              |
|   1 |  SORT AGGREGATE                 |              |
|   2 |   INDEX RANGE SCAN (MULTI VALUE)| CI_ETIKET_IX |
--------------------------------------------------------
```

Fonksiyon tabanlı indeksin kullanılması için sorgudaki ifade, indeksteki ifadeyle **aynı** olmalı (dönüş tipi ve hata maddeleri dahil). Basit bir `JSON_VALUE(veri, '$.uygulama')` (varsayılan `VARCHAR2(4000)` ve `NULL ON ERROR`) bu indeksi kullanmayabilir. Ekipte bunu garanti etmenin yolu, ifadeyi bir görünümde ya da sanal sütunda bir kez tanımlamak: `ALTER TABLE ci_olaylari ADD (uygulama AS (JSON_VALUE(...)))` ve indeksi o sütuna koymak.

### Ne zaman JSON, ne zaman sütun?

- **Sütun:** Sık filtrelenen, join'lenen, kısıt (NOT NULL, FK, CHECK) gerektiren, raporlarda toplanan alanlar. Veritabanı onları doğrular ve optimizer onlar hakkında istatistik tutar.
- **JSON:** Yapısı kaynağa göre değişen, çoğunlukla bütün olarak okunan, nadiren sorgulanan veriler: webhook yükleri, ayarlar, üçüncü parti API yanıtları, denetim kayıtları.
- **Karma** sık görülen en iyi çözümdür: Kimlik, zaman, durum gibi alanlar sütun, geri kalanı bir `JSON` sütunda. "Her şeyi tek bir JSON sütununa koyalım, esnek olur" yaklaşımı genellikle veri kalitesi sorunları ve yavaş sorgularla sonuçlanır.

## JSON Relational Duality görünümleri

23ai'nin en dikkat çekici özelliği. Uygulama verisini JSON belgeleri olarak okumak ve yazmak ister (bir doküman veritabanı gibi), ama veri **normalleştirilmiş tablolarda** durur. Duality görünümü ikisini birleştirir: Aynı veriyi hem tablolar hem belgeler olarak okur ve yazarsın, kopya yoktur.

```sql
CREATE OR REPLACE JSON RELATIONAL DUALITY VIEW ekip_dv AS
  ekipler @insert @update @delete
  {
    _id       : id,
    ad        : ad,
    sunucular : sunucular @insert @update @delete
      [ { sunucuId : id, ad : ad, bolge : bolge, cpu : cpu, bellekGb : bellek_gb, durum : durum } ]
  };
```

Sözdizimi GraphQL'e benzer: Kök tablo (`ekipler`), belgedeki alan adları (`_id`, `ad`) ve iç içe dizi olarak alt tablo (`sunucular`). İlişki, iki tablo arasındaki yabancı anahtardan **çıkarılır**. `@insert @update @delete` hangi işlemlere izin verildiğini belirler. Her belgenin bir `_id` alanı olmalı ve kök tablonun birincil anahtarına eşlenmelidir.

```sql
SELECT JSON_SERIALIZE(JSON_TRANSFORM(d.data, KEEP '$._id', '$.ad', '$._metadata') PRETTY)
FROM ekip_dv d WHERE d.data."_id" = 4;
```

```json
{
  "_id" : 4,
  "_metadata" : { "etag" : "73A20944383493E1DE3ACCB5AF2B9891", "asof" : "000000000023353D" },
  "ad" : "mobil"
}
```

(Okunabilirlik için `KEEP` ile sunucu dizisini çıkardık; tam belge 15 sunucuyu içerir.) `_metadata.etag`, belgenin içeriğinden hesaplanan bir sürüm özetidir.

### Belge olarak yazmak

Yeni bir ekip ve iki sunucusu, tek bir JSON belgesiyle. İlk denemede bir engelle karşılaşırız:

```text
ORA-42692: Cannot insert into JSON Relational Duality View 'EGITIM'.'EKIP_DV':
           Error while inserting into table 'SUNUCULAR'
ORA-32795: cannot insert into a generated always identity column
```

`sunucular.id` sütunu `GENERATED ALWAYS AS IDENTITY` ve Duality görünümü bu sütuna değer yazmaya çalışıyor (belgede `sunucuId` olmasa bile NULL olarak). Duality görünümüyle kullanılacak tablolarda kimlik sütunları `GENERATED BY DEFAULT ON NULL` olmalı: Değer verilmezse (ya da NULL verilirse) sequence'ten üretilir.

```sql
ALTER TABLE sunucular MODIFY id GENERATED BY DEFAULT ON NULL AS IDENTITY;

INSERT INTO ekip_dv VALUES ('{"_id": 5, "ad": "veri", "sunucular": [
  {"ad": "srv-061", "bolge": "ist", "cpu": 32, "bellekGb": 128, "durum": "calisiyor"},
  {"ad": "srv-062", "bolge": "fra", "cpu": 32, "bellekGb": 128, "durum": "calisiyor"}]}');

SELECT id, ad, bolge, ekip_id, TO_CHAR(olusturma, 'YYYY-MM-DD') AS olusturma
FROM sunucular WHERE ekip_id = 5 ORDER BY ad;
```

```text
        ID AD         BOLGE         EKIP_ID OLUSTURMA
---------- ---------- ---------- ---------- ----------
       221 srv-061    ist                 5 2026-11-26
       222 srv-062    fra                 5 2026-11-26
```

Bir belge, iki tabloya üç satır olarak yazıldı. `ekip_id` yabancı anahtarı ilişkiden otomatik dolduruldu, belgede olmayan `olusturma` sütunu varsayılan değerini aldı. Tablo kısıtları (CHECK, NOT NULL, FK) belgeyle yazarken de geçerli: Belgede `"bolge": "ank"` olsaydı ekleme reddedilirdi.

Tersi de çalışır: Tabloyu SQL ile değiştir, belge anında değişir:

```sql
UPDATE sunucular SET durum = 'bakimda' WHERE ad = 'srv-062';
SELECT JSON_SERIALIZE(d.data PRETTY) FROM ekip_dv d WHERE d.data."_id" = 5;
```

```json
{
  "_id" : 5,
  "_metadata" : { "etag" : "5B7EFD5D1C866C22B12E46FC77591F68", "asof" : "000000000023354E" },
  "ad" : "veri",
  "sunucular" : [
    { "sunucuId" : 221, "ad" : "srv-061", "bolge" : "ist", "cpu" : 32, "bellekGb" : 128, "durum" : "calisiyor" },
    { "sunucuId" : 222, "ad" : "srv-062", "bolge" : "fra", "cpu" : 32, "bellekGb" : 128, "durum" : "bakimda" }
  ]
}
```

Belgeden bir sunucuyu çıkarmak, tablodan o satırı **siler** (alt tabloda `@delete` olduğu için):

```sql
UPDATE ekip_dv d
SET d.data = JSON_TRANSFORM(d.data, REMOVE '$.sunucular[*]?(@.ad == "srv-061")')
WHERE d.data."_id" = 5;
SELECT ad, durum FROM sunucular WHERE ekip_id = 5;
-- srv-062  bakimda
```

### ETag ile iyimser kilitleme

Bir REST API'de istemci belgeyi okur, kullanıcı birkaç dakika düzenler, sonra geri gönderir. Bu sırada başka biri belgeyi değiştirmişse? Belgenin içindeki `etag`, okunduğu andaki sürümü taşır. Eski bir etag ile yazma reddedilir:

```sql
UPDATE ekip_dv d
SET d.data = '{"_id": 5, "_metadata": {"etag": "00000000000000000000000000000000"}, "ad": "veri2", "sunucular": []}'
WHERE d.data."_id" = 5;
```

```text
ORA-42699: Cannot update JSON Relational Duality View 'EKIP_DV': The ETAG of document with ID 'FB03C10600'
           in the database did not match the ETAG passed in.
```

Uygulama bunu HTTP `412 Precondition Failed` (ya da `409 Conflict`) olarak istemciye iletir: "Belge siz düzenlerken değişti, yeniden yükleyin." Bu, kilit tutmadan kayıp güncellemeleri (lost update) önlemenin standart yoludur. Etag'i belgeye koymazsan kontrol yapılmaz.

Denemeyi bitirince her şeyi geri al:

```sql
ROLLBACK;
ALTER TABLE sunucular MODIFY id GENERATED ALWAYS AS IDENTITY;
```

### Ne zaman Duality?

Duality görünümleri, belge odaklı çalışan uygulamalar (Node/Java servisleri, MongoDB API'si, ORDS ile REST) ile ilişkisel raporlama ve bütünlük kısıtlarının birlikte gerektiği durumlarda güçlüdür: Aynı veri üzerinde hem uygulama belge olarak çalışır, hem de analitik sorgular ve diğer sistemler tablolarla çalışır. Sınırları da var: Bir belge yapısı bir hiyerarşi olmalı (çoktan çoğa ilişkiler dikkatli tasarım ister). Yabancı anahtar ilişkisi belirsizse (aynı iki tablo arasında birden fazla FK) görünüm oluşturulamaz: Bağımlılık tablomuzda `ORA-42607` alırız, çünkü `bagimliliklar` tablosunun `uygulamalar`'a giden iki FK'sı var. Böyle durumlar için Oracle, birleştirme koşulunu açıkça yazmana izin veren SQL tabanlı bir tanım sözdizimi de sunar.

## Alıştırma

1. `ci_olaylari`'ndan her yazarın deploy sayısını ve bu deploy'lardan kaçının `hotfix` dalından geldiğini bul.
2. Her uygulama için, production'daki deploy'ların ortalama `deploy` adım süresini `JSON_TABLE` ile hesapla. En yavaş 3 uygulamayı getir.
3. Bir API ucu için şu yapıda bir JSON üret: `{"uygulama": "auth", "sonDeploylar": [{"surum": ..., "durum": ...}, ...]}`. Son 3 deploy, yeniden eskiye.

<details><summary>Çözüm</summary>

```sql
SELECT c.veri.commit.yazar.string() AS yazar,
       COUNT(*) AS deploy,
       COUNT(CASE WHEN c.veri.commit.dal.string() = 'hotfix' THEN 1 END) AS hotfix
FROM ci_olaylari c
GROUP BY c.veri.commit.yazar.string()
ORDER BY deploy DESC, yazar;
```

```text
YAZAR          DEPLOY     HOTFIX
---------- ---------- ----------
ayse               35          7
can                34          7
mehmet             34          7
zeynep             34          7
```

```sql
SELECT c.veri.uygulama.string() AS uygulama, ROUND(AVG(j.sn)) AS ort_deploy_sn
FROM ci_olaylari c,
     JSON_TABLE(c.veri, '$.adimlar[*]?(@.ad == "deploy")' COLUMNS (sn NUMBER PATH '$.sn')) j
WHERE c.veri.ortam.string() = 'production'
GROUP BY c.veri.uygulama.string()
ORDER BY ort_deploy_sn DESC FETCH FIRST 3 ROWS ONLY;
```

```text
UYGULAMA      ORT_DEPLOY_SN
------------- -------------
fatura                  395
indeksleyici            381
arama-api               378
```

Yol ifadesindeki filtre (`?(@.ad == "deploy")`), `JSON_TABLE`'ın sadece deploy adımını satıra açmasını sağladı. `WHERE j.adim = 'deploy'` de aynı sonucu verirdi ama önce bütün adımları açardı.

```sql
SELECT JSON_SERIALIZE(
  JSON_OBJECT(
    'uygulama' VALUE u.ad,
    'sonDeploylar' VALUE (
      SELECT JSON_ARRAYAGG(JSON_OBJECT('surum' VALUE surum, 'durum' VALUE durum) ORDER BY baslangic DESC RETURNING JSON)
      FROM (SELECT surum, durum, baslangic FROM deploylar d
            WHERE d.uygulama_id = u.id ORDER BY baslangic DESC FETCH FIRST 3 ROWS ONLY))
    RETURNING JSON) PRETTY) AS j
FROM uygulamalar u WHERE u.ad = 'auth';
```

```json
{
  "uygulama" : "auth",
  "sonDeploylar" : [
    { "surum" : "v5.19.3", "durum" : "basarili" },
    { "surum" : "v5.19.5", "durum" : "basarili" },
    { "surum" : "v5.19.7", "durum" : "basarili" }
  ]
}
```

Sıra doğru: En son deploy v5.19.3. Örnek verideki sürüm numaraları zamanla düzenli artmıyor. Analitik fonksiyonlar dersindeki "en yüksek sürüm, en son sürüm değildir" uyarısının bir örneği daha.

`FETCH FIRST`'ü `JSON_ARRAYAGG`'nin içinde değil, bir alt sorguda yaptık: Toplama fonksiyonları satır sınırlamasını desteklemez, önce satırları sınırla, sonra topla.

</details>

```quiz
`JSON_VALUE(veri, '$.tutar' RETURNING NUMBER)` alan "12,50 TL" gibi bir metin içeriyorsa varsayılan olarak ne döner?
- Hata verir
- [x] NULL: varsayılan NULL ON ERROR, dönüşüm hatası sessizce NULL olur
- 12
? Veri kalitesinin önemli olduğu yerlerde `ERROR ON ERROR` kullan.
```

```quiz
Bir JSON sütunundaki dizinin içinde (örneğin etiketler) değer arayan sorgular için hangi indeks uygundur?
- Normal B-tree indeks
- [x] Multivalue indeks (`CREATE MULTIVALUE INDEX ... (t.veri.dizi.string())`)
- Bitmap indeks
? Tek skaler alanlar için JSON_VALUE üzerinde fonksiyon tabanlı indeks, belgenin her yerinde arama için JSON search index.
```

```quiz
Duality görünümünde `_metadata.etag` ne işe yarar?
- Belgenin ne zaman oluşturulduğunu gösterir
- [x] İyimser kilitleme: eski bir etag ile yapılan güncelleme reddedilir, kayıp güncellemeler önlenir
- Belgeyi şifreler
? Etag belgenin içeriğinden hesaplanır; belge değişince değişir.
```

## Özet

- `JSON` tipi ikili (OSON) saklanır. Eski şemalarda `CLOB ... IS JSON`.
- Erişim: nokta gösterimi (takma ad gerekir), `JSON_VALUE` (dönüş tipi ve `ERROR ON ERROR`), `JSON_EXISTS` (yol filtreleri, `PASSING`), `JSON_QUERY`.
- `JSON_TABLE` ile `NESTED PATH`: dizileri satırlara açar.
- Üretme: `JSON_OBJECT`, `JSON_ARRAYAGG` (`ORDER BY`, iç içe `RETURNING JSON`). Değiştirme: `JSON_TRANSFORM`.
- İndeksler: `JSON_VALUE` üzerinde fonksiyon tabanlı (ifade birebir aynı olmalı), dizi için multivalue, genel arama için search index.
- Karma model: sorgulanan alanlar sütun, değişken yapı JSON.
- Duality görünümleri: aynı veri hem tablo hem belge; FK'dan ilişki çıkarımı, `BY DEFAULT ON NULL` kimlik, etag ile iyimser kilitleme.
