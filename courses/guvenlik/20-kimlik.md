# Kimlik doğrulama: parolalar, oturumlar, JWT ve MFA

Kimlik doğrulama tek bir soruyu cevaplar: "Bu istek **kimden** geliyor?" Cevabın yanlış olması, sonraki bütün kontrolleri (yetkilendirme, denetim kaydı, kota) anlamsız kılar. Bu derste uçtan uca ele alacağımız konular:

- parolanın nasıl saklandığı
- girişin nasıl doğrulandığı
- oturumun nasıl taşındığı
- ikinci faktörün nasıl eklendiği

Her biri için Node'un yerleşik `crypto` modülüyle çalışan örneklerimiz var.

## Parola saklama

Veritabanı bir gün sızar. Bu bir SQL enjeksiyonu, bir yedek dosyası ya da bir çalışanın dizüstü bilgisayarı olabilir. Parola saklamanın amacı, sızıntıdan sonra saldırganın **parolaları geri elde etmesini** pahalı hale getirmektir. Saldırgan elindeki hash'lere karşı çevrimdışı tahmin yapar. Bu yüzden tek ölçü, bir tahminin **kaç kaynağa** mal olduğudur:

```js
// parola.mjs — hızlı hash, scrypt ve argon2id karşılaştırması (Node 24)
import crypto from "node:crypto";

const parola = "Yaz2026!";
const tuz = crypto.randomBytes(16);

function sure(ad, fn, n = 1) {
  const t = performance.now();
  for (let i = 0; i < n; i++) fn();
  const ms = (performance.now() - t) / n;
  console.log(`${ad.padEnd(34)} ${ms.toFixed(3).padStart(9)} ms/deneme  ->  saniyede ~${Math.round(1000 / ms).toLocaleString("tr-TR")} deneme (tek çekirdek)`);
}

sure("sha256(tuz+parola)", () => crypto.createHash("sha256").update(tuz).update(parola).digest(), 20000);
sure("scrypt N=2^17 r=8 p=1 (128 MiB)", () => crypto.scryptSync(parola, tuz, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }), 3);
sure("argon2id m=19 MiB t=2 p=1", () => crypto.argon2Sync("argon2id", { message: parola, nonce: tuz, parallelism: 1, tagLength: 32, memory: 19456, passes: 2 }), 5);
```

```text
sha256(tuz+parola)                     0.002 ms/deneme  ->  saniyede ~539.107 deneme (tek çekirdek)
scrypt N=2^17 r=8 p=1 (128 MiB)      245.243 ms/deneme  ->  saniyede ~4 deneme (tek çekirdek)
argon2id m=19 MiB t=2 p=1             24.760 ms/deneme  ->  saniyede ~40 deneme (tek çekirdek)
```

Bu rakamlar tek bir CPU çekirdeğinde, JavaScript'in çağrı maliyeti de dahil olarak ölçüldü. Bir GPU, tuzlu SHA-256 ile saniyede **milyarlarca** tahmin yapar. "Tuz kullanıyoruz" demek yetmez:

- Tuz, aynı parolaların aynı hash'i üretmesini ve hazır tabloların (rainbow table) kullanılmasını engeller.
- Tuz, her tahminin maliyetini **artırmaz**.

Maliyeti artıran şey **bellek-yoğun** bir fonksiyondur. argon2id ve scrypt her tahmin için megabaytlarca belleğe rastgele erişim gerektirir. GPU'nun binlerce çekirdeği bu belleği paylaşamadığı için paralellik avantajı çöker.

| Algoritma | Öneri (OWASP, 2025) | Not |
|---|---|---|
| **argon2id** | m=19 MiB, t=2, p=1 (en az). Bellek varsa m=46 MiB, t=1 | İlk tercih. Node 24'te `crypto.argon2Sync`/`argon2` yerleşik |
| scrypt | N=2^17, r=8, p=1 | Yerleşik (`crypto.scrypt`), FIPS gerekmiyorsa iyi |
| bcrypt | maliyet ≥ 10 | Girdinin **ilk 72 baytını** kullanır, fazlasını sessizce atar. Eski sistemler için |
| PBKDF2-HMAC-SHA256 | ≥ 600.000 yineleme | Sadece FIPS zorunluysa. Bellek-yoğun değildir |
| MD5, SHA-1, SHA-256 (tek başına) | asla | Hız burada bir kusurdur |

Parametreleri **sunucunun gerçek kapasitesine göre** ayarla. Giriş uç noktası her istekte bu işi yapar. Saniyede 100 giriş alan bir servis argon2id m=19 MiB ile 100 × 25 ms = 2,5 CPU-saniye harcar ve anlık 2 GB bellek kullanır. Bu, aynı zamanda bir **hizmet dışı bırakma** yüzeyidir, yani giriş uç noktasında hız sınırlama zorunludur (aşağıda).

### Saklama biçimi ve yükseltme

Hash, algoritma ve parametreleriyle birlikte tek bir PHC dizgesi olarak saklanır. Bu sayede parametreler sonradan değiştirildiğinde eski kayıtlar hâlâ doğrulanabilir:

```js
// Saklama biçimi (PHC dizgesi): algoritma ve parametreler hash'in yanında durur
const b64 = (b) => b.toString("base64").replace(/=+$/, "");
function hashle(p) {
  const s = crypto.randomBytes(16);
  const h = crypto.argon2Sync("argon2id", { message: p, nonce: s, parallelism: 1, tagLength: 32, memory: 19456, passes: 2 });
  return `$argon2id$v=19$m=19456,t=2,p=1$${b64(s)}$${b64(h)}`;
}
function dogrula(p, kayit) {
  const [, alg, , param, s, h] = kayit.split("$");
  const o = Object.fromEntries(param.split(",").map((x) => x.split("=")));
  const beklenen = Buffer.from(h, "base64");
  const hesap = crypto.argon2Sync(alg, { message: p, nonce: Buffer.from(s, "base64"), parallelism: +o.p, tagLength: beklenen.length, memory: +o.m, passes: +o.t });
  return crypto.timingSafeEqual(hesap, beklenen);
}
const kayit = hashle(parola);
console.log("\nkayıt :", kayit);
console.log("doğru parola:", dogrula(parola, kayit), "| yanlış parola:", dogrula("yaz2026!", kayit));
console.log("aynı parola iki kez hashlenince aynı mı?", hashle(parola) === hashle(parola));
```

```text
kayıt : $argon2id$v=19$m=19456,t=2,p=1$uxY0jW4iLWthRO+Gs0CGbg$oZBOkRe0Rf7laSP0PZyNwPgH/6CNFxns5vM82SVUOP0
doğru parola: true | yanlış parola: false
aynı parola iki kez hashlenince aynı mı? false
```

Eski bir şemadan (örneğin tuzsuz SHA-1) geçiş iki yolla yapılır:

1. **Girişte yeniden hashleme:** Kullanıcı başarılı giriş yaptığında, parola o an elde olduğundan yeni algoritmayla hashlenir ve kayıt güncellenir. Kayıttaki parametreler güncel değerlerden zayıfsa, aynı yükseltme yine girişte yapılır.
2. **Sarmalama:** Hiç giriş yapmayan kullanıcıların eski hash'leri beklemeden korunur: `argon2id(sha1(parola))`. Doğrulamada önce `sha1`, sonra `argon2id` uygulanır. Sızıntı anında hiçbir kayıt zayıf biçimde kalmaz.

**Biber (pepper)**, veritabanında değil gizli bilgi kasasında (ya da HSM'de) duran ve bütün hash'lere eklenen bir anahtardır. Genellikle hash'in üzerine bir HMAC olarak uygulanır. Sadece veritabanı sızarsa, saldırgan biber olmadan çevrimdışı tahmin **yapamaz**. Biberin bedeli anahtar yönetimidir: döndürme ve yedekleme. Sır yönetimi dersinde tekrar karşımıza çıkacak.

### Parola politikası

NIST SP 800-63B'nin güncel sürümü, sezgiye ters gelen ama ölçülmüş kurallar koyar:

- **Uzunluk** önemlidir, **bileşim kuralları** (büyük harf, rakam, sembol zorunluluğu) önemli değildir. Bu kurallar `Yaz2026!` gibi tahmin edilebilir kalıplar üretir. Parola tek faktörse en az 15, MFA'nın bir parçasıysa en az 8 karakter istenir. En az 64 karakter kabul edilmelidir. Boşluk ve Unicode'a izin verilir.
- **Periyodik zorunlu değişiklik yok.** Sadece sızıntı şüphesinde değiştirilir.
- Yeni parola **sızmış parola listelerine** karşı kontrol edilir. "Have I Been Pwned" API'si k-anonimlik kullanır: SHA-1'in ilk 5 karakteri gönderilir, dönen listede yerel olarak aranır. Parolanın kendisi hiçbir zaman servise gitmez.
- Parola yöneticilerinin çalışması engellenmez (yapıştırma serbest).

## Girişi doğrulamak

### Kullanıcı numaralandırma

"Kullanıcı bulunamadı" ve "parola yanlış" diye iki farklı mesaj, saldırgana hangi e-postaların kayıtlı olduğunu söyler. Mesajları aynı yapmak da yetmez, çünkü **yanıt süresi** de konuşur:

```js
// zamanlama.mjs — kullanıcı numaralandırma: yanıt süresi kullanıcının var olup olmadığını söylüyor
const SAHTE = { tuz: crypto.randomBytes(16), hash: crypto.randomBytes(32) };   // var olmayan kullanıcı için

function girisKotu(eposta, parola) {
  const k = kullanicilar.get(eposta);
  if (!k) return false;                                   // erken dönüş: hash hiç hesaplanmıyor
  return crypto.timingSafeEqual(h(parola, k.tuz), k.hash);
}
function girisIyi(eposta, parola) {
  const k = kullanicilar.get(eposta) ?? SAHTE;            // her durumda aynı iş yapılır
  const ok = crypto.timingSafeEqual(h(parola, k.tuz), k.hash);
  return ok && k !== SAHTE;
}
```

```text
kötü: var olan kullanıcı  25.48 ms | olmayan kullanıcı   0.00 ms
iyi : var olan kullanıcı  24.94 ms | olmayan kullanıcı  25.55 ms
```

Kötü sürümde fark 25 ms'dir. Bu fark ağ gürültüsünün çok üstündedir ve tek bir istekle bile ölçülebilir. İyi sürüm, var olmayan kullanıcı için de bir hash hesaplar. Aynı dikkat diğer akışlar için de gerekir:

- **Kayıt:** "Bu e-posta zaten kullanılıyor" mesajı da numaralandırma kanalıdır. Mesaj yerine "doğrulama e-postası gönderdik" de. E-posta zaten kayıtlıysa, adrese "hesabınız zaten var" bildirimi gönder.
- **Parola sıfırlama:** Yanıt her zaman aynı olmalı: "Bu adres kayıtlıysa bir bağlantı gönderdik."

### Kaba kuvvet ve credential stuffing

Çevrimiçi saldırılar iki biçimde gelir:

- **Kaba kuvvet:** Tek hesap, çok parola.
- **Credential stuffing:** Başka sitelerden sızan e-posta ve parola çiftleri, çok hesap üzerinde, her biri bir kez. Bu saldırıda hesap başına sayaç hiç tetiklenmez.

Savunma katmanlı olur:

- **Hesap başına** ve **IP/ağ başına** hız sınırlama. Sabit kilitlemek ("5 hatada 24 saat kilit") yerine artan gecikme uygula. Sabit kilitleme saldırgana, kurbanı hesabından atma imkânı verir.
- **Genel anormallik:** Toplam başarısız giriş oranı ve yeni cihaz ya da ülkeden gelen başarılı girişler bir alarm kaynağıdır. Credential stuffing tek tek isteklerde değil, toplamda görünür.
- Sızmış parola kontrolünü girişte de yap. Kullanıcıyı parola değiştirmeye yönlendir.
- **MFA:** Credential stuffing'i neredeyse tamamen etkisiz bırakır.

Hız sınırlamanın yeri, birden fazla uygulama kopyasının ortak gördüğü bir sayaçtır (Redis). Bellekte tutulan bir sayaç, 10 pod'lu bir dağıtımda sınırı 10 katına çıkarır. Bunun uygulaması Yüksek Trafik kursunda.

## Oturumlar

Giriş başarılı olduktan sonra kimlik bir **oturum** ile taşınır. İki model var:

| | Sunucu tarafı oturum (opak kimlik) | Kendi kendini taşıyan jeton (JWT) |
|---|---|---|
| Çerezdeki değer | 128 bit rastgele kimlik | İmzalı JSON (kimlik, rol, süre) |
| Doğrulama | Depoya (Redis/DB) sorgu | İmza kontrolü, depo yok |
| İptal | Kaydı sil: anında | Süresi dolana kadar **geçerli**. İptal listesi gerekir (ki bu da bir depo demek) |
| Rol değişikliği | Bir sonraki istekte geçerli | Jeton yenilenene kadar eski rol |
| Uygun yer | Tarayıcı oturumları | Servisler arası, kısa ömürlü erişim jetonları (OAuth) |

Tarayıcı oturumu için varsayılan tercih, `HttpOnly; Secure; SameSite=Lax` bir çerezde opak oturum kimliğidir. "Durumsuz olsun" diye tarayıcı oturumunu JWT'ye taşımak, iptali kaybettirir ve çoğu zaman jetonu `localStorage`'a taşır. Bunun bedeli XSS dersinde gördüğümüz jeton hırsızlığıdır.

Oturum yönetiminin kuralları:

- **Girişte yeni kimlik (session fixation):** Giriş öncesi verilen oturum kimliği giriş sonrasında da kullanılırsa, saldırgan kurbana önceden bildiği bir kimliği verebilir (örneğin URL parametresiyle) ve kurban giriş yaptıktan sonra aynı kimlikle oturuma girebilir. Ayrıcalık değişen her an kimliği yenile: giriş, MFA tamamlanması, rol yükseltme.
- **Zaman aşımları:** Boşta kalma süresi (örneğin 30 dakika) ve mutlak süre (örneğin 12 saat).
- **Çıkış sunucu tarafında yapılır.** Çerezi silmek yetmez, kayıt depodan silinir. "Bütün cihazlardan çık" ve parola değişikliği, kullanıcının bütün oturumlarını iptal eder.
- Oturum kimliği **loglanmaz**. Loglanması gerekiyorsa, bir hash'i loglanır.

## JWT doğrulama hataları

JWT; başlık, gövde ve imza olmak üzere base64url ile kodlanmış ve noktayla ayrılmış üç parçadır. Kütüphaneler yıllarca iki temel hatayı tekrar etti. İkisinin de kökü aynı: **Doğrulayıcı, hangi algoritmayla doğrulayacağını jetonun kendisine soruyor.**

```js
// jwt.mjs — KÖTÜ: algoritmayı jetonun kendi başlığından okuyor ve "anahtar"ı her algoritmaya veriyor
function dogrulaKotu(jeton, anahtar) {
  const [bas, govde, imza] = jeton.split(".");
  const { alg } = JSON.parse(Buffer.from(bas, "base64url"));
  const veri = Buffer.from(`${bas}.${govde}`);
  let gecerli;
  if (alg === "none") gecerli = true;
  else if (alg === "HS256") gecerli = crypto.createHmac("sha256", anahtar).update(veri).digest("base64url") === imza;
  else if (alg === "RS256") gecerli = crypto.verify("sha256", veri, anahtar, Buffer.from(imza, "base64url"));
  if (!gecerli) throw new Error("imza geçersiz");
  return JSON.parse(Buffer.from(govde, "base64url"));
}

// Saldırı 1: alg=none, imza boş
const sahte1 = `${b64u({ alg: "none", typ: "JWT" })}.${b64u({ sub: "mehmet", rol: "admin" })}.`;

// Saldırı 2: alg=HS256, HMAC anahtarı olarak herkese açık PEM kullanılıyor
const bas2 = b64u({ alg: "HS256", typ: "JWT" }), govde2 = b64u({ sub: "mehmet", rol: "admin", exp: simdi + 600 });
const imza2 = crypto.createHmac("sha256", PUBLIC_PEM).update(`${bas2}.${govde2}`).digest("base64url");
```

```text
gerçek jeton (kötü doğrulayıcı): developer
alg=none        (kötü): admin
RS256→HS256     (kötü): admin
```

- **`alg: none`:** JWT standardı imzasız jetonlara izin verir. Bu seçeneği kabul eden bir doğrulayıcı, imzayı hiç kontrol etmeden her şeyi kabul eder.
- **Algoritma karışıklığı:** Sunucu RS256 jetonları bekliyor ve doğrulama için **herkese açık** anahtarı kullanıyor. Saldırgan başlığı `HS256` yapar ve aynı herkese açık anahtarı (JWKS'ten indirilebilir) HMAC **sırrı** olarak kullanıp imzalar. Doğrulayıcı da "anahtar" diye aynı PEM'i HMAC'e verir ve imza tutar.

Düzeltilmiş doğrulayıcı algoritmayı sabitler ve iddiaları kontrol eder:

```js
// İYİ: beklenen algoritma sabit, iddialar (exp, iss, aud) kontrol ediliyor
function dogrula(jeton, { iss, aud }) {
  const parcalar = jeton.split(".");
  if (parcalar.length !== 3) throw new Error("biçim");
  const [bas, govde, imza] = parcalar;
  const b = JSON.parse(Buffer.from(bas, "base64url"));
  if (b.alg !== "RS256") throw new Error(`beklenmeyen alg: ${b.alg}`);
  if (!crypto.verify("sha256", Buffer.from(`${bas}.${govde}`), publicKey, Buffer.from(imza, "base64url")))
    throw new Error("imza geçersiz");
  const y = JSON.parse(Buffer.from(govde, "base64url"));
  const simdi = Math.floor(Date.now() / 1000);
  if (typeof y.exp !== "number" || y.exp < simdi - 30) throw new Error("süresi dolmuş");   // 30 sn saat kayması payı
  if (y.iss !== iss) throw new Error("iss uyuşmuyor");
  if (y.aud !== aud) throw new Error("aud uyuşmuyor");
  return y;
}
```

```text
gerçek             (iyi) : kabul, rol=developer
alg=none           (iyi) : RED - beklenmeyen alg: none
RS256→HS256        (iyi) : RED - beklenmeyen alg: HS256
başka servis için  (iyi) : RED - aud uyuşmuyor
süresi dolmuş      (iyi) : RED - süresi dolmuş

gövde herkesçe okunur: {"sub":"mehmet","rol":"developer","iss":"https://sso.ornek.com","aud":"deploy-api","exp":1795691532}
```

`aud` kontrolü bu listede en sık unutulanıdır. Aynı kimlik sağlayıcısından jeton alan bütün servisler birbirinin jetonunu kabul ederse, `rapor-api` için verilmiş bir jeton (ya da bu jetonları gören ele geçirilmiş bir `rapor-api`) `deploy-api`'de de çalışır.

Kendi doğrulayıcını yazma. Bu kod sadece mekanizmayı göstermek için. Gerçekte `jose` gibi bakımlı bir kütüphaneyi **izin verilen algoritma listesini açıkça vererek** kullan: `jwtVerify(jeton, JWKS, { algorithms: ["RS256"], issuer, audience })`. Kütüphane ne kadar iyi olursa olsun, şu kurallar geçerlidir:

- **Gövde şifreli değildir.** İçine kişisel veri ya da sır koyma.
- **`kid`, `jku`, `x5u` başlıkları saldırganın girdisidir.** `kid` ile dosya yolu ya da SQL kurma. `jku` ile başlıkta verilen URL'den anahtar indirme (SSRF ve sahte anahtar).
- **Erişim jetonu kısa ömürlü olmalı** (5–15 dakika). Uzun oturum için yenileme (refresh) jetonu kullanılır. Yenileme jetonu her kullanımda yenisiyle değiştirilir (rotation). Eski bir yenileme jetonu ikinci kez gelirse, bu bir hırsızlık işaretidir ve bütün jeton ailesi iptal edilir.

## İkinci faktör

### TOTP

Kimlik doğrulayıcı uygulamaların ürettiği 6 haneli kodlar TOTP'dir (RFC 6238): `HMAC-SHA1(paylaşılan_anahtar, floor(zaman / 30))`, ardından dinamik kesme ile 6 basamağa indirme. Küçük bir uygulama yazıp RFC'nin test vektörleriyle doğrulayalım:

```js
// totp.mjs — TOTP (RFC 6238): 30 saniyelik pencere, HMAC-SHA1, dinamik kesme (RFC 4226)
import crypto from "node:crypto";

function hotp(anahtar, sayac, basamak = 6, alg = "sha1") {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(sayac));
  const h = crypto.createHmac(alg, anahtar).update(b).digest();
  const o = h[h.length - 1] & 0x0f;                         // dinamik kesme
  const kod = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** basamak;
  return String(kod).padStart(basamak, "0");
}
const totp = (anahtar, zaman = Date.now() / 1000, adim = 30, basamak = 6) => hotp(anahtar, Math.floor(zaman / adim), basamak);

// RFC 6238 Ek B test vektörleri (SHA1, 8 basamak, anahtar "12345678901234567890")
const rfc = Buffer.from("12345678901234567890");
for (const [t, beklenen] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]])
  console.log(`T=${String(t).padEnd(10)} ${totp(rfc, t, 30, 8)}  beklenen ${beklenen}  ${totp(rfc, t, 30, 8) === beklenen ? "✓" : "✗"}`);

// Doğrulama: ±1 pencere tolerans, aynı kod ikinci kez kabul edilmez
const kullanilan = new Set();     // gerçekte: kullanıcı başına, kalıcı depoda
function dogrula(anahtar, kod, zaman = Date.now() / 1000) {
  const sayac = Math.floor(zaman / 30);
  for (const k of [sayac - 1, sayac, sayac + 1]) {
    const aday = hotp(anahtar, k);
    if (aday.length === kod.length && crypto.timingSafeEqual(Buffer.from(aday), Buffer.from(kod))) {
      if (kullanilan.has(k)) return "tekrar kullanım reddedildi";
      kullanilan.add(k);
      return "kabul";
    }
  }
  return "red";
}
```

```text
T=59         94287082  beklenen 94287082  ✓
T=1111111109 07081804  beklenen 07081804  ✓
T=1234567890 89005924  beklenen 89005924  ✓
T=2000000000 69279037  beklenen 69279037  ✓

kod: 265465 | aynı pencere: kabul | ikinci kez: tekrar kullanım reddedildi | 31 sn sonra (yeni kod): kabul | 95 sn önceki kod: red
```

Uygulama ayrıntıları önemlidir:

- **Tekrar kullanım engeli:** Kod 30–90 saniye geçerlidir. Bu sürede omuz üzerinden görülen ya da loglara düşen bir kod tekrar kullanılabilir. Kabul edilen son sayaç kullanıcı başına saklanır.
- **Deneme sınırı:** 6 hane 10^6 olasılık demektir. ±1 pencereyle her denemede 3 kod geçerli sayılır. Sınırsız denemede kod dakikalar içinde bulunur. Kullanıcı başına sıkı bir deneme sınırı şarttır.
- **Paylaşılan anahtar bir sırdır.** Sunucuda şifreli saklanır (sır yönetimi dersi). Kurulumda bir kez QR koduyla gösterilir ve bir daha gösterilmez.
- **Kurtarma kodları:** Tek kullanımlıktır ve parolalar gibi hashlenerek saklanır.

### Oltalamaya dayanıklılık: passkey ve WebAuthn

TOTP, SMS ve "onayla" bildirimleri **oltalamaya açıktır**. Saldırganın sahte sitesi kullanıcının girdiği parolayı ve kodu gerçek siteye anlık olarak aktarır (evilginx gibi ters vekil araçları). Kullanıcı da kodun hangi siteye gittiğini ayırt edemez. Push bildirimlerinde ek bir risk var: "MFA yorgunluğu". Saldırgan arka arkaya istek gönderir, kullanıcı da bir noktada "onayla"ya basar. Bu yüzden numara eşleştirme gerekir.

WebAuthn (passkey) bu sorunu yapısal olarak çözer:

- Tarayıcı, imzalanan veriye sayfanın **origin'ini** ekler.
- Anahtar çifti her site için ayrıdır.
- `ornek-giris.com` adresindeki sahte site, `ornek.com` için oluşturulmuş anahtarı **kullanamaz**, çünkü tarayıcı vermez.
- Sunucuda paylaşılan bir sır yoktur, sadece herkese açık anahtar saklanır. Veritabanı sızsa bile anahtar işe yaramaz.

Yönetici hesapları, üretim erişimi ve CI/CD yönetimi için hedef, oltalamaya dayanıklı MFA'dır: passkey ya da donanım anahtarı.

## Parola sıfırlama

Sıfırlama akışı, parolanın kendisi kadar güçlü bir **alternatif giriş yoludur**. Kuralları:

- Jeton 32 bayt `crypto.randomBytes` ile üretilir. Veritabanında jetonun **hash'i** saklanır, böylece DB sızıntısı aktif sıfırlama bağlantılarını vermez. Jeton tek kullanımlıktır ve kısa ömürlüdür (15–60 dakika).
- Bağlantıdaki alan adı yapılandırmadan gelir, **isteğin `Host` başlığından gelmez**. Aksi halde saldırgan `Host: kotu.example` ile sıfırlama isteği gönderir, kurbana giden e-postadaki bağlantı saldırganın sitesine işaret eder ve jeton saldırgana sızar. Bu, host header injection açığıdır.
- Sıfırlama sayfasında `Referrer-Policy: no-referrer` kullanılır. URL'deki jeton üçüncü taraf betiklere ve analitiğe sızmaz.
- Başarılı sıfırlamadan sonra kullanıcının **bütün oturumları** iptal edilir ve hesaba bildirim gönderilir. Bildirim, saldırganın hesabı ele geçirdiğini kullanıcının fark etmesini sağlar.
- E-posta değiştirmek de bir sıfırlama yoludur. Değişiklikte mevcut parola ya da MFA istenir, eski adrese de bildirim gider.

```quiz
{
  "question": "Bir ekip parolaları `sha256(tuz + parola)` ile saklıyor ve tuz kullanıcı başına rastgele. 'Tuz olduğu için güvenli' diyorlar. Doğru değerlendirme hangisi?",
  "options": [
    "Doğru, tuz kaba kuvvet saldırılarını etkisiz kılar.",
    "Tuz hazır tabloları ve aynı parolaların aynı hash'i üretmesini engeller, ama her tahminin maliyetini artırmaz. GPU ile saniyede milyarlarca tahmin yapılabilir. argon2id/scrypt gibi bellek-yoğun bir fonksiyona geçilmeli, mevcut kayıtlar da sarmalama ile hemen korunmalı.",
    "SHA-256 yerine SHA-512 kullanmak yeterli olur.",
    "Tuzu gizli tutarlarsa güvenli olur."
  ],
  "answer": 1,
  "explanation": "Çevrimdışı saldırıda ölçü tahmin başına maliyettir. Hızlı hash'ler, tuzlu olsa bile ucuzdur. Geçiş için argon2id(sha256(tuz+parola)) sarmalaması yapılır, girişte de doğrudan argon2id'ye yükseltilir. Gizli bir değer isteniyorsa bu biberdir ve kasada durur, ama bellek-yoğun fonksiyonun yerini tutmaz."
}
```

```quiz
{
  "question": "Bir mikroservis mimarisinde bütün servisler aynı kimlik sağlayıcısının RS256 jetonlarını doğruluyor. İmza, exp ve iss kontrol ediliyor, aud kontrol edilmiyor. Hangi saldırı mümkün olur?",
  "options": [
    "alg=none saldırısı.",
    "Az yetkili ya da ele geçirilmiş bir servis için verilmiş geçerli bir jeton, başka bir serviste (örneğin deploy-api) kullanılabilir.",
    "Jetonun gövdesi okunabilir hale gelir.",
    "Hiçbiri. İmza kontrolü yeterlidir."
  ],
  "answer": 1,
  "explanation": "İmza jetonun kimin tarafından verildiğini kanıtlar, kimin için verildiğini değil. aud kontrolü olmadan bir servise gönderilen jeton başka bir serviste tekrar oynatılabilir. Her servis kendi aud değerini zorunlu kılmalı."
}
```

```lab
{
  "title": "Kimlik doğrulamayı kır ve düzelt",
  "steps": [
    "parola.mjs'teki argon2id parametrelerini m=46 MiB, t=1 ve m=64 MiB, t=3 olarak dene. Kendi sunucunda saniyede kaç giriş kaldırabileceğini (çekirdek sayısı × 1000/ms) ve anlık bellek ihtiyacını hesapla.",
    "zamanlama.mjs'teki kötü giriş fonksiyonunu bir HTTP sunucusuna koy ve curl'ün `-w '%{time_total}'` çıktısıyla var olan ve olmayan e-postaları ayırt et. Sonra iyi sürüme geç ve farkın kaybolduğunu doğrula.",
    "jwt.mjs'e `kid` başlığından anahtar dosyası okuyan bir doğrulayıcı ekle (`fs.readFileSync('keys/' + kid)`). `kid: '../../../dev/null'` ile boş anahtarla HMAC imzası üretip doğrulamayı atlat. Ardından kid'i bir izin listesi eşlemesine çevir.",
    "totp.mjs'e kullanıcı başına deneme sayacı ekle: 5 başarısız denemeden sonra 15 dakika bekletme. Bekletme olmadan 10^6 kodu taramanın kaç istek gerektirdiğini ve ±1 pencerenin bunu nasıl etkilediğini hesapla.",
    "Kendi uygulamanın parola sıfırlama akışını bu dersteki kurallarla karşılaştır: jeton DB'de hash'li mi, bağlantı alan adı nereden geliyor, sıfırlama sonrası oturumlar iptal ediliyor mu?"
  ]
}
```

## Özet

- Parolalar argon2id (m≥19 MiB, t≥2) ya da scrypt ile, PHC dizgesi olarak saklanır. Tuz tahmin maliyetini artırmaz, bellek-yoğun fonksiyon artırır. Eski şemalar sarmalanır ve girişte yükseltilir.
- Parola politikası: bileşim kuralları yerine uzunluk ve sızmış parola kontrolü. Zorunlu periyodik değişiklik yok.
- Giriş, kayıt ve sıfırlama akışları kullanıcı varlığını mesajla ya da **süreyle** sızdırmamalı. Hız sınırlama hesap başına ve ağ başına yapılır, sayaç ortak bir depoda tutulur.
- Tarayıcı oturumu için opak kimlik ve `HttpOnly` çerez kullan. Kimliği girişte yenile, çıkışı sunucu tarafında yap. JWT kısa ömürlü olmalı, yenileme jetonu her kullanımda değiştirilmeli.
- JWT doğrulamasında algoritmayı jetona sorma: Algoritma listesini sabitle, `exp`, `iss` ve **`aud`** değerlerini kontrol et. Gövde şifreli değildir.
- TOTP'de tekrar kullanım engeli ve deneme sınırı şarttır. TOTP, SMS ve push oltalamaya açıktır. Kritik hesaplar için passkey ya da WebAuthn kullan.
- Parola sıfırlama, ikinci bir giriş yoludur. Jeton hash'li, tek kullanımlık ve kısa ömürlü olmalı. Bağlantı `Host` başlığından kurulmamalı. Sıfırlama sonrası bütün oturumlar iptal edilir.
