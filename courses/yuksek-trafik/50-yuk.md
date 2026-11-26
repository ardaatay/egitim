# Yük testi: açık ve kapalı model, koordineli ihmal ve kapasite planı

Kurs boyunca her konuyu yük altında ölçtük. Bu ders o ölçümlerin **yöntemini** ele alıyor: Yanlış yapılan bir yük testi, ölçüm yapmamaktan daha tehlikelidir, çünkü yanlış bir güven verir. Bu derste ele aldığımız sorular:

- Yük üreticisi nasıl tasarlanır?
- Hangi test türü hangi soruyu cevaplar?
- Sonuçlar bir kapasite planına nasıl dönüşür?

## Koordineli ihmal

Bütün yük testi hatalarının en yaygını ve en sinsisi budur. Bir yük üreticisi **kapalı model** ile çalışabilir: N "sanal kullanıcı", her biri bir istek gönderir, yanıtı **bekler**, biraz düşünür, sonra yenisini gönderir. Çoğu aracın varsayılanı budur. Bu modelin bir kör noktası var: Sunucu donduğunda sanal kullanıcılar da yanıtı beklerken durur. Dolayısıyla **yeni istek göndermezler**. Donma süresince gelmesi gereken yüzlerce istek hiç gönderilmez, bu yüzden hiç ölçülmez. Ölçüm aracı, sistemin en kötü anlarını kendisi atlar. Gil Tene bu olguya "koordineli ihmal" (coordinated omission) adını verdi.

Gösterelim. Sunucu normalde 1 ms'de yanıt veriyor, ama her 5 saniyede bir olay döngüsünü 1 saniye donduruyor. Bu davranış uzun bir GC duraklamasını, bir kilit beklemesini ya da senkron bir yeniden yüklemeyi temsil ediyor:

```js
// duraklayan.mjs — normalde ~1 ms, her 5 sn'de bir 1 sn donan sunucu
import http from "node:http";
const mesgul = (ms) => { const son = performance.now() + ms; while (performance.now() < son); };
setInterval(() => mesgul(1000), 5000);
http.createServer((req, res) => res.end("ok\n")).listen(4040, "127.0.0.1", () => console.log("duraklayan 4040"));
```

Aynı sunucuyu iki modelle ölçüyoruz. Kapalı modelde 10 sanal kullanıcı var, her biri yanıttan sonra 20 ms düşünüyor. Açık model ise kapalı modelin ulaştığı **aynı ortalama hızda**, kapasite dersindeki üreticiyle yük gönderiyor:

```js
// ihmal-test.mjs
async function kapali(url, K, saniye) {
  const ajan = new http.Agent({ keepAlive: true, maxSockets: K });
  const hist = createHistogram(); let n = 0;
  const bitis = performance.now() + saniye * 1000;
  await Promise.all(Array.from({ length: K }, async () => {
    while (performance.now() < bitis) {
      const t0 = performance.now();                                      // gecikme GÖNDERİM anından ölçülür
      await new Promise((ok) => http.get(url, { agent: ajan }, (r) => { r.resume(); r.on("end", ok); }).on("error", ok));
      hist.record(Math.max(1, Math.round((performance.now() - t0) * 1000))); n++;
      await new Promise((ok) => setTimeout(ok, 20));                     // her sanal kullanıcı 20 ms 'düşünür'
    }
  }));
  ajan.destroy();
  return { verim: n / saniye, p50: hist.percentile(50) / 1000, p99: hist.percentile(99) / 1000, p999: hist.percentile(99.9) / 1000, maks: hist.max / 1000, n };
}

const k = await kapali(URL_, 10, 30);
const a = await yukle({ url: URL_, hiz: Math.round(k.verim), sure: 30, tohum: 2 });   // açık model, aynı hız
```

```text
kapalı model (10 sanal kullanıcı)  istek= 7710 verim= 257/sn  p50=   1.2  p99=    3.0  p99.9= 1001.0  maks= 1001 ms
açık model (aynı ortalama hız)     istek= 7725 verim= 257/sn  p50=   0.4  p99=  948.2  p99.9=  997.4  maks= 1001 ms
```

Aynı sunucu, aynı ortalama hız, aynı istek sayısı. Kapalı model **p99 = 3 ms** diyor, açık model **p99 = 948 ms**. Hangisi doğru? Sunucu zamanın **%20'sinde** (5 saniyenin 1 saniyesinde) donuk. Gerçek kullanıcılar birbirini beklemediği için, gelenlerin yaklaşık %20'si 0 ile 1000 ms arasında bekler. Gerçek p99 1 saniyeye yakındır. Kapalı model bunu göremedi. 10 sanal kullanıcı donma sırasında sadece 10 istek göndermişti, yani sadece 10 yavaş örnek oluştu, onlar da binlerce hızlı örneğin arasında p99.9'a itildi. Sorun aynı **maks** değerinde de görünüyor. İki model de 1001 ms gördü, ama kapalı modelde bu değer bir "aykırı nokta" gibi duruyor.

Bu yüzden:

- Gecikme, isteğin **planlanan** anından ölçülür, gönderildiği andan değil. Kapasite dersindeki üretici bunu en baştan böyle yapıyordu.
- Kullanıcı trafiğini simüle etmek için açık model (sabit varış hızı) kullanılır. k6'da `constant-arrival-rate` ve `ramping-arrival-rate`, wrk2'de `-R`, Gatling'de `constantUsersPerSec`. k6'nın varsayılan `vus` yürütücüsü ise kapalı modeldir.
- Kapalı model de yanlış değildir. **Azami verimi** bulmak için doğru araçtır (Node dersinde cluster ölçeğini böyle ölçtük). Ayrıca gerçekten kapalı sistemleri de doğru temsil eder: sabit sayıda işçisi olan bir toplu iş ya da kendi havuzu dolunca bekleyen bir istemci. Önemli olan sorunun doğru modelle sorulmasıdır.

## Test türleri

| Tür | Soru | Biçim |
|---|---|---|
| **Duman** (smoke) | Senaryo çalışıyor mu, hata var mı? | Çok düşük yük, kısa süre. Her dağıtımdan sonra |
| **Yük** (load) | Beklenen tepe yükte SLO'lar tutuyor mu? | Hedef hıza kademeli çıkış, 15–60 dk sabit |
| **Stres** | Kırılma noktası nerede ve nasıl kırılıyor? | Kapasiteyi aşana kadar artan hız. Kırılma biçimi önemlidir: zarif yük atma mı, çöküş mü? |
| **Ani yük** (spike) | Aniden 5 katına çıkan trafikte ne olur? | Saniyeler içinde sıçrama. Otomatik ölçekleme yetişiyor mu, önbellek ve havuzlar dayanıyor mu? |
| **Dayanıklılık** (soak) | Saatler içinde ne bozuluyor? | Normal yükte 4–24 saat. Bellek sızıntısı, bağlantı sızıntısı, log ve disk dolması, GC'nin kötüleşmesi |
| **Kapasite** | Bir kopya ya da bir küme ne kadar taşır? | Kademeli adımlar, her adımda gecikme ve kaynak kullanımı |

En değerli olan çoğunlukla **stres testidir**, çünkü kırılma biçimini gösterir. Dayanıklılık dersindeki yük atma, devre kesici ve geri basınç önlemleri tam bu testte kendini gösterir. Kapasitesinin %150'sini alan bir sistemin, kabul ettiği %100'ü zamanında yanıtlayıp gerisini hızlıca reddetmesi gerekir. Önceki derslerde bunun tersini birkaç kez gördük: Kapasitenin üstünde gecikme saniyelere çıktı ve verim düştü.

## Bir yük testinin anatomisi

Aşağıdaki k6 betiği, kapasite dersindeki üreticinin yaptığını bir test aracında ifade ediyor: açık model, kademeli artış, eşikler ve gerçekçi bir istek karışımı.

```js
// yuk-testi.js — k6 (bu ortamda k6 kurulu değil; betik yapıyı göstermek için)
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    tepe: {
      executor: "ramping-arrival-rate",       // AÇIK model: varış hızı, VU sayısından bağımsız
      startRate: 50, timeUnit: "1s",
      preAllocatedVUs: 200, maxVUs: 2000,     // VU'lar biterse k6 'dropped_iterations' bildirir
      stages: [
        { target: 600, duration: "5m" },      // ısınma ve kademeli artış
        { target: 600, duration: "20m" },     // hedef tepe
        { target: 1200, duration: "5m" },     // stres: tepenin 2 katı
        { target: 0, duration: "2m" },
      ],
    },
  },
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration{grup:urun}": ["p(99)<300"],
    "http_req_duration{grup:odeme}": ["p(99)<800"],
    "dropped_iterations": ["count==0"],       // üretici yetişemediyse test geçersiz
  },
};

const urunler = JSON.parse(open("./urun-idleri.json"));   // üretimden örneklenmiş, Zipf benzeri dağılım

export default function () {
  const id = urunler[Math.floor(Math.random() * urunler.length)];
  const r = http.get(`${__ENV.HEDEF}/urun/${id}`, { tags: { grup: "urun" } });
  check(r, { "200": (x) => x.status === 200 });
  if (Math.random() < 0.05) {                              // isteklerin %5'i ödeme akışı
    http.post(`${__ENV.HEDEF}/odeme`, JSON.stringify({ urun: id }), {
      headers: { "content-type": "application/json", "idempotency-key": `${__VU}-${__ITER}` },
      tags: { grup: "odeme" },
    });
  }
}
```

Bu betikte ve her yük testinde dikkat edilmesi gerekenler:

- **Üretici darboğazı:** Yük üreticisinin CPU'su, ağı ve dosya tanımlayıcıları da sınırlıdır. Bu kursta da ilk denemede üreticinin kendi zamanlayıcı gecikmesi bütün ölçümlere 8 ms ekledi (kapasite dersi). Bir başka denemede açık model üretici, kapasite üstünde binlerce soket açıp sonuçları bozdu (Node dersi). Üreticinin CPU'sunu izle ve hedeflenen hıza **gerçekten** ulaşıldığını doğrula (`dropped_iterations`). Büyük testleri dağıtık üreticilerle yap.
- **Gerçekçi veri ve karışım:** Hep aynı ürünü isteyen bir test, %100 önbellek isabetiyle sahte bir başarı ölçer (önbellek dersi). Anahtar dağılımı, istek karışımı (okuma/yazma oranı, uç noktalar) ve veri hacmi üretime benzemelidir. En iyi kaynak, üretim loglarından örneklemektir. Kişisel veri kullanılmaz (güvenlik kursu).
- **Isınma:** JIT derlemesi, önbellekler, bağlantı havuzları ve otomatik ölçekleme ilk dakikalarda sabit değildir. Isınma dönemi ölçüme katılmaz, ya da "soğuk başlangıç" ayrıca ölçülür.
- **Ortam:** Test ortamı, üretimle aynı kaynak sınırlarına, aynı sürüme, aynı yapılandırmaya ve benzer veri hacmine sahip olmalıdır. 1000 satırlık bir test veritabanı, 50 milyon satırlık üretimin sorgu planlarını göstermez. Paylaşılan bir test ortamında başka testler sonuçları bozar.
- **Bağımlılıklar:** Dış API'ler (ödeme, SMS) gerçekten çağrılmaz. Sahte servislerle (mock) değiştirilir. Bu sahte servisler de gerçekçi gecikmelerle (ve ara sıra hatalarla) yanıt vermelidir. 0 ms'de yanıt veren bir sahte ödeme servisi, havuz ve zaman aşımı sorunlarını gizler.
- **Sadece gecikme değil:** Test süresince sistemin bütün kaynakları izlenir: CPU, bellek, GC, havuz bekleme süreleri, veritabanı bağlantıları ve kilitleri, kuyruk derinlikleri, hata oranları. Hedef, **ilk tükenen kaynağı** bulmaktır.
- **İzin:** Kursun başında söylediğimiz gibi: Yük testi yalnızca kendi sistemlerine, ilgili ekiplerin (ve bulut sağlayıcısının politikasının) haberi olarak yapılır. Bir CDN ya da WAF arkasındaki üretim ortamına yapılan habersiz bir test, bir saldırıdan ayırt edilemez.

## Sonuçtan kapasite planına

Yük testinin çıktısı tek bir sayı değil, bir **eğridir**. Kapasite dersindeki gibi, artan yük karşısında gecikme ve verim. Kapasite planı bu eğriden şöyle türetilir:

1. **SLO'yu karşılayan azami hızı bul.** Örneğin "p99 < 300 ms" koşulunu sağlayan en yüksek hız, kopya başına 450 istek/sn. Gecikmenin patladığı dirsek noktası değil, ondan önceki güvenli nokta seçilir.
2. **Darboğazı adlandır.** Bu hızda ilk tükenen kaynak ne? CPU mu, veritabanı bağlantıları mı, bir dış API'nin kotası mı? Darboğaz uygulama kopyasındaysa yatay ölçekleme işe yarar. Paylaşılan bir kaynaktaysa (veritabanı, tek bir sıcak anahtar) pod eklemek hiçbir şey kazandırmaz (USL).
3. **Ölçeklemenin doğrusallığını doğrula.** 1 kopyada 450 ise, 4 kopyada 1800 mü, yoksa 1300 mü? Doğrusallıktan sapma, paylaşılan bir darboğazın ilk işaretidir.
4. **Tepeyi ve payı hesapla:**

   ```text
   beklenen tepe (kampanya)          : 6000 istek/sn
   kopya başına güvenli hız          : 450 istek/sn  (p99 < 300 ms)
   gereken kopya                     : 6000 / 450 ≈ 14
   bir bölge/düğüm kaybına dayanma   : N+1 ya da %30 pay → 18–19 kopya
   veritabanı: kopya başına 12 bağlantı × 19 = 228 → havuzlayıcı ile sunucu tarafında 40
   ```

5. **Ölçeklemenin hızını hesaba kat.** Otomatik ölçekleme anlık değildir. Metriğin toplanması, karar, yeni pod'un zamanlanması, imajın çekilmesi, uygulamanın başlaması ve ısınması dakikalar sürebilir. Ani yük testinde, bu süre boyunca mevcut kopyaların fazla yükü taşıması gerekir. Önceden planlanmış olaylar (kampanyalar, yayınlar) için **önceden ölçekle**. Bunu sonraki derste ele alacağız.
6. **Düzenli tekrarla.** Kapasite statik değildir. Her sürüm bir sorgu, bir bağımlılık ya da bir serileştirme maliyeti ekleyebilir. Yük testini CI/CD'ye bağla: Gece çalışan bir kapasite testi ve sürümler arasındaki "aynı yükte gecikme" karşılaştırması, performans gerilemelerini üretime ulaşmadan yakalar.

```quiz
{
  "question": "Bir ekip k6'nın varsayılan VU modeliyle (100 sanal kullanıcı, her biri yanıttan sonra yeni istek gönderir) yük testi yapıyor ve p99 = 40 ms ölçüyor. Üretimde ise kullanıcılar zaman zaman 2 saniyelik takılmalar yaşıyor. En olası açıklama hangisi?",
  "options": [
    "Üretim ağı test ağından yavaştır.",
    "Koordineli ihmal: Kapalı modelde sunucu duraksadığında sanal kullanıcılar da yanıt bekleyerek durur ve o sırada gelmesi gereken istekler hiç gönderilmez, dolayısıyla ölçülmez. Gecikme planlanan andan ölçülmeli ve kullanıcı trafiği açık modelle (constant/ramping-arrival-rate) simüle edilmelidir. Bu derste aynı sunucu kapalı modelde p99=3 ms, açık modelde p99=948 ms ölçüldü.",
    "k6 yanlış hesaplama yapıyor.",
    "Test süresi kısa olduğu için."
  ],
  "answer": 1,
  "explanation": "Kapalı model, sistemin yavaş olduğu anlarda kendi yükünü azaltır ve en kötü anları örneklemez. Gerçek kullanıcılar birbirini beklemez. Kullanıcıya dönük gecikme SLO'ları açık modelle doğrulanır."
}
```

```quiz
{
  "question": "Bir yük testinde uygulama 4 kopyadan 8 kopyaya çıkarıldığında azami verim sadece %15 artıyor. Uygulama pod'larının CPU'su %40 civarında. İlk bakılması gereken yer neresidir?",
  "options": [
    "Pod'ların CPU limitleri.",
    "Paylaşılan bir darboğaz: veritabanı (bağlantı havuzu doygunluğu, kilitler, CPU), paylaşılan önbellekte sıcak anahtar, tek bir dış servis ya da yük üreticisinin kendisi. Doğrusal olmayan ölçekleme, kopyalar arasında paylaşılan bir kaynağın ya da tutarlılık maliyetinin işaretidir. Havuz bekleme süreleri ve veritabanı metrikleri incelenmelidir.",
    "Kopya sayısını 16'ya çıkarmak.",
    "Node.js sürümünü güncellemek."
  ],
  "answer": 1,
  "explanation": "Kopya CPU'su düşükken verim artmıyorsa, darboğaz kopyalarda değildir. USL'deki çekişme ve tutarlılık terimleri devrededir. Önce ilk tükenen kaynağı bulmak gerekir."
}
```

```lab
{
  "title": "Kendi yük testi metodolojini kur",
  "steps": [
    "duraklayan.mjs ve ihmal-test.mjs'i çalıştır. Donma süresini 1 sn'den 200 ms'ye, aralığı 5 sn'den 30 sn'ye çıkar. Kapalı ve açık modelin p99 farkının nasıl değiştiğini tabloya dök.",
    "Kapasite dersindeki sabit.mjs için bir 'SLO'yu sağlayan azami hız' arayıcısı yaz: p99 < 20 ms koşulunu sağlayan en yüksek hızı ikili aramayla bul (her adım 15 sn). Bulduğun değeri ρ olarak ifade et.",
    "Önbellek dersindeki onbellek.mjs'e karşı iki test yap: Biri hep aynı 10 ürünü, diğeri Zipf dağılımıyla 10.000 ürünü istesin. Sonuçlar arasındaki farkı 'gerçekçi veri' açısından yorumla.",
    "Yük üreticisinin kendi CPU kullanımını ölçen bir kontrol ekle (`process.cpuUsage()`). Üreticinin bir çekirdeği doyurduğu hızı bul ve o hızın üstündeki ölçümleri geçersiz say.",
    "Kendi servisin için bir test planı yaz: hangi test türleri, hangi istek karışımı ve veri, hangi eşikler (SLO'lardan türetilmiş), hangi kaynak metrikleri izlenecek, test ortamı üretimden nasıl farklı?"
  ]
}
```

## Özet

- Kapalı model, sunucu duraksadığında kendi yükünü keser ve en kötü anları ölçmez (koordineli ihmal). Aynı sunucu kapalı modelde p99=3 ms, açık modelde p99=948 ms ölçüldü. Gerçek değer 1 saniyeye yakın.
- Kullanıcı trafiğini açık modelle (sabit varış hızı) simüle et ve gecikmeyi planlanan andan ölç. Azami verimi kapalı modelle bul.
- Test türleri farklı soruları cevaplar: duman, yük, stres (kırılma biçimi), ani yük (ölçekleme hızı), dayanıklılık (sızıntılar), kapasite.
- Geçerli bir test için: üreticinin hedef hıza ulaştığını doğrula, gerçekçi veri ve karışım kullan, ısınmayı ayır, üretime benzer ortam ve gerçekçi sahte bağımlılıklar kullan, bütün kaynakları izle, izin al.
- Kapasite planı eğriden türetilir: SLO'yu sağlayan güvenli hız, adlandırılmış darboğaz, doğrusallık kontrolü, tepe ve kayıp payı, ölçeklemenin süresi. Testi düzenli olarak CI/CD'de tekrarla.
