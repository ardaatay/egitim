# Oturumlar, bekleme olayları, kilit zincirleri ve yavaş SQL

Gece 02:00'de bir alarm geliyor: "API yanıt süreleri 10 saniye". Veritabanının o anda ne yaptığını birkaç sorguyla görebilmelisin: Kimler bağlı ve ne yapıyor, CPU mu harcıyorlar yoksa bir şey mi bekliyorlar, birbirlerini mi engelliyorlar, en çok kaynağı hangi SQL tüketiyor. Bu ders, Linux kursundaki `top`, `ps` ve `iostat` alışkanlığının Oracle'daki karşılığını kuruyor: **Zaman nereye gidiyor?**

Bu dersteki çıktılar gerçek bir yük altında alındı: Aynı anda iki oturum ağır bir rapor sorgusunu döngüde çalıştırıyor (`rapor-servisi`), bir oturum bir satırı güncelleyip commit etmeden boşta bekliyor (`admin-paneli`), ve bir oturum aynı satırı güncellemeye çalışıyor (`deploy-servisi`). İzleme sorguları `system` olarak çalıştırıldı.

> **Dikkat:** Bu dersteki `V$SESSION`, `V$SQL`, `V$SYSTEM_EVENT` gibi görünümler her sürümde ücretsizdir. **`V$ACTIVE_SESSION_HISTORY` (ASH), AWR ve ADDM ise Enterprise Edition'da ayrı lisanslanan Diagnostics Pack'in parçasıdır.** Lisansın yoksa bunları sorgulamak bile lisans ihlalidir (kullanım `DBA_FEATURE_USAGE_STATISTICS`'te kaydedilir). Oracle Free'de ve Autonomous Database'de kullanılabilirler. Lisanssız ortamlar için ücretsiz alternatif **Statspack**'tir.

## Zaman modeli: CPU ya da bekleme

Bir oturum ya **CPU'da** çalışıyordur ya da bir şeyi **bekliyordur**: diskten bir blok, bir kilit, istemciden bir sonraki komut, ağ. Oracle her beklemeyi bir **bekleme olayı** (wait event) olarak adlandırır ve sınıflandırır. Performans teşhisinin temel sorusu: "Veritabanı zamanı nereye harcıyor?" Cevap "CPU" ise sorgular fazla iş yapıyordur (kötü planlar, fazla okunan blok). Cevap bir bekleme ise, o beklemenin sebebi bulunur.

Bekleme sınıfları (`WAIT_CLASS`):

| Sınıf | Örnek olaylar | Tipik sebep |
|---|---|---|
| **Idle** | `SQL*Net message from client` | Oturum boşta, istemciden komut bekliyor. Sorun değil |
| **User I/O** | `db file sequential read` (tek blok, indeks), `db file scattered read` (çoklu, tam tarama), `direct path read` | Bellekte olmayan veri, yavaş disk, kötü plan |
| **Application** | `enq: TX - row lock contention` | Satır kilidi: başka bir transaction bekleniyor |
| **Commit** | `log file sync` | Commit'te LGWR'ın redo yazmasını bekleme: sık commit ya da yavaş redo diski |
| **Concurrency** | `latch: shared pool`, `library cache lock`, `buffer busy waits` | Bellek yapıları üzerinde çekişme: literal SQL, sıcak bloklar |
| **Configuration** | `log file switch (checkpoint incomplete)` | Küçük redo log'lar, yetersiz yapılandırma |
| **Network** | `SQL*Net more data to client` | Büyük sonuç kümeleri, yavaş ağ |

## Şu an kim ne yapıyor?

```sql
SELECT s.sid, s.serial#, s.username, s.module, s.status, s.state,
       CASE WHEN s.state = 'WAITING' THEN s.event ELSE 'CPU' END AS event,
       s.wait_class, s.seconds_in_wait AS sn, s.sql_id
FROM v$session s
WHERE s.type = 'USER' AND s.username = 'EGITIM'
ORDER BY s.status, s.sid;
```

```text
 SID SERIAL# USERNAME MODULE          STATUS   STATE             EVENT                          WAIT_CLASS  SN SQL_ID
---- ------- -------- --------------- -------- ----------------- ------------------------------ ----------- -- -------------
 207    1022 EGITIM   rapor-servisi   ACTIVE   WAITED SHORT TIME CPU                            Other        0 5bmqa68c7dr69
 210   56141 EGITIM   rapor-servisi   ACTIVE   WAITED SHORT TIME CPU                            Other        0 5bmqa68c7dr69
 206   38066 EGITIM   admin-paneli    INACTIVE WAITING           SQL*Net message from client    Idle         1
 216   24719 EGITIM   SQL*Plus        INACTIVE WAITING           SQL*Net message from client    Idle         0
```

`STATE` sütunu önemli: `WAITING` ise oturum şu an `EVENT`'i bekliyor. Başka bir değer (`WAITED SHORT TIME`, `WAITED KNOWN TIME`) ise oturum **CPU'da** ve `EVENT` sütunu sadece son beklediği şeyi gösteriyor. Bu yüzden sorguda `CASE` ile düzelttik; ham `EVENT` sütununa bakıp "bu oturum bekliyor" sonucuna varmak yaygın bir hatadır.

`MODULE` sütunu, uygulamaların `DBMS_APPLICATION_INFO.SET_MODULE` ile kendilerini tanıtmasından geliyor. Bu bilgi yoksa her şey "JDBC Thin Client" ya da "node" görünür ve hangi servisin sorun çıkardığını bulmak zorlaşır. Sürücüler bunu bağlantı özelliği olarak destekler: `node-oracledb`'de `connection.module`, JDBC'de `setClientInfo("OCSID.MODULE", ...)`.

Bir dikkat noktası daha: 216 numaralı oturum burada `INACTIVE` görünüyor ama aslında bir kilit bekliyordu. Bu sorgu oturumun `MODULE` bilgisini henüz ayarlamadan önceki bir anında yakalandı (`SQL*Plus`). Anlık görüntüler (snapshot) aldatıcı olabilir: Aynı sorguyu birkaç saniye arayla tekrar çalıştırmak ya da ASH'e (aşağıda) bakmak daha güvenilirdir.

## Kilit zincirleri

Transaction'lar dersinde tek bir engelleyeni bulmuştuk. Gerçek olaylarda engelleme bir **zincir** ya da ağaç olur: A, B'yi engeller; B'yi bekleyen C, D ve E vardır. Kökü bulmak için hiyerarşik sorgu:

```sql
SELECT LPAD(' ', 2 * (LEVEL - 1)) || s.sid || ' ' || s.module || ' (' || s.status || ')' AS agac,
       s.event, s.seconds_in_wait AS sn
FROM v$session s
WHERE s.username = 'EGITIM'
START WITH s.blocking_session IS NULL
       AND s.sid IN (SELECT blocking_session FROM v$session WHERE blocking_session IS NOT NULL)
CONNECT BY PRIOR s.sid = s.blocking_session;
```

```text
AGAC                                     EVENT                                  SN
---------------------------------------- ------------------------------ ----------
206 admin-paneli (INACTIVE)              SQL*Net message from client             1
  216 deploy-servisi (ACTIVE)            enq: TX - row lock contention           0
```

Kök engelleyen: `admin-paneli`, ve **INACTIVE**: boşta, istemciden komut bekliyor, ama açık bir transaction'ı ve satır kilidi var. Bu, gerçek hayatta en sık görülen engelleme desenidir: Bir uygulama bir kaydı güncelledi, sonra commit etmeden başka bir şey yapmaya gitti (bir HTTP çağrısı, kullanıcı girdisi, bir hata yolunda bağlantıyı havuza commit etmeden iade etmek).

"Açık transaction'la boşta duran" oturumları doğrudan aramak:

```sql
SELECT s.sid, s.module, s.status, s.last_call_et AS son_cagri_sn, t.start_time, t.used_urec
FROM v$session s JOIN v$transaction t ON t.addr = s.taddr
WHERE s.status = 'INACTIVE';
```

```text
 SID MODULE          STATUS   SON_CAGRI_SN START_TIME            USED_UREC
---- --------------- -------- ------------ -------------------- ----------
 206 admin-paneli    INACTIVE            1 11/26/26 08:55:54             1
```

`LAST_CALL_ET`: Oturumun son çağrısından bu yana geçen saniye. Birkaç dakikadır boşta duran ve açık transaction'ı olan bir oturum neredeyse her zaman bir hatadır. Bu sorgu izleme sistemine bir alarm olarak eklenmeye değer.

### Engelleyeni sonlandırmak

Engelleyenin ne olduğunu ve kime ait olduğunu (`MODULE`, `MACHINE`, `PROGRAM`, `OSUSER`) kaydettikten sonra, son çare olarak:

```sql
BEGIN
  FOR s IN (SELECT sid, serial# FROM v$session WHERE module = 'admin-paneli' AND username = 'EGITIM') LOOP
    DBMS_OUTPUT.PUT_LINE('ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.serial# || ''' IMMEDIATE');
    EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.serial# || ''' IMMEDIATE';
  END LOOP;
END;
/
```

```text
ALTER SYSTEM KILL SESSION '216,13188' IMMEDIATE
```

Bekleyen oturumun tarafında:

```text
1 row updated.
Elapsed: 00:00:08.12          ← engelleyen öldürülene kadar bekledi, sonra devam etti
```

Öldürülen oturumun transaction'ı **geri alındı** ve kilit kalktı. Öldürülen oturumun uygulaması, bir sonraki çağrısında bir hata alır:

```text
ORA-03113: end-of-file on communication channel
Session ID: 216 Serial number: 13188
```

Bağlantı havuzları bu hatayı görünce bağlantıyı atıp yenisini açar. `SID` tek başına yetmez: `SERIAL#` aynı SID'nin yeniden kullanılmasına karşı koruma sağlar. Yanlış oturumu öldürmemek için ikisini birlikte ver. RAC'ta `'sid,serial#,@inst_id'` yazılır.

23ai'den beri bunun otomatik bir yolu da var: `MAX_IDLE_BLOCKER_TIME` parametresi (dakika, varsayılan 0 yani kapalı), başkalarını engelleyerek belirtilen süreden fazla boşta kalan oturumları sonlandırır: `ALTER SYSTEM SET max_idle_blocker_time = 5`. Bunu açmak, "unutulmuş transaction" olaylarını kendiliğinden çözer, ama bir uygulamanın meşru uzun transaction'larını da keser: Uygulama ekipleriyle konuşarak bir değer seç.

## Geçmişe bakmak: Active Session History

`V$SESSION` sadece **şu anı** gösterir. Alarm geldiğinde olay bitmiş olabilir. **ASH**, her saniye aktif (idle olmayan) her oturumun bir örneğini alır ve bellekte (yaklaşık son bir saat), sonra AWR'da (varsayılan 8 gün) saklar. "Son bir dakikada aktif oturumlar ne yapıyordu?":

```sql
SELECT NVL(event, 'CPU') AS event, NVL(wait_class, 'CPU') AS wait_class, module, sql_id, COUNT(*) AS ornek
FROM v$active_session_history
WHERE sample_time > SYSTIMESTAMP - INTERVAL '1' MINUTE
  AND user_id = (SELECT user_id FROM dba_users WHERE username = 'EGITIM')
GROUP BY event, wait_class, module, sql_id
ORDER BY ornek DESC FETCH FIRST 6 ROWS ONLY;
```

```text
EVENT                            WAIT_CLASS   MODULE           SQL_ID             ORNEK
-------------------------------- ------------ ---------------- ------------- ----------
CPU                              CPU          rapor-servisi    5bmqa68c7dr69         41
enq: TX - row lock contention    Application  deploy-servisi   4ca1nuj2ywqwy         14
```

Her satır yaklaşık "bir saniyelik bir oturum" demektir: Son dakikada `rapor-servisi`, `5bmqa68c7dr69` sorgusuyla yaklaşık 41 oturum-saniye CPU harcadı. `deploy-servisi` 14 saniye satır kilidi bekledi. Bu tek sorgu bir olayın özetidir: hangi servis, hangi SQL, hangi bekleme.

Zaman içindeki dağılım, yükün ne zaman başladığını gösterir:

```sql
SELECT TO_CHAR(sample_time, 'HH24:MI:SS') AS an, COUNT(*) AS aktif,
       SUM(CASE WHEN session_state = 'ON CPU' THEN 1 ELSE 0 END) AS cpu,
       SUM(CASE WHEN wait_class = 'Application' THEN 1 ELSE 0 END) AS kilit
FROM v$active_session_history
WHERE sample_time > SYSTIMESTAMP - INTERVAL '30' SECOND
  AND user_id = (SELECT user_id FROM dba_users WHERE username = 'EGITIM')
GROUP BY TO_CHAR(sample_time, 'HH24:MI:SS') ORDER BY 1;
```

```text
AN            AKTIF        CPU      KILIT
-------- ---------- ---------- ----------
08:55:55          3          2          1
08:55:56          3          2          1
08:55:57          3          2          1
...
```

Her saniye 3 aktif oturum: 2'si CPU'da, 1'i kilit bekliyor. **Ortalama aktif oturum** (average active sessions, AAS) sayısı, veritabanı yükünün en iyi tek ölçüsüdür. Bu sayıyı CPU çekirdek sayısıyla karşılaştır: 4 çekirdekli bir sunucuda sürekli 12 aktif oturum varsa, oturumların çoğu bekliyor demektir (CPU kuyruğunda ya da bir kaynakta). Oracle Enterprise Manager'daki ünlü "performans grafiği" tam olarak bu sorgunun görselleştirmesidir.

ASH, AWR'da saklananlar için `DBA_HIST_ACTIVE_SESS_HISTORY` görünümünden sorgulanır: "Dün gece 02:00–02:30 arasında ne oldu?" sorusu böylece cevaplanır. Bir zaman aralığının hazır raporu için `@?/rdbms/admin/ashrpt.sql`.

## En pahalı SQL

```sql
SELECT sql_id, executions AS calisma, ROUND(elapsed_time/1e6, 1) AS toplam_sn,
       ROUND(elapsed_time/1e3/NULLIF(executions, 0), 1) AS ort_ms,
       ROUND(buffer_gets/NULLIF(executions, 0)) AS blok_calisma,
       ROUND(cpu_time/NULLIF(elapsed_time, 0) * 100) AS cpu_yuzde,
       SUBSTR(sql_text, 1, 44) AS sql_text
FROM v$sql
WHERE parsing_schema_name = 'EGITIM' AND last_active_time > SYSDATE - 2/1440
  AND sql_text NOT LIKE 'DECLARE%' AND sql_text NOT LIKE 'BEGIN%'
ORDER BY elapsed_time DESC FETCH FIRST 4 ROWS ONLY;
```

```text
SQL_ID        CALISMA TOPLAM_SN  ORT_MS BLOK_CALISMA CPU_YUZDE SQL_TEXT
------------- ------- --------- ------- ------------ --------- --------------------------------------------
5bmqa68c7dr69      39      41.3  1059.5         1459       100 SELECT COUNT(*) FROM OLAYLAR O JOIN SUNUCULA
4ca1nuj2ywqwy       2      26.1 13049.2           14         0 UPDATE sunucular SET durum = durum WHERE id
4a7tq010kz3ca       2         0     9.9           47        82 UPDATE sunucular SET bellek_gb = bellek_gb W
```

İki farklı türde "pahalı" sorgu:

- **`5bmqa68c7dr69`**: Her çalışması yaklaşık 1 saniye, %100 CPU, 1.459 blok. Bu sorgu **iş yapıyor**: Tam tarama ve her satırda `REGEXP_LIKE`. Çözüm sorgunun kendisinde: plan, indeks, ya da düzenli ifade yerine daha ucuz bir koşul.
- **`4ca1nuj2ywqwy`**: Her çalışması 13 saniye ama **%0 CPU**, sadece 14 blok. Bu sorgu iş yapmıyor, **bekliyor**. Sorgunun planını iyileştirmek hiçbir şey değiştirmez. Sorun onu engelleyen oturumda.

`CPU_YUZDE` (cpu_time / elapsed_time) bu ayrımı tek bir sütunda yapar. `V$SQL` istatistikleri, sorgu çalışırken birkaç saniyede bir güncellenir. Hâlâ çalışan uzun bir sorgunun değerleri eksik olabilir. Uzun süren tek bir sorgu için `V$SQL_MONITOR` (5 saniyeden uzun sorgular otomatik izlenir, Tuning Pack lisansı gerekir) adım adım ilerlemeyi gösterir.

Farklı sıralama ölçütleri farklı sorunları ortaya çıkarır:

- `ORDER BY elapsed_time DESC`: toplamda en çok zaman alan (sık çalışan küçük sorgular da dahil).
- `ORDER BY buffer_gets DESC`: en çok blok okuyan (CPU ve bellek baskısı).
- `ORDER BY executions DESC`: en sık çalışan (N+1 desenleri, gereksiz tekrarlar).
- `ORDER BY elapsed_time/executions DESC`: çalışma başına en yavaş (kullanıcıya en çok yansıyan).

## Sistem genelinde bekleme olayları

```sql
SELECT event, wait_class, total_waits, ROUND(time_waited_micro/1e6, 1) AS toplam_sn,
       ROUND(time_waited_micro/1e3/NULLIF(total_waits, 0), 2) AS ort_ms
FROM v$system_event
WHERE wait_class <> 'Idle'
ORDER BY time_waited_micro DESC FETCH FIRST 6 ROWS ONLY;
```

```text
EVENT                                   WAIT_CLASS     TOTAL_WAITS  TOPLAM_SN     ORT_MS
--------------------------------------- -------------- ----------- ---------- ----------
enq: TX - row lock contention           Application              6       42.7    7120.99
log file switch (checkpoint incomplete) Configuration          106       14.2     133.96
db file sequential read                 User I/O             23982        2.6        .11
log file switch completion              Configuration          129        2.5      19.47
online DDL delay                        Other                    2        2.3    1125.19
direct path write                       User I/O              2723        1.8        .67
```

Bu görünüm, instance açıldığından bu yana **toplamdır**. Derslerdeki kilit denemeleri ilk sırada. İkinci sıradaki daha ilginç: **`log file switch (checkpoint incomplete)`**, 106 kez, ortalama 134 ms. Mimari dersinde gördüğümüz iki adet 10 MB'lık redo log grubu, bu kursta yaptığımız toplu işler için (200.000 satırlık yüklemeler, silmeler) çok küçük. LGWR bir log grubunu doldurup diğerine geçmek istediğinde, o grubun checkpoint'i henüz bitmemişse **bütün yazma işlemleri bekler**. Üretimde bu, yük altında periyodik "donmalar" olarak görünür. Çözüm, redo log'ları büyütmek ve/veya grup sayısını artırmak (depolama dersinde yapacağız). Ortalama bekleme süreleri de bir sağlık göstergesidir: `db file sequential read` için 0,11 ms, verinin büyük kısmının işletim sistemi önbelleğinden ya da hızlı bir SSD'den geldiğini gösteriyor. Döner disklerde 5–10 ms tipiktir, 20 ms üstü depolamada bir sorun demektir.

Toplam değerler, bir zaman aralığındaki değişimi görmek için iki anlık görüntü arasındaki farkla kullanılır. AWR ve Statspack tam olarak bunu yapar: Saatlik anlık görüntüler ve aralarındaki farkın raporu. AWR raporunun (`@?/rdbms/admin/awrrpt.sql`) "Top 10 Foreground Events" ve "SQL ordered by Elapsed Time" bölümleri bu dersteki iki sorgunun karşılığıdır.

## Bellek ve geçici alan

Büyük sıralamalar ve hash join'ler PGA'ya sığmazsa TEMP tablespace'e taşar. Kimin ne kadar TEMP kullandığı:

```sql
SELECT s.sid, s.module, u.tablespace, u.segtype, ROUND(u.blocks * 8 / 1024) AS mb, u.sql_id
FROM v$tempseg_usage u JOIN v$session s ON s.saddr = u.session_addr
ORDER BY u.blocks DESC;

SELECT s.sid, s.module, ROUND(p.pga_used_mem / 1024 / 1024) AS pga_mb, ROUND(p.pga_max_mem / 1024 / 1024) AS pga_max_mb
FROM v$session s JOIN v$process p ON p.addr = s.paddr
WHERE s.type = 'USER' ORDER BY p.pga_used_mem DESC FETCH FIRST 5 ROWS ONLY;
```

TEMP dolarsa sorgular `ORA-01652: unable to extend temp segment` alır. PGA toplam sınırı (`PGA_AGGREGATE_LIMIT`) aşılırsa Oracle en çok kullanan oturumları sonlandırır. Linux kursundaki bellek izleme bilgisiyle birleştir: Oracle süreçlerinin RSS değerleri, SGA ve PGA kullanımının işletim sistemi tarafındaki görüntüsüdür.

## Bir olay anında kontrol listesi

1. **Yük ne kadar ve ne tür?** ASH'den son 5–15 dakikanın ortalama aktif oturum sayısı, CPU ve bekleme sınıflarına göre dağılımı.
2. **Kilit zinciri var mı?** Hiyerarşik engelleme sorgusu. Kök engelleyen `INACTIVE` ve açık transaction'lı mı?
3. **Hangi SQL?** ASH'de en çok örneği olan `SQL_ID`'ler; `V$SQL`'de çalışma başına süre, blok sayısı ve CPU oranı.
4. **Plan değişti mi?** `V$SQL`'de aynı `SQL_ID` için farklı `PLAN_HASH_VALUE`'lar, ya da `DBA_HIST_SQLSTAT`'ta dünkü planla bugünkünün karşılaştırması. Değiştiyse önceki dersteki baseline aracı.
5. **Sistem kaynağı mı?** Bekleme olaylarında I/O süreleri, `log file sync`, `log file switch`; işletim sisteminde CPU, bellek, disk (Linux kursundaki araçlar).
6. **Kim?** `MODULE`, `MACHINE`, `PROGRAM`: Sorunu hangi uygulamanın, hangi sunucunun ürettiğini bul ve o ekibi olaya dahil et.

## Alıştırma

1. Bu dersteki senaryoyu kendin kur: İki terminalde aynı satırı güncelle (ilki commit etmesin), üçüncü terminalde kilit ağacını ve "boşta açık transaction" sorgusunu çalıştır. Sonra ilk oturumu `COMMIT` ile (öldürmeden) serbest bırak.
2. Bir uygulamanın veritabanına her istekte 50 küçük sorgu gönderdiği şikâyet ediliyor (N+1). `V$SQL` ile bunu nasıl doğrularsın?
3. ASH sorgusunda en büyük bekleme `log file sync` çıkıyor. Hangi iki sebebi araştırırsın?

<details><summary>Çözüm</summary>

1. Kilit ağacında kök olarak commit etmeyen oturum `INACTIVE` görünür, bekleyen onun altında `enq: TX - row lock contention` ile. İlk oturum `COMMIT` yapınca bekleyen anında devam eder. Öldürmekten farkı, ilk oturumun değişikliğinin geri alınmak yerine kalıcı olmasıdır.

2. `ORDER BY executions DESC` ile en sık çalışan sorgulara bak. N+1 deseninde aynı küçük sorgu (örneğin `SELECT ... FROM sunucular WHERE id = :1`) çok yüksek çalışma sayısıyla, çok düşük çalışma başına süreyle görünür. Çalışma sayısını, uygulamanın istek sayısıyla karşılaştır: istek başına 50 çalışma, döngü içinde tek tek sorgu atan bir kodu gösterir. `MODULE`/`ACTION` bilgisi varsa hangi uç noktanın yaptığı da görünür. Çözüm uygulamada: tek bir join'li sorgu ya da `WHERE id IN (...)` ile toplu okuma.

3. (a) **Çok sık commit:** Uygulama her satırdan sonra commit ediyor (örneğin bir döngüde 10.000 ekleme, her birinde commit). Her commit LGWR'ın bir yazmasını bekler. `V$SYSSTAT`'ta `user commits` sayısının saniye başına değerine bak; çözüm, işi mantıklı partilerle commit etmek. (b) **Yavaş redo diski:** `log file parallel write` olayının ortalama süresine bak (LGWR'ın kendi yazma süresi). Bu yüksekse (birkaç ms'den fazla) redo log'ların bulunduğu depolama yavaştır. Redo'yu düşük gecikmeli bir diske taşımak, ya da diğer yoğun I/O'dan (yedekler, arşiv) ayırmak gerekir.

</details>

```quiz
V$SESSION'da STATE = 'WAITED SHORT TIME' ve EVENT = 'db file sequential read' olan bir oturum ne yapıyordur?
- Diskten blok okumayı bekliyordur
- [x] CPU'da çalışıyordur; EVENT sadece son beklediği şeyi gösterir
- Boştadır
? Oturum sadece STATE = 'WAITING' ise EVENT'i bekliyordur.
```

```quiz
Kilit zincirinin kökünde INACTIVE bir oturum görmek genellikle neyi gösterir?
- Oturum çökmüştür
- [x] Uygulama bir kaydı değiştirip commit etmeden başka işe geçmiş; açık transaction kilidi tutuyor
- Oracle bir hata yapmış
? Açık transaction'lı boşta oturumları V$SESSION + V$TRANSACTION ile bul.
```

```quiz
V$SQL'de bir sorgu çalışma başına 13 saniye sürüyor ama CPU oranı %0. İlk ne yaparsın?
- Sorgunun planını iyileştiririm
- [x] Sorgunun neyi beklediğine (kilit, I/O) bakarım; muhtemelen bir kilit tarafından engelleniyordur
- İndeks eklerim
? CPU harcamayan yavaş sorgu iş yapmıyor, bekliyordur.
```

```quiz
V$ACTIVE_SESSION_HISTORY'yi lisanslı bir Enterprise Edition'da sorgulamak için ne gerekir?
- Hiçbir şey, V$ görünümleri ücretsizdir
- [x] Diagnostics Pack lisansı (ASH, AWR ve ADDM bu paketin parçasıdır)
- Sadece DBA rolü
? Lisanssız ortamlarda ücretsiz alternatif Statspack'tir.
```

## Özet

- Zaman ya CPU ya bekleme. `STATE = 'WAITING'` değilse oturum CPU'dadır. Bekleme sınıfları sebebe yol gösterir.
- `V$SESSION`: anlık görüntü; `MODULE`'ü uygulamalara ayarlat.
- Kilit zinciri: `BLOCKING_SESSION` üzerinde hiyerarşik sorgu. Kökte `INACTIVE` + açık transaction en yaygın desen. `KILL SESSION 'sid,serial#'` son çare, geri alma yapar; `MAX_IDLE_BLOCKER_TIME` (23ai+).
- ASH (Diagnostics Pack): saniyelik örnekler, ortalama aktif oturum, olay sonrası analiz. Lisans yoksa Statspack.
- `V$SQL`: süre, blok, çalışma sayısı ve CPU oranıyla "iş yapan" ve "bekleyen" sorguları ayır.
- `V$SYSTEM_EVENT`: instance geneli; küçük redo log'lar `log file switch` beklemeleri üretir.
- TEMP (`V$TEMPSEG_USAGE`) ve PGA (`V$PROCESS`) kullanımı.
