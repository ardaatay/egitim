# Gizli bilgi yönetimi, loglarda veri ve KVKK

Bir uygulamanın en değerli varlıkları kodu değil, kodun **eriştiği** şeylerdir: veritabanı parolası, ödeme sağlayıcısının anahtarı, bulut kimlik bilgileri ve müşterilerin kişisel verisi. Bu ders, iki soru üzerine kurulu:

- **Sırlar** nerede durmalı, nasıl dağıtılmalı, nasıl döndürülmeli?
- **Kişisel veri** loglara, yedeklere ve üçüncü taraflara nasıl sızar, KVKK bu konuda ne ister?

## Sırlar nerede sızar

### Git geçmişi

En yaygın sızıntı yolu depodur. Bir geliştirici `.env` dosyasını commit'liyor, sonra fark edip siliyor ve `.gitignore`'a ekliyor:

```sh
# gizli-git.sh (özet) — "sildim" sanılan anahtar
printf 'DB_HOST=db.ic\nDB_PAROLA=Cok$Gizli2026\nSTRIPE_KEY=sk_live_51Hc8EXAMPLEa9Xk2Qz\n' > .env
git add . && git commit -qm "ilk sürüm"
git rm -q --cached .env && printf '.env\n' > .gitignore && git add .gitignore
git commit -qm ".env kaldırıldı"

git ls-files
git log --oneline -S sk_live
git show HEAD~1:.env
git log -p --all | grep -nE '^\+.*(sk_live_[0-9A-Za-z]+|PAROLA=|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)'
```

```text
--- çalışma dizini ve son commit
.gitignore
app.js
--- geçmişte arama: git log -p -S sk_live
33572ff .env kaldırıldı
8b49707 ilk sürüm
--- o commit'teki dosya
DB_HOST=db.ic
DB_PAROLA=Cok$Gizli2026
STRIPE_KEY=sk_live_51Hc8EXAMPLEa9Xk2Qz
--- basit bir tarama: tüm geçmişteki eklenen satırlar
37:+DB_PAROLA=Cok$Gizli2026
38:+STRIPE_KEY=sk_live_51Hc8EXAMPLEa9Xk2Qz
```

Dosya son sürümden gitti, ama geçmişte duruyor. Depoyu klonlayan herkes, depo bir gün herkese açık yapılırsa herkes, ayrıca CI önbellekleri ve forklar bu değerleri okuyabilir. Herkese açık depolarda sızan anahtarlar otomatik tarayıcılarla dakikalar içinde bulunup kullanılıyor.

Sızan bir sır için sıra şudur:

1. **Önce döndür.** Anahtarı sağlayıcıda iptal et ve yenisini üret. Bu adım sızıntının zamanından bağımsız olarak **ilk** yapılır.
2. **Sonra kullanımı incele.** Sağlayıcının erişim loglarında, sızıntı ile iptal arasında anahtarın kullanılıp kullanılmadığına bak.
3. **En son geçmişi temizle** (Git kursundaki `filter-repo`). Bu adım bir hijyen işlemidir, güvenlik önlemi **değildir**. Temizlenen geçmiş, daha önce klonlanmış kopyalardan silinmez.

Önleme katmanları:

- **Commit öncesi:** Git kursunda yazdığımız pre-commit kancası ya da gitleaks/trufflehog gibi bir tarayıcı geliştiricinin makinesinde çalışır. Kanca atlanabilir (`--no-verify`), bu yüzden tek katman olamaz.
- **Push sırasında:** GitLab ve GitHub'ın sunucu tarafı push koruması (secret push protection) bilinen anahtar biçimlerini reddeder.
- **CI'da:** Bütün geçmişi tarayan bir iş, yeni MR'larda ve gece taramalarında çalışır.
- **Sağlayıcı tarafında:** Birçok sağlayıcı (AWS, Stripe, GitLab) herkese açık depolarda kendi anahtar biçimlerini tarar ve bulduklarını otomatik iptal eder. Anahtar biçimine bir önek konmasının (`sk_live_`, `glpat-`, `ghp_`) nedeni budur: Tespit kolaylaşır ve yanlış pozitif azalır.

### Diğer sızıntı yolları

| Yol | Örnek | Önlem |
|---|---|---|
| İmaj katmanları | `COPY . .` ile gelen `.env`, sonraki katmanda `rm` ile silinmesi | `.dockerignore`, build-time sırları için `--mount=type=secret` (Docker kursu) |
| Ortam değişkenleri | `/proc/<pid>/environ`, alt süreçlere miras (enjeksiyon dersindeki `DB_PAROLA`), hata sayfaları ve debug uç noktalarında `process.env` dökümü, `docker inspect` | Sırları dosyadan oku (bağlanmış birim). Alt süreçlere `env` seçeneğiyle sadece gerekeni ver |
| CI logları | `echo $DEPLOY_TOKEN`, `set -x`, hata ayıklama çıktısı | Maskelenmiş ve korumalı değişkenler (Git kursu). Logda sır bulma taraması |
| Loglar ve hata izleme | İstek gövdesi, `Authorization` başlığı, bağlantı dizgesi içeren hata mesajı | Aşağıdaki karartma bölümü |
| İstemci tarafı paket | `VITE_`/`NEXT_PUBLIC_` önekli değişkenler, paketlenmiş JS içindeki anahtar | Tarayıcıya giden her şey **herkese açıktır**. Sırlar sadece sunucuda |
| Kubernetes Secret | base64 bir şifreleme değildir. `get secret` yetkisi olan herkes okur. etcd şifrelenmemişse yedekte açık durur | RBAC ile `secrets` erişimini daralt, etcd şifrelemesini KMS ile aç, dış sır deposu kullan |

## Sır yönetimi

Hedef mimarinin dört özelliği var:

1. **Merkezi depo:** Vault, bulut sır yöneticileri (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault) ya da OpenBao. Erişim kimliğe bağlıdır ve her okuma denetim kaydına düşer.
2. **İş yükü kimliği:** Uygulama depoya **başka bir sırla** değil, platformun verdiği kimlikle bağlanır: Kubernetes ServiceAccount jetonu, IRSA/Workload Identity, CI'ın OIDC jetonu. "Sırrı açan sır" sorunu böyle çözülür.
3. **Teslim:** External Secrets Operator ya da Secrets Store CSI sürücüsü, sırrı depodan alıp pod'a **dosya** olarak bağlar. Değişikliklerde dosya güncellenir ve uygulama yeniden okur. Git'te şifreli sır tutmak gerekiyorsa SOPS (KMS anahtarıyla) ya da Sealed Secrets kullanılabilir. Bu durumda Git'te sadece şifreli metin durur.
4. **Kısa ömür ve döndürme:** En iyi sır, **dinamik** olanıdır. Vault'un veritabanı motoru her pod için ayrı, saatler içinde süresi dolan bir veritabanı kullanıcısı üretir. Bunun iki faydası var: Sızan kimlik bilgisi kısa sürede işe yaramaz hale gelir, ve hangi pod'un ne yaptığı veritabanı loglarında ayrışır. Statik sırlar ise otomatik döndürme ile yönetilir. İki sürüm bir süre birlikte geçerli kalır (eski ve yeni), uygulama yenisine geçince eskisi iptal edilir.

Pratikte uygulamanın sırrı nasıl okuduğu da önemlidir:

```js
// sırrı dosyadan oku; değişince yeniden yükle (CSI/ESO dosyayı günceller)
import fs from "node:fs";
const YOL = process.env.DB_PAROLA_DOSYASI ?? "/var/run/secrets/app/db-parola";
let dbParola = fs.readFileSync(YOL, "utf8").trim();
fs.watchFile(YOL, { interval: 30_000 }, () => {
  dbParola = fs.readFileSync(YOL, "utf8").trim();
  havuzuYenile();                         // yeni bağlantılar yeni parolayla
});
```

## Loglarda kişisel veri ve sır

Loglar, bir kuruluşta en geniş erişime sahip veri deposudur. Geliştiriciler, SRE ekibi, log platformu sağlayıcısı ve destek ekibi erişir, saklama süresi de çoğu zaman belirsizdir. Bir isteği "hata ayıklamak için" bütünüyle loglamak, parolaları ve kişisel verileri bu depoya taşır:

```text
KÖTÜ: {"yol":"/api/odeme","ip":"203.0.113.7","basliklar":{"authorization":"Bearer eyJhbGciOi...","user-agent":"curl/8.11"},"govde":{"eposta":"ayse.yilmaz@ornek.com","tckn":"10000000146","parola":"Yaz2026!","iban":"TR12 0006 4000 0011 2345 6789 01","siparis":98765432101}}
```

Karartma iki katmanlı yapılır. Hassas **alan adları** tamamen gizlenir. **Değer kalıpları** ise serbest metinde de aranır, çünkü hassas veri hata mesajlarının içine de girer:

```js
// log.mjs — alan bazlı karartma + değer bazlı tespit
const HASSAS_ALANLAR = /^(parola|password|sifre|token|jeton|authorization|cookie|set-cookie|secret|api[_-]?key|kart_no|cvv|iban)$/i;

// TCKN: 11 hane, ilk hane 0 değil, 10. ve 11. haneler kontrol hanesi
function tcknGecerli(s) {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const tek = d[0] + d[2] + d[4] + d[6] + d[8], cift = d[1] + d[3] + d[5] + d[7];
  const h10 = (((tek * 7 - cift) % 10) + 10) % 10;
  const h11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d[9] === h10 && d[10] === h11;
}
const DEGER_KALIPLARI = [
  [/\b(sk_live_|ghp_|glpat-|AKIA)[0-9A-Za-z_-]{8,}\b/g, () => "[SIR]"],
  [/\bTR\d{2}(?:\s?\d{4}){5}\s?\d{2}\b/g, () => "[IBAN]"],
  [/\b[1-9]\d{10}\b/g, (m) => (tcknGecerli(m) ? "[TCKN]" : m)],                 // kontrol hanesi tutmayanlar dokunulmaz
  [/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (m, a, b) => `${a}***@${b}`],
];

function karart(deger, anahtar = "") {
  if (HASSAS_ALANLAR.test(anahtar)) return "[GİZLİ]";
  if (typeof deger === "string") return DEGER_KALIPLARI.reduce((s, [re, f]) => s.replace(re, f), deger);
  if (Array.isArray(deger)) return deger.map((x) => karart(x));
  if (deger && typeof deger === "object")
    return Object.fromEntries(Object.entries(deger).map(([k, v]) => [k, karart(v, k)]));
  return deger;
}

const log = (seviye, mesaj, alanlar = {}) =>
  console.log(JSON.stringify({ zaman: "2026-11-26T11:20:00Z", seviye, mesaj: karart(mesaj), ...karart(alanlar) }));

log("info", "ödeme isteği", { istek });
log("error", "sağlayıcı hatası: key sk_live_51Hc8EXAMPLEa9Xk2Qz geçersiz, müşteri 10000000146 / 12345678901", {});
```

```text
{"zaman":"2026-11-26T11:20:00Z","seviye":"info","mesaj":"ödeme isteği","istek":{"yol":"/api/odeme","ip":"203.0.113.7","basliklar":{"authorization":"[GİZLİ]","user-agent":"curl/8.11"},"govde":{"eposta":"a***@ornek.com","tckn":"[TCKN]","parola":"[GİZLİ]","iban":"[GİZLİ]","siparis":98765432101}}}
{"zaman":"2026-11-26T11:20:00Z","seviye":"error","mesaj":"sağlayıcı hatası: key [SIR] geçersiz, müşteri [TCKN] / 12345678901"}
tcknGecerli: 10000000146=true 12345678901=false 98765432101=false
```

Bu çıktının iki ayrıntısı önemli:

- **Kontrol hanesi doğrulaması:** "11 haneli sayı" kalıbı sipariş numaralarını da yakalardı. TCKN'nin kontrol haneleri doğrulandığında, `98765432101` sipariş numarası dokunulmadan kaldı, geçerli kontrol haneli `10000000146` ise karartıldı. `12345678901` de geçersiz olduğu için bırakıldı. Bunun bedeli, geçersiz ama gerçek bir TCKN yazım hatasının loga düşebilmesidir. Yanlış pozitif ile yanlış negatif arasındaki bu dengeyi bilerek seç.
- **Mesaj metni de karartılmalı:** İlk yazdığımız sürüm sadece alanları karartıyordu. İkinci satır o sürümde `sk_live_51Hc8EXAMPLEa9Xk2Qz` ve `10000000146` değerlerini açık olarak logluyordu. Hassas veri genellikle hata mesajlarının ve istisna metinlerinin içinden sızar.

Değer kalıplarıyla tespit bir **güvenlik ağıdır**, birincil savunma değil. Birincil savunma, hassas veriyi loga **hiç koymamaktır**: Logda kayıt kimliği (`musteri_id=42`) yer alır, kişisel verinin kendisi yer almaz. Yapılandırılmış log kütüphaneleri (pino'nun `redact`, logback maskeleme) alan bazlı karartmayı yapılandırmayla sağlar. Log toplama hattına (Fluent Bit, Vector) eklenen bir tarama aşaması da uygulamanın kaçırdıklarını yakalar.

IP adresi, kullanıcı kimliği ve cihaz kimliği de kişisel veridir. Bunların loglanması meşru olabilir (güvenlik, dolandırıcılık tespiti), ama bu durumda **saklama süresi** belirlenir ve uygulanır. Süresiz saklanan güvenlik logları kendi başına bir risktir.

## KVKK: geliştiricinin bilmesi gerekenler

6698 sayılı Kişisel Verilerin Korunması Kanunu, bir hukuk metni olarak bu dersin konusu değil. Ama sistem tasarımında doğrudan karşılığı olan yükümlülükler getiriyor. Kesin yorum için kurumun hukuk birimi esastır. Aşağıdakiler, mühendislik açısından karşılıklardır:

| Kavram / yükümlülük | Sistemde karşılığı |
|---|---|
| **İlkeler:** amaçla bağlantılı, sınırlı ve ölçülü işleme. Gerekli süre kadar saklama | Veri minimizasyonu: Formda sorulmayan veri sızamaz. Her tablo ve alan için amaç ve saklama süresi |
| **İşleme şartları:** açık rıza her işlemin dayanağı değildir. Sözleşmenin ifası, kanuni yükümlülük, meşru menfaat de dayanaktır | Rıza gereken işlemler (pazarlama gibi) için rızanın kaydı, kapsamı, zamanı ve geri alınabilmesi |
| **Özel nitelikli veri:** sağlık, biyometrik, din ve ceza mahkûmiyeti gibi veriler | Ayrı şifreleme anahtarı, daha dar erişim, erişim logları. Kurulun belirlediği ek önlemler |
| **Veri güvenliği:** gerekli teknik ve idari tedbirler (m.12) | Bu kursun tamamı: erişim kontrolü, şifreleme, loglama, yedek güvenliği, sızma testi |
| **Saklama ve imha:** süre dolunca silme, yok etme ya da anonim hale getirme. Periyodik imha | Zamanlanmış silme işleri, yedeklerde kripto-silme (kripto dersindeki kayıt başına anahtar), loglarda saklama politikası |
| **İlgili kişinin hakları:** bilgi talebi, düzeltme, silme | "Bu kişiye ait bütün veriyi bul ve dışa aktar ya da sil" sorgusunu yanıtlayabilen bir veri haritası |
| **Veri ihlali bildirimi** | Kurul kararına göre ihlal öğrenildikten sonra **72 saat** içinde Kurula bildirim, etkilenenlere de makul sürede bildirim. Olay müdahale dersinin konusu |
| **Yurt dışına aktarım** (2024 değişikliği) | Yeterlilik kararı yoksa uygun güvenceler, örneğin standart sözleşme. Standart sözleşme imzalandıktan sonra 5 iş günü içinde Kurula bildirilir. Bulut bölgesi, log platformu, hata izleme ve analitik sağlayıcısının konumu bu kapsama girer |

Mühendislik açısından en sık atlanan noktalar şunlar:

- **Kopyalar:** Üretim verisinin test ve geliştirme ortamlarına kopyalanması. Bu veri, üretimin erişim kontrolünü kaybeder. Test için sentetik ya da maskelenmiş veri kullan. Maskeleme, ilişkileri koruyacak şekilde deterministik olabilir. Örneğin anahtarlı HMAC ile takma adlandırma.
- **Üçüncü taraflar:** Hata izleme (Sentry gibi), analitik ve log platformlarına giden olaylar kişisel veri içerir. Bu servisler veri işleyendir ve yurt dışındaysa aktarım kuralları geçerlidir. Gönderilen veriyi istemci tarafında karart.
- **"Anonim" iddiası:** Hash'lenmiş telefon numarası ya da IP adresi anonim değildir (kripto dersinin sınavı). Takma adlandırılmış veri hâlâ kişisel veridir. Gerçek anonimleştirme, toplulaştırma ve küçük grupların bastırılması gibi yöntemler gerektirir.
- **Silme:** "Kullanıcıyı sil" düğmesi birincil veritabanından siler. Peki ya arama indeksi, önbellek, olay akışı (Kafka konusu), veri ambarı, yedekler ve loglar? Silme işlemi veri haritasındaki bütün kopyalara yayılmalıdır. Yedekler için kripto-silme pratik tek yoldur.

```quiz
{
  "question": "Bir geliştirici, herkese açık bir depoya yanlışlıkla bulut erişim anahtarı içeren bir commit gönderiyor ve 10 dakika sonra fark ediyor. İlk yapılması gereken nedir?",
  "options": [
    "`git filter-repo` ile geçmişi temizleyip force push yapmak.",
    "Depoyu gizli yapmak.",
    "Anahtarı sağlayıcıda hemen iptal edip yenisini üretmek, ardından sızıntı ile iptal arasındaki kullanımı loglardan incelemek. Geçmiş temizliği en son ve sadece hijyen amaçlı yapılır.",
    "Anahtarı .gitignore'a eklemek."
  ],
  "answer": 2,
  "explanation": "Herkese açık depolardaki anahtarlar dakikalar içinde otomatik tarayıcılar tarafından bulunur. Geçmişi temizlemek klonlanmış kopyaları ve önbellekleri silmez. Tek güvenilir önlem anahtarın geçersiz kılınmasıdır."
}
```

```quiz
{
  "question": "Bir ekip, sırlarını Kubernetes Secret'larına koyup ortam değişkeni olarak pod'lara veriyor ve 'Secret'lar şifreli' diyor. Hangi ifade doğru?",
  "options": [
    "Doğru. Kubernetes Secret'ları varsayılan olarak şifrelidir.",
    "Secret verisi base64 ile kodlanır, şifrelenmez. etcd'de şifreleme ayrıca yapılandırılmadıysa açık durur. `get secret` yetkisi olan herkes ve pod'a exec yapabilen herkes okur. Ortam değişkeni olarak verilmesi alt süreçlere miras, hata dökümü ve `/proc` gibi ek sızıntı yolları açar.",
    "Ortam değişkeni olarak verilen sırlar sadece root tarafından okunabilir.",
    "Base64 kırılması zor bir kodlamadır."
  ],
  "answer": 1,
  "explanation": "Kubernetes Secret bir erişim kontrolü nesnesidir, kriptografik bir koruma değildir. etcd şifrelemesini KMS sağlayıcısıyla aç, RBAC'ı daralt, mümkünse dış sır deposu ve dosya bağlama kullan."
}
```

```lab
{
  "title": "Sır ve kişisel veri sızıntılarını avla",
  "steps": [
    "gizli-git.sh'i çalıştır. Ardından aynı depoda `git filter-branch` ya da `filter-repo` ile .env'i geçmişten temizle. Temizlemeden önce yapılmış bir klonda sırrın hâlâ durduğunu doğrula.",
    "Kendi bir deponda tüm geçmişi tarayan bir komut yaz: `git log -p --all` çıktısında bilinen anahtar önekleri, `-----BEGIN ... PRIVATE KEY` ve `parola=`/`password=` kalıpları. Bulguları yanlış pozitif ve gerçek olarak ayır.",
    "log.mjs'e kart numarası tespiti ekle: 13–19 haneli dizilerde Luhn kontrolü yap ve sadece Luhn'u tutanları `[KART]` ile değiştir. Sipariş numaralarının yanlışlıkla karartılmadığını test et.",
    "Bir Node uygulamasında hata yakalayıcının (error handler) istemciye ve loga ne gönderdiğini incele. İstisna mesajına bağlantı dizgesi (`postgres://kullanici:parola@...`) giren bir hata oluştur ve her iki çıktıda da parolanın görünmediğinden emin ol.",
    "Çalıştığın bir sistem için küçük bir veri haritası çıkar: Bir müşterinin e-posta adresi hangi tablolarda, indekslerde, kuyruklarda, loglarda, yedeklerde ve üçüncü taraf servislerde bulunuyor? Silme talebinde bunların her biri nasıl temizlenir?"
  ]
}
```

## Özet

- Git'ten silinen sır geçmişte kalır. Sızıntıda sıra: döndür, kullanımı incele, geçmişi temizle. Önleme dört katmanlıdır: commit öncesi kanca, sunucu tarafı push koruması, CI taraması ve sağlayıcı taraması.
- Sırlar imaj katmanlarından, ortam değişkenlerinden, CI loglarından, istemci paketinden ve base64 Kubernetes Secret'larından da sızar.
- Hedef mimari: merkezi depo, iş yükü kimliğiyle erişim, dosya olarak teslim, kısa ömürlü ya da otomatik döndürülen sırlar.
- Loglar en geniş erişimli veri deposudur. Hassas veriyi loga koyma. Alan bazlı karartma ve değer kalıbıyla tespit (TCKN için kontrol hanesi) uygula, mesaj metnini de karart, saklama süresi belirle.
- KVKK'nın mühendislik karşılıkları: minimizasyon, amaç ve saklama süresi, özel nitelikli veri için ek önlemler, kopyalara yayılan silme (yedeklerde kripto-silme), 72 saatlik ihlal bildirimi, yurt dışı aktarımda üçüncü taraf servislerin konumu.
