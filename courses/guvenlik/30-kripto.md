# Uygulamalı kriptografi: hash, şifreleme, imza ve TLS

Bu ders bir kriptografi kursu değildir. Algoritmaların içine girmeyeceğiz. Uygulama geliştiricisinin gerçekte karşılaştığı sorulara cevap arıyoruz:

- Hangi işe hangi araç?
- Hangi parametreler?
- Doğru algoritmayla bile sistemi kıran hangi kullanım hataları?

Kural sıfır: **Kendi algoritmanı ya da protokolünü tasarlama.** Kural bir: Doğru algoritmayı yanlış kullanmak, yanlış algoritmayı kullanmak kadar kötüdür. Bu dersteki hataların hepsi AES ve SHA-256 gibi sağlam yapı taşlarıyla yapılıyor.

## Hangi işe hangi araç

| İhtiyaç | Araç | Anahtar | Örnek |
|---|---|---|---|
| Veri değişti mi (anahtarsız) | Hash: SHA-256, SHA-3, BLAKE3 | yok | İmaj özeti, dosya bütünlüğü, içerik adresleme |
| Parola saklama | argon2id, scrypt | yok (tuz + parametre) | Önceki ders |
| Mesaj bu sırrı bilen birinden mi geldi | MAC: HMAC-SHA256 | paylaşılan sır | Webhook imzası, çerez imzası, CSRF jetonu |
| Gizlilik + bütünlük | AEAD: AES-256-GCM, ChaCha20-Poly1305 | simetrik | Veritabanında alan şifreleme, dosya şifreleme |
| Herkes doğrulayabilsin, sadece biri imzalasın | İmza: Ed25519, ECDSA P-256, RSA-PSS | özel/açık çift | Yazılım imzası, JWT (RS256/EdDSA), commit imzası |
| İki taraf ortak sır kursun | Anahtar değişimi: X25519 (ECDH), ML-KEM | geçici çiftler | TLS el sıkışması |
| Tahmin edilemez değer | CSPRNG: `crypto.randomBytes` | yok | Oturum kimliği, jeton, nonce, anahtar |

Bu tablo en sık yapılan karışıklıkları da gösteriyor:

- **"Şifreledik, değiştirilemez"** yanlıştır. Bütünlük olmadan şifreleme (AES-CBC, AES-CTR) ile şifreli metin anlamlı biçimde değiştirilebilir. Yeni kodda sadece AEAD kullan.
- **"Hash'ledik, anonim"** de yanlıştır. TCKN, telefon numarası ve e-posta gibi küçük uzaylı değerlerin hash'i bir sözlükle saniyeler içinde geri bulunur. Takma adlandırma (pseudonymization) gerekiyorsa, gizli anahtarlı bir HMAC kullan.
- **"Base64 ile kodladık"** bir şifreleme değildir. Kubernetes Secret'larında olduğu gibi.

## Örnek dosya

Bütün çıktılar bu tek dosyadan geliyor. Node'un yerleşik `crypto` modülünü kullanıyor:

```js
// kripto.mjs — AES-GCM, nonce tekrarı, AAD, zarf şifreleme, imza
import crypto from "node:crypto";

// --- 1) AES-256-GCM: şifreleme + bütünlük (AEAD)
function sifrele(anahtar, metin, aad = "", nonce = crypto.randomBytes(12)) {
  const c = crypto.createCipheriv("aes-256-gcm", anahtar, nonce);
  c.setAAD(Buffer.from(aad));
  const sifreli = Buffer.concat([c.update(metin, "utf8"), c.final()]);
  return { nonce, sifreli, etiket: c.getAuthTag() };
}
function coz(anahtar, { nonce, sifreli, etiket }, aad = "") {
  const d = crypto.createDecipheriv("aes-256-gcm", anahtar, nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(etiket);
  return Buffer.concat([d.update(sifreli), d.final()]).toString("utf8");
}

const anahtar = crypto.randomBytes(32);
const k = sifrele(anahtar, '{"iban":"TR12 0006 4000 0011 2345 6789 01"}', "musteri:42");
console.log("1) çözüldü:", coz(anahtar, k, "musteri:42"));

// Bir bayt değiştir: GCM etiketi bunu yakalar
const bozuk = { ...k, sifreli: Buffer.from(k.sifreli) }; bozuk.sifreli[5] ^= 0x01;
try { coz(anahtar, bozuk, "musteri:42"); } catch (e) { console.log("   1 bit değişti    ->", e.message); }

// AAD: şifreli değer başka bir kaydın satırına taşınırsa
try { coz(anahtar, k, "musteri:43"); } catch (e) { console.log("   başka kayda taşındı ->", e.message); }

// --- 2) Nonce tekrarı: GCM'in (ve her akış şifresinin) en ağır hatası
const sabitNonce = Buffer.alloc(12, 0);                     // "rastgele üretmek yavaş" diye sabit
const a = sifrele(anahtar, "maas: 85000 TL   ", "", sabitNonce);
const b = sifrele(anahtar, "AAAAAAAAAAAAAAAAA", "", sabitNonce);   // saldırganın bildiği/seçtiği metin
const xor = (x, y) => Buffer.from(x.map((v, i) => v ^ y[i]));
const anahtarAkisi = xor(b.sifreli, Buffer.from("AAAAAAAAAAAAAAAAA"));
console.log("2) aynı nonce ile, anahtarı bilmeden çözülen metin:", xor(a.sifreli, anahtarAkisi).toString());

// --- 3) Zarf şifreleme: veri anahtarı (DEK) her kayıt için, ana anahtar (KEK) KMS'de
const KEK = crypto.randomBytes(32);                           // gerçekte KMS/HSM içinde, dışarı çıkmaz
function zarfSifrele(metin, baglam) {
  const dek = crypto.randomBytes(32);
  const veri = sifrele(dek, metin, baglam);
  const sarilmisDek = sifrele(KEK, dek.toString("base64"), "dek:" + baglam);   // KMS Encrypt çağrısı
  return { veri, sarilmisDek };
}
function zarfCoz({ veri, sarilmisDek }, baglam) {
  const dek = Buffer.from(coz(KEK, sarilmisDek, "dek:" + baglam), "base64");   // KMS Decrypt çağrısı
  return coz(dek, veri, baglam);
}
const z = zarfSifrele("TCKN 12345678901", "musteri:42");
console.log("3) zarf:", { veri: z.veri.sifreli.length + " bayt", sarilmisDek: z.sarilmisDek.sifreli.length + " bayt" }, "->", zarfCoz(z, "musteri:42"));

// --- 4) İmza: Ed25519 (bütünlük + kaynak), HMAC (paylaşılan sır)
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const mesaj = Buffer.from('{"uygulama":"odeme-api","surum":"2.4.1","imaj":"sha256:9f2c..."}');
const imza = crypto.sign(null, mesaj, privateKey);
console.log("4) Ed25519 imza", imza.length, "bayt | doğrula:", crypto.verify(null, mesaj, publicKey, imza),
  "| değişmiş mesaj:", crypto.verify(null, Buffer.from(mesaj.toString().replace("2.4.1", "2.4.2")), publicKey, imza));

// Webhook: gönderen `zaman.govde` üzerinde HMAC hesaplar; alıcı aynısını hesaplayıp karşılaştırır
const webhookSirri = "whsec_ornek";
const hmac = (zaman, govde) => crypto.createHmac("sha256", webhookSirri).update(`${zaman}.${govde}`).digest();
function webhookDogrula(zaman, govde, imzaHex, simdi) {
  if (Math.abs(simdi - Number(zaman)) > 300) return "red: zaman damgası eski (tekrar oynatma)";
  const gelen = Buffer.from(imzaHex, "hex"), beklenen = hmac(zaman, govde);
  return gelen.length === beklenen.length && crypto.timingSafeEqual(gelen, beklenen) ? "kabul" : "red: imza";
}
const z0 = 1795690000, g0 = '{"olay":"deploy.bitti","id":881}';
const s0 = hmac(z0, g0).toString("hex");
console.log("   webhook: özgün:", webhookDogrula(z0, g0, s0, z0 + 2),
  "| gövde değişmiş:", webhookDogrula(z0, g0.replace("881", "882"), s0, z0 + 2),
  "| 1 saat sonra tekrar:", webhookDogrula(z0, g0, s0, z0 + 3600));

// --- 5) Rastgelelik: Math.random bir güvenlik kaynağı değildir
console.log("5) jeton:", crypto.randomBytes(32).toString("base64url"), "| UUID:", crypto.randomUUID());
```

```bash
node kripto.mjs
```

```text
1) çözüldü: {"iban":"TR12 0006 4000 0011 2345 6789 01"}
   1 bit değişti    -> Unsupported state or unable to authenticate data
   başka kayda taşındı -> Unsupported state or unable to authenticate data
2) aynı nonce ile, anahtarı bilmeden çözülen metin: maas: 85000 TL
3) zarf: { veri: '16 bayt', sarilmisDek: '44 bayt' } -> TCKN 12345678901
4) Ed25519 imza 64 bayt | doğrula: true | değişmiş mesaj: false
   webhook: özgün: kabul | gövde değişmiş: red: imza | 1 saat sonra tekrar: red: zaman damgası eski (tekrar oynatma)
5) jeton: q6yma0oDaoViyHt_J7sSL4VIaL0zA3v3b0XVW6Es_so | UUID: 17a6d143-f35a-423c-8316-9b53d85b4943
```

## AEAD: AES-GCM'i doğru kullanmak

### Etiket ve AAD

GCM şifreli metnin yanında 16 baytlık bir **kimlik doğrulama etiketi** üretir. Tek bir bitin değişmesi bile çözmeyi başarısız kılar (çıktı 1). Hata mesajı "unable to authenticate data". Etiket doğrulanmadan çözülen veriyi **asla** kullanma. Akış halinde çözen API'lerde çözülen parçaları `final()` başarılı olana kadar tutmak gerekir.

**AAD** (ek kimliği doğrulanmış veri), şifrelenmeyen ama etikete dahil edilen bağlamdır. Örnekte `musteri:42` kullanıldı. Veritabanına erişimi olan bir saldırgan, 42 numaralı müşterinin şifreli IBAN'ını kopyalayıp 43'ün satırına yapıştırabilir. AAD olmasaydı bu değer 43'ün IBAN'ı olarak sorunsuz çözülürdü. AAD ile çözme başarısız oluyor. Kural: AAD'ye kaydın kimliğini, alan adını ve şema sürümünü koy.

### Nonce tekrarı

GCM (ve CTR ya da ChaCha20) içeride bir **anahtar akışı** üretir. Bu akış `(anahtar, nonce)` çiftinden türetilir ve düz metinle XOR'lanır. Aynı çift iki kez kullanılırsa:

```text
şifreli_A ⊕ şifreli_B = düzmetin_A ⊕ düzmetin_B
```

Saldırgan metinlerden birini biliyor ya da seçebiliyorsa (çıktı 2'deki `AAAA...` girdisi), diğerini **anahtarı hiç bilmeden** okur. GCM'de bundan daha kötüsü de var: Nonce tekrarı, kimlik doğrulama anahtarını da sızdırır. Bundan sonra saldırgan geçerli etiketli sahte mesajlar üretebilir.

Pratik kurallar:

- Nonce her şifrelemede `crypto.randomBytes(12)` ile üretilir ve şifreli metinle birlikte saklanır. Nonce gizli değildir.
- 96 bitlik rastgele nonce ile **aynı anahtar** altında yaklaşık 2^32 şifrelemeden sonra çakışma olasılığı kabul edilemez hale gelir (NIST sınırı). Çok yüksek hacimde anahtarı döndür. Zarf şifreleme bunu zaten yapar: Her kaydın kendi DEK'i vardır.
- Nonce'u bir sayaçla üretmek, sayaç **asla** geri dönmüyorsa güvenlidir. Bir yedekten geri dönen, kopyalanan ya da iki pod arasında paylaşılan sayaç geri döner. Rastgele nonce daha az kırılgandır.
- Nonce hatasına dayanıklı bir mod istiyorsan AES-GCM-SIV kullan (tekrar olursa sadece "aynı mesaj aynı" bilgisi sızar). Ya da 192 bit nonce'lu XChaCha20-Poly1305 kullan (rastgele nonce çakışması pratikte imkânsız).

## Zarf şifreleme ve anahtar yönetimi

Kriptografide zor kısım algoritma değil, **anahtardır**: nerede durduğu, kimin eriştiği, nasıl döndürüldüğü. Bulut KMS'leri (AWS KMS, GCP KMS, Vault Transit) bunu **zarf şifreleme** ile çözer:

1. Her kayıt (ya da dosya) için rastgele bir **veri anahtarı** (DEK) üretilir. Veri bu anahtarla yerel olarak şifrelenir.
2. DEK, KMS'teki **ana anahtarla** (KEK) şifrelenir. Ana anahtar KMS'ten hiç çıkmaz. Sarılmış DEK verinin yanında saklanır.
3. Çözerken sarılmış DEK KMS'e gönderilir, açık DEK geri alınır ve veri yerel olarak çözülür.

Bu yapının kazanımları:

- **Erişim kontrolü ve denetim KMS'te:** Kim hangi anahtarla ne zaman çözdü, KMS logunda yazar. Veritabanı yedeği sızsa bile KMS erişimi olmadan işe yaramaz.
- **Döndürme ucuz:** Ana anahtar döndürüldüğünde sadece küçük sarılmış DEK'ler yeniden sarılır, terabaytlarca veri yeniden şifrelenmez.
- **Kripto-silme:** Bir müşterinin verisini her yedekten silmek imkânsıza yakındır. Müşteriye özel anahtarı silmek ise bütün kopyaları okunamaz kılar. KVKK'daki silme yükümlülüğü için bu bir yöntemdir (sonraki ders).
- **Performans:** KMS çağrısı ağ gecikmesi ve kota demektir. DEK'ler kısa süre önbelleğe alınabilir. Bunun bedeli, önbelleğe alınmış anahtarların bellekte durmasıdır.

## İmzalar ve MAC

- **Ed25519**, yeni sistemler için varsayılan imza algoritmasıdır. 32 baytlık anahtarları ve 64 baytlık imzası var (çıktı 4). Deterministiktir, yani her imzada yeni bir rastgele değer gerekmez. ECDSA'nın imza başına rastgele değer (k) gerektirmesi tarihsel bir felaket kaynağıdır: PlayStation 3 ve bazı Bitcoin cüzdanlarında k tekrar kullanıldı ve özel anahtarlar sızdı. FIPS gerekiyorsa ECDSA P-256 ya da RSA-PSS kullan.
- **HMAC**, paylaşılan sırla çalışır, yani doğrulayan da imzalayabilir. Webhook'lar için uygundur. Doğrulamada üç kural var:
  1. Karşılaştırma `timingSafeEqual` ile yapılır.
  2. İmzalanan veri **ham** gövdedir. JSON'u ayrıştırıp yeniden serileştirirsen baytlar değişir.
  3. Zaman damgası imzaya dahil edilir ve sınırlı bir pencereyle kontrol edilir. Çıktıdaki "1 saat sonra tekrar" satırı, aynı geçerli isteğin tekrar oynatılmasının bu sayede reddedildiğini gösteriyor. Tam koruma için ayrıca olay kimliği tekilleştirilir.
- İmza, **neyin** imzalandığı kadar güçlüdür. İmzalanan mesajda imaj **özeti** (`sha256:...`) olmalı, etiketi (`:latest`) olmamalı. Etiket sonradan başka bir imajı gösterebilir. Tedarik zinciri dersinde imaj imzalarında bunu tekrar göreceğiz.

## Rastgelelik

`Math.random()` hızlı ve istatistiksel olarak düzgündür, ama **tahmin edilebilir**. V8'in xorshift128+ üretecinin iç durumu, ardışık birkaç çıktıdan geri hesaplanabilir. Bundan sonraki bütün değerler bilinir. Oturum kimliği, parola sıfırlama jetonu, davet kodu, nonce ve anahtar için sadece `crypto.randomBytes`, `crypto.randomUUID` ve `crypto.getRandomValues` kullanılır. Kod incelemesinde güvenlik bağlamındaki her `Math.random` bir bulgudur.

Bir jetonun uzunluğu en az 128 bit olmalıdır. `randomBytes(32)` ile 256 bit tahmin edilemezlik elde edilir. Kısa kodlar (6 haneli e-posta doğrulama kodu gibi) ancak sıkı deneme sınırı ve kısa ömürle güvenlidir.

## TLS

TLS, ağ üzerindeki trafiğe gizlilik ve bütünlük katar ve sunucunun kimliğini doğrular. Uygulama geliştiricinin TLS hataları, protokolün kendisinden değil **doğrulamanın kapatılmasından** gelir. Yerel bir iç CA ve onun imzaladığı bir sunucu sertifikasıyla dört durumu deneyelim:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 30 -subj "/CN=Egitim Ic CA"
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout srv.key -out srv.csr -subj "/CN=api.egitim.test"
printf "subjectAltName=DNS:api.egitim.test,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in srv.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out srv.crt -days 7 -extfile ext.cnf
openssl x509 -in srv.crt -noout -subject -issuer -ext subjectAltName -dates
```

```text
subject=CN=api.egitim.test
issuer=CN=Egitim Ic CA
X509v3 Subject Alternative Name:
    DNS:api.egitim.test, DNS:localhost, IP Address:127.0.0.1
notBefore=Nov 26 11:07:42 2026 GMT
notAfter=Dec  3 11:07:42 2026 GMT
```

```js
// tls.mjs — sunucu ve istemci doğrulamasının dört durumu — sadece 127.0.0.1
import https from "node:https";
import fs from "node:fs";

const oku = (f) => fs.readFileSync(new URL(`./tls/${f}`, import.meta.url));
const sunucu = https.createServer({ key: oku("srv.key"), cert: oku("srv.crt"), minVersion: "TLSv1.2" },
  (req, res) => res.end("merhaba\n"));

function iste(ad, secenek) {
  return new Promise((ok) => {
    const r = https.get({ host: "127.0.0.1", port: 3443, path: "/", ...secenek }, (res) => {
      const s = res.socket;
      let g = ""; res.on("data", (d) => (g += d));
      res.on("end", () => { console.log(`${ad.padEnd(40)} OK  ${s.getProtocol()} ${s.getCipher().name}  yanıt=${g.trim()}`); ok(); });
    });
    r.on("error", (e) => { console.log(`${ad.padEnd(40)} HATA ${e.code}: ${e.message}`); ok(); });
  });
}

sunucu.listen(3443, "127.0.0.1", async () => {
  await iste("1) sistem güven deposu", {});
  await iste("2) iç CA verildi, servername=localhost", { ca: oku("ca.crt"), servername: "localhost" });
  await iste("3) iç CA verildi, servername yanlış", { ca: oku("ca.crt"), servername: "odeme.egitim.test" });
  await iste("4) rejectUnauthorized: false", { rejectUnauthorized: false, servername: "odeme.egitim.test" });
  sunucu.close();
});
```

```text
1) sistem güven deposu                   HATA UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca
2) iç CA verildi, servername=localhost   OK  TLSv1.3 TLS_AES_256_GCM_SHA384  yanıt=merhaba
3) iç CA verildi, servername yanlış      HATA ERR_TLS_CERT_ALTNAME_INVALID: Hostname/IP does not match certificate's altnames: Host: odeme.egitim.test. is not in the cert's altnames: DNS:api.egitim.test, DNS:localhost, IP Address:127.0.0.1
4) rejectUnauthorized: false             OK  TLSv1.3 TLS_AES_256_GCM_SHA384  yanıt=merhaba
```

TLS'in iki ayrı kontrolü var:

1. **Zincir:** Sertifika güvenilen bir CA'ya kadar doğrulanıyor mu? Durum 1'de iç CA bilinmediği için bağlantı reddedildi.
2. **Ad:** Sertifika **bağlandığım adı** içeriyor mu? Durum 3'te zincir geçerliydi, ama ad uyuşmadığı için bağlantı reddedildi.

Ad kontrolü olmadan, herhangi bir CA'dan **kendi alan adı** için geçerli sertifika alan herkes, araya girip (MITM) senin servisinmiş gibi davranabilir.

Durum 4 bu yüzden tehlikelidir. `rejectUnauthorized: false` (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, `verify=False`) her iki kontrolü de kapatır. Bağlantı yine "TLSv1.3, AES-256-GCM" der, şifreleme çalışır, ama **kiminle** konuştuğun artık bilinmez. Bu ayar "geçici olarak, sertifika sorununu çözene kadar" eklenir ve üretimde unutulur. Doğru çözüm durum 2'dir: İç CA'yı `ca` seçeneğiyle, `NODE_EXTRA_CA_CERTS` ile ya da `--use-system-ca` ile sistem deposundan güven listesine ekle.

TLS işletimi için ilkeler:

- **Sürüm:** En az TLS 1.2, tercihen 1.3. TLS 1.3'te zayıf şifre takımları zaten yoktur ve el sıkışması tek tur sürer. Modern tarayıcılar ve Node, anahtar değişiminde kuantum sonrası hibrit yöntemi (`X25519MLKEM768`) destekler. Bu yöntem, bugün kaydedilip yarın çözülmeye çalışılacak trafiğe ("şimdi topla, sonra çöz") karşı koruma sağlar. Aynı sunucuya Node 24 (OpenSSL 3.5) ile bağlanıp `socket.getEphemeralKeyInfo()` çağrıldığında, hibrit yöntemin varsayılan olarak seçildiği görülüyor: `{"type":"TLSGroup","name":"X25519MLKEM768"}`.
- **Sertifika ömrü kısalıyor.** CA/Browser Forum kararıyla genel sertifikaların azami ömrü 2026'da 200 güne iniyor, kademeli olarak 2029'da 47 güne düşecek. Elle yenileme artık bir seçenek değil. ACME (Let's Encrypt, cert-manager) ile otomatik yenile ve bitişe kalan süreyi izle.
- **İç trafik:** Servisler arası trafik de şifrelenir. "İç ağ güvenlidir" varsayımı SSRF dersinde çöktü. Servis ağı (Istio, Linkerd) mTLS'i ve sertifika döndürmeyi uygulamadan bağımsız olarak sağlar. mTLS ile her iki taraf da birbirini sertifikayla doğrular.
- **Özel anahtar:** Sertifikanın değil, **özel anahtarın** korunması esastır. Özel anahtarı imaja gömme, Git'e koyma. Sır yönetimi dersinin konusu bu.

```quiz
{
  "question": "Bir servis, kişisel verileri AES-256-GCM ile şifreliyor. Performans için nonce'u, servis başladığında rastgele üretip her şifrelemede bir artırıyor. Servis 6 kopya (pod) olarak çalışıyor ve hepsi aynı anahtarı kullanıyor. Sorun ne?",
  "options": [
    "Sorun yok, nonce rastgele başladığı için çakışmaz.",
    "Kopyaların sayaçları aynı aralıklardan geçebilir ve pod yeniden başladığında sayaç sıfırlanır. Aynı anahtar ve nonce çifti tekrar ederse düz metinler XOR'la ilişkilendirilir ve GCM'in kimlik doğrulama anahtarı sızar. Her şifrelemede rastgele nonce ya da kayıt başına DEK kullanılmalı.",
    "Sayaçlı nonce GCM'de desteklenmez.",
    "Sorun sadece performansla ilgili: 6 kopya aynı sayacı kilitlemek zorunda."
  ],
  "answer": 1,
  "explanation": "Sayaç ancak tek bir yerde tutulup asla geri dönmüyorsa güvenlidir. Paylaşılan anahtar ve dağıtık, yeniden başlayan sayaçlar çakışmayı olası kılar. Rastgele 96 bit nonce, zarf şifreleme ya da nonce'a dayanıklı modlar (AES-GCM-SIV, XChaCha20-Poly1305) kullanılmalı."
}
```

```quiz
{
  "question": "Bir analitik ekibi, kullanıcıları 'anonim' izlemek için olaylara `sha256(telefon_numarasi)` ekliyor. Bu veri bir analitik sağlayıcısına gönderiliyor. Değerlendirme?",
  "options": [
    "Hash geri döndürülemez, veri anonimdir.",
    "Türkiye'deki cep telefonu numaralarının uzayı küçüktür (yaklaşık 10^9–10^10). Bütün olası numaraların hash'i dakikalar içinde hesaplanır, değer geri bulunur. Bu takma adlandırma bile değildir. Gizli anahtarlı HMAC gerekir, veri yine de kişisel veri sayılır.",
    "SHA-256 yerine SHA-512 kullanılırsa anonim olur.",
    "Tuz eklenirse veri anonim olur ve paylaşılabilir."
  ],
  "answer": 1,
  "explanation": "Küçük uzaylı tanımlayıcıların hash'i sözlükle geri çevrilir. HMAC (anahtar kurumda kalır) takma adlandırmadır, anonimleştirme değildir. KVKK açısından veri kişisel veri olmaya devam eder (sonraki ders)."
}
```

```lab
{
  "title": "Kripto hatalarını kendin üret",
  "steps": [
    "kripto.mjs'te AES-256-GCM yerine 'aes-256-ctr' kullanan, etiketsiz bir sürüm yaz. Şifreli metnin belirli bir baytını XOR'layarak `85000` değerini `95000` yap ve çözmenin hatasız geçtiğini gör. Sonra GCM'de aynı denemenin neden başarısız olduğunu açıkla.",
    "Zarf şifrelemede 'ana anahtar döndürme' fonksiyonu yaz: Bütün sarılmış DEK'leri eski KEK ile çöz ve yeni KEK ile sar. Verinin kendisine hiç dokunulmadığını doğrula.",
    "Webhook doğrulamasına olay kimliği tekilleştirmesi ekle. Aynı kimlik 5 dakika içinde ikinci kez geldiğinde reddet. Zaman damgası penceresi ile tekilleştirmenin birlikte neden gerektiğini açıkla.",
    "tls.mjs'e istemci sertifikası (mTLS) ekle: Sunucuda `requestCert: true, ca: iç CA`, istemcide `cert/key` kullan. İç CA ile imzalanmış bir istemci sertifikası üret ve sertifikasız bağlantının reddedildiğini gör.",
    "Kendi kod tabanında `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`, `curl -k`, `verify=False`, `Math.random()` ve `createCipheriv('aes-...-ecb'` ya da sabit IV kullanımlarını ara."
  ]
}
```

## Özet

- Önce ihtiyacı belirle: hash, MAC, AEAD, imza, anahtar değişimi, CSPRNG. "Şifreledik" bütünlük demek değildir. "Hash'ledik" anonim demek değildir.
- Yeni kodda sadece AEAD kullan (AES-256-GCM, ChaCha20-Poly1305). Etiket doğrulanmadan çözülen veriyi kullanma. Kaydın kimliğini AAD'ye koy.
- Aynı anahtar altında nonce tekrarı, gizliliği ve bütünlüğü birlikte yıkar. Rastgele nonce, kayıt başına anahtar ya da nonce'a dayanıklı mod kullan.
- Anahtarlar KMS'te durmalı ve zarf şifreleme kullanılmalı: KEK dışarı çıkmaz, DEK kayıt başınadır. Döndürme ucuzdur, kripto-silme mümkündür, erişim denetlenir.
- İmza için Ed25519, webhook için HMAC kullan: ham gövde, `timingSafeEqual`, zaman damgası ve olay kimliği. Neyin imzalandığına dikkat et (özet, etiket değil).
- Güvenlik değerleri `crypto.randomBytes` ile üretilir. `Math.random` tahmin edilebilir.
- TLS'te zincir ve ad kontrolü birlikte yapılır. `rejectUnauthorized: false` kimlik doğrulamayı tamamen kapatır. İç CA'yı güven listesine ekle. Sertifika yenilemesini otomatikleştir, ömürler 47 güne iniyor.
