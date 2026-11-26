# BULK COLLECT, FORALL, trigger'lar ve zamanlanmış işler

PL/SQL bölümünün son dersi üç operasyonel konuyu birleştiriyor: Büyük veri üzerinde PL/SQL'i hızlı çalıştırmak (toplu işleme), veri değiştiğinde otomatik çalışan kod (trigger'lar) ve veritabanının içinden zamanlanmış işler (`DBMS_SCHEDULER`). Üçünde de iyi bilinen tuzaklar var: satır satır döngüler, mutasyon hataları, sessizce çalışmayan ya da yanlış saatte çalışan gece işleri.

## Satır satır, toplu ve saf SQL

Bir özet tablosunu, 182.713 INFO olayından dolduracağız: sunucu adı, zaman ve mesajdan çıkarılan milisaniye. Üç yöntemi aynı veriyle ölçelim:

```sql
CREATE TABLE olay_ozet (olay_id NUMBER PRIMARY KEY, sunucu_ad VARCHAR2(30), zaman TIMESTAMP, sure_ms NUMBER);
SET TIMING ON SERVEROUTPUT ON
```

**1. Satır satır** (row-by-row, "slow-by-slow"):

```sql
BEGIN
  FOR r IN (SELECT o.id, s.ad, o.zaman, o.mesaj
            FROM olaylar o JOIN sunucular s ON s.id = o.sunucu_id
            WHERE o.seviye = 'INFO') LOOP
    INSERT INTO olay_ozet
    VALUES (r.id, r.ad, r.zaman, TO_NUMBER(REGEXP_SUBSTR(r.mesaj, '([0-9]+) ms', 1, 1, NULL, 1)));
  END LOOP;
  COMMIT;
END;
/
-- Elapsed: 00:00:05.04
```

**2. Toplu** (`BULK COLLECT` + `FORALL`):

```sql
TRUNCATE TABLE olay_ozet;
DECLARE
  CURSOR c IS SELECT o.id, s.ad, o.zaman, o.mesaj
              FROM olaylar o JOIN sunucular s ON s.id = o.sunucu_id
              WHERE o.seviye = 'INFO';
  TYPE t_satirlar IS TABLE OF c%ROWTYPE;
  v t_satirlar;
BEGIN
  OPEN c;
  LOOP
    FETCH c BULK COLLECT INTO v LIMIT 1000;
    EXIT WHEN v.COUNT = 0;
    FORALL i IN 1 .. v.COUNT
      INSERT INTO olay_ozet
      VALUES (v(i).id, v(i).ad, v(i).zaman, TO_NUMBER(REGEXP_SUBSTR(v(i).mesaj, '([0-9]+) ms', 1, 1, NULL, 1)));
  END LOOP;
  CLOSE c;
  COMMIT;
END;
/
-- Elapsed: 00:00:01.55
```

**3. Saf SQL:**

```sql
TRUNCATE TABLE olay_ozet;
INSERT INTO olay_ozet
SELECT o.id, s.ad, o.zaman, TO_NUMBER(REGEXP_SUBSTR(o.mesaj, '([0-9]+) ms', 1, 1, NULL, 1))
FROM olaylar o JOIN sunucular s ON s.id = o.sunucu_id
WHERE o.seviye = 'INFO';
COMMIT;
-- 182713 rows created.
-- Elapsed: 00:00:01.16
```

| Yöntem | Süre | Bağlam geçişi |
|---|---|---|
| Satır satır | 5,04 sn | her satırda bir `INSERT` → 182.713 |
| `BULK COLLECT` + `FORALL` | 1,55 sn | 1.000'lik partiler → yaklaşık 183 |
| Tek `INSERT ... SELECT` | 1,16 sn | 1 |

Satır satır döngüde her `INSERT`, PL/SQL motorundan SQL motoruna ayrı bir geçiştir. (Cursor FOR döngüsünün okuma tarafı Oracle tarafından zaten 100'lük partilerle yapılır, bu yüzden fark tamamen yazma tarafındadır.) `FORALL`, bir koleksiyondaki bütün satırları **tek bir** SQL çağrısıyla gönderir. Saf SQL ise hiç geçiş yapmaz, ve optimizer işi bütün olarak planlayabilir (doğrudan yol yükleme, paralellik).

Sıralama her zaman şudur: **Önce tek bir SQL ifadesiyle yapmayı dene.** Satır başına SQL ile ifade edilemeyen karmaşık bir mantık varsa (bir API çağrısı, karmaşık bir karar ağacı), toplu işleme kullan. Satır satır döngü, sadece satır sayısı küçükse kabul edilebilir.

`LIMIT` neden önemli: `LIMIT` olmadan `BULK COLLECT` bütün sonucu tek seferde belleğe (PGA) okur. 182.000 satır sorun değil, 50 milyon satır sunucunun belleğini tüketir ve oturum `ORA-04036: PGA memory used by the instance exceeds PGA_AGGREGATE_LIMIT` ile öldürülür. 100 ile 1.000 arası bir `LIMIT` neredeyse bütün faydayı sağlar.

### SAVE EXCEPTIONS: hatalı satırlarda durmamak

`FORALL` içinde bir satır hata verirse, varsayılan olarak o noktada durur ve **o ifadenin** bütün işi geri alınır. `SAVE EXCEPTIONS` hatalı satırları kaydedip devam eder, sonunda tek bir hata (`ORA-24381`) fırlatır:

```sql
DECLARE
  TYPE t_id IS TABLE OF NUMBER;
  v_ids t_id := t_id(1, 2, 13, 3, 26, 4);   -- 1, 2, 3, 4 olay_ozet'te zaten var
  e_toplu EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_toplu, -24381);
BEGIN
  FORALL i IN 1 .. v_ids.COUNT SAVE EXCEPTIONS
    INSERT INTO olay_ozet (olay_id, sunucu_ad, zaman, sure_ms) VALUES (v_ids(i), 'test', SYSTIMESTAMP, 0);
EXCEPTION
  WHEN e_toplu THEN
    DBMS_OUTPUT.PUT_LINE('başarılı: ' || SQL%ROWCOUNT || ', hatalı: ' || SQL%BULK_EXCEPTIONS.COUNT);
    FOR j IN 1 .. SQL%BULK_EXCEPTIONS.COUNT LOOP
      DBMS_OUTPUT.PUT_LINE('  eleman ' || SQL%BULK_EXCEPTIONS(j).ERROR_INDEX
        || ' (id ' || v_ids(SQL%BULK_EXCEPTIONS(j).ERROR_INDEX) || '): '
        || SQLERRM(-SQL%BULK_EXCEPTIONS(j).ERROR_CODE));
    END LOOP;
END;
/
ROLLBACK;
```

```text
başarılı: 2, hatalı: 4
  eleman 1 (id 1): ORA-00001: unique constraint (.) violated on table . columns ()
  eleman 2 (id 2): ORA-00001: unique constraint (.) violated on table . columns ()
  eleman 4 (id 3): ORA-00001: unique constraint (.) violated on table . columns ()
  eleman 6 (id 4): ORA-00001: unique constraint (.) violated on table . columns ()
```

`ERROR_INDEX`, koleksiyondaki hatalı elemanın sırasını verir; onu kullanarak hatalı **veriyi** loglayabilirsin. Dikkat: `SQLERRM(-kod)` sadece hata numarasının genel mesajını verir, kısıt adı ve sütun gibi ayrıntılar kaybolur. Ayrıntı gerekiyorsa saf SQL'deki `LOG ERRORS` (CTE ve MERGE dersinde) daha zengin bilgi verir.

## Trigger'lar

Trigger, bir tablodaki DML (ya da veritabanı olayları: oturum açma, DDL) sırasında otomatik çalışan PL/SQL'dir.

### Denetim (audit) trigger'ı

Bir sunucunun durumu her değiştiğinde, kimin, hangi araçla değiştirdiğini kaydetmek:

```sql
CREATE TABLE sunucu_gecmis (
  id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sunucu_id  NUMBER NOT NULL,
  zaman      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  eski       VARCHAR2(10),
  yeni       VARCHAR2(10),
  kim        VARCHAR2(128),
  modul      VARCHAR2(64)
);

CREATE OR REPLACE TRIGGER sunucular_durum_trg
AFTER UPDATE OF durum ON sunucular
FOR EACH ROW
WHEN (OLD.durum <> NEW.durum)
BEGIN
  INSERT INTO sunucu_gecmis (sunucu_id, eski, yeni, kim, modul)
  VALUES (:OLD.id, :OLD.durum, :NEW.durum,
          SYS_CONTEXT('USERENV', 'SESSION_USER'), SYS_CONTEXT('USERENV', 'MODULE'));
END;
/

EXEC DBMS_APPLICATION_INFO.SET_MODULE('bakim-betigi', NULL)
UPDATE sunucular SET durum = 'bakimda' WHERE id IN (1, 2);
UPDATE sunucular SET durum = durum WHERE id = 3;           -- değer değişmiyor
SELECT sunucu_id, eski, yeni, kim, modul FROM sunucu_gecmis ORDER BY id;
ROLLBACK;
SELECT COUNT(*) AS gecmis_rollback_sonrasi FROM sunucu_gecmis;
```

```text
 SUNUCU_ID ESKI       YENI       KIM        MODUL
---------- ---------- ---------- ---------- ----------------
         1 calisiyor  bakimda    EGITIM     bakim-betigi
         2 calisiyor  bakimda    EGITIM     bakim-betigi

GECMIS_ROLLBACK_SONRASI
-----------------------
                      0
```

- `AFTER UPDATE OF durum`: Sadece `durum` sütunu güncellendiğinde tetiklenir.
- `FOR EACH ROW`: her satır için bir kez. `:OLD` ve `:NEW` satırın önceki ve yeni değerleri.
- `WHEN (OLD.durum <> NEW.durum)`: Değer gerçekten değişmediyse (sunucu 3) trigger gövdesi hiç çalışmaz. `WHEN` içinde iki nokta üst üste yazılmaz.
- `MODULE` bilgisi, uygulamanın ya da betiğin `DBMS_APPLICATION_INFO` ile kendini tanıtmasına bağlıdır. Bu yüzden her uygulamanın bağlantı açtığında modül adını ayarlaması iyi bir alışkanlıktır: Denetimde, izlemede ve kilit araştırmasında "bu oturum kim?" sorusunun cevabıdır.
- Trigger'ın yazdığı satırlar ana işlemin **parçasıdır**: Ana işlem geri alınınca geçmiş de geri alındı. Denetim için doğru davranış budur: Gerçekleşmemiş bir değişikliğin kaydı olmamalı. (Başarısız girişimleri de kaydetmek istiyorsan, otonom transaction ile yazan bir prosedür çağırırsın.)

Kapsamlı ve değiştirilemez denetim için Oracle'ın yerleşik **Unified Auditing**'i (güvenlik dersinde) trigger'lardan daha güvenilirdir: Trigger'ı tablonun sahibi kapatabilir, denetim politikasını kapatamaz.

### Mutasyon hatası: ORA-04091

İş kuralı: "Bir ekibin son çalışan sunucusu bakıma alınamaz." İlk akla gelen, bir satır trigger'ı içinde aynı tabloyu saymak:

```sql
CREATE OR REPLACE TRIGGER sunucular_son_calisan_trg
BEFORE UPDATE OF durum ON sunucular
FOR EACH ROW
DECLARE
  v_calisan PLS_INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_calisan FROM sunucular
  WHERE ekip_id = :NEW.ekip_id AND durum = 'calisiyor';
  IF :NEW.durum <> 'calisiyor' AND v_calisan <= 1 THEN
    RAISE_APPLICATION_ERROR(-20030, 'ekibin son çalışan sunucusu bakıma alınamaz');
  END IF;
END;
/
UPDATE sunucular SET durum = 'bakimda' WHERE id = 4;
```

```text
ORA-04091: table EGITIM.SUNUCULAR is mutating, trigger/function may not see it
ORA-06512: at "EGITIM.SUNUCULAR_SON_CALISAN_TRG", line 4
ORA-04088: error during execution of trigger 'EGITIM.SUNUCULAR_SON_CALISAN_TRG'
```

Bir satır trigger'ı, değişmekte olan (mutating) tabloyu sorgulayamaz. Çünkü `UPDATE` çok satırlıysa, trigger çalıştığında tablo yarı güncellenmiş bir ara durumdadır ve sorgunun sonucu satırların işlenme sırasına bağlı olurdu. Oracle bu belirsizliği reddeder.

Çözüm, kontrolü **ifade seviyesine**, bütün satırlar güncellendikten sonraya taşımak. **Compound trigger**, satır ve ifade seviyesindeki bölümleri tek bir trigger'da birleştirir ve aralarında durum paylaşır:

```sql
DROP TRIGGER sunucular_son_calisan_trg;
CREATE OR REPLACE TRIGGER sunucular_son_calisan_trg
FOR UPDATE OF durum ON sunucular
COMPOUND TRIGGER
  TYPE t_ekipler IS TABLE OF BOOLEAN INDEX BY PLS_INTEGER;
  g_ekipler t_ekipler;

  AFTER EACH ROW IS
  BEGIN
    g_ekipler(:NEW.ekip_id) := TRUE;           -- hangi ekipler etkilendi?
  END AFTER EACH ROW;

  AFTER STATEMENT IS
    v_e       PLS_INTEGER := g_ekipler.FIRST;
    v_calisan PLS_INTEGER;
  BEGIN
    WHILE v_e IS NOT NULL LOOP                 -- artık tablo tutarlı, sorgulanabilir
      SELECT COUNT(*) INTO v_calisan FROM sunucular WHERE ekip_id = v_e AND durum = 'calisiyor';
      IF v_calisan = 0 THEN
        RAISE_APPLICATION_ERROR(-20030, 'ekip ' || v_e || ' için çalışan sunucu kalmıyor');
      END IF;
      v_e := g_ekipler.NEXT(v_e);
    END LOOP;
  END AFTER STATEMENT;
END sunucular_son_calisan_trg;
/
UPDATE sunucular SET durum = 'bakimda' WHERE id = 4;          -- ekipte başkaları çalışıyor
UPDATE sunucular SET durum = 'bakimda' WHERE ekip_id = 1;     -- ekibin hepsi
ROLLBACK;
```

```text
1 row updated.

ORA-20030: ekip 1 için çalışan sunucu kalmıyor
ORA-06512: at "EGITIM.SUNUCULAR_SON_CALISAN_TRG", line 15
```

Bu trigger bile tam değildir: İki oturum aynı anda aynı ekibin son iki sunucusunu bakıma alırsa, ikisi de commit edilmemiş diğer değişikliği göremez, ikisi de "bir çalışan kalıyor" görür ve ikisi de geçer. Satırlar arası kurallar, eşzamanlılık altında ancak kilitlemeyle (ekip satırını `FOR UPDATE` ile kilitleyerek) garanti edilebilir. Bu da kuralı bir trigger yerine API paketine (önceki ders) koymanın bir sebebidir.

### Trigger'ların maliyeti ve "sihir" sorunu

```sql
CREATE TABLE olay_tetik AS SELECT * FROM olaylar;
CREATE TABLE olay_tetik_log (olay_id NUMBER, zaman TIMESTAMP);
SET TIMING ON
UPDATE olay_tetik SET seviye = seviye;      -- trigger yok
ROLLBACK;

CREATE OR REPLACE TRIGGER olay_tetik_trg AFTER UPDATE ON olay_tetik FOR EACH ROW
BEGIN
  INSERT INTO olay_tetik_log VALUES (:NEW.id, SYSTIMESTAMP);
END;
/
UPDATE olay_tetik SET seviye = seviye;      -- satır trigger'ıyla
ROLLBACK;
```

```text
200000 rows updated.
Elapsed: 00:00:01.30

200000 rows updated.
Elapsed: 00:00:03.81
```

Tek satırlık bir trigger, 200.000 satırlık güncellemeyi **üç kat** yavaşlattı. Toplu işlemleri yavaşlatmanın ötesinde, trigger'ların asıl sorunu **görünmez** olmalarıdır: Bir `UPDATE` yazan geliştirici, arkada başka tablolara yazan, e-posta kuyruğuna iş ekleyen ya da hata fırlatan bir trigger zinciri olduğunu bilmez. Hata ayıklama zorlaşır, ve "basit bir güncelleme neden 10 saniye sürüyor" sorusunun cevabı üç trigger derinliğinde bir yerdedir.

Trigger'lar için makul kullanımlar: denetim ve geçmiş kayıtları, türetilmiş sütunlar (sanal sütun yetmiyorsa), basit varsayılanlar ve veri bütünlüğü kontrolleri. İş süreçleri (sipariş onaylanınca fatura oluştur, e-posta gönder) trigger'larla değil, açıkça çağrılan API'lerle yapılmalı. Toplu yüklemelerde trigger'ları geçici olarak devre dışı bırakmak (`ALTER TRIGGER ... DISABLE`) yaygındır, ama o sırada başka yollardan gelen değişiklikler de denetimsiz kalır: Bunu bir bakım penceresinde ve bilinçli yap.

## Zamanlanmış işler: DBMS_SCHEDULER

Veritabanının kendi iş zamanlayıcısı: cron'a benzer takvimler, iş geçmişi, hata kayıtları, iş zincirleri. Log tablosunu 30 günde bir temizleyen bir prosedür ve onu her gece çalıştıran bir iş:

```sql
CREATE OR REPLACE PROCEDURE log_temizle (p_gun NUMBER DEFAULT 30) AS
BEGIN
  DBMS_APPLICATION_INFO.SET_MODULE('log_temizle', 'siliniyor');
  DELETE FROM uygulama_log WHERE zaman < SYSTIMESTAMP - NUMTODSINTERVAL(p_gun, 'DAY');
  log_pkg.yaz('INFO', 'log_temizle', SQL%ROWCOUNT || ' kayıt silindi');
  COMMIT;
END;
/
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name            => 'LOG_TEMIZLE_IS',
    job_type            => 'STORED_PROCEDURE',
    job_action          => 'LOG_TEMIZLE',
    number_of_arguments => 1,
    repeat_interval     => 'FREQ=DAILY; BYHOUR=3; BYMINUTE=15',
    enabled             => FALSE,
    comments            => 'uygulama_log saklama: 30 gün');
  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE('LOG_TEMIZLE_IS', 1, '30');
  DBMS_SCHEDULER.ENABLE('LOG_TEMIZLE_IS');
END;
/
SELECT job_name, enabled, state, repeat_interval,
       TO_CHAR(next_run_date, 'YYYY-MM-DD HH24:MI TZR') AS next_run
FROM user_scheduler_jobs;
```

```text
JOB_NAME        ENABL STATE      REPEAT_INTERVAL                    NEXT_RUN
--------------- ----- ---------- ---------------------------------- ------------------------
LOG_TEMIZLE_IS  TRUE  SCHEDULED  FREQ=DAILY; BYHOUR=3; BYMINUTE=15  2026-11-26 03:15 PST8PDT
```

Dikkat: `PST8PDT`. İşin saati ABD Pasifik saatine göre hesaplandı.

> **Dikkat:** `start_date` verilmeyen işlerde zamanlayıcı, veritabanının `DEFAULT_TIMEZONE` özelliğini kullanır. Bu imajda (ve birçok kurulumda) bu değer **PST8PDT**'dir. "Her gece 03:15" diye kurulan iş, Türkiye saatiyle 14:15'te, mesai ortasında çalışır. Yoğun saatte büyük bir silme ya da rapor işi kilitlere ve yavaşlığa yol açar, ve sebebi kimsenin aklına gelmez. Her işe zaman dilimi açık bir `start_date` ver:

```sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'TZ_TEST2',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN NULL; END;',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'Europe/Istanbul',
    repeat_interval => 'FREQ=DAILY; BYHOUR=3; BYMINUTE=15',
    enabled         => TRUE);
END;
/
-- NEXT_RUN: 2026-11-27 03:15 EUROPE/ISTANBUL
```

Yönetici yetkisi olan biri varsayılanı da değiştirebilir: `DBMS_SCHEDULER.SET_SCHEDULER_ATTRIBUTE('default_timezone', 'Europe/Istanbul')`. Ama mevcut işler etkilenmez, ve açık `start_date` her zaman daha güvenlidir.

Bir takvim ifadesinin gerçekte ne zaman çalışacağını görmek için:

```sql
DECLARE
  v_sonraki   TIMESTAMP WITH TIME ZONE;
  v_baslangic TIMESTAMP WITH TIME ZONE := SYSTIMESTAMP;
BEGIN
  FOR i IN 1 .. 3 LOOP
    DBMS_SCHEDULER.EVALUATE_CALENDAR_STRING(
      'FREQ=WEEKLY; BYDAY=MON,THU; BYHOUR=2; BYMINUTE=0; BYSECOND=0', NULL, v_baslangic, v_sonraki);
    DBMS_OUTPUT.PUT_LINE(TO_CHAR(v_sonraki, 'YYYY-MM-DD Dy HH24:MI', 'NLS_DATE_LANGUAGE=TURKISH'));
    v_baslangic := v_sonraki;
  END LOOP;
END;
/
```

```text
2026-11-30 Pzt 02:00
2026-12-03 Per 02:00
2026-12-07 Pzt 02:00
```

### Çalıştırmak ve izlemek

```sql
EXEC DBMS_SCHEDULER.RUN_JOB('LOG_TEMIZLE_IS', use_current_session => FALSE)
SELECT job_name, status, run_duration, errors
FROM user_scheduler_job_run_details WHERE job_name = 'LOG_TEMIZLE_IS' ORDER BY log_id;
SELECT kaynak, mesaj FROM uygulama_log WHERE kaynak = 'log_temizle';
```

```text
JOB_NAME        STATUS     RUN_DURATION   ERRORS
--------------- ---------- -------------- ------
LOG_TEMIZLE_IS  SUCCEEDED  +000 00:00:00

KAYNAK       MESAJ
------------ ---------------
log_temizle  0 kayıt silindi
```

`use_current_session => FALSE` işi zamanlayıcının kendi süreçlerinde (`j000` gibi) çalıştırır, tıpkı zamanında çalıştığında olacağı gibi. Böylece yetki ve ortam farkları test sırasında ortaya çıkar.

Başarısız bir iş:

```sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name   => 'BOZUK_IS',
    job_type   => 'PLSQL_BLOCK',
    job_action => 'BEGIN UPDATE sunucular SET durum = ''yok'' WHERE id = 1; END;',
    enabled    => TRUE,
    auto_drop  => TRUE);
END;
/
-- birkaç saniye sonra
SELECT job_name, status, errors FROM user_scheduler_job_run_details WHERE job_name = 'BOZUK_IS';
SELECT COUNT(*) AS hala_var FROM user_scheduler_jobs WHERE job_name = 'BOZUK_IS';
```

```text
JOB_NAME   STATUS   ERRORS
---------- -------- ----------------------------------------------------------
BOZUK_IS   FAILED   ORA-02290: check constraint (EGITIM.SYS_C008940) violated
                    ORA-06512: at line 1

  HALA_VAR
----------
         0
```

Tek seferlik iş başarısız oldu ve `auto_drop` yüzünden **silindi**. Hata sadece çalışma geçmişinde (`USER_SCHEDULER_JOB_RUN_DETAILS`) duruyor, ve geçmiş de bir süre sonra temizlenir (varsayılan 30 gün). İşlerin başarısız olduğunu kimsenin fark etmemesi, zamanlanmış işlerin en yaygın operasyonel sorunudur. Önlemler:

- İş geçmişini izleyen bir kontrol: "Son 24 saatte `FAILED` olan iş var mı?" sorgusu izleme sistemine (Prometheus exporter, Zabbix, ya da düzenli bir rapor) bağlanır.
- Zamanlayıcının e-posta bildirimleri: `DBMS_SCHEDULER.ADD_JOB_EMAIL_NOTIFICATION` (SMTP yapılandırması gerekir).
- Her işin kendi log kaydını yazması (yukarıdaki `log_temizle` gibi), böylece "çalıştı ama 0 kayıt sildi" gibi sessiz anormallikler de görünür.
- Uzun işler için `max_run_duration` ile süre aşımı olayı.

Linux kursundaki cron ve systemd zamanlayıcılarıyla karşılaştırıldığında, `DBMS_SCHEDULER`'ın avantajları: veritabanıyla birlikte yedeklenir ve taşınır, Data Guard geçişinde yeni birincil sunucuda çalışmaya devam eder, ve veritabanı içindeki işler için ayrı bir sunucu ve kimlik bilgisi gerekmez. Dış sistemlere dokunan işler (dosya aktarımı, API çağrıları) için ise cron, Kubernetes CronJob ya da bir iş orkestratörü genellikle daha doğru araçtır.

İşleri temizle:

```sql
EXEC DBMS_SCHEDULER.DROP_JOB('LOG_TEMIZLE_IS')
EXEC DBMS_SCHEDULER.DROP_JOB('TZ_TEST2')
DROP TABLE olay_ozet PURGE;
```

## Alıştırma

1. `sunucu_gecmis` trigger'ını, durumu `bakimda`'ya geçen her sunucu için `uygulama_log`'a da bir `WARN` kaydı yazacak şekilde genişlet. Bunu trigger'da yapmanın bir sakıncası var mı?
2. Her pazartesi 06:00'da (İstanbul saati) geçen haftanın sorunlu deploy sayılarını `gunluk_deploy` benzeri bir rapor tablosuna yazan bir iş tasarla. Hangi parametreleri verirsin, işin başarısız olduğunu nasıl fark edersin?

<details><summary>Çözüm</summary>

1. Trigger gövdesine ekle:

```sql
  IF :NEW.durum = 'bakimda' THEN
    log_pkg.yaz('WARN', 'sunucular_durum_trg', 'sunucu ' || :NEW.id || ' bakıma alındı');
  END IF;
```

Sakıncası: `log_pkg.yaz` otonom transaction ile **hemen commit eder**. Ana `UPDATE` geri alınırsa, `sunucu_gecmis` kaydı geri alınır ama "bakıma alındı" log kaydı kalır: Log, gerçekleşmemiş bir olayı anlatır. Bu bir "girişim" logu olarak bilinçli tasarlanabilir ("bakıma alma denendi"), ama mesaj buna göre yazılmalı. Ayrıca toplu bir güncellemede (yüzlerce sunucu) her satır için ayrı bir otonom transaction ve commit oluşur: yavaş. Kayıt `sunucu_gecmis`'te zaten var, ikinci bir kayda genelde gerek yoktur.

2. Örnek tasarım:

```sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name          => 'HAFTALIK_DEPLOY_RAPORU',
    job_type          => 'STORED_PROCEDURE',
    job_action        => 'RAPOR_PKG.HAFTALIK_DEPLOY',
    start_date        => TIMESTAMP '2026-11-30 06:00:00 Europe/Istanbul',
    repeat_interval   => 'FREQ=WEEKLY; BYDAY=MON; BYHOUR=6; BYMINUTE=0; BYSECOND=0',
    max_run_duration  => INTERVAL '30' MINUTE,
    enabled           => TRUE,
    comments          => 'geçen haftanın sorunlu deployları, sahibi: platform ekibi');
END;
/
```

Zaman dilimi `start_date` içinde açıkça var. Prosedür idempotent olmalı: Raporu `MERGE` ile yazmak, iş iki kez çalışsa ya da elle yeniden çalıştırılsa bile aynı sonucu verir. Hangi haftayı hesapladığını `SYSDATE`'e göre değil, `TRUNC(SYSDATE, 'IW') - 7` gibi açık bir haftaya göre belirlemeli. Bir pazartesi çalışmazsa, salı günü elle çalıştırıldığında yine geçen haftayı hesaplar. Başarısızlığı fark etmek için: İzleme sisteminde `USER_SCHEDULER_JOB_RUN_DETAILS`'e bakan bir kontrol (son çalışma `FAILED` mı, ya da son başarılı çalışma 8 günden eski mi?), ve prosedürün başta ve sonda `log_pkg` ile kayıt yazması. "Rapor tablosunda bu haftanın satırı yok" kontrolü ise işin hiç çalışmadığı (zamanlayıcının durdurulduğu) durumu da yakalar.

</details>

```quiz
`BULK COLLECT INTO v` (LIMIT olmadan) 50 milyon satırlık bir sorguda neden tehlikelidir?
- Yavaştır
- [x] Bütün sonuç oturumun PGA belleğine okunur; bellek tükenir ve oturum PGA_AGGREGATE_LIMIT ile sonlandırılabilir
- 50 milyon satırı desteklemez
? `FETCH ... BULK COLLECT INTO v LIMIT 1000` ile parti parti oku.
```

```quiz
Bir satır trigger'ı (FOR EACH ROW) kendi tablosunu sorgularsa ne olur?
- Güncel değerleri görür
- [x] ORA-04091 (mutating table) hatası
- Eski değerleri görür
? Kontrolü compound trigger'ın AFTER STATEMENT bölümüne taşı, ya da kuralı bir API paketine koy.
```

```quiz
`start_date` verilmeden `FREQ=DAILY; BYHOUR=3` ile oluşturulan bir iş Türkiye'de neden 14:00'te çalışabilir?
- Zamanlayıcı UTC kullanır
- [x] Zaman dilimi zamanlayıcının DEFAULT_TIMEZONE özelliğinden gelir; bu kurulumda PST8PDT idi
- BYHOUR yerel saat değildir
? Her işe `start_date => SYSTIMESTAMP AT TIME ZONE 'Europe/Istanbul'` gibi açık bir zaman dilimi ver.
```

## Özet

- Önce tek SQL; olmuyorsa `BULK COLLECT ... LIMIT` + `FORALL`; satır satır en son. Ölçüm: 5,04 sn → 1,55 sn → 1,16 sn.
- `FORALL ... SAVE EXCEPTIONS` + `SQL%BULK_EXCEPTIONS` ile hatalı satırları atlayıp raporlamak.
- Satır trigger'ları: `:OLD`/`:NEW`, `WHEN` koşulu, `UPDATE OF sütun`. Denetim için iyi; trigger'ın yazdıkları ana işlemle birlikte geri alınır.
- `ORA-04091` mutasyon hatası → compound trigger. Satırlar arası kurallar eşzamanlılıkta kilit gerektirir.
- Trigger'lar DML'i yavaşlatır (burada 3 kat) ve görünmezdir: İş süreçleri için API'ler.
- `DBMS_SCHEDULER`: `start_date` ile zaman dilimini açıkça ver (varsayılan PST8PDT olabilir), `EVALUATE_CALENDAR_STRING` ile takvimi doğrula, `RUN_JOB(..., FALSE)` ile gerçekçi test, `USER_SCHEDULER_JOB_RUN_DETAILS`'i izle. `auto_drop` işleri başarısız olsa da siler.
