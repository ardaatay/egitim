# Data Pump, RMAN ve Flashback

Bir yedeğin değeri, ondan ne kadar hızlı ve ne kadar kayıpsız **geri dönebildiğinle** ölçülür. Bu derste Oracle'ın üç geri dönüş katmanını ele alıyoruz: mantıksal yedek (Data Pump: şemaları ve tabloları taşımak, kopyalamak), fiziksel yedek ve kurtarma (datafile'lar, arşiv log'lar, redo uygulama, RMAN), ve hızlı geri alma (Flashback: dakikalar önce yapılan bir hatayı yedeksiz geri almak). Bu dersteki her senaryo gerçekten uygulandı: Bir datafile silindi ve verisi geri getirildi.

İki kavram bütün tasarımı belirler:

- **RPO (Recovery Point Objective):** Kaybetmeyi kabul edebileceğin en fazla veri. "Son 5 dakikanın verisi kaybolabilir" ya da "hiç veri kaybolamaz".
- **RTO (Recovery Time Objective):** Geri dönüşün en fazla ne kadar sürebileceği. "1 saat içinde tekrar açık olmalı."

Gecelik bir `expdp` yedeği, 24 saatlik bir RPO demektir. ARCHIVELOG modunda fiziksel yedek + arşiv log'lar, son commit'e kadar (RPO ≈ 0) dönmeyi mümkün kılar. Data Guard ile bir bekleme (standby) veritabanı ise RTO'yu dakikalara indirir.

## Data Pump: mantıksal yedek

Data Pump (`expdp` / `impdp`), nesneleri ve verileri bir **dump dosyasına** yazar: tablolar, indeks tanımları, kısıtlar, PL/SQL, yetkiler, istatistikler. Sunucu tarafında çalışır, dosyalar veritabanı sunucusundaki bir **dizin nesnesine** yazılır:

```sql
-- system olarak, PDB'de
CREATE OR REPLACE DIRECTORY yedek_dir AS '/opt/oracle/oradata/dpump';
```

```bash
docker exec ora-egitim mkdir -p /opt/oracle/oradata/dpump
docker exec ora-egitim expdp system/<parola>@FREEPDB1 schemas=egitim \
  directory=yedek_dir dumpfile=egitim.dmp logfile=egitim_exp.log
```

```text
Processing object type SCHEMA_EXPORT/SQL_DOMAIN/SIMPLE_DOMAIN/SQL_DOMAIN
Processing object type SCHEMA_EXPORT/TABLE/TABLE
Processing object type SCHEMA_EXPORT/PACKAGE/PACKAGE_SPEC
...
. . exported "EGITIM"."OLAYLAR"                            9.5 MB  200000 rows
. . exported "EGITIM"."CI_OLAYLARI"                         50 KB     137 rows
. . exported "EGITIM"."DEPLOYLAR"                        259.5 KB    5000 rows
...
. . exported "EGITIM"."OLAYLAR_P":"SYS_P699"               1.4 MB   30240 rows
...
Job "SYSTEM"."SYS_EXPORT_SCHEMA_01" successfully completed at Thu Nov 26 09:18:58 2026 elapsed 0 00:00:47
```

Bütün şema (domain, tablolar, bölümler, paketler, trigger'lar, Duality görünümü) 16 MB'lık bir dosyaya, 47 saniyede yazıldı. `parallel=2` ile denediğimizde: `ORA-39094: Parallel execution not supported in this database edition`. Paralel Data Pump Enterprise Edition'ın bir özelliğidir.

### Başka bir şemaya geri yüklemek

Data Pump'ın en sık kullanımı bir şemayı başka bir yere kopyalamaktır: üretimden test ortamına, bir veritabanından diğerine, ya da "dünkü halini yan tarafa açıp karşılaştır":

```bash
docker exec ora-egitim impdp system/<parola>@FREEPDB1 directory=yedek_dir dumpfile=egitim.dmp \
  logfile=egitim_imp.log remap_schema=egitim:egitim_test
```

```text
. . imported "EGITIM_TEST"."OLAYLAR"                       9.5 MB  200000 rows
. . imported "EGITIM_TEST"."DEPLOYLAR"                   259.5 KB    5000 rows
...
Job "SYSTEM"."SYS_IMPORT_FULL_01" successfully completed at Thu Nov 26 09:20:08 2026 elapsed 0 00:00:27
```

```sql
SELECT object_type, status, COUNT(*) FROM dba_objects
WHERE owner = 'EGITIM_TEST' GROUP BY object_type, status ORDER BY 1;
```

```text
OBJECT_TYPE        STATUS    COUNT(*)
------------------ ------- ----------
DOMAIN             VALID            1
INDEX              VALID           29
INDEX PARTITION    VALID           10
PACKAGE            VALID            2
PACKAGE BODY       VALID            2
PROCEDURE          VALID            1
SEQUENCE           VALID            8
SYNONYM            INVALID          1
TABLE              VALID           14
TABLE PARTITION    VALID            5
TRIGGER            VALID            1
VIEW               VALID            1
```

Kullanıcı (`egitim_test`) otomatik oluşturuldu, PL/SQL geçerli derlendi. Tek geçersiz nesne, Duality görünümü için Oracle'ın kendiliğinden oluşturduğu küçük harfli `ekip_dv` eşanlamlısı. Her içe aktarımdan sonra geçersiz nesneleri kontrol et ve derle (`DBMS_UTILITY.COMPILE_SCHEMA`). Diğer kullanışlı parametreler:

- `tables=egitim.sunucular remap_table=sunucular:sunucular_dun`: tek bir tabloyu farklı adla geri yükle (yanlışlıkla güncellenmiş bir tablonun eski halini yan tarafa açmak).
- `content=metadata_only` / `data_only`: sadece yapı ya da sadece veri.
- `query=egitim.olaylar:"WHERE zaman > SYSDATE - 7"`: verinin bir alt kümesi (test ortamı için küçük bir kopya).
- `exclude=statistics`, `include=...`: nesne türlerini filtrele.
- `sqlfile=ddl.sql`: hiçbir şey yüklemeden DDL'i bir dosyaya yaz. Bir şemanın tam tanımını görmek ya da sürüm kontrolüne almak için:

```text
CREATE TABLE "EGITIM"."SUNUCULAR"
   (  "ID" NUMBER GENERATED ALWAYS AS IDENTITY MINVALUE 1 ... START WITH 1 CACHE 20 NOORDER NOCYCLE ...,
      "AD" VARCHAR2(30 BYTE) NOT NULL ENABLE,
      "BOLGE" VARCHAR2(10 BYTE) NOT NULL ENABLE,
      ...
```

Data Pump'ın **sınırı**: Dump dosyası, dışa aktarıldığı **andaki** verinin bir kopyasıdır. Gece 02:00'de alınan bir yedekle saat 16:00'da yaşanan bir felakette, 14 saatlik veri kaybolur. Ayrıca büyük veritabanlarında hem dışa aktarma hem içe aktarma saatler sürer (içe aktarmada bütün indeksler yeniden oluşturulur). Data Pump bir **taşıma ve kopyalama** aracıdır; tek başına bir felaket kurtarma stratejisi değildir.

Tutarlılık için bir ayrıntı: Varsayılan olarak her tablo kendi dışa aktarıldığı anın görüntüsüyle yazılır. Tablolar arasında tutarlılık (yabancı anahtar ilişkileri) için `flashback_time=systimestamp` ile tek bir an belirtilir.

## Fiziksel yedek ve kurtarma

Fiziksel yedek, datafile'ların, control file'ın ve arşiv log'ların kopyasıdır. Kurtarma iki adımdır: **restore** (dosyaları yedekten geri koy) ve **recover** (yedekten sonraki redo kayıtlarını uygulayarak dosyaları ileri sar). İkinci adım ancak **ARCHIVELOG** modunda mümkündür.

### ARCHIVELOG ve Fast Recovery Area

CDB'de, `SYS` olarak (veritabanı kısa bir süre kapanır):

```sql
ALTER SYSTEM SET db_recovery_file_dest_size = 10G SCOPE = BOTH;
ALTER SYSTEM SET db_recovery_file_dest = '/opt/oracle/oradata/fra' SCOPE = BOTH;
ALTER PLUGGABLE DATABASE FREEPDB1 SAVE STATE;      -- açılışta PDB'yi otomatik aç
SHUTDOWN IMMEDIATE
STARTUP MOUNT
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;
ARCHIVE LOG LIST
```

```text
Database log mode              Archive Mode
Automatic archival             Enabled
Archive destination            USE_DB_RECOVERY_FILE_DEST
Oldest online log sequence     148
Current log sequence           147
```

(Dizini önce oluştur: `docker exec ora-egitim mkdir -p /opt/oracle/oradata/fra`.) Artık her dolan redo log, FRA'ya arşivleniyor. Mimari dersindeki açılış aşamalarının pratiği: ARCHIVELOG modu sadece MOUNT aşamasında değiştirilebilir. Bir önceki dersteki uyarı burada geçerli hale geldi: Bu veritabanında FRA dolarsa yazmalar durur.

### Bir datafile'ı kaybetmek ve geri getirmek

Kullandığımız `gvenzl/oracle-free:23-slim` imajında **RMAN yok** (küçük tutmak için çıkarılmış; tam imaj `gvenzl/oracle-free:23` ve Oracle'ın resmi imajında var). Bu yüzden kurtarmanın mekanizmasını, RMAN'in arka planda yaptığı işi elle yaparak gösteriyoruz: kullanıcı yönetimli (user-managed) **sıcak yedek**. RMAN komutları aşağıda ayrıca var.

**1. Veritabanı açıkken yedek al.** `BEGIN BACKUP`, dosyaların kopyalanırken tutarsız olabileceğini Oracle'a bildirir. Oracle bu süre boyunca değişen blokların tamamını redo'ya yazar, böylece kurtarmada tutarlı hale getirilebilirler:

```sql
-- CDB'de SYS olarak
ALTER SESSION SET CONTAINER = FREEPDB1;
ALTER DATABASE BEGIN BACKUP;
SELECT d.name, b.status, b.change# FROM v$backup b JOIN v$datafile d ON d.file# = b.file#;
HOST cp /opt/oracle/oradata/FREE/FREEPDB1/users01.dbf /opt/oracle/oradata/yedek/users01.dbf
ALTER DATABASE END BACKUP;
```

```text
NAME                                                 STATUS                CHANGE#
---------------------------------------------------- ------------------ ----------
/opt/oracle/oradata/FREE/FREEPDB1/system01.dbf       ACTIVE                2436502
/opt/oracle/oradata/FREE/FREEPDB1/sysaux01.dbf       ACTIVE                2436502
/opt/oracle/oradata/FREE/FREEPDB1/undotbs01.dbf      ACTIVE                2436502
/opt/oracle/oradata/FREE/FREEPDB1/users01.dbf        ACTIVE                2436502
```

`CHANGE#` (2436502), yedeğin başladığı SCN'dir: Kurtarma bu noktadan itibaren redo uygular. (Yedek dizinini önce oluştur: `mkdir -p /opt/oracle/oradata/yedek`.) `END BACKUP`'ı unutmak tehlikelidir: Dosyalar "yedekleniyor" durumunda kalır ve her değişiklik tam blok olarak redo'ya yazılmaya devam eder, redo hacmi katlanır.

**2. Yedekten sonra bir değişiklik yap** ve redo'nun arşivlendiğinden emin ol:

```sql
INSERT INTO egitim.uygulama_log (seviye, kaynak, mesaj) VALUES ('INFO', 'yedek-testi', 'yedekten SONRA eklenen satır');
COMMIT;
ALTER SESSION SET CONTAINER = CDB$ROOT;
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM SWITCH LOGFILE;
ALTER SESSION SET CONTAINER = FREEPDB1;
```

Bu satır yedekte **yok**: Sadece redo'da var.

**3. Felaket: Datafile kayboluyor.**

```sql
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/users01.dbf' OFFLINE;
HOST rm /opt/oracle/oradata/FREE/FREEPDB1/users01.dbf
SELECT COUNT(*) FROM egitim.sunucular;
SELECT file_name, online_status FROM dba_data_files WHERE tablespace_name = 'USERS';
```

```text
ORA-00376: file 24 cannot be read at this time
ORA-01110: data file 24: '/opt/oracle/oradata/FREE/FREEPDB1/users01.dbf'

FILE_NAME                                            ONLINE_
---------------------------------------------------- -------
/opt/oracle/oradata/FREE/FREEPDB1/users01.dbf        RECOVER
```

`USERS` tablespace'indeki her şey (bu kurstaki bütün tablolar) erişilemez. Ama veritabanının geri kalanı (`SYSTEM`, diğer PDB'ler) çalışmaya devam ediyor. Gerçek hayatta bu bir disk arızası, yanlış bir `rm`, ya da bozuk bir depolama birimidir. Dosyayı silmeden önce `OFFLINE` yaptık; gerçek bir arızada Oracle dosyaya ulaşamadığında hata verir ve dosyayı kendisi çevrimdışı alır.

**4. Restore + recover:**

```sql
HOST cp /opt/oracle/oradata/yedek/users01.dbf /opt/oracle/oradata/FREE/FREEPDB1/users01.dbf
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/users01.dbf' ONLINE;
```

```text
ORA-01113: file 24 needs media recovery
```

Oracle, dosyanın yedekten geldiğini (control file'daki SCN'den daha eski olduğunu) fark etti ve açmayı reddetti: Eksik değişikliklerle açılsaydı veri tutarsız olurdu. Redo'yu uygulayalım:

```sql
RECOVER AUTOMATIC DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/users01.dbf';
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/users01.dbf' ONLINE;
SELECT COUNT(*) FROM egitim.sunucular;
SELECT kaynak, mesaj FROM egitim.uygulama_log WHERE kaynak = 'yedek-testi';
```

```text
Media recovery complete.
Database altered.

  COUNT(*)
----------
        60

KAYNAK         MESAJ
-------------- ----------------------------
yedek-testi    yedekten SONRA eklenen satır
```

Dosya, yedekteki halinden **son commit'e kadar** ileri sarıldı: Yedekten sonra eklenen satır da geldi. Kayıp veri: sıfır. Arşivlenen log'lar:

```sql
SELECT sequence#, ROUND(blocks*block_size/1024/1024, 1) AS mb, name FROM v$archived_log
WHERE name IS NOT NULL ORDER BY sequence#;
```

```text
 SEQUENCE#         MB NAME
---------- ---------- -------------------------------------------------------------
       148       46.9 /opt/oracle/oradata/fra/FREE/archivelog/2026_11_26/o1_mf_1_1...
       149          0 /opt/oracle/oradata/fra/FREE/archivelog/2026_11_26/o1_mf_1_1...
       150          0 /opt/oracle/oradata/fra/FREE/archivelog/2026_11_26/o1_mf_1_1...
```

Bu deneyin dersi: **Yedek + arşiv log'lar bir zincirdir.** Yedekten sonraki tek bir arşiv log eksikse, kurtarma o noktada durur ve sonrası kaybolur. Arşiv log'lar en az yedekler kadar önemlidir ve aynı özenle (ayrı bir yere kopyalanarak) korunmalıdır.

### RMAN

Üretimde yukarıdaki işler **RMAN** (Recovery Manager) ile yapılır. RMAN aynı mekanizmayı kullanır ama: hangi dosyanın hangi yedekte olduğunu kataloglar, sadece değişen blokları yedekler (artımlı yedek), yedeği alırken blok bozulmalarını kontrol eder, sıkıştırır, saklama politikasına göre eski yedekleri siler, ve `BEGIN BACKUP` gerektirmez (blokları tutarlı okur). Tam imajda ya da kurumsal bir kurulumda:

```text
RMAN> CONFIGURE CONTROLFILE AUTOBACKUP ON;
RMAN> CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
RMAN> BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG;
RMAN> LIST BACKUP SUMMARY;
RMAN> REPORT NEED BACKUP;
RMAN> DELETE OBSOLETE;

-- yukarıdaki kurtarmanın RMAN karşılığı:
RMAN> ALTER DATABASE DATAFILE 24 OFFLINE;
RMAN> RESTORE DATAFILE 24;
RMAN> RECOVER DATAFILE 24;
RMAN> ALTER DATABASE DATAFILE 24 ONLINE;

-- yedeğin gerçekten geri yüklenebildiğini, geri yüklemeden doğrula:
RMAN> RESTORE DATABASE VALIDATE;
```

(Bu kursun imajında RMAN olmadığı için bu komutlar burada çalıştırılmadı.) Tipik bir strateji: haftada bir seviye 0 (tam) yedek, her gece seviye 1 (artımlı) yedek, arşiv log'ların birkaç saatte bir yedeklenmesi, ve yedeklerin **başka bir yere** (nesne depolama, başka bir veri merkezi) kopyalanması. Aynı diskteki bir yedek, o diskle birlikte kaybolur.

### Kurtarma senaryoları

| Ne kayboldu | Kurtarma |
|---|---|
| Bir datafile | Datafile'ı restore + recover. Veritabanının geri kalanı açık kalır (yukarıdaki gibi) |
| Bütün veritabanı (sunucu gitti) | Yeni sunucuda control file + bütün datafile'ları restore, recover, `OPEN RESETLOGS` |
| Bir PDB'nin yanlış bir saatten sonraki hali | **PDB point-in-time recovery**: sadece o PDB'yi geçmişteki bir SCN'e geri sar |
| Online redo log'ların hepsi | En kötü senaryo: Son arşivden sonrası kaybolur. Redo'yu çoklamanın (multiplexing) sebebi |
| Control file | Çoklanmış kopyadan ya da autobackup'tan geri yükle |

## Flashback: yedeksiz geri alma

Bir sabah biri bir tabloyu silmiş ya da yanlış bir `UPDATE` çalıştırmış. Bütün veritabanını yedekten geri yüklemek saatler sürer ve diğer herkesin işini de geri alır. Flashback teknolojileri bu tür **mantıksal hataları** saniyeler içinde, sadece etkilenen nesnede geri alır.

### Silinen tabloyu geri getirmek

```sql
DROP TABLE saglik;
SELECT COUNT(*) FROM saglik;
SELECT original_name, object_name, type, droptime FROM user_recyclebin WHERE original_name = 'SAGLIK';
FLASHBACK TABLE saglik TO BEFORE DROP;
SELECT COUNT(*) FROM saglik;
```

```text
ORA-00942: table or view "EGITIM"."SAGLIK" does not exist

ORIGINAL_NAME  OBJECT_NAME                      TYPE   DROPTIME
-------------- -------------------------------- ------ --------------------
SAGLIK         BIN$YSuBfRL2DJTgYwMAEaw89Q==$0   TABLE  2026-11-26:09:24:09

Flashback complete.

  COUNT(*)
----------
        20
```

`DROP TABLE` tabloyu silmez, **geri dönüşüm kutusuna** taşır (adı değişir, yeri aynı kalır). `FLASHBACK TABLE ... TO BEFORE DROP` onu indeksleri ve kısıtlarıyla geri getirir (indekslerin adları `BIN$...` olarak kalabilir, yeniden adlandırmak gerekebilir). `DROP ... PURGE` ya da tablespace'te yer daraldığında recycle bin temizlenir: Bu bir yedek değil, bir emniyet ağıdır.

### Bir tabloyu geçmişteki bir ana geri sarmak

Transaction'lar dersindeki flashback query'nin tablo seviyesindeki karşılığı:

```sql
COLUMN t0 NEW_VALUE t0 NOPRINT
SELECT TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.FF') AS t0 FROM dual;   -- "hatadan önceki an"

UPDATE isler SET durum = 'iptal';               -- WHERE unutuldu
DELETE FROM isler WHERE id > 3;
COMMIT;
SELECT id, durum FROM isler ORDER BY id;

ALTER TABLE isler ENABLE ROW MOVEMENT;
FLASHBACK TABLE isler TO TIMESTAMP TO_TIMESTAMP('&t0', 'YYYY-MM-DD HH24:MI:SS.FF');
SELECT id, durum FROM isler ORDER BY id;
```

```text
        ID DURUM
---------- ----------
         1 iptal
         2 iptal
         3 iptal

Flashback complete.

        ID DURUM
---------- ----------
         1 calisiyor
         2 calisiyor
         3 calisiyor
         4 calisiyor
         5 bekliyor
         6 bekliyor
```

Güncellenen ve silinen satırlar, hatadan önceki haline döndü. Tek bir DDL benzeri ifade, ve diğer tablolara dokunulmadı. Sınırları: Undo retention süresi kadar geriye gidilebilir (varsayılan 15 dakika, transaction'lar dersi), tablo yapısı arada değişmemiş olmalı, ve `ENABLE ROW MOVEMENT` gerekir. Bağlı tablolar varsa (yabancı anahtar), birlikte geri sarılmalıdırlar: `FLASHBACK TABLE a, b TO TIMESTAMP ...`.

Daha uzun süreler için:

- **Flashback Data Archive** (Temporal History): Seçilen tabloların bütün değişiklik geçmişini **yıllarca** saklar, `AS OF` sorguları o süre boyunca çalışır. Denetim ve "geçen ay bu kayıt neydi?" soruları için. EE'de ek lisans gerektirmez.
- **Flashback Database:** Bütün veritabanını (ya da bir PDB'yi) geçmişteki bir ana saniyeler içinde geri sarar. FRA'da flashback log'ları tutulur (`ALTER DATABASE FLASHBACK ON`). Başarısız bir uygulama yükseltmesinden sonra "her şeyi yükseltme öncesine döndür" için idealdir: Yükseltme öncesi bir **garantili geri yükleme noktası** (`CREATE RESTORE POINT oncesi GUARANTEE FLASHBACK DATABASE`) oluşturulur.

## Yedeği test et

Hiç geri yüklenmemiş bir yedek, bir varsayımdır. Kurumsal kayıpların önemli bir kısmı "yedek vardı ama açılmadı" hikâyeleridir: Eksik arşiv log'lar, şifreleme anahtarı olmayan TDE yedekleri, yanlış dizindeki dosyalar, sessizce başarısız olan yedekleme işleri. Kurallar:

- Yedekleme işlerinin sonucunu izle (zamanlanmış işler dersindeki ilke): `V$RMAN_BACKUP_JOB_DETAILS`'te son başarılı yedek ne zaman?
- Düzenli olarak, otomatik bir şekilde **başka bir sunucuya geri yükle** ve açıp bir kontrol sorgusu çalıştır. Data Pump için de aynı: `impdp` ile bir test şemasına yükle, satır sayılarını karşılaştır.
- Geri yükleme süresini ölç: RTO hedefinle karşılaştır. 2 TB'lık bir veritabanının geri yüklenmesi, ağ ve disk hızına bağlı olarak saatler sürer.
- Geri yükleme prosedürünü yaz ve en az yılda bir, prosedürü yazmayan biri uygulasın.

## Alıştırma

1. `deploylar` tablosunu, `remap_table` ile `deploylar_yedek` adıyla aynı şemaya geri yükleyecek `impdp` komutunu yaz.
2. Yanlışlıkla bütün sunucuların durumu `kapali` yapıldı ve commit edildi, 5 dakika önce. Sırasıyla hangi yöntemleri düşünürsün ve neden?
3. ARCHIVELOG modundaki bir veritabanında son tam yedek dün gece alındı. Bugün öğlen bir datafile bozuldu. Hangi dosyalar olmadan bu datafile son commit'e kadar kurtarılamaz?

<details><summary>Çözüm</summary>

1.

```bash
docker exec ora-egitim impdp system/<parola>@FREEPDB1 directory=yedek_dir dumpfile=egitim.dmp \
  tables=egitim.deploylar remap_table=deploylar:deploylar_yedek \
  exclude=constraint,ref_constraint,trigger,index
```

`exclude` ile kısıtları, trigger'ları ve indeksleri dışarıda bırakmak, aynı şemada isim çakışmasını önler (kısıt ve indeks adları da aynı olurdu). Geri yüklenen tablo, üretimdeki tabloyla karşılaştırma ve seçici düzeltme için kullanılır: `UPDATE ... FROM deploylar_yedek` ile sadece etkilenen satırlar düzeltilir.

2. Sırasıyla: (a) **Flashback query** ile önceki değerleri görüp sadece `durum` sütununu düzelt (`UPDATE sunucular s SET durum = (SELECT durum FROM sunucular AS OF TIMESTAMP ... o WHERE o.id = s.id)`). En hedefli yöntem: Arada başka sütunlarda yapılan meşru değişiklikleri bozmaz. (b) **Flashback table** ile tabloyu 5 dakika önceye geri sar. Daha basit, ama aradaki **bütün** değişiklikleri de geri alır. (c) Undo yetmiyorsa (çok zaman geçmişse), dünkü **Data Pump** dump'ından tabloyu yan tarafa yükleyip karşılaştır. (d) Hiçbiri olmuyorsa, ayrı bir sunucuda fiziksel yedekten **point-in-time** geri yükleme yapıp tabloyu oradan al. Bütün veritabanını geri sarmak ise son çaredir, çünkü diğer bütün işleri de geri alır.

3. Dün geceki yedekten bugün öğlene kadar üretilen **bütün arşiv log'lar** ve henüz arşivlenmemiş **online redo log'lar**. Bu zincirde bir halka bile eksikse, kurtarma eksik halkadan önce durur ve sonraki değişiklikler kaybolur. Bu yüzden arşiv log'lar sık yedeklenir ve en az iki ayrı yerde tutulur, online redo log'lar çoklanır.

</details>

```quiz
Gecelik expdp yedeği alan bir sistemde öğleden sonra bir felaket olursa en fazla ne kadar veri kaybolur?
- Hiç
- [x] Son dışa aktarmadan bu yana yapılan her şey (yaklaşık bir gün): Data Pump bir anlık kopyadır
- Sadece son commit
? Son commit'e kadar dönmek için ARCHIVELOG + fiziksel yedek + arşiv log'lar gerekir.
```

```quiz
Yedekten geri yüklenen bir datafile neden doğrudan ONLINE yapılamaz (ORA-01113)?
- Dosya izinleri yanlıştır
- [x] Dosya yedeğin anındaki halindedir; sonraki değişikliklerin redo'dan uygulanması (recover) gerekir, yoksa veri tutarsız olur
- Yedek bozuktur
? Restore dosyayı geri koyar, recover onu son commit'e kadar ileri sarar.
```

```quiz
5 dakika önce yanlışlıkla WHERE'siz çalıştırılan bir UPDATE'i geri almanın en hızlı yolu?
- Gece yedeğinden bütün veritabanını geri yüklemek
- [x] Flashback query ile önceki değerleri okuyup düzeltmek ya da FLASHBACK TABLE ile tabloyu geri sarmak (undo yeterliyse)
- RMAN ile datafile'ı geri yüklemek
? Flashback mantıksal hataları sadece etkilenen nesnede, saniyeler içinde geri alır.
```

## Özet

- RPO (ne kadar veri kaybı) ve RTO (ne kadar süre) yedekleme tasarımını belirler.
- Data Pump: mantıksal, şema/tablo taşıma ve kopyalama, `remap_schema`, `remap_table`, `sqlfile`, `query`. Anlık kopya; tek başına felaket kurtarma değil. Paralel Data Pump EE gerektirir.
- ARCHIVELOG + FRA: son commit'e kadar kurtarmanın ön koşulu. Sadece MOUNT'ta açılır.
- Restore + recover: yedeği geri koy, arşiv log'larla ileri sar. Yedek ve arşiv log'lar bir zincirdir.
- RMAN: katalog, artımlı yedek, blok kontrolü, saklama politikası, `RESTORE ... VALIDATE`. Yedekler başka bir yere.
- Flashback: recycle bin (`TO BEFORE DROP`), `FLASHBACK TABLE ... TO TIMESTAMP`, Flashback Data Archive, Flashback Database ve garantili geri yükleme noktası.
- Test edilmemiş yedek bir varsayımdır: düzenli otomatik geri yükleme ve süre ölçümü.
