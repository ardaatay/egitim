# Docker ile Oracle 26ai Free, istemciler ve bağlantı

Bu derste kurs boyunca kullanacağın veritabanını kuruyoruz: Docker'da Oracle AI Database 26ai Free (eski adıyla 23ai), bir uygulama kullanıcısı ve örnek şema. Ardından Oracle'a bağlanmanın yollarını (EZConnect, servis adları, listener) ve en sık karşılaşılan bağlantı hatalarını ele alıyoruz.

## Seçenekler

| Ortam | Ne zaman |
|---|---|
| **Docker: `gvenzl/oracle-free`** | Kendi makinende tam yetkili bir veritabanı. Kursun önerdiği yol. |
| **Docker: `container-registry.oracle.com/database/free`** | Oracle'ın resmi imajı, daha büyük, ilk açılışı daha yavaş. |
| **FreeSQL (tarayıcı)** | Kurulum yok. SQL ve PL/SQL dersleri için yeterli, ama `SYS` yetkisi ve `V$` görünümleri yok. |
| **Oracle Cloud Always Free** | İnternetten erişilebilen, yönetilen bir Autonomous Database. |

Oracle Database Free'nin sınırları: en fazla 2 CPU iş parçacığı, 2 GB SGA+PGA ve 12 GB kullanıcı verisi. Özellik olarak Enterprise Edition'ın çoğunu (partitioning, JSON Duality, vektör arama dahil) içerir, bu yüzden öğrenmek için ideal.

```lab
FreeSQL: tarayıcıda Oracle 26ai
https://freesql.com
Oracle'ın ücretsiz çevrimiçi SQL çalışma alanı. Kayıt olunca kalıcı bir şema verir. SQL ve PL/SQL derslerinde kullanılabilir, yönetim derslerinde (SYS, V$ görünümleri) yetersizdir.
```

## Docker ile kurulum

```bash
docker volume create oracle-veri

docker run -d --name ora-egitim \
  -p 127.0.0.1:1521:1521 \
  -e ORACLE_PASSWORD='SysParola_123' \
  -e APP_USER=egitim -e APP_USER_PASSWORD='egitim' \
  -v oracle-veri:/opt/oracle/oradata \
  --memory 3g \
  gvenzl/oracle-free:23-slim

docker logs -f ora-egitim       # "DATABASE IS READY TO USE!" görünce Ctrl+C
```

Seçimlerin sebepleri:

- **`127.0.0.1:1521:1521`**: Portu sadece yerel makineye açar. `-p 1521:1521` yazarsan ağdaki herkes veritabanına ulaşabilir (Docker kursunda konuştuğumuz gibi Docker, ufw/firewalld kurallarını da atlar).
- **`ORACLE_PASSWORD`**: `SYS` ve `SYSTEM` parolası. **`APP_USER`**: `FREEPDB1` içinde uygulama kullanıcısı oluşturur. Uygulamalar asla `SYS` ya da `SYSTEM` ile bağlanmamalı.
- **Volume**: `/opt/oracle/oradata`'da datafile'lar, redo log'lar ve control file'lar durur. Volume olmadan konteyner silinince veritabanı da gider.
- **`--memory 3g`**: Free sürümü en fazla 2 GB kullanır. Üstüne süreçler için pay bırakıyoruz.
- **`23-slim`**: Gereksiz bileşenleri çıkarılmış daha küçük bir imaj. `23-faststart` ise veritabanı önceden oluşturulmuş geldiği için ilk açılışı saniyeler sürer, ama imajı daha büyüktür.

İlk açılış veritabanını oluşturduğu için bir iki dakika sürer. Sonraki açılışlarda volume'deki veritabanı doğrudan açılır.

Compose ile aynısı, sağlık kontrolüyle:

```yaml
# compose.yaml
services:
  oracle:
    image: gvenzl/oracle-free:23-slim
    ports: ["127.0.0.1:1521:1521"]
    environment:
      ORACLE_PASSWORD_FILE: /run/secrets/oracle_sys
      APP_USER: egitim
      APP_USER_PASSWORD: egitim
    secrets: [oracle_sys]
    volumes: [oracle-veri:/opt/oracle/oradata]
    healthcheck:
      test: ["CMD", "healthcheck.sh"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 60s
    mem_limit: 3g
  api:
    image: ornek/api:1.0
    depends_on:
      oracle: { condition: service_healthy }   # veritabanı hazır olmadan başlama
secrets:
  oracle_sys: { file: ./secrets/oracle_sys.txt }
volumes:
  oracle-veri:
```

## İstemciler

- **SQL\*Plus**: Oracle'ın klasik komut satırı istemcisi. Konteynerin içinde hazır: `docker exec -it ora-egitim sqlplus egitim/egitim@FREEPDB1`.
- **SQLcl** (`sql`): SQL\*Plus'ın modern hali. Komut geçmişi, sekme tamamlama, `INFO tablo`, `DDL tablo`, CSV/JSON çıktı (`SET SQLFORMAT json`) ve dahili Liquibase. Java 17+ gerektirir. Oracle'ın sitesinden zip olarak indirilir, ya da Oracle'ın resmi konteyner imajıyla çalıştırılır.
- **SQL Developer for VS Code**: VS Code eklentisi olarak grafik arayüz, plan görüntüleyici, tablo tarayıcı. Günlük geliştirme için en rahatı.
- **Uygulama sürücüleri**: Node için `node-oracledb`, Python için `python-oracledb`, Java için JDBC (`ojdbc11`). Modern sürücüler **thin mode** ile çalışır, Oracle Instant Client kurulumu gerektirmez.

Kursta örnekleri konteynerdeki SQL\*Plus ile çalıştırıyoruz, çünkü hiçbir şey kurmayı gerektirmiyor:

```bash
docker exec -it ora-egitim sqlplus egitim/egitim@FREEPDB1
```

SQL\*Plus çıktısını okunur yapmak için oturum başında şunları ayarla (ya da `~/.sqlplus/login.sql`'e koy):

```sql
SET LINESIZE 200 PAGESIZE 100 TRIMSPOOL ON
SET SQLPROMPT "_USER'@'_CONNECT_IDENTIFIER> "
COLUMN ad FORMAT A20
```

## Bağlantı dizgeleri ve listener

Bir istemci Oracle'a **listener** üzerinden bağlanır: 1521 portunu dinleyen ayrı bir süreç (`tnslsnr`). Listener isteği alır, istenen **servis adına** bakar, o servise hizmet veren veritabanı için bir sunucu süreci oluşturur ve bağlantıyı ona devreder. Sonrasında listener aradan çıkar; listener'ı yeniden başlatmak açık bağlantıları koparmaz.

**EZConnect** en yaygın biçimdir:

```text
host:port/servis_adi
localhost:1521/FREEPDB1
db.ornek.com:1521/odeme_prod.ornek.com
```

JDBC'de: `jdbc:oracle:thin:@//localhost:1521/FREEPDB1`. Node/Python sürücülerinde `connectString: "localhost:1521/FREEPDB1"`.

**tnsnames.ora** ise bağlantı tanımlarını bir dosyada adlandırır. Yük dengeleme, yedek sunucu (failover) ve zaman aşımı gibi ayarlar burada yapılır:

```ini
ODEME_PROD =
  (DESCRIPTION =
    (CONNECT_TIMEOUT = 5)(RETRY_COUNT = 3)(TRANSPORT_CONNECT_TIMEOUT = 3)
    (ADDRESS_LIST =
      (LOAD_BALANCE = off)(FAILOVER = on)
      (ADDRESS = (PROTOCOL = TCP)(HOST = db1.ornek.com)(PORT = 1521))
      (ADDRESS = (PROTOCOL = TCP)(HOST = db2.ornek.com)(PORT = 1521)))
    (CONNECT_DATA = (SERVICE_NAME = odeme_prod.ornek.com)))
```

`TNS_ADMIN` ortam değişkeni bu dosyanın bulunduğu dizini gösterir. Artık **SID** ile bağlanma (`host:1521:SID`) eskide kaldı. PDB'lere her zaman servis adıyla bağlanılır.

Listener'ın durumunu ve kayıtlı servisleri görmek için:

```bash
docker exec ora-egitim lsnrctl status
```

```text
STATUS of the LISTENER
------------------------
Alias                     LISTENER
Version                   TNSLSNR for Linux: Version 23.26.4.0.0 - Production
Uptime                    0 days 0 hr. 4 min. 27 sec
Listener Parameter File   /opt/oracle/product/26ai/dbhomeFree/network/admin/listener.ora
Listener Log File         /opt/oracle/diag/tnslsnr/25042c39184c/listener/alert/log.xml
Listening Endpoints Summary...
  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=25042c39184c)(PORT=1521)))
Services Summary...
Service "FREE" has 1 instance(s).
  Instance "FREE", status READY, has 1 handler(s) for this service...
Service "freepdb1" has 1 instance(s).
  Instance "FREE", status READY, has 1 handler(s) for this service...
...
```

`FREE` CDB'nin, `freepdb1` PDB'nin servisi. `status READY` instance'ın kendini listener'a **dinamik olarak** kaydettiğini gösterir (LREG süreci yapar). Veritabanı açılmadan önce bu satırlar yoktur ve bağlantılar `ORA-12514` alır. Listener'ın kendi logu da ayrı bir yerde: Bağlantı reddi ya da bağlantı fırtınası araştırırken oraya bakılır.

Uygulamalar için `FREEPDB1` yerine **kendi servislerini** tanımlamak iyi bir uygulamadır (`DBMS_SERVICE.CREATE_SERVICE`). Böylece bir servisin hangi instance'larda çalıştığını, oturumların hangi uygulamaya ait olduğunu (`V$SESSION.SERVICE_NAME`) ve kaynak yönetimini ayrı ayrı kontrol edebilirsin.

## Sık bağlantı hataları

| Hata | Anlamı | Bakılacak yer |
|---|---|---|
| `ORA-12541: no listener` | O host:port'ta listener yok | Konteyner çalışıyor mu, port yayınlanmış mı, güvenlik duvarı |
| `ORA-12514: listener does not currently know of service` | Listener çalışıyor ama bu servis adı kayıtlı değil | Servis adını yazım hatası, PDB açık mı (`lsnrctl status`) |
| `ORA-01017: invalid username/password` | Kimlik bilgisi yanlış | Kullanıcı doğru PDB'de mi oluşturuldu? Parolalar büyük/küçük harf duyarlı |
| `ORA-28000: the account is locked` | Çok fazla başarısız giriş | `ALTER USER ... ACCOUNT UNLOCK`. Sebebini bul: genellikle eski parolayla deneyen bir uygulama |
| `ORA-12170 / ORA-12535: timeout` | Ağ yolu yok ya da paketler düşüyor | Güvenlik grupları, firewall, NAT. `nc -vz host 1521` ile kontrol |
| `ORA-00020 / ORA-12516` | `processes` sınırına ulaşıldı | Bağlantı sızıntısı ya da havuzu çok büyük uygulamalar |

`ORA-12514` özellikle konteynerlerde sık görülür: Veritabanı henüz açılmamışken uygulama bağlanmaya çalışır. Compose'daki `service_healthy` koşulu bunun için var.

## Örnek şema

Kursun geri kalanında aynı veri setini kullanacağız: ekipler, uygulamalar, 60 sunucu, 5.000 deploy kaydı ve 200.000 olay (log) satırı. Veriler rastgele değil, formüllerle üretiliyor; derslerdeki çıktılarla kendi sonuçların birebir aynı olur.

Betiği indir ve konteynere kopyalayıp çalıştır:

```bash
curl -fsSLO https://ardaatay.github.io/egitim/courses/oracle/ornek-sema.sql
docker cp ornek-sema.sql ora-egitim:/tmp/
docker exec -it ora-egitim sqlplus -s egitim/egitim@FREEPDB1 @/tmp/ornek-sema.sql
```

```text
Table created.
4 rows created.
...
200000 rows created.
Commit complete.
...
TABLO            SATIR
----------- ----------
ekipler              4
uygulamalar          8
sunucular           60
deploylar         5000
olaylar         200000
```

Betik yaklaşık 30 saniye sürer, çoğu 200.000 olay satırını üretmek ve istatistik toplamaktır. Bittikten sonra SQL\*Plus komut isteminde kalırsın, oradan devam edebilirsin.

FreeSQL kullanıyorsan betiğin içeriğini çalışma alanına yapıştırıp çalıştır. Betik önce aynı adlı tabloları sildiği için istediğin zaman yeniden çalıştırıp temiz bir başlangıç yapabilirsin.

Tablolar:

```text
ekipler (id, ad)
uygulamalar (id, ad, ekip_id → ekipler)
sunucular (id, ad, bolge, cpu, bellek_gb, durum, ekip_id → ekipler, olusturma)
deploylar (id, uygulama_id → uygulamalar, sunucu_id → sunucular, surum, ortam, baslangic, sure_sn, durum)
olaylar (id, sunucu_id → sunucular, zaman, seviye, mesaj)
```

İlk sorgu:

```sql
SELECT s.bolge, COUNT(*) AS sunucu, SUM(s.cpu) AS toplam_cpu
FROM sunucular s
WHERE s.durum = 'calisiyor'
GROUP BY s.bolge
ORDER BY s.bolge;
```

```text
BOLGE          SUNUCU TOPLAM_CPU
---------- ---------- ----------
ams                18        142
fra                18        134
ist                19        134
```

## Alıştırma

1. `SYSTEM` olarak `FREEPDB1`'e bağlan ve `raporcu` adında, sadece `egitim.sunucular` tablosunu okuyabilen bir kullanıcı oluştur. Sonra `raporcu` ile bağlanıp sorgula, `deploylar`'ı okuyamadığını doğrula.
2. Konteyneri durdurup tekrar başlat. Verilerin durduğunu ve listener'ın servisi yeniden kaydettiğini kontrol et.

<details><summary>Çözüm</summary>

```sql
-- docker exec -it ora-egitim sqlplus system/SysParola_123@FREEPDB1
CREATE USER raporcu IDENTIFIED BY "Rapor_123";
GRANT CREATE SESSION TO raporcu;
GRANT SELECT ON egitim.sunucular TO raporcu;
```

```sql
-- docker exec -it ora-egitim sqlplus raporcu/Rapor_123@FREEPDB1
SELECT COUNT(*) FROM egitim.sunucular;
SELECT COUNT(*) FROM egitim.deploylar;
```

```text
  COUNT(*)
----------
        60

SELECT COUNT(*) FROM egitim.deploylar
                            *
ERROR at line 1:
ORA-00942: table or view "EGITIM"."DEPLOYLAR" does not exist
```

İkinci sorgudaki hata ilginç: Oracle "yetkin yok" demiyor, "tablo yok" diyor. Yetkisi olmayan bir kullanıcıya bir nesnenin varlığını bile göstermemek bir güvenlik tercihidir. Ama üretimde `ORA-00942` gördüğünde ilk soru "tablo gerçekten yok mu, yoksa bu kullanıcının yetkisi mi yok?" olmalı.

```bash
docker restart ora-egitim
docker logs --tail 5 ora-egitim
docker exec ora-egitim lsnrctl status | grep -i freepdb1
```

Volume sayesinde veriler durur. Açılıştan hemen sonra birkaç saniye `ORA-12514` alabilirsin: Veritabanı servislerini listener'a henüz kaydetmemiştir.

</details>

```quiz
Uygulamanın `ORA-12514: listener does not currently know of service` hatası alması neyi gösterir?
- Listener çalışmıyor
- [x] Listener'a ulaşıldı ama istenen servis adı kayıtlı değil (yazım hatası ya da veritabanı/PDB henüz açılmadı)
- Parola yanlış
? Listener hiç yoksa ORA-12541 alınır.
```

```quiz
Docker'da `-p 1521:1521` yerine `-p 127.0.0.1:1521:1521` kullanmanın sebebi?
- Daha hızlı bağlantı
- [x] Veritabanı portunu sadece yerel makineye açmak. Docker, host güvenlik duvarı kurallarını atlayabilir
- Oracle bunu zorunlu tutar
? Geliştirme veritabanı bile ağa açık olmamalı.
```

```quiz
Listener yeniden başlatılırsa mevcut açık bağlantılar ne olur?
- Hepsi kopar
- [x] Etkilenmez: listener sadece bağlantı kurulurken aracılık eder, sonra aradan çıkar
- Yeniden yönlendirilir
? Yeni bağlantılar listener tekrar açılana kadar kurulamaz.
```

## Özet

- `gvenzl/oracle-free:23-slim` ile Docker'da 26ai Free (imaj etiketi hâlâ 23): portu 127.0.0.1'e bağla, volume kullan, `APP_USER` ile uygulama kullanıcısı aç.
- İstemciler: konteynerdeki SQL\*Plus, SQLcl, VS Code için SQL Developer. Sürücüler thin mode ile Instant Client gerektirmez.
- Bağlantı: EZConnect `host:port/servis`, gelişmiş ayarlar için tnsnames.ora. Listener sadece aracıdır.
- Hatalar: 12541 listener yok, 12514 servis yok, 01017 kimlik, 12170 ağ, 12516 süreç sınırı.
- Örnek şema: ekipler, uygulamalar, sunucular, deploylar, olaylar.
