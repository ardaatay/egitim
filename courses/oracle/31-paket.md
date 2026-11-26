# Prosedürler, fonksiyonlar ve paketler

Anonim bloklar deneme içindir. Üretim kodu, veritabanında saklanan **adlandırılmış birimlerde** yaşar: prosedürler, fonksiyonlar ve bunları bir araya getiren **paketler**. Bu derste bir deploy API'si yazıyoruz: Uygulamanın tabloları doğrudan değiştirmek yerine çağırdığı, kuralları ve logları tek yerde tutan bir paket. Ardından paketlerin operasyon tarafındaki sorunlarını ele alıyoruz: paket durumu ve deploy sırasında oturumlarda patlayan `ORA-04068`, bağımlılıklar ve geçersiz nesneler, SQL içinden fonksiyon çağırmanın gizli maliyeti.

## Log paketi: otonom transaction

Önce bir log tablosu ve onu yazan bir paket:

```sql
CREATE TABLE uygulama_log (
  id      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zaman   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  seviye  VARCHAR2(5) NOT NULL,
  kaynak  VARCHAR2(60),
  mesaj   VARCHAR2(4000),
  yigin   VARCHAR2(4000),
  oturum  NUMBER DEFAULT SYS_CONTEXT('USERENV', 'SID')
);

CREATE OR REPLACE PACKAGE log_pkg AS
  PROCEDURE yaz (p_seviye VARCHAR2, p_kaynak VARCHAR2, p_mesaj VARCHAR2, p_yigin VARCHAR2 DEFAULT NULL);
  PROCEDURE hata (p_kaynak VARCHAR2);
END log_pkg;
/
CREATE OR REPLACE PACKAGE BODY log_pkg AS
  PROCEDURE yaz (p_seviye VARCHAR2, p_kaynak VARCHAR2, p_mesaj VARCHAR2, p_yigin VARCHAR2 DEFAULT NULL) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO uygulama_log (seviye, kaynak, mesaj, yigin)
    VALUES (p_seviye, p_kaynak, SUBSTR(p_mesaj, 1, 4000), SUBSTR(p_yigin, 1, 4000));
    COMMIT;
  END yaz;

  PROCEDURE hata (p_kaynak VARCHAR2) IS
  BEGIN
    yaz('ERROR', p_kaynak, SQLERRM, DBMS_UTILITY.FORMAT_ERROR_BACKTRACE);
  END hata;
END log_pkg;
/
```

Bir paketin iki parçası var:

- **Spec (belirtim):** Dışarıya açık arayüz: hangi prosedürler, fonksiyonlar, tipler, sabitler. Çağıranlar sadece buna bağımlıdır.
- **Body (gövde):** Uygulama ve özel (private) yardımcılar. Spec'te olmayan her şey paketin dışından görünmez.

`PRAGMA AUTONOMOUS_TRANSACTION`, `yaz` prosedürünü çağıranın transaction'ından **bağımsız** bir transaction'da çalıştırır. Kendi `COMMIT`'i sadece log satırını kalıcı yapar, çağıranın yarım işini değil. Çağıran daha sonra hata alıp `ROLLBACK` yapsa bile log kaydı kalır. Hata loglamanın tam olarak istediği budur: "Bu işlem neden başarısız oldu?" sorusunun cevabı, işlemle birlikte geri alınmamalı.

> **Dikkat:** Otonom transaction'ı log dışında kullanmak (örneğin bir fonksiyonun içinden veri değiştirmek için) neredeyse her zaman bir tasarım hatasıdır: Ana işlem geri alınır ama otonom değişiklik kalır, ve veri tutarsızlaşır. Otonom transaction ana transaction'ın commit edilmemiş verisini de göremez, ve aynı satırları kilitlemeye çalışırsa kendi ana oturumunu bekler: bir **kendi kendine deadlock**.

## Deploy API paketi

```sql
CREATE OR REPLACE PACKAGE deploy_api AS
  e_sunucu_uygun_degil CONSTANT PLS_INTEGER := -20010;
  e_deploy_yok         CONSTANT PLS_INTEGER := -20011;
  e_gecersiz_gecis     CONSTANT PLS_INTEGER := -20012;

  FUNCTION baslat (p_uygulama IN VARCHAR2, p_sunucu IN VARCHAR2, p_surum IN VARCHAR2,
                   p_ortam IN VARCHAR2 DEFAULT 'staging') RETURN deploylar.id%TYPE;
  PROCEDURE bitir (p_id IN deploylar.id%TYPE, p_durum IN VARCHAR2, p_sure_sn IN NUMBER);
END deploy_api;
/
CREATE OR REPLACE PACKAGE BODY deploy_api AS

  -- özel yardımcı: spec'te yok, dışarıdan çağrılamaz
  FUNCTION sunucu_bul (p_ad VARCHAR2) RETURN sunucular%ROWTYPE IS
    v sunucular%ROWTYPE;
  BEGIN
    SELECT * INTO v FROM sunucular WHERE ad = p_ad FOR UPDATE;
    RETURN v;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    RAISE_APPLICATION_ERROR(e_sunucu_uygun_degil, 'sunucu yok: ' || p_ad);
  END sunucu_bul;

  FUNCTION baslat (p_uygulama IN VARCHAR2, p_sunucu IN VARCHAR2, p_surum IN VARCHAR2,
                   p_ortam IN VARCHAR2 DEFAULT 'staging') RETURN deploylar.id%TYPE IS
    v_s  sunucular%ROWTYPE;
    v_u  uygulamalar.id%TYPE;
    v_id deploylar.id%TYPE;
  BEGIN
    v_s := sunucu_bul(p_sunucu);
    IF v_s.durum <> 'calisiyor' THEN
      RAISE_APPLICATION_ERROR(e_sunucu_uygun_degil, p_sunucu || ' durumu ' || v_s.durum);
    END IF;
    SELECT id INTO v_u FROM uygulamalar WHERE ad = p_uygulama;
    INSERT INTO deploylar (uygulama_id, sunucu_id, surum, ortam, baslangic, sure_sn, durum)
    VALUES (v_u, v_s.id, p_surum, p_ortam, SYSTIMESTAMP, 0, 'basarili')
    RETURNING id INTO v_id;
    log_pkg.yaz('INFO', 'deploy_api.baslat',
                p_uygulama || ' ' || p_surum || ' -> ' || p_sunucu || ' (id ' || v_id || ')');
    RETURN v_id;
  EXCEPTION
    WHEN OTHERS THEN
      log_pkg.hata('deploy_api.baslat');
      RAISE;
  END baslat;

  PROCEDURE bitir (p_id IN deploylar.id%TYPE, p_durum IN VARCHAR2, p_sure_sn IN NUMBER) IS
  BEGIN
    IF p_durum NOT IN ('basarili', 'basarisiz', 'geri_alindi') THEN
      RAISE_APPLICATION_ERROR(e_gecersiz_gecis, 'gecersiz durum: ' || p_durum);
    END IF;
    UPDATE deploylar SET durum = p_durum, sure_sn = p_sure_sn WHERE id = p_id;
    IF SQL%ROWCOUNT = 0 THEN
      RAISE_APPLICATION_ERROR(e_deploy_yok, 'deploy yok: ' || p_id);
    END IF;
  END bitir;

END deploy_api;
/
```

Kullanalım:

```sql
SET SERVEROUTPUT ON
VARIABLE id NUMBER
EXEC :id := deploy_api.baslat('auth', 'srv-002', 'v6.0.0')
EXEC deploy_api.bitir(:id, 'basarili', 95)
SELECT id, surum, durum, sure_sn FROM deploylar WHERE id = :id;

EXEC :id := deploy_api.baslat('auth', 'srv-017', 'v6.0.1')     -- bakımdaki sunucu
EXEC deploy_api.bitir(999999, 'basarili', 10)                  -- olmayan deploy
ROLLBACK;

SELECT seviye, kaynak, mesaj FROM uygulama_log ORDER BY id;
SELECT yigin FROM uygulama_log WHERE seviye = 'ERROR';
```

```text
        ID SURUM    DURUM           SURE_SN
---------- -------- ------------ ----------
     22261 v6.0.0   basarili             95

ORA-20010: srv-017 durumu bakimda
ORA-06512: at "EGITIM.DEPLOY_API", line 30
ORA-06512: at "EGITIM.DEPLOY_API", line 19

ORA-20011: deploy yok: 999999
ORA-06512: at "EGITIM.DEPLOY_API", line 40

Rollback complete.

SEVIY KAYNAK              MESAJ
----- ------------------- ------------------------------------
INFO  deploy_api.baslat   auth v6.0.0 -> srv-002 (id 22261)
ERROR deploy_api.baslat   ORA-20010: srv-017 durumu bakimda

YIGIN
-------------------------------------------
ORA-06512: at "EGITIM.DEPLOY_API", line 19
```

`ROLLBACK`, 22261 numaralı deploy'u geri aldı. Ama iki log satırı da kaldı (otonom transaction). Hata kaydının yığını, hatanın paketin 19. satırında (`RAISE_APPLICATION_ERROR` satırı) oluştuğunu söylüyor.

Bu tasarımın faydaları:

- **Tek giriş noktası:** Uygulama (`node-oracledb`, JDBC) sadece `deploy_api.baslat` çağırır. Durum kuralı, kilitleme (`FOR UPDATE`), loglama her çağıranda aynıdır. Bir toplu iş ya da başka bir servis de aynı kuralları atlatamaz.
- **Yetki:** Uygulama kullanıcısına tablolarda `INSERT`/`UPDATE` yetkisi vermek yerine sadece `EXECUTE ON deploy_api` verilebilir. Paket, sahibinin yetkileriyle çalışır (definer's rights, varsayılan). Güvenlik dersinde bu kalıba döneceğiz.
- **Tek gidiş-dönüş:** Dört SQL ifadesi (sunucuyu kilitle, uygulamayı bul, ekle, logla) uygulama ile veritabanı arasında tek bir ağ çağrısında çalışır. Uzak bir veritabanında her gidiş-dönüş 1–2 ms ise bu fark yoğun yük altında önemlidir.

Bedeli de var: İş mantığı iki yerde (uygulama ve veritabanı) bölünür, PL/SQL kodu sürüm kontrolüne ve test hattına uygulama kodu kadar dikkatle alınmalıdır. Migration'lar dersinde bunu konuşacağız.

### Parametre modları

- `IN` (varsayılan): salt okunur.
- `OUT`: Prosedür bir değer döndürür. Çağrının başında `NULL`'dır.
- `IN OUT`: hem okunur hem yazılır.
- `NOCOPY` ipucu: Büyük koleksiyonları ve LOB'ları kopyalamadan referansla geçirir. Hızlıdır, ama prosedür hata verirse çağıranın değişkeni yarı değiştirilmiş kalabilir.

Uygulama tarafından çağrılan API'lerde fonksiyon ya da `OUT` parametreli prosedür tercihi çoğu zaman sürücünün kolaylığına göre yapılır. SQL içinden çağrılacaksa (sonraki bölüm) fonksiyon olmalıdır ve veri değiştirmemelidir.

## Derleme uyarıları

PL/SQL derleyicisi, potansiyel hatalar için uyarı verebilir. Geliştirme ortamında açık tut:

```sql
ALTER SESSION SET PLSQL_WARNINGS = 'ENABLE:ALL';
CREATE OR REPLACE PROCEDURE yutan AS
BEGIN
  DELETE FROM nobetler WHERE id = -1;
EXCEPTION WHEN OTHERS THEN NULL;
END;
/
SHOW ERRORS PROCEDURE yutan
```

```text
SP2-0804: Procedure created with compilation warnings

LINE/COL ERROR
-------- -----------------------------------------------------------------
1/1      PLW-05018: unit YUTAN omitted optional AUTHID clause; default value DEFINER used
4/16     PLW-06009: procedure "YUTAN" OTHERS handler does not end in RAISE or RAISE_APPLICATION_ERROR
```

`PLW-06009` bir önceki dersteki "hatayı yutma" kalıbını yakalıyor. CI hattında uyarıları hataya çevirmek mümkündür: `ALTER SESSION SET PLSQL_WARNINGS = 'ERROR:06009'`. Böylece bu kalıp hiçbir zaman derlenmez.

## Bağımlılıklar ve geçersiz nesneler

Oracle, her PL/SQL biriminin hangi nesnelere bağımlı olduğunu izler:

```sql
SELECT name, type, referenced_name, referenced_type
FROM user_dependencies
WHERE name = 'DEPLOY_API' AND referenced_owner = 'EGITIM'
ORDER BY 1, 2, 3;
```

```text
NAME         TYPE          REFERENCED_NAME  REFERENCED_TYPE
------------ ------------- ---------------- ---------------
DEPLOY_API   PACKAGE       DEPLOYLAR        TABLE
DEPLOY_API   PACKAGE BODY  DEPLOYLAR        TABLE
DEPLOY_API   PACKAGE BODY  DEPLOY_API       PACKAGE
DEPLOY_API   PACKAGE BODY  LOG_PKG          PACKAGE
DEPLOY_API   PACKAGE BODY  SUNUCULAR        TABLE
DEPLOY_API   PACKAGE BODY  UYGULAMALAR      TABLE
```

Spec, sadece `deploylar.id%TYPE` kullandığı için `DEPLOYLAR`'a bağımlı. Body, kullandığı her tabloya ve pakete. Bağımlı olunan bir nesne değişince bağımlı olan **geçersiz** (INVALID) olabilir:

```sql
ALTER TABLE uygulamalar RENAME COLUMN ad TO adi;
SELECT object_name, object_type, status FROM user_objects
WHERE object_name IN ('LOG_PKG', 'DEPLOY_API') ORDER BY 1, 2;
EXEC :id := deploy_api.baslat('auth', 'srv-002', 'v6.0.2')
SELECT line, position, text FROM user_errors WHERE name = 'DEPLOY_API' ORDER BY sequence;
```

```text
OBJECT_NAME  OBJECT_TYPE   STATUS
------------ ------------- -------
DEPLOY_API   PACKAGE       VALID
DEPLOY_API   PACKAGE BODY  INVALID
LOG_PKG      PACKAGE       VALID
LOG_PKG      PACKAGE BODY  VALID

ORA-04063: package body "EGITIM.DEPLOY_API" has errors
ORA-06508: PL/SQL: could not find program unit being called: "EGITIM.DEPLOY_API"

      LINE   POSITION TEXT
---------- ---------- -------------------------------------------
        21         47 PL/SQL: ORA-00904: "AD": invalid identifier
        21          5 PL/SQL: SQL Statement ignored
```

Body geçersiz oldu ve ilk çağrıda Oracle onu yeniden derlemeyi denedi. Sütun artık yok, derleme başarısız, çağrı `ORA-04063` ile patladı. **Spec geçerli kaldı**: Spec'e bağımlı olan diğer birimler etkilenmedi. Paketlerin spec ve body olarak ayrılmasının en önemli faydası budur: Body'deki değişiklikler (ya da body'nin bağımlılıklarındaki değişiklikler) çağıranları geçersiz kılmaz.

Sütunu geri adlandırınca:

```sql
ALTER TABLE uygulamalar RENAME COLUMN adi TO ad;
EXEC :id := deploy_api.baslat('auth', 'srv-002', 'v6.0.3')    -- başarılı: otomatik yeniden derlendi
ROLLBACK;
```

Body, bir sonraki çağrıda **otomatik olarak** yeniden derlendi ve geçerli hale geldi. Oracle'ın ince taneli bağımlılık takibi (11g+) gereksiz geçersizleştirmeleri de azaltır: Tabloya ilgisiz bir sütun eklemek, o tabloyu kullanan ama `SELECT *` ya da `%ROWTYPE` kullanmayan kodu geçersiz kılmaz.

Operasyonel kural: Bir migration'dan (tablo değişikliği) sonra geçersiz nesneleri kontrol et ve **hemen** derle. İlk kullanıcının çağrısını derleme yapmaya, ya da hata almaya bırakma:

```sql
SELECT object_name, object_type FROM user_objects WHERE status = 'INVALID';
EXEC DBMS_UTILITY.COMPILE_SCHEMA(schema => USER, compile_all => FALSE)
```

Yoğun bir sistemde, sık çağrılan bir paketin aynı anda yüzlerce oturum tarafından yeniden derlenmeye çalışılması kilitlere (`library cache pin` beklemeleri) yol açar. Bu yüzden PL/SQL deploy'ları genellikle düşük trafikte yapılır ya da Edition-Based Redefinition kullanılır (aşağıda).

## Paket durumu ve ORA-04068

Paket gövdesinde, herhangi bir prosedürün dışında tanımlanan değişkenler **oturum boyunca** yaşar. Bu, bir önbellek ya da sayaç için kullanışlıdır:

```sql
CREATE OR REPLACE PACKAGE sayac_pkg AS
  PROCEDURE artir;
END sayac_pkg;
/
CREATE OR REPLACE PACKAGE BODY sayac_pkg AS
  g_sayi PLS_INTEGER := 0;              -- paket durumu: oturuma özel, oturum boyunca
  PROCEDURE artir IS
  BEGIN
    g_sayi := g_sayi + 1;
    DBMS_OUTPUT.PUT_LINE('sayac: ' || g_sayi);
  END artir;
END sayac_pkg;
/
```

Şimdi bir **deploy** senaryosu: A oturumu (bir uygulama sunucusunun havuzdaki bağlantısı) paketi kullanıyor. Bu sırada B oturumu yeni sürümü derliyor:

```sql
-- A oturumu
EXEC sayac_pkg.artir        -- sayac: 1
EXEC sayac_pkg.artir        -- sayac: 2

-- B oturumu
CREATE OR REPLACE PACKAGE BODY sayac_pkg AS ... 'sayac (v2): ' ... END sayac_pkg;
/

-- A oturumu
EXEC sayac_pkg.artir
EXEC sayac_pkg.artir
```

```text
ORA-04068: existing state of packages has been discarded
ORA-04061: existing state of package body "EGITIM.SAYAC_PKG" has been invalidated
ORA-04065: not executed, altered or dropped package body "EGITIM.SAYAC_PKG"
ORA-06508: PL/SQL: could not find program unit being called: "EGITIM.SAYAC_PKG"

PL/SQL procedure successfully completed.
```

A'nın ilk çağrısı **hata verdi**: Oturumun paket durumu (`g_sayi = 2`) yeni koda ait değil, Oracle onu atmak zorunda ve bunu çağırana bildiriyor. İkinci çağrı başarılı oldu, durum sıfırdan başladı. Dikkat: İkinci çağrının `DBMS_OUTPUT` çıktısı da görünmedi. `ORA-04068` oturumdaki **bütün** paket durumlarını sıfırlar, `DBMS_OUTPUT`'un "açık" bilgisi dahil.

Üretimdeki etkisi: Bağlantı havuzundaki her bağlantı, deploy'dan sonra o paketi ilk kez çağırdığında bir kez `ORA-04068` alır. 200 bağlantılı bir havuzda bu, deploy anında 200 başarısız istek demektir. Çözümler:

- **Paketleri durumsuz tasarla.** Gövdede global değişken yoksa (sabitler hariç), yeniden derleme `ORA-04068`'e yol açmaz. Aynı senaryoyu durumsuz bir paketle denedik: Yeniden derlemeden sonra A'nın çağrısı sorunsuz çalıştı. Önbellek gerekiyorsa `RESULT_CACHE` fonksiyonları ya da bir tablo.
- **Uygulamada yeniden dene:** `ORA-04068` yakalanırsa çağrıyı bir kez tekrarla. Durum zaten sıfırlanmıştır, ikinci deneme yeni kodla çalışır.
- **Edition-Based Redefinition (EBR):** Yeni kod ayrı bir **edition**'da derlenir; mevcut oturumlar eski edition'da çalışmaya devam eder, yeni oturumlar yenisini kullanır. Sıfır kesintili PL/SQL deploy'u bunun üzerine kurulur, ama şema tasarımında hazırlık ister (editioning view'lar).

## SQL içinden fonksiyon çağırmak

PL/SQL fonksiyonları SQL içinde kullanılabilir. Ama her çağrı, SQL motorundan PL/SQL motoruna bir **bağlam geçişi** (context switch) demektir. Ölçelim: Olay mesajlarından milisaniye değerini çıkarıp toplamak, 1 milyon satır üzerinde (200.000 olay × 5):

```sql
SET TIMING ON
-- saf SQL
SELECT SUM(TO_NUMBER(REGEXP_SUBSTR(mesaj, '([0-9]+) ms', 1, 1, NULL, 1))) AS toplam
FROM olaylar o1, (SELECT 1 FROM dual CONNECT BY level <= 5);

-- aynı ifade bir PL/SQL fonksiyonunda
CREATE OR REPLACE FUNCTION mesaj_ms (p VARCHAR2) RETURN NUMBER IS
BEGIN
  RETURN TO_NUMBER(REGEXP_SUBSTR(p, '([0-9]+) ms', 1, 1, NULL, 1));
END;
/
SELECT SUM(mesaj_ms(mesaj)) AS toplam FROM olaylar o1, (SELECT 1 FROM dual CONNECT BY level <= 5);
```

```text
    TOPLAM
----------
 273637270
Elapsed: 00:00:03.62      ← saf SQL

    TOPLAM
----------
 273637270
Elapsed: 00:00:04.66      ← PL/SQL fonksiyonu
```

Bir milyon bağlam geçişi yaklaşık bir saniye, yani %28 ek maliyet. `PRAGMA UDF` (fonksiyonu SQL'den çağrılmak üzere derler) ve 12c'nin `WITH FUNCTION` (fonksiyonu sorgunun içinde tanımlar) bu maliyeti azaltmak için var. Bu testte ikisi de belirgin bir fark yaratmadı (4,59 ve 4,21 saniye), çünkü süreyi `REGEXP_SUBSTR`'nin kendisi belirliyor. Basit aritmetik yapan fonksiyonlarda kazanç daha büyüktür.

Asıl tehlike, **içinde SQL çalıştıran** fonksiyonlar:

```sql
CREATE OR REPLACE FUNCTION sunucu_adi (p_id NUMBER) RETURN VARCHAR2 IS
  v sunucular.ad%TYPE;
BEGIN
  SELECT ad INTO v FROM sunucular WHERE id = p_id;
  RETURN v;
END;
/
SELECT COUNT(DISTINCT sunucu_adi(sunucu_id)) AS fonksiyonla FROM olaylar;
SELECT COUNT(DISTINCT s.ad) AS joinle FROM olaylar o JOIN sunucular s ON s.id = o.sunucu_id;
```

```text
FONKSIYONLA
-----------
         60
Elapsed: 00:00:01.41

    JOINLE
----------
         60
Elapsed: 00:00:00.01
```

**140 kat** fark. Fonksiyon her satır için ayrı bir sorgu çalıştırdı: 200.000 sorgu. Optimizer fonksiyonun içini göremez, bu yüzden onu bir join'e çeviremez, satır sayısını tahmin edemez ve paralelleştiremez. Bu, ORM'lerdeki N+1 sorununun veritabanı içindeki karşılığıdır.

İkinci, daha sinsi bir sorun da var: **Tutarlılık.** Dış sorgu başladığı anın görüntüsünü görür (okuma tutarlılığı), ama fonksiyonun içindeki her sorgu **kendi** başladığı anın görüntüsünü görür. Sorgu çalışırken başka biri `sunucular`'ı değiştirirse, aynı sonuç kümesinin ilk satırları eski, son satırları yeni adları gösterir. Bir join'de bu asla olmaz.

Kurallar:

- Arama (lookup) fonksiyonu yerine join yaz. Tekrar kullanmak istiyorsan bir **görünüm** (view) tanımla, fonksiyon değil.
- SQL'den çağrılan fonksiyonlar saf hesaplama yapsın (biçimlendirme, dönüşüm), sorgu çalıştırmasın.
- Aynı girdiye her zaman aynı sonucu veren fonksiyonları `DETERMINISTIC` işaretle, Oracle tekrarlanan değerler için sonucu önbelleğe alabilir. Nadiren değişen tablolardan okuyan fonksiyonlar için `RESULT_CACHE`: Sonuç, oturumlar arasında paylaşılan bir önbellekte tutulur ve tablo değişince otomatik geçersizleşir.

## Definer ve invoker hakları

Varsayılan olarak bir paket, **sahibinin** yetkileriyle çalışır (`AUTHID DEFINER`): `deploy_api`'yi çağıran kullanıcının `deploylar` tablosunda yetkisi olmasa bile paket ona yazabilir. API kalıbının güvenlik faydası budur: Kullanıcıya tabloyu değil, işlemi verirsin.

`AUTHID CURRENT_USER` (invoker's rights) ise paketi **çağıranın** yetkileriyle çalıştırır. Nesne adları da çağıranın şemasında çözümlenir. Birçok şemada aynı işi yapan yardımcı araçlar (bir rapor üreticisi, bir bakım betiği) için kullanılır.

Definer's rights paketlerin bir güvenlik sorumluluğu var: Paket, sahibinin bütün yetkilerini kullanabilir. İçinde dinamik SQL ve enjeksiyon açığı olan bir definer paketi, çağıranın sahip olmadığı yetkileri kullanmasına izin verir. Önceki dersteki enjeksiyon örneği, yüksek yetkili bir şemada bir paketin içinde olsaydı, çok daha tehlikeli olurdu.

## Alıştırma

1. `deploy_api`'ye `geri_al(p_id)` prosedürü ekle: Sadece `basarili` durumundaki bir deploy geri alınabilir, durumu `geri_alindi` olur ve bir INFO logu yazılır. Başka durumdaki bir deploy için `e_gecersiz_gecis` hatası fırlat.
2. Bir paketin gövdesinde `g_son_okuma DATE` adında bir global değişken var ve bir önbellek için kullanılıyor. Ekibin her deploy'dan sonra "bazı istekler bir kez hata veriyor" şikâyeti ne olabilir, ve iki çözüm öner.

<details><summary>Çözüm</summary>

Spec'e ekle:

```sql
  PROCEDURE geri_al (p_id IN deploylar.id%TYPE);
```

Body'ye ekle:

```sql
  PROCEDURE geri_al (p_id IN deploylar.id%TYPE) IS
    v_durum deploylar.durum%TYPE;
  BEGIN
    SELECT durum INTO v_durum FROM deploylar WHERE id = p_id FOR UPDATE;
    IF v_durum <> 'basarili' THEN
      RAISE_APPLICATION_ERROR(e_gecersiz_gecis, 'deploy ' || p_id || ' ' || v_durum || ', geri alınamaz');
    END IF;
    UPDATE deploylar SET durum = 'geri_alindi' WHERE id = p_id;
    log_pkg.yaz('INFO', 'deploy_api.geri_al', 'deploy ' || p_id || ' geri alındı');
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE_APPLICATION_ERROR(e_deploy_yok, 'deploy yok: ' || p_id);
  END geri_al;
```

```sql
EXEC deploy_api.geri_al(5000)
EXEC deploy_api.geri_al(5000)
ROLLBACK;
```

```text
PL/SQL procedure successfully completed.

ORA-20012: deploy 5000 geri_alindi, geri alınamaz
ORA-06512: at "EGITIM.DEPLOY_API", line 46
```

İkinci çağrı, durum artık `geri_alindi` olduğu için reddedildi. `FOR UPDATE`, iki eşzamanlı geri alma isteğinin ikisinin de kontrolü geçmesini önler.

2. Paket durumu: Her deploy'da paket gövdesi yeniden derlenince, bağlantı havuzundaki her oturumun bu pakete ilk çağrısı `ORA-04068` alır. Çözümler: (a) Önbelleği paket değişkeninden çıkarıp `RESULT_CACHE` bir fonksiyona ya da bir tabloya taşımak (paket durumsuz olur). (b) Uygulamanın veritabanı katmanında `ORA-04068`'i yakalayıp çağrıyı bir kez yeniden denemek. (c) Uzun vadede Edition-Based Redefinition ile deploy.

</details>

```quiz
PRAGMA AUTONOMOUS_TRANSACTION ile yazan bir log prosedürünün çağıranı daha sonra ROLLBACK yaparsa ne olur?
- Log kaydı da geri alınır
- [x] Log kaydı kalır; otonom transaction kendi COMMIT'iyle bağımsız olarak kalıcı olmuştur
- Hata verir
? Bu yüzden hata loglamada kullanılır; veri değiştirmek için kullanmak tutarsızlık yaratır.
```

```quiz
Bir paket gövdesini yeniden derlemek, o paketi kullanan oturumlarda ne zaman ORA-04068'e yol açar?
- Her zaman
- [x] Paket gövdesinde oturum boyu yaşayan global değişkenler (paket durumu) varsa
- Sadece spec değişirse
? Durumsuz paketler yeniden derlemeden etkilenmez; sıfır kesinti için EBR.
```

```quiz
`SELECT f(sutun) FROM buyuk_tablo` sorgusunda f içinde bir SELECT çalıştırıyorsa sorun nedir?
- Sorun yok, Oracle önbelleğe alır
- [x] Her satır için ayrı sorgu çalışır (N+1), optimizer içini göremez, ve iç sorgular dış sorguyla aynı anın görüntüsünü görmez
- Fonksiyonlar SQL'de kullanılamaz
? Join ya da view kullan.
```

## Özet

- Paket = spec (arayüz) + body (uygulama). Spec değişmedikçe body değişiklikleri çağıranları geçersiz kılmaz.
- API paketi kalıbı: tek giriş noktası, kurallar ve kilitleme tek yerde, `EXECUTE` yetkisiyle tablolara doğrudan erişimsiz kullanım.
- Otonom transaction: log için doğru, veri değişikliği için yanlış.
- `PLSQL_WARNINGS` ile `PLW-06009` gibi uyarılar; CI'da hataya çevir.
- `USER_DEPENDENCIES`, `INVALID` nesneler, `ORA-04063`. Migration sonrası `COMPILE_SCHEMA`.
- Paket durumu → deploy'da `ORA-04068`. Durumsuz tasarım, yeniden deneme, EBR.
- SQL'den fonksiyon: bağlam geçişi maliyeti (`PRAGMA UDF`, `WITH FUNCTION`). İçinde SQL olan fonksiyon N+1 ve tutarlılık sorunudur; join/view kullan. `DETERMINISTIC`, `RESULT_CACHE`.
- `AUTHID DEFINER` (varsayılan) ve `CURRENT_USER`; definer paketlerinde enjeksiyon daha tehlikelidir.
