# Node.js performansı: olay döngüsü, worker'lar ve bağlantılar

Node.js'in performans modelini tek cümleyle özetlemek mümkün: **G/Ç beklerken binlerce isteği aynı anda taşır, ama CPU işi yaparken tek bir isteği bile başkasıyla paylaşamaz.** Bu ders, bu cümlenin iki yarısını ölçerek gösteriyor:

- olay döngüsünü bloklamanın etkisi
- CPU işini worker thread'lere ya da süreçlere dağıtmak
- bağlantıları yeniden kullanmanın etkisi

Önceki dersteki yük üreticisini (`yuk.mjs`) kullanıyoruz.

## Olay döngüsü: tek garson

Node'da JavaScript kodu tek bir iş parçacığında, olay döngüsünde çalışır. Ağ, disk ve zamanlayıcılar işletim sistemine (epoll, kqueue, IOCP) ya da libuv'nin iş parçacığı havuzuna devredilir. Döngü bu sırada başka isteklerin koduna geçer. Bu model, işin çoğu **bekleme** olduğunda son derece verimlidir. Döngü bir isteğin JavaScript kodunu çalıştırırken ise başka hiçbir isteğe dokunamaz. 50 ms süren bir hesaplama, o 50 ms boyunca bütün istekleri bekletir.

### Deney sunucusu

```js
// olaydongusu.mjs — hızlı, CPU-ağır, worker'a devredilmiş ve G/Ç bekleyen uç noktalar
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { setTimeout as bekle } from "node:timers/promises";

const agirIs = () => crypto.pbkdf2Sync("parola", "tuz", 180_000, 32, "sha256");   // ~50 ms CPU

// Basit worker havuzu: işler kuyruğa girer, boş worker alır
const WORKER_KODU = `
  const { parentPort } = require("node:worker_threads");
  const crypto = require("node:crypto");
  parentPort.on("message", (id) => {
    crypto.pbkdf2Sync("parola", "tuz", 180_000, 32, "sha256");
    parentPort.postMessage(id);
  });`;
const HAVUZ_BOYUTU = Math.max(1, os.availableParallelism() - 2);
const bosta = [], kuyruk = [], bekleyen = new Map();
let sayac = 0;
for (let i = 0; i < HAVUZ_BOYUTU; i++) {
  const w = new Worker(WORKER_KODU, { eval: true });
  w.on("message", (id) => { bekleyen.get(id)(); bekleyen.delete(id); const s = kuyruk.shift(); s ? s(w) : bosta.push(w); });
  bosta.push(w);
}
function workerdaCalistir() {
  return new Promise((tamam) => {
    const id = ++sayac; bekleyen.set(id, tamam);
    const gonder = (w) => w.postMessage(id);
    const w = bosta.pop(); w ? gonder(w) : kuyruk.push(gonder);
  });
}

// Olay döngüsü kullanımı (ELU): döngünün iş yaparak geçirdiği zaman oranı, zamanlayıcıdan bağımsız
let oncekiElu = performance.eventLoopUtilization();

http.createServer(async (req, res) => {
  switch (req.url) {
    case "/hizli": return res.end("ok\n");
    case "/agir": agirIs(); return res.end("agir\n");
    case "/agir-worker": await workerdaCalistir(); return res.end("agir-worker\n");
    case "/bekle": await bekle(50); return res.end("bekle\n");                   // 50 ms'lik bir veritabanı çağrısı gibi
    case "/metrik": {
      const simdi = performance.eventLoopUtilization();
      const elu = performance.eventLoopUtilization(simdi, oncekiElu).utilization;
      oncekiElu = simdi;
      return res.end(JSON.stringify({ elu }) + "\n");
    }
    default: res.statusCode = 404; return res.end();
  }
}).listen(4002, "127.0.0.1", () => console.log(`dinleniyor 4002, worker havuzu=${HAVUZ_BOYUTU}`));
```

Test betiği her senaryoda yük üreticisini çalıştırıyor, sonra sunucunun olay döngüsü kullanımını okuyor. Senaryo B'de iki üretici aynı anda çalışıyor: hızlı uç noktaya saniyede 500, ağır uç noktaya saniyede 5 istek.

```js
// olaydongusu-test.mjs (özet)
const [b1, b2] = await Promise.all([
  yukle({ url: B + "/hizli", hiz: 500, sure: 10, tohum: 3 }),
  yukle({ url: B + "/agir", hiz: 5, sure: 10, tohum: 9 }),
]);
```

```text
dinleniyor 4002, worker havuzu=14
/agir tek başına: p50=47.7 ms (CPU işi)

A) /hizli 500/sn                       verim= 516  p50=   0.4  p99=   1.1 ms  | olay döngüsü kullanımı=10%
B) /hizli 500/sn + /agir 5/sn          verim= 516  p50=   0.5  p99= 137.7 ms  | olay döngüsü kullanımı=43%
   (/agir)                             verim=   5  p50=  73.2  p99= 158.6 ms
C) /hizli 500/sn + /agir-worker 5/sn   verim= 516  p50=   0.3  p99=   0.8 ms  | olay döngüsü kullanımı=8%
   (/agir-worker)                      verim=   5  p50=  48.1  p99=  73.3 ms
D) /agir 30/sn                         verim=  20  p50=2742.3  p99=6414.3 ms  | olay döngüsü kullanımı=100%
E) /agir-worker 150/sn                 verim= 155  p50=  67.5  p99=  89.5 ms  | olay döngüsü kullanımı=4%
F) /bekle 1000/sn (50 ms G/Ç)          verim=1016  p50=  50.8  p99=  55.0 ms  | olay döngüsü kullanımı=19%
   ölçülen eşzamanlılık L=51.8 (λW = 51.8)
```

Senaryoları tek tek okuyalım:

- **A → B:** Saniyede sadece 5 ağır istek (toplam isteklerin yüzde 1'i), hızlı uç noktanın **p99'unu 1 ms'den 138 ms'ye** çıkardı. p50 neredeyse değişmedi. Bu, olay döngüsü bloklamasının tipik imzasıdır: Ortalama ve medyan iyi görünür, kuyruk patlar. Hızlı isteklerin bir kısmı, kendisinden önce gelen ağır işin bitmesini bekledi. Ağır isteklerin kendisi de birbirini bekledi: p50 48 değil 73 ms.
- **B → C:** Aynı ağır iş worker havuzuna taşındı. Hızlı uç noktanın p99'u 0,8 ms'ye döndü ve olay döngüsü kullanımı yüzde 43'ten yüzde 8'e indi. Ağır işin süresi değişmedi (yaklaşık 48 ms), ama artık kimseyi bekletmiyor.
- **D:** Ağır uç noktanın kapasitesi `1000 / 47,7 ≈ 21` istek/sn. Saniyede 30 istek kapasitenin üstünde. Verim 20'de doydu, kuyruk büyüdü ve 10 saniyelik testin sonunda gecikme saniyeler mertebesine çıktı. Olay döngüsü yüzde 100 dolu. Önceki dersteki eğrinin ρ>1 tarafı tam olarak bu.
- **E:** Aynı iş 14 worker'a dağıtıldığında saniyede 150 istek rahatça taşındı. Olay döngüsü yüzde 4 dolu. p50, 48 ms'lik işin üstüne iş kuyruğu ve mesajlaşma maliyetini (yaklaşık 20 ms) ekliyor.
- **F:** Her istek 50 ms **bekliyor**, ama CPU kullanmıyor. Tek bir iş parçacığı saniyede 1000 isteği taşıdı. Little yasasına göre her an ortalama 52 istek "uçuşta". Olay döngüsü yüzde 19 dolu. Node'un güçlü olduğu senaryo budur.

> **Not:** Olay döngüsü gecikmesini ölçmek için `perf_hooks.monitorEventLoopDelay()` de kullanılır. Ama bu fonksiyon bir zamanlayıcının ne kadar geç tetiklendiğini ölçer. Windows'ta zamanlayıcı çözünürlüğü kaba olduğu için, bu ölçümde boşta bile 16 ms civarında "gecikme" gördük. **Olay döngüsü kullanımı** (`performance.eventLoopUtilization()`) zamanlayıcıdan bağımsızdır ve hangi platformda olursa olsun döngünün ne kadar meşgul olduğunu doğru gösterir. Üretimde ikisini birlikte izle.

### Olay döngüsünü bloklayan şeyler

Senkron CPU işi sadece "hesaplama" demek değildir. Gözden kaçan yaygın kaynaklar:

| Kaynak | Örnek | Çözüm |
|---|---|---|
| Büyük JSON | 50 MB'lık bir yanıtı `JSON.parse` ya da `JSON.stringify` etmek | Sayfalama, akışla (stream) ayrıştırma, yanıt boyutu sınırı |
| Senkron kripto | `pbkdf2Sync`, `scryptSync`, büyük `createHash().update()` | Asenkron sürümler (libuv havuzunda çalışır) ya da worker |
| Senkron dosya ve süreç | `readFileSync`, `execSync`, `zlib.gzipSync` | Asenkron API'ler. Başlangıçta bir kez okumak sorun değildir |
| Regex | Güvenlik kursundaki ReDoS | Doğrusal motor, uzunluk sınırı |
| Büyük dizi işlemleri | 1 milyon elemanlık `sort` ya da `map`/`filter` zincirleri | Veritabanında yap, parçalara böl, worker kullan |
| Şablon ve SSR | Büyük bir sayfanın sunucu tarafında oluşturulması | Önbellek (sonraki ders), akışla oluşturma |

Asenkron kripto ve `zlib` fonksiyonları libuv'nin iş parçacığı havuzunda çalışır. Bu havuzun varsayılan boyutu **4**'tür (`UV_THREADPOOL_SIZE`). Aynı anda 4'ten fazla asenkron `pbkdf2` ya da `fs` işlemi, bu havuzda sıraya girer. Çok çekirdekli bir makinede parola doğrulama yoğun bir uç nokta, havuzu büyütmekten (en fazla 1024) fayda görür.

## CPU'yu ölçeklemek: worker'lar ve süreçler

İki yol var, ikisinin de yeri ayrı:

| | `worker_threads` | Birden çok süreç (`cluster`, PM2, birden çok pod) |
|---|---|---|
| Ne için | Bir isteğin içindeki ağır CPU işini ana döngüden ayırmak | Bütün sunucuyu çekirdekler arasında çoğaltmak |
| Bellek | Aynı süreç. `SharedArrayBuffer` ile paylaşım mümkün | Her süreç ayrı yığın (heap) |
| Hata yalıtımı | Worker çökmesi yakalanabilir | Bir süreç çökerse diğerleri çalışır |
| Kubernetes'te | Pod başına bir süreç, içinde worker havuzu | Genellikle süreç başına bir pod. Ölçeklemeyi HPA yapar |

`cluster` ile ölçeklemeyi ölçelim. Her süreç istek başına 4 ms CPU işi yapıyor (önceki dersteki sunucu). Azami verimi ölçmek için bu kez **kapalı model** kullanıyoruz: N süreç için 4N eşzamanlı bağlantı açılıyor, her bağlantı yanıtı alır almaz yeni istek gönderiyor.

```js
// kume.mjs — node:cluster ile N süreç: her biri istek başına 4 ms CPU işi yapar
import cluster from "node:cluster";
import http from "node:http";
const N = Number(process.env.N ?? 1);
if (cluster.isPrimary) {
  for (let i = 0; i < N; i++) cluster.fork();
  cluster.on("exit", (w, kod) => console.log(`worker ${w.process.pid} çıktı (${kod})`));
  console.log(`birincil süreç, ${N} worker`);
} else {
  const mesgul = (ms) => { const son = performance.now() + ms; while (performance.now() < son); };
  http.createServer((req, res) => { mesgul(4); res.end("tamam\n"); }).listen(4003, "127.0.0.1");
}
```

```js
// kume-test.mjs — azami verim: kapalı model (K eşzamanlı bağlantı, her biri yanıt gelince yenisini gönderir)
async function kapaliModel(url, K, saniye) {
  const ajan = new http.Agent({ keepAlive: true, maxSockets: K });
  const bitis = performance.now() + saniye * 1000;
  let biten = 0, hata = 0;
  const dongu = async () => {
    while (performance.now() < bitis) {
      await new Promise((ok) => http.get(url, { agent: ajan }, (r) => { r.resume(); r.on("end", () => { biten++; ok(); }); })
        .on("error", () => { hata++; ok(); }));
    }
  };
  await Promise.all(Array.from({ length: K }, dongu));
  ajan.destroy();
  return { verim: biten / saniye, hata };
}
// N = 1, 2, 4, 8, 12 için kume.mjs'i başlat, kapaliModel(url, 4 * N, 6) ölç
```

```text
N= 1  azami verim=  237 istek/sn  (doğrusal: 234)  hata=0
N= 2  azami verim=  238 istek/sn  (doğrusal: 468)  hata=0
N= 4  azami verim=  238 istek/sn  (doğrusal: 936)  hata=0
N= 8  azami verim=  241 istek/sn  (doğrusal: 1872)  hata=0
N=12  azami verim=  244 istek/sn  (doğrusal: 2808)  hata=0
```

12 süreç, tek süreçle aynı verimi verdi. Bunun nedeni bağlantıların dağıtımıdır. Windows'ta `cluster`'ın varsayılan politikası `SCHED_NONE`'dur, yani kabul edilen bağlantıyı hangi sürecin alacağına işletim sistemi karar verir. Az sayıda, **uzun ömürlü** (keep-alive) bağlantıda hepsi aynı sürece düştü. Diğer süreçler boşta kaldı. Round-robin dağıtımla:

```bash
NODE_CLUSTER_SCHED_POLICY=rr node kume-test.mjs
```

```text
N= 1  azami verim=  238 istek/sn  (doğrusal: 234)  hata=0
N= 2  azami verim=  473 istek/sn  (doğrusal: 468)  hata=0
N= 4  azami verim=  932 istek/sn  (doğrusal: 936)  hata=0
N= 8  azami verim= 1827 istek/sn  (doğrusal: 1872)  hata=0
N=12  azami verim= 2762 istek/sn  (doğrusal: 2808)  hata=0
```

İş tamamen paralel ve paylaşılan durum olmadığı için ölçekleme neredeyse doğrusal (Amdahl'ın en iyi durumu). Linux'ta `cluster`'ın varsayılanı zaten round-robin'dir. Bu ölçümün dersi platformdan bağımsızdır: **Yük dağıtımı bağlantı seviyesinde yapılıyorsa, uzun ömürlü bağlantılar dengesizliğe yol açar.** Kubernetes'te de aynı sorun görülür. Bir Service'in (kube-proxy) dağıttığı şey bağlantılardır, istekler değil. Yeni bir pod eklendiğinde, mevcut keep-alive bağlantıları (özellikle gRPC ve HTTP/2) eski pod'larda kalır. Yeni pod, yeni bağlantı açılana kadar boşta bekler. Çözüm, istek seviyesinde dengeleyen bir vekildir (Envoy, ingress, servis ağı) ya da bağlantılara azami ömür vermektir (sonraki ders).

Ölçüm hakkında bir not: Aynı testi önce açık model üreticiyle, kapasitenin üstünde bir hızla yaptık. Üretici binlerce soket açtı. Windows'un dinleme kuyruğu (listen backlog) taştı, isteklerin bir kısmı hatayla döndü ve 8 süreçte verim 275'e çöktü. **Azami verim, kapalı modelle ölçülür. Gecikme ise açık modelle ölçülür.** İkisinin farkını yük testi dersinde ayrıntılı göreceğiz.

## Bağlantıları yeniden kullanmak

Her yeni TCP bağlantısı en az bir gidiş-dönüş (el sıkışma), TLS varsa bir ya da iki gidiş-dönüş daha, çekirdekte soket yapıları ve kapanışta `TIME_WAIT` durumu demektir. Aynı hızda, bağlantı yeniden kullanılarak ve her istekte yeni bağlantı açılarak:

```js
for (const keepAlive of [true, false]) {
  const r = await yukle({ url: "http://127.0.0.1:4002/hizli", hiz: 1000, sure: 5, tohum: 2, keepAlive });
  ...
}
```

```text
keepAlive=true  verim=987  p50=0.26  p99=0.88  p99.9=13.91 ms  hata=0
keepAlive=false verim=910  p50=451.58  p99=1263.62  p99.9=1293.31 ms  hata=0
```

Saniyede 1000 yeni bağlantı, Windows'ta yerel makinede bile gecikmeyi yüzlerce milisaniyeye çıkardı. Linux'ta fark daha küçük olur. Ama ağ üzerinden, özellikle TLS ile, her bağlantının maliyeti milisaniyeler mertebesindedir. Pratikte:

- **Giden istekler:** Node 19'dan beri `http.globalAgent` keep-alive kullanır. `fetch` (undici) de bağlantı havuzu kullanır. Ama özel bir `http.Agent` oluşturuyorsan `keepAlive: true` ve makul bir `maxSockets` vermek senin işin. Her istekte yeni bir `Agent` oluşturmak, havuzu her seferinde sıfırlar. Bu yaygın bir hatadır.
- **Gelen istekler:** Sunucunun `keepAliveTimeout` değeri (Node'da varsayılan 5 sn), önündeki yük dengeleyicinin boşta bekleme süresinden **uzun** olmalıdır. Aksi halde sunucu bağlantıyı tam yük dengeleyici yeni bir istek gönderirken kapatır ve aralıklı 502 hataları görülür. Örneğin AWS ALB'nin varsayılanı 60 sn olduğundan, `server.keepAliveTimeout = 65_000` ve `server.headersTimeout = 66_000` gerekir.
- **Veritabanı:** Bağlantı havuzu aynı ilkenin veritabanı karşılığıdır. Havuz boyutunu veritabanı dersinde ölçeceğiz.

## Bellek ve çöp toplayıcı

V8'in çöp toplayıcısı nesilsel çalışır. Kısa ömürlü nesneler "genç nesilde" ucuza toplanır. Uzun yaşayan ve büyüyen nesneler "yaşlı nesle" geçer ve onların toplanması daha pahalıdır. Yüksek trafikte belirtiler şunlardır:

- **GC duraklamaları:** Büyük bir yaşlı nesil koleksiyonu, olay döngüsünü onlarca milisaniye durdurabilir. Bu duraklama p99'da görünür. `--trace-gc` bayrağı ve `perf_hooks`'un `gc` girdileri ile izlenir.
- **Bellek sızıntısı:** Sınırsız büyüyen bir önbellek (`Map`), kapatılmayan olay dinleyicileri, closure'larda tutulan büyük nesneler. Belirtisi yavaş büyüyen RSS, ardından artan GC süresi, sonunda OOM ile yeniden başlatmadır. Sonraki dersteki önbellek, bu yüzden boyut sınırlı olacak.
- **Konteyner limiti:** Güncel Node sürümleri, varsayılan yığın boyutunu kullanılabilir belleğe göre belirler. Yine de `--max-old-space-size` değerini konteyner limitinin yaklaşık yüzde 75'i olarak açıkça vermek iki fayda sağlar: Davranış sürümden bağımsız hale gelir, ayrıca yerel bellek (Buffer'lar, yerel eklentiler, iş parçacığı yığınları) için pay kalır. Aksi halde süreç V8 sınırına gelmeden çekirdeğin OOM öldürücüsüyle karşılaşabilir.

```quiz
{
  "question": "Bir Node API'sinin p50 gecikmesi 3 ms ama p99 gecikmesi 180 ms. CPU kullanımı %30 civarında. Olay döngüsü kullanımı da düşük değil, sıçramalar yapıyor. En olası neden ve ilk yapılacak iş hangisi?",
  "options": [
    "Ağ gecikmesi. Daha hızlı bir ağ kartı gerekir.",
    "Bazı istekler olay döngüsünü senkron CPU işiyle bloke ediyor (büyük JSON, senkron kripto, regex, büyük dizi işlemleri). O sırada gelen bütün istekler bekliyor. Olay döngüsü kullanımını ve yavaş uç noktaları ölçüp ağır işi bulmalı, ardından onu asenkron API'ye, worker'a ya da veritabanına taşımalı.",
    "Sunucu sayısını iki katına çıkarmak p99'u düzeltir.",
    "UV_THREADPOOL_SIZE'ı 1024 yapmak her durumda çözer."
  ],
  "answer": 1,
  "explanation": "Düşük p50 ile yüksek p99 ve döngü kullanımındaki sıçramalar, bloklamanın imzasıdır. Sunucu eklemek bloklama süresini kısaltmaz, sadece etkilenen istek oranını biraz azaltır. Thread pool sadece libuv'ye devredilen asenkron işleri etkiler."
}
```

```quiz
{
  "question": "Kubernetes'te gRPC kullanan bir servis 3 pod'dan 10 pod'a ölçekleniyor, ama yük hâlâ ilk 3 pod'da toplanıyor ve yeni pod'lar neredeyse boşta. Neden?",
  "options": [
    "Yeni pod'ların readiness probe'u başarısız.",
    "gRPC, HTTP/2 üzerinde uzun ömürlü tek bir bağlantı kullanır. Kubernetes Service'i (kube-proxy) bağlantı seviyesinde dengeler. Mevcut bağlantılar eski pod'larda kaldığı için yeni pod'lara istek gitmez. İstek seviyesinde dengeleyen bir vekil (Envoy, servis ağı), istemci tarafı dengeleme ya da bağlantılara azami ömür (max connection age) gerekir.",
    "HPA yanlış yapılandırılmış.",
    "gRPC sadece tek pod ile çalışır."
  ],
  "answer": 1,
  "explanation": "Bağlantı seviyesindeki dengeleme, uzun ömürlü bağlantılarda dengesizlik yaratır. Bu derste Windows'taki cluster SCHED_NONE ölçümünde aynı etkiyi gördük: 12 süreç, 1 sürecin verimini verdi."
}
```

```lab
{
  "title": "Olay döngüsünü ölç ve serbest bırak",
  "steps": [
    "olaydongusu.mjs'i çalıştır ve test betiğindeki B senaryosunu /agir hızını 1, 2, 5, 10 yaparak tekrarla. Hızlı uç noktanın p99'unun ağır işin sıklığıyla nasıl değiştiğini tabloya dök.",
    "`agirIs` fonksiyonunu senkron yerine `crypto.pbkdf2` (callback'li, libuv havuzunda çalışan) sürümüyle değiştir. Saniyede 30 istek gönder ve sonucu worker havuzuyla karşılaştır. Ardından `UV_THREADPOOL_SIZE=16` ile tekrar dene.",
    "Kendi uygulamana `performance.eventLoopUtilization()` değerini her 10 saniyede bir loglayan (ya da metrik olarak yayımlayan) bir kod ekle. Yük altında hangi uç noktaların ELU'yu yükselttiğini bul.",
    "kume-test.mjs'i `NODE_CLUSTER_SCHED_POLICY=none` ve `rr` ile, bir de K=4N yerine K=200 bağlantıyla çalıştır. Çok sayıda kısa bağlantının SCHED_NONE'daki dengesizliği nasıl azalttığını gözlemle.",
    "Kendi servisinin keepAliveTimeout ve headersTimeout değerlerini, önündeki yük dengeleyicinin boşta bekleme süresiyle karşılaştır."
  ]
}
```

## Özet

- Node, G/Ç beklemesinde son derece verimlidir: Tek iş parçacığı, 50 ms bekleyen saniyede 1000 isteği yüzde 19 döngü kullanımıyla taşıdı. CPU işinde ise tek bir istek herkesi bekletir.
- İsteklerin yüzde 1'i olan ağır işler, hızlı uç noktanın p99'unu 1 ms'den 138 ms'ye çıkardı. p50 değişmedi. Bloklamanın imzası düşük p50 ve yüksek p99'dur.
- Ağır CPU işini worker havuzuna taşı. Olay döngüsünü **kullanım** (ELU) ile izle, zamanlayıcı tabanlı gecikme ölçümü platforma bağlıdır.
- Asenkron kripto, zlib ve fs, libuv havuzunu kullanır (varsayılan 4 iş parçacığı).
- Süreçlerle ölçekleme, paylaşılan durum yoksa neredeyse doğrusaldır (12 süreç 2762/2808). Bağlantı seviyesinde dengeleme ise uzun ömürlü bağlantılarda dengesizlik yaratır. Bu durum Windows'ta cluster'ın SCHED_NONE politikasında ve Kubernetes'te gRPC'de görülür.
- Azami verimi kapalı modelle, gecikmeyi açık modelle ölç.
- Bağlantıları yeniden kullan: keep-alive, tek bir paylaşılan Agent, yük dengeleyiciden uzun `keepAliveTimeout`. Belleği sınırlı tut, GC duraklamalarını izle.
