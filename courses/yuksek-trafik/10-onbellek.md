# Önbellekleme: cache-aside, geçersizleştirme ve önbellek fırtınası

Önbellek, yüksek trafikte en etkili tek araçtır. Pahalı bir işin sonucunu saklayıp tekrar kullanmak, o işi hızlandırmaktan her zaman daha ucuzdur. Önbelleğin iki bilinen zorluğu var:

- **Geçersizleştirme:** Saklanan değer ne zaman artık doğru değildir?
- **Önbellek kaybolduğunda arka ucun ne yaşadığı:** Bu soru genellikle hiç sorulmaz.

Bu derste ikisini de ölçüyoruz.

## Deney: yavaş bir veritabanı ve önbellek

"Veritabanı", her okuması 80 ms süren ve aynı anda en fazla 20 sorgu kabul eden (bir bağlantı havuzu gibi) bir fonksiyon. Kapasitesi `20 / 0,08 = 250` sorgu/sn. Önünde boyutu sınırlı bir LRU ve TTL önbelleği var. `MOD` ortam değişkeni, önbelleğin nasıl kullanılacağını seçiyor:

```js
// onbellek.mjs — yavaş "veritabanı" + LRU/TTL önbellek + tekil uçuş (single-flight)
// MOD=yok | aside | tekil | swr   (TTL_MS ile yaşam süresi)
import http from "node:http";
import { setTimeout as bekle } from "node:timers/promises";

const MOD = process.env.MOD ?? "aside";
const TTL_MS = Number(process.env.TTL_MS ?? 30_000);
const KAPASITE = Number(process.env.KAPASITE ?? 1000);

// --- "Veritabanı": her okuma 80 ms, aynı anda en fazla 20 sorgu (bağlantı havuzu)
let dbSorgu = 0, dbAktif = 0, dbEnFazla = 0;
const dbKuyruk = [];
async function dbOku(id) {
  if (dbAktif >= 20) await new Promise((ok) => dbKuyruk.push(ok));
  dbAktif++; dbSorgu++; dbEnFazla = Math.max(dbEnFazla, dbAktif);
  try { await bekle(80); return { id, ad: `Ürün ${id}`, fiyat: 100 + (id % 50) }; }
  finally { dbAktif--; dbKuyruk.shift()?.(); }
}

// --- LRU + TTL: Map ekleme sırasını korur; erişilen öğe sona taşınır, en baştaki en eski
class LruTtl {
  constructor(kapasite, ttl) { this.k = kapasite; this.ttl = ttl; this.m = new Map(); this.isabet = 0; this.iska = 0; }
  al(anahtar) {
    const o = this.m.get(anahtar);
    if (!o || o.son < Date.now()) { if (o) this.m.delete(anahtar); this.iska++; return undefined; }
    this.m.delete(anahtar); this.m.set(anahtar, o); this.isabet++;
    return o.deger;
  }
  koy(anahtar, deger) {
    this.m.delete(anahtar);
    this.m.set(anahtar, { deger, son: Date.now() + this.ttl, sert: Date.now() + 10 * this.ttl });   // sert: bayat sunmanın üst sınırı
    if (this.m.size > this.k) this.m.delete(this.m.keys().next().value);    // en az yakın zamanda kullanılanı at
  }
}
const onbellek = new LruTtl(KAPASITE, TTL_MS);

// --- Tekil uçuş: aynı anahtar için süren bir sorgu varsa ona katıl
const ucustakiler = new Map();
function tekilUcus(anahtar, fn) {
  let p = ucustakiler.get(anahtar);
  if (!p) { p = fn().finally(() => ucustakiler.delete(anahtar)); ucustakiler.set(anahtar, p); }
  return p;
}

async function urunGetir(id) {
  if (MOD === "yok") return dbOku(id);
  if (MOD === "swr") {                                   // stale-while-revalidate: bayatı hemen sun, arka planda yenile
    const yukle = async () => { const v = await dbOku(id); onbellek.koy(id, v); return v; };
    const o = onbellek.m.get(id), simdi = Date.now();
    if (o && o.sert > simdi) {
      if (o.son < simdi) tekilUcus(id, yukle).catch(() => {});     // beklemeden yenile
      onbellek.isabet++; return o.deger;
    }
    onbellek.iska++; return tekilUcus(id, yukle);
  }
  const o = onbellek.al(id);
  if (o !== undefined) return o;
  const yukle = async () => { const v = await dbOku(id); onbellek.koy(id, v); return v; };
  return MOD === "tekil" ? tekilUcus(id, yukle) : yukle();
}

http.createServer(async (req, res) => {
  const m = req.url.match(/^\/urun\/(\d+)$/);
  if (m) { const u = await urunGetir(+m[1]); res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(u)); }
  if (req.url === "/istatistik") {
    const t = onbellek.isabet + onbellek.iska;
    res.end(JSON.stringify({ mod: MOD, dbSorgu, dbEnFazlaEszamanli: dbEnFazla, isabetOrani: t ? onbellek.isabet / t : 0, boyut: onbellek.m.size }) + "\n");
    dbSorgu = 0; dbEnFazla = 0; onbellek.isabet = 0; onbellek.iska = 0;
    return;
  }
  res.statusCode = 404; res.end();
}).listen(Number(process.env.PORT ?? 4010), "127.0.0.1", () => console.log(`önbellek deneyi mod=${MOD} ttl=${TTL_MS}`));
```

Gerçek trafik düzgün dağılmaz. Az sayıda ürün, isteklerin çoğunu alır. Test, 10.000 ürün arasından **Zipf dağılımıyla** (k. ürünün olasılığı 1/k ile orantılı) seçim yapıyor. Yük üreticisinin URL parametresi bunun için bir fonksiyon da alabiliyor:

```js
// onbellek-test.mjs (özet) — Zipf dağılımlı anahtarlarla karşılaştırma
const N = 10_000, kum = [];
let t = 0; for (let k = 1; k <= N; k++) { t += 1 / k; kum.push(t); }
const zipf = (r) => { const x = r() * t; let a = 0, b = N - 1; while (a < b) { const m = (a + b) >> 1; kum[m] < x ? (a = m + 1) : (b = m); } return a + 1; };

const r = await yukle({ url: (rnd) => `http://127.0.0.1:4010/urun/${zipf(rnd)}`, hiz, sure: 15, tohum: 11, zamanAsimi: 30_000 });
```

```text
trafikteki pay: en popüler 100 ürün %53, en popüler 1000 ürün %76

önbelleksiz 200/sn             p50=   83.8  p99=  123.0 ms  verim=194  isabet=%0.0  db sorgusu=2920
önbelleksiz 300/sn             p50= 1518.6  p99= 3625.0 ms  verim=236  isabet=%0.0  db sorgusu=4405
cache-aside, 1000 öğe 300/sn   p50=    0.5  p99=  125.2 ms  verim=292  isabet=%62.5  db sorgusu=1651
cache-aside, 100 öğe 300/sn    p50=   80.8  p99=  124.9 ms  verim=292  isabet=%37.8  db sorgusu=2741
```

Okuma:

- **Önbelleksiz, 300/sn:** Veritabanının kapasitesi (250/sn) aşıldı. Önceki derslerin ρ>1 durumu: Kuyruk büyüdü, p50 1,5 saniyeye çıktı.
- **Cache-aside, 1000 öğe:** Aynı yükte p50 **0,5 ms**. İsteklerin yüzde 62,5'i önbellekten döndü, veritabanı sorgusu üçte bire düştü. p99 hâlâ 125 ms, çünkü ıskalar veritabanına gidiyor. Önbellek medyanı düzeltir, kuyruğu düzeltmesi için ıska yolunun da hızlı olması gerekir.
- **İsabet oranı, teorik paydan düşük:** En popüler 1000 ürün trafiğin yüzde 76'sı, ölçülen isabet yüzde 62,5. Fark, 15 saniyelik testin ilk anlarında önbelleğin boş olmasından (soğuk başlangıç) ve uzun kuyruktaki ürünlerin LRU'dan sürekli atılmasından geliyor. Yeni açılan bir pod ya da yeniden başlatılan bir önbellek, bir süre "soğuk" çalışır. Dağıtımlarda bu ısınma süresi planlanmalıdır.
- **100 öğelik önbellek:** İsabet yüzde 38'e düştü, p50 bir veritabanı sorgusu süresine döndü. Önbellek boyutu ile isabet oranı arasındaki ilişki, erişim dağılımına bağlıdır. Bu ilişki tahmin edilmez, ölçülür. İsabet oranını metrik olarak yayımlamak bu yüzden şarttır.

## Önbellek kalıpları

| Kalıp | Okuma | Yazma | Ne zaman |
|---|---|---|---|
| **Cache-aside** (lazy loading) | Önbellekte yoksa uygulama veritabanından okur ve önbelleğe yazar | Veritabanına yazar, önbellekteki anahtarı siler | Varsayılan seçim. Önbellek çökerse sistem yavaşlar ama çalışır |
| **Read-through** | Önbellek kütüphanesi ya da katmanı yükleyiciyi kendisi çağırır | Cache-aside ile aynı | Yükleme mantığını tek yerde toplamak için |
| **Write-through** | Önbellekten | Önce önbelleğe, eşzamanlı olarak veritabanına | Yazılan veri hemen okunacaksa |
| **Write-behind** | Önbellekten | Önbelleğe yazar, veritabanına **sonra** toplu yazar | Sayaçlar, analitik. Önbellek kaybında veri kaybı riski |
| **Refresh-ahead / SWR** | Süresi dolmak üzere olanı arka planda yeniler | | Popüler ve yenilenmesi pahalı anahtarlar |

Önbelleğin **nerede** durduğu da bir tasarım kararıdır:

- **Süreç içi** (bu deneydeki `Map`): Nanosaniye erişim, ağ yok. Ama her kopyanın ayrı önbelleği vardır. 10 pod, aynı veriyi 10 kez yükler ve geçersizleştirme 10 kopyaya ulaşmalıdır. Sık değişmeyen, küçük ve çok okunan veri için uygundur: yapılandırma, kategori ağacı, özellik bayrakları.
- **Paylaşılan** (Redis, Memcached, Valkey): Bütün kopyalar aynı önbelleği görür, geçersizleştirme tek yerde yapılır. Her erişim bir ağ gidiş-dönüşüdür (aynı veri merkezinde yaklaşık 0,2–0,5 ms). Önbellek sunucusu da bir bağımlılık ve bir kapasite kaynağı haline gelir.
- **İki katmanlı:** Kısa TTL'li süreç içi önbellek ve arkasında paylaşılan önbellek. Popüler anahtarlar ağa hiç çıkmaz. Paylaşılan önbellekte tek bir anahtarın tek bir düğüme yük bindirmesi ("sıcak anahtar") sorunu da hafifler.
- **HTTP ve CDN:** Yanıtın kendisi istemciye, CDN'e ya da ters vekile kadar önbelleğe alınır. Uygulama sunucusuna hiç istek gelmez. Sonraki dersin konusu.

## Önbellek fırtınası

Popüler bir anahtarın süresi dolduğunda ne olur? Cache-aside'da, ıskayı gören **her** istek veritabanına gider. Veritabanı yanıtı 80 ms sürüyorsa ve o anahtara saniyede 1000 istek geliyorsa, bu 80 ms içinde gelen 80 isteğin hepsi aynı sorguyu çalıştırır. Buna önbellek fırtınası ya da "dog-pile" denir. Tek bir anahtara saniyede 1000 istek, TTL 2 saniye:

```js
// firtina-test.mjs — tek bir popüler anahtar, kısa TTL, yüksek eşzamanlılık
for (const mod of ["aside", "tekil", "swr"]) {
  const p = spawn(process.execPath, ["onbellek.mjs"], { env: { ...process.env, MOD: mod, TTL_MS: "2000" }, stdio: "ignore" });
  await bekle(1000);
  const r = await yukle({ url: "http://127.0.0.1:4010/urun/1", hiz: 1000, sure: 10, tohum: 5 });
  const ist = await (await fetch("http://127.0.0.1:4010/istatistik")).json();
  ...
}
```

```text
aside  istek=9919  db sorgusu= 414  aynı anda en fazla db sorgusu=20  p50=0.4  p99=256.4  p99.9=335.9 ms
tekil  istek=9919  db sorgusu=   5  aynı anda en fazla db sorgusu= 1  p50=0.3  p99=66.9  p99.9=85.2 ms
swr    istek=9915  db sorgusu=   5  aynı anda en fazla db sorgusu= 1  p50=0.3  p99=7.8  p99.9=81.4 ms
```

10 saniyede 5 kez süre doldu (TTL 2 sn):

- **Cache-aside:** Her süre dolumunda ortalama 80 istek aynı sorguyu çalıştırdı. Toplam **414** sorgu, aynı anda havuzun tamamı (20) kullanıldı. Havuz dolunca istekler kuyrukta bekledi, p99 256 ms. Bu tek bir anahtar için. Gerçek bir sistemde aynı anda süresi dolan yüzlerce anahtar ve zaten yüklü bir veritabanı olur. Fırtına, veritabanını devirip bir kesintiye dönüşebilir.
- **Tekil uçuş (single-flight):** Aynı anahtar için süren bir yükleme varsa, yeni ıskalar ona **katılır**, yani aynı Promise'i bekler. Süre dolumu başına tam 1 sorgu, toplam 5. İlk ıskayı yapan istekler yine 80 ms bekler (p99 67 ms).
- **Stale-while-revalidate (SWR):** Süresi dolmuş ama "sert" sınırı geçmemiş değer **hemen** sunulur, yenileme arka planda (tekil uçuşla) yapılır. Kullanıcı hiç beklemez: p99 7,8 ms. Bedeli, kısa bir süre (bir yenileme süresi kadar) bayat veri sunmaktır. Ürün açıklaması ya da fiyat listesi için genellikle kabul edilebilir. Stok miktarı ya da bakiye için değildir.

Tekil uçuş süreç içinde çalışır. 10 pod varsa, süre dolumunda yine 10 sorgu gider. Bu genellikle yeterlidir. Daha fazlası gerekiyorsa paylaşılan önbellekte bir **kilit anahtarı** kullanılır (`SET kilit:urun:1 <id> NX PX 5000`): Kilidi alan yükler, diğerleri kısa bir süre bekleyip tekrar önbelleğe bakar ya da bayat değeri sunar.

Fırtınayı önlemenin iki tamamlayıcı tekniği daha var:

- **TTL'e rastgelelik (jitter):** Aynı anda önbelleğe yazılan binlerce anahtar (örneğin bir dağıtımdan sonra), aynı anda süresi dolar. TTL'i `300 sn ± %10` gibi rastgele yapmak, süre dolumlarını zamana yayar.
- **Olasılıksal erken yenileme (XFetch):** Her okumada, sürenin dolmasına ne kadar az kaldığına ve yüklemenin ne kadar sürdüğüne bağlı küçük bir olasılıkla değer **erken** yenilenir. Popüler anahtarlar süre dolmadan, tek bir istek tarafından yenilenir. Kilide gerek kalmaz.

```js
// XFetch: deltaMs = son yüklemenin süresi, beta = 1 (büyüdükçe daha erken yeniler)
const erkenYenile = (kayit, beta = 1) =>
  Date.now() - kayit.deltaMs * beta * Math.log(Math.random()) >= kayit.son;
```

## Geçersizleştirme

"Bilgisayar biliminde iki zor şey var: önbellek geçersizleştirme ve şeylere isim vermek." Zorluk, okuma ve yazmanın **eşzamanlı** olmasından gelir. Cache-aside'ın standart yazma yolu "veritabanını güncelle, önbellekteki anahtarı sil" şeklindedir. Bu yol, şu sıralamada bozulur:

1. t=0: Okuyucu önbellekte bulamaz, veritabanından **eski** değeri okur. Sorgu yavaştır.
2. t=10: Yazıcı veritabanını günceller ve önbellekteki anahtarı siler (zaten yok).
3. t=50: Okuyucunun sorgusu döner, **eski** değeri önbelleğe yazar.

Önbellek artık TTL dolana kadar yanlış değeri sunar. Bu yarışı deterministik olarak üretelim:

```js
// yaris.mjs — geçersizleştirme yarışı ve sürümlü yazımla düzeltme
import { setTimeout as bekle } from "node:timers/promises";

async function senaryo(ad, { surumlu }) {
  const db = { fiyat: 100, surum: 1 };
  const onbellek = new Map();

  const dbOku = async (gecikme) => { const v = { ...db }; await bekle(gecikme); return v; };   // okunan an ile dönülen an arasında zaman geçer
  const onbellegeKoy = (v) => {
    const mevcut = onbellek.get("urun:1");
    // sürümlü yazım: önbellekteki değerden eski olanı yazma; mezar taşı ise aynı ya da daha yeni sürüm yazılabilir
    if (surumlu && mevcut && (mevcut.silindi ? v.surum < mevcut.surum : v.surum <= mevcut.surum)) return;
    onbellek.set("urun:1", v);
  };

  const oku = async (gecikme) => {
    const o = onbellek.get("urun:1");
    if (o && !o.silindi) return o;        // isabet (mezar taşı ıska sayılır)
    const v = await dbOku(gecikme);
    onbellegeKoy(v);
    return v;
  };
  const okuyucu = oku(50);                // yavaş sorgu: t=0'da okudu, t=50'de dönüyor
  const yazici = (async () => {
    await bekle(10);                      // t=10: fiyat güncellemesi
    db.fiyat = 120; db.surum = 2;
    if (surumlu) onbellek.set("urun:1", { silindi: true, surum: 2 });   // silmek yerine sürümlü mezar taşı
    else onbellek.delete("urun:1");
  })();
  await Promise.all([okuyucu, yazici]);

  const goster = (o) => (o?.silindi ? `mezar taşı (sürüm ${o.surum})` : `fiyat=${o?.fiyat} (sürüm ${o?.surum})`);
  console.log(`${ad}\n  yarıştan sonra   db: fiyat=${db.fiyat} (sürüm ${db.surum})  önbellek: ${goster(onbellek.get("urun:1"))}`);
  const sonraki = await oku(5);
  console.log(`  sonraki okuma    kullanıcı gördü: fiyat=${sonraki.fiyat}  önbellek: ${goster(onbellek.get("urun:1"))}`);
}

await senaryo("sil ve yeniden doldur", { surumlu: false });
await senaryo("sürümlü yazım + mezar taşı", { surumlu: true });
```

```text
sil ve yeniden doldur
  yarıştan sonra   db: fiyat=120 (sürüm 2)  önbellek: fiyat=100 (sürüm 1)
  sonraki okuma    kullanıcı gördü: fiyat=100  önbellek: fiyat=100 (sürüm 1)
sürümlü yazım + mezar taşı
  yarıştan sonra   db: fiyat=120 (sürüm 2)  önbellek: mezar taşı (sürüm 2)
  sonraki okuma    kullanıcı gördü: fiyat=120  önbellek: fiyat=120 (sürüm 2)
```

Düzeltmede yazıcı anahtarı silmek yerine, **sürüm numaralı bir mezar taşı** bırakır. Okuyucu ancak elindeki değer önbellekteki sürümden yeniyse (mezar taşında aynı ya da yeniyse) yazabilir. Gecikmiş okuyucunun 1. sürümü, 2. sürümün mezar taşını ezemez. Bu düzeltmeyi yazarken kendimiz de bir hata yaptık. İlk sürümde koşul `mevcut.surum >= v.surum` idi. Bu koşul, mezar taşı olan 2. sürümün yerine, veritabanından yeni okunan **aynı** 2. sürümün yazılmasını da engelliyordu. Bu yüzden anahtar hiç dolmuyordu. Önbellek mantığı da test edilmesi gereken bir koddur.

Gerçek bir paylaşılan önbellekte "oku, karşılaştır, yaz" işlemi **atomik** olmalıdır. Redis'te bu bir Lua betiği ya da `WATCH`/`MULTI` ile yapılır. Sürüm numarası veritabanından gelir: bir `surum` sütunu, PostgreSQL'de `xmin` ya da güncelleme zaman damgası.

Geçersizleştirme stratejileri, kesinlik sırasıyla:

1. **Sadece TTL:** Bayatlık en fazla TTL kadardır. Basit ve sağlamdır. Birçok veri için yeterlidir. Kabul edilebilir bayatlık süresini ürün ekibiyle **açıkça** konuş.
2. **Yazmada sil (ve TTL):** Çoğu yazmada önbellek güncel kalır. Yukarıdaki yarış durumu TTL ile sınırlanır.
3. **Sürümlü yazım ya da gecikmeli ikinci silme** (yazmadan sonra, örneğin 500 ms sonra tekrar sil): Yarışı kapatır.
4. **Değişiklik akışıyla geçersizleştirme:** Veritabanının değişiklik akışı (CDC: Debezium, PostgreSQL mantıksal replikasyonu) ya da outbox olayları dinlenir ve ilgili anahtarlar silinir. Uygulamadan bağımsız, eksiksiz bir yöntemdir. Kuyruk dersinde outbox ile birlikte ele alacağız.

Bir uyarı daha: **Anahtar tasarımı** geçersizleştirmenin yarısıdır. Bir ürünün fiyatı değiştiğinde hangi anahtarlar silinmeli? `urun:42`, `kategori:7:sayfa:1`, `arama:"kırmızı ayakkabı"`... Türetilmiş ve birleştirilmiş sonuçları önbelleğe almak isabet oranını artırır, ama geçersizleştirmeyi neredeyse imkânsız kılar. Böyle durumlarda kısa TTL'e ya da **sürümlü anahtar ad alanlarına** başvurulur (`v17:kategori:7:...`). Ad alanı sürümünü artırmak, eski anahtarların hepsini tek seferde geçersiz kılar.

## Diğer tuzaklar

- **Önbellek delinmesi (penetration):** Var olmayan kayıtlar (`/urun/99999999`) her seferinde ıskalar ve veritabanına gider. Saldırgan bunu bilinçli olarak kullanabilir. Çözüm "yok" sonucunu da kısa TTL'le önbelleğe almaktır (negatif önbellek). Çok büyük anahtar uzaylarında Bloom filtresi kullanılır.
- **Büyük değerler:** 5 MB'lık bir değer, her okumada ağda 5 MB demektir. Redis gibi tek iş parçacıklı bir sunucuda bu, diğer istekleri de bekletir. Değerleri küçük tut, gerekirse sıkıştır.
- **Kişiye özel veri:** Kullanıcıya özel bir yanıtı, kullanıcı kimliği olmayan bir anahtarla önbelleğe almak, bir kullanıcının verisini başka bir kullanıcıya gösterir. HTTP önbelleğinde bunun karşılığı `Cache-Control: private` ve `Vary` başlıklarıdır (sonraki ders).
- **Önbellek kaybı:** Paylaşılan önbellek yeniden başladığında bütün anahtarlar aynı anda ıskalar. Veritabanı, önbelleksiz tam yükü bir süre taşıyabilmelidir. Taşıyamıyorsa önbellek artık bir **performans iyileştirmesi değil, bir bağımlılıktır** ve kapasite planı buna göre yapılır: çoğaltma, kalıcılık, ısıtma.

```quiz
{
  "question": "Bir e-ticaret sitesinde ana sayfa verisi 60 saniye TTL ile Redis'te tutuluyor. Her dakika başında veritabanı CPU'su %100'e fırlıyor ve birkaç saniye boyunca hata oranı artıyor. En olası neden ve uygun önlem hangisi?",
  "options": [
    "Redis yavaş. Daha büyük bir Redis örneği gerekir.",
    "Önbellek fırtınası: Popüler anahtarın süresi dolduğunda, o anda gelen bütün istekler aynı pahalı sorguyu çalıştırıyor. Tekil uçuş (ya da dağıtık kilit), stale-while-revalidate ile bayatı sunup arka planda yenileme, TTL'e rastgelelik ve olasılıksal erken yenileme uygulanmalı.",
    "TTL'i 1 saniyeye düşürmek sorunu çözer.",
    "Veritabanı indeksleri eksik, önbelleğin konuyla ilgisi yok."
  ],
  "answer": 1,
  "explanation": "Periyodik ve TTL ile eşzamanlı yük sıçramaları fırtınanın imzasıdır. Bu derste tek bir anahtarda 10 saniyede 414 sorgu ölçtük. Tekil uçuşla bu 5'e, SWR ile kullanıcının bekleme süresi de neredeyse sıfıra indi."
}
```

```quiz
{
  "question": "Cache-aside kullanan bir serviste, yazma yolu 'önce veritabanını güncelle, sonra önbellekteki anahtarı sil' şeklinde. Nadiren bir ürünün eski fiyatı TTL dolana kadar (1 saat) görünmeye devam ediyor. Neden?",
  "options": [
    "Redis silme komutunu bazen kaybediyor.",
    "Bir okuyucu, yazmadan önce veritabanından eski değeri okuyup yazma ve silme işlemi bittikten sonra önbelleğe yazabilir. Silme bu geç yazımı engellemez. Sürümlü yazım (eski sürümün yeni sürümü ezmesini engellemek), gecikmeli ikinci silme ya da CDC ile geçersizleştirme gerekir. TTL de bayatlığın üst sınırıdır, bu yüzden kısa tutulmalıdır.",
    "Önce önbelleği silip sonra veritabanını güncellemek sorunu tamamen çözer.",
    "Bu bir ağ sorunudur."
  ],
  "answer": 1,
  "explanation": "Okuma-yazma yarışı cache-aside'ın bilinen zayıflığıdır. 'Önce sil, sonra güncelle' sırası da yarışı çözmez, sadece pencereyi değiştirir. Sürüm karşılaştırmasının atomik yapılması gerekir."
}
```

```lab
{
  "title": "Önbelleği ölç ve kır",
  "steps": [
    "onbellek-test.mjs'i KAPASITE=100, 1000, 5000 ve 10000 ile çalıştır. İsabet oranını ve p50'yi önbellek boyutuna karşı tabloya dök. Zipf dağılımında 'yeterli' boyut nerede?",
    "Testi 15 yerine 60 saniye çalıştır ve isabet oranını 5 saniyelik dilimlerle yazdır. Soğuk başlangıcın ne kadar sürdüğünü ölç.",
    "firtina-test.mjs'e 100 farklı popüler anahtar ekle ve hepsinin TTL'i aynı anda dolsun. Ardından TTL'e ±%20 rastgelelik ekleyip veritabanındaki 'aynı anda en fazla sorgu' değerini karşılaştır.",
    "onbellek.mjs'e XFetch olasılıksal erken yenilemeyi ekle (kaydın içine son yükleme süresini koy). Fırtına testinde db sorgu sayısını ve p99'u tekil uçuş ve SWR ile karşılaştır.",
    "yaris.mjs'teki düzeltmeyi 'gecikmeli ikinci silme' yöntemiyle değiştir: Yazıcı sildikten 100 ms sonra bir kez daha silsin. Yarışın kapanıp kapanmadığını ve hangi durumda (okuyucu 100 ms'den daha yavaşsa) yine açıldığını göster."
  ]
}
```

## Özet

- Önbellek, pahalı işi tekrar etmemenin en ucuz yoludur. Zipf dağılımlı trafikte 1000 öğelik bir önbellek, aynı yükte p50'yi 1,5 saniyeden 0,5 ms'ye indirdi. İsabet oranı boyuta ve erişim dağılımına bağlıdır, ölç ve metrik olarak yayımla.
- Cache-aside varsayılan kalıptır. Süreç içi önbellek hızlıdır ama her kopyada ayrıdır. Paylaşılan önbellek tutarlıdır ama bir ağ gidiş-dönüşü ve bir bağımlılıktır. İkisi katmanlanabilir.
- Önbellek fırtınası: Tek bir anahtarın süre dolumu, 10 saniyede 414 sorguya yol açtı. Tekil uçuş bunu 5'e indirdi. SWR kullanıcı beklemesini de kaldırdı (p99 7,8 ms). TTL'e rastgelelik ve olasılıksal erken yenileme ekle.
- "Güncelle, sonra sil" yaklaşımı okuma-yazma yarışına açıktır. Çözümler: sürümlü ve atomik yazım (mezar taşı ile), gecikmeli ikinci silme, CDC ile geçersizleştirme. Kabul edilebilir bayatlığı açıkça belirle.
- Negatif önbellek, değer boyutu, kişiye özel veri ve önbellek kaybını planla. Veritabanı önbelleksiz yükü taşıyamıyorsa önbellek bir bağımlılıktır.
