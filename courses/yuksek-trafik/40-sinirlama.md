# Hız sınırlama: token bucket, kayan pencere ve dağıtık sayaçlar

Hız sınırlama birden çok amaca hizmet eder:

- **Paylaşılan kapasiteyi adil dağıtmak:** Tek bir müşterinin hatalı bir döngüsü herkesin servisini yavaşlatmamalı.
- **Maliyeti kontrol etmek:** Pahalı uç noktalar, dış API kotaları.
- **Kötüye kullanımı yavaşlatmak:** Kaba kuvvet, kazıma (scraping). Güvenlik kursundaki giriş uç noktası buna bir örnek.
- **Sistemi aşırı yükten korumak:** Kapasite dersindeki ρ>1 bölgesine hiç girmemek.

Ters vekil dersinde nginx'in `limit_req` direktifini kullanmıştık. Bu derste algoritmaların farklarını ve sayaç birden çok kopya arasında paylaşıldığında ortaya çıkan doğruluk sorununu ölçüyoruz.

## Algoritmalar

Dört algoritmayı, dakikada 100 istek sınırıyla, aynı istek dizilerine karşı çalıştıralım:

```js
// sinir.mjs — hız sınırlama algoritmaları: dakikada 100 istek sınırı
const SINIR = 100, PENCERE = 60_000;

function sabitPencere() {
  const m = new Map();
  return (anahtar, t) => {
    const p = Math.floor(t / PENCERE), k = `${anahtar}:${p}`;
    const n = (m.get(k) ?? 0) + 1; m.set(k, n);
    return n <= SINIR;
  };
}
function kayanGunluk() {                                     // her isteğin zamanını sakla (kesin, bellek pahalı)
  const m = new Map();
  return (anahtar, t) => {
    const g = (m.get(anahtar) ?? []).filter((x) => x > t - PENCERE);
    if (g.length >= SINIR) { m.set(anahtar, g); return false; }
    g.push(t); m.set(anahtar, g); return true;
  };
}
function kayanSayac() {                                      // iki sabit pencerenin ağırlıklı toplamı (yaklaşık, ucuz)
  const m = new Map();
  return (anahtar, t) => {
    const p = Math.floor(t / PENCERE), gecen = (t % PENCERE) / PENCERE;
    const simdi = m.get(`${anahtar}:${p}`) ?? 0, onceki = m.get(`${anahtar}:${p - 1}`) ?? 0;
    if (onceki * (1 - gecen) + simdi >= SINIR) return false;
    m.set(`${anahtar}:${p}`, simdi + 1); return true;
  };
}
function jetonKovasi(kapasite = 20) {                        // dolum: 100/dk; kova: ani yük payı
  const m = new Map(), dolum = SINIR / PENCERE;
  return (anahtar, t) => {
    const k = m.get(anahtar) ?? { jeton: kapasite, son: t };
    k.jeton = Math.min(kapasite, k.jeton + (t - k.son) * dolum); k.son = t;
    if (k.jeton < 1) { m.set(anahtar, k); return false; }
    k.jeton -= 1; m.set(anahtar, k); return true;
  };
}

// İstek dizileri (ms cinsinden zaman damgaları)
const senaryolar = {
  "pencere sınırında patlama (0:59'da 100, 1:00'da 100)": [
    ...Array.from({ length: 100 }, (_, i) => 59_000 + i * 5), ...Array.from({ length: 100 }, (_, i) => 60_000 + i * 5)],
  "düzgün 2 istek/sn, 3 dk": Array.from({ length: 360 }, (_, i) => i * 500),
  "ani 50 istek, sonra sessizlik, tekrar": [
    ...Array.from({ length: 50 }, (_, i) => i * 10), ...Array.from({ length: 50 }, (_, i) => 30_000 + i * 10)],
};
for (const [ad, dizi] of Object.entries(senaryolar)) {
  console.log(`\n${ad}  (toplam ${dizi.length} istek)`);
  for (const [alg, f] of [["sabit pencere", sabitPencere()], ["kayan günlük", kayanGunluk()], ["kayan sayaç", kayanSayac()], ["jeton kovası (20)", jetonKovasi()]]) {
    const kabul = dizi.filter((t) => f("ip:1", t));
    // herhangi bir 60 sn'lik aralıkta kabul edilen en çok istek
    let enCok = 0; for (let i = 0, j = 0; i < kabul.length; i++) { while (kabul[i] - kabul[j] >= PENCERE) j++; enCok = Math.max(enCok, i - j + 1); }
    console.log(`   ${alg.padEnd(18)} kabul=${String(kabul.length).padStart(3)}   herhangi 60 sn'de en çok=${enCok}`);
  }
}
```

```bash
node sinir.mjs
```

```text
pencere sınırında patlama (0:59'da 100, 1:00'da 100)  (toplam 200 istek)
   sabit pencere      kabul=200   herhangi 60 sn'de en çok=200
   kayan günlük       kabul=100   herhangi 60 sn'de en çok=100
   kayan sayaç        kabul=101   herhangi 60 sn'de en çok=101
   jeton kovası (20)  kabul= 22   herhangi 60 sn'de en çok=22

düzgün 2 istek/sn, 3 dk  (toplam 360 istek)
   sabit pencere      kabul=300   herhangi 60 sn'de en çok=100
   kayan günlük       kabul=300   herhangi 60 sn'de en çok=100
   kayan sayaç        kabul=300   herhangi 60 sn'de en çok=100
   jeton kovası (20)  kabul=319   herhangi 60 sn'de en çok=119

ani 50 istek, sonra sessizlik, tekrar  (toplam 100 istek)
   sabit pencere      kabul=100   herhangi 60 sn'de en çok=100
   kayan günlük       kabul=100   herhangi 60 sn'de en çok=100
   kayan sayaç        kabul=100   herhangi 60 sn'de en çok=100
   jeton kovası (20)  kabul= 40   herhangi 60 sn'de en çok=40
```

Algoritmaları tek tek değerlendirelim:

- **Sabit pencere:** En basit olanı: dakika başına bir sayaç. Pencere sınırında zayıftır. 0:59'da 100 ve 1:00'da 100 istek, iki ayrı pencereye düşer ve **10 saniye içinde 200 istek** kabul edilir. Bu, sınırın iki katıdır. Arka uç "dakikada 100" için boyutlandıysa, bu patlama onu aşar.
- **Kayan günlük:** Her isteğin zamanını tutar ve son 60 saniyeyi sayar. Kesindir, ama anahtar başına sınır kadar zaman damgası saklar. Dakikada 10.000 sınırlı bir milyon anahtar için bu, makul olmayan bir bellek demektir.
- **Kayan sayaç:** İki sabit pencereyi, geçen süreye göre ağırlıklandırarak birleştirir. Anahtar başına iki sayaç tutar, sınır aşımı en fazla birkaç istektir (burada 101). Cloudflare gibi büyük ölçekli sistemlerin kullandığı pratik bir uzlaşmadır.
- **Jeton kovası:** Kovada en fazla 20 jeton bulunur ve kova saniyede 100/60 jeton hızında dolar. Her istek bir jeton harcar. "Ortalama hız" ile "ani yük payı" iki ayrı parametredir. Bu esneklik bir bedelle gelir: Kova doluyken gelen ani yük, dolum hızının üstüne eklenir. Düzgün trafikte herhangi bir 60 saniyede 119 istek kabul edildi (100 dolum + 19 kova). Ani yük senaryosunda ise 50'lik patlamanın sadece 20'si (kova kapasitesi) geçti. Kova kapasitesi, "ne kadar ani yük kabul edilebilir" sorusunun cevabıdır.

Hangisi ne zaman:

| İhtiyaç | Algoritma |
|---|---|
| Ani yüke izin veren ortalama hız (API istemcileri, toplu işler) | Jeton kovası (ya da eşdeğeri GCRA) |
| Arka uca düzgün hız (bir dış API'nin "saniyede 10" kuralı) | Sızdıran kova: istekleri kuyrukta tutup sabit hızda bırakır (nginx `limit_req` `nodelay` olmadan) |
| "Dakikada/saatte/günde N" kotası (faturalama, plan sınırları) | Kayan sayaç ya da sabit pencere. Pencere sınırındaki patlama kotada genellikle sorun değildir |
| Kesinlik gerekirse ve anahtar başına istek az ise | Kayan günlük |

**GCRA** (Generic Cell Rate Algorithm), jeton kovasıyla aynı davranışı anahtar başına **tek bir zaman damgasıyla** uygular: "bir sonraki isteğin kabul edileceği en erken teorik zaman". Saklaması ve atomik güncellemesi en kolay algoritmadır. Dağıtık uygulamalarda bu yüzden sık tercih edilir.

## Dağıtık sayaç: doğruluk sorunu

Uygulama birden çok kopya olarak çalışıyorsa, her kopyanın kendi bellek içi sayacı fiilî sınırı **kopya sayısı** kadar çarpar. 10 pod'da "dakikada 100" sınırı, dakikada 1000 olur. Ters vekil dersindeki nginx sınırı da her kopyada ayrı sayılıyordu. Sayacın **paylaşılan** bir depoda (Redis, veritabanı) tutulması gerekir. Paylaşılan sayacın da kendi tuzağı vardır.

Önceki derslerin PostgreSQL'ini paylaşılan sayaç olarak kullanalım. Sınır 1000. 16 eşzamanlı istemci toplam 3200 kez deniyor. İlk sürüm, çoğu "ilk" uygulamanın yaptığı gibi, önce okuyor, uygulamada karar veriyor, sonra yazıyor:

```sql
-- sinir-yaris.sql (pgbench betiği): oku, karar ver, yaz: iki ayrı adım
SELECT sayac FROM sinir WHERE anahtar = 'api:musteri42' \gset
\if :sayac < 1000
  UPDATE sinir SET sayac = :sayac + 1 WHERE anahtar = 'api:musteri42';
  INSERT INTO kabul (anahtar) VALUES ('api:musteri42');
\endif
```

```sql
-- sinir-atomik.sql: karar ve artırma tek bir atomik ifadede
WITH s AS (UPDATE sinir SET sayac = sayac + 1 WHERE anahtar = 'api:musteri42' AND sayac < 1000 RETURNING 1)
INSERT INTO kabul (anahtar) SELECT 'api:musteri42' FROM s;
```

```bash
PB -n -f /s/sinir-yaris.sql  -c 16 -j 8 -t 200
PB -n -f /s/sinir-atomik.sql -c 16 -j 8 -t 200
```

```text
sinir-yaris: deneme=3200  kabul edilen=3200  sayaç=240
sinir-atomik: deneme=3200  kabul edilen=1000  sayaç=1000
```

İlk sürümde sınır **hiç çalışmadı**: 3200 denemenin hepsi kabul edildi. Sayaç ise sadece 240'ı gösteriyor. Bu tablo iki ayrı hatayı birlikte gösteriyor:

- **Kontrol ile güncelleme arasındaki yarış (TOCTOU):** 16 istemci aynı anda `sayac = 57` okur, hepsi "1000'den az" diye karar verir, hepsi kabul eder.
- **Kayıp güncelleme:** Hepsi `sayac = 58` yazar. 16 artıştan 15'i kaybolur, bu yüzden sayaç asla 1000'e ulaşmaz ve kontrol hiç tetiklenmez.

Atomik sürümde karar (`sayac < 1000`) ve artırma (`sayac + 1`) **tek bir ifadede** yapılır. Veritabanı satır kilidiyle bunları sıraya koyar. Tam olarak 1000 kabul edildi.

Redis'te aynı ilke bir **Lua betiğiyle** uygulanır. Redis betikleri atomik çalıştırır. Aşağıdaki jeton kovası, yukarıdaki JavaScript sürümünün atomik karşılığıdır:

```lua
-- KEYS[1]: kova anahtarı, ARGV: kapasite, saniyedeki dolum, şimdiki zaman (ms)
local k = redis.call('HMGET', KEYS[1], 'jeton', 'son')
local kapasite, dolum, simdi = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local jeton = tonumber(k[1]) or kapasite
local son = tonumber(k[2]) or simdi
jeton = math.min(kapasite, jeton + (simdi - son) / 1000 * dolum)
local izin = 0
if jeton >= 1 then jeton = jeton - 1; izin = 1 end
redis.call('HSET', KEYS[1], 'jeton', jeton, 'son', simdi)
redis.call('PEXPIRE', KEYS[1], math.ceil(kapasite / dolum * 1000) + 1000)   -- boşta kalan anahtarlar temizlensin
return { izin, jeton }
```

> **Not:** Bu ortamda Redis imajı bulunmadığı için Lua betiği çalıştırılmadı. Atomiklik ilkesi yukarıdaki PostgreSQL deneyiyle gösterildi. Betikte zamanı istemciden almak yerine Redis'in `TIME` komutunu kullanmak, kopyalar arasındaki saat farklarının etkisini kaldırır.

Paylaşılan sayacın maliyetleri:

- **Her istekte bir ağ gidiş-dönüşü** (Redis'te yaklaşık 0,2–0,5 ms). Çok yüksek hızlarda, yerel bir ön sayaçla birleştirilir: Her kopya küçük bir jeton payını yerel olarak harcar, bitince merkezden yenisini alır. Sınır biraz esner, merkez yükü büyük ölçüde azalır.
- **Sıcak anahtar:** Tek bir büyük müşterinin anahtarı, Redis kümesinde tek bir düğüme düşer. Önceki derslerdeki sıcak parça sorununun aynısı.
- **Depo düştüğünde ne olacak?** Hız sınırlayıcı bir **güvenlik kontrolüdür** (giriş uç noktası) ya da bir **koruma mekanizmasıdır** (kapasite). Güvenlik kursundaki "güvenli başarısızlık" ilkesi burada bir karar gerektirir. Giriş denemesi sınırı depo yokken **kapalı** başarısız olmalıdır, yani reddetmelidir. Genel API kotası ise çoğunlukla **açık** başarısız olur, yani kabul eder ve bir alarm üretir. Bu kararı bilinçli ver ve uç nokta bazında yapılandır.

## Neyi, nerede sınırlamak

- **Anahtar:** Kimliği doğrulanmış isteklerde kullanıcı, API anahtarı ya da kiracı. Anonim isteklerde IP, ama NAT ve botnet sınırlamaları akılda tutulmalı (ters vekil dersi). Çoğu zaman birkaç katman birlikte uygulanır: IP başına kaba bir sınır (kenarda), kiracı başına plan kotası (uygulamada), uç nokta başına koruma (pahalı uç noktalarda daha sıkı).
- **Maliyet ağırlıklı sınır:** Bütün istekler eşit değildir. Bir rapor uç noktası 50 "birim", basit bir okuma 1 birim harcayabilir. GraphQL'de sorgu karmaşıklığı puanı bu fikrin bir uygulamasıdır.
- **Eşzamanlılık sınırı:** Hız sınırı "saniyede kaç istek" sorusunu cevaplar. Eşzamanlılık sınırı ise "aynı anda kaç istek" sorusunu. Little yasasına göre ikisi gecikme üzerinden birbirine bağlıdır: Bir arka uç yavaşladığında, aynı hız daha fazla eşzamanlı istek demektir. Uzun süren işler (rapor, dışa aktarma) ve yavaşlayabilen bağımlılıklar için kiracı başına **eşzamanlı istek** sınırı daha doğru bir korumadır.
- **Kenarda mı, uygulamada mı:** Kaba ve anonim sınırlar CDN'de, WAF'ta ya da ingress'te uygulanır. Kötü trafik uygulamaya hiç ulaşmaz. İş kuralına bağlı sınırlar (plan, kiracı, maliyet) uygulamada ya da bir API ağ geçidinde uygulanır, çünkü kimlik ve plan bilgisi orada vardır.

## İstemciyle iletişim

Sınırlanan bir istek **429 Too Many Requests** ile döner. İstemcinin doğru davranabilmesi için yanıt bilgi taşımalıdır:

```text
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Policy: "dakika";q=100;w=60
RateLimit: "dakika";r=0;t=12
```

- **`Retry-After`:** İstemcinin ne kadar beklemesi gerektiğini söyler (saniye ya da tarih).
- **`RateLimit` ve `RateLimit-Policy`:** IETF taslağındaki standart başlıklardır: kalan istek sayısı (`r`), sıfırlanmaya kalan süre (`t`), politika (`q` = kota, `w` = pencere). Başarılı yanıtlarda da gönderilirse, istemciler sınıra ulaşmadan yavaşlayabilir.

İstemci tarafının da sorumlulukları vardır. 429 aldığında `Retry-After` kadar bekler. Başlık yoksa üstel bekleme ve rastgelelikle tekrar dener. **Hemen** tekrar denemek, sınırı daha da zorlar. Kendi servislerinin dış API'leri çağırdığı durumlarda, istemci tarafında da bir jeton kovası uygulamak, 429'a hiç ulaşmamayı sağlar. Sağlayıcının kotası, kendi kapasite planının bir parçasıdır.

```quiz
{
  "question": "Bir API, dakikada 600 istek sınırını sabit pencereyle uyguluyor. Arka uç saniyede en fazla 15 istek taşıyabiliyor. Bazı müşteriler dakikanın son saniyelerinde ve ilk saniyelerinde toplu istek gönderdiğinde arka uç aşırı yükleniyor. Neden ve ne yapılmalı?",
  "options": [
    "Sınır çok yüksek, 300'e düşürülmeli.",
    "Sabit pencerede pencere sınırının iki yanındaki istekler ayrı sayılır. Kısa sürede sınırın iki katı (1200) geçebilir. Bu derste 10 saniyede 200/100 kabul ölçüldü. Kayan sayaç ya da ani yük payı sınırlı bir jeton kovası (örneğin dolum 10/sn, kova 30) kullanılmalı. Arka ucu korumak için ayrıca eşzamanlılık sınırı düşünülmeli.",
    "Sabit pencere her zaman en doğru algoritmadır, sorun arka uçtadır.",
    "Pencereyi 1 saate çıkarmak sorunu çözer."
  ],
  "answer": 1,
  "explanation": "Sabit pencerenin zayıflığı sınır patlamasıdır. Kota amaçlı sınırlarda kabul edilebilir, ama kapasite koruması için uygun değildir. Kapasite koruması kısa ölçekli bir hız (jeton kovası) ya da eşzamanlılık sınırıyla yapılır."
}
```

```quiz
{
  "question": "8 pod'lu bir serviste hız sınırlama Redis'te tutuluyor: Uygulama `GET sayac`, karşılaştırma, ardından `SET sayac sayac+1` yapıyor. Yük testinde sınırın çok aşıldığı görülüyor. Neden?",
  "options": [
    "Redis yavaş olduğu için.",
    "Okuma, karar ve yazma ayrı adımlardır. Eşzamanlı istekler aynı değeri okur, hepsi kabul edilir ve artışlar birbirinin üzerine yazılır (kayıp güncelleme). İşlem atomik olmalıdır: INCR ile dönen değeri karşılaştırmak ya da bir Lua betiği kullanmak. Bu derste aynı desen PostgreSQL'de 1000 sınırında 3200 kabul üretti.",
    "Pod sayısı fazla, tek pod kullanılmalı.",
    "Redis'in kalıcılığı kapalı olduğu için."
  ],
  "answer": 1,
  "explanation": "Paylaşılan sayaç, doğruluğu ancak atomik güncelleme ile sağlar. 'Kontrol et, sonra güncelle' deseni eşzamanlılık altında hem yarışa hem kayıp güncellemeye yol açar."
}
```

```lab
{
  "title": "Kendi hız sınırlayıcını yaz ve kır",
  "steps": [
    "sinir.mjs'e GCRA algoritmasını ekle (anahtar başına tek bir 'teorik varış zamanı'). Jeton kovasıyla aynı senaryolarda aynı sonuçları verdiğini doğrula.",
    "Kayan sayacın en kötü durumda sınırı ne kadar aşabileceğini bulan bir senaryo tasarla (ipucu: önceki pencerenin trafiği sonunda yoğunlaşsın).",
    "sinir-atomik.sql'i jeton kovasına çevir: Tabloda `jeton` ve `son` sütunları olsun, tek bir UPDATE ifadesiyle doldurma ve harcama yapılsın. 16 istemcili pgbench ile 5 saniyede kabul edilen istek sayısının `5 × dolum + kapasite` olduğunu doğrula.",
    "Ters vekil dersindeki Node arka ucuna bir hız sınırlayıcı ara katmanı ekle. 429 yanıtında `Retry-After` ve `RateLimit` başlıklarını döndür. Yük üreticisini 429 aldığında `Retry-After` kadar bekleyecek şekilde değiştir.",
    "Kendi sisteminde hız sınırlarının nerede uygulandığını listele (CDN, ingress, uygulama, dış API'ler). Her biri için anahtar, algoritma, depo ve 'depo düşerse açık mı kapalı mı' sorularını cevapla."
  ]
}
```

## Özet

- Hız sınırlama adalet, maliyet, kötüye kullanım ve aşırı yükten korunma içindir.
- Sabit pencere, sınırında iki katına izin verir (10 sn'de 200/100). Kayan günlük kesin ama pahalıdır. Kayan sayaç ucuz ve yaklaşık doğrudur. Jeton kovası (ve GCRA) ortalama hızı ve ani yük payını ayrı ayarlar, kova kapasitesi kadar aşıma izin verir.
- Kopya başına bellek içi sayaç, sınırı kopya sayısıyla çarpar. Paylaşılan sayaç ise atomik olmalıdır: "Oku, karar ver, yaz" deseni 1000 sınırında 3200 isteği kabul etti, atomik UPDATE tam 1000'de durdu. Redis'te Lua betiği kullanılır.
- Depo düştüğünde güvenlik sınırları kapalı, genel kotalar çoğunlukla açık başarısız olur. Bunu uç nokta bazında bilinçli seç.
- Sınırlar katmanlıdır: kenarda IP, uygulamada kiracı ve plan, pahalı uç noktada maliyet ağırlıklı ya da eşzamanlılık sınırı.
- 429 ile `Retry-After` ve `RateLimit` başlıklarını döndür. İstemciler beklemeli ve rastgele, üstel aralıklarla tekrar denemeli.
