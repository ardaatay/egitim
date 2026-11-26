-- Oracle kursu örnek şeması: ekipler, uygulamalar, sunucular, deploylar, olaylar
-- Çalıştırma: FREEPDB1'deki uygulama kullanıcısıyla (örneğin egitim) bağlanıp bu dosyayı çalıştır.
--   sql egitim/egitim@localhost:1521/FREEPDB1 @ornek-sema.sql
-- Veriler deterministiktir: herkes aynı sonuçları görür.

BEGIN
  FOR t IN (SELECT table_name FROM user_tables
            WHERE table_name IN ('OLAYLAR','DEPLOYLAR','SUNUCULAR','UYGULAMALAR','EKIPLER')) LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS PURGE';
  END LOOP;
END;
/

CREATE TABLE ekipler (
  id  NUMBER       PRIMARY KEY,
  ad  VARCHAR2(30) NOT NULL UNIQUE
);

INSERT INTO ekipler VALUES (1, 'platform'), (2, 'odeme'), (3, 'arama'), (4, 'mobil');

CREATE TABLE uygulamalar (
  id       NUMBER       PRIMARY KEY,
  ad       VARCHAR2(40) NOT NULL UNIQUE,
  ekip_id  NUMBER       NOT NULL REFERENCES ekipler
);

INSERT INTO uygulamalar VALUES
  (1, 'api-gateway', 1), (2, 'auth', 1), (3, 'odeme-api', 2), (4, 'fatura', 2),
  (5, 'arama-api', 3), (6, 'indeksleyici', 3), (7, 'mobil-bff', 4), (8, 'bildirim', 4);

CREATE TABLE sunucular (
  id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ad         VARCHAR2(30) NOT NULL UNIQUE,
  bolge      VARCHAR2(10) NOT NULL CHECK (bolge IN ('ist', 'fra', 'ams')),
  cpu        NUMBER(3)    NOT NULL,
  bellek_gb  NUMBER(4)    NOT NULL,
  durum      VARCHAR2(10) DEFAULT 'calisiyor' NOT NULL
             CHECK (durum IN ('calisiyor', 'bakimda', 'kapali')),
  ekip_id    NUMBER       NOT NULL REFERENCES ekipler,
  olusturma  DATE         DEFAULT SYSDATE NOT NULL
);

INSERT INTO sunucular (ad, bolge, cpu, bellek_gb, durum, ekip_id, olusturma)
SELECT 'srv-' || LPAD(level, 3, '0'),
       CASE MOD(level, 3) WHEN 0 THEN 'ist' WHEN 1 THEN 'fra' ELSE 'ams' END,
       POWER(2, MOD(level, 4) + 1),
       POWER(2, MOD(level, 4) + 3),
       CASE WHEN MOD(level, 17) = 0 THEN 'bakimda'
            WHEN MOD(level, 29) = 0 THEN 'kapali'
            ELSE 'calisiyor' END,
       MOD(level, 4) + 1,
       DATE '2024-01-01' + MOD(level * 37, 700)
FROM dual CONNECT BY level <= 60;

CREATE TABLE deploylar (
  id           NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uygulama_id  NUMBER       NOT NULL REFERENCES uygulamalar,
  sunucu_id    NUMBER       NOT NULL REFERENCES sunucular,
  surum        VARCHAR2(20) NOT NULL,
  ortam        VARCHAR2(12) NOT NULL CHECK (ortam IN ('staging', 'production')),
  baslangic    TIMESTAMP    NOT NULL,
  sure_sn      NUMBER(6)    NOT NULL,
  durum        VARCHAR2(12) NOT NULL CHECK (durum IN ('basarili', 'basarisiz', 'geri_alindi'))
);

INSERT INTO deploylar (uygulama_id, sunucu_id, surum, ortam, baslangic, sure_sn, durum)
SELECT MOD(level, 8) + 1,
       MOD(level * 7, 60) + 1,
       'v' || (1 + TRUNC(level / 1000)) || '.' || MOD(TRUNC(level / 50), 20) || '.' || MOD(level, 10),
       CASE WHEN MOD(level, 3) = 0 THEN 'production' ELSE 'staging' END,
       TIMESTAMP '2026-01-01 00:00:00' + NUMTODSINTERVAL(level * 5400 + MOD(level * 7919, 3600), 'SECOND'),
       30 + MOD(level * 7919, 600),
       CASE WHEN MOD(level, 23) = 0 THEN 'basarisiz'
            WHEN MOD(level, 41) = 0 THEN 'geri_alindi'
            ELSE 'basarili' END
FROM dual CONNECT BY level <= 5000;

CREATE TABLE olaylar (
  id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sunucu_id  NUMBER        NOT NULL REFERENCES sunucular,
  zaman      TIMESTAMP     NOT NULL,
  seviye     VARCHAR2(5)   NOT NULL CHECK (seviye IN ('INFO', 'WARN', 'ERROR')),
  mesaj      VARCHAR2(200) NOT NULL
);

INSERT INTO olaylar (sunucu_id, zaman, seviye, mesaj)
SELECT MOD(level * 13, 60) + 1,
       TIMESTAMP '2026-10-01 00:00:00' + NUMTODSINTERVAL(level * 20, 'SECOND'),
       CASE WHEN MOD(level, 97) = 0 THEN 'ERROR' WHEN MOD(level, 13) = 0 THEN 'WARN' ELSE 'INFO' END,
       CASE WHEN MOD(level, 97) = 0 THEN
              CASE MOD(level, 3) WHEN 0 THEN 'disk dolu: /var/lib/app'
                                 WHEN 1 THEN 'veritabani baglantisi zaman asimi'
                                 ELSE 'OOMKilled: bellek limiti asildi' END
            WHEN MOD(level, 13) = 0 THEN
              CASE MOD(level, 2) WHEN 0 THEN 'yanit suresi 2 sn ustunde' ELSE 'disk kullanimi %85' END
            ELSE 'istek tamamlandi: ' || (100 + MOD(level * 31, 400)) || ' ms' END
FROM dual CONNECT BY level <= 200000;

COMMIT;

CREATE INDEX deploylar_uygulama_ix ON deploylar (uygulama_id);
CREATE INDEX deploylar_sunucu_ix   ON deploylar (sunucu_id);
CREATE INDEX olaylar_sunucu_ix     ON olaylar (sunucu_id);

EXEC DBMS_STATS.GATHER_SCHEMA_STATS(USER);

SELECT 'ekipler' AS tablo, COUNT(*) AS satir FROM ekipler UNION ALL
SELECT 'uygulamalar', COUNT(*) FROM uygulamalar UNION ALL
SELECT 'sunucular',   COUNT(*) FROM sunucular   UNION ALL
SELECT 'deploylar',   COUNT(*) FROM deploylar   UNION ALL
SELECT 'olaylar',     COUNT(*) FROM olaylar;
