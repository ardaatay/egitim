# Kapasite modeli: gecikme, verim, Little yasası ve kuyruklar

"Sistem yavaşladı, sunucu ekleyelim" cümlesi bazen doğrudur. Çoğu zaman ise sorunun ne olduğu bilinmeden söylenir. Bu ders, kursun geri kalanında kullanacağımız ortak dili kuruyor:

- **Gecikme** ile **verim** nasıl ilişkilidir?
- Bir sunucu yüzde 70 doluyken neden rahat, yüzde 95 doluyken neden çöker?
- Ortalama gecikme neden yalan söyler?

Bunları önce formülle, sonra gerçek bir ölçümle göreceğiz.

## Temel kavramlar

| Kavram | Tanım | Birim |
|---|---|---|
| **Verim** (throughput, λ) | Birim zamanda tamamlanan iş | istek/sn |
| **Gecikme** (latency, W) | Bir isteğin baştan sona süresi: **bekleme + servis** | ms |
| **Servis süresi** (S) | İşin kendisinin süresi, kuyrukta bekleme hariç | ms |
| **Kapasite** (μ = 1/S) | Kaynağın azami verimi | istek/sn |
| **Kullanım** (ρ = λ/μ) | Kaynağın meşgul olduğu zaman oranı | 0–1 |
| **Eşzamanlılık** (L) | Aynı anda sistemde bulunan istek sayısı | adet |

İki yasa bunları birbirine bağlar. Bu yasalar dağılım, dil ya da mimariden bağımsızdır, kararlı her sistemde geçerlidir:

- **Kullanım yasası:** `ρ = λ × S`. Saniyede 200 istek alan ve her isteğe 4 ms CPU harcayan tek çekirdekli bir süreç, zamanın yüzde 80'inde meşguldür.
- **Little yasası:** `L = λ × W`. Saniyede 1000 istek alan ve ortalama 50 ms'de yanıt veren bir servis, her an ortalama **50** isteği işlemektedir. Bu sayı; bağlantı havuzu boyutu, iş parçacığı sayısı ve "aynı anda kaç istek bekleyebilir" sorularının cevabıdır.

Little yasası tasarımda doğrudan kullanılır. Bir servis saniyede 2000 istek alıyor ve her istek veritabanında ortalama 15 ms geçiriyorsa, veritabanı havuzunda ortalama `2000 × 0,015 = 30` bağlantı **meşgul** olur. Havuz 20 bağlantıysa, istekler bağlantı için kuyrukta bekler. Gecikme artar, bu da L'yi artırır ve döngü kendini besler.

## Yük üreticisi

Ölçmek için bir yük üreticisi gerekiyor ve onu kendimiz yazıyoruz. Bu tasarımın kritik özelliği **açık model** olmasıdır:

- İstekler, önceki isteklerin yanıtı beklenmeden, belirlenen hızda (Poisson süreci) gönderilir. Gerçek kullanıcılar da birbirini beklemez.
- Gecikme, isteğin **planlanan** anından ölçülür.

Bu ikinci ayrıntının neden önemli olduğunu yük testi dersinde göreceğiz (koordineli ihmal). Bu üreticiyi kurs boyunca tekrar kullanacağız:

```js
// yuk.mjs — açık model yük üreticisi: istekler Poisson süreciyle, yanıt beklenmeden gönderilir
// Kullanım: node yuk.mjs <url> <hız/sn> <süre/sn> [tohum]
import http from "node:http";
import { createHistogram } from "node:perf_hooks";

export async function yukle({ url, hiz, sure, tohum = 1, zamanAsimi = 10_000, keepAlive = true }) {
  const ajan = new http.Agent({ keepAlive, maxSockets: Infinity });
  let s = tohum >>> 0 || 1;
  const rastgele = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const hist = createHistogram();
  let gonderilen = 0, biten = 0, hata = 0, toplamGecikme = 0;
  const durumlar = {};
  const basla = performance.now();
  const bitis = basla + sure * 1000;
  let sonraki = basla;
  let planlamaBitti = false;
  // Uçuştaki istek sayısının zaman ağırlıklı ortalaması (bir 'gauge' metriği gibi, gecikmelerden bağımsız ölçülür)
  let ucusta = 0, alan = 0, sonT = basla;
  const degis = (d) => { const t = performance.now(); alan += ucusta * (t - sonT); sonT = t; ucusta += d; };

  await new Promise((tamam) => {
    const planla = () => {
      const simdi = performance.now();
      // Planlanan zamanı geçmiş bütün istekleri gönder (gecikme planlanan andan ölçülür)
      while (sonraki <= simdi && sonraki < bitis) {
        const planlanan = sonraki;
        gonderilen++; degis(+1);
        const hedef = typeof url === "function" ? url(rastgele) : url;   // URL bir fonksiyon da olabilir
        const istek = http.get(hedef, { agent: ajan, timeout: zamanAsimi }, (yanit) => {
          yanit.resume();
          yanit.on("end", () => {
            const ms = performance.now() - planlanan;
            hist.record(Math.max(1, Math.round(ms * 1000)));     // mikrosaniye
            toplamGecikme += ms; biten++; degis(-1);
            durumlar[yanit.statusCode] = (durumlar[yanit.statusCode] ?? 0) + 1;
            if (planlamaBitti && biten + hata === gonderilen) tamam();
          });
        });
        istek.on("timeout", () => istek.destroy(new Error("zaman aşımı")));
        istek.on("error", () => { hata++; degis(-1); if (planlamaBitti && biten + hata === gonderilen) tamam(); });
        sonraki += (-Math.log(1 - rastgele()) / hiz) * 1000;   // üstel dağılımlı bekleme
      }
      // Zamanlayıcı çözünürlüğü (Windows'ta ~1-15 ms) üreticinin kendisini geciktirmesin:
      // bir sonraki isteğe 20 ms'den az kaldıysa setImmediate ile bekle (bir çekirdeği meşgul eder)
      const kalan = sonraki - performance.now();
      if (sonraki < bitis) kalan > 20 ? setTimeout(planla, kalan - 15) : setImmediate(planla);
      else { planlamaBitti = true; if (biten + hata === gonderilen) tamam(); }
    };
    planla();
  });
  ajan.destroy();
  const gecen = (performance.now() - basla) / 1000;
  const p = (q) => hist.percentile(q) / 1000;
  return {
    hiz, gonderilen, biten, hata, durumlar,
    verim: biten / gecen,                                        // boşalma süresi dahil gerçek verim
    ort: toplamGecikme / Math.max(1, biten),
    p50: p(50), p90: p(90), p99: p(99), p999: p(99.9), maks: hist.max / 1000,
    eszamanlilik: alan / (sonT - basla),                         // ölçülen L (ortalama eşzamanlı istek)
  };
}

if (process.argv[1]?.endsWith("yuk.mjs")) {                      // doğrudan çalıştırıldıysa
  const [url, hiz, sure, tohum] = process.argv.slice(2);
  if (url) console.log(await yukle({ url, hiz: +hiz, sure: +sure, tohum: +(tohum ?? 1) }));
}
```

Bu üreticiyi yazarken üç ölçüm hatası yaptık. Her biri, gerçek yük testlerinde de sık görülen hatalardan:

1. **Üreticinin kendi gecikmesi:** İlk sürüm her adımda `setTimeout` kullanıyordu. Windows'ta zamanlayıcı çözünürlüğü kaba olduğu için istekler planlanandan geç gidiyordu ve bütün gecikmelere yaklaşık 8 ms ekleniyordu. Yük üreticisi de bir sistemdir ve kendi darboğazları vardır.
2. **Verimin yanlış hesaplanması:** İlk sürüm verimi `biten / test süresi` olarak hesaplıyordu. Aşırı yükte kuyruk test bittikten sonra boşaldığı için bu hesap, kapasitenin üstünde bir "verim" gösteriyordu (250'lik bir sunucu için 300). Doğrusu, gerçekte geçen süreye bölmektir.
3. **Kendini doğrulayan ölçüm:** L'yi önce `toplam gecikme / süre` olarak hesapladık. Bu, λW'nin cebirsel olarak aynısıdır, yani bir doğrulama değildir. Şimdiki sürüm L'yi, uçuştaki istek sayısının zaman ağırlıklı ortalaması olarak ayrı ölçüyor. Üretimdeki bir "eşzamanlı istek" göstergesi de böyle çalışır.

## Deney: kullanım arttıkça gecikme

Sunucu, her isteğe 4 ms boyunca CPU'yu meşgul eden tek iş parçacıklı bir Node süreci. Kuyruk teorisindeki adıyla, sabit servis süreli tek sunucu (M/D/1):

```js
// sabit.mjs — her isteğe sabit S ms CPU işi yapan tek iş parçacıklı sunucu
import http from "node:http";
const S = Number(process.env.S_MS ?? 4);
function mesgul(ms) { const son = performance.now() + ms; while (performance.now() < son); }
http.createServer((req, res) => { mesgul(S); res.end("tamam\n"); })
  .listen(Number(process.env.PORT ?? 4001), "127.0.0.1", () => console.log(`sabit sunucu S=${S}ms`));
```

Önce gerçek kapasiteyi kapasitenin çok üstünde bir yükle ölçüyoruz, sonra artan kullanım oranlarında gecikmeyi:

```js
// egri.mjs — önce gerçek kapasiteyi (μ) ölç, sonra artan ρ'da gecikme ve M/D/1 teorisi
import { yukle } from "./yuk.mjs";
const URL_ = "http://127.0.0.1:4001/";

const doyma = await yukle({ url: URL_, hiz: 400, sure: 10, tohum: 5 });   // kapasitenin çok üstünde
const MU = doyma.verim, S = 1000 / MU;
console.log(`ölçülen kapasite μ ≈ ${MU.toFixed(0)} istek/sn  ->  etkin servis süresi S ≈ ${S.toFixed(2)} ms\n`);

const satir = (...a) => console.log(a.map((x, i) => String(x).padStart(i === 0 ? 5 : 8)).join(""));
satir("ρ", "hız", "verim", "ort", "p50", "p99", "p99.9", "teori", "L", "λW");
for (const rho of [0.2, 0.5, 0.7, 0.8, 0.9, 0.95]) {
  const hiz = Math.round(rho * MU);
  const r = await yukle({ url: URL_, hiz, sure: 20, tohum: 7 });
  const teori = S + (rho * S) / (2 * (1 - rho));             // M/D/1 ortalama yanıt süresi (ms)
  satir(rho, hiz, r.verim.toFixed(0), r.ort.toFixed(1), r.p50.toFixed(1), r.p99.toFixed(1), r.p999.toFixed(1),
    teori.toFixed(1), r.eszamanlilik.toFixed(2), (r.verim * r.ort / 1000).toFixed(2));
}
```

```bash
node sabit.mjs &
node egri.mjs
```

```text
ölçülen kapasite μ ≈ 234 istek/sn  ->  etkin servis süresi S ≈ 4.27 ms

    ρ     hız   verim     ort     p50     p99   p99.9   teori       L      λW
  0.2      47      48     5.1     4.5    11.3    26.6     4.8    0.24    0.24
  0.5     117     121     6.4     4.7    17.8    20.5     6.4    0.77    0.78
  0.7     164     166     8.6     7.2    26.2    33.7     9.2    1.43    1.43
  0.8     188     190    11.3     9.0    34.7    51.8    12.8    2.14    2.14
  0.9     211     211    18.0    14.0    62.9    78.1    23.5    3.80    3.80
 0.95     223     223    31.2    24.6   101.7   122.0    44.8    6.95    6.95
```

Bu tablo kursun en önemli tablosu. Okumanın yolu şöyle:

- **Etkin servis süresi 4 değil 4,27 ms.** Fark, HTTP ayrıştırması ve yanıt yazımından geliyor. Kapasiteyi kodun "iş" kısmından hesaplamak yerine ölçmek gerekir.
- **Verim, yüke kadar doğrusal artıyor**, gecikme ise artmıyor, **patlıyor**. Kullanım 0,2'den 0,8'e çıkarken (4 kat) ortalama gecikme iki katına çıkıyor. 0,8'den 0,95'e çıkarken (yüzde 19 artış) üç katına çıkıyor. Kuyruk teorisinin formülü bunu açıklıyor. Bekleme süresi `ρ / (1 − ρ)` ile orantılıdır: ρ=0,5'te 1, ρ=0,8'de 4, ρ=0,9'da 9, ρ=0,95'te 19, ρ=0,99'da 99.
- **Teori ile ölçüm, ρ=0,8'e kadar birkaç milisaniye içinde uyuşuyor.** Daha yüksek kullanımda ölçüm teoriden düşük çıkıyor. Bunun nedeni, kapasiteyi aşırı yükte ölçmemiz. Aşırı yükte Node istekleri olay döngüsünün bir turunda toplu işler ve tur başına sabit maliyeti paylaştırır. Bu, ölçülen μ'yü normal yüktekinden biraz yüksek gösterir, dolayısıyla gerçek ρ tablodakinden biraz düşüktür. Modeller kesin rakam vermez. **Eğrinin biçimini** doğru verir.
- **Yüzdelikler ortalamadan çok daha hızlı bozuluyor.** ρ=0,95'te ortalama 31 ms, p99 102 ms ve p99.9 122 ms. Kullanıcıların yüzde birinin her 100 istekte bir yaşadığı gecikme, ortalamanın üç katı.
- **L ve λW her satırda aynı.** Little yasası, sistemin iç yapısını bilmeden, ortalama eşzamanlılığı verimden ve gecikmeden hesaplamamızı sağlıyor.

Pratik sonuç: **Kaynakları yüzde 100'e göre değil, yüzde 60–75'e göre planla.** Kalan pay israf değildir. Ani yük artışlarını (burst), bir kopyanın düşmesini ve dağıtım sırasında azalan kapasiteyi gecikme patlaması olmadan karşılayan tampondur. Kubernetes'te HPA'nın hedef CPU kullanımını yüzde 100 değil yüzde 60–70 civarında tutmasının nedeni de budur. Bunu gözlem dersinde tekrar ele alacağız.

### Çok sunuculu kuyruk

Aynı toplam kapasite, **tek büyük kuyruk ve çok sunucu** olarak düzenlenirse bekleme çok azalır. Bankadaki tek sıra ve çok gişe düzeni buna örnektir. Ayrı sıralar ve ayrı gişeler ise daha kötüdür: Bir sıra boşken diğeri dolu olabilir. Yük dengeleyicinin "en az bağlantı" ya da "iki rastgele seçim, azı" (power of two choices) algoritmaları, ayrı kuyrukları tek kuyruğa yaklaştırmaya çalışır. Bunu ters vekil dersinde göreceğiz.

## Ortalama neden yalan söyler

Gecikme dağılımları simetrik değildir. Uzun bir kuyruğa (tail) sahiptir: çöp toplama duraklamaları, önbellek ıskaları, kilit beklemeleri, TCP yeniden iletimleri. Ortalama bu kuyruğu ya gizler ya da birkaç aşırı değer tarafından çarpıtılır. Bu yüzden:

- Gecikme **yüzdeliklerle** raporlanır: p50 (tipik deneyim), p99 ve p99.9 (kuyruk).
- Yüzdelikler **histogramlardan** hesaplanır. Yüzdeliklerin ortalaması alınamaz: Beş sunucunun p99'larının ortalaması, sistemin p99'u değildir. İzleme sistemlerinde ham histogramlar toplanır, yüzdelik en son hesaplanır.

### Ölçekte kuyruk: dağılım çarpılır

Bir sayfa isteği 10 arka uç servisine paralel çağrı yapıyorsa, isteğin süresi **en yavaş** çağrının süresidir. Her arka uç kendi başına yüzde 1 olasılıkla p99'unu aşıyorsa:

```bash
node -e 'console.log("N arka uç | en az birinin p99 aşma olasılığı | isteğin p50 olarak gördüğü arka uç yüzdeliği");
for (const n of [1, 5, 10, 50, 100]) { const p = 1 - 0.99 ** n, q = 0.5 ** (1 / n);
  console.log(String(n).padStart(4), " | ", (p * 100).toFixed(1).padStart(5) + "%", " | p" + (q * 100).toFixed(1)); }'
```

```text
N arka uç | en az birinin p99 aşma olasılığı | isteğin p50 olarak gördüğü arka uç yüzdeliği
   1  |    1.0%                       | p50.0
   5  |    4.9%                       | p87.1
  10  |    9.6%                       | p93.3
  50  |   39.5%                       | p98.6
 100  |   63.4%                       | p99.3
```

100 servise dağılan bir istekte, isteklerin yüzde 63'ü en az bir yavaş arka uca takılır. Arka uçların **p99**'u, kullanıcının **tipik** (p50) deneyimi olur. Mikroservis mimarilerinde kuyruk gecikmesinin bu kadar önemli olmasının nedeni budur. Önlemler (Google'ın "The Tail at Scale" makalesinden):

- **Yayılımı azalt:** Bir istekteki paralel çağrı sayısını azalt, toplu (batch) API'ler kullan.
- **Yedek istek (hedged request):** p95 süresi geçtiği halde yanıt gelmediyse aynı isteği ikinci bir kopyaya gönder, ilk geleni kullan. Ek yük yaklaşık yüzde 5 olur, kuyruk dramatik biçimde kısalır. Sadece idempotent isteklerde kullanılır.
- **Kısmi yanıt:** Önemsiz bir arka uç zamanında yanıt vermediyse sayfayı onsuz gönder (dayanıklılık dersi).

## Ölçeklenebilirlik yasaları

Bir sunucu yerine iki sunucu, iki kat verim verir mi? Ancak iş tamamen paralelleştirilebiliyorsa.

- **Amdahl yasası:** İşin seri kısmı (paylaşılan bir kilit, tek bir veritabanı satırı, sıralı bir adım) toplam hızlanmayı sınırlar. İşin yüzde 5'i seriyse, sonsuz sunucuyla bile azami hızlanma 20 kattır.
- **Evrensel Ölçeklenebilirlik Yasası (USL):** Gunther'in yasası, Amdahl'a bir **tutarlılık maliyeti** ekler: Düğümlerin birbirleriyle eşgüdüm kurma maliyeti (önbellek tutarlılığı, dağıtık kilitler, çoğaltma). Bu terim düğüm sayısının karesiyle büyür. Sonuç olarak verim belirli bir noktadan sonra yalnızca durmaz, **düşer**. Sunucu eklemek sistemi yavaşlatır.

```text
                N
X(N) = ─────────────────────────      σ: çekişme (seri kısım), κ: tutarlılık maliyeti
        1 + σ(N − 1) + κN(N − 1)
```

Pratik anlamı şudur: Yatay ölçeklemenin önündeki engel çoğunlukla **paylaşılan durumdur**. Kursun geri kalanının büyük kısmı, paylaşılan durumu azaltma ya da dağıtma teknikleridir: önbellek, replika, parçalama, kuyruk.

## Zarf arkası hesap

Tasarımın ilk adımı, kabaca da olsa sayılarla konuşmaktır:

```text
Günde 10 milyon istek                 → ortalama 10e6 / 86400 ≈ 116 istek/sn
Tepe / ortalama oranı (tipik 3–10)     → tepe ≈ 600–1200 istek/sn
İstek başına 20 ms CPU                → tepe için 12–24 çekirdek-saniye/sn → %65 hedefle 18–37 çekirdek
Ortalama yanıt 80 ms                  → Little: tepe eşzamanlılık ≈ 1200 × 0,08 ≈ 96 istek
İstek başına 3 veritabanı sorgusu × 5 ms → veritabanında meşgul bağlantı ≈ 1200 × 3 × 0,005 = 18
Yanıt 15 KB                           → tepe çıkış ≈ 1200 × 15 KB ≈ 18 MB/sn ≈ 144 Mbit/sn
```

Bu hesap bir tahmindir, ama hangi kaynağın önce tükeneceğini ve hangi sayının ölçülmesi gerektiğini söyler. Dikkat çeken bir nokta: Günlük 10 milyon istek "büyük" görünür, ama ortalama saniyede 116 istektir. Bu yükü iyi yazılmış tek bir servis karşılar. Çoğu sistemin sorunu ortalama değil, **tepe** ve **kuyruk** davranışıdır.

> **İpucu:** Tanınmış gecikme mertebelerini akılda tutmak bu hesapları hızlandırır. Bellek erişimi yaklaşık 100 ns, aynı veri merkezinde gidiş-dönüş yaklaşık 0,5 ms, SSD'den rastgele okuma yaklaşık 100 µs, aynı kıtada bölgeler arası gidiş-dönüş 20–80 ms, kıtalar arası 100–200 ms. Bir isteği 10 ardışık veritabanı sorgusuna bölmek ağ gidiş-dönüşüyle 5 ms ekler. Kıtalar arası bir çağrı tek başına 150 ms ekler.

```quiz
{
  "question": "Bir API'nin ortalama CPU kullanımı %55, ortalama gecikmesi 40 ms. Kampanya döneminde trafiğin %60 artması bekleniyor. 'CPU %88'e çıkar, hâlâ %100'ün altında, sorun olmaz' deniyor. Bu değerlendirmedeki hata ne?",
  "options": [
    "Hata yok. %100'e ulaşılmadıkça gecikme değişmez.",
    "Kuyruk bekleme süresi ρ/(1−ρ) ile orantılı büyür. %55'te bu oran yaklaşık 1,2, %88'de yaklaşık 7,3. Bekleme süresi altı kat artar, kuyruk gecikmesi (p99) daha da fazla bozulur. Üstelik tepe anlar ortalamanın üstündedir ve bir kopya düşerse kullanım %100'ü aşar. Kapasite %60–75 hedefiyle planlanmalı.",
    "CPU %88'e çıkınca verim düşer, gecikme değişmez.",
    "Sadece bellek kullanımına bakmak gerekir."
  ],
  "answer": 1,
  "explanation": "Kullanım ile gecikme arasındaki ilişki doğrusal değildir. Yüksek kullanımda küçük yük artışları büyük gecikme artışlarına yol açar. Kapasite planlaması ortalamaya değil, tepeye ve kuyruk gecikmesine göre yapılır."
}
```

```quiz
{
  "question": "Bir servis saniyede 3000 istek alıyor. Her istek veritabanında ortalama 8 ms geçiriyor. Bağlantı havuzu 16 bağlantı. Ne beklenir?",
  "options": [
    "Sorun yok. 16 bağlantı, saniyede 16 × 1000 = 16.000 istek demektir.",
    "Little yasasına göre ortalama 3000 × 0,008 = 24 bağlantı meşgul olmalı. 16'lık havuzda istekler bağlantı için kuyrukta bekler, gecikme ve dolayısıyla L artar, havuz sürekli doygun kalır. Havuz büyütülmeli ya da veritabanı süresi kısaltılmalı. Veritabanının kendi kapasitesi de hesaba katılmalı.",
    "Little yasası sadece kuyruk sistemleri için geçerlidir, veritabanı için geçerli değildir.",
    "Bağlantı sayısı gecikmeyi etkilemez."
  ],
  "answer": 1,
  "explanation": "L = λW. Gereken ortalama eşzamanlılık 24'tür. Ani yükler için ek pay da gerekir. Ama havuzu büyütmek veritabanını da yükler. Havuz boyutunun veritabanı tarafındaki sınırı, veritabanı dersinde ölçülecek."
}
```

```lab
{
  "title": "Kendi kullanım eğrini çıkar",
  "steps": [
    "sabit.mjs ve egri.mjs'i çalıştır. Kendi makinendeki μ değerini ve ρ=0,9'daki p99'u not et. Ölçümü üç farklı tohumla tekrarla ve sonuçların ne kadar değiştiğini gör.",
    "sabit.mjs'teki sabit servis süresini üstel dağılımlı yap (`mesgul(-Math.log(1 - Math.random()) * S)`). Bu bir M/M/1 kuyruğudur, ortalama yanıt süresi S/(1−ρ). Aynı ρ'da gecikmenin ve p99'un M/D/1'e göre nasıl değiştiğini ölç. Servis süresindeki değişkenlik kuyruğu nasıl etkiliyor?",
    "sabit.mjs'i 4 süreç olarak (farklı portlarda) çalıştır. Önce yük üreticisini rastgele bir porta, sonra her zaman 'en az uçuştaki isteği olan' porta yönlendirecek şekilde değiştir. Aynı toplam yükte p99'u karşılaştır.",
    "Kendi çalıştığın bir servis için zarf arkası hesap yap: günlük istek, tepe oranı, istek başına CPU ve veritabanı süresi. Gereken çekirdek ve havuz boyutunu hesapla, gerçek değerlerle karşılaştır.",
    "Bir izleme panosunda ortalama gecikme ile p99 grafiklerini yan yana koy. Ortalamanın 'sakin' göründüğü ama p99'un sıçradığı bir an bul ve nedenini araştır."
  ]
}
```

## Özet

- Verim, gecikme, servis süresi, kullanım ve eşzamanlılık şu iki yasayla birbirine bağlıdır: `ρ = λS` ve `L = λW`. Little yasası havuz ve iş parçacığı boyutlarının temelidir.
- Kullanım arttıkça gecikme doğrusal değil, `ρ/(1−ρ)` ile artar. Ölçüm, M/D/1 teorisiyle ρ=0,8'e kadar uyuştu. 0,8'den 0,95'e çıkışta gecikme üç katına çıktı. Kapasite %60–75 hedefiyle planlanır.
- Kapasiteyi koddan hesaplama, ölç. Etkin servis süresi HTTP yükü yüzünden 4 değil 4,27 ms çıktı.
- Yük üreticisi de bir sistemdir: zamanlayıcı çözünürlüğü, boşalma süresi ve kendini doğrulayan metrikler ölçümü bozar.
- Gecikme histogramla toplanır, yüzdeliklerle raporlanır. Paralel çağrılarda arka ucun p99'u kullanıcının p50'si olur. Yayılımı azalt, idempotent isteklerde yedek istek kullan.
- Ölçeklenme seri kısım (Amdahl) ve tutarlılık maliyetiyle (USL) sınırlıdır. Asıl engel paylaşılan durumdur.
- Tasarım zarf arkası hesapla başlar: tepe hız, çekirdek, eşzamanlılık, bağlantı, bant genişliği.
