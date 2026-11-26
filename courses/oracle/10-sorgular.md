# Join'ler, alt sorgular ve küme operatörleri

Join yazmayı biliyorsun. Bu ders, join'lerin **yanlış ama hatasız** sonuç verdiği durumlara odaklanıyor: toplamları şişiren çoklama (fan-out), `LEFT JOIN`'i sessizce `INNER JOIN`'e çeviren `WHERE` koşulu, `NOT IN`'in NULL tuzağı. Ardından Oracle'da sık kullanılan araçlara geçiyoruz: `EXISTS` ile yarı ve anti join, `LATERAL`/`CROSS APPLY` ile "her grup için ilk N", küme operatörleri, `ROLLUP` ile ara toplamlar ve `PIVOT`.

Bütün örnekler örnek şemada (`egitim@FREEPDB1`) çalışır, çıktılar gerçek sonuçlardır.

## Join çoklaması: şişen toplamlar

"Her ekibin toplam CPU'su" basit bir sorgu:

```sql
SELECT e.ad AS ekip, COUNT(*) AS satir, SUM(s.cpu) AS toplam_cpu
FROM ekipler e JOIN sunucular s ON s.ekip_id = e.id
GROUP BY e.ad ORDER BY e.ad;
```

```text
EKIP           SATIR TOPLAM_CPU
--------- ---------- ----------
arama             15        120
mobil             15        240
odeme             15         60
platform          15         30
```

Şimdi aynı rapora deploy sayısını da ekleyelim:

```sql
SELECT e.ad AS ekip, COUNT(*) AS satir, SUM(s.cpu) AS toplam_cpu, COUNT(d.id) AS deploy
FROM ekipler e
JOIN sunucular s ON s.ekip_id = e.id
LEFT JOIN deploylar d ON d.sunucu_id = s.id
GROUP BY e.ad ORDER BY e.ad;
```

```text
EKIP           SATIR TOPLAM_CPU     DEPLOY
--------- ---------- ---------- ----------
arama           1250      10000       1250
mobil           1250      20000       1250
odeme           1250       5000       1250
platform        1250       2500       1250
```

Deploy sayısı doğru, ama arama ekibinin CPU'su 120'den 10.000'e çıktı. Sebep: Bir sunucunun her deploy'u için sunucu satırı bir kez **tekrarlandı**. Join, "bire çok" ilişkide bir taraftaki satırları çoğaltır, sonra `SUM` çoğaltılmış değerleri toplar. Sorgu hata vermez, sonuç makul görünebilir (özellikle ilişki seyrekse) ve raporda yıllarca yanlış kalabilir.

Çözüm: Çok taraflı tabloyu join'den **önce** ilişki anahtarına göre özetle:

```sql
SELECT e.ad AS ekip, SUM(s.cpu) AS toplam_cpu, SUM(dd.adet) AS deploy
FROM ekipler e
JOIN sunucular s ON s.ekip_id = e.id
LEFT JOIN (SELECT sunucu_id, COUNT(*) AS adet
           FROM deploylar GROUP BY sunucu_id) dd ON dd.sunucu_id = s.id
GROUP BY e.ad ORDER BY e.ad;
```

```text
EKIP      TOPLAM_CPU     DEPLOY
--------- ---------- ----------
arama            120       1250
mobil            240       1250
odeme             60       1250
platform          30       1250
```

Kontrol alışkanlığı: Join ekledikten sonra satır sayısı beklediğinden fazlaysa (ya da `COUNT(*)` ile `COUNT(DISTINCT anahtar)` farklıysa) çoklama vardır. `SUM(DISTINCT cpu)` bir çözüm değildir: İki sunucunun CPU'su aynıysa birini atar.

## LEFT JOIN'de koşul nereye yazılır?

"Her sunucu ve Kasım'da aldığı production deploy sayısı, hiç almayanlar 0 olarak":

```sql
SELECT s.ad, COUNT(d.id) AS prod_kasim
FROM sunucular s LEFT JOIN deploylar d ON d.sunucu_id = s.id
WHERE d.ortam = 'production' AND d.baslangic >= TIMESTAMP '2026-11-01 00:00:00'
GROUP BY s.ad ORDER BY s.ad;
```

```text
AD       PROD_KASIM
-------- ----------
srv-001           2
srv-004           3
srv-007           3
srv-010           2
...                         (toplam 20 sunucu)
```

60 sunucu yerine 20 geldi, sıfırlar yok. `LEFT JOIN`, eşleşmeyen sunucular için `d` sütunlarını NULL ile doldurur; sonra `WHERE d.ortam = 'production'` o NULL satırları eler. Sonuç, `INNER JOIN` ile aynıdır. Dış tablonun (`d`) koşulları **`ON`** içine yazılmalı:

```sql
SELECT s.ad, COUNT(d.id) AS prod_kasim
FROM sunucular s LEFT JOIN deploylar d
  ON  d.sunucu_id = s.id
  AND d.ortam = 'production'
  AND d.baslangic >= TIMESTAMP '2026-11-01 00:00:00'
GROUP BY s.ad ORDER BY s.ad;
```

```text
AD       PROD_KASIM
-------- ----------
srv-001           2
srv-002           0
srv-003           0
srv-004           3
...                         (toplam 60 sunucu)
```

Kural: `ON` **hangi satırların eşleşeceğini**, `WHERE` **sonuçtan hangi satırların kalacağını** belirler. `INNER JOIN`'de ikisi aynı sonucu verir, `LEFT JOIN`'de vermez. `COUNT(*)` yerine `COUNT(d.id)` kullanmak da önemli: Eşleşmeyen satırda `COUNT(*)` 1 sayar, `COUNT(d.id)` NULL'u saymaz.

### Eski sözdizimi: `(+)`

Eski Oracle kodlarında dış join şöyle yazılır, okuyabilmen gerekir:

```sql
SELECT COUNT(*)
FROM sunucular s, deploylar d
WHERE d.sunucu_id(+) = s.id            -- (+) "eksik olabilecek" taraftadır: d
  AND d.durum(+) = 'basarisiz';        -- dış tablonun her koşulunda (+) olmalı
```

Dış tablonun bir koşulunda `(+)` unutulursa, yukarıdaki `WHERE` hatasının aynısı olur. Yeni kodda her zaman ANSI `JOIN ... ON` kullan.

## Yarı join ve anti join: EXISTS

"Kasım'da deploy almış ama şu an çalışmayan sunucular": Sunucuları listeliyoruz, deploy'lar sadece bir **varlık koşulu**. Join kullanırsak her deploy için sunucu tekrarlanır (`DISTINCT` gerekir). `EXISTS` ilk eşleşmeyi bulunca durur ve satırı çoğaltmaz:

```sql
SELECT s.ad, s.durum FROM sunucular s
WHERE s.durum <> 'calisiyor'
  AND EXISTS (SELECT 1 FROM deploylar d
              WHERE d.sunucu_id = s.id
                AND d.baslangic >= TIMESTAMP '2026-11-01 00:00:00')
ORDER BY s.ad;
```

```text
AD       DURUM
-------- ----------
srv-017  bakimda
srv-029  kapali
srv-034  bakimda
srv-051  bakimda
srv-058  kapali
```

Kapalı bir sunucuya hâlâ deploy gidiyorsa, deploy hattının envanteri güncel değil demektir: Gerçek bir operasyon sorusu.

**Anti join**, "hiç ... olmayanlar": production'a hiç deploy almamış sunucular.

```sql
SELECT COUNT(*) AS prod_almamis FROM sunucular s
WHERE NOT EXISTS (SELECT 1 FROM deploylar d
                  WHERE d.sunucu_id = s.id AND d.ortam = 'production');
-- 40
```

Aynı soruyu `NOT IN` ile de yazabilirsin ve burada aynı sonucu verir, çünkü `deploylar.sunucu_id` `NOT NULL`. Ama önceki dersteki gibi alt sorgu tek bir NULL döndürürse `NOT IN` hiçbir satır döndürmez. `NOT EXISTS` her zaman güvenlidir. Optimizer ikisini de genelde aynı verimli **anti join** planına çevirir, yani performans farkı yoktur.

`IN` ile `EXISTS` arasında da Oracle'da performans farkı yoktur; optimizer ikisini birbirine dönüştürebilir. Okunurluğa göre seç: sabit liste ya da tek sütunlu alt sorgu için `IN`, ilişkili koşullar için `EXISTS`.

## İlişkili alt sorgular ve LATERAL

**Skaler alt sorgu** `SELECT` listesinde tek bir değer döndürür:

```sql
SELECT u.ad AS uygulama,
       (SELECT MAX(d.baslangic) FROM deploylar d
        WHERE d.uygulama_id = u.id AND d.ortam = 'production') AS son_prod
FROM uygulamalar u ORDER BY u.id;
```

```text
UYGULAMA      SON_PROD
------------- ----------------------------
api-gateway   09-NOV-26 12.00.48.000000 AM
auth          08-NOV-26 01.31.03.000000 AM
odeme-api     08-NOV-26 03.48.54.000000 PM
...
```

Skaler alt sorgu dış sorgunun her satırı için çalışır (Oracle sonuçlarını önbelleğe alsa da). 8 uygulama için sorun değil, 1 milyon satırda ciddi bir sorundur. Büyük veride önce gruplayıp join etmek ya da analitik fonksiyonlar (sonraki ders) daha iyidir.

Skaler alt sorgu **tek değer** döndürebilir. "Her uygulamanın son 2 production deploy'unun sürümü ve durumu" gibi birden çok satır ve sütun gerektiğinde **`LATERAL`** (ya da Oracle'ın da desteklediği `CROSS APPLY` / `OUTER APPLY`) kullanılır. Bunlar, sağdaki alt sorgunun soldaki tablonun sütunlarına başvurmasına izin verir:

```sql
SELECT u.ad AS uygulama, d.surum, d.durum, TO_CHAR(d.baslangic, 'YYYY-MM-DD HH24:MI') AS baslangic
FROM uygulamalar u
CROSS APPLY (SELECT surum, durum, baslangic FROM deploylar d
             WHERE d.uygulama_id = u.id AND d.ortam = 'production'
             ORDER BY d.baslangic DESC
             FETCH FIRST 2 ROWS ONLY) d
WHERE u.ekip_id = 2
ORDER BY u.ad, d.baslangic DESC;
```

```text
UYGULAMA      SURUM    DURUM        BASLANGIC
------------- -------- ------------ ----------------
fatura        v5.19.5  basarili     2026-11-09 05:06
fatura        v5.19.1  basarili     2026-11-07 17:19
odeme-api     v5.19.6  basarili     2026-11-08 15:48
odeme-api     v5.19.2  basarili     2026-11-07 03:01
```

`CROSS APPLY` iç join gibi davranır (alt sorgu satır döndürmezse soldaki satır düşer), `OUTER APPLY` dış join gibi (soldaki satır NULL'larla kalır). `(uygulama_id, ortam, baslangic)` üzerinde bir indeks varsa her uygulama için sadece 2 satır okunur. Az sayıda grup ve büyük bir tablo için bu, bütün tabloyu sıralayan analitik çözümden çok daha hızlıdır.

## Küme operatörleri

```sql
-- başarısız deploy alan VE OOM hatası yaşayan sunucular
SELECT COUNT(*) FROM (
  SELECT sunucu_id FROM deploylar WHERE durum = 'basarisiz'
  INTERSECT
  SELECT sunucu_id FROM olaylar WHERE seviye = 'ERROR' AND mesaj LIKE 'OOM%');
-- 20

-- production deploy'u almamış sunucular: MINUS (Oracle) ya da EXCEPT (standart, 21c+)
SELECT COUNT(*) FROM (
  SELECT id FROM sunucular
  MINUS
  SELECT sunucu_id FROM deploylar WHERE ortam = 'production');
-- 40

SELECT COUNT(*) AS union_all FROM (SELECT ekip_id FROM sunucular UNION ALL SELECT ekip_id FROM uygulamalar);
SELECT COUNT(*) AS union_    FROM (SELECT ekip_id FROM sunucular UNION     SELECT ekip_id FROM uygulamalar);
```

```text
 UNION_ALL
----------
        68

    UNION_
----------
         4
```

`UNION`, `INTERSECT` ve `MINUS` **tekrarları kaldırır**, bunun için bir sıralama ya da hash işlemi yapar. Tekrar olmayacağını bildiğin ya da tekrarları istediğin durumda `UNION ALL` kullan: Hem daha hızlı hem de "kaybolan satır" sürprizi yaşatmaz. Küme operatörleri NULL'ları eşit sayar; bu, `=` karşılaştırmasından farklıdır ve iki tablo arasındaki farkı bulmak için kullanışlıdır:

```sql
-- iki ortamdaki yapılandırma tablosunun farkı (her iki yön)
(SELECT * FROM ayarlar_staging MINUS SELECT * FROM ayarlar_prod)
UNION ALL
(SELECT * FROM ayarlar_prod MINUS SELECT * FROM ayarlar_staging);
```

## Ara toplamlar: ROLLUP, CUBE, GROUPING SETS

Raporlarda grup satırlarının yanında ara ve genel toplamlar istenir. Bunu `UNION ALL` ile üç ayrı sorgu birleştirerek yapmak yerine:

```sql
SELECT CASE WHEN GROUPING(e.ad) = 1 THEN 'TOPLAM' ELSE e.ad END AS ekip,
       CASE WHEN GROUPING(d.ortam) = 1 AND GROUPING(e.ad) = 0 THEN 'ara toplam' ELSE d.ortam END AS ortam,
       COUNT(*) AS deploy,
       SUM(CASE WHEN d.durum <> 'basarili' THEN 1 ELSE 0 END) AS sorunlu
FROM deploylar d
JOIN uygulamalar u ON u.id = d.uygulama_id
JOIN ekipler e ON e.id = u.ekip_id
GROUP BY ROLLUP (e.ad, d.ortam)
ORDER BY GROUPING(e.ad), e.ad, GROUPING(d.ortam), d.ortam;
```

```text
EKIP      ORTAM           DEPLOY    SORUNLU
--------- ----------- ---------- ----------
arama     production         416         27
arama     staging            834         55
arama     ara toplam        1250         82
mobil     production         417         28
mobil     staging            833         55
mobil     ara toplam        1250         83
odeme     production         417         28
odeme     staging            833         55
odeme     ara toplam        1250         83
platform  production         416         28
platform  staging            834         57
platform  ara toplam        1250         85
TOPLAM                      5000        333
```

- `ROLLUP (a, b)`: `(a, b)`, `(a)` ve `()` gruplarını üretir: hiyerarşik ara toplamlar.
- `CUBE (a, b)`: bütün kombinasyonlar, `(b)` dahil.
- `GROUPING SETS ((a, b), (b), ())`: tam olarak istediğin grupları seçersin.
- `GROUPING(sutun)`: O satırda sütun "toplam için" NULL yapılmışsa 1 döner. Gerçek NULL değerlerle ara toplam satırlarını ayırt etmenin tek güvenilir yolu budur.

Tek tablo taranır, bütün gruplar tek geçişte hesaplanır.

## PIVOT: satırları sütunlara çevirmek

```sql
SELECT * FROM (
  SELECT u.ad AS uygulama, d.durum
  FROM deploylar d JOIN uygulamalar u ON u.id = d.uygulama_id
)
PIVOT (COUNT(*) FOR durum IN ('basarili' AS basarili, 'basarisiz' AS basarisiz, 'geri_alindi' AS geri_alindi))
ORDER BY uygulama;
```

```text
UYGULAMA        BASARILI  BASARISIZ GERI_ALINDI
------------- ---------- ---------- -----------
api-gateway          583         27          15
arama-api            584         27          14
auth                 582         27          16
bildirim             583         28          14
...
```

`PIVOT`'ta sütun listesi sorgu yazılırken bilinmelidir (dinamik sütun yoktur, gerekiyorsa dinamik SQL). Alt sorgudaki her sütun, pivot edilmeyenler gruplama anahtarı olur. Bu yüzden alt sorguya sadece gereken sütunları koy, yoksa beklenmedik bir şekilde gruplanır. Aynı sonucu taşınabilir şekilde **koşullu toplama** ile de alırsın ve genellikle daha esnektir:

```sql
SELECT u.ad AS uygulama,
       COUNT(*) AS toplam,
       COUNT(CASE WHEN d.durum = 'basarisiz' THEN 1 END) AS basarisiz,
       ROUND(100 * COUNT(CASE WHEN d.durum = 'basarisiz' THEN 1 END) / COUNT(*), 2) AS yuzde
FROM deploylar d JOIN uygulamalar u ON u.id = d.uygulama_id
GROUP BY u.ad
ORDER BY yuzde DESC FETCH FIRST 3 ROWS ONLY;
```

```text
UYGULAMA          TOPLAM  BASARISIZ      YUZDE
------------- ---------- ---------- ----------
bildirim             625         28       4.48
auth                 625         27       4.32
fatura               625         27       4.32
```

(`auth` ve `fatura` eşit; `ORDER BY`'a ikinci bir anahtar eklemezsen hangisinin önce geleceği garanti değil.)

## Alıştırma

1. Her **bölge** için: sunucu sayısı, toplam CPU ve bu bölgedeki sunuculara yapılmış **başarısız** deploy sayısı. Çoklama tuzağına düşme; ipucu: Başarısız deploy'u olmayan bir bölge olsaydı da 0 ile görünmeli.
2. Son 30 günde (verideki son olay 16 Kasım 2026, yani 17 Ekim–16 Kasım) hiç ERROR olayı olmayan **ekipleri** bul. Sonuç boş çıkarsa, sorgunun doğru çalıştığını nasıl doğrularsın?
3. `ROLLUP` ile: bölge → durum kırılımında sunucu sayısı, bölge ara toplamları ve genel toplam.

<details><summary>Çözüm</summary>

```sql
SELECT s.bolge, COUNT(*) AS sunucu, SUM(s.cpu) AS cpu, NVL(SUM(b.adet), 0) AS basarisiz
FROM sunucular s
LEFT JOIN (SELECT sunucu_id, COUNT(*) AS adet FROM deploylar
           WHERE durum = 'basarisiz' GROUP BY sunucu_id) b ON b.sunucu_id = s.id
GROUP BY s.bolge ORDER BY s.bolge;
```

```text
BOLGE          SUNUCU        CPU  BASARISIZ
---------- ---------- ---------- ----------
ams                20        150         72
fra                20        150         72
ist                20        150         73
```

Deploy'lar önce sunucu başına özetlendi, sonra join edildi: CPU toplamları çoklanmadı. `NVL(SUM(...), 0)`: Hiç eşleşmesi olmayan bir bölge NULL yerine 0 gösterir.

```sql
SELECT e.ad FROM ekipler e
WHERE NOT EXISTS (
  SELECT 1 FROM sunucular s JOIN olaylar o ON o.sunucu_id = s.id
  WHERE s.ekip_id = e.id
    AND o.seviye = 'ERROR'
    AND o.zaman >= TIMESTAMP '2026-10-17 00:00:00');
-- satır yok
```

Örnek veride her ekibin hata olayı var, sonuç boş. Doğrulamak için tersini sor: `NOT EXISTS`'i `EXISTS` yap ve 4 ekibin hepsinin geldiğini gör, ya da koşulu daralt (örneğin `o.mesaj LIKE 'disk dolu%'` ve tek bir gün) ve bazı ekiplerin listeye girdiğini gözle. Boş sonuç döndüren bir sorguyu "çalışıyor" saymadan önce, sonuç döndürmesi gereken bir durumda denemek iyi bir alışkanlıktır.

```sql
SELECT CASE WHEN GROUPING(s.bolge) = 1 THEN 'TOPLAM' ELSE s.bolge END AS bolge,
       CASE WHEN GROUPING(s.durum) = 1 AND GROUPING(s.bolge) = 0 THEN 'ara toplam' ELSE s.durum END AS durum,
       COUNT(*) AS sunucu
FROM sunucular s
GROUP BY ROLLUP (s.bolge, s.durum)
ORDER BY GROUPING(s.bolge), s.bolge, GROUPING(s.durum), s.durum;
```

```text
BOLGE      DURUM          SUNUCU
---------- ---------- ----------
ams        bakimda             1
ams        calisiyor          18
ams        kapali              1
ams        ara toplam         20
fra        bakimda             1
fra        calisiyor          18
fra        kapali              1
fra        ara toplam         20
ist        bakimda             1
ist        calisiyor          19
ist        ara toplam         20
TOPLAM                        60
```

Neden `s.` öneki? Takma adlar sütun adlarıyla aynı (`AS bolge`, `AS durum`). `ORDER BY durum` yazarsan Oracle önce **takma adı** kullanır, yani içinde `GROUPING` olan `CASE` ifadesini, ve `ORA-00934: group function is not allowed here` verir. `s.durum` diye nitelendirmek, takma adı değil tablodaki sütunu kastettiğini belli eder.

</details>

```quiz
`ekipler JOIN sunucular LEFT JOIN deploylar` sonrası `SUM(sunucular.cpu)` neden yanlış çıkar?
- LEFT JOIN NULL değerleri toplar
- [x] Her sunucu satırı deploy sayısı kadar tekrarlanır, SUM tekrarlanan değerleri toplar
- SUM, LEFT JOIN ile kullanılamaz
? Çok taraflı tabloyu join'den önce anahtara göre özetle.
```

```quiz
`FROM a LEFT JOIN b ON a.id = b.a_id WHERE b.durum = 'aktif'` sorgusu neye dönüşür?
- Değişmez, LEFT JOIN olarak kalır
- [x] Fiilen INNER JOIN: eşleşmeyen satırlarda b.durum NULL olduğu için WHERE onları eler
- CROSS JOIN
? b'nin koşulunu ON içine taşı.
```

```quiz
`UNION` yerine `UNION ALL` ne zaman tercih edilmeli?
- Hiçbir zaman, UNION daha güvenlidir
- [x] Tekrar olmayacağını bildiğinde ya da tekrarlar istendiğinde: tekrar kaldırma maliyeti olmaz, satır kaybolmaz
- Sadece iki tablo aynı şemadaysa
? UNION, INTERSECT ve MINUS tekrarları kaldırmak için sıralama/hash yapar.
```

## Özet

- Bire çok join satırları çoğaltır: Toplamları join'den önce özetle. `COUNT(*)` ile `COUNT(DISTINCT anahtar)` farkı çoklamayı ele verir.
- `LEFT JOIN`'de dış tablonun koşulları `ON`'a; `COUNT(dis.id)` ile eşleşmeyenler 0 olur. Eski `(+)` sözdizimini okuyabil.
- Varlık koşulları için `EXISTS` / `NOT EXISTS` (yarı/anti join, satır çoğaltmaz, NULL tuzağı yok).
- `CROSS APPLY` / `OUTER APPLY` / `LATERAL`: her satır için ilk N. Skaler alt sorgular büyük veride pahalıdır.
- `UNION ALL` varsayılan olsun. `MINUS`/`EXCEPT` ile iki tablonun farkı.
- `ROLLUP`, `CUBE`, `GROUPING SETS` ve `GROUPING()` ile ara toplamlar; `PIVOT` ya da koşullu toplama.
