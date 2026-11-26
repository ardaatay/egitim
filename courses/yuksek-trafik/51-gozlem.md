# Gözlemlenebilirlik, SLO ve otomatik ölçekleme

Kurs boyunca ölçümleri kendi betiklerimizle aldık. Üretimde ise sistem, gecenin üçünde de, kimse bakmazken de kendini anlatabilmelidir: Ne kadar iş yapıyor, ne kadar hızlı, ne kadar hatalı, hangi kaynağı tüketiyor? **Gözlemlenebilirlik** bunun altyapısıdır. **SLO**'lar ölçümleri "iyi mi kötü mü" kararına çevirir. **Otomatik ölçekleme** de bu kararlara göre kapasiteyi ayarlar. Bu son ders üçünü birleştiriyor.

## Ne ölçülür

İki tamamlayıcı yöntem, neredeyse her sorunun ilk sorusunu karşılar:

- **RED (istek odaklı, her servis için):** **R**ate (hız: istek/sn), **E**rrors (hata oranı), **D**uration (süre dağılımı, histogram). Kullanıcının deneyimini anlatır.
- **USE (kaynak odaklı, her kaynak için):** **U**tilization (kullanım), **S**aturation (doygunluk: bekleyen iş, kuyruk), **E**rrors. Neden yavaş olduğunu anlatır. Kurs boyunca gördüğümüz doygunluk göstergelerinin hepsi bu sınıftadır: olay döngüsü kullanımı (Node dersi), havuz bekleme süresi (veritabanı dersi), kuyruktaki en eski işin yaşı (kuyruk dersi), tüketici gecikmesi (akış dersi), replikasyon gecikmesi.

Üç sinyal türü birlikte çalışır:

| Sinyal | Neyi cevaplar | Maliyet ve tuzak |
|---|---|---|
| **Metrik** | Ne kadar, ne sıklıkta? Eğilimler, alarmlar | Ucuzdur. Ama yüksek **kardinalite** pahalıdır: Etikete kullanıcı kimliği, URL'nin tamamı ya da istek kimliği koymak zaman serisi sayısını patlatır |
| **İz** (trace) | Bu istek zamanını **nerede** geçirdi? | Örnekleme gerekir. Hatalı ve yavaş istekleri tutan "kuyruk tabanlı örnekleme" (tail-based sampling) en değerlisidir |
| **Log** | Tam olarak **ne** oldu? | Hacim ve kişisel veri riski (güvenlik kursu). Yapılandırılmış (JSON) olmalı ve iz kimliğini içermeli |

OpenTelemetry, üç sinyal için ortak bir standart ve SDK sağlar. En büyük faydası **bağlamın yayılmasıdır**: W3C `traceparent` başlığı servisler arasında taşınır. Bir alarmdan (metrik) o anki yavaş isteğe (iz), oradan da o isteğin loglarına tek tıkla geçilir. Kapasite dersindeki "100 servise dağılan istek" problemini çözmek, ancak bir izde hangi alt çağrının yavaş olduğunu görmekle mümkündür.

## Yüzdelikler toplanamaz

Gecikme metriklerinin en yaygın hatası, her kopyanın kendi hesapladığı p99 değerlerinin bir panoda **ortalamasını almaktır**. İki kopyalı bir servisi düşünelim. A kopyası trafiğin %90'ını alıyor ve hızlı. B kopyası %10'unu alıyor ve yavaş, örneğin gürültülü bir komşu yüzünden:

```js
// gozlem.mjs (1. bölüm)
let s = 7; const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const ustel = (ort) => -Math.log(1 - r()) * ort;
const yuzdelik = (dizi, q) => { const d = [...dizi].sort((a, b) => a - b); return d[Math.min(d.length - 1, Math.floor((q / 100) * d.length))]; };

const A = Array.from({ length: 90_000 }, () => 5 + ustel(10));
const B = Array.from({ length: 10_000 }, () => 5 + ustel(80));
const pA = yuzdelik(A, 99), pB = yuzdelik(B, 99), gercek = yuzdelik([...A, ...B], 99);
// Prometheus tarzı kova histogramı: kovaları topla, sonra doğrusal ara değerle
const kovalar = [10, 25, 50, 100, 250, 500, 1000, Infinity];
const say = (d) => kovalar.map((k) => d.filter((x) => x <= k).length);
const toplam = say(A).map((v, i) => v + say(B)[i]);
const hedef = 0.99 * toplam.at(-1); const i = toplam.findIndex((v) => v >= hedef);
const alt = i ? kovalar[i - 1] : 0, ust = kovalar[i], altSay = i ? toplam[i - 1] : 0;
```

```text
1) p99 toplama
   kopya A p99=51 ms  kopya B p99=378 ms
   p99'ların ortalaması=215 ms   p99'ların en büyüğü=378 ms   GERÇEK p99 (birleşik)=189 ms
   kova histogramından (histogram_quantile mantığı): 221 ms  (kova 100-250 ms)
```

Hiçbir türetilmiş değer gerçek p99'u (189 ms) vermiyor. Ortalama ve en büyük değer, kopyaların trafik **ağırlıklarını** bilmez. Doğru yol şudur: Her kopya ham dağılımı bir **histogram** olarak yayımlar (kova sayaçları), izleme sistemi kovaları toplar, yüzdelik en son ve **birleşik** veri üzerinden hesaplanır. Prometheus'ta bu `histogram_quantile(0.99, sum by (le) (rate(http_istek_suresi_saniye_bucket[5m])))` sorgusudur.

Kova histogramı da yaklaşık bir değer verir (221 ms). Yüzdeliği 100–250 ms kovasının içinde doğrusal ara değerle tahmin eder, hata da kovanın genişliği kadardır. Bu yüzden:

- Kova sınırları SLO eşiklerini içermelidir. SLO "300 ms'nin altında" ise 300 bir kova sınırı olmalıdır. Böylece "300 ms'nin altında kalan istek oranı" **kesin** olarak hesaplanır, tahmin gerekmez.
- Prometheus'un **yerel (native) histogramları** ve HDR/DDSketch tabanlı özetler, sabit kovalar yerine üstel kovalarla çok daha düşük hata verir.
- İstemci tarafında hesaplanan "summary" türündeki yüzdelikler kopyalar arasında **toplanamaz**. Çok kopyalı servislerde histogram tercih edilir.

## SLO ve hata bütçesi

Bir SLO, kullanıcı açısından ölçülen bir hedeftir: "Ürün sayfası isteklerinin %99,9'u 30 günlük pencerede 300 ms içinde ve hatasız yanıtlanır." Bileşenleri:

- **SLI** (gösterge): iyi olayların toplam olaylara oranı. Örneğin `300 ms altında ve 5xx olmayan istekler / bütün istekler`. Sunucunun kendi ölçümü ister istemez iyimserdir. Mümkünse ölçüm yük dengeleyiciden ya da istemciye yakın bir yerden yapılır.
- **Hedef:** %99,9. %100 hedeflenmez: Hem ulaşılamaz hem de her değişikliği durdurur.
- **Hata bütçesi:** `1 − hedef`. Değişiklik yapmanın, deneme yapmanın, bakım yapmanın "parasıdır".

```text
2) SLO %99.9 (30 gün): hata bütçesi = 43.2 dakikalık tam kesinti
   hata oranı % 0.1 -> yanma hızı   1.0x; 720 saat sürerse bütçeden %100.0 tüketir; tüm bütçe 720 saatte biter
   hata oranı % 0.2 -> yanma hızı   2.0x;  24 saat sürerse bütçeden %6.7 tüketir; tüm bütçe 360 saatte biter
   hata oranı % 1.0 -> yanma hızı  10.0x;   6 saat sürerse bütçeden %8.3 tüketir; tüm bütçe 72 saatte biter
   hata oranı % 1.4 -> yanma hızı  14.4x;   1 saat sürerse bütçeden %2.0 tüketir; tüm bütçe 50 saatte biter
   hata oranı % 2.0 -> yanma hızı  20.0x;   1 saat sürerse bütçeden %2.8 tüketir; tüm bütçe 36 saatte biter
```

**Yanma hızı** (burn rate), bütçenin ne kadar hızlı tüketildiğidir: anlık hata oranı / izin verilen hata oranı. 1x, bütçenin tam 30 günde biteceği hızdır. Alarmlar ham hata oranına değil yanma hızına bağlanır. Google'ın SRE çalışma kitabındaki çok pencereli kural bu tablonun bir satırına dayanır: "1 saatte bütçenin %2'si" yanma hızı **14,4x** demektir ve birini uyandırmayı (page) hak eder. Yanlış alarmı azaltmak için aynı koşul kısa bir pencerede de (5 dk) doğrulanır. Böylece sorun düzeldikten sonra alarm uzun süre çalmaya devam etmez. Daha yavaş yanmalar (6 saatte %5, 3 günde %10) bir bilet (ticket) açar.

```yaml
# Prometheus kuralı (yapıyı gösterir; bu kursta bir Prometheus'ta çalıştırılmadı)
- alert: UrunSayfasiHataButcesiHizliYaniyor
  expr: |
    (slo:hata_orani:1h > 14.4 * 0.001) and (slo:hata_orani:5m > 14.4 * 0.001)
  labels: { onem: page }
  annotations:
    ozet: "Ürün sayfası SLO'su: bütçenin %2'si 1 saatte tükeniyor"
```

Hata bütçesinin asıl değeri bir **karar aracı** olmasıdır. Bütçe bolsa ekip hızlı dağıtır ve deneme yapar. Bütçe tükeniyorsa öncelik güvenilirliğe kayar: dağıtım dondurma, kök neden düzeltmeleri, kapasite. Güvenlik kursundaki olay sonrası incelemelerin çoğu, bütçeyi en çok tüketen olaylardan seçilir.

## Otomatik ölçekleme

Kubernetes HPA'sı basit bir orantı kuralı uygular: `istenen kopya = ceil(mevcut kopya × mevcut metrik / hedef metrik)`. Kuralın kendisi basittir. Asıl sorun **zamandır**. Metriğin toplanması, HPA döngüsü (varsayılan 15 sn), pod'un zamanlanması, imajın çekilmesi, uygulamanın başlaması, ısınması ve readiness probe'unun geçmesi toplam bir dakikayı kolayca bulur. Ani bir trafik artışına karşı bu süre boyunca mevcut pod'lar yükü taşımak zorundadır:

```js
// gozlem.mjs (3. bölüm) — trafik 1000 -> 3000 istek/sn; pod kapasitesi 300/sn; hedef CPU %60; 15 sn döngü
function hpa({ minPod, hedef = 0.6, hazirlik = 60 }) {
  let pod = Math.max(minPod, Math.ceil(1000 / 300 / hedef)), bekleyen = [];
  let asiriSn = 0, enKotu = 0;
  for (let t = 0; t < 600; t++) {
    const trafik = t < 60 ? 1000 : 3000;
    bekleyen = bekleyen.filter((p) => { if (p <= t) { pod++; return false; } return true; });
    const kullanim = trafik / (pod * 300);
    if (kullanim > 0.9) asiriSn++;
    enKotu = Math.max(enKotu, kullanim);
    if (t % 15 === 0) {                                     // HPA: istenen = ceil(mevcut * kullanım / hedef)
      const istenen = Math.ceil(pod * kullanim / hedef);
      for (let k = pod + bekleyen.length; k < istenen; k++) bekleyen.push(t + hazirlik);
    }
  }
  return { asiriSn, enKotu };
}
```

```text
3) HPA ani yük: 1000 -> 3000 istek/sn (t=60 sn), pod kapasitesi 300/sn, hazırlık 60 sn
   min 6 pod (hedefe göre)      kullanım >%90 olan süre= 60 sn   en kötü kullanım=%167
   min 6 pod, hazırlık 15 sn    kullanım >%90 olan süre= 15 sn   en kötü kullanım=%167
   min 12 pod (önceden ölçek)   kullanım >%90 olan süre=  0 sn   en kötü kullanım=%83
```

Bu basit model bile önemli bir şey gösteriyor. HPA doğru kararı ilk döngüde veriyor, ama yeni pod'lar hazır olana kadar mevcut 6 pod kapasitelerinin **%167'siyle** karşılaşıyor. Kapasite dersinden biliyoruz: ρ>1 demek, kuyruk büyüyor, gecikme saniyelere çıkıyor, zaman aşımları ve yeniden denemeler başlıyor demek. Dayanıklılık önlemleri yoksa bu bir dakika, yeni pod'lar geldiğinde bile toparlanamayan bir kesintiye dönüşebilir. Gerçek HPA'da metrik gecikmesi de eklenir (metrikler 15–60 sn geriden gelir), yani gerçek süre daha uzundur.

Model üç kaldıraç gösteriyor:

- **Hazırlık süresini kısaltmak** (60'tan 15 saniyeye): Aşırı yük süresi de aynı oranda kısaldı. Küçük imajlar, önceden çekilmiş imajlar, hızlı başlangıç (başlangıçta ağır iş yapmamak), doğru readiness probe'ları ve gerekirse önceden hazır bekleyen düğümler (cluster autoscaler'ın "overprovisioning" deseni).
- **Yeterli pay** (12 pod): Aşırı yük hiç yaşanmadı, en kötü kullanım %83. Hedef kullanımın %60 olmasının nedeni de budur. Pay, otomatik ölçekleme yetişene kadarki tampondur. Planlanan olaylar (kampanya, maç, toplu bildirim) için `minReplicas` önceden **elle** ya da zamanlanmış olarak yükseltilir.
- **Doğru metrik:** CPU, Node gibi tek iş parçacıklı ve G/Ç ağırlıklı servislerde yükü iyi temsil etmeyebilir. Node dersinde 50 ms bekleyen 1000 istek/sn, sadece %19 olay döngüsü kullanımıyla taşınıyordu. Böyle servislerde **istek hızı**, **eşzamanlı istek** ya da kuyruk/akış servislerinde **gecikme ve kuyruk yaşı** (KEDA) daha doğru ölçekleme sinyalleridir.

Ölçeklemenin ters yönü de dikkat ister. Hızlı ölçek küçültme, trafik dalgalanırken kopya sayısının sürekli inip çıkmasına (flapping) ve her seferinde soğuk başlangıç ödenmesine yol açar. HPA'nın `behavior.scaleDown.stabilizationWindowSeconds` ayarı (varsayılan 300 sn) bunun içindir: hızlı büyü, yavaş küçül. Ölçeklemenin bir de **aşağı akış** etkisi vardır: Her yeni pod veritabanına yeni bağlantılar açar (veritabanı dersi), soğuk önbellekle başlar (önbellek dersi) ve tüketici grubunu yeniden dengeler (akış dersi). Ölçekleme, paylaşılan kaynakların kapasitesiyle birlikte planlanır.

## Kursun sonu: bir kontrol listesi

Bu kursun bütün derslerini, yüksek trafik altına girecek bir servis için sorulacak sorulara indirgeyebiliriz:

| Konu | Soru |
|---|---|
| Kapasite | Tepe hız ve kopya başına güvenli hız ölçüldü mü? %60–75 hedef ve N+1 payı var mı? |
| Node | Olay döngüsünü bloklayan iş var mı? ELU izleniyor mu? Bağlantılar yeniden kullanılıyor mu? |
| Önbellek | İsabet oranı ölçülüyor mu? Fırtınaya karşı tekil uçuş/SWR, geçersizleştirme yarışına karşı sürüm var mı? |
| Vekil | Dengeleme algoritması geri bildirimli mi (ve `zone` var mı)? Mikro önbellek, yeniden deneme sınırı, keep-alive? |
| Veritabanı | Toplam bağlantı = kopya × havuz hesaplandı mı? Havuzlayıcı, N+1, işlem süresi, zaman aşımları? |
| Replika | Kendi yazdığını okuma tutarlılığı nasıl sağlanıyor? Gecikme izleniyor ve sınırlanıyor mu? |
| Kuyruk/akış | İşleyiciler idempotent mi? Outbox var mı? En eski işin yaşı ve tüketici gecikmesi izleniyor mu? |
| Sınırlama | Sayaç paylaşılan ve atomik mi? Anahtar, katman ve başarısızlık davranışı belli mi? |
| Dayanıklılık | Her dış çağrının zaman aşımı, bütçeli yeniden denemesi, devre kesicisi ve yedek yanıtı var mı? Yük atılıyor mu? |
| Yük testi | Açık modelle, gerçekçi veriyle, üreticisi doğrulanmış bir stres testi yapıldı mı? Kırılma biçimi biliniyor mu? |
| Gözlem | RED ve USE metrikleri, histogramlar, izler var mı? SLO, yanma hızı alarmları ve ölçekleme sinyali doğru mu? |

```quiz
{
  "question": "Bir pano, 20 pod'un her birinin raporladığı p99 gecikmenin ortalamasını gösteriyor ve değer 120 ms. Kullanıcılar ise sık sık yavaşlıktan şikâyet ediyor. Bu panonun sorunu nedir?",
  "options": [
    "Pano doğru. Kullanıcı şikâyetleri ağdan kaynaklanıyor.",
    "Yüzdeliklerin ortalaması anlamlı bir istatistik değildir. Kopyaların trafik ağırlıklarını ve dağılımlarını yok sayar. Bu derste p99'ların ortalaması 215 ms, gerçek birleşik p99 ise 189 ms çıktı. Farklı dağılımlarda sapma her iki yönde de olabilir. Her pod ham dağılımı histogram olarak yayımlamalı, kovalar toplanmalı ve yüzdelik birleşik veri üzerinden hesaplanmalıdır. SLO eşiği bir kova sınırı olmalıdır.",
    "p99 yerine ortalama gecikme gösterilmelidir.",
    "Pod sayısı azaltılırsa pano doğru hale gelir."
  ],
  "answer": 1,
  "explanation": "Yüzdelikler toplanamaz. Kopya başına summary türü yüzdelikler ancak tek kopya için anlamlıdır. Çok kopyalı servislerde histogram ve histogram_quantile kullanılır."
}
```

```quiz
{
  "question": "Bir servisin HPA'sı CPU %80 hedefiyle çalışıyor ve yeni pod'ların hazır olması 90 saniye sürüyor. Her akşam 20:00'de bildirim gönderimiyle trafik 30 saniye içinde 3 katına çıkıyor ve her seferinde birkaç dakika hata yaşanıyor. Hangi önlemler doğrudur?",
  "options": [
    "HPA hedefini %95'e çıkarmak.",
    "Hedef kullanımı düşürmek (%60 civarı, pay için), 20:00 öncesinde minReplicas'ı zamanlanmış olarak yükseltmek (öngörülebilir tepe), pod hazırlık süresini kısaltmak (imaj, başlangıç, readiness) ve mümkünse bildirim gönderimini zamana yaymak (kaynakta yük düzleştirme). Aşırı yük anı için yük atma ve bütçeli yeniden deneme de olmalıdır.",
    "Ölçek küçültme penceresini sıfırlamak.",
    "HPA'yı kapatıp sabit pod sayısı kullanmak her zaman daha iyidir."
  ],
  "answer": 1,
  "explanation": "Otomatik ölçekleme tepkiseldir ve gecikmelidir. Bu derste 60 saniyelik hazırlıkta mevcut pod'lar kapasitelerinin %167'siyle karşılaştı. Öngörülebilir tepeler önceden ölçeklenir. Pay ve hızlı başlangıç tepki süresini telafi eder."
}
```

```lab
{
  "title": "Kendi servisine gözlem ve SLO kur",
  "steps": [
    "gozlem.mjs'te kova sınırlarını [10, 25, 50, 100, 150, 200, 250, 500, 1000] yap ve histogram tahmininin gerçek p99'a ne kadar yaklaştığını ölç. Kova sayısının metrik maliyetine etkisini (kova × etiket kombinasyonu) hesapla.",
    "Kapasite dersindeki sabit.mjs'e bir /metrics uç noktası ekle: istek sayacı, hata sayacı ve SLO eşiğini (örneğin 20 ms) içeren kovalarla bir süre histogramı. Prometheus metin biçiminde yayımla, yük üreticisiyle çalıştırıp değerleri kontrol et.",
    "Kendi servisin için bir SLO yaz: SLI tanımı (iyi olay nedir, nerede ölçülür), hedef, pencere, bütçe ve iki yanma hızı alarmı (page ve ticket).",
    "HPA simülasyonuna metrik gecikmesini ekle (HPA, 30 sn önceki kullanımı görsün) ve ölçek küçültme kararlılık penceresini uygula. Trafiğin 1000 ile 3000 arasında her 2 dakikada bir dalgalandığı bir senaryoda pod sayısının inip çıkmasını gözlemle.",
    "Bu dersteki kontrol listesini kendi servislerinden biri için doldur. Cevabı 'hayır' ya da 'bilmiyorum' olan her satırı bir iş maddesine çevir."
  ]
}
```

## Özet

- RED (hız, hata, süre) kullanıcı deneyimini, USE (kullanım, doygunluk, hata) nedeni anlatır. Metrik, iz ve log, OpenTelemetry ile bağlamı paylaşarak birlikte çalışır. Metrik etiketlerinde kardinaliteye dikkat et.
- Yüzdelikler toplanamaz: p99'ların ortalaması 215 ms, gerçek p99 189 ms çıktı. Histogram yayımla, kovaları topla, yüzdeliği en son hesapla. SLO eşiğini kova sınırı yap.
- SLO ve hata bütçesi, güvenilirliği bir karar aracına çevirir. Alarmları yanma hızına bağla: 1 saatte bütçenin %2'si (14,4x) uyandırır. Çok pencereli doğrulama kullan.
- Otomatik ölçekleme gecikmelidir: 60 sn hazırlıkla mevcut pod'lar kapasitelerinin %167'siyle karşılaştı. Pay bırak (hedef ~%60), hazırlık süresini kısalt, öngörülebilir tepeleri önceden ölçekle, servise uygun sinyal kullan (istek hızı, eşzamanlılık, kuyruk yaşı), hızlı büyü ve yavaş küçül.
- Ölçekleme; bağlantılar, önbellek ve tüketici grupları gibi paylaşılan kaynakları da etkiler. Kapasite bütün zincir boyunca planlanır.
