# Kuyruklar: SKIP LOCKED, idempotency ve outbox

Bir isteğin yaptığı her işin kullanıcıyı bekletmesi gerekmez. E-posta göndermek, fatura PDF'i üretmek, resim küçültmek, arama indeksini güncellemek, bir web kancasını çağırmak: Bunlar "sonra" yapılabilir. Kuyruk, işi **üreten** ile **yapan**ı zaman içinde ayırır. Bunun üç faydası var:

- **Gecikme:** İstek, iş kuyruğa yazıldığı anda yanıt verir.
- **Tepe yükü düzleştirme:** Tepe anlarında iş kuyrukta birikir. Arka plan işçileri ortalama hızda çalışır, sistem tepeye göre değil ortalamaya göre boyutlanır.
- **Yalıtım:** Bir alt sistem (e-posta sağlayıcısı) çöktüğünde iş kaybolmaz, bekler.

Bedeli de var: **en az bir kez teslim**, sıra, tekrar eden işler ve "iş nerede kaldı" sorusu. Bu derste bunları PostgreSQL ile, ayrı bir aracı (broker) kurmadan uyguluyoruz. Önceki derslerdeki `egitim-pg` konteynerini kullanıyoruz.

## Veritabanında bir iş kuyruğu

Çoğu sistemde zaten bir PostgreSQL var. Saniyede birkaç bin işe kadar, ayrı bir RabbitMQ ya da Kafka işletmek yerine aynı veritabanında bir kuyruk tablosu kullanmak hem yeterlidir hem de büyük bir avantaj sağlar: İş, iş verisiyle **aynı işlemde** yazılabilir (aşağıdaki outbox bölümü). Graphile Worker, pg-boss, Oban ve Solid Queue gibi kütüphaneler bu modeli uygular.

```sql
-- kuyruk-sema.sql
CREATE TABLE isler (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tur         text NOT NULL,
  yuk         jsonb NOT NULL,
  durum       text NOT NULL DEFAULT 'bekliyor',      -- bekliyor | isleniyor | bitti | olu
  deneme      int  NOT NULL DEFAULT 0,
  calisan     text,
  kira_bitis  timestamptz,                           -- 'görünmezlik zaman aşımı'
  olusturma   timestamptz NOT NULL DEFAULT now()
);
-- sadece bekleyen işleri içeren kısmi indeks: kuyruk ne kadar büyürse büyüsün küçük kalır
CREATE INDEX isler_bekleyen ON isler (id) WHERE durum = 'bekliyor';
INSERT INTO isler (tur, yuk) SELECT 'eposta', jsonb_build_object('kime', 'k' || g || '@ornek.com') FROM generate_series(1, 300000) g;
ANALYZE isler;
```

### İş almak: FOR UPDATE ve SKIP LOCKED

Birden çok işçinin aynı işi almaması için iş satırı kilitlenmelidir. İki yolu karşılaştıralım. 300.000 iş var, 16 işçi `pgbench` ile 10 saniye boyunca iş alıyor:

```sql
-- al-skip.sql
UPDATE isler SET durum = 'bitti', deneme = deneme + 1, calisan = 'w' || :client_id
WHERE id = (SELECT id FROM isler WHERE durum = 'bekliyor' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id;
-- al-kilit.sql: aynısı, sadece SKIP LOCKED yok (FOR UPDATE)
```

```bash
PB -n -M prepared -f /s/al-kilit.sql -c 16 -j 8 -T 10
PB -n -M prepared -f /s/al-skip.sql  -c 16 -j 8 -T 10
```

```text
al-kilit  iş/sn=1159    ort=13.800 ms
bitti=11550 iki kez işlenen=0
al-skip   iş/sn=6946    ort=2.304 ms
bitti=69102 iki kez işlenen=0
```

İkisi de doğru çalıştı, hiçbir iş iki kez alınmadı. Ama verim farkı **6 kat**:

- **`FOR UPDATE`:** 16 işçinin hepsi "ilk bekleyen işi" ister. Biri satırı kilitler, diğer 15'i **o satırın kilidini bekler**. Kilit bırakıldığında satır artık bekleyen durumda değildir. Bekleyenler yeniden değerlendirir, bir sonrakini dener ve yine sıraya girer. İşçiler fiilen tek sıra halinde çalışır. Amdahl'ın seri kısmı tam olarak budur.
- **`SKIP LOCKED`:** Kilitli satırı beklemek yerine **atlar** ve bir sonraki kilitsiz satırı alır. 16 işçi aynı anda 16 farklı iş alır.

Kısmi indeks (`WHERE durum = 'bekliyor'`) da önemlidir. Tablo milyonlarca bitmiş iş içerse bile indeks sadece bekleyenleri tutar, iş almak her zaman ucuz kalır. Bitmiş işler düzenli olarak silinmeli ya da bir arşiv tablosuna taşınmalıdır. Sürekli güncellenen ve silinen bir kuyruk tablosu, VACUUM'un sık çalışmasını gerektirir. Tabloya özel `autovacuum_vacuum_scale_factor` değerini düşürmek iyi bir pratiktir.

> **İpucu:** İşçilerin kuyruğu sürekli sorgulaması (polling) gereksiz yük ve gecikme yaratır. PostgreSQL'in `LISTEN`/`NOTIFY` mekanizmasıyla üretici iş ekledikten sonra `NOTIFY isler` gönderir, işçiler uyanır ve iş alır. Bildirimler kaybolabilir (bağlantı koparsa), bu yüzden seyrek bir yoklama (örneğin 5 saniyede bir) güvenlik ağı olarak kalır.

## En az bir kez teslim ve kiralar

Bir işçi işi aldıktan sonra çökerse ne olur? İş "işleniyor" durumunda sonsuza kadar kalmamalıdır. Çözüm **kiradır** (lease, SQS'teki adıyla "visibility timeout"): İş, sınırlı bir süre için alınır. Süre dolarsa bir toplayıcı işi kuyruğa geri koyar. Bu çözüm kaçınılmaz bir sonuç doğurur: **Kirası dolan işçi aslında ölmemiş, sadece yavaşlamış olabilir.** O zaman iş iki kez yapılır. Bu senaryoyu adım adım oynayalım:

```sql
-- kira.sql (özet)
-- A işi 2 saniyelik kirayla alır
UPDATE isler SET durum = 'isleniyor', deneme = deneme + 1, calisan = 'A', kira_bitis = clock_timestamp() + interval '2 s'
WHERE id = (SELECT id FROM isler WHERE durum = 'bekliyor' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id, calisan, deneme;
-- A takılır: 3 saniye geçer
SELECT pg_sleep(3);
-- Toplayıcı: kirası dolan işleri kuyruğa geri koy (5 denemeden sonra ölü mektup)
UPDATE isler SET durum = CASE WHEN deneme >= 5 THEN 'olu' ELSE 'bekliyor' END, calisan = NULL, kira_bitis = NULL
WHERE durum = 'isleniyor' AND kira_bitis < clock_timestamp() RETURNING id, durum;
-- B aynı işi alır, ödemeyi yapar, işi tamamlar
-- A uyanır, ödemeyi yapar, işi tamamlamaya çalışır:
UPDATE isler SET durum = 'bitti' WHERE id = 1 AND calisan = 'A' RETURNING id;
```

Ödeme iki tabloya yapılıyor. Birinde koruma yok. Diğerinde iş kimliği benzersiz ve ekleme `ON CONFLICT DO NOTHING` ile yapılıyor:

```sql
INSERT INTO odemeler (siparis, tutar, is_id) SELECT ... FROM isler WHERE id = 1;
INSERT INTO odemeler_idem (siparis, tutar, is_id) SELECT ... FROM isler WHERE id = 1 ON CONFLICT (is_id) DO NOTHING;
```

```text
--- A işi 2 saniyelik kirayla alır
 id | calisan | deneme
----+---------+--------
  1 | A       |      1
--- A takılır (GC duraklaması, ağ kesintisi...). 3 saniye geçer
--- Toplayıcı: kirası dolan işleri kuyruğa geri koy (5 denemeden sonra ölü mektup)
 id |  durum
----+----------
  1 | bekliyor
--- B aynı işi alır ve tamamlar
 id | calisan | deneme
----+---------+--------
  1 | B       |      2
--- A uyanır, işi bitirdiğini sanır ve ödemeyi yapar
--- A işi tamamlamaya çalışır: kira artık B'de (sahiplik kontrolü)
 id
----

--- Sonuç
           tablo            | odeme_sayisi | toplam
----------------------------+--------------+--------
 idempotent olmayan         |            2 | 499.80
 is_id UNIQUE + ON CONFLICT |            1 | 249.90
```

Bu senaryodan çıkan üç kural, her kuyruk sistemi için geçerlidir:

1. **Teslimat en az bir kezdir.** "Tam olarak bir kez teslim" dağıtık bir sistemde garanti edilemez. Kira, yeniden deneme, ağ kopması ve aracının onay alamaması, aynı işin ikinci kez gelmesine yol açar. Hedef, tam olarak bir kez **etkidir**, ve bu ancak **idempotent** işleyiciyle sağlanır.
2. **Yan etkiyi bir idempotency anahtarına bağla.** Ödeme tablosundaki `is_id UNIQUE` kısıtı, ikinci ödemeyi veritabanı seviyesinde reddetti. Dış servislere giden çağrılarda aynı fikir bir **idempotency anahtarı** başlığıyla uygulanır (Stripe gibi ödeme sağlayıcıları `Idempotency-Key` destekler). Anahtar işin kimliğinden türetilir, her denemede aynıdır.
3. **İşi tamamlarken sahipliği kontrol et.** `WHERE calisan = 'A'` koşulu, kirası elinden alınmış bir işçinin işi "bitti" olarak işaretlemesini engelledi (0 satır döndü). Daha sağlamı bir **kira sayacıdır** (fencing token). Her alımda artan bir numara olur ve işçinin her yazması bu numarayı taşır.

Kira süresi, işin normal süresinin birkaç katı olmalıdır. Uzun işlerde işçi düzenli olarak kirasını **uzatır** (heartbeat): `UPDATE isler SET kira_bitis = now() + '30 s' WHERE id = $1 AND calisan = $2`. Bu güncelleme 0 satır döndürürse, iş başka birine geçmiş demektir. İşçi işi bırakmalıdır.

### Yeniden deneme ve ölü mektup

Bazı işler hiçbir zaman başarılı olmaz: geçersiz e-posta adresi, silinmiş bir kayıt, koddaki bir hata. Bunların sonsuza kadar yeniden denenmesi, kuyruğu ve sağlıklı işleri boğar ("zehirli mesaj"). Bu yüzden:

- Denemeler arasındaki bekleme **üstel** artar ve **rastgelelik** içerir: 1 sn, 2 sn, 4 sn... ±%20. Böylece aynı anda başarısız olan bin iş aynı anda yeniden denenmez (dayanıklılık dersi). Kuyruk tablosunda bu bir `calistirma_zamani` sütunudur ve iş alma sorgusu `WHERE calistirma_zamani <= now()` koşulunu içerir.
- Belirli bir denemeden sonra iş **ölü mektup** (dead letter) durumuna geçer. Ölü işler bir alarm üretir, incelenir, düzeltilip yeniden kuyruğa alınır ya da atılır.
- Hata türleri ayrılır: Geçici hatalar (zaman aşımı, 503) yeniden denenir. Kalıcı hatalar (400, doğrulama hatası) doğrudan ölü mektuba gider.

## Outbox: iki yere atomik yazmak

Sipariş oluşturan bir servis, siparişi veritabanına yazmak **ve** "sipariş oluşturuldu" olayını bir aracıya (Kafka, RabbitMQ) göndermek istiyor. İki ayrı sisteme yazmak (dual write) atomik değildir:

- Önce veritabanı, sonra aracı: Veritabanı işlemi başarılı olur, aracıya gönderim başarısız olur ya da süreç arada çöker. Sipariş var, olay yok. Fatura hiç kesilmez.
- Önce aracı, sonra veritabanı: Olay gider, veritabanı işlemi geri alınır. Var olmayan bir siparişin faturası kesilir.

**Outbox deseni** olayı, iş verisiyle **aynı veritabanı işleminde** bir `outbox` tablosuna yazar. Ayrı bir aktarıcı süreç bu tabloyu okuyup aracıya gönderir:

```sql
-- outbox.sql (özet)
CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  konu text NOT NULL, anahtar text NOT NULL, olay jsonb NOT NULL,
  yayinlandi timestamptz
);
CREATE INDEX outbox_bekleyen ON outbox (id) WHERE yayinlandi IS NULL;

-- 1) Sipariş ve olay aynı işlemde; işlem başarısız olursa ikisi birden geri alınır
BEGIN;
INSERT INTO siparisler (musteri, tutar) VALUES (42, 249.90);
INSERT INTO outbox (konu, anahtar, olay) SELECT 'siparis.olusturuldu', 'musteri:42', jsonb_build_object('siparis', id, 'tutar', tutar) FROM siparisler WHERE ...;
SELECT 1 / 0;   -- örneğin bir kısıt ihlali
ROLLBACK;

-- 3) Aktarıcı: bekleyen olayları al, aracıya gönder, SADECE alınanları işaretle
BEGIN;
SELECT array_agg(id) AS ids FROM (SELECT id FROM outbox WHERE yayinlandi IS NULL ORDER BY id LIMIT 3 FOR UPDATE SKIP LOCKED) s \gset
SELECT id, anahtar, olay FROM outbox WHERE id = ANY (:'ids') ORDER BY id;
-- ... burada aracıya (Kafka/RabbitMQ) gönderilir ve onay beklenir ...
UPDATE outbox SET yayinlandi = clock_timestamp() WHERE id = ANY (:'ids');   -- sadece gerçekten alınanlar
COMMIT;
```

```text
--- 1) Sipariş ve olayı AYNI işlemde yaz; işlem başarısız olursa ikisi birden geri alınır
ERROR:  division by zero
 siparis | olay
---------+------
       0 |    0
--- 2) Başarılı işlemler
 siparis | bekleyen_olay
---------+---------------
       5 |             5
--- 3) Aktarıcı: bekleyen olayları sırayla al (SKIP LOCKED: birden çok aktarıcı çakışmaz), aracıya gönder, işaretle
 id |  anahtar   |             olay
----+------------+------------------------------
  2 | musteri:41 | {"tutar": 101, "siparis": 2}
  3 | musteri:42 | {"tutar": 102, "siparis": 3}
  4 | musteri:40 | {"tutar": 103, "siparis": 4}

 yayinlanan | bekleyen
------------+----------
          3 |        2
```

Çıktıda kimliklerin 1'den değil 2'den başladığına dikkat et. Geri alınan işlem `IDENTITY` dizisinden 1'i **tüketti**. Diziler işlemsel değildir, geri alınmaz. Bu ayrıntı demoda gerçek bir hataya yol açtı. Aktarıcının ilk sürümü `WHERE id IN (1, 2, 3)` ile işaretleme yapıyordu. Sadece 2 ve 3 işaretlendi, gönderilmiş olan 4 numaralı olay "bekliyor" olarak kaldı ve bir sonraki turda **ikinci kez** gönderilecekti. Doğrusu, sadece gerçekten alınan kimlikleri işaretlemektir. Kimliklerde boşluk olabileceğini ve sıranın kesintisiz olmayacağını varsay.

Outbox'ın garantileri ve sınırları:

- **Atomiklik:** Olay, ancak iş verisi kalıcı olduysa vardır. Dual write sorunu ortadan kalkar.
- **En az bir kez:** Aktarıcı aracıya gönderip `COMMIT`'ten önce çökerse, olay tekrar gönderilir. Tüketiciler yine **idempotent** olmalıdır. Olay kimliği (`outbox.id`) tekilleştirme anahtarıdır.
- **Sıra:** Aynı anahtarın (`musteri:42`) olayları sırayla gönderilmelidir. Birden çok aktarıcı paralel çalışıyorsa, sıra anahtar bazında korunmalıdır. Sonraki dersteki bölümler (partition) bunu sağlar.
- **Yoklama yerine CDC:** Aktarıcı tabloyu yoklamak yerine, veritabanının değişiklik akışını (PostgreSQL mantıksal replikasyonu, Debezium) okuyabilir. Gecikme daha düşük olur ve veritabanı üzerindeki yoklama yükü kalkar. Önbellek dersindeki CDC ile geçersizleştirme de aynı akışı kullanır.

Tüketici tarafında outbox'ın karşılığı **inbox**'tır. Tüketici işlediği olay kimliklerini kendi veritabanında, iş verisiyle aynı işlemde tutar (`islenen_olaylar(olay_id PRIMARY KEY)`). Aynı olay ikinci kez geldiğinde ekleme çakışır ve olay atlanır.

## Kuyruğun kapasitesi: geri basınç

Kuyruk, tepe yükünü emer. Ama sonsuz değildir. Üretim hızı tüketim hızını **sürekli** aşarsa:

```text
üretim 1200 iş/sn, tüketim 1000 iş/sn  →  kuyruk saniyede 200 iş büyür
1 saat sonra: 720.000 iş birikmiş
Little: yeni gelen bir işin bekleme süresi ≈ 720.000 / 1000 = 720 sn = 12 dakika ve büyüyor
```

Kapasite dersindeki ρ>1 durumu, bu kez saniyeler değil saatler ölçeğinde. Kuyruk sorunu gizler. Sistem "çalışıyor" görünür, ama e-postalar saatler sonra gider. Bu yüzden kuyruklar için izlenmesi gerekenler:

- **Kuyruk derinliği** ve daha önemlisi **en eski bekleyen işin yaşı**. Kullanıcı deneyimi yaşla ilgilidir, derinlikle değil. Bu metrik bir SLO'ya bağlanır: "Bildirim e-postalarının %99'u 1 dakika içinde gönderilir."
- **Üretim ve tüketim hızları.** Fark sürekli pozitifse, işçi eklemek ya da işi hızlandırmak gerekir. İşçi sayısına göre otomatik ölçekleme (Kubernetes'te KEDA) kuyruk derinliğine ve yaşa göre yapılır, CPU'ya göre değil.
- **Geri basınç (backpressure):** Kuyruğun bir üst sınırı olmalıdır. Sınıra ulaşıldığında üreticiye "yavaşla" sinyali verilir: 429/503 yanıtı, önemsiz işlerin atılması ya da kabulün durdurulması. Sınırsız bir kuyruk, bir kesintiyi gecikmeli ve daha büyük bir kesintiye çevirir. Belleği dolduran bir süreç içi kuyruk da OOM'a yol açar.

```quiz
{
  "question": "Bir işçi, bir kuyruktan sipariş onay e-postası işini alıyor, e-postayı gönderiyor, sonra işi 'bitti' olarak işaretliyor. Nadiren müşteriler aynı e-postayı iki kez alıyor. En olası neden ve düzeltme hangisi?",
  "options": [
    "E-posta sağlayıcısında bir hata var.",
    "Teslimat en az bir kezdir: İşçi e-postayı gönderip işaretlemeden önce çökerse, kirası dolarsa ya da aracıya onay ulaşmazsa iş yeniden teslim edilir. Gönderimi idempotent yapmak gerekir: iş kimliğinden türetilen bir anahtarla 'gönderildi' kaydını benzersiz kısıtla tutmak ve sağlayıcıya idempotency anahtarı vermek. İşaretleme sırasında sahiplik de kontrol edilmeli.",
    "Kuyruğu 'tam olarak bir kez teslim' moduna almak sorunu kesin çözer.",
    "İşçi sayısını 1'e indirmek gerekir."
  ],
  "answer": 1,
  "explanation": "Dağıtık sistemlerde tam olarak bir kez teslim garanti edilemez. Tam olarak bir kez etki, idempotent işleyiciyle sağlanır. Bu derste kirası dolan işçi senaryosunda koruma olmadan ödeme iki kez yapıldı, benzersiz kısıtla bir kez."
}
```

```quiz
{
  "question": "Bir servis, sipariş kaydını veritabanına yazdıktan sonra 'siparis.olusturuldu' olayını Kafka'ya gönderiyor. Kafka geçici olarak erişilemez olduğunda siparişler oluşuyor ama faturalar hiç kesilmiyor. Hangi düzeltme doğrudur?",
  "options": [
    "Kafka gönderimini veritabanı işleminden önce yapmak.",
    "Outbox deseni: Olay, sipariş ile aynı veritabanı işleminde bir outbox tablosuna yazılır. Ayrı bir aktarıcı (yoklama ya da CDC) olayları Kafka'ya gönderir ve gönderilenleri işaretler. Tüketiciler olay kimliğiyle idempotent çalışır.",
    "Kafka gönderimini 10 kez yeniden denemek yeterlidir.",
    "İki aşamalı commit (XA) her zaman en iyi çözümdür."
  ],
  "answer": 1,
  "explanation": "İki ayrı sisteme yazmak atomik değildir. Yeniden deneme süreç çökmesini kapsamaz. Gönderimi öne almak, geri alınan işlemlerin olaylarını yayımlar. Outbox atomikliği tek veritabanı işlemine indirger."
}
```

```lab
{
  "title": "Kendi iş kuyruğunu kur",
  "steps": [
    "kuyruk-sema.sql ve al-skip.sql ile işçi sayısını 1, 4, 16 ve 64 yaparak verimi ölç. SKIP LOCKED ile verim hangi noktada doyuyor ve neden?",
    "Kuyruk tablosuna `calistirma_zamani` sütunu ekle. Başarısız işi üstel bekleme ve ±%20 rastgelelikle yeniden planlayan, 5 denemeden sonra 'olu' yapan bir SQL fonksiyonu yaz. İş alma sorgusunu ve kısmi indeksi buna göre güncelle.",
    "kira.sql'deki sahiplik kontrolünü bir kira sayacıyla (fencing token) değiştir: Her alımda `kira_no` artsın, tamamlama `WHERE kira_no = $1` ile yapılsın. A'nın geç kalan güncellemesinin reddedildiğini göster.",
    "outbox.sql'e bir tüketici tarafı ekle: `islenen_olaylar(olay_id PRIMARY KEY)` tablosu ve aynı olayı iki kez işlemeye çalışan bir senaryo. İş verisinin sadece bir kez değiştiğini doğrula.",
    "Kuyruğun 'en eski bekleyen işin yaşı' metriğini döndüren bir sorgu yaz. Üreticiyi işçilerden %20 hızlı çalıştırıp metriğin nasıl büyüdüğünü 10 saniyede bir ölç."
  ]
}
```

## Özet

- Kuyruk; gecikmeyi kısaltır, tepe yükünü düzleştirir ve alt sistemleri yalıtır. Saniyede birkaç bin işe kadar PostgreSQL'de bir kuyruk tablosu yeterlidir ve iş verisiyle aynı işlemde yazılabilir.
- `FOR UPDATE SKIP LOCKED`, işçilerin birbirini beklemesini önler: 16 işçide 6 kat verim (6946/1159 iş/sn). Bekleyen işler için kısmi indeks kullan, bitmiş işleri temizle.
- Teslimat en az bir kezdir. Kirası dolan işçi senaryosunda koruma olmadan ödeme iki kez yapıldı. Yan etkiyi benzersiz bir idempotency anahtarına bağla, tamamlarken sahipliği (kira sayacı) kontrol et, uzun işlerde kirayı uzat.
- Yeniden denemeler üstel ve rastgele beklemeli olmalı, kalıcı hatalar ve zehirli mesajlar ölü mektuba gitmeli.
- Outbox, dual write sorununu tek bir veritabanı işlemine indirger. Aktarıcı sadece aldığı olayları işaretlemeli (diziler geri alınmaz, kimliklerde boşluk olur). Tüketiciler inbox ile idempotent olmalıdır.
- Kuyruk sorunları gizler. En eski işin yaşını izle, işçileri kuyruk metriğine göre ölçekle, kuyruğa üst sınır koyup geri basınç uygula.
