# Analitik fonksiyonlar: sıralama, pencereler, toplamlar

`GROUP BY` satırları **birleştirir**: 5.000 deploy, 8 uygulama satırına iner. Analitik (window) fonksiyonlar ise her satırı **korur** ve yanına, o satırla ilişkili bir grup üzerinden hesaplanmış bir değer ekler: "bu sunucunun bölgesindeki toplam CPU", "bu deploy'dan önceki deploy", "şimdiye kadarki kümülatif toplam". Raporlama SQL'inin belki de en güçlü aracıdır ve onlarca satırlık self-join'leri ve PL/SQL döngülerini tek bir sorguya indirir.

## OVER: satırı koruyarak toplamak

```sql
SELECT ad, bolge, cpu,
       SUM(cpu) OVER (PARTITION BY bolge)                        AS bolge_cpu,
       ROUND(100 * cpu / SUM(cpu) OVER (PARTITION BY bolge), 1)  AS pay_yuzde,
       ROUND(100 * RATIO_TO_REPORT(cpu) OVER (PARTITION BY bolge), 1) AS ratio
FROM sunucular WHERE id <= 6
ORDER BY bolge, ad;
```

```text
AD       BOLGE             CPU  BOLGE_CPU  PAY_YUZDE      RATIO
-------- ---------- ---------- ---------- ---------- ----------
srv-002  ams                 8         12       66.7       66.7
srv-005  ams                 4         12       33.3       33.3
srv-001  fra                 4          6       66.7       66.7
srv-004  fra                 2          6       33.3       33.3
srv-003  ist                16         24       66.7       66.7
srv-006  ist                 8         24       33.3       33.3
```

Bir analitik fonksiyonun üç parçası var:

```text
fonksiyon(...) OVER ( PARTITION BY ...   -- hangi satırlar bir grup (yoksa: bütün sonuç)
                      ORDER BY ...       -- grup içi sıra (sıralama ve kayan pencereler için)
                      ROWS/RANGE ... )   -- pencere: sıralı grupta hangi satırlar hesaba katılır
```

Analitik fonksiyonlar `WHERE`, `GROUP BY` ve `HAVING`'den **sonra**, `ORDER BY`'dan önce hesaplanır. Bu yüzden `WHERE` içinde kullanılamazlar: Sonuçlarına göre filtrelemek için bir alt sorgu ya da (23ai/26ai'de) `QUALIFY` gerekir. `RATIO_TO_REPORT`, "toplam içindeki pay"ı hesaplayan Oracle'a özgü bir kısayoldur.

## Sıralama: ROW_NUMBER, RANK, DENSE_RANK

```sql
SELECT ad, cpu,
       ROW_NUMBER() OVER (ORDER BY cpu DESC) AS row_number,
       RANK()       OVER (ORDER BY cpu DESC) AS rank,
       DENSE_RANK() OVER (ORDER BY cpu DESC) AS dense_rank
FROM sunucular WHERE ekip_id = 1 OR id IN (1, 2, 3)
ORDER BY cpu DESC, ad FETCH FIRST 8 ROWS ONLY;
```

```text
AD              CPU ROW_NUMBER       RANK DENSE_RANK
-------- ---------- ---------- ---------- ----------
srv-003          16          1          1          1
srv-002           8          2          2          2
srv-001           4          3          3          3
srv-004           2          4          4          4
srv-008           2          5          4          4
srv-012           2          6          4          4
srv-016           2          7          4          4
srv-020           2          8          4          4
```

- `ROW_NUMBER`: her satıra benzersiz bir numara. Eşitler arasındaki sıra **rastgeledir**; deterministik olması için `ORDER BY`'a benzersiz bir anahtar ekle.
- `RANK`: eşitlere aynı sıra, sonra boşluk (4, 4, 4, 4, 4, sonra 9).
- `DENSE_RANK`: eşitlere aynı sıra, boşluk yok (4, 4, ..., sonra 5).

### Her grubun ilk N'i

"Her uygulamanın production'daki en uzun süren deploy'u": analitik fonksiyonların en sık kullanımı.

```sql
SELECT uygulama, surum, TO_CHAR(baslangic, 'YYYY-MM-DD HH24:MI') AS baslangic, sure_sn
FROM (
  SELECT u.ad AS uygulama, d.surum, d.baslangic, d.sure_sn,
         ROW_NUMBER() OVER (PARTITION BY d.uygulama_id ORDER BY d.sure_sn DESC, d.id) AS rn
  FROM deploylar d JOIN uygulamalar u ON u.id = d.uygulama_id
  WHERE d.ortam = 'production')
WHERE rn = 1
ORDER BY sure_sn DESC, uygulama;
```

```text
UYGULAMA     SURUM    BASLANGIC           SURE_SN
------------ -------- ---------------- ----------
fatura       v1.7.3   2026-01-23 16:59        627
mobil-bff    v1.2.6   2026-01-08 21:09        624
auth         v1.9.9   2026-01-31 14:09        621
arama-api    v1.5.2   2026-01-16 18:19        618
bildirim     v1.0.5   2026-01-01 23:29        615
odeme-api    v1.7.8   2026-01-24 15:29        612
indeksleyici v1.2.1   2026-01-09 19:39        609
api-gateway  v1.10.4  2026-02-01 12:39        606
```

26ai'de aynı şeyi alt sorgu olmadan `QUALIFY` ile yazabilirsin (analitik fonksiyonlar için `HAVING` gibi düşün):

```sql
SELECT u.ad AS uygulama, d.surum, d.sure_sn
FROM deploylar d JOIN uygulamalar u ON u.id = d.uygulama_id
WHERE d.ortam = 'production'
QUALIFY ROW_NUMBER() OVER (PARTITION BY d.uygulama_id ORDER BY d.sure_sn DESC, d.id) = 1
ORDER BY d.sure_sn DESC, uygulama;
```

`rn = 1` yerine `rn <= 3` her grubun ilk 3'ünü verir. Eşitler de dahil olsun istiyorsan `RANK` kullan. Önceki dersteki `CROSS APPLY ... FETCH FIRST` ile karşılaştır: Analitik yöntem bütün satırları okuyup sıralar, çok sayıda grup için iyidir. `CROSS APPLY` her grup için indeksten birkaç satır okur, az sayıda grup ve büyük tablo için iyidir.

### KEEP: "son kaydın değeri"

Sadece "her uygulamanın son production sürümü" gerekiyorsa, Oracle'ın `KEEP` sözdizimi alt sorgusuz bir toplama fonksiyonudur:

```sql
SELECT u.ad AS uygulama,
       MAX(d.surum) KEEP (DENSE_RANK LAST ORDER BY d.baslangic) AS son_surum,
       MAX(d.surum) AS max_surum_yanlis
FROM deploylar d JOIN uygulamalar u ON u.id = d.uygulama_id
WHERE d.ortam = 'production' AND d.uygulama_id IN (1, 2, 3)
GROUP BY u.ad ORDER BY u.ad;
```

```text
UYGULAMA     SON_SURUM  MAX_SURUM_YANLIS
------------ ---------- ----------------
api-gateway  v5.19.2    v5.9.8
auth         v5.19.7    v5.9.7
odeme-api    v5.19.6    v5.9.8
```

`KEEP (DENSE_RANK LAST ORDER BY baslangic)`: "`baslangic`'e göre son satır(lar)ı tut, onların `surum`'unun `MAX`'ını al." Yanındaki sütun, sık yapılan bir hatayı gösteriyor: `MAX(surum)` sürümleri **metin olarak** karşılaştırır ve `'v5.9.8' > 'v5.19.2'` çünkü `'9' > '1'`. "En yüksek sürüm" demek "en son sürüm" demek değildir, ve metin olarak "en yüksek" ikisi de değildir.

## LAG ve LEAD: önceki ve sonraki satır

"Ödeme API'sinin production deploy'ları arasında kaç saat geçmiş?"

```sql
SELECT surum, durum, TO_CHAR(baslangic, 'MM-DD HH24:MI') AS baslangic,
       LAG(surum) OVER (ORDER BY baslangic) AS onceki,
       ROUND((CAST(baslangic AS DATE)
            - CAST(LAG(baslangic) OVER (ORDER BY baslangic) AS DATE)) * 24, 1) AS saat_arasi
FROM deploylar
WHERE uygulama_id = 3 AND ortam = 'production'
  AND baslangic >= TIMESTAMP '2026-10-20 00:00:00'
ORDER BY baslangic FETCH FIRST 6 ROWS ONLY;
```

```text
SURUM    DURUM        BASLANGIC        ONCEKI   SAAT_ARASI
-------- ------------ ---------------- -------- ----------
v5.13.4  geri_alindi  10-20 03:30
v5.13.8  basarili     10-21 15:17      v5.13.4        35.8
v5.14.2  basarili     10-23 03:05      v5.13.8        35.8
v5.14.6  basarili     10-24 15:52      v5.14.2        36.8
v5.15.0  basarili     10-26 03:40      v5.14.6        35.8
v5.15.4  basarili     10-27 15:28      v5.15.0        35.8
```

`LAG(x, n, varsayilan)`: n satır öncesi (varsayılan 1), yoksa `varsayilan`. `LEAD` ise sonrakidir. `TIMESTAMP` farkı bir `INTERVAL` döndürdüğü için, saat cinsinden sayı elde etmek amacıyla `DATE`'e çevirip farkı 24 ile çarptık. Tipik kullanımlar: iki ölçüm arasındaki değişim (sayaç değerlerinden hız hesaplama), oturumlar arası boşluk, "durum ne zaman değişti".

## Pencereler: kümülatif ve kayan hesaplar

`OVER` içinde `ORDER BY` olduğunda, toplama fonksiyonları varsayılan olarak "baştan bu satıra kadar" hesaplanır. Sorunlu (başarısız ya da geri alınmış) deploy'ların aylık sayısı, kümülatif toplamı ve 3 aylık hareketli ortalaması:

```sql
SELECT TO_CHAR(TRUNC(baslangic, 'MM'), 'YYYY-MM') AS ay,
       COUNT(*) AS deploy,
       SUM(COUNT(*)) OVER (ORDER BY TRUNC(baslangic, 'MM')) AS kumulatif,
       ROUND(AVG(COUNT(*)) OVER (ORDER BY TRUNC(baslangic, 'MM')
                                 ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 1) AS hareketli_3ay
FROM deploylar
WHERE durum <> 'basarili'
GROUP BY TRUNC(baslangic, 'MM')
ORDER BY 1;
```

```text
AY          DEPLOY  KUMULATIF HAREKETLI_3AY
------- ---------- ---------- -------------
2026-01         33         33            33
2026-02         30         63          31.5
2026-03         33         96            32
...
2026-10         33        324          32.7
2026-11          9        333          24.7
```

`SUM(COUNT(*)) OVER (...)`: İç `COUNT(*)` `GROUP BY` toplamasıdır, dış `SUM ... OVER` o grup satırları üzerinde çalışan analitik fonksiyondur. Bu iç içe kullanım Oracle'da geçerlidir ve çok pratiktir. Kasım'ın düşük değeri bir anomali değil, verinin 9 Kasım'da bitmesi: Kısmi dönemler hareketli ortalamaları yanıltır.

### ROWS ve RANGE farkı

```sql
WITH t(gun, adet) AS (VALUES (1, 10), (2, 20), (2, 5), (3, 30))
SELECT gun, adet,
       SUM(adet) OVER (ORDER BY gun)                         AS varsayilan_range,
       SUM(adet) OVER (ORDER BY gun ROWS UNBOUNDED PRECEDING) AS rows_
FROM t ORDER BY gun, adet DESC;
```

```text
       GUN       ADET VARSAYILAN_RANGE      ROWS_
---------- ---------- ---------------- ----------
         1         10               10         10
         2         20               35         30
         2          5               35         35
         3         30               65         65
```

`ORDER BY` verip pencere belirtmezsen varsayılan `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` olur. `RANGE` mantıksal değere bakar: Aynı `gun` değerine sahip satırların hepsi "mevcut satır" sayılır, bu yüzden 2. gündeki iki satır da 35 gösteriyor. `ROWS` ise fiziksel satır sayar. Sıralama anahtarı benzersiz değilse kümülatif toplamın satır satır artmasını istiyorsan `ROWS` yaz (ve eşitlerin sırası için `ORDER BY`'a bir anahtar daha ekle).

`RANGE` ise değer aralıkları için kullanışlıdır: `RANGE BETWEEN INTERVAL '1' HOUR PRECEDING AND CURRENT ROW` "son bir saatteki olaylar" demektir. Satır sayısı ne olursa olsun zaman penceresidir. Bir log tablosunda "her olayda, son 5 dakikadaki ERROR sayısı" bu şekilde hesaplanır.

### LAST_VALUE tuzağı

```sql
SELECT ad, cpu,
       FIRST_VALUE(ad) OVER (ORDER BY cpu, ad) AS ilk,
       LAST_VALUE(ad)  OVER (ORDER BY cpu, ad) AS son_yanlis,
       LAST_VALUE(ad)  OVER (ORDER BY cpu, ad
                             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS son
FROM sunucular WHERE id <= 4 ORDER BY cpu, ad;
```

```text
AD              CPU ILK      SON_YANLIS SON
-------- ---------- -------- ---------- --------
srv-004           2 srv-004  srv-004    srv-003
srv-001           4 srv-004  srv-001    srv-003
srv-002           8 srv-004  srv-002    srv-003
srv-003          16 srv-004  srv-003    srv-003
```

`LAST_VALUE` her satırda **kendini** döndürdü, çünkü varsayılan pencere "mevcut satıra kadar" ve o pencerenin son satırı mevcut satırdır. Ya pencereyi `UNBOUNDED FOLLOWING`'e kadar aç, ya da daha basiti: `FIRST_VALUE(ad) OVER (ORDER BY cpu DESC, ad DESC)`.

## Yüzdelikler

Ortalama, deploy ve yanıt süreleri gibi çarpık dağılımları iyi anlatmaz. Operasyonda p50 (medyan) ve p95/p99 kullanılır:

```sql
SELECT u.ad AS uygulama,
       ROUND(AVG(d.sure_sn)) AS ort,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY d.sure_sn) AS p50,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY d.sure_sn) AS p95,
       MAX(d.sure_sn) AS en_uzun
FROM deploylar d JOIN uygulamalar u ON u.id = d.uygulama_id
WHERE d.ortam = 'production'
GROUP BY u.ad ORDER BY p95 DESC FETCH FIRST 4 ROWS ONLY;
```

```text
UYGULAMA            ORT        P50        P95    EN_UZUN
------------ ---------- ---------- ---------- ----------
fatura              339        339        603        627
mobil-bff           337        336        600        624
auth                332        333        597        621
arama-api           331        330        594        618
```

`PERCENTILE_CONT` değerler arasında enterpolasyon yapar, `PERCENTILE_DISC` ise gerçekten var olan bir değeri döndürür. Örnek veri düzgün dağıldığı için ortalama ve medyan çok yakın; gerçek yanıt süresi verisinde p95 genellikle ortalamanın katları kadar olur. Her ikisi de `OVER (PARTITION BY ...)` ile analitik olarak da kullanılabilir.

Çok büyük tablolarda kesin yüzdelik bütün değerleri sıralamayı gerektirir. Yaklaşık sonuç yeterliyse:

```sql
SELECT APPROX_PERCENTILE(0.95) WITHIN GROUP (ORDER BY sure_sn) AS yaklasik_p95,
       APPROX_COUNT_DISTINCT(surum) AS yaklasik_surum,
       COUNT(DISTINCT surum) AS gercek_surum
FROM deploylar;
```

```text
YAKLASIK_P95 YAKLASIK_SURUM GERCEK_SURUM
------------ -------------- ------------
         601            997         1001
```

Yüz milyonlarca satırlık bir log tablosunda `APPROX_COUNT_DISTINCT` kesin olanın küçük bir kesrinde çalışır ve hata payı genellikle %1–2'dir: Panolar için ideal, faturalama için değil.

## Boşluklar ve adalar: kesintileri bulmak

Klasik bir operasyon sorusu: Her dakika yapılan sağlık kontrollerinde, kesintiler ne zaman başladı, ne kadar sürdü? Önce küçük bir tablo:

```sql
CREATE TABLE saglik (servis VARCHAR2(10), zaman DATE, sonuc VARCHAR2(4));
INSERT INTO saglik
SELECT 'odeme', DATE '2026-11-20' + (level - 1) / 1440,
       CASE WHEN level BETWEEN 4 AND 6 OR level BETWEEN 11 AND 15 OR level = 18
            THEN 'FAIL' ELSE 'OK' END
FROM dual CONNECT BY level <= 20;
COMMIT;
ALTER SESSION SET NLS_DATE_FORMAT = 'HH24:MI';
```

İki `ROW_NUMBER` farkı tekniği: Bütün satırlar içindeki sıra ile aynı sonuca sahip satırlar içindeki sıranın farkı, **ardışık** aynı değerli satırlar için sabit kalır:

```sql
SELECT zaman, sonuc,
       ROW_NUMBER() OVER (ORDER BY zaman) AS rn_hepsi,
       ROW_NUMBER() OVER (PARTITION BY sonuc ORDER BY zaman) AS rn_sonuc,
       ROW_NUMBER() OVER (ORDER BY zaman)
     - ROW_NUMBER() OVER (PARTITION BY sonuc ORDER BY zaman) AS grp
FROM saglik
WHERE zaman BETWEEN DATE '2026-11-20' + 2/1440 AND DATE '2026-11-20' + 7/1440
ORDER BY zaman;
```

```text
ZAMAN SONU   RN_HEPSI   RN_SONUC        GRP
----- ---- ---------- ---------- ----------
00:02 OK            1          1          0
00:03 FAIL          2          1          1
00:04 FAIL          3          2          1
00:05 FAIL          4          3          1
00:06 OK            5          2          3
00:07 OK            6          3          3
```

Ardışık FAIL'ler aynı `grp` değerini (1) aldı. Şimdi bu gruplara göre toplayınca her kesinti bir satır olur:

```sql
SELECT MIN(zaman) AS basla, MAX(zaman) AS bitis, COUNT(*) AS dakika
FROM (
  SELECT zaman, sonuc,
         ROW_NUMBER() OVER (ORDER BY zaman)
       - ROW_NUMBER() OVER (PARTITION BY sonuc ORDER BY zaman) AS grp
  FROM saglik WHERE servis = 'odeme')
WHERE sonuc = 'FAIL'
GROUP BY grp
ORDER BY basla;
```

```text
BASLA BITIS     DAKIKA
----- ----- ----------
00:03 00:05          3
00:10 00:14          5
00:17 00:17          1
```

### MATCH_RECOGNIZE

Oracle'ın satır desenleri için özel bir sözdizimi var: satırlar üzerinde düzenli ifade. Aynı soru, ama tek dakikalık "titreşimleri" (flapping) saymadan, en az 2 ardışık hata:

```sql
SELECT * FROM saglik
MATCH_RECOGNIZE (
  PARTITION BY servis ORDER BY zaman
  MEASURES FIRST(zaman) AS basla, LAST(zaman) AS bitis, COUNT(*) AS dakika
  ONE ROW PER MATCH
  PATTERN (hata{2,})
  DEFINE hata AS sonuc = 'FAIL'
);
```

```text
SERVIS     BASLA BITIS     DAKIKA
---------- ----- ----- ----------
odeme      00:03 00:05          3
odeme      00:10 00:14          5
```

`PATTERN` düzenli ifade sözdizimini kullanır (`+`, `*`, `{n,m}`, `|`), `DEFINE` her değişkenin hangi satıra uyduğunu tanımlar ve önceki satırlara (`PREV(sonuc)`) bakabilir. "CPU %90'ı 3 ölçüm üst üste geçti, sonra düştü", "fiyat düştü, sonra yükseldi" (V deseni) ya da "giriş başarısız × 5, sonra başarılı" (kaba kuvvet saldırısı) gibi desenler bununla birkaç satırda yazılır.

## Alıştırma

1. Her ekibin sunucularını CPU'ya göre sırala ve her ekipteki **en güçlü 2** sunucuyu getir (eşitlikte ada göre). Her satırda ekibin toplam CPU'su da görünsün.
2. Olaylar tablosunda her sunucu için, her ERROR olayının bir önceki ERROR'dan kaç dakika sonra geldiğini hesapla ve sunucu başına bu sürenin ortalamasını bul. İlk 3 sunucuyu getir.
3. `saglik` tablosunda her kesintinin kaç dakika sürdüğünü ve kesintiden **önceki son başarılı** kontrolün zamanını göster.

<details><summary>Çözüm</summary>

```sql
SELECT ekip, ad, cpu, ekip_cpu FROM (
  SELECT e.ad AS ekip, s.ad, s.cpu,
         SUM(s.cpu) OVER (PARTITION BY e.id) AS ekip_cpu,
         ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY s.cpu DESC, s.ad) AS rn
  FROM sunucular s JOIN ekipler e ON e.id = s.ekip_id)
WHERE rn <= 2
ORDER BY ekip, rn;
```

```text
EKIP      AD              CPU   EKIP_CPU
--------- -------- ---------- ----------
arama     srv-002           8        120
arama     srv-006           8        120
mobil     srv-003          16        240
mobil     srv-007          16        240
odeme     srv-001           4         60
odeme     srv-005           4         60
platform  srv-004           2         30
platform  srv-008           2         30
```

Örnek veride bir ekibin bütün sunucuları aynı CPU'ya sahip, bu yüzden "en güçlü 2" tamamen eşitlik bozucuya (`s.ad`) kaldı. Eşitlerin hepsini görmek isteseydin `RANK() ... <= 2` 15 satır döndürürdü.

```sql
SELECT sunucu_id, COUNT(*) AS hata, ROUND(AVG(dk_arasi), 1) AS ort_dk
FROM (
  SELECT sunucu_id,
         (CAST(zaman AS DATE) - CAST(LAG(zaman) OVER (PARTITION BY sunucu_id ORDER BY zaman) AS DATE)) * 1440 AS dk_arasi
  FROM olaylar WHERE seviye = 'ERROR')
GROUP BY sunucu_id
ORDER BY ort_dk, sunucu_id FETCH FIRST 3 ROWS ONLY;
```

```text
 SUNUCU_ID       HATA     ORT_DK
---------- ---------- ----------
         1         34       1940
         2         35       1940
         3         35       1940
```

Bütün sunucuların ortalaması aynı çıktı, çünkü örnek veri formülle, periyodik olarak üretildi: Her sunucuya tam olarak 5.820 olayda bir (97 × 60) hata düşüyor, bu da 1.940 dakika eder. Gerçek loglarda bu sorgu "sürekli hata veren" sunucuları en üste çıkarır.

`AVG` her sunucunun ilk hatasındaki NULL'u (öncesi yok) yok sayar. `COUNT(*)` ise bütün hataları sayar.

```sql
SELECT MIN(zaman) AS basla, MAX(zaman) AS bitis, COUNT(*) AS dakika, MIN(onceki_ok) AS onceki_ok
FROM (
  SELECT zaman, sonuc,
         MAX(CASE WHEN sonuc = 'OK' THEN zaman END) OVER (ORDER BY zaman ROWS UNBOUNDED PRECEDING) AS onceki_ok,
         ROW_NUMBER() OVER (ORDER BY zaman) - ROW_NUMBER() OVER (PARTITION BY sonuc ORDER BY zaman) AS grp
  FROM saglik)
WHERE sonuc = 'FAIL'
GROUP BY grp
ORDER BY basla;
```

```text
BASLA BITIS     DAKIKA ONCEK
----- ----- ---------- -----
00:03 00:05          3 00:02
00:10 00:14          5 00:09
00:17 00:17          1 00:16
```

`MAX(CASE WHEN sonuc = 'OK' THEN zaman END) OVER (... ROWS UNBOUNDED PRECEDING)`: "şimdiye kadarki en son OK zamanı". Bu kalıp, `LAST_VALUE(... IGNORE NULLS)` ile de yazılabilir ve bir boşluğu son bilinen değerle doldurmak için (forward fill) kullanılır.

</details>

```quiz
`SELECT ..., ROW_NUMBER() OVER (...) AS rn FROM t WHERE rn = 1` neden çalışmaz?
- ROW_NUMBER WHERE ile kullanılamaz, sadece ORDER BY ile kullanılır
- [x] Analitik fonksiyonlar WHERE'den sonra hesaplanır: alt sorgu ya da QUALIFY gerekir
- rn bir anahtar kelimedir
? 26ai'de `QUALIFY rn = 1` yazılabilir.
```

```quiz
`SUM(x) OVER (ORDER BY gun)` sıralama anahtarı benzersiz değilse ne olur?
- Hata verir
- [x] Varsayılan RANGE penceresi aynı gun değerine sahip bütün satırları birlikte sayar, kümülatif toplam satır satır artmaz
- Rastgele sonuç verir
? Satır satır artış için `ROWS UNBOUNDED PRECEDING` kullan.
```

```quiz
`MAX(surum)` neden "en son sürümü" vermeyebilir?
- MAX metinlerle çalışmaz
- [x] Metin karşılaştırması yapar ('v5.9' > 'v5.19') ve sürüm sırası zaman sırası değildir
- NULL'ları sayar
? Zamana göre son değer için `MAX(surum) KEEP (DENSE_RANK LAST ORDER BY baslangic)`.
```

## Özet

- `fonksiyon() OVER (PARTITION BY ... ORDER BY ... pencere)`: satırları koruyarak hesaplama. WHERE/GROUP BY'dan sonra çalışır, filtre için alt sorgu ya da `QUALIFY`.
- `ROW_NUMBER` / `RANK` / `DENSE_RANK`; her grubun ilk N'i. Deterministik sıra için benzersiz bir ek anahtar.
- `KEEP (DENSE_RANK FIRST/LAST ORDER BY ...)`: grubun ilk/son kaydının değeri.
- `LAG` / `LEAD`: önceki/sonraki satır, değişim ve aralıklar.
- Pencereler: kümülatif ve kayan hesaplar. `ROWS` fiziksel, `RANGE` mantıksal (zaman pencereleri). `LAST_VALUE` varsayılan pencere tuzağı.
- `PERCENTILE_CONT`, `APPROX_*` büyük veride.
- Boşluklar ve adalar (iki ROW_NUMBER farkı) ve `MATCH_RECOGNIZE` ile satır desenleri.
