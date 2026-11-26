# Yetkilendirme: IDOR, RBAC/ABAC, OAuth 2.0 ve OIDC

Kimlik doğrulama "kim" sorusunu cevaplar, yetkilendirme "**bunu yapabilir mi**" sorusunu. OWASP Top 10'da birinci sıradaki "Broken Access Control" bu ikinci sorunun cevaplanmamasından gelir. OWASP API Security Top 10'un ilk sırasında da nesne seviyesi yetkilendirme (BOLA, IDOR'un API adı) var. Bu açıklar tarayıcı ya da kriptografi bilgisi gerektirmez. Saldırganın yaptığı tek şey bir **sayıyı değiştirmek** ya da gövdeye **fazladan bir alan eklemektir**. Tarayıcılar ve otomatik tarayıcılar da bu açıkları bulmakta zorlanır, çünkü "bu kullanıcı bu faturayı görmeli mi" bilgisi sadece iş kurallarında yazar.

## Deney sunucusu

Çok kiracılı (multi-tenant) bir SaaS'ın küçük bir API'si. Kimlik doğrulamanın yapıldığını varsayıyoruz, jeton doğrudan kullanıcıyı veriyor. Kiracılar ve kullanıcılar:

- `acme`: ayse (admin), mehmet (developer)
- `globex`: zeynep (admin)

```js
// yetki.mjs — AÇIKLI ÖRNEK: yetkilendirme hataları — sadece 127.0.0.1
import http from "node:http";

const GUVENLI = process.env.GUVENLI === "1";
// Kimlik doğrulama yapılmış varsayılıyor: jeton -> kullanıcı (önceki dersin konusu)
const JETONLAR = {
  "j-ayse":   { id: 1, ad: "ayse",   kiraci: "acme",   rol: "admin" },
  "j-mehmet": { id: 2, ad: "mehmet", kiraci: "acme",   rol: "developer" },
  "j-zeynep": { id: 3, ad: "zeynep", kiraci: "globex", rol: "admin" },
};
const kullanicilar = new Map([
  [1, { id: 1, ad: "ayse", eposta: "ayse@acme.com", kiraci: "acme", rol: "admin" }],
  [2, { id: 2, ad: "mehmet", eposta: "mehmet@acme.com", kiraci: "acme", rol: "developer" }],
  [3, { id: 3, ad: "zeynep", eposta: "zeynep@globex.com", kiraci: "globex", rol: "admin" }],
]);
const faturalar = new Map([
  [1001, { id: 1001, kiraci: "acme", tutar: 4200, sahip: 1 }],
  [1002, { id: 1002, kiraci: "globex", tutar: 98000, sahip: 3 }],
]);

// Politika: kim, hangi eylemi, hangi kaynak üzerinde yapabilir (tek yerde)
const IZINLER = {
  admin:     ["fatura:oku", "kullanici:oku", "kullanici:guncelle", "kullanici:rol-ata", "kullanici:sil"],
  developer: ["fatura:oku", "kullanici:oku", "kullanici:guncelle-kendi"],
};
function izinVar(ozne, eylem, kaynak) {
  if (kaynak && kaynak.kiraci !== ozne.kiraci) return false;                 // kiracı sınırı her şeyden önce
  if (IZINLER[ozne.rol]?.includes(eylem)) return true;
  if (eylem === "kullanici:guncelle" && kaynak?.id === ozne.id)
    return IZINLER[ozne.rol]?.includes("kullanici:guncelle-kendi");
  return false;
}

http.createServer(async (req, res) => {
  const ozne = JETONLAR[(req.headers.authorization ?? "").replace("Bearer ", "")];
  if (!ozne) return json(res, 401, { hata: "kimlik yok" });
  const url = new URL(req.url, "http://x");
  let m;

  // 1) Nesne seviyesi: GET /faturalar/:id
  if ((m = url.pathname.match(/^\/faturalar\/(\d+)$/)) && req.method === "GET") {
    const f = faturalar.get(+m[1]);
    if (GUVENLI && (!f || !izinVar(ozne, "fatura:oku", f))) return json(res, 404, { hata: "bulunamadı" });
    if (!f) return json(res, 404, { hata: "bulunamadı" });
    return json(res, 200, f);
  }

  // 2) Toplu atama: PATCH /kullanicilar/:id
  if ((m = url.pathname.match(/^\/kullanicilar\/(\d+)$/)) && req.method === "PATCH") {
    const k = kullanicilar.get(+m[1]);
    const g = await govde(req);
    if (!GUVENLI) {
      if (!k) return json(res, 404, { hata: "bulunamadı" });
      if (k.id !== ozne.id && ozne.rol !== "admin") return json(res, 403, { hata: "yasak" });
      Object.assign(k, g);                                                 // gövdedeki her alan yazılıyor
      return json(res, 200, k);
    }
    if (!k || !izinVar(ozne, "kullanici:guncelle", k)) return json(res, 404, { hata: "bulunamadı" });
    const IZINLI_ALANLAR = ["ad", "eposta"];                                // açık izin listesi
    const yasakli = Object.keys(g).filter((a) => !IZINLI_ALANLAR.includes(a));
    if (yasakli.length) return json(res, 400, { hata: `izin verilmeyen alan: ${yasakli.join(", ")}` });
    for (const a of IZINLI_ALANLAR) if (a in g) k[a] = String(g[a]);
    return json(res, 200, k);
  }

  // 3) İşlev seviyesi: DELETE /yonetim/kullanicilar/:id
  if ((m = url.pathname.match(/^\/yonetim\/kullanicilar\/(\d+)$/)) && req.method === "DELETE") {
    const k = kullanicilar.get(+m[1]);
    if (GUVENLI && (!k || !izinVar(ozne, "kullanici:sil", k))) return json(res, 404, { hata: "bulunamadı" });
    // açıklı sürüm: "yönetim arayüzünde bu düğme sadece adminlere görünüyor" varsayımı
    kullanicilar.delete(+m[1]);
    return json(res, 200, { silindi: +m[1] });
  }
  json(res, 404, { hata: "yok" });
}).listen(Number(process.env.PORT ?? 3031), "127.0.0.1");
```

```bash
PORT=3031 node yetki.mjs &             # açıklı
PORT=3032 GUVENLI=1 node yetki.mjs &   # düzeltilmiş
```

## Üç hata sınıfı

### 1. Nesne seviyesi (IDOR / BOLA)

Mehmet `acme` kiracısında. Fatura numarasını bir artırıyor:

```bash
curl -s -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3031/faturalar/1001
curl -s -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3031/faturalar/1002
```

```text
{"id":1001,"kiraci":"acme","tutar":4200,"sahip":1}
{"id":1002,"kiraci":"globex","tutar":98000,"sahip":3}
```

Uç nokta "kimlik doğrulanmış mı" diye baktı, "**bu fatura bu kullanıcıya ait mi**" diye bakmadı. Başka bir şirketin faturası açıldı. Sıralı kimlikler numaralandırmayı kolaylaştırır, ama kökte sorun bu değil. UUID kullanmak açığı **kapatmaz**. UUID'ler başka yerlerden sızar: URL paylaşımı, loglar, `Referer` başlığı, başka bir API yanıtı. UUID tahmini zorlaştıran bir derinlemesine savunmadır, kontrolün yerini tutmaz.

Düzeltilmiş sunucuda:

```bash
curl -s -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3032/faturalar/1001
curl -s -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3032/faturalar/1002
```

```text
{"id":1001,"kiraci":"acme","tutar":4200,"sahip":1}
{"hata":"bulunamadı"}
```

Yanıt `403` değil `404`. "Var ama göremezsin" demek, kaynağın **varlığını** sızdırır. Saldırgan bu bilgiyle başka kiracıların fatura numaralarını, yani müşteri sayısını ve büyüme hızını tahmin edebilir. Yetkisiz kaynak için "yok" demek bu kanalı kapatır.

### 2. Toplu atama (mass assignment)

Mehmet kendi profilini güncelleyebilir. Bu meşru bir işlem. Ama gövdeye **fazladan iki alan** ekliyor:

```bash
curl -s -X PATCH -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3031/kullanicilar/2 -d '{"ad":"Mehmet K."}'
curl -s -X PATCH -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3031/kullanicilar/2 -d '{"rol":"admin","kiraci":"globex"}'
```

```text
{"id":2,"ad":"Mehmet K.","eposta":"mehmet@acme.com","kiraci":"acme","rol":"developer"}
{"id":2,"ad":"Mehmet K.","eposta":"mehmet@acme.com","kiraci":"globex","rol":"admin"}
```

`Object.assign(k, g)` ifadesi (ORM'lerde `User.update(req.body)`) gövdedeki **her** alanı yazar. Mehmet kendini admin yapıp başka bir kiracıya taşıdı. Bu açık için gizli alanları bilmek gerekmez. Alan adları genelde API'nin GET yanıtında zaten görünür. Düzeltme, yazılabilir alanların **açık bir izin listesidir**. Beklenmeyen alanı sessizce atlamak yerine reddetmek, istemci hatalarını da görünür kılar:

```bash
curl -s -X PATCH -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3032/kullanicilar/2 -d '{"rol":"admin","kiraci":"globex"}'
```

```text
{"hata":"izin verilmeyen alan: rol, kiraci"}
```

Okuma yönünde de aynı ilke geçerlidir. Veritabanı nesnesini doğrudan JSON'a çevirip döndürmek; parola hash'ini, iç notları ve başka kullanıcıların verisini sızdırır. Yanıt için ayrı bir şema ya da DTO kullan, yani **çıktıda da izin listesi** olsun.

### 3. İşlev seviyesi ve kiracı sınırı

Yönetim uç noktası, arayüzde sadece adminlere görünen bir düğmenin arkasında. Mehmet API'yi doğrudan çağırıyor. Ayrıca globex'in admini zeynep, acme'nin kullanıcısını güncellemeyi deniyor:

```bash
curl -s -X DELETE -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3031/yonetim/kullanicilar/1
curl -s -X PATCH -H "Authorization: Bearer j-zeynep" http://127.0.0.1:3031/kullanicilar/1 -d '{"eposta":"zeynep@globex.com"}'
```

```text
{"silindi":1}
{"id":1,"ad":"ayse","eposta":"zeynep@globex.com","kiraci":"acme","rol":"admin"}
```

İki hata da yaygın varsayımlardan geliyor:

- **"Düğmeyi gizledik":** Arayüz bir yetki kontrolü **değildir**. Her uç nokta, istemciden bağımsız olarak kendini korumalıdır. Mobil uygulamanın kullandığı ve "kimse bilmiyor" denen API'ler de buna dahildir.
- **"Admin her şeyi yapabilir":** Hangi kiracının admini? Kontrol `rol === "admin"` olarak yazıldığında, globex'in admini acme'nin yöneticisinin e-postasını kendi adresi yaptı. Ardından parola sıfırlama, hesabın tamamen ele geçirilmesi demektir.

Düzeltilmiş sunucuda bu istekler ve meşru istek:

```bash
curl -s -X PATCH -H "Authorization: Bearer j-zeynep" http://127.0.0.1:3032/kullanicilar/1 -d '{"eposta":"zeynep@globex.com"}'
curl -s -X DELETE -H "Authorization: Bearer j-mehmet" http://127.0.0.1:3032/yonetim/kullanicilar/1
curl -s -X DELETE -H "Authorization: Bearer j-ayse" http://127.0.0.1:3032/yonetim/kullanicilar/2
```

```text
{"hata":"bulunamadı"}
{"hata":"bulunamadı"}
{"silindi":2}
```

## Yetkilendirmeyi tasarlamak

Üç düzeltmenin ortak noktası **tek bir politika fonksiyonudur**: `izinVar(ozne, eylem, kaynak)`. Her uç nokta kendi `if`'ini yazdığında, yüz uç noktadan biri unutulur. Politika tek yerde olursa:

- İncelemesi ve test etmesi kolaylaşır ("developer hangi eylemleri yapabilir" sorusunun cevabı tek bir tablodadır).
- Varsayılan **reddetmedir**. Listede olmayan eylem yapılamaz.
- Kiracı sınırı her kontrolde ilk adımdır ve unutulamaz.

### RBAC, ABAC, ReBAC

| Model | Karar | Ne zaman | Zorluk |
|---|---|---|---|
| **RBAC** (rol tabanlı) | Rolün izinleri: `developer → fatura:oku` | İzinler kullanıcı tipine bağlıysa | "Rol patlaması": `developer-istanbul-odeme-salt-okunur` |
| **ABAC** (öznitelik tabanlı) | Özne, kaynak ve ortam öznitelikleri: `kaynak.kiraci == ozne.kiraci && saat in mesai` | Kurallar veri ve bağlama bağlıysa | Politikaların test edilmesi ve açıklanması |
| **ReBAC** (ilişki tabanlı) | İlişki grafiği: `mehmet → üye → ekip:odeme → sahip → repo:odeme-api` | Paylaşım, klasörler, organizasyon hiyerarşisi (Google Zanzibar modeli) | Ayrı bir yetki servisi ve tutarlılık |

Gerçek sistemler bunları karıştırır. Deneydeki politika rol (RBAC), kiracı sınırı (ABAC) ve "kendi kaydı" (ilişki) içeriyor. Politika büyüdüğünde, onu koddan ayırıp bildirimsel bir dilde yazmak gerekir: Open Policy Agent/Rego, Cedar ya da OpenFGA/SpiceDB (ReBAC için). Bunu Kubernetes kursundaki RBAC ve admission controller'lardan hatırlıyorsun. Aynı fikir uygulama seviyesinde de geçerli.

### Kiracı yalıtımı: derinlemesine

Çok kiracılı sistemde en ağır sızıntı kiracılar arasıdır, bu yüzden tek bir kontrole güvenilmez:

1. **Uygulama:** Politika fonksiyonu ve kiracı kimliği **jetondan** alınır, istekten (URL, gövde, başlık) alınmaz.
2. **Veri erişim katmanı:** Her sorguya kiracı filtresi otomatik olarak eklenir (ORM kapsamı ya da depo sınıfı). Elle yazılan ham sorgular kod incelemesinde işaretlenir.
3. **Veritabanı:** Satır seviyesi güvenlik (PostgreSQL RLS, Oracle kursundaki VPD). Uygulama her bağlantıda `SET app.kiraci = ...` yapar, veritabanı başka kiracının satırlarını döndürmez. Uygulama katmanındaki bir hata bu katmanda durur.
4. **Test:** İki kiracılı otomatik testlerle her uç noktada "A kiracısının jetonu B'nin kaynağına erişebiliyor mu" sorusu sorulur. Bu test, yeni uç nokta eklendiğinde kendiliğinden genişlemelidir. Örneğin uç nokta listesi OpenAPI şemasından üretilir.

## OAuth 2.0 ve OpenID Connect

İki protokol sıklıkla karıştırılır:

- **OAuth 2.0** bir **yetkilendirme devri** protokolüdür. Bir uygulama, kullanıcı adına başka bir API'ye **sınırlı** erişim (kapsam, scope) alır: "Bu CI aracı GitLab'daki depolarımı okuyabilir."
- **OpenID Connect (OIDC)**, OAuth'un üzerine **kimlik** katmanı ekler. Kullanıcının kim olduğunu söyleyen imzalı bir `id_token` (JWT) verir. "Google ile giriş" ve kurumsal SSO OIDC'dir.

Erişim jetonu (`access_token`) bir API için **yetki belgesidir**, kimlik kanıtı değildir. Bir uygulamanın, eline geçen herhangi bir erişim jetonunu "kullanıcı giriş yaptı" kanıtı olarak kabul etmesi, başka bir uygulamaya verilmiş jetonla giriş yapılmasına yol açar. Giriş için `id_token` kullanılır ve `aud` değerinin **senin** istemci kimliğin olduğu doğrulanır.

### Authorization Code + PKCE akışı

Tarayıcı uygulamaları, mobil ve masaüstü uygulamalar ve sunucu uygulamaları için güncel tek öneri budur. OAuth 2.1 taslağı implicit ve parola akışlarını kaldırır.

```text
 Uygulama                      Tarayıcı                     Yetki sunucusu (IdP)
    │ 1. verifier = rastgele 32 bayt                               │
    │    challenge = BASE64URL(SHA256(verifier))                   │
    │    state = rastgele, nonce = rastgele (oturumda sakla)       │
    │──── 302 /authorize?response_type=code&client_id=..&redirect_uri=..
    │         &scope=openid profile&state=..&nonce=..&code_challenge=..&code_challenge_method=S256 ──▶│
    │                                │  2. kullanıcı giriş + onay  │
    │◀─── 302 redirect_uri?code=..&state=.. ───────────────────────│
    │ 3. state oturumdakiyle aynı mı?                              │
    │──── POST /token  code + verifier (+ istemci kimlik bilgisi) ─────────────────────────────────▶│
    │                                │  4. SHA256(verifier) == challenge?                          │
    │◀─── access_token, id_token (nonce içinde), refresh_token ────────────────────────────────────│
    │ 5. id_token: imza, iss, aud=client_id, exp, nonce doğrula   │
```

PKCE (RFC 7636), yetkilendirme kodunun çalınmasına karşı korur. Kod tarayıcı geçmişinde, loglarda ya da mobilde kötü niyetli bir uygulamanın kaydettiği URL şemasında görünebilir. Saldırgan kodu ele geçirse bile `verifier`'ı bilmeden jetona çeviremez. Challenge hesabı ve RFC'nin test vektörü:

```bash
node -e 'const c=require("crypto"); const v="dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
console.log("verifier :", v); console.log("challenge:", c.createHash("sha256").update(v).digest("base64url"));
console.log("yeni verifier:", c.randomBytes(32).toString("base64url"))'
```

```text
verifier : dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
yeni verifier: B3Ll4RBK6eOku4crxquILnj8ouXLVhwMFZ_0dgBo99Y
```

Çıktı, RFC 7636 Ek B'deki değerle (`E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`) aynı.

Akıştaki her parametrenin bir saldırıya karşılık gelen bir görevi var:

| Parametre / kontrol | Neye karşı | Hata örneği |
|---|---|---|
| `state` | Giriş CSRF'si: Saldırgan kendi kodunu kurbanın tarayıcısına geri döndürür ve kurban **saldırganın hesabına** bağlanır | `state` hiç kullanılmıyor ya da oturuma bağlanmıyor |
| `nonce` (`id_token` içinde) | Çalınmış `id_token`'ın tekrar oynatılması | Doğrulanmıyor |
| `redirect_uri` **tam eşleşme** | Kodun saldırganın adresine gönderilmesi | IdP'de joker karakter (`https://*.ornek.com/*`) ya da önek eşleşmesi. Açık bir yönlendirme bulunduğunda kod sızar |
| PKCE `S256` | Kod hırsızlığı | `plain` yöntemine izin vermek |
| `aud` ve `iss` | Başka istemciye verilen jetonun kabulü | Sadece imza doğrulanıyor |
| Kapsam (`scope`) en azı | Jeton sızarsa zararın sınırlanması | `api` ya da `*` kapsamı istemek |

Uygulama tarafındaki pratik kurallar:

- **Tarayıcıda jeton tutma (BFF deseni):** Tek sayfalık uygulama için önerilen mimari, bir arka uç bileşeninin (Backend-for-Frontend) OAuth istemcisi olmasıdır. Jetonlar sunucuda kalır, tarayıcıya sadece `HttpOnly` bir oturum çerezi gider. Böylece XSS jeton çalamaz.
- **Servisler arası:** Kullanıcı olmadan çalışan servisler `client_credentials` akışını kullanır. Daha iyisi, platformun iş yükü kimliğidir: Kubernetes ServiceAccount jetonları, GitLab CI'ın `id_tokens` ile verdiği OIDC jetonu. Git kursunda CI'dan buluta **uzun ömürlü anahtar olmadan** erişimi böyle kurmuştuk.
- **Jeton değişimi ve yetki daraltma:** Bir servis kullanıcının jetonunu alt servise olduğu gibi iletmemeli. Bunun yerine o servise özel `aud` değerli, daraltılmış bir jeton alır (RFC 8693 token exchange). Aksi halde her alt servis bütün API'ler için geçerli bir jeton taşır.

```quiz
{
  "question": "Bir API, kaynak kimliklerini sıralı sayılardan UUID v4'e geçiriyor ve ekip bunu 'IDOR düzeltmesi' olarak kaydediyor. Doğru değerlendirme hangisi?",
  "options": [
    "Doğru, UUID tahmin edilemediği için IDOR kapanır.",
    "Tahmin zorlaşır, ama açık kapanmaz. UUID'ler URL paylaşımı, loglar, Referer başlığı ve başka API yanıtlarıyla sızar. Her istekte kaynağın özneye (kiracı, sahip) ait olduğunun kontrol edilmesi gerekir.",
    "UUID v4 yerine UUID v7 kullanılırsa açık kapanır.",
    "IDOR sadece sıralı kimliklerde olur, UUID'de olmaz."
  ],
  "answer": 1,
  "explanation": "IDOR'un kökü eksik yetki kontrolüdür, tahmin edilebilir kimlik değil. UUID bir derinlemesine savunmadır. Üstelik UUID v7 zaman damgası içerdiği için kısmen tahmin edilebilir."
}
```

```quiz
{
  "question": "OIDC ile 'kurumsal SSO ile giriş' yapan bir uygulama, geri dönüşte `state` parametresini kontrol etmiyor. Saldırgan bunu nasıl kullanır?",
  "options": [
    "Kurbanın parolasını öğrenir.",
    "Kendi hesabıyla akışı başlatıp aldığı `code` içeren geri dönüş URL'sini kurbana açtırır. Kurban, farkında olmadan saldırganın hesabına giriş yapmış olur ve yüklediği dosyalar ya da girdiği veriler saldırganın hesabına gider.",
    "IdP'nin imza anahtarını ele geçirir.",
    "PKCE varsa state'in hiçbir önemi yoktur."
  ],
  "answer": 1,
  "explanation": "Bu, giriş CSRF'sidir. state, geri dönüşün bu tarayıcının başlattığı akışa ait olduğunu kanıtlar. PKCE kod hırsızlığına karşı korur. Verifier istemci oturumuna bağlıysa giriş CSRF'sini de zorlaştırır, ama state (ya da nonce) kontrolü yine de standart gerekliliktir."
}
```

```lab
{
  "title": "Yetki kontrollerini test eden bir test paketi yaz",
  "steps": [
    "yetki.mjs'i iki kopya olarak başlat. Her uç nokta için üç jeton (ayse, mehmet, zeynep) ile bir 'kim neye erişebilmeli' matrisi çıkar, sonra açıklı kopyada matrisle uyuşmayan her hücreyi bul.",
    "Matrisi bir Node test dosyasına (`node:test`) çevir. Her hücre bir test olsun. Testlerin açıklı sunucuda başarısız, düzeltilmiş sunucuda başarılı olduğunu doğrula.",
    "Düzeltilmiş sunucuya `GET /faturalar?kiraci=globex` biçiminde bir liste uç noktası ekle. Kiracı filtresinin jetondan gelmesi gerektiğini, sorgu parametresinin yok sayılması gerektiğini teste ekle.",
    "Yanıtlarda bir çıktı izin listesi uygula: Kullanıcı yanıtı sadece id, ad ve eposta alanlarını içersin. Rol alanını sadece aynı kiracının adminleri görsün.",
    "Kendi kullandığın bir IdP'de (GitLab, Keycloak, Entra ID) kayıtlı bir OAuth uygulamasının redirect URI ayarlarını incele: tam eşleşme mi, joker karakter mi? İstenen kapsamlar gerçekten gerekli mi?"
  ]
}
```

## Özet

- Yetkilendirme açıkları bir sayıyı değiştirmek ya da gövdeye bir alan eklemekle istismar edilir. Tarayıcılar bulamaz, çünkü kural iş mantığındadır.
- IDOR/BOLA: Her nesne erişiminde "bu kaynak bu özneye ait mi?" diye bak. UUID kontrolün yerini tutmaz. Yetkisiz kaynak için 404 döndür.
- Toplu atama: Yazılabilir alanlar için açık izin listesi kullan. Çıktıda da izin listesi (DTO) olsun.
- Arayüz bir yetki kontrolü değildir. Her uç nokta kendini korur. "Admin", hangi kiracının admini olduğuyla birlikte anlam taşır.
- Politika tek yerde olmalı (`izinVar(ozne, eylem, kaynak)`), varsayılan reddetme olmalı. Büyüyünce OPA, Cedar ya da OpenFGA kullan.
- Kiracı yalıtımı katmanlıdır: jetondan gelen kiracı kimliği, otomatik sorgu filtresi, veritabanında RLS/VPD ve iki kiracılı otomatik testler.
- OAuth yetki devridir, OIDC kimliktir. Authorization Code + PKCE (S256) kullan. `state`, `nonce`, tam eşleşmeli `redirect_uri` ve `aud`/`iss` kontrolleri zorunludur. Tarayıcı uygulamasında BFF deseniyle jetonu sunucuda tut.
