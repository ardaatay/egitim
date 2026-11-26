# PL/SQL temelleri: bloklar, değişkenler, cursor'lar, hatalar

PL/SQL, Oracle'ın veritabanının içinde çalışan prosedürel dilidir: SQL'i değişkenler, koşullar, döngüler ve hata yönetimiyle birleştirir. Veriye en yakın yerde çalıştığı için, birden çok SQL ifadesinden oluşan bir işi (bir deploy kaydını açmak, sunucunun durumunu kontrol etmek, olay yazmak) tek bir ağ gidiş-dönüşüyle yapar. Birçok kurumsal sistemde iş kurallarının önemli bir kısmı PL/SQL paketlerindedir, ve bir veritabanını işleten herkes onları okuyup hata ayıklayabilmelidir.

Bu derste dilin temelleri ve en önemlisi **hata yönetimi**: Kötü yazılmış bir `EXCEPTION` bölümü, hataları sessizce yutup verinin bozulmasına yol açan en yaygın PL/SQL hatasıdır. Sondaki dinamik SQL bölümü ise bir güvenlik dersidir.

SQL\*Plus'ta `DBMS_OUTPUT` çıktısını görmek için oturum başında `SET SERVEROUTPUT ON` yap.

## Blok yapısı ve değişkenler

```sql
DECLARE
  v_sunucu  sunucular%ROWTYPE;              -- tablonun bir satırıyla aynı yapı
  v_adet    PLS_INTEGER;
  v_ad      sunucular.ad%TYPE := 'srv-017'; -- sütunla aynı tip
BEGIN
  SELECT * INTO v_sunucu FROM sunucular WHERE ad = v_ad;
  SELECT COUNT(*) INTO v_adet FROM deploylar WHERE sunucu_id = v_sunucu.id;

  DBMS_OUTPUT.PUT_LINE(v_sunucu.ad || ' ' || v_sunucu.bolge || ' ' || v_sunucu.durum || ', deploy: ' || v_adet);

  IF v_sunucu.durum = 'calisiyor' THEN
    DBMS_OUTPUT.PUT_LINE('normal');
  ELSIF v_sunucu.durum = 'bakimda' THEN
    DBMS_OUTPUT.PUT_LINE('bakımda, deploy almamalı');
  ELSE
    DBMS_OUTPUT.PUT_LINE('kapalı');
  END IF;
END;
/
```

```text
srv-017 ams bakimda, deploy: 83
bakımda, deploy almamalı
```

- Blok üç bölümdür: `DECLARE` (isteğe bağlı), `BEGIN ... END` ve isteğe bağlı `EXCEPTION`. SQL\*Plus'ta blok `/` ile çalıştırılır.
- **`%TYPE` ve `%ROWTYPE`**: Değişkenin tipini tablodan al. Sütun `VARCHAR2(30)`'dan `VARCHAR2(60 CHAR)`'a genişletildiğinde kod değişmeden doğru tipte kalır. Elle `VARCHAR2(30)` yazılmış değişkenler, sütun genişleyince `ORA-06502: numeric or value error` ile patlar.
- `PLS_INTEGER` tam sayı aritmetiği için `NUMBER`'dan hızlıdır (sayaçlar, indeksler için).
- PL/SQL'de SQL değişkenleri doğrudan kullanır: `WHERE ad = v_ad`. Bu otomatik olarak bir **bind değişkenidir**, enjeksiyon riski yoktur (dinamik SQL'de durum farklı, aşağıda).
- Ad çakışması tuzağı: Değişkenin adı bir sütun adıyla aynıysa (`WHERE ad = ad`), SQL sütunu kullanır ve koşul her zaman doğrudur. Bu yüzden `v_`, `p_` (parametre) gibi önekler gelenekseldir.

## SELECT INTO: tam olarak bir satır

`SELECT ... INTO` tam olarak **bir** satır bekler:

```sql
DECLARE
  v_id sunucular.id%TYPE;
BEGIN
  SELECT id INTO v_id FROM sunucular WHERE ad = 'srv-999';    -- hiç satır yok
END;
/
DECLARE
  v_id sunucular.id%TYPE;
BEGIN
  SELECT id INTO v_id FROM sunucular WHERE bolge = 'ist';     -- 20 satır
END;
/
```

```text
ORA-01403: no data found
ORA-06512: at line 4

ORA-01422: exact fetch returned more than the requested number of rows (1)
```

İkisi de bir hata olarak ele alınmalı, ama farklı anlamları var: `NO_DATA_FOUND` çoğu zaman beklenen bir iş durumudur ("böyle bir sunucu yok"), `TOO_MANY_ROWS` ise neredeyse her zaman bir veri ya da kod hatasıdır (benzersiz olması gereken bir şey değil). Beklenen durumu kendi yerinde yakala:

```sql
DECLARE
  v_id sunucular.id%TYPE;
BEGIN
  SELECT id INTO v_id FROM sunucular WHERE ad = 'srv-999';
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    DBMS_OUTPUT.PUT_LINE('sunucu bulunamadı');
END;
/
-- sunucu bulunamadı
```

Toplama fonksiyonları satır yoksa bile **bir** satır döndürür, bu yüzden hata vermez: `SELECT MAX(id) INTO v FROM sunucular WHERE ad = 'srv-999'` NULL döner. Bazen işe yarar, bazen bir hatayı gizler. Hangisini istediğini bil.

## Cursor'lar

Birden çok satırı işlemek için en okunur yol, **cursor FOR döngüsü**: Açma, okuma ve kapatma otomatik, ve Oracle satırları arka planda 100'lük gruplar halinde çeker:

```sql
DECLARE
  v_toplam PLS_INTEGER := 0;
BEGIN
  FOR r IN (SELECT s.ad, COUNT(d.id) AS basarisiz
            FROM sunucular s JOIN deploylar d ON d.sunucu_id = s.id
            WHERE d.durum = 'basarisiz' AND s.durum <> 'calisiyor'
            GROUP BY s.ad ORDER BY s.ad) LOOP
    DBMS_OUTPUT.PUT_LINE(RPAD(r.ad, 10) || r.basarisiz);
    v_toplam := v_toplam + r.basarisiz;
  END LOOP;
  DBMS_OUTPUT.PUT_LINE('toplam: ' || v_toplam);
END;
/
```

```text
srv-017   3
srv-029   4
srv-034   4
srv-051   4
srv-058   3
toplam: 18
```

Burada bir uyarı: Bu örnekte toplamı döngüde hesapladık, ama aynı sonucu SQL tek başına verirdi. **"Satır satır" (row-by-row) işleme, PL/SQL'deki en yaygın performans hatasıdır.** Bir işi önce tek bir SQL ifadesiyle yapmayı dene, olmuyorsa toplu işlemeyi (`BULK COLLECT`/`FORALL`, iki ders sonra), en son çare olarak satır satır döngüyü.

Açık (explicit) cursor'lar, parametreli sorgular ve `FETCH ... LIMIT` ile parti parti okuma için kullanılır. Transaction dersindeki iş kuyruğu örneği buydu.

### SQL%ROWCOUNT

Bir DML'in kaç satırı etkilediği, hemen ardından `SQL%ROWCOUNT` ile okunur:

```sql
BEGIN
  UPDATE sunucular SET durum = durum WHERE bolge = 'fra';
  DBMS_OUTPUT.PUT_LINE('güncellenen: ' || SQL%ROWCOUNT);
  UPDATE sunucular SET durum = durum WHERE ad = 'yok';
  IF SQL%ROWCOUNT = 0 THEN
    DBMS_OUTPUT.PUT_LINE('hiçbir satır güncellenmedi');
  END IF;
  ROLLBACK;
END;
/
-- güncellenen: 20
-- hiçbir satır güncellenmedi
```

`UPDATE` hiçbir satır bulamazsa hata **vermez**. "Sunucuyu bakıma al" diyen bir prosedür, yanlış bir id ile çağrıldığında sessizce başarılı görünür. `SQL%ROWCOUNT = 0` kontrolü bunu yakalamanın yoludur. İyimser kilitlemedeki (`WHERE surum = :okunan`) çakışma tespiti de buna dayanır.

## Hata yönetimi

### Kendi hatalarını fırlatmak

İş kuralı ihlallerini, uygulamanın tanıyabileceği numaralarla fırlat. `-20000` ile `-20999` arası uygulama hataları için ayrılmıştır:

```sql
DECLARE
  v_durum sunucular.durum%TYPE;
BEGIN
  SELECT durum INTO v_durum FROM sunucular WHERE id = 17;
  IF v_durum <> 'calisiyor' THEN
    RAISE_APPLICATION_ERROR(-20010, 'srv-017 ' || v_durum || ' durumunda, deploy başlatılamaz');
  END IF;
END;
/
```

```text
ORA-20010: srv-017 bakimda durumunda, deploy başlatılamaz
ORA-06512: at line 9
```

Uygulama tarafında hata kodu (`20010`) ile eşleme yapılır: HTTP 409, kullanıcıya anlamlı bir mesaj. Hata numaralarını bir pakette sabit olarak tanımlayıp belgelemek, ekip büyüdükçe numara çakışmalarını önler.

Oracle'ın bir hatasını adıyla yakalamak için `PRAGMA EXCEPTION_INIT`:

```sql
DECLARE
  e_kilitli EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_kilitli, -54);    -- ORA-00054: kaynak meşgul (NOWAIT)
BEGIN
  ...
EXCEPTION
  WHEN e_kilitli THEN
    RAISE_APPLICATION_ERROR(-20020, 'Kayıt şu an başka biri tarafından düzenleniyor');
END;
```

### WHEN OTHERS THEN NULL: hatayı yutmak

```sql
BEGIN
  BEGIN
    INSERT INTO nobetler (kisi_id, baslangic, bitis) VALUES (99, SYSTIMESTAMP, SYSTIMESTAMP + 1);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  DBMS_OUTPUT.PUT_LINE('devam ediyoruz, hiçbir şey olmamış gibi');
END;
/
-- devam ediyoruz, hiçbir şey olmamış gibi
```

99 numaralı kişi yok, ekleme bir yabancı anahtar hatası verdi, ve **kimse bunu bilmiyor**. Bu kod üretimde çalıştığında nöbet kaydı oluşmaz, alarm kimseye gitmez, ve aylar sonra "neden kimse aranmadı?" sorusunun cevabı bu satırdır. Oracle derleyicisi bu kalıp için özel bir uyarı bile verir (`PLW-06009`).

Kurallar:

- Sadece **beklediğin ve ne yapacağını bildiğin** hataları yakala (`NO_DATA_FOUND`, `DUP_VAL_ON_INDEX`, kendi tanımladıkların).
- `WHEN OTHERS` kullanıyorsan, logla ve **yeniden fırlat** (`RAISE`). Yalnızca bir sistemin en dış katmanında (bir zamanlanmış işin ana döngüsü), hatayı logladıktan sonra sonraki kayda devam etmek bilinçli bir seçim olabilir.
- Hata yakalandığında transaction'ın yarım kalabileceğini unutma: İfade seviyesinde geri alma, önceki ifadeleri geri almaz.

### Hatanın nerede oluştuğu

```sql
CREATE OR REPLACE PROCEDURE ic_adim AS
  v NUMBER;
BEGIN
  v := 1 / 0;
END;
/
CREATE OR REPLACE PROCEDURE dis_adim AS
BEGIN
  ic_adim;
END;
/
BEGIN
  dis_adim;
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('hata: ' || SQLERRM);
    DBMS_OUTPUT.PUT_LINE('yer: ' || DBMS_UTILITY.FORMAT_ERROR_BACKTRACE);
    RAISE;
END;
/
```

```text
hata: ORA-01476: divisor is equal to zero
yer: ORA-06512: at "EGITIM.IC_ADIM", line 4
ORA-06512: at "EGITIM.DIS_ADIM", line 3
ORA-06512: at line 2

ORA-01476: divisor is equal to zero
ORA-06512: at line 7
ORA-06512: at "EGITIM.IC_ADIM", line 4
...
```

`SQLERRM` sadece hata mesajını verir. **`DBMS_UTILITY.FORMAT_ERROR_BACKTRACE`** ise hatanın **oluştuğu** yeri (hangi nesne, hangi satır) verir. Bir log tablosuna sadece `SQLERRM` yazan kod, hatanın yüzlerce satırlık bir paketin neresinde oluştuğunu kaybeder. `RAISE` ile yeniden fırlatılan hata, `ORA-06512` satırlarıyla bütün yığını taşımaya devam eder. Log kaydını transaction geri alınsa da kalıcı kılmanın yolu (otonom transaction) sonraki dersin konusu.

## Koleksiyonlar

Bellek içi diziler ve sözlükler. **İlişkisel dizi** (associative array) bir anahtar-değer haritasıdır:

```sql
DECLARE
  TYPE t_sayac IS TABLE OF PLS_INTEGER INDEX BY VARCHAR2(10);
  v_sayac t_sayac;
  v_k     VARCHAR2(10);
BEGIN
  FOR r IN (SELECT seviye FROM olaylar WHERE zaman >= TIMESTAMP '2026-11-16 00:00:00') LOOP
    IF v_sayac.EXISTS(r.seviye) THEN
      v_sayac(r.seviye) := v_sayac(r.seviye) + 1;
    ELSE
      v_sayac(r.seviye) := 1;
    END IF;
  END LOOP;

  v_k := v_sayac.FIRST;                 -- anahtarlar sıralı dolaşılır
  WHILE v_k IS NOT NULL LOOP
    DBMS_OUTPUT.PUT_LINE(RPAD(v_k, 6) || v_sayac(v_k));
    v_k := v_sayac.NEXT(v_k);
  END LOOP;
END;
/
```

```text
ERROR 13
INFO  1171
WARN  97
```

(Yine: Gerçekte bu bir `GROUP BY`'dır. Koleksiyonlar, SQL ile ifade edilemeyen bellek içi işler, önbellekler ve toplu işleme için kullanılır.)

Koleksiyon türleri: `INDEX BY` ilişkisel diziler (sadece PL/SQL'de), `TABLE OF` iç içe tablolar (SQL'de `TABLE()` ile sorgulanabilir) ve `VARRAY` (sabit üst sınırlı). Koleksiyonların hepsi oturumun **PGA** belleğinde tutulur: Milyonlarca satırı tek bir koleksiyona okumak, sunucunun belleğini tüketebilir ve `PGA_AGGREGATE_LIMIT`'e çarpıp oturumun sonlandırılmasına yol açabilir. Büyük veri her zaman `LIMIT` ile parti parti okunur.

## Dinamik SQL ve SQL enjeksiyonu

Bazen SQL ifadesi çalışma anında oluşturulmalıdır: tablo adı bir parametreyse, DDL çalıştırılacaksa, filtre koşulları değişkense. `EXECUTE IMMEDIATE` bir string'i çalıştırır, ve burada dikkat edilmezse **SQL enjeksiyonu** kapısı açılır.

Bir tabloda gizli bir değer olsun ve bölge adını parametre olarak alan bir fonksiyon yazalım:

```sql
CREATE TABLE gizli_ayar (ad VARCHAR2(30), deger VARCHAR2(60));
INSERT INTO gizli_ayar VALUES ('smtp_parola', 'Cok$Gizli2026');
COMMIT;

CREATE OR REPLACE FUNCTION sunucu_say_kotu (p_bolge VARCHAR2) RETURN NUMBER AS
  v NUMBER;
BEGIN
  EXECUTE IMMEDIATE
    'SELECT COUNT(*) FROM sunucular WHERE bolge = ''' || p_bolge || '''' INTO v;   -- BİRLEŞTİRME
  RETURN v;
END;
/
SELECT sunucu_say_kotu('ist') AS normal FROM dual;
SELECT sunucu_say_kotu('x'' OR 1=1 --') AS enjeksiyon FROM dual;
```

```text
    NORMAL
----------
        20

ENJEKSIYON
----------
        60
```

Parametre `x' OR 1=1 --` olunca oluşan SQL: `... WHERE bolge = 'x' OR 1=1 --'`. Koşul her zaman doğru, filtre atlandı. Daha kötüsü, fonksiyon sadece bir **sayı** döndürse bile veri sızdırılabilir. Her soru bir evet/hayır sorusudur (kör enjeksiyon, blind injection):

```sql
SELECT sunucu_say_kotu('x'' OR EXISTS (SELECT 1 FROM gizli_ayar WHERE SUBSTR(deger, 1, 1) = ''A'') --') AS a_mi FROM dual;
SELECT sunucu_say_kotu('x'' OR EXISTS (SELECT 1 FROM gizli_ayar WHERE SUBSTR(deger, 1, 1) = ''C'') --') AS c_mi FROM dual;
SELECT sunucu_say_kotu('x'' OR EXISTS (SELECT 1 FROM gizli_ayar WHERE SUBSTR(deger, 1, 3) = ''Cok'') --') AS cok_mu FROM dual;
```

```text
      A_MI
----------
         0          ← ilk harf A değil

      C_MI
----------
        60          ← ilk harf C

    COK_MU
----------
        60          ← ilk üç harf "Cok"
```

Saldırgan, cevap 60 mı 0 mı diye bakarak parolayı **harf harf** çıkarır. Otomatik araçlar bunu saniyeler içinde yapar. Fonksiyon bir web API'sinin arkasındaysa, bu API'yi çağırabilen herkes fonksiyonun sahibi olan şemanın okuyabildiği her şeyi okuyabilir.

Çözüm, değeri SQL metnine **birleştirmek yerine bind değişkeni olarak vermek**:

```sql
CREATE OR REPLACE FUNCTION sunucu_say (p_bolge VARCHAR2) RETURN NUMBER AS
  v NUMBER;
BEGIN
  EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM sunucular WHERE bolge = :b' INTO v USING p_bolge;
  RETURN v;
END;
/
SELECT sunucu_say('x'' OR 1=1 --') AS bind_ile FROM dual;
-- 0: "x' OR 1=1 --" adında bir bölge yok
```

Bind değişkeninin değeri SQL'in **parçası olmaz**, sadece bir veridir. Ne yazarsan yaz, bir bölge adı olarak karşılaştırılır. Ayrıca performans faydası da var: SQL metni her çağrıda aynı kaldığı için bir kez ayrıştırılır ve planı paylaşılır (performans bölümünde göreceğiz).

Bind değişkeni sadece **değerler** için kullanılabilir. Tablo, sütun adları ve SQL anahtar kelimeleri bind edilemez. Bunları birleştirmek zorundaysan, önce doğrula:

```sql
SELECT DBMS_ASSERT.SIMPLE_SQL_NAME('sunucular') AS ad FROM dual;               -- sunucular
SELECT DBMS_ASSERT.SIMPLE_SQL_NAME('sunucular; DROP TABLE x') AS ad FROM dual;
-- ORA-44003: invalid SQL name
```

`DBMS_ASSERT` geçerli bir tanımlayıcı olmayanı reddeder. Daha güvenlisi, izin verilen değerlerin bir listesiyle karşılaştırmaktır (beyaz liste): "sıralama sütunu sadece `ad`, `cpu` ya da `bolge` olabilir". Partitioning dersindeki bölüm silme bloğunda `DBMS_ASSERT.ENQUOTE_NAME` bu yüzden vardı.

## DBMS_OUTPUT bir log aracı değildir

```sql
BEGIN
  FOR i IN 1 .. 3 LOOP
    DBMS_OUTPUT.PUT_LINE('adım ' || i || ' ' || TO_CHAR(SYSTIMESTAMP, 'HH24:MI:SS'));
    DBMS_SESSION.SLEEP(1);
  END LOOP;
END;
/
```

```text
adım 1 08:20:02
adım 2 08:20:03
adım 3 08:20:04
```

Zaman damgaları birer saniye arayla, ama SQL\*Plus'ta üç satır **birlikte**, blok bittikten sonra göründü. `DBMS_OUTPUT` sunucuda bir tampona yazar, istemci onu sadece çağrı bitince okur. Saatlerce süren bir işin ilerlemesini izlemek için işe yaramaz. Uygulama sürücüsü onu okumazsa hiç görünmez, ve tampon dolarsa hata verir. Alternatifler:

- İlerleme için: `DBMS_APPLICATION_INFO.SET_MODULE` / `SET_ACTION` / `SET_CLIENT_INFO`. Değerler hemen `V$SESSION`'da görünür, başka bir oturumdan izlenebilir. Uzun işler için `DBMS_APPLICATION_INFO.SET_SESSION_LONGOPS`, `V$SESSION_LONGOPS`'ta yüzde ve tahmini süre gösterir.
- Kalıcı log için: Bir log tablosu ve otonom transaction'la yazan bir prosedür (sonraki ders).

## Alıştırma

1. Bir sunucu adı alan ve bakıma alan bir anonim blok yaz. Kurallar: Sunucu yoksa `-20001`, zaten bakımdaysa `-20002` fırlat. Güncellemenin gerçekten bir satırı etkilediğini kontrol et.
2. `WHEN OTHERS THEN NULL` içeren şu kodda hangi hatalar sessizce kaybolabilir? İki örnek ver.

```sql
BEGIN
  INSERT INTO deploylar (...) VALUES (...);
  UPDATE sunucular SET durum = 'calisiyor' WHERE id = :s;
EXCEPTION WHEN OTHERS THEN NULL;
END;
```

<details><summary>Çözüm</summary>

```sql
DECLARE
  v_ad    sunucular.ad%TYPE := 'srv-005';
  v_durum sunucular.durum%TYPE;
BEGIN
  SELECT durum INTO v_durum FROM sunucular WHERE ad = v_ad FOR UPDATE;
  IF v_durum = 'bakimda' THEN
    RAISE_APPLICATION_ERROR(-20002, v_ad || ' zaten bakımda');
  END IF;
  UPDATE sunucular SET durum = 'bakimda' WHERE ad = v_ad;
  IF SQL%ROWCOUNT <> 1 THEN
    RAISE_APPLICATION_ERROR(-20003, 'beklenmeyen satır sayısı: ' || SQL%ROWCOUNT);
  END IF;
  DBMS_OUTPUT.PUT_LINE(v_ad || ' bakıma alındı');
  ROLLBACK;   -- denemede veriyi değiştirmemek için; gerçekte COMMIT
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE_APPLICATION_ERROR(-20001, v_ad || ' adında sunucu yok');
END;
/
```

```text
srv-005 bakıma alındı

-- v_ad := 'srv-017' ile:
ORA-20002: srv-017 zaten bakımda

-- v_ad := 'srv-999' ile:
ORA-20001: srv-999 adında sunucu yok
```

`FOR UPDATE`, kontrol ile güncelleme arasında başka bir oturumun durumu değiştirmesini engeller (önceki dersteki "kontrol et, sonra yaz" yarışı). `NO_DATA_FOUND`'u yakalayıp kendi anlamlı hatamıza çevirdik; diğer bütün hatalar olduğu gibi yukarı çıkıyor.

2. Örneğin: (a) `INSERT` bir `CHECK` ya da yabancı anahtar ihlali verir, deploy kaydı oluşmaz, ama blok "başarılı" döner ve uygulama deploy'u başlamış sanır. (b) `INSERT` başarılı olur, `UPDATE` bir kilit beklemesinde (`ORA-00054` NOWAIT ile ya da bir deadlock `ORA-00060`) hata verir. Deploy kaydı var ama sunucu durumu güncellenmemiş: Yarım bir iş, ve çağıran bir sonraki adımda commit ederse kalıcı hale gelir. Ayrıca `ORA-01653: unable to extend table` (tablespace dolu) gibi operasyonel bir alarm da yutulur ve kimse diskin dolduğunu fark etmez.

</details>

```quiz
`SELECT id INTO v_id FROM sunucular WHERE bolge = 'ist'` 20 satır döndürürse ne olur?
- İlk satır v_id'ye atanır
- Son satır atanır
- [x] ORA-01422 (TOO_MANY_ROWS) hatası
? SELECT INTO tam olarak bir satır bekler; hiç satır yoksa ORA-01403 NO_DATA_FOUND.
```

```quiz
`UPDATE sunucular SET durum = 'bakimda' WHERE id = :id` hiçbir satır bulamazsa ne olur?
- NO_DATA_FOUND hatası verir
- [x] Hata vermez; SQL%ROWCOUNT = 0 olur ve bunu kontrol etmek gerekir
- ORA-01403
? NO_DATA_FOUND sadece SELECT INTO içindir.
```

```quiz
Dinamik SQL'de kullanıcıdan gelen bir değeri güvenle kullanmanın yolu?
- Tek tırnakları iki tırnakla değiştirmek
- [x] Değeri SQL metnine birleştirmeden, bind değişkeni olarak vermek (`USING`)
- Değeri UPPER ile büyük harfe çevirmek
? Tablo/sütun adları bind edilemez: onlar için DBMS_ASSERT ya da beyaz liste.
```

## Özet

- Blok: `DECLARE` / `BEGIN` / `EXCEPTION` / `END`. Tipleri `%TYPE` ve `%ROWTYPE` ile al. Değişken adları sütunlarla çakışmasın.
- `SELECT INTO` tam bir satır: `NO_DATA_FOUND` (çoğu zaman iş durumu) ve `TOO_MANY_ROWS` (hata). Toplama fonksiyonları hata vermez.
- Cursor FOR döngüsü okunur; ama önce tek SQL, sonra toplu işleme, en son satır satır.
- DML hiçbir satır bulamazsa hata vermez: `SQL%ROWCOUNT`'ı kontrol et.
- `RAISE_APPLICATION_ERROR(-20xxx)` ile iş hataları, `PRAGMA EXCEPTION_INIT` ile Oracle hatalarına ad. `WHEN OTHERS THEN NULL` yasak; logla ve `RAISE`. `FORMAT_ERROR_BACKTRACE` hatanın yerini verir.
- Koleksiyonlar PGA'da yaşar: büyük veride `LIMIT`.
- Dinamik SQL'de değerler bind değişkeniyle (`USING`), tanımlayıcılar `DBMS_ASSERT` ya da beyaz listeyle. Birleştirme enjeksiyondur, kör enjeksiyon da veri sızdırır.
- `DBMS_OUTPUT` blok bitince görünür. İlerleme için `DBMS_APPLICATION_INFO`.
