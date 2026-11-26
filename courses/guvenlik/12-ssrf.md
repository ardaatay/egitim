# SSRF, dosya yükleme ve sunucu tarafı tuzaklar

Önceki dersin saldırıları kullanıcının tarayıcısını kullanıyordu. Bu derstekiler **sunucunun kendisini** silaha çevirir:

- **SSRF:** Sunucu, saldırganın seçtiği bir adrese istek atar.
- **Dosya yükleme:** Sunucu, saldırganın dosyasını saklar ve sunar.
- **Prototip kirliliği ve ReDoS:** JavaScript'in kendi dil özelliklerinden doğan iki sunucu tarafı tuzaktır.

## SSRF: sunucu adına istek

"Bağlantı önizleme", "webhook URL'si", "URL'den resim içe aktar", "PDF oluştur" ve "RSS ekle" gibi özelliklerin hepsinde sunucu, **kullanıcının verdiği bir URL'ye** istek atar. Bu isteği sunucu kendi ağ konumundan yapar. Yani istek internetten erişilemeyen yerlere ulaşabilir:

- **Bulut metadata servisi** (`169.254.169.254`): Makinenin IAM rolünün geçici erişim anahtarları buradadır. 2019'daki Capital One sızıntısı tam olarak bu zincirdi: bir WAF'taki SSRF, sonra metadata, sonra S3.
- **Küme içi servisler:** Kubernetes API'si, etcd, Redis, Elasticsearch ve kimlik doğrulaması olmayan yönetim panelleri ("iç ağda nasılsa").
- **`localhost` üzerindeki yönetim uçları:** Actuator, `/debug/pprof` ve Prometheus metrikleri.

### Deney

Tek bir süreç üç rol oynuyor:

- `127.0.0.1:3022` metadata servisini temsil ediyor.
- `127.0.0.1:3023`, saldırganın internetteki sunucusunu temsil ediyor. Bir yönlendirme de yapabiliyor.
- 3021 ve 3024, "önizleme" uç noktası olan uygulama. Biri açıklı, biri düzeltilmiş.

```js
// ssrf.mjs — AÇIKLI ÖRNEK: SSRF — sadece 127.0.0.1
import http from "node:http";
import net from "node:net";
import dns from "node:dns";

const IC = process.env.IC !== "0";   // iç/dış test servislerini yalnızca bir kopya başlatsın
// 1) "İç" servis: bulut metadata servisini temsil ediyor (gerçekte 169.254.169.254)
if (IC) http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ yol: req.url, AccessKeyId: "ASIAORNEK123", SecretAccessKey: "gizli/anahtar", Token: "..." }));
}).listen(3022, "127.0.0.1");

// 2) "Dış" site: bir yönlendirme yapıyor (saldırganın kontrolündeki sunucuyu temsil ediyor)
if (IC) http.createServer((req, res) => {
  if (req.url.startsWith("/yonlendir")) {
    res.writeHead(302, { location: "http://127.0.0.1:3022/latest/meta-data/iam/security-credentials/rol" });
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<title>Zararsız sayfa</title>");
}).listen(3023, "127.0.0.1");

// --- Güvenli istemci ---
const yasak = new net.BlockList();
yasak.addSubnet("127.0.0.0", 8);        // loopback
yasak.addSubnet("10.0.0.0", 8);         // özel ağlar
yasak.addSubnet("172.16.0.0", 12);
yasak.addSubnet("192.168.0.0", 16);
yasak.addSubnet("169.254.0.0", 16);     // link-local: bulut metadata
yasak.addSubnet("100.64.0.0", 10);      // CGNAT
yasak.addSubnet("0.0.0.0", 8);
yasak.addAddress("::1", "ipv6");
yasak.addSubnet("fc00::", 7, "ipv6");   // ULA
yasak.addSubnet("fe80::", 10, "ipv6");  // link-local

// BlockList, IPv4-eşlemeli IPv6 adreslerini (::ffff:7f00:1) IPv4 kurallarıyla da karşılaştırır
const adresYasakMi = (adres) => yasak.check(adres, net.isIPv6(adres) ? "ipv6" : "ipv4");

// Bağlantı anında çağrılır: DNS cevabı burada denetlenir (DNS rebinding'e karşı)
// Node 20+ (autoSelectFamily) lookup'ı { all: true } ile çağırır ve dizi bekler
function guvenliLookup(host, opts, cb) {
  dns.lookup(host, { ...opts, all: true }, (err, adresler) => {
    if (err) return cb(err);
    const yasakli = adresler.find((a) => adresYasakMi(a.address));   // biri bile yasaksa reddet
    if (yasakli) return cb(new Error(`yasak adres: ${host} -> ${yasakli.address}`));
    if (opts.all) return cb(null, adresler);
    cb(null, adresler[0].address, adresler[0].family);
  });
}

// Deneyde "internetteki site" rolünü 127.0.0.1:3023 oynuyor; gerçekte bu istisna olmaz
const disSiteMi = (u) => u.host === "127.0.0.1:3023";

function getir(hedef, guvenli, kalanYonlendirme = 3) {
  return new Promise((ok, red) => {
    let u;
    try { u = new URL(hedef); } catch { return red(new Error("geçersiz URL")); }
    if (guvenli) {
      if (!["http:", "https:"].includes(u.protocol)) return red(new Error(`şema yasak: ${u.protocol}`));
      const h = u.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(h) && adresYasakMi(h) && !disSiteMi(u))
        return red(new Error(`yasak adres: ${h}`));
    }
    const istek = http.get(u, guvenli && !disSiteMi(u) ? { lookup: guvenliLookup } : {}, (yanit) => {
      if (yanit.statusCode >= 300 && yanit.statusCode < 400 && yanit.headers.location) {
        yanit.resume();
        if (kalanYonlendirme === 0) return red(new Error("çok fazla yönlendirme"));
        const sonraki = new URL(yanit.headers.location, u).href;
        return getir(sonraki, guvenli, kalanYonlendirme - 1).then(ok, red);   // her adım yeniden denetlenir
      }
      let govde = ""; yanit.on("data", (d) => (govde += d)); yanit.on("end", () => ok(govde.slice(0, 300)));
    });
    istek.setTimeout(3000, () => istek.destroy(new Error("zaman aşımı")));
    istek.on("error", red);
  });
}

// 3) Uygulama: "bağlantı önizleme" uç noktası
const GUVENLI = process.env.GUVENLI === "1";
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/onizle") { res.writeHead(404); return res.end(); }
  try {
    const govde = await getir(url.searchParams.get("url") ?? "", GUVENLI);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ onizleme: govde }));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ hata: e.message }));
  }
}).listen(Number(process.env.PORT ?? 3021), "127.0.0.1");
```

```bash
PORT=3021 node ssrf.mjs &                    # açıklı uygulama + iç/dış test servisleri
PORT=3024 IC=0 GUVENLI=1 node ssrf.mjs &     # düzeltilmiş uygulama
```

Açıklı uygulamaya bir dizi URL gönderelim. İlki meşru, geri kalanı aynı iç servise farklı yazımlarla ulaşmaya çalışıyor:

```bash
for U in "http://127.0.0.1:3023/" \
         "http://127.0.0.1:3022/latest/meta-data/iam/security-credentials/rol" \
         "http://localhost:3022/" "http://2130706433:3022/" "http://0x7f.1:3022/" \
         "http://[::ffff:127.0.0.1]:3022/" "http://127.0.0.1:3023/yonlendir" \
         "file:///etc/passwd" "http://169.254.169.254/latest/meta-data/"; do
  echo "--- $U"; curl -s -G "http://127.0.0.1:3021/onizle" --data-urlencode "url=$U"; echo
done
```

```text
--- http://127.0.0.1:3023/
{"onizleme":"<title>Zararsız sayfa</title>"}
--- http://127.0.0.1:3022/latest/meta-data/iam/security-credentials/rol
{"onizleme":"{\"yol\":\"/latest/meta-data/iam/security-credentials/rol\",\"AccessKeyId\":\"ASIAORNEK123\",\"SecretAccessKey\":\"gizli/anahtar\",\"Token\":\"...\"}"}
--- http://localhost:3022/
{"onizleme":"{\"yol\":\"/\",\"AccessKeyId\":\"ASIAORNEK123\",...}"}
--- http://2130706433:3022/
{"onizleme":"{\"yol\":\"/\",\"AccessKeyId\":\"ASIAORNEK123\",...}"}
--- http://0x7f.1:3022/
{"onizleme":"{\"yol\":\"/\",\"AccessKeyId\":\"ASIAORNEK123\",...}"}
--- http://[::ffff:127.0.0.1]:3022/
{"onizleme":"{\"yol\":\"/\",\"AccessKeyId\":\"ASIAORNEK123\",...}"}
--- http://127.0.0.1:3023/yonlendir
{"onizleme":"{\"yol\":\"/latest/meta-data/iam/security-credentials/rol\",\"AccessKeyId\":\"ASIAORNEK123\",...}"}
--- file:///etc/passwd
{"hata":"Protocol \"file:\" not supported. Expected \"http:\""}
--- http://169.254.169.254/latest/meta-data/
{"hata":"connect ENETUNREACH 169.254.169.254:80"}
```

Bu çıktıda üç ders var:

1. **Adresin onlarca yazımı vardır.** `2130706433` (ondalık), `0x7f.1` (onaltılık ve kısaltılmış) ve `[::ffff:127.0.0.1]` (IPv4-eşlemeli IPv6) adreslerinin hepsi `127.0.0.1`'dir. WHATWG URL ayrıştırıcısı ilk ikisini normalleştirir:

   ```text
   http://2130706433:3022/ -> 127.0.0.1
   http://0x7f.1:3022/ -> 127.0.0.1
   http://[::ffff:127.0.0.1]:3022/ -> [::ffff:7f00:1]
   http://127.1:3022/ -> 127.0.0.1
   ```

   Bu yüzden **metin üzerinde** yapılan her kontrol (`if (url.includes("127.0.0.1"))`, `hostname === "localhost"`, regex ile IP denetimi) atlatılır. Kontrol, **bağlanılacak gerçek IP** üzerinde yapılmalıdır.
2. **Yönlendirme, kontrolü atlatır.** Saldırgan zararsız görünen kendi alan adını verir ve kontrolden geçer. Sunucu `302` ile iç adrese yönlendirir. Yönlendirmeyi kendiliğinden izleyen istemciler (`fetch` varsayılan olarak izler) her adımı yeniden denetlemez.
3. **Hata mesajı bir port tarayıcıdır.** `ENETUNREACH`, `ECONNREFUSED` ve zaman aşımı birbirinden ayırt edilebilir. Saldırgan önizleme uç noktasını kullanarak iç ağdaki hangi adreste hangi portun açık olduğunu haritalar. Yanıt gövdesi hiç dönmese bile (kör SSRF) bu ayrım ve yanıt süreleri yeterli bilgi verir.

Bu deneydeki tek koruma tesadüftür: Node'un `http` modülü `file:` şemasını desteklemiyor. `curl` tabanlı ya da çok protokollü kütüphaneler (`libcurl`, eski `request`, bazı PDF oluşturucular) `file://`, `gopher://` ve `dict://` şemalarını da destekler. `gopher://` ile Redis'e ya da SMTP'ye ham komut göndermek, SSRF'yi RCE'ye çevirmenin klasik yoludur.

### Düzeltme: gerçek IP üzerinde, bağlantı anında

Düzeltilmiş istemci dört şey yapıyor:

1. Şema izin listesi: sadece `http:` ve `https:`.
2. Host bir IP adresiyse, bu adres yasak aralıklar listesiyle (Node'un yerleşik `net.BlockList`'i) karşılaştırılır.
3. Host bir alan adıysa, kontrol **`lookup` kancasında**, yani soket açılmadan hemen önce, DNS'in döndürdüğü **her** adres üzerinde yapılır.
4. Yönlendirmeler elle izlenir ve her adım aynı denetimden geçer.

```bash
for U in ...aynı liste...; do curl -s -G "http://127.0.0.1:3024/onizle" --data-urlencode "url=$U"; echo; done
```

```text
--- http://127.0.0.1:3023/
{"onizleme":"<title>Zararsız sayfa</title>"}
--- http://127.0.0.1:3022/latest/meta-data/iam/security-credentials/rol
{"hata":"yasak adres: 127.0.0.1"}
--- http://localhost:3022/
{"hata":"yasak adres: localhost -> ::1"}
--- http://2130706433:3022/
{"hata":"yasak adres: 127.0.0.1"}
--- http://0x7f.1:3022/
{"hata":"yasak adres: 127.0.0.1"}
--- http://[::ffff:127.0.0.1]:3022/
{"hata":"yasak adres: ::ffff:7f00:1"}
--- http://127.0.0.1:3023/yonlendir
{"hata":"yasak adres: 127.0.0.1"}
--- file:///etc/passwd
{"hata":"şema yasak: file:"}
--- http://169.254.169.254/latest/meta-data/
{"hata":"yasak adres: 169.254.169.254"}
```

Yönlendirme durumunda ilk adım (`3023`) geçti, ikinci adım reddedildi. `localhost` için DNS önce `::1` döndürdü ve bu adres de yasak listesinde.

Kontrolün `lookup` kancasında olmasının nedeni **DNS rebinding**'dir. Saldırganın alan adı, düşük TTL ile ilk sorguda zararsız bir IP, ikinci sorguda `127.0.0.1` döndürebilir. "Önce çöz ve kontrol et, sonra URL'yi ver" yaklaşımında kontrol ilk cevabı, bağlantı ikinci cevabı görür (TOCTOU). Kontrol bağlantının kullandığı **aynı** çözümleme üzerinde yapılırsa, bu pencere kapanır.

> **Dikkat:** Bu kodu yazarken gerçek bir hata yaptık ve test yakaladı. Node 20'den beri `autoSelectFamily` varsayılan olarak açık olduğu için `lookup` kancası `{ all: true }` ile çağrılır ve bir **dizi** bekler. İlk sürüm tek adres döndürüyordu. Yasaklı adreslerde doğru şekilde hata veriyordu, ama **izinli** her adreste `Invalid IP address: undefined` ile bağlantı kuramıyordu. Güvenlik kontrolünü test ederken sadece "saldırı engellendi mi" sorusunu sorma. "Meşru istek hâlâ çalışıyor mu" sorusu da testin parçasıdır.

### Ağ katmanı: asıl savunma

Uygulama kodundaki kontrol gereklidir, ama tek katman olarak kırılgandır. Yeni bir kütüphane, bir PDF oluşturucunun içindeki tarayıcı ya da bir görüntü işleyicinin URL desteği bu kontrolü atlatabilir. Derinlemesine savunma şunları gerektirir:

- **Çıkış (egress) kısıtlaması:** Dışarıya istek atması gereken servisleri ayrı bir çıkış proxy'si üzerinden geçir. Proxy iç aralıkları reddeder. Kubernetes'te bu servislerin NetworkPolicy'si sadece proxy'ye çıkışa izin verir. Diğer pod'ların internete hiç çıkışı olmaz.
- **Metadata koruması:** AWS'de **IMDSv2**'yi zorunlu kıl (`HttpTokens=required`). v2'de önce bir `PUT` ile oturum jetonu alınır ve bu istek özel bir başlık ister. Basit SSRF'ler (`GET` ve yönlendirme) bu adımı yapamaz. Hop limitini 1 yaparsan, konteynerlerin içinden metadata servisine erişim de engellenir. GCP'de `Metadata-Flavor: Google` başlığı benzer bir rol oynar. Kubernetes'te metadata adresini NetworkPolicy ile pod'lara kapat, iş yükü kimliği için IRSA ya da Workload Identity kullan.
- **İç servislerde kimlik doğrulama:** "Sadece iç ağdan erişilir" bir kimlik doğrulama yöntemi **değildir**. SSRF, iç ağı dışarıya açan bir köprüdür. Redis'e parola koy, yönetim uçlarını ayrı bir porta al ve o portu dışarı açma.
- **Port izin listesi:** Sadece 80 ve 443 portlarına izin vermek, iç servislerin çoğunu (6379, 9200, 2379, 10250) kapsam dışında bırakır.

## Dosya yükleme

Yüklenen dosya üç yerde tehlikelidir: **adında**, **içeriğinde** ve **sunulma biçiminde**.

| Risk | Örnek | Önlem |
|---|---|---|
| Ad: dizin geçişi | `../../views/index.html` | Diskteki adı sunucu üretir (UUID). Kullanıcının verdiği ad sadece görüntüleme için ve `basename` ile saklanır |
| Ad: uzantı | `kabuk.php`, `x.jsp`. Sunucu uzantıya göre çalıştırıyorsa doğrudan RCE | Uzantıyı içerikten belirle. Yükleme dizini hiçbir zaman çalıştırılabilir değil |
| İçerik: tür sahteciliği | `Content-Type: image/png` ama içerik SVG/HTML | Türü içeriğin ilk baytlarından (magic bytes) belirle. İzin listesi kullan |
| İçerik: SVG | `<svg><script>`. Aynı origin'den sunulursa saklanan XSS | SVG'yi kabul etme ya da rasterleştir. Ayrı alan adından ve `attachment` olarak sun |
| İçerik: ayrıştırıcı açıkları | ImageMagick ve ghostscript açıkları, XML'de XXE, ZIP bombası | Ayrıştırmayı izole bir işte yap (ayrı konteyner, kaynak limiti). XML'de harici varlıkları kapat |
| Boyut | 10 GB'lık gövde, disk ve bellek tükenir | Ters vekilde ve uygulamada üst sınır (`client_max_body_size`), akışla işleme |

Türü içerikten belirleyen küçük bir kontrol:

```js
// yukle.mjs — yüklenen dosyanın türünü ada/Content-Type'a değil içeriğin ilk baytlarına göre belirle
import crypto from "node:crypto";
import path from "node:path";

const IMZALAR = [
  { tur: "image/png",  uzanti: ".png", bayt: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { tur: "image/jpeg", uzanti: ".jpg", bayt: [0xff, 0xd8, 0xff] },
  { tur: "application/pdf", uzanti: ".pdf", bayt: [0x25, 0x50, 0x44, 0x46, 0x2d] },   // %PDF-
];
const ENFAZLA = 5 * 1024 * 1024;

function kabulEt(dosyaAdi, beyanTuru, icerik) {
  if (icerik.length > ENFAZLA) return { red: "dosya çok büyük" };
  const imza = IMZALAR.find((i) => i.bayt.every((b, k) => icerik[k] === b));
  if (!imza) return { red: `bilinmeyen içerik (ad: ${dosyaAdi}, beyan: ${beyanTuru})` };
  // kullanıcının verdiği ad sadece görüntüleme için saklanır; diskteki ad rastgele
  const kayitAdi = crypto.randomUUID() + imza.uzanti;
  return { kayitAdi, tur: imza.tur, gorunenAd: path.basename(dosyaAdi).slice(0, 100) };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
const html = Buffer.from("<html><script>fetch('/api/profil')</script>");

console.log(kabulEt("logo.png", "image/png", png));
console.log(kabulEt("logo.png", "image/png", svg));
console.log(kabulEt("../../views/index.html", "image/jpeg", html));
console.log(kabulEt("../../avatar.png", "image/png", png));
```

```text
{ kayitAdi: '04fca8cd-30fc-4ac2-817e-79d91a0e225f.png', tur: 'image/png', gorunenAd: 'logo.png' }
{ red: 'bilinmeyen içerik (ad: logo.png, beyan: image/png)' }
{ red: 'bilinmeyen içerik (ad: ../../views/index.html, beyan: image/jpeg)' }
{ kayitAdi: '3b0a5533-ef6a-4f36-a562-f9f9496d347a.png', tur: 'image/png', gorunenAd: 'avatar.png' }
```

Magic bytes kontrolü gereklidir, ama "bu dosya zararsız" demek değildir. Geçerli bir PNG başlığının arkasına HTML eklenebilir (poliglot dosya). Asıl önlem **sunma biçimidir**:

- Kullanıcı dosyalarını **ayrı bir alan adından** sun. `ornek-kullanici-icerik.com` gibi bir alan adı **farklı site** olur, böylece XSS uygulamanın çerezlerine ulaşamaz. `cdn.ornek.com` ise aynı site sayılır, SameSite açısından yetersizdir.
- Yanıtta `X-Content-Type-Options: nosniff` ve doğru `Content-Type` başlıklarını gönder. Görüntü olmayan her şeyi `Content-Disposition: attachment` ile sun.
- Nesne deposundan (S3, MinIO) kısa ömürlü imzalı URL'lerle sun. Uygulama sunucusu dosya içeriğine hiç dokunmaz.
- Görüntüleri **yeniden kodla** (decode ve yeniden encode). Bu, poliglotları ve EXIF meta verisini (konum bilgisi) temizler.

## Prototip kirliliği

JavaScript'te her nesne zincirin sonunda `Object.prototype`'tan miras alır. Saldırgan bir yolla `Object.prototype`'a özellik yazabilirse, o özellik **süreçteki bütün nesnelerde** görünür. Bu genellikle kullanıcı JSON'unu yinelemeli olarak birleştiren bir "derin birleştirme" (deep merge) fonksiyonuyla olur:

```js
// proto.mjs — saf bir "derin birleştirme": birçok yapılandırma/ayar kodunda bulunan kalıp
function birlestir(hedef, kaynak) {
  for (const anahtar of Object.keys(kaynak)) {
    if (typeof kaynak[anahtar] === "object" && kaynak[anahtar] !== null) {
      if (typeof hedef[anahtar] !== "object" || hedef[anahtar] === null) hedef[anahtar] = {};
      birlestir(hedef[anahtar], kaynak[anahtar]);
    } else hedef[anahtar] = kaynak[anahtar];
  }
  return hedef;
}

function birlestirGuvenli(hedef, kaynak) {
  for (const anahtar of Object.keys(kaynak)) {
    if (anahtar === "__proto__" || anahtar === "constructor" || anahtar === "prototype") continue;
    const d = kaynak[anahtar];
    if (typeof d === "object" && d !== null) {
      if (!Object.hasOwn(hedef, anahtar) || typeof hedef[anahtar] !== "object") hedef[anahtar] = {};
      birlestirGuvenli(hedef[anahtar], d);
    } else hedef[anahtar] = d;
  }
  return hedef;
}

const istekGovdesi = '{"tema": "koyu", "__proto__": {"admin": true}}';   // kullanıcının PATCH /ayarlar gövdesi
const govde = JSON.parse(istekGovdesi);
console.log("JSON.parse sonucu kendi anahtarları:", Object.keys(govde));

const yetkiKontrol = (kullanici) => (kullanici.admin ? "YÖNETİCİ" : "normal");
const baskaKullanici = { ad: "mehmet" };
console.log("önce  :", yetkiKontrol(baskaKullanici));

birlestir({}, govde);                 // ayse'nin ayarları birleştirildi
console.log("sonra :", yetkiKontrol(baskaKullanici), "| ({}).admin =", ({}).admin);

delete Object.prototype.admin;
birlestirGuvenli({}, JSON.parse(istekGovdesi));
console.log("güvenli birleştirme sonrası:", yetkiKontrol(baskaKullanici), "| ({}).admin =", ({}).admin);

const sozluk = Object.create(null);
console.log("Object.create(null) sözlükte toString:", sozluk.toString, "| 'admin' in sozluk:", "admin" in sozluk);
```

```bash
node proto.mjs
```

```text
JSON.parse sonucu kendi anahtarları: [ 'tema', '__proto__' ]
önce  : normal
sonra : YÖNETİCİ | ({}).admin = true
güvenli birleştirme sonrası: normal | ({}).admin = undefined
Object.create(null) sözlükte toString: undefined | 'admin' in sozluk: false
```

Mekanizma şöyle işliyor:

1. `JSON.parse`, `__proto__` anahtarını sıradan bir **kendi özelliği** olarak oluşturur. Bu kendi başına zararsızdır.
2. `birlestir` fonksiyonu `hedef["__proto__"]` ifadesini okur. Bu, hedefin prototipini, yani `Object.prototype`'ı döndürür.
3. Fonksiyon ardından bu nesneye `admin = true` yazar.

Artık `ayse`'nin ayar isteği, **mehmet'i** (ve sürecin geri kalanındaki her nesneyi) yönetici yapmıştır. Gerçek etkiler şunlardır:

- **Yetki atlatma:** `if (kullanici.isAdmin)` gibi kontroller.
- **Hizmet dışı bırakma:** `toString`'i ezmek her şeyi kırar.
- **RCE:** `child_process.spawn` seçeneklerindeki `shell` ya da `env` gibi alanlar, kendi değeri verilmemiş nesnelerde prototipten okunur. Lodash `merge` (CVE-2018-16487) ve `minimist` gibi yaygın paketlerde bu sınıftan açıklar çıktı.

Önlemler:

- Birleştirme ve kopyalama fonksiyonlarında `__proto__`, `constructor` ve `prototype` anahtarlarını atla ya da hazır ve güncel bir kütüphane kullan.
- Kullanıcı verisini yapılandırmayla **birleştirme**. Gövdeyi bir şemayla doğrula (Zod, Ajv: `additionalProperties: false`). Böylece beklenmeyen anahtar hiç içeri girmez.
- Anahtarları kullanıcıdan gelen sözlükler için `Map` ya da `Object.create(null)` kullan.
- `node --disable-proto=delete` (ya da `=throw`) bayrağı, `__proto__` erişimcisini kaldırır. Bu bir derinlemesine savunma katmanıdır.

## ReDoS: tek istekle CPU'yu kilitlemek

Node.js tek iş parçacıklı bir olay döngüsüyle çalışır. Bir istekte 5 saniye süren senkron bir işlem, o 5 saniye boyunca **bütün** istekleri durdurur. Geri izlemeli (backtracking) regex motorları, iç içe niceleyicili kalıplarda (`(a+)*`, `(a|aa)+`) eşleşmeyen girdi karşısında üstel sayıda yol dener:

```js
// redos.mjs — kullanıcının e-posta alanını doğrulayan, iç içe niceleyicili bir regex
const kotu = /^([a-zA-Z0-9]+)*@ornek\.com$/;
const iyi  = /^[a-zA-Z0-9]+@ornek\.com$/;
for (const n of [24, 28, 30, 32, 34]) {
  const girdi = "a".repeat(n) + "!";
  let t = performance.now(); kotu.test(girdi); const tk = performance.now() - t;
  t = performance.now(); iyi.test(girdi); const ti = performance.now() - t;
  console.log(`n=${n}  kötü: ${tk.toFixed(1).padStart(8)} ms   iyi: ${ti.toFixed(3)} ms`);
}
```

```text
n=24  kötü:      6.1 ms   iyi: 0.030 ms
n=28  kötü:     10.8 ms   iyi: 0.036 ms
n=30  kötü:     45.6 ms   iyi: 0.002 ms
n=32  kötü:    172.4 ms   iyi: 0.002 ms
n=34  kötü:    711.1 ms   iyi: 0.002 ms
```

Her iki karakter, süreyi yaklaşık dört katına çıkarıyor. 40 karakterlik bir girdi dakikalar sürer. İki kalıp aynı dili tanıyor, ama ikincisinde belirsizlik yok, yani motorun deneyeceği tek bir yol var. Önlemler:

- İç içe niceleyicilerden ve örtüşen alternatiflerden kaçın. `eslint-plugin-regexp` ve `safe-regex` gibi araçlar bu kalıpları statik olarak bulur.
- Regex'ten önce **uzunluk sınırı** koy. 254 karakterden uzun bir e-posta adresi zaten geçersizdir.
- Doğrusal zamanlı bir motor kullan. V8'in deneysel motoru `l` bayrağıyla açılır. Aynı kötü kalıp bu motorla anında biter:

  ```bash
  node --enable-experimental-regexp-engine redos2.mjs   # /^([a-zA-Z0-9]+)*@ornek\.com$/l, n=34
  ```

  ```text
  false 0.040 ms
  ```

  Üretimde daha yaygın seçenek, RE2 bağlayıcısıdır (`re2` paketi). Geri başvuru (backreference) gibi bazı özellikleri desteklemez, bunun karşılığında doğrusal süreyi garanti eder.
- Ağır, senkron işleri (büyük JSON ayrıştırma, görüntü işleme, karmaşık regex) `worker_threads`'e taşı ve bir zaman aşımı koy. Böylece olay döngüsü kilitlenmez.

```quiz
{
  "question": "Bir webhook özelliği, URL'yi aldıktan sonra `dns.lookup` ile çözüp IP'yi yasak aralıklara karşı kontrol ediyor, sonra `fetch(url)` çağırıyor. Bu yaklaşımın açığı ne?",
  "options": [
    "Yok. IP kontrol edildiği için iç adreslere ulaşılamaz.",
    "fetch alan adını yeniden çözer. DNS rebinding ile ikinci çözüm iç adresi döndürebilir. Ayrıca fetch yönlendirmeleri kendiliğinden izler ve sonraki adımları denetlemez.",
    "dns.lookup IPv6 döndürmez, bu yüzden IPv6 adresleri kontrol edilmez.",
    "Sadece performans sorunu var: iki kez DNS sorgusu yapılır."
  ],
  "answer": 1,
  "explanation": "Kontrol ile bağlantı farklı çözümlemeleri kullanır (TOCTOU). Kontrol, bağlantının kullandığı çözümleme üzerinde yapılmalıdır (lookup kancası ya da IP'ye sabitlenmiş bağlantı). Yönlendirmeler de elle izlenip her adımda yeniden denetlenmelidir (redirect: 'manual')."
}
```

```quiz
{
  "question": "Profil fotoğrafları `https://ornek.com/uploads/<kullanıcının dosya adı>` adresinden, yüklenirken gelen Content-Type ile sunuluyor. Ekip sadece 'dosya uzantısı .png/.jpg olmalı' kontrolünü yapıyor. En ciddi risk hangisi?",
  "options": [
    "Dosyalar çok büyük olabilir.",
    "Saldırgan `x.png` adıyla ve `text/html` Content-Type'ıyla HTML/SVG yükler. Dosya uygulamanın origin'inden sunulduğu için saklanan XSS olur. Ayrıca dosya adı yolun içinde kullanıldığı için dizin geçişi riski de var.",
    "PNG dosyaları EXIF verisi içerebilir.",
    "Uzantı kontrolü yeterli. Tarayıcılar .png uzantılı dosyayı her zaman resim olarak gösterir."
  ],
  "answer": 1,
  "explanation": "Tarayıcı uzantıya değil Content-Type başlığına (ve nosniff yoksa içeriğe) bakar. Türü içerikten belirle, diskteki adı sunucuda üret, nosniff ile doğru türü gönder, dosyaları ayrı bir siteden ve gerekirse attachment olarak sun."
}
```

```lab
{
  "title": "SSRF savunmasını sına",
  "steps": [
    "ssrf.mjs'i iki kopya olarak başlat ve yukarıdaki URL listesini her ikisine de gönder. Açıklı kopyada iç servise ulaşan her yazımı not et.",
    "Açıklı kopyaya `http://127.0.0.1:3022/` ve `http://127.0.0.1:1/` (kapalı port) gönder. Hata mesajlarının ve yanıt sürelerinin farkına bakarak bunun nasıl bir port tarayıcısına dönüştüğünü gözlemle.",
    "Düzeltilmiş getir() fonksiyonundaki `lookup` kancasını kaldır ve kontrolü 'önce dns.lookup ile çöz, sonra bağlan' biçiminde yeniden yaz. Bu yazım neden DNS rebinding'e açık? Bir zaman çizelgesiyle açıkla.",
    "guvenliLookup'ı `{ ...opts, all: false }` ile tek adres döndürecek şekilde değiştir ve meşru `http://127.0.0.1:3023/` önizlemesinin neden hâlâ çalıştığını bul (ipucu: disSiteMi istisnası lookup'ı devre dışı bırakıyor). Sonra kendi makinende izinli bir alan adı için kancanın çağrıldığı bir test yaz ve `Invalid IP address: undefined` hatasını yeniden üret.",
    "proto.mjs'i `node --disable-proto=throw proto.mjs` ile çalıştır ve hangi satırın hata verdiğine bak. Ardından birleştirme yerine bir şema doğrulamasıyla (izin verilen anahtarlar: tema, dil) aynı işi yap."
  ]
}
```

## Özet

- SSRF, sunucunun ağ konumunu saldırgana kiralar. Metadata servisi, küme içi servisler ve localhost yönetim uçları hedeftir.
- Adresin onlarca yazımı vardır (ondalık, onaltılık, IPv4-eşlemeli IPv6, DNS). Metin üzerindeki kontrol atlatılır. Kontrolü **bağlanılan gerçek IP** üzerinde, bağlantı anında (`lookup` kancası) yap. Yönlendirmeleri elle izle ve her adımı yeniden denetle.
- Uygulama kontrolüne ek katmanlar: çıkış proxy'si ve NetworkPolicy, IMDSv2 (`HttpTokens=required`, hop limiti 1), iç servislerde kimlik doğrulama, port izin listesi.
- Güvenlik kontrolünü test ederken meşru yolu da test et. `lookup` kancasının `all: true` hatasını izinli istek yakaladı.
- Dosya yükleme: Ad sunucuda üretilir, tür içerikten belirlenir, dosya ayrı bir siteden `nosniff` ve gerekirse `attachment` ile sunulur. Ayrıştırma işi izole edilir.
- Prototip kirliliği: Derin birleştirmede `__proto__`/`constructor` anahtarlarını atla. Kullanıcı verisini şemayla doğrula. Sözlükler için `Map` ya da `Object.create(null)` kullan.
- ReDoS: Tek iş parçacıklı olay döngüsünde bir regex bütün servisi durdurur. İç içe niceleyicilerden kaçın, uzunluk sınırı koy, doğrusal bir motor (RE2, V8'in `l` bayrağı) ya da `worker_threads` kullan.
