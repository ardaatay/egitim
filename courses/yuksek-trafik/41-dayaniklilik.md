# Dayanıklılık kalıpları: zaman aşımı, yeniden deneme, devre kesici

Dağıtık bir sistemde bağımlılıklar her zaman bir gün yavaşlar ya da çöker. Asıl soru, bir bağımlılık bozulduğunda **senin** servisinin ne yaptığıdır. Üç olası sonuç var:

- Bozulmayı sınırlar ve kısmen çalışmaya devam eder.
- Bozulmayı aynen yayar.
- Bozulmayı **büyütür**.

Bu son durum, kesintilerin en tehlikeli biçimidir. Küçük bir yavaşlama, yeniden denemeler ve biriken isteklerle bütün sistemi devirir. Bu derste zaman aşımı, yeniden deneme, devre kesici ve yük atma kalıplarını, iki katmanlı gerçek bir düzenekte ölçüyoruz.

## Düzenek

- **Bağımlılık** (`bagimli.mjs`): Aynı anda 20 iş yapar, her iş 20 ms sürer, yani kapasitesi yaklaşık saniyede 1000 istektir. Önündeki kuyruk 40'ı aşarsa yeni istekleri hemen `503` ile reddeder (yük atma). İkinci senaryoda "askıda" moduna geçer: Her isteği 3 saniye bekletip hata verir. Bu, bağlantı kabul eden ama yanıt vermeyen bir veritabanını ya da kilitlenmiş bir servisi temsil eder.
- **Ön servis** (`on.mjs`): Her istekte bağımlılığı çağırır. Davranışı `POLITIKA` değişkeniyle değişir.

```js
// bagimli.mjs — aynı anda 20 iş, iş başına 20 ms (kapasite ~1000/sn); kuyruk 40'ı aşarsa 503 (yük atma)
// DURUM=normal | olu (her isteği 3 sn bekletip kapatır: 'askıda kalan' bağımlılık)
import http from "node:http";
import { setTimeout as bekle } from "node:timers/promises";

let aktif = 0, gelen = 0, red = 0;
const kuyruk = [];
let durum = process.env.DURUM ?? "normal";

http.createServer(async (req, res) => {
  if (req.url === "/sayac") { res.end(JSON.stringify({ gelen, red }) + "\n"); gelen = 0; red = 0; return; }
  if (req.url.startsWith("/durum/")) { durum = req.url.split("/")[2]; return res.end(durum + "\n"); }
  gelen++;
  if (durum === "olu") { await bekle(3000); res.statusCode = 504; return res.end(); }
  if (aktif >= 20 && kuyruk.length >= 40) { red++; res.statusCode = 503; return res.end("aşırı yük\n"); }
  if (aktif >= 20) await new Promise((ok) => kuyruk.push(ok));
  aktif++;
  try { await bekle(20); res.end("tamam\n"); }
  finally { aktif--; kuyruk.shift()?.(); }
}).listen(4031, "127.0.0.1", () => console.log("bağımlılık 4031"));
```

```js
// on.mjs — ön servis: her istekte bağımlılığı çağırır. POLITIKA ile davranış değişir:
//   yok        : zaman aşımı yok, yeniden deneme yok
//   zamanasimi : 300 ms zaman aşımı
//   hemen3     : zaman aşımı + 3 kez hemen yeniden dene
//   akilli     : zaman aşımı + üstel bekleme ve rastgelelik + yeniden deneme bütçesi (%10)
//   devre      : akilli + devre kesici
import http from "node:http";
import { setTimeout as bekle } from "node:timers/promises";

const POLITIKA = process.env.POLITIKA ?? "yok";
const ajan = new http.Agent({ keepAlive: true, maxSockets: Infinity });

function cagir(zamanAsimi) {
  return new Promise((ok, red) => {
    const r = http.get("http://127.0.0.1:4031/", { agent: ajan }, (y) => {
      y.resume(); y.on("end", () => (y.statusCode === 200 ? ok() : red(new Error(String(y.statusCode)))));
    });
    if (zamanAsimi) r.setTimeout(zamanAsimi, () => r.destroy(new Error("zaman aşımı")));
    r.on("error", red);
  });
}

// Yeniden deneme bütçesi: denemeler, son 1 sn'deki ilk isteklerin %10'unu geçemez
let ilkIstek = 0, yenidenDeneme = 0;
setInterval(() => { ilkIstek = 0; yenidenDeneme = 0; }, 1000).unref();

// Devre kesici: son 20 çağrının %50'si hatalıysa 2 sn açık; sonra yarı açık (tek deneme)
const devre = { durum: "kapali", sonuclar: [], acilis: 0 };
function devreIzinVerir() {
  if (devre.durum === "acik" && Date.now() - devre.acilis > 2000) devre.durum = "yari";
  return devre.durum !== "acik";
}
function devreKaydet(basari) {
  if (devre.durum === "yari") { devre.durum = basari ? "kapali" : "acik"; devre.acilis = Date.now(); devre.sonuclar = []; return; }
  devre.sonuclar.push(basari); if (devre.sonuclar.length > 20) devre.sonuclar.shift();
  const hata = devre.sonuclar.filter((x) => !x).length;
  if (devre.sonuclar.length >= 10 && hata / devre.sonuclar.length >= 0.5) { devre.durum = "acik"; devre.acilis = Date.now(); }
}

async function isle() {
  if (POLITIKA === "yok") return cagir(0);
  if (POLITIKA === "zamanasimi") return cagir(300);
  if (POLITIKA === "hemen3") {
    for (let d = 0; ; d++) { try { return await cagir(300); } catch (e) { if (d === 3) throw e; } }
  }
  // akilli / devre
  ilkIstek++;
  if (POLITIKA === "devre" && !devreIzinVerir()) throw new Error("devre açık");
  for (let d = 0; ; d++) {
    try { await cagir(300); if (POLITIKA === "devre") devreKaydet(true); return; }
    catch (e) {
      if (POLITIKA === "devre") devreKaydet(false);
      if (d === 3 || yenidenDeneme >= ilkIstek * 0.1) throw e;          // bütçe bitti
      yenidenDeneme++;
      await bekle(Math.random() * 50 * 2 ** d);                           // tam rastgelelik (full jitter)
      if (POLITIKA === "devre" && !devreIzinVerir()) throw new Error("devre açık");
    }
  }
}

http.createServer(async (req, res) => {
  try { await isle(); res.end("ok\n"); }
  catch (e) { res.statusCode = 503; res.end(e.message + "\n"); }
}).listen(4030, "127.0.0.1", () => console.log(`ön servis politika=${POLITIKA}`));
```

Test betiği (`dayan-test.mjs`) her politika için ön servisi başlatıyor ve kapasite dersindeki yük üreticisiyle 10 saniye yük gönderiyor. Ardından bağımlılığa kaç istek ulaştığını sayıyor.

## Senaryo A: aşırı yük ve yeniden deneme fırtınası

Saniyede 1300 istek geliyor, bağımlılığın kapasitesi yaklaşık 1000. Yükün bir kısmı nasılsa reddedilecek. Soru, yeniden denemelerin bunu nasıl etkilediği:

```text
A) 1300 istek/sn, bağımlılık kapasitesi ~1000/sn
zamanasimi   başarı=% 74.2  başarılı/sn= 976  p50=   58  p99=   77 ms  bağımlılığa giden= 13143 (istek başına 1.00)  503=3388
hemen3       başarı=% 47.1  başarılı/sn= 620  p50=  366  p99= 6197 ms  bağımlılığa giden= 18216 (istek başına 1.38)  503=9590
akilli       başarı=% 74.6  başarılı/sn= 981  p50=   59  p99=  107 ms  bağımlılığa giden= 14462 (istek başına 1.10)  503=4648
```

- **Sadece zaman aşımı:** Bağımlılık kapasitesi kadar istek (saniyede 976) başarılı oldu, fazlası hemen `503` ile reddedildi. Gecikme düşük kaldı (p99 77 ms). Bunu sağlayan, bağımlılığın **yük atmasıdır**. Kuyruk 40'ta sınırlı olduğu için, fazla istekler bekletilmek yerine hemen reddedildi. Kabul edilen istekler de makul sürede tamamlandı.
- **Üç kez hemen yeniden deneme:** Başarılı istek sayısı saniyede 976'dan **620'ye düştü**, p99 77 ms'den **6,2 saniyeye** çıktı. Bağımlılığa giden yük istek başına 1,38'e çıktı. Reddedilen her istek, hemen geri döndü ve kuyruk kapasitesini zaten taşan bağımlılığı daha da zorladı. Zaman aşımına uğrayan denemeler bağımlılıkta yine de işlendi, yani boşa harcanan iş arttı. Yeniden deneme, aşırı yükü **çözmek yerine katladı**. Kapasite dersindeki eğrinin ρ>1 tarafında daha da ileriye itildik. Bu duruma **yeniden deneme fırtınası** (retry storm) denir.
- **Akıllı yeniden deneme:** Üç ek önlem var. Denemeler arasında **üstel bekleme ve tam rastgelelik** uygulanır: `random(0, 50 ms × 2^deneme)`. Denemeler bir **bütçeyle** sınırlanır: ilk isteklerin en fazla %10'u. Bunun sonucunda yük istek başına 1,10'da kaldı. Başarı ve gecikme, yeniden denemesiz duruma çok yakın. Arada sırada başarısız olan bir isteğin bir kez daha denenmesine izin verildi, ama bağımlılık sistematik olarak aşırı yüklüyken denemeler kendiliğinden durdu.

Yeniden denemenin kuralları:

1. **Sadece geçici ve güvenli hataları yeniden dene.** Bağlantı hatası, `503`, `429`, zaman aşımı geçicidir. `400`, `401`, `404` ise kalıcıdır. Yeniden deneme yalnızca **idempotent** işlemlerde, ya da bir idempotency anahtarıyla yapılır (kuyruk dersi). Ödeme isteği zaman aşımına uğradıysa işlem gerçekleşmiş olabilir.
2. **Üstel bekleme ve rastgelelik:** Rastgelelik olmadan, aynı anda başarısız olan binlerce istemci aynı anda yeniden dener ve senkronize dalgalar oluşturur.
3. **Bütçe:** Toplam yeniden deneme oranı sınırlı olmalıdır (örneğin %10). Sabit "3 deneme" kuralı, sistematik bir sorunda yükü 4 katına çıkarır.
4. **Sadece tek bir katmanda yeniden dene.** İstemci 3, ağ geçidi 3, servis 3 kez yeniden denerse, en alttaki bağımlılık bir istek için 4 × 4 × 4 = **64** çağrı alabilir. Yeniden deneme genellikle en dış katmanda ya da bağımlılığın hemen yanında yapılır, aradaki katmanlarda yapılmaz.

## Senaryo B: askıda kalan bağımlılık

Bağımlılık çökmüş değil, ama yanıt vermiyor: Her çağrı 3 saniye sürüp hata veriyor. Bu durum, hızlı bir "bağlantı reddedildi" hatasından **çok daha tehlikelidir**:

```text
B) bağımlılık askıda (her çağrı 3 sn), 200 istek/sn
yok          başarı=%  0.0  başarılı/sn=   0  p50= 3006  p99= 3017 ms  bağımlılığa giden=  2066 (istek başına 1.00)  503=0
zamanasimi   başarı=%  0.0  başarılı/sn=   0  p50=  305  p99=  317 ms  bağımlılığa giden=  2066 (istek başına 1.00)  503=0
akilli       başarı=%  0.0  başarılı/sn=   0  p50=  307  p99=  665 ms  bağımlılığa giden=  2270 (istek başına 1.10)  503=0
devre        başarı=%  0.0  başarılı/sn=   0  p50=    0  p99=  347 ms  bağımlılığa giden=   266 (istek başına 0.13)  503=0
```

Hiçbir politika isteği başarılı yapamaz, çünkü bağımlılık gerçekten bozuk. Fark, **ön servisin ne kadar zarar gördüğündedir**:

- **Zaman aşımı yok:** Her istek 3 saniye bekledi. Little yasasına göre ön serviste her an `200 × 3 = 600` istek askıda. Her biri bir soket, bellek ve (bir iş parçacığı modelinde) bir iş parçacığı tutar. Gerçek bir yükte bu sayı binlere çıkar, ön servisin kaynakları tükenir ve **bağımlılığı hiç kullanmayan** uç noktaları da yanıt veremez hale gelir. Tek bir bozuk bağımlılık bütün servisi devirir. Kademeli çöküş (cascading failure) böyle başlar.
- **300 ms zaman aşımı:** İstekler yine başarısız, ama 300 ms'de. Askıdaki istek sayısı 600'den 60'a iner, ön servis diğer işlerini yapmaya devam edebilir.
- **Devre kesici:** Hata oranı eşiği geçince devre **açılır** ve sonraki çağrılar bağımlılığa hiç gitmeden **anında** başarısız olur (p50 0 ms). Bağımlılığa giden yük istek başına 0,13'e, yani yaklaşık **%87 azaldı**. Her 2 saniyede bir devre "yarı açık" konuma geçer ve tek bir deneme isteği gönderir. Bağımlılık iyileşmişse devre kapanır. İki faydası var: Ön servis kaynaklarını korur ve bağımlılığa **toparlanma fırsatı** verir. Aşırı yük yüzünden düşen bir servis, yük kesilmezse hiç ayağa kalkamaz.

### Zaman aşımı değerini seçmek

Zaman aşımı keyfi bir değer değildir:

- **Bağımlılığın gecikme dağılımına göre:** Genellikle p99 ya da p99.9'un biraz üstü. Çok kısa bir zaman aşımı, sağlıklı ama biraz yavaş istekleri keser ve yeniden denemelerle yükü artırır.
- **Bütçeyle (deadline):** Kullanıcıya dönen isteğin bir toplam süre bütçesi vardır, örneğin 1 saniye. Her katman kalan süreyi alt çağrıya iletir (gRPC deadline propagation, `AbortSignal.timeout()`). Kullanıcının çoktan vazgeçtiği bir isteğin alt çağrılarını sürdürmek, boşa harcanan iştir.
- **Her katmanda ayrı:** Bağlantı kurma (kısa: 100 ms–1 sn), ilk bayta kadar geçen süre ve toplam süre ayrı ayrı belirlenir. Varsayılanlara güvenme. Birçok HTTP istemcisinin varsayılan zaman aşımı **yoktur** ya da dakikalar mertebesindedir. Node'un `fetch`'inde de istek için varsayılan bir toplam zaman aşımı yoktur, `AbortSignal.timeout(ms)` gerekir.

## Diğer kalıplar

### Bölme (bulkhead)

Geminin su geçirmez bölmelerinden adını alır. Bir bağımlılığın sorunu, diğer işlerin kaynaklarını tüketmemelidir. Her bağımlılık için ayrı bir bağlantı havuzu ve ayrı bir eşzamanlılık sınırı kullanılır. Örneğin öneri servisine aynı anda en fazla 50 çağrı yapılır. Öneri servisi askıda kalırsa, sadece o 50 yuva dolar ve ödeme akışı etkilenmez. Senaryo B'deki "600 askıda istek", bölme ile 50'de sınırlanırdı.

### Yük atma ve önceliklendirme

Bağımlılık örneğimizin kuyruğu 40 ile sınırlıydı. Senaryo A'daki iyi sonuçların temeli buydu. Sınırsız bir kuyrukta fazla istekler bekler, bekleme süresi büyür. Sonunda **bütün** istekler zaman aşımına uğrar: Sistem tam kapasiteyle çalışır, ama hiçbir yanıt zamanında ulaşmaz. Buna "goodput çöküşü" denir. Yük atmanın ilkeleri:

- **Erken reddet:** Kapasite aşıldığında yeni isteği iş yapmadan önce reddet (`503` ve `Retry-After`). Reddetmek ucuzdur, yarım yapılmış iş pahalıdır.
- **Kuyruktaki eski istekleri at:** Kuyrukta, istemcinin zaman aşımından uzun süre beklemiş bir istek, işlendiğinde kimse yanıtı beklemiyor olacaktır. CoDel ya da "kuyrukta en fazla X ms" kuralı uygula. Yoğun anlarda LIFO (en yeni önce) sırası da bir seçenektir.
- **Önceliklendir:** Yük atılacaksa önce önemsiz trafik atılır. Ödeme ve giriş işlemleri öneri ve analitik isteklerinden, kullanıcı istekleri arka plan işlerinden önce gelir. İstek önceliği bir başlıkla taşınır ve aşırı yükte eşik buna göre uygulanır.
- **Uyarlanabilir eşzamanlılık:** Sabit bir sınır yerine, gecikme arttıkça eşzamanlılık sınırını otomatik olarak düşüren algoritmalar (TCP tıkanıklık kontrolünden esinlenen AIMD, Netflix'in concurrency-limits kütüphanesi) kapasiteyi önceden bilmeden doğru noktada durur.

### Zarif bozulma

Bağımlılık yoksa hata vermek yerine daha az iyi bir yanıt vermek, çoğu zaman en iyi seçenektir:

- Öneri servisi yoksa popüler ürünlerin önbellekteki listesi gösterilir.
- Kişiselleştirme yoksa genel sayfa gösterilir.
- Stok servisi yavaşsa "stok bilgisi güncelleniyor" yazılır ve sipariş sırasında kontrol edilir.

Devre kesicinin "açık" dalı ve önbellek dersindeki `stale-if-error` bu tür yedek yanıtların doğal yeridir. Her bağımlılık için "bu yoksa ne yaparız?" sorusunu tasarım aşamasında cevapla ve bu yolu **test et**: Hiç çalışmayan yedek kod, ihtiyaç anında da çalışmaz.

### Kaos testi

Bu kalıpların çalıştığını öğrenmenin tek yolu, bağımlılıkları bilinçli olarak bozmaktır. Bu dersteki senaryolar bunun küçük bir örneği. Üretime benzer bir ortamda gecikme enjekte etmek, bir bağımlılığı kapatmak ya da bir pod'u öldürmek (Chaos Mesh, Litmus, AWS FIS, servis ağının hata enjeksiyonu), zaman aşımlarının, devre kesicilerin ve yedek yanıtların gerçekten tetiklendiğini gösterir. Kullanıcı deneyiminin nasıl bozulduğunu da ortaya koyar.

```quiz
{
  "question": "Bir veritabanı kısa süreli bir aşırı yük yaşıyor. Ondan sonra bile sistem bir türlü toparlanamıyor: Veritabanı yükü normalin 3 katında kalıyor, hataların çoğu zaman aşımı. Uygulama her veritabanı hatasında 2 kez, ağ geçidi de her 5xx'te 2 kez hemen yeniden deniyor. En olası açıklama ve doğru müdahale nedir?",
  "options": [
    "Veritabanı bozuldu, yeniden başlatılmalı.",
    "Yeniden deneme fırtınası: Katmanlar arası yeniden denemeler çarpılıyor (3 × 3 = 9 kata kadar). Zaman aşımına uğrayan istekler veritabanında yine de işleniyor. Aşırı yük kendini besliyor. Yeniden denemeyi tek katmana indirmek, üstel bekleme ve rastgelelik ile bütçe eklemek, devre kesiciyle yükü geçici olarak kesmek ve veritabanı önünde yük atmak gerekir.",
    "Zaman aşımlarını 60 saniyeye çıkarmak sorunu çözer.",
    "Daha fazla uygulama pod'u eklemek gerekir."
  ],
  "answer": 1,
  "explanation": "Bu derste hemen yapılan yeniden denemeler başarılı verimi saniyede 976'dan 620'ye düşürdü ve p99'u 6 saniyeye çıkardı. Bütçeli ve bekleme süreli yeniden deneme yükü %10 ile sınırladı. Pod eklemek yükü daha da artırır."
}
```

```quiz
{
  "question": "Bir ürün sayfası servisi, yorum servisini zaman aşımı olmadan çağırıyor. Yorum servisi askıda kaldığında ürün sayfası servisinin bütün uç noktaları, yorumları kullanmayanlar da dahil, yanıt vermez hale geliyor. Hangi önlem kombinasyonu doğrudur?",
  "options": [
    "Yorum servisine daha fazla pod eklemek.",
    "Yorum çağrısına kısa bir zaman aşımı (ve istek bütçesi) koymak, yorum çağrıları için ayrı ve sınırlı bir eşzamanlılık havuzu (bölme) kullanmak, hata oranına göre açılan bir devre kesici eklemek ve yorumlar olmadan sayfayı gösteren zarif bozulma uygulamak.",
    "Ürün sayfası servisinin bellek limitini artırmak.",
    "Yorum servisini her istekte 5 kez yeniden denemek."
  ],
  "answer": 1,
  "explanation": "Zaman aşımı olmayan bir çağrı, askıda kalan bağımlılıkta Little yasasıyla biriken isteklere yol açar (bu derste 600 eşzamanlı askıda istek). Bölme, sorunu bir kaynak havuzuyla sınırlar. Devre kesici yükü keser. Zarif bozulma kullanıcıya bir yanıt sunar."
}
```

```lab
{
  "title": "Dayanıklılık kalıplarını kendin ölç",
  "steps": [
    "dayan-test.mjs'i çalıştır. Ardından bagimli.mjs'teki kuyruk sınırını kaldır (sınırsız kuyruk) ve senaryo A'yı tekrarla. Goodput ve p99'un nasıl değiştiğini açıkla.",
    "on.mjs'e 'tek katmanda değil iki katmanda yeniden deneme' senaryosunu ekle: Ön servisin önüne aynı hemen3 politikasıyla çalışan ikinci bir vekil koy. Bağımlılığa giden 'istek başına çağrı' sayısını ölç.",
    "Devre kesicinin eşiklerini (hata oranı %50, pencere 20, açık kalma 2 sn) değiştir. Bağımlılığı 5 saniye 'olu', sonra 'normal' moda al (`/durum/` uç noktası) ve devrenin ne zaman kapandığını, bu sürede kaç isteğin gereksiz yere reddedildiğini ölç.",
    "Ön servise bir bölme ekle: Bağımlılığa aynı anda en fazla 30 çağrı yapılsın, fazlası beklemeden reddedilsin. Senaryo B'de ön servisin kendi /saglik uç noktasının gecikmesini bölmeli ve bölmesiz durumda karşılaştır.",
    "Kendi servisinin dış çağrılarını listele: Her biri için zaman aşımı, yeniden deneme politikası (kaç katmanda?), devre kesici ve 'bu yoksa ne olur?' sorusunun cevabı var mı?"
  ]
}
```

## Özet

- Bir bağımlılık bozulduğunda hedef bozulmayı sınırlamaktır. En kötü sonuç, bozulmanın büyümesidir.
- Hemen yapılan yeniden denemeler aşırı yükü katlar: Başarılı verim saniyede 976'dan 620'ye düştü, p99 6 saniyeye çıktı. Akıllı yeniden deneme (üstel bekleme, tam rastgelelik, %10 bütçe, sadece idempotent ve geçici hatalar, tek katman) yükü 1,10'da tuttu.
- Askıda kalan bağımlılık hızlı çöken bağımlılıktan tehlikelidir: Zaman aşımı olmadan 600 eşzamanlı askıda istek oluştu. Zaman aşımları bağımlılığın gecikme dağılımına ve isteğin toplam bütçesine göre seçilir, varsayılanlara güvenilmez.
- Devre kesici başarısızlığı anında döndürdü ve bağımlılığa giden yükü %87 azalttı. Bu, bağımlılığa toparlanma fırsatı verir.
- Bölme (ayrı havuzlar ve sınırlar), yük atma (sınırlı kuyruk, erken ret, öncelik, uyarlanabilir eşzamanlılık) ve zarif bozulma, kademeli çöküşü önler.
- Bu kalıpların çalıştığını ancak bağımlılıkları bilinçli bozarak (kaos testi) öğrenebilirsin.
