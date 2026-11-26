# Oracle mimarisi: instance, CDB/PDB, bellek ve süreçler

Bir uygulama "veritabanı yavaş" dediğinde, bir oturum dakikalarca beklediğinde ya da disk dolduğunda doğru yere bakabilmek için Oracle'ın içini bilmen gerekir. Bu ders sonraki her dersin temelini atıyor: Oracle'ın bellekte ve diskte nelerden oluştuğu, bir `COMMIT`'in arkasında ne olduğu ve bunların hepsini veritabanının kendisine nasıl soracağın.

## Instance ve database

Oracle'da bu iki kelime farklı şeyleri anlatır:

- **Database:** diskteki dosyalar. Verinin kendisi (datafile'lar), veritabanının yapısını tutan control file'lar ve değişikliklerin günlüğü olan online redo log'lar.
- **Instance:** o dosyaları kullanan **bellek alanları** (SGA) ve **arka plan süreçleri**. Instance başlatılır, durdurulur, çöker; dosyalar diskte kalır.

```text
               ┌──────────────────────── INSTANCE ────────────────────────┐
 istemci ──▶   │ sunucu süreci (PGA)        SGA                           │
 (uygulama)    │                 ┌──────────────────────────────────┐     │
               │                 │ buffer cache │ shared pool │ redo │     │
               │                 │              │ (SQL planları)│ buf │     │
               │                 └──────────────────────────────────┘     │
               │  DBWn   LGWR   CKPT   SMON   PMON   ARCn   MMON  ...     │
               └────┬───────┬──────────────────────────────────┬─────────┘
                    ▼       ▼                                  ▼
               datafile'lar  online redo log'lar   control file   (arşiv log'lar)
               └────────────────────── DATABASE (diskteki dosyalar) ──────┘
```

Tek sunuculu kurulumda bir instance bir database'i açar. **RAC**'ta (Real Application Clusters) birden çok sunucudaki birden çok instance aynı database'i (paylaşımlı diskte) birlikte açar.

## Multitenant: CDB ve PDB

Oracle 21c'den beri her veritabanı bir **container database (CDB)**'dir. İçinde:

- **CDB$ROOT:** Oracle'ın kendi meta verisi ve ortak kullanıcılar. Uygulama verisi buraya konmaz.
- **PDB$SEED:** yeni PDB'ler oluşturmak için salt okunur bir şablon.
- **PDB'ler (pluggable database):** uygulamaların gerçek veritabanları. Her PDB kendi kullanıcıları, tabloları ve tablespace'leri olan, uygulamaya bağımsız bir veritabanı gibi görünür. Ama hepsi **aynı instance'ı** (belleği ve süreçleri) paylaşır.

Docker ile kuracağımız Oracle AI Database 26ai Free'de CDB'nin adı `FREE`, hazır gelen PDB'nin adı `FREEPDB1`. Uygulamalar her zaman bir **servis adı** üzerinden bir PDB'ye bağlanır (`localhost:1521/FREEPDB1`). CDB root'a sadece yönetim işleri için bağlanılır.

Operasyon açısından PDB'nin faydası: Bir PDB klonlanabilir, başka bir CDB'ye taşınabilir (unplug/plug), tek başına açılıp kapatılabilir, kaynak sınırı (CPU, bellek, I/O) konabilir. Veritabanı sürümü yükseltmesi CDB seviyesinde bir kez yapılır.

## Bellek: SGA ve PGA

**SGA (System Global Area)** bütün oturumların paylaştığı bellektir:

| Bileşen | Ne tutar | Yetersizse |
|---|---|---|
| **Buffer cache** | Datafile'lardan okunan bloklar (genelde 8 KB). Bir satır okunacaksa önce burada aranır. | Daha fazla fiziksel okuma (disk I/O) |
| **Shared pool** | Ayrıştırılmış SQL'ler ve execution plan'ları (library cache), veri sözlüğü önbelleği | Hard parse artışı, `ORA-04031` |
| **Redo log buffer** | Henüz diske yazılmamış değişiklik kayıtları | `log buffer space` beklemeleri |
| **Large pool** | Paralel sorgu, RMAN, paylaşımlı sunucu bellekleri | |

**PGA (Program Global Area)** her sunucu sürecinin **özel** belleğidir: sıralama (`ORDER BY`, `GROUP BY`), hash join'ler, cursor durumu. PGA yetmezse sıralama diske, yani **TEMP** tablespace'ine taşar ve sorgu yavaşlar.

Bellek boyutları birkaç parametreyle yönetilir: `SGA_TARGET` (SGA toplamı, bileşenler arasında otomatik dağıtılır), `PGA_AGGREGATE_TARGET` (bütün PGA'lar için hedef) ve `PGA_AGGREGATE_LIMIT` (aşılırsa en çok kullanan oturumlar sonlandırılır). Konteynerde çalışırken bunların toplamı konteynerin bellek limitinin altında kalmalı, yoksa Docker kursunda gördüğümüz OOM killer devreye girer.

## Süreçler

Linux'ta Oracle'ın her arka plan süreci ayrı bir işletim sistemi sürecidir. Eski sürümlerde komut satırında `ora_pmon_ORCL` gibi görünürlerdi, 26ai'de `db_pmon_FREE` biçimine geçildi (çekirdeğin gördüğü kısa ad, yani `comm`, hâlâ `ora_pmon_free`). Kullandığımız slim imajda `ps` yok, ama Linux kursundaki `/proc` bilgisi yeter:

```bash
docker exec ora-egitim sh -c 'for p in /proc/[0-9]*; do echo "${p#/proc/} $(cat $p/comm)"; done' \
  | grep -E 'ora_(pmon|smon|dbw|lgwr|ckpt|mmon)'
```

```text
56 ora_pmon_free
97 ora_dbw0_free
99 ora_lgwr_free
101 ora_ckpt_free
104 ora_smon_free
121 ora_mmon_free
```

Boş bir veritabanında bile yaklaşık 60 Oracle süreci çalışır. Gerçek bir sunucuda `ps -eo pid,rss,cmd | grep db_` ile aynı listeyi ve her birinin bellek kullanımını görürsün.

En önemlileri:

- **LGWR (log writer):** redo log buffer'ı online redo log dosyalarına yazar. `COMMIT` ancak LGWR redo'yu diske yazdığında tamamlanır.
- **DBWn (database writer):** buffer cache'teki değişmiş ("kirli") blokları datafile'lara yazar. Bunu **tembel** yapar, commit anında değil.
- **CKPT (checkpoint):** belirli aralıklarla DBWn'yi tetikler ve control file'a "şu noktaya kadar her şey datafile'larda" bilgisini yazar.
- **SMON (system monitor):** çökmeden sonra açılışta **instance recovery** yapar.
- **PMON (process monitor):** ölen istemci süreçlerinin kilitlerini ve kaynaklarını temizler.
- **ARCn (archiver):** dolan redo log'ları arşive kopyalar (ARCHIVELOG modunda).
- **MMON:** performans istatistiklerini (AWR) toplar.

Her istemci bağlantısı için de bir **sunucu süreci** (dedicated server) oluşur: `oracleFREE (LOCAL=NO)`. 2.000 bağlantı açan bir uygulama sunucuda 2.000 süreç demektir. Uygulama tarafında bağlantı havuzunun (connection pool) neden şart olduğunu son bölümde konuşacağız.

## Bir COMMIT'in arkasında ne var?

```sql
UPDATE hesaplar SET bakiye = bakiye - 100 WHERE id = 42;
COMMIT;
```

1. Sunucu süreci satırın bulunduğu bloğu buffer cache'te arar, yoksa datafile'dan okur.
2. Eski değer **undo**'ya yazılır (geri alma ve diğer oturumların tutarlı okuması için).
3. Blok bellekte değiştirilir ve değişikliği tarif eden bir **redo** kaydı redo log buffer'a yazılır.
4. `COMMIT`: LGWR redo kayıtlarını online redo log dosyasına yazar. Yazma bitince istemciye "tamam" denir.
5. Değişen blok **daha sonra** DBWn tarafından datafile'a yazılır.

Commit'in hızlı olmasının sebebi sadece sıralı redo yazmasını beklemesidir. Datafile'lara rastgele yazmayı beklemez. Sunucu 4. ile 5. adım arasında çökerse veri kaybolmaz: Açılışta SMON redo log'dan değişiklikleri yeniden uygular (roll forward) ve commit edilmemiş işlemleri undo ile geri alır.

Bu yüzden operasyonda **redo log'ların bulunduğu diskin gecikmesi** doğrudan commit süresidir. Bekleme olaylarında `log file sync` görüyorsan, uygulama ya çok sık commit ediyordur (her satırda bir) ya da redo diski yavaştır.

## Diskteki dosyalar

- **Datafile'lar**, **tablespace** adı verilen mantıksal gruplara aittir. Her PDB'nin kendi `SYSTEM`, `SYSAUX`, `UNDOTBS1`, `TEMP` ve uygulama tablespace'leri (`USERS`) vardır. Bir tablo bir tablespace'te yaşar.
- **Control file:** veritabanının "haritası": datafile ve redo log'ların yerleri, son checkpoint. Kaybı ciddi bir sorundur, bu yüzden üretimde en az iki kopya farklı disklerde tutulur.
- **Online redo log'lar:** döngüsel olarak kullanılan, en az iki grup. Biri dolunca LGWR diğerine geçer (**log switch**).
- **Arşiv log'lar:** ARCHIVELOG modunda dolan redo log'ların kopyaları. Zamanın herhangi bir anına geri dönebilmek (point-in-time recovery) bunlara bağlıdır. Üretimde ARCHIVELOG kapalı bir veritabanı, son yedekten sonraki her şeyi kaybetmeyi kabul ediyor demektir.
- **Alert log ve trace dosyaları:** Linux kursundaki log izleme alışkanlığının Oracle karşılığı. Açılış, kapanış, log switch'ler, `ORA-` hataları, tablespace doluluk uyarıları buraya yazılır. Bir sorun olduğunda ilk bakılacak yer.

## Açılış aşamaları

```text
SHUTDOWN ──▶ NOMOUNT ──▶ MOUNT ──▶ OPEN
             SPFILE okunur,   control file    datafile ve redo
             SGA ayrılır,     açılır          log'lar açılır,
             süreçler başlar                  kullanıcılar bağlanır
```

Bazı işler sadece belirli bir aşamada yapılabilir: control file'ı yeniden oluşturmak NOMOUNT'ta, ARCHIVELOG modunu açmak ve tam veritabanı geri yüklemek MOUNT'ta. CDB açıldıktan sonra PDB'ler ayrıca açılır (`ALTER PLUGGABLE DATABASE ... OPEN`). `SAVE STATE` ile açılışta otomatik açılmaları sağlanır.

## Veritabanına kendisini sormak

Oracle'ın içinde olan her şey **dinamik performans görünümleri** (`V$...`) ve **veri sözlüğü görünümleri** (`DBA_...`, `ALL_...`, `USER_...`) ile sorgulanabilir. Sonraki derslerde sürekli kullanacağız. Aşağıdakileri bir sonraki derste kuracağımız veritabanında `SYS` olarak çalıştır:

```sql
-- instance ve veritabanı
SELECT instance_name, version_full, status, startup_time FROM v$instance;
SELECT name, cdb, log_mode, open_mode FROM v$database;

-- container'lar
SELECT con_id, name, open_mode FROM v$pdbs;
```

```text
INSTANCE_NAME VERSION_FULL STATUS       STARTUP_TIME
------------- ------------ ------------ ------------------
FREE          23.26.4.0.0  OPEN         26-NOV-26

NAME   CDB LOG_MODE     OPEN_MODE
------ --- ------------ --------------------
FREE   YES NOARCHIVELOG READ WRITE

    CON_ID NAME       OPEN_MODE
---------- ---------- ----------
         2 PDB$SEED   READ ONLY
         3 FREEPDB1   READ WRITE
```

Sürüm numarası 23.26: Oracle, 23ai'yi 2025'te **Oracle AI Database 26ai** olarak yeniden adlandırdı ama sürüm hattını değiştirmedi. Belgelerde ve forumlarda ikisini de görürsün, aynı veritabanıdır. `V$PDBS` CDB root'tan sorgulandığı için `CDB$ROOT` (con_id 1) listede yok, sadece PDB'ler var.

```sql
-- SGA bileşenleri (MB)
SELECT name, ROUND(bytes/1024/1024) AS mb, resizeable
FROM v$sgainfo
WHERE name IN ('Buffer Cache Size','Shared Pool Size','Redo Buffers','Large Pool Size','Maximum SGA Size');

-- bellek parametreleri
SELECT name, display_value FROM v$parameter
WHERE name IN ('sga_target','pga_aggregate_target','pga_aggregate_limit','processes','db_block_size');
```

```text
NAME                       MB RES
------------------- --------- ---
Redo Buffers                4 No
Buffer Cache Size         928 Yes
Shared Pool Size          432 Yes
Large Pool Size            16 Yes
Maximum SGA Size         1529 No

NAME                  DISPLAY_VALUE
--------------------- -------------
processes             200
pga_aggregate_limit   2G
sga_target            1536M
db_block_size         8192
pga_aggregate_target  512M
```

1,5 GB'lık SGA'nın çoğu buffer cache'e ayrılmış. `processes = 200`: bu veritabanına aynı anda en fazla 200 süreç (arka plan süreçleri dahil) bağlanabilir. Bir uygulama bağlantı sızdırırsa ilk duvara burada çarpar.

```sql
-- arka plan süreçleri
SELECT b.name, b.description
FROM v$bgprocess b JOIN v$process p ON p.addr = b.paddr
WHERE b.name IN ('PMON','SMON','LGWR','CKPT','MMON','DBW0')
ORDER BY b.name;

-- redo log grupları
SELECT group#, ROUND(bytes/1024/1024) AS mb, members, status FROM v$log;

-- alert log nerede?
SELECT name, value FROM v$diag_info WHERE name IN ('Diag Trace','Default Trace File');
```

```text
NAME   DESCRIPTION
------ ---------------------------------------------
CKPT   checkpoint
DBW0   db writer process 0
LGWR   Redo etc.
MMON   Manageability Monitor Process
PMON   process cleanup
SMON   System Monitor Process

    GROUP#         MB    MEMBERS STATUS
---------- ---------- ---------- ----------------
         1         10          1 ACTIVE
         2         10          1 CURRENT

NAME                 VALUE
-------------------- ------------------------------------------------------
Diag Trace           /opt/oracle/diag/rdbms/free/FREE/trace
Default Trace File   /opt/oracle/diag/rdbms/free/FREE/trace/FREE_ora_285.trc
```

İki adet 10 MB'lık redo log grubu var, her birinde tek dosya (`MEMBERS = 1`). Bu bir geliştirme ayarı: Üretimde redo log'lar genellikle yüzlerce MB ile birkaç GB arasıdır (saatte birkaç log switch hedeflenir) ve her grupta farklı disklerde en az iki üye olur. `CURRENT`, LGWR'ın şu an yazdığı grup; `ACTIVE`, içeriği henüz datafile'lara checkpoint edilmemiş grup.

Alert log, `Diag Trace` dizinindeki `alert_<SID>.log` dosyasıdır. Konteynerde canlı izlemek:

```bash
docker exec ora-egitim sh -c 'tail -f $ORACLE_BASE/diag/rdbms/free/FREE/trace/alert_FREE.log'
```

## Alıştırma

Bir sonraki dersteki kurulumdan sonra:

1. `FREEPDB1`'e bağlıyken o PDB'nin datafile'larını, bulundukları tablespace'leri ve boyutlarını listele.
2. Veritabanı ARCHIVELOG modunda mı? Değilse bunun bir üretim veritabanı için ne anlama geldiğini bir cümleyle açıkla.
3. Alert log'un son 20 satırında neler var?

<details><summary>Çözüm</summary>

```sql
ALTER SESSION SET CONTAINER = FREEPDB1;   -- SYS olarak CDB'deyken PDB'ye geç
SELECT tablespace_name, file_name, ROUND(bytes/1024/1024) AS mb, autoextensible
FROM dba_data_files ORDER BY tablespace_name;
```

```text
TABLESPACE FILE_NAME                                              MB AUT
---------- ---------------------------------------------- ---------- ---
SYSAUX     /opt/oracle/oradata/FREE/FREEPDB1/sysaux01.dbf        373 YES
SYSTEM     /opt/oracle/oradata/FREE/FREEPDB1/system01.dbf        300 YES
UNDOTBS1   /opt/oracle/oradata/FREE/FREEPDB1/undotbs01.dbf        21 YES
USERS      /opt/oracle/oradata/FREE/FREEPDB1/users01.dbf          31 YES
```

`TEMP` burada yok çünkü geçici dosyalar ayrı bir görünümde: `DBA_TEMP_FILES`.

2. `SELECT log_mode FROM v$database;` sorgusu `NOARCHIVELOG` döner (geliştirme imajlarında varsayılan). Üretimde bu, sadece en son tam yedeğe dönülebileceği, ondan sonraki bütün işlemlerin bir disk arızasında kaybolacağı anlamına gelir. Ayrıca çevrimiçi (veritabanı açıkken) yedek almak mümkün olmaz.

3. `docker exec ora-egitim sh -c 'tail -20 $ORACLE_BASE/diag/rdbms/free/FREE/trace/alert_FREE.log'`. Açılış sırasında genellikle PDB açılış mesajları, `Completed: ALTER DATABASE OPEN` ve log switch kayıtları görürsün.

</details>

```quiz
Instance ile database arasındaki fark nedir?
- İkisi aynı şeydir
- [x] Instance bellek (SGA) ve arka plan süreçleridir, database diskteki dosyalardır
- Database bellekte, instance diskte tutulur
? Instance kapanıp açılabilir, database dosyaları diskte kalır. RAC'ta birden çok instance aynı database'i açar.
```

```quiz
Bir COMMIT ne zaman tamamlanmış sayılır?
- DBWn değişen blokları datafile'a yazdığında
- [x] LGWR redo kayıtlarını online redo log dosyasına yazdığında
- Bir sonraki checkpoint'te
? Datafile'lara yazma daha sonra, tembel olarak yapılır. Çökme olursa redo'dan yeniden uygulanır.
```

```quiz
Bir uygulama Oracle 23ai Free'de tablolarını nereye kurmalı?
- CDB$ROOT'a
- PDB$SEED'e
- [x] Bir PDB'ye (örneğin FREEPDB1), servis adı üzerinden bağlanarak
? CDB root Oracle'ın meta verisi için, seed ise yeni PDB'ler için salt okunur şablondur.
```

## Özet

- Instance = SGA + arka plan süreçleri; database = datafile'lar, control file'lar, redo log'lar.
- Multitenant: CDB$ROOT, PDB$SEED, uygulama PDB'leri. Uygulamalar servis adıyla PDB'ye bağlanır.
- SGA: buffer cache, shared pool, redo buffer. PGA: oturum başına sıralama ve hash belleği, taşarsa TEMP.
- LGWR commit'i belirler, DBWn tembel yazar, SMON çökme sonrası kurtarır. Her bağlantı bir sunucu süreci.
- ARCHIVELOG, point-in-time recovery'nin ön koşuludur. Alert log ilk bakılacak yer.
- `V$` ve `DBA_` görünümleri ile veritabanı kendini anlatır.
