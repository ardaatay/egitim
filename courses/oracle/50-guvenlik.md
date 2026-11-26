# Kullanıcılar, roller, yetkiler ve denetim

Bir veritabanı sızıntısı genellikle karmaşık bir saldırıyla değil, gereğinden fazla yetkiyle olur: Uygulama şema sahibi kullanıcıyla bağlanır, bir enjeksiyon açığı bütün tabloları açar; ya da bir rapor kullanıcısının `SELECT ANY TABLE` yetkisi vardır. Bu derste en az yetki ilkesini Oracle'da uygulamayı ele alıyoruz: Şema sahibi ile uygulama kullanıcısını ayırmak, rolleri, `READ` ile `SELECT` farkını, 23ai'nin şema yetkilerini, parola politikalarını, birleşik denetimi (unified auditing) ve satır seviyesinde erişim kontrolünü (VPD). Bu dersteki komutlar `system` olarak çalıştırılır (`docker exec -it ora-egitim sqlplus system/<parola>@FREEPDB1`).

## Şema sahibi ile uygulama kullanıcısı ayrı olmalı

Şimdiye kadar her şeyi `egitim` kullanıcısıyla yaptık: Tabloların sahibi o. Bir uygulama bu kullanıcıyla bağlanırsa, uygulamadaki tek bir açık bütün tabloları silebilir (`DROP TABLE`), kısıtları kaldırabilir, ve denetim kayıtlarında kimin ne yaptığı ayırt edilemez. Doğru yapı:

| Hesap | Ne yapar | Ne yapamaz |
|---|---|---|
| **Şema sahibi** (`egitim`) | Nesneleri oluşturur, migration'ları çalıştırır | Uygulama tarafından kullanılmaz. İdeal olarak parolasızdır (aşağıda) |
| **Uygulama kullanıcısı** (`api_kul`) | Sadece verilen paketleri çağırır / tabloları okur-yazar | DDL yapamaz, verilmeyen tablolara erişemez |
| **Rapor kullanıcısı** (`raporcu`) | Belirli tabloları okur | Yazamaz, kilitleyemez |

```sql
CREATE ROLE deploy_api_rol;
GRANT EXECUTE ON egitim.deploy_api TO deploy_api_rol;

CREATE USER api_kul IDENTIFIED BY "Api_Parola_2026";
GRANT CREATE SESSION TO api_kul;
GRANT deploy_api_rol TO api_kul;

CREATE ROLE rapor_rol;
GRANT READ ON egitim.deploylar TO rapor_rol;
GRANT READ ON egitim.uygulamalar TO rapor_rol;

CREATE USER raporcu IDENTIFIED BY "Rapor_Parola_2026";
GRANT CREATE SESSION, rapor_rol TO raporcu;
```

Yetkileri doğrudan kullanıcılara değil **rollere** ver, kullanıcılara rolleri ver. Yeni bir uygulama sunucusu ya da yeni bir rapor kullanıcısı eklemek bir `GRANT rol TO kullanici` kadar basit olur, ve "bu kullanıcı neye erişebilir?" sorusunun cevabı rol tanımlarına bakılarak verilir.

Şimdi `api_kul` olarak bağlanıp deneyelim:

```sql
CONNECT api_kul/Api_Parola_2026@FREEPDB1
SELECT COUNT(*) FROM egitim.deploylar;
UPDATE egitim.sunucular SET durum = 'kapali' WHERE id = 1;
VARIABLE id NUMBER
EXEC :id := egitim.deploy_api.baslat('auth', 'srv-002', 'v7.0.0')
PRINT id
ROLLBACK;
```

```text
ORA-00942: table or view "EGITIM"."DEPLOYLAR" does not exist
ORA-00942: table or view "EGITIM"."SUNUCULAR" does not exist

PL/SQL procedure successfully completed.

        ID
----------
    244501
```

Uygulama kullanıcısı tabloları **göremiyor**, ama paketi çağırarak deploy kaydı oluşturabiliyor. Paket, sahibinin (`egitim`) yetkileriyle çalışıyor (definer's rights, paketler dersi). Böylece uygulama sadece paketin izin verdiği işlemleri, paketin kurallarıyla yapabilir: Durum kontrolü atlatılamaz, log yazılmadan deploy açılamaz. Bu kullanıcıyla bir SQL enjeksiyonu bulunsa bile saldırgan tablolara doğrudan erişemez.

Yetkisi olmayan nesne için Oracle'ın "yetkin yok" değil "tablo yok" (`ORA-00942`) demesi bilinçli bir tasarımdır: Yetkisiz kullanıcıya nesnelerin varlığı bile gösterilmez.

### READ ve SELECT farkı

```sql
CONNECT raporcu/Rapor_Parola_2026@FREEPDB1
SELECT COUNT(*) FROM egitim.deploylar;
SELECT id FROM egitim.deploylar WHERE id = 1 FOR UPDATE;
LOCK TABLE egitim.deploylar IN EXCLUSIVE MODE;
```

```text
  COUNT(*)
----------
      5000

ORA-41900: missing SELECT privilege on "EGITIM"."DEPLOYLAR"
ORA-41900: missing LOCK privilege on "EGITIM"."DEPLOYLAR"
```

`SELECT` yetkisi, okumanın yanında `SELECT ... FOR UPDATE` ve `LOCK TABLE` ile **satırları kilitlemeye** de izin verir. Salt okuma amaçlı bir kullanıcı (bir rapor aracı, bir BI sistemi), yanlışlıkla ya da kötü niyetle tabloyu kilitleyip üretimdeki bütün yazmaları durdurabilir. 12c'den beri gelen `READ` yetkisi sadece okumaya izin verir. Rapor ve izleme kullanıcıları için her zaman `READ` ver. (26ai, bu durum için daha açıklayıcı `ORA-41900` hatasını getirdi.)

### 23ai: şema seviyesinde yetkiler

Bir rapor kullanıcısının bir şemadaki **bütün** tabloları okuması gerekiyorsa, eskiden iki kötü seçenek vardı: Her tablo için ayrı `GRANT` (yeni tablo eklendikçe unutulur), ya da `SELECT ANY TABLE` (veritabanındaki **bütün şemalar**, sistem tabloları dahil). 23ai'den beri:

```sql
CONNECT system/...@FREEPDB1
GRANT READ ANY TABLE ON SCHEMA egitim TO raporcu;

CONNECT raporcu/Rapor_Parola_2026@FREEPDB1
SELECT COUNT(*) FROM egitim.sunucular;    -- 60
SELECT COUNT(*) FROM egitim.olaylar;      -- 200000
```

Yetki sadece `egitim` şemasını kapsar ve şemaya ileride eklenecek tablolar için de geçerlidir. `ANY` yetkileri (`SELECT ANY TABLE`, `EXECUTE ANY PROCEDURE`, `DROP ANY TABLE`) uygulama kullanıcılarına asla verilmemelidir. Mevcut bir veritabanında kimin `ANY` yetkisi olduğunu kontrol et:

```sql
SELECT grantee, privilege FROM dba_sys_privs
WHERE privilege LIKE '%ANY%' AND grantee NOT IN (SELECT role FROM dba_roles WHERE oracle_maintained = 'Y')
  AND grantee NOT IN (SELECT username FROM dba_users WHERE oracle_maintained = 'Y')
ORDER BY grantee, privilege;
```

Geri al: `REVOKE READ ANY TABLE ON SCHEMA egitim FROM raporcu;`

### Parolasız şema sahibi

Şema sahibinin bir parolası varsa, o parola bir yerde (bir CI değişkeni, bir migration aracının yapılandırması, bir geliştiricinin bilgisayarı) durur ve sızabilir. 18c'den beri şema sahibi **kimlik doğrulamasız** (schema-only) olabilir:

```sql
ALTER USER egitim NO AUTHENTICATION;
```

Bu kullanıcıyla artık doğrudan bağlanılamaz. Migration'lar ve bakım, yetkili bir yöneticinin **proxy** olarak bağlanmasıyla yapılır: `GRANT CONNECT THROUGH` ile yetkilendirilen bir yönetici, kendi parolasıyla bağlanıp şema sahibi gibi çalışır (`CONNECT yonetici[egitim]/parola@...`). Denetim kayıtlarında hem proxy kullanıcı hem şema sahibi görünür. Bu kursta `egitim`'i parolalı bırakıyoruz, ama üretimde önerilen yapı budur.

## Parola politikaları: profile

```sql
CREATE PROFILE uygulama_prof LIMIT
  FAILED_LOGIN_ATTEMPTS 3
  PASSWORD_LOCK_TIME 1/24          -- 1 saat
  PASSWORD_LIFE_TIME UNLIMITED;
ALTER USER api_kul PROFILE uygulama_prof;
```

Üç yanlış parola denemesi:

```sql
CONNECT api_kul/yanlis1@FREEPDB1
CONNECT api_kul/yanlis2@FREEPDB1
CONNECT api_kul/yanlis3@FREEPDB1
CONNECT api_kul/Api_Parola_2026@FREEPDB1     -- doğru parola
```

```text
ORA-01017: invalid credential or not authorized; logon denied
ORA-01017: invalid credential or not authorized; logon denied
ORA-01017: invalid credential or not authorized; logon denied
ORA-28000: The account is locked; login denied.

USERNAME       ACCOUNT_STATUS   LOCK_DATE
-------------- ---------------- ------------------
API_KUL        LOCKED(TIMED)    26-NOV-26
```

Dördüncü denemede doğru parola bile reddedildi: Hesap bir saatliğine kilitlendi (`LOCKED(TIMED)`). Bu, kaba kuvvet saldırılarına karşı korur, ama bir **operasyon riskidir**: Parolası değiştirilmiş ama yapılandırması güncellenmemiş tek bir uygulama sunucusu, eski parolayla tekrar tekrar denedikçe hesabı kilitler ve **bütün** uygulama sunucuları bağlanamaz hale gelir. Bu yüzden:

- Uygulama hesapları için `FAILED_LOGIN_ATTEMPTS` genellikle daha yüksek tutulur (örneğin 10) ve `PASSWORD_LOCK_TIME` kısa tutulur. Uygulama hesapları ve insan hesapları **farklı profiller** kullanır.
- Parola değişikliği sıfır kesintiyle yapılmalı: 21c'den beri `PASSWORD_ROLLOVER_TIME` profili ayarı, belirtilen süre boyunca hem eski hem yeni parolanın geçerli olmasını sağlar. Uygulama sunucuları sırayla güncellenir.
- Bir kilitlenme olayında önce **kim** deniyor bul (aşağıdaki denetim kaydında `ORA-01017` dönen girişler ve istemci makinesi), sonra kilidi aç: `ALTER USER api_kul ACCOUNT UNLOCK;`

Oracle, ardışık başarısız girişlerde yanıtı kademeli olarak **geciktirir** (birkaç saniyeye kadar). Bu test sırasında da başarısız denemelerin her biri giderek daha uzun sürdü. Kaba kuvvet saldırılarını yavaşlatan ama bir uygulamanın bağlantı havuzunu da yavaşlatabilecek bir özellik.

Parolalar uygulamada düz metin olarak değil, bir gizli bilgi yöneticisinde (Kubernetes Secret, Vault, bulut sağlayıcının secret manager'ı) tutulur. Kubernetes kursundaki gizli bilgi yönetimi burada da geçerli. Oracle tarafında bir seçenek de, parolayı istemci tarafında şifreli bir **wallet**'ta tutmaktır (`mkstore`, `sqlnet.ora`'da `WALLET_LOCATION`). Uygulama `/@baglanti_adi` ile parola yazmadan bağlanır.

## Birleşik denetim (Unified Auditing)

Kim, ne zaman, hangi tabloyu değiştirdi? Başarısız giriş denemeleri nereden geliyor? 12c'den beri Oracle'ın denetim sistemi, politika tabanlı **birleşik denetim**dir (yönetmek için `AUDIT_ADMIN` rolü gerekir):

```sql
CREATE AUDIT POLICY sunucu_degisiklik_pol
  ACTIONS UPDATE ON egitim.sunucular, DELETE ON egitim.sunucular;
AUDIT POLICY sunucu_degisiklik_pol;

CREATE AUDIT POLICY basarisiz_giris_pol ACTIONS LOGON;
AUDIT POLICY basarisiz_giris_pol WHENEVER NOT SUCCESSFUL;
```

Bir değişiklik ve bir başarısız giriş:

```sql
CONNECT egitim/egitim@FREEPDB1
UPDATE sunucular SET durum = 'bakimda' WHERE id = 9;
ROLLBACK;
CONNECT raporcu/yanlis_parola@FREEPDB1

CONNECT system/...@FREEPDB1
SELECT TO_CHAR(event_timestamp, 'HH24:MI:SS') AS zaman, dbusername, action_name, object_name,
       return_code, client_program_name AS program, SUBSTR(sql_text, 1, 50) AS sql_text
FROM unified_audit_trail
WHERE unified_audit_policies IN ('SUNUCU_DEGISIKLIK_POL', 'BASARISIZ_GIRIS_POL')
  AND event_timestamp > SYSTIMESTAMP - INTERVAL '5' MINUTE
ORDER BY event_timestamp;
```

```text
ZAMAN    DBUSERNAME  ACTION_NAME  OBJECT_NAME  RETURN_CODE PROGRAM                            SQL_TEXT
-------- ----------- ------------ ------------ ----------- ---------------------------------- -----------------------------------------
09:08:10 EGITIM      UPDATE       SUNUCULAR              0 sqlplus@25042c39184c (TNS V1-V3)   UPDATE sunucular SET durum = 'bakimda' WHERE id =
09:08:31 RAPORCU     LOGON                            1017 sqlplus@25042c39184c (TNS V1-V3)
```

İki ayrıntı önemli:

- `UPDATE` geri alındı (`ROLLBACK`), ama denetim kaydı **kaldı**. Denetim, trigger tabanlı geçmiş tablolarının aksine, girişimleri de kaydeder ve ana transaction'dan bağımsızdır.
- Başarısız girişin `RETURN_CODE`'u `1017`: yanlış parola. Hesap kilitleme olaylarında hangi makineden hangi programın denediği buradan bulunur (`USERHOST`, `CLIENT_PROGRAM_NAME`, `OS_USERNAME` sütunları).

Denetimin kendisini tablo sahibi kapatamaz (trigger'ların aksine). Kayıtlar `AUDSYS` şemasında, sadece denetim yöneticilerinin erişebildiği bir yerde tutulur. Denetim kaydı büyür: `DBMS_AUDIT_MGMT` ile saklama süresi ve temizleme işi tanımlanır, ve kayıtlar genellikle merkezi bir log sistemine (SIEM) aktarılır. Hangi işlemleri denetleyeceğini seç: Her `SELECT`'i denetlemek büyük bir yük ve gürültüdür. Tipik bir politika: başarısız girişler, yetki değişiklikleri (`GRANT`, `REVOKE`, `ALTER USER`), DDL, ve hassas tablolardaki değişiklikler. Oracle'ın hazır `ORA_SECURECONFIG` ve `ORA_LOGON_FAILURES` politikaları iyi bir başlangıçtır.

Temizlik:

```sql
NOAUDIT POLICY sunucu_degisiklik_pol;
NOAUDIT POLICY basarisiz_giris_pol;
DROP AUDIT POLICY sunucu_degisiklik_pol;
DROP AUDIT POLICY basarisiz_giris_pol;
```

(`DROP AUDIT POLICY IF EXISTS` ve `DROP PROFILE IF EXISTS` çalışmaz: `IF [NOT] EXISTS` her DDL için desteklenmez, `ORA-11600` verir.)

## Satır seviyesinde güvenlik: VPD

Bazen bir kullanıcının tabloyu görmesi yeterli değildir: **Hangi satırları** gördüğü de kısıtlanmalıdır. Örneğin bir ekip panelinde her ekip sadece kendi sunucularını görmeli. Bunu her sorguya `WHERE ekip_id = :benim_ekibim` yazarak yapmak, unutulan tek bir sorguyla delinir. **Virtual Private Database** (VPD, `DBMS_RLS`), bir tabloya yapılan **her** sorguya otomatik olarak bir koşul ekler:

```sql
GRANT READ ON egitim.sunucular TO raporcu;

CREATE OR REPLACE FUNCTION egitim.ekip_filtresi (p_sema VARCHAR2, p_nesne VARCHAR2) RETURN VARCHAR2 AS
BEGIN
  IF SYS_CONTEXT('USERENV', 'SESSION_USER') = 'EGITIM' THEN
    RETURN NULL;                                 -- şema sahibi her şeyi görür
  END IF;
  RETURN 'ekip_id = TO_NUMBER(SYS_CONTEXT(''USERENV'', ''CLIENT_IDENTIFIER'') DEFAULT NULL ON CONVERSION ERROR)';
END;
/
BEGIN
  DBMS_RLS.ADD_POLICY(
    object_schema   => 'EGITIM',  object_name     => 'SUNUCULAR',
    policy_name     => 'EKIP_SATIR_POL',
    function_schema => 'EGITIM',  policy_function => 'EKIP_FILTRESI',
    statement_types => 'SELECT');
END;
/
```

Uygulama, kullanıcının ekibini bağlantıya bir **istemci kimliği** olarak yazar (giriş yapmış kullanıcının bilgisinden, uygulama tarafında):

```sql
CONNECT raporcu/Rapor_Parola_2026@FREEPDB1
SELECT COUNT(*) AS kimlik_yok FROM egitim.sunucular;

EXEC DBMS_SESSION.SET_IDENTIFIER('2')
SELECT ekip_id, COUNT(*) FROM egitim.sunucular GROUP BY ekip_id;

EXEC DBMS_SESSION.SET_IDENTIFIER('4')
SELECT ekip_id, COUNT(*) FROM egitim.sunucular GROUP BY ekip_id;

EXEC DBMS_SESSION.SET_IDENTIFIER('4 OR 1=1')
SELECT COUNT(*) AS enjeksiyon_denemesi FROM egitim.sunucular;
```

```text
KIMLIK_YOK
----------
         0          ← kimlik yoksa hiçbir satır

   EKIP_ID   COUNT(*)
---------- ----------
         2         15

   EKIP_ID   COUNT(*)
---------- ----------
         4         15

ENJEKSIYON_DENEMESI
-------------------
                  0
```

Aynı sorgu (`SELECT ... FROM egitim.sunucular`), istemci kimliğine göre farklı satırlar döndürdü. Sorguda hiçbir `WHERE` koşulu yok: Oracle onu sorgu ayrıştırılırken kendisi ekledi. Kimlik olmadan hiçbir satır görünmüyor (güvenli varsayılan). Kimliğe bir enjeksiyon denemesi koymak da işe yaramadı: Fonksiyon kimliği bir sayıya çeviriyor ve çevrilemezse NULL kullanıyor (`DEFAULT NULL ON CONVERSION ERROR`). Koşul metni sabit, değer `SYS_CONTEXT` ile çalışma anında okunuyor, yani birleştirme yok.

VPD hakkında bilmen gerekenler:

- İstemci kimliği oturum seviyesindedir. **Bağlantı havuzlarında** her istek başında doğru kimlik ayarlanmalı, istek sonunda temizlenmelidir (`DBMS_SESSION.CLEAR_IDENTIFIER`). Aksi halde bir kullanıcının isteği, havuzdan aynı bağlantıyı alan önceki kullanıcının kimliğiyle çalışır. Daha sağlam bir yöntem, değerleri bir uygulama bağlamına (`CREATE CONTEXT ... USING paket`) sadece güvenilir bir paket üzerinden yazmaktır. Böylece istemci kendi kimliğini doğrudan değiştiremez.
- Politika fonksiyonu her ayrıştırmada çalışır. Basit ve hızlı olmalı, koşulun kullandığı sütunlar indekslenmeli.
- VPD, Enterprise Edition'ın bir özelliğidir (ek lisans gerektirmez). 23ai'nin yeni **SQL Firewall** özelliği ve Database Vault gibi araçlar ise yetkili kullanıcıların bile beklenmeyen SQL çalıştırmasını engellemek için kullanılır.

Temizlik:

```sql
CONNECT system/...@FREEPDB1
EXEC DBMS_RLS.DROP_POLICY('EGITIM', 'SUNUCULAR', 'EKIP_SATIR_POL')
DROP FUNCTION egitim.ekip_filtresi;
```

## Ağ ve veri şifreleme

- **Ağ şifrelemesi:** Uygulama ile veritabanı arasındaki trafik varsayılan olarak **şifresizdir**: Parola el sıkışması korunur, ama sorgular ve sonuçlar ağda düz metindir. İki seçenek var: Oracle'ın yerel ağ şifrelemesi (`sqlnet.ora`'da `SQLNET.ENCRYPTION_SERVER = REQUIRED`, 12c'den beri her sürümde ücretsiz), ya da TLS (`TCPS` protokolü, sertifikalarla, 23ai'de kurulumu kolaylaştırılmış). Bir oturumun durumu:

```sql
SELECT network_service_banner FROM v$session_connect_info WHERE sid = SYS_CONTEXT('USERENV', 'SID');
SELECT SYS_CONTEXT('USERENV', 'NETWORK_PROTOCOL') AS protokol FROM dual;
```

```text
NETWORK_SERVICE_BANNER
------------------------------------------------------------------
TCP/IP NT Protocol Adapter for Linux: Version 23.26.4.0.0 - Production
Encryption service for Linux: Version 23.26.4.0.0 - Production
Crypto-checksumming service for Linux: Version 23.26.4.0.0 - Production

PROTOKOL
--------
tcp
```

  Şifreleme **etkin** olsaydı, listede "AES256 Encryption service adapter" gibi kullanılan algoritmayı gösteren bir satır olurdu. Burada sadece servislerin yüklü olduğu görünüyor, kullanılan bir algoritma yok, ve protokol `tcp` (TLS olsaydı `tcps`). Bu bağlantı şifresiz. Üretimde, özellikle veritabanı ile uygulama farklı ağlardaysa (bulut, farklı veri merkezleri), şifrelemeyi zorunlu tut.

- **Saklanan verinin şifrelenmesi (TDE):** Datafile'ların, yedeklerin ve redo log'ların diskte şifrelenmesi. Diskler ya da yedek bantları çalınırsa veri okunamaz. Advanced Security seçeneğinin parçasıdır (EE'de ayrı lisans; Oracle Cloud'da varsayılan olarak açık).
- **Data Redaction:** Sorgu sonuçlarında hassas sütunları maskeleme (kart numarasının son 4 hanesi). O da Advanced Security'nin parçasıdır. Lisans yoksa, maskelenmiş değerleri döndüren görünümler ve görünümlere `READ` yetkisi basit bir alternatiftir.

## Alıştırma

1. `izleme_kul` adında, sadece `egitim.sunucular` ve `egitim.deploylar` tablolarını okuyabilen, kilitleyemeyen, ve 5 yanlış denemede 10 dakika kilitlenen bir kullanıcı oluştur. Yetkileri bir rol üzerinden ver.
2. Bir uygulama ekibi, "uygulama kullanıcımız tablolara doğrudan `INSERT` yapabilmeli, paket kullanmak istemiyoruz" diyor. Hangi riskleri anlatırsın, hangi orta yolu önerirsin?
3. Mevcut bir veritabanında `DBA` rolüne sahip ve Oracle'a ait olmayan kullanıcıları listele.

<details><summary>Çözüm</summary>

```sql
CREATE ROLE izleme_rol;
GRANT READ ON egitim.sunucular TO izleme_rol;
GRANT READ ON egitim.deploylar TO izleme_rol;
CREATE PROFILE izleme_prof LIMIT FAILED_LOGIN_ATTEMPTS 5 PASSWORD_LOCK_TIME 10/1440;
CREATE USER izleme_kul IDENTIFIED BY "Izleme_Parola_2026" PROFILE izleme_prof;
GRANT CREATE SESSION, izleme_rol TO izleme_kul;
```

`10/1440` = 10 dakika (gün cinsinden). `READ` olduğu için `FOR UPDATE` ve `LOCK TABLE` reddedilir.

2. Riskler: Kuralların (durum kontrolü, kilitleme sırası, log) uygulama kodunda olması, başka bir yazma yolunun (toplu iş, başka servis, elle düzeltme) onları atlatabilmesi demektir. Bir enjeksiyon açığı tablolara doğrudan yazmaya izin verir. Denetimde hangi işlemin hangi kuralla yapıldığı ayırt edilemez. Orta yol: Uygulama kullanıcısına sadece gereken tablolarda gereken yetkileri ver (`INSERT ON deploylar`, `SELECT/UPDATE (durum) ON sunucular`; sütun seviyesinde `UPDATE` yetkisi mümkündür), asla şema sahibiyle bağlanma, kritik kuralları kısıtlarla (CHECK, FK, benzersiz indeks) veritabanında garanti et, ve hassas tablolarda denetim politikası aç. DDL yetkisi hiçbir zaman verilmez.

3.

```sql
SELECT grantee FROM dba_role_privs
WHERE granted_role = 'DBA'
  AND grantee NOT IN (SELECT username FROM dba_users WHERE oracle_maintained = 'Y')
ORDER BY grantee;
```

```text
no rows selected
```

Bu veritabanında `DBA` rolü sadece Oracle'ın kendi hesaplarında (`SYS`, `SYSTEM`) var; `ANY` yetki sorgusu da boş döndü.

Bu listede bir uygulama hesabı ya da kişisel bir hesap görmek, düzeltilmesi gereken bir bulgudur. `DBA` rolü sadece yöneticilere, mümkünse kişisel hesaplar üzerinden ve denetimle birlikte verilir.

</details>

```quiz
Bir uygulamanın şema sahibi kullanıcıyla (tabloların sahibi) bağlanmasının en büyük riski?
- Daha yavaş çalışır
- [x] Uygulamadaki bir açık (enjeksiyon) bütün tabloları silme, kısıtları kaldırma ve her veriyi okuma yetkisi verir
- Bağlantı sayısı sınırlanır
? Uygulama için ayrı, sadece gereken yetkilere sahip bir kullanıcı kullan.
```

```quiz
Rapor kullanıcısına neden `SELECT` yerine `READ` yetkisi verilmelidir?
- READ daha hızlıdır
- [x] SELECT, FOR UPDATE ve LOCK TABLE ile satırları/tabloyu kilitlemeye de izin verir; READ sadece okumaya izin verir
- SELECT 23ai'de kaldırıldı
? Salt okuma kullanıcısı yanlışlıkla üretimdeki yazmaları durduramamalı.
```

```quiz
Uygulama hesabında FAILED_LOGIN_ATTEMPTS = 3 olmasının operasyonel riski?
- Hiçbir risk yoktur
- [x] Eski parolayla deneyen tek bir sunucu hesabı kilitler ve bütün uygulama sunucuları bağlanamaz hale gelir
- Parola süresi dolar
? Uygulama ve insan hesapları için farklı profiller; parola değişiminde PASSWORD_ROLLOVER_TIME.
```

## Özet

- Şema sahibi, uygulama kullanıcısı ve rapor kullanıcısı ayrı. Yetkiler rollere, roller kullanıcılara. Şema sahibi parolasız (`NO AUTHENTICATION`) + proxy.
- API paketi + `EXECUTE` yetkisi: uygulama tabloları göremez, sadece kurallı işlemleri yapar.
- Rapor kullanıcılarına `READ` (kilitleyemez). 23ai: `GRANT ... ON SCHEMA`. `ANY` yetkilerinden kaçın.
- Profiller: başarısız giriş kilidi, uygulama ve insan hesapları için farklı değerler, `PASSWORD_ROLLOVER_TIME`. Parolalar secret manager ya da wallet'ta.
- Birleşik denetim: politika tabanlı, geri alınan işlemleri ve başarısız girişleri de kaydeder, tablo sahibi kapatamaz. Saklama ve SIEM'e aktarım planla.
- VPD: her sorguya otomatik satır koşulu; havuzlarda kimliği her istekte ayarla/temizle, güvenilir bağlam paketi.
- Ağ şifrelemesi varsayılan kapalı: `SQLNET.ENCRYPTION_SERVER = REQUIRED` ya da TLS. TDE ve Redaction ayrı lisans.
