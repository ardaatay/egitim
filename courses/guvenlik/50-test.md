# Güvenlik testi: tehdit modelinden sızma testine

Önceki derslerde her açığı elle bulduk ve elle doğruladık. Gerçek bir kod tabanında bu ölçeklenmez: Yüzlerce uç nokta, her gün onlarca değişiklik ve bağımlılıkların bağımlılıkları var. Bu ders, güvenlik doğrulamasını **sürekli ve otomatik** hale getiren katmanları ele alıyor. Ayrıca otomasyonun bulamadıklarını bulan insan odaklı testleri inceliyor.

## Katmanlar ve neyi bulurlar

| Katman | Ne zaman | Neyi bulur | Neyi bulamaz |
|---|---|---|---|
| **Tehdit modeli** (ilk ders) | Tasarımda | Eksik kontroller, güven sınırları, iş mantığı riskleri | Kodlama hataları |
| **Güvenlik birim/entegrasyon testleri** | Her commit | Yetki matrisi, kiracı sınırı, girdi doğrulama gibi **bilinen** kurallar | Hiç düşünülmemiş durumlar |
| **Özellik tabanlı test ve fuzzing** | Her commit / gece | Ayrıştırıcılardaki ve doğrulayıcılardaki köşe durumlar | İş kuralı ihlalleri |
| **SAST** | MR | Bilinen güvensiz kalıplar (veri akışı: kaynaktan hedefe) | Yetkilendirme mantığı, yapılandırma |
| **Sır, bağımlılık ve imaj taraması** | MR + sürekli | Sızmış sırlar, bilinen CVE'ler | Sıfırıncı gün açıklar, zararlı paketler (kısmen) |
| **DAST** | Çalışan ortamda | Başlık eksikleri, yansıyan XSS, açık uç noktalar, yanlış yapılandırma | Kimlik doğrulama arkasındaki derin akışlar (kısmen) |
| **Sızma testi / kırmızı takım** | Periyodik, büyük değişikliklerde | Zincirlenmiş açıklar, iş mantığı, yaratıcı saldırılar | Süreklilik yoktur, testin yapıldığı anı gösterir |
| **Hata ödül programı / VDP** | Sürekli | Dışarıdan bakan çok sayıda göz | Kapsam dışı sistemler |

Tablonun ana mesajı: Hiçbir katman tek başına yeterli değildir, her katman bir öncekinin kör noktasını kapatır. Yetkilendirme hataları, yani OWASP'ın bir numarası, SAST ve DAST'ın en zayıf olduğu alandır. Bu hatalar en iyi **senin yazdığın testlerle** yakalanır.

## Yetki matrisi testi

Yetkilendirme dersinin laboratuvarında önerdiğimiz testi yazalım. "Kim neye erişebilmeli" tablosunun her hücresi bir test:

```js
// yetki.test.mjs — yetki matrisi testi: her hücre bir test
import { test } from "node:test";
import assert from "node:assert/strict";

const URL_ = process.env.HEDEF ?? "http://127.0.0.1:3032";
const iste = (jeton, yontem, yol, govde) =>
  fetch(URL_ + yol, { method: yontem, headers: { authorization: `Bearer ${jeton}` }, body: govde && JSON.stringify(govde) })
    .then(async (r) => ({ durum: r.status, govde: await r.json() }));

// [açıklama, jeton, yöntem, yol, gövde, beklenen durum kodu]
const MATRIS = [
  ["developer kendi kiracısının faturasını okur", "j-mehmet", "GET", "/faturalar/1001", null, 200],
  ["developer başka kiracının faturasını okuyamaz", "j-mehmet", "GET", "/faturalar/1002", null, 404],
  ["admin başka kiracının faturasını okuyamaz", "j-ayse", "GET", "/faturalar/1002", null, 404],
  ["developer kendi adını değiştirir", "j-mehmet", "PATCH", "/kullanicilar/2", { ad: "Mehmet K." }, 200],
  ["developer kendine rol atayamaz", "j-mehmet", "PATCH", "/kullanicilar/2", { rol: "admin" }, 400],
  ["başka kiracının admini kullanıcı güncelleyemez", "j-zeynep", "PATCH", "/kullanicilar/1", { eposta: "x@globex.com" }, 404],
  ["developer kullanıcı silemez", "j-mehmet", "DELETE", "/yonetim/kullanicilar/1", null, 404],
  ["başka kiracının admini kullanıcı silemez", "j-zeynep", "DELETE", "/yonetim/kullanicilar/1", null, 404],
];

for (const [ad, jeton, yontem, yol, govde, beklenen] of MATRIS) {
  test(ad, async () => {
    const { durum } = await iste(jeton, yontem, yol, govde);
    assert.equal(durum, beklenen);
  });
}
```

Aynı test, yetkilendirme dersindeki sunucunun iki sürümüne karşı çalıştırılıyor:

```bash
HEDEF=http://127.0.0.1:3031 node --test --test-reporter=spec yetki.test.mjs   # açıklı
HEDEF=http://127.0.0.1:3032 node --test --test-reporter=spec yetki.test.mjs   # düzeltilmiş
```

```text
##### açıklı (3031)
✔ developer kendi kiracısının faturasını okur (47.7769ms)
✖ developer başka kiracının faturasını okuyamaz (4.5991ms)
✖ admin başka kiracının faturasını okuyamaz (3.1752ms)
✔ developer kendi adını değiştirir (5.9404ms)
✖ developer kendine rol atayamaz (3.4164ms)
✖ başka kiracının admini kullanıcı güncelleyemez (2.6323ms)
✖ developer kullanıcı silemez (3.1956ms)
✖ başka kiracının admini kullanıcı silemez (2.0348ms)
ℹ tests 8
ℹ pass 2
ℹ fail 6
##### düzeltilmiş (3032)
✔ developer kendi kiracısının faturasını okur (41.6212ms)
✔ developer başka kiracının faturasını okuyamaz (3.633ms)
✔ admin başka kiracının faturasını okuyamaz (2.1664ms)
✔ developer kendi adını değiştirir (5.9202ms)
✔ developer kendine rol atayamaz (4.3158ms)
✔ başka kiracının admini kullanıcı güncelleyemez (3.4828ms)
✔ developer kullanıcı silemez (2.2057ms)
✔ başka kiracının admini kullanıcı silemez (2.9485ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

Matrisin iki özelliği önemli:

- **Olumsuz testler**, yani "yapamamalı" satırları, olumlu testler kadar önemlidir. Fonksiyonel testler neredeyse her zaman sadece "yapabilmeli" satırlarını içerir. Bu yüzden yetki hataları fonksiyonel testlerden geçer.
- Matris **büyüdükçe kendiliğinden genişlemeli**. Uç nokta listesi OpenAPI şemasından, roller ve kiracılar test verisinden üretilirse, yeni eklenen bir uç nokta da otomatik olarak "başka kiracının jetonuyla" denenir. Bu sayede yeni uç nokta yetki kontrolünü unutsa bile test yakalar.

## Özellik tabanlı test ve fuzzing

Örnek tabanlı testler, yazanın düşündüğü durumları dener. **Özellik tabanlı** test bunun yerine her girdi için doğru olması gereken bir özellik tanımlar ve onu çok sayıda üretilmiş girdiyle sınar. Enjeksiyon dersindeki dosya yolu kontrolünü düşünelim. İki sürümü de ilk bakışta doğru görünüyor:

```js
// fuzz.test.mjs — "dizin dışına çıkılamaz" özelliğini rastgele girdilerle sına
import { test } from "node:test";
import assert from "node:assert/strict";
import { posix as path } from "node:path";   // platformdan bağımsız, tekrarlanabilir sonuç

const KOK = path.resolve("/srv/raporlar");

// İncelemeden geçmiş, "güvenli" görünen iki sürüm
const kontrolA = (girdi) => { const y = path.resolve(KOK, girdi); return y.startsWith(KOK) ? y : null; };
const kontrolB = (girdi) => { const y = path.resolve(KOK, girdi); return y.startsWith(KOK + path.sep) ? y : null; };

// Tohumlu (tekrarlanabilir) rastgele üreteç: mulberry32
function prng(tohum) {
  return () => { tohum |= 0; tohum = (tohum + 0x6d2b79f5) | 0; let t = Math.imul(tohum ^ (tohum >>> 15), 1 | tohum);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PARCALAR = ["..", ".", "kasim.txt", "raporlar", "raporlar-eski", "srv", "", "a", "%2e%2e"];

function fuzz(kontrol, tohum, n = 5000) {
  const r = prng(tohum);
  for (let i = 0; i < n; i++) {
    const uzunluk = 1 + Math.floor(r() * 4);
    const girdi = Array.from({ length: uzunluk }, () => PARCALAR[Math.floor(r() * PARCALAR.length)]).join("/");
    const sonuc = kontrol(girdi);
    // Özellik: kabul edilen yol KOK'un kendisi ya da altında olmalı (dışarı çıkmamalı)
    if (sonuc !== null && sonuc !== KOK && !sonuc.startsWith(KOK + path.sep)) return { deneme: i + 1, girdi, sonuc };
  }
  return null;
}

test("kontrolA: startsWith(KOK)", () => {
  const bulgu = fuzz(kontrolA, 2026);
  assert.equal(bulgu, null, `özellik bozuldu: ${JSON.stringify(bulgu)}`);
});

test("kontrolB: startsWith(KOK + sep)", () => {
  const bulgu = fuzz(kontrolB, 2026);
  assert.equal(bulgu, null, `özellik bozuldu: ${JSON.stringify(bulgu)}`);
});
```

```bash
node --test --test-reporter=spec fuzz.test.mjs
```

```text
✖ kontrolA: startsWith(KOK) (2.7646ms)
✔ kontrolB: startsWith(KOK + sep) (9.8059ms)
ℹ tests 2
ℹ pass 1
ℹ fail 1

✖ failing tests:

test at fuzz.test.mjs:31:1
✖ kontrolA: startsWith(KOK) (2.7646ms)
  AssertionError [ERR_ASSERTION]: özellik bozuldu: {"deneme":96,"girdi":"./../raporlar-eski","sonuc":"/srv/raporlar-eski"}
```

96\. denemede `./../raporlar-eski` bulundu. `/srv/raporlar-eski` metni `/srv/raporlar` ile başladığı için kontrolA onu kabul etti. Enjeksiyon dersinde ayırıcının neden gerekli olduğunu açıklamıştık. Burada test bu hatayı **kendisi** buldu. Tohum sabit olduğu için bulgu her çalıştırmada tekrar üretilebilir ve bir hata kaydına doğrudan eklenebilir.

Bu örnek bilinçli olarak basit tutuldu: Girdi üreteci, ilgili parçalardan oluşan küçük bir alfabe. Gerçekte bu iş için hazır araçlar kullanılır:

- **fast-check:** JavaScript için özellik tabanlı test kütüphanesi. Bulduğu hatalı girdiyi otomatik olarak **küçültür** (shrinking) ve en kısa örneği raporlar.
- **Kapsam güdümlü fuzzer'lar** (Jazzer.js, libFuzzer, Go'nun yerleşik `go test -fuzz` aracı, AFL++): Kodun hangi dallarına girildiğini izleyerek girdiyi evrimleştirir. Ayrıştırıcılarda, sıkıştırma ve resim kütüphanelerinde ve protokol işleyicilerinde en verimli yöntemdir. OSS-Fuzz projesi bu yöntemle on binlerce hata buldu.

Fuzzing'in en iyi hedefleri, **güvenilmeyen girdiyi ayrıştıran** fonksiyonlardır: URL ve yol doğrulayıcıları, dosya biçimi okuyucuları, şablon motorları, JWT/JSON/XML ayrıştırıcıları ve özel protokoller.

## SAST: bilinen kalıplar, özel kurallar

Hazır SAST şablonlarını (GitLab'ın Secret Detection, SAST ve Dependency Scanning işleri) Git kursunda CI'a eklemiştik. Hazır kurallar genel kalıpları bulur. Asıl değer, **kurumun kendi** tekrarlayan hatalarını kurala çevirmektir. Bu kurstaki açıklardan iki örnek, Semgrep kuralı olarak:

```yaml
# .semgrep/node-enjeksiyon.yml
rules:
  - id: sql-sablon-dizgesi
    languages: [javascript, typescript]
    severity: ERROR
    message: SQL metni şablon dizgesiyle kuruluyor; bind değişkeni (?) kullan
    pattern-either:
      - pattern: $DB.prepare(`...${$X}...`)
      - pattern: $DB.query(`...${$X}...`)
  - id: exec-kabuk-ile
    languages: [javascript, typescript]
    severity: ERROR
    message: exec kabuk üzerinden çalışır; execFile/spawn ve argüman dizisi kullan
    pattern-either:
      - pattern: exec(`...${$X}...`, ...)
      - pattern: $CP.exec(`...${$X}...`, ...)
      - pattern: $CP.spawn($CMD, $ARGS, {..., shell: true, ...})
```

> **Not:** Semgrep bu ortamda kurulu olmadığı için bu kurallar çalıştırılmadı. Kural sözdizimi Semgrep'in JavaScript desen dilini izliyor. Kendi ortamında `semgrep scan --config .semgrep/ --test` ile, açıklı ve düzeltilmiş örnek dosyalara karşı doğrula.

SAST'ı verimli kullanmanın üç kuralı var:

1. **Yanlış pozitifi yönet.** Gürültülü bir araç kısa sürede yok sayılır. Yeni kuralları önce "uyarı" modunda çalıştır, yanlış pozitif oranını ölç, sonra "engelleme" moduna al.
2. **Sadece yeni bulguyu engelle.** Eski kod tabanındaki yüzlerce bulgu bir başlangıç çizgisi (baseline) olarak kaydedilir. MR yalnızca **eklediği** bulgularla engellenir, eskiler ayrı bir iş listesinde azaltılır.
3. **Bulgunun yeri MR olmalı.** Gece çalışan ve kimsenin bakmadığı bir panoya düşen bulgu düzeltilmez. Bulgu, değişikliği yapan kişinin MR'ında satır yorumu olarak görünmelidir.

## DAST: çalışan uygulamaya dışarıdan bakmak

DAST, uygulamayı bir saldırgan gibi HTTP üzerinden tarar. Uygulamanın yanında yeni bir MR için açılan inceleme ortamına (review app) karşı çalıştırmak, üretime dokunmadan her değişikliği test etmeyi sağlar:

```yaml
stages: [test, guvenlik, inceleme, dast]

include:
  - template: Jobs/Secret-Detection.gitlab-ci.yml
  - template: Jobs/SAST.gitlab-ci.yml
  - template: Jobs/Dependency-Scanning.gitlab-ci.yml

guvenlik-testleri:
  stage: guvenlik
  image: $CI_REGISTRY/sirket/platform/arac-imajlari/node:24
  script:
    - npm ci --ignore-scripts
    - node --test --test-reporter=junit --test-reporter-destination=guvenlik.xml test/guvenlik/
  artifacts:
    when: always
    reports:
      junit: guvenlik.xml
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

semgrep-ozel:
  stage: guvenlik
  image: $CI_REGISTRY/sirket/platform/arac-imajlari/semgrep:1
  script:
    - semgrep scan --config .semgrep/ --error --json --output semgrep.json
  artifacts:
    when: always
    paths: [semgrep.json]
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

inceleme-ortami:
  stage: inceleme
  script:
    - ./deploy.sh "inceleme-$CI_MERGE_REQUEST_IID"
  environment:
    name: inceleme/$CI_MERGE_REQUEST_IID
    url: https://mr-$CI_MERGE_REQUEST_IID.inceleme.sirket.com
    on_stop: inceleme-kapat
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

inceleme-kapat:
  stage: inceleme
  script:
    - ./deploy.sh --sil "inceleme-$CI_MERGE_REQUEST_IID"
  environment:
    name: inceleme/$CI_MERGE_REQUEST_IID
    action: stop
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      when: manual
      allow_failure: true

zap-taban:
  stage: dast
  image: $CI_REGISTRY/sirket/platform/arac-imajlari/zap:2
  needs: [inceleme-ortami]
  script:
    - zap-baseline.py -t "https://mr-$CI_MERGE_REQUEST_IID.inceleme.sirket.com" -c .zap/kurallar.tsv -J zap.json -I
  artifacts:
    when: always
    paths: [zap.json]
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

Bu dosya, Git kursundaki yapı kontrolünden (YAML, aşamalar ve `needs`) geçti. Canlı bir GitLab'da çalıştırılmadı. Birkaç seçimin gerekçesi:

- **`zap-baseline`** pasif bir taramadır. Sayfaları gezer, yanıtları inceler (eksik başlıklar, çerez öznitelikleri, bilgi sızıntısı), ama saldırı yükü **göndermez**. Her MR için güvenle çalışır. Aktif tarama (`zap-full-scan`) ise gerçekten enjeksiyon dener. Sadece yalıtılmış bir ortamda ve gece gibi zamanlarda çalıştırılır. **Asla** üretime ya da başkasının sistemine karşı çalıştırılmaz.
- `.zap/kurallar.tsv` hangi kuralların hata, hangilerinin uyarı olduğunu ve hangilerinin yok sayıldığını belirler. Yok sayma kararları gerekçesiyle bu dosyada yaşar ve kod incelemesinden geçer.
- Kimlik doğrulama arkasındaki sayfalar için DAST'a bir test kullanıcısının oturumu verilir. Bu kullanıcının yetkileri ve verisi de test verisi olmalıdır.
- Kendi güvenlik testlerin JUnit raporu olarak MR'da görünür. Başarısız bir yetki testi, diğer testler gibi birleştirmeyi durdurur.

## Sızma testi ve hata ödülü

Otomasyon, bilinen hata **sınıflarını** bulur. Deneyimli bir insan ise farklı bir şey yapar: Küçük bulguları **zincirler**. Örneğin bir açık yönlendirme, bir SSRF ve metadata servisi bir araya geldiğinde bulut hesabının ele geçirilmesine dönüşür. İnsan ayrıca iş mantığını anlar ("indirim kodu iki kez uygulanabiliyor"). Sızma testinden değer almak için:

- **Yazılı yetki ve kapsam:** Hangi sistemler, hangi IP'ler, hangi tarihler, hangi teknikler (sosyal mühendislik, DoS hariç gibi), acil durumda kime ulaşılacağı. Kursun girişinde belirttiğimiz gibi, yetkisiz test Türk Ceza Kanunu'nun 243–245. maddeleri kapsamında suçtur. "Kendi sistemimiz" denilen bulut kaynaklarında bile, sağlayıcının sızma testi politikası okunmalıdır.
- **Beyaz kutu daha verimlidir:** Test ekibine kaynak koda, mimari belgelerine ve tehdit modeline erişim ver. Siyah kutu test, kısıtlı sürenin çoğunu keşfe harcar.
- **Bulgular bir iş listesidir:** Her bulgu önem derecesine göre bir **düzeltme süresiyle** (SLA) kaydedilir. Örneğin kritik 7 gün, yüksek 30 gün. Düzeltme yeniden test edilerek kapatılır. Aynı bulgu sınıfı tekrar ediyorsa, düzeltme tek bir yer değil **bir kalıptır**: kural, kütüphane ya da varsayılan.

Dışarıdan gelen raporlar için bir kapı açık olmalıdır. Bir **açıklama politikası** (VDP) ve `/.well-known/security.txt` (RFC 9116) dosyası, iyi niyetli araştırmacının raporunu nereye ve nasıl göndereceğini söyler:

```text
Contact: mailto:guvenlik@ornek.com
Expires: 2027-11-30T00:00:00.000Z
Encryption: https://ornek.com/.well-known/pgp-key.txt
Policy: https://ornek.com/guvenlik/aciklama-politikasi
Preferred-Languages: tr, en
```

Hata ödül programı (bug bounty), VDP'nin bir sonraki adımıdır. Öncesinde iç süreçlerin, yani raporu sınıflandırma ve düzeltme süreçlerinin işliyor olması gerekir. Aksi halde gelen rapor seli ekibi boğar.

```quiz
{
  "question": "Bir ekibin SAST, DAST, bağımlılık ve sır taraması CI'da çalışıyor, hepsi yeşil. Yine de bir sızma testinde 'başka kiracının faturası okunabiliyor' bulgusu çıkıyor. En olası açıklama ve doğru önlem hangisi?",
  "options": [
    "Araçlardan biri yanlış yapılandırılmış. Doğru yapılandırılsaydı bulurdu.",
    "Yetkilendirme hataları iş kuralına bağlıdır. Hangi kullanıcının hangi kaydı görmesi gerektiğini otomatik araçlar bilemez. Önlem, olumsuz satırları da içeren ve uç nokta listesiyle kendiliğinden genişleyen bir yetki matrisi testidir.",
    "DAST'ı aktif tarama moduna almak bu hatayı bulur.",
    "Daha fazla SAST kuralı eklemek yeterlidir."
  ],
  "answer": 1,
  "explanation": "SAST veri akışını, DAST bilinen saldırı kalıplarını görür. 'Bu fatura bu kullanıcıya ait mi' sorusu iş mantığıdır. Bu sınıf için en etkili araç, iki kiracılı test verisiyle çalışan olumsuz yetki testleridir."
}
```

```quiz
{
  "question": "Bir geliştirici, yerel makinesinden bir müşterinin üretim API'sine karşı `zap-full-scan` çalıştırmayı öneriyor: 'Müşterinin güvenliği için iyi olur.' Doğru yaklaşım hangisi?",
  "options": [
    "Pasif tarama olduğu için sorun yoktur.",
    "Aktif tarama gerçek saldırı yükleri gönderir. Veri bozabilir, hizmeti etkileyebilir ve yetkisiz yapıldığında suçtur (TCK 243–245). Yazılı yetki ve kapsam olmadan yapılmaz. Kendi sistemlerimizde de sadece yalıtılmış bir test ortamında çalıştırılır.",
    "Gece yapılırsa sorun olmaz.",
    "VPN üzerinden yapılırsa iz bırakmadığı için sorun olmaz."
  ],
  "answer": 1,
  "explanation": "Güvenlik testinin ilk koşulu yetkidir. zap-full-scan aktif bir saldırıdır. zap-baseline ise pasiftir ve kendi inceleme ortamlarımızda her MR'da güvenle çalışır."
}
```

```lab
{
  "title": "Kendi güvenlik test paketini kur",
  "steps": [
    "Yetkilendirme dersindeki sunucuya bir liste uç noktası (`GET /faturalar`) ekle ve yetki matrisine 'liste başka kiracının kaydını içermemeli' testini yaz. Önce testi açıklı bir uygulamayla kırmızıya, sonra düzeltmeyle yeşile çevir.",
    "fuzz.test.mjs'e SSRF dersindeki adres kontrolü için bir özellik ekle: Üretilen URL'lerin (farklı IP yazımları: ondalık, onaltılık, IPv6, `localhost` varyantları) hiçbiri, yasak bir adrese çözüldüğü halde kabul edilmemeli. Üretici alfabesini genişleterek ilk sürümde bir atlatma bulmaya çalış.",
    "Bu dersteki Semgrep kurallarını kur ve `semgrep scan --config .semgrep/` ile enjeksiyon dersindeki enjeksiyon.mjs dosyasına karşı çalıştır. Her iki kuralın da açıklı satırları bulduğunu, düzeltilmiş satırları ise bulmadığını doğrula.",
    "Bir inceleme ortamına (ya da yerelde çalışan bir uygulamaya) karşı ZAP baseline taramasını çalıştır. Çıkan uyarıları XSS dersindeki başlıklarla (CSP, nosniff, HSTS, çerez öznitelikleri) eşleştir.",
    "Kuruluşunun web sitesinde `/.well-known/security.txt` var mı? Yoksa bir taslak ve kısa bir açıklama politikası metni hazırla: kapsam, güvenli liman maddesi, yanıt süresi."
  ]
}
```

## Özet

- Güvenlik doğrulaması katmanlıdır: tehdit modeli, güvenlik testleri, özellik tabanlı test ve fuzzing, SAST, tarayıcılar, DAST, sızma testi ve VDP. Her katman bir öncekinin kör noktasını kapatır.
- Yetkilendirme hataları otomatik araçların en zayıf olduğu alandır. Olumsuz satırları da içeren ve kendiliğinden genişleyen bir yetki matrisi testi yaz.
- Özellik tabanlı test, düşünülmemiş girdileri bulur. Bu derste sabit tohumlu basit bir üreteç, `startsWith` hatasını 96. denemede buldu. Ayrıştırıcılar için kapsam güdümlü fuzzer kullan.
- SAST'ın değeri kurumun kendi hata kalıplarını kurala çevirmektir. Yanlış pozitifi ölç, sadece yeni bulguyu engelle, bulguyu MR'da göster.
- DAST'ın pasif taraması (`zap-baseline`) her MR'da inceleme ortamına karşı çalışabilir. Aktif tarama yalnızca yalıtılmış ortamda ve yetkiyle yapılır.
- Sızma testi yazılı yetki ve kapsamla, mümkünse beyaz kutu olarak yapılır. Bulgular SLA'lı bir iş listesidir. `security.txt` ve VDP, dışarıdan gelen raporlar için kapıyı açar.
