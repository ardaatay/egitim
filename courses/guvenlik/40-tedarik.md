# Tedarik zinciri: bağımlılıklar, SBOM, SLSA ve imzalama

Tipik bir Node uygulamasında yazdığın kod, çalışan kodun yüzde birkaçıdır. Gerisi bağımlılıklar, bağımlılıkların bağımlılıkları, derleme araçları, CI imajları ve temel konteyner imajıdır. Bunların her biri bir **güven kararıdır**. Saldırganlar da hedefi değiştirdi: Bin şirkete tek tek saldırmak yerine, hepsinin kullandığı tek bir paketi ele geçirmek daha verimli. Tedarik zinciri saldırısının sonucu, kendi kodunda hiçbir hata olmadan üretimde saldırganın kodunun çalışmasıdır.

## Saldırı yolları

| Yol | Nasıl | Gerçek örnek |
|---|---|---|
| **Yazım benzerliği** (typosquatting) | `lodash` yerine `lodahs`, `cross-env` yerine `crossenv` | 2017'de `crossenv` ve onlarca benzeri, ortam değişkenlerini topluyordu |
| **Bağımlılık karışıklığı** (dependency confusion) | Şirketin iç paketi `@sirket/odeme-sdk` değil de `odeme-sdk` ise, saldırgan herkese açık kayıt defterine aynı adla **daha yüksek sürüm** yayımlar. Yanlış yapılandırılmış istemci yükseği seçer | 2021'de bir araştırmacı bu yolla 35'ten fazla büyük şirketin derleme sistemlerinde kod çalıştırdı |
| **Bakımcı hesabının ele geçirilmesi** | Oltalama ya da sızmış jetonla meşru paketin yeni, zararlı bir sürümü yayımlanır | 2021 `ua-parser-js`. 2025'te oltalanan bir bakımcı hesabıyla haftada milyarlarca indirilen `chalk` ve `debug` paketlerinin zararlı sürümleri |
| **Kendini çoğaltan solucan** | Zararlı `postinstall` betiği geliştiricinin npm/GitHub jetonlarını çalar ve o kişinin yayımladığı paketlere kendini ekleyip yeniden yayımlar | 2025 "Shai-Hulud" solucanı yüzlerce pakete yayıldı |
| **Uzun vadeli sosyal mühendislik** | Yıllarca güven kazanan bir katkıcı, bakımcı olur ve derleme sürecine arka kapı gizler | 2024 `xz-utils` (CVE-2024-3094): sshd'ye uzanan arka kapı, tesadüfen bir performans gerilemesiyle fark edildi |
| **Derleme sisteminin ele geçirilmesi** | Kaynak kod temizdir, derleme sunucusunda üretilen çıktı değiştirilir | 2020 SolarWinds |
| **Terk edilmiş paket / alan adı** | Bakımcının e-posta alan adının süresi dolar. Saldırgan alan adını alır, parola sıfırlar ve hesabı devralır | Birçok npm ve PyPI vakası |

## Kurulum betikleri: `npm install` kod çalıştırır

npm paketleri `preinstall`, `install` ve `postinstall` betikleri tanımlayabilir. Bu betikler kurulum sırasında, **kurulumu yapan kullanıcının** yetkileri ve ortam değişkenleriyle çalışır. Bu bir geliştiricinin dizüstü bilgisayarı ya da sırlarla dolu bir CI işi olabilir. Yerel bir paketle deneyelim:

```js
// paketler/renkli-log/kur.js — "zararsız" bir kurulum betiği: gerçekte burada her şey yapılabilir
const path = require("path");
const supheli = Object.keys(process.env).filter((k) => /(TOKEN|SECRET|_KEY|PAROLA)/.test(k) && !k.startsWith("npm_"));
console.log(`[renkli-log postinstall] çalıştığım dizin: .../${path.basename(path.resolve(process.cwd(), "../.."))}/node_modules/renkli-log`);
console.log(`[renkli-log postinstall] ortamda gördüğüm sır benzeri değişkenler: ${supheli.join(", ") || "(yok)"}`);
require("fs").writeFileSync(path.join(process.env.INIT_CWD || ".", "postinstall-calisti.txt"), new Date().toISOString());
```

```json
{
  "name": "renkli-log",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": { "postinstall": "node kur.js" }
}
```

Paketi `npm pack` ile bir arşive çeviriyoruz ve bir CI işini taklit eden ortam değişkenleriyle kuruyoruz. Ağa erişim yok (`--offline`). Betik çıktısını görmek için `--foreground-scripts` kullanıyoruz:

```bash
DEPLOY_TOKEN=glpat-ornek NPM_TOKEN=npm_ornek AWS_SECRET_ACCESS_KEY=x \
  npm install ../paketler/renkli-log/renkli-log-1.0.0.tgz --offline --no-audit --no-fund --foreground-scripts
ls postinstall-calisti.txt
```

```text
> renkli-log@1.0.0 postinstall
> node kur.js

[renkli-log postinstall] çalıştığım dizin: .../uygulama/node_modules/renkli-log
[renkli-log postinstall] ortamda gördüğüm sır benzeri değişkenler: AWS_SECRET_ACCESS_KEY, DEPLOY_TOKEN, NPM_TOKEN

added 1 package in 854ms
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   renkli-log@1.0.0 (postinstall: node kur.js)
npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.
postinstall-calisti.txt
```

Bu çıktıda iki önemli gözlem var:

- Betik CI'ın bütün sırlarını **gördü**. Bu örnek sadece adlarını yazdı. Shai-Hulud gibi bir solucan, değerleri dışarı gönderir ve bulduğu npm jetonuyla yayılır.
- npm 11.19, onaylanmamış kurulum betikleri için uyarı veriyor (`allowScripts`), ama `--foreground-scripts` olmadan yapılan normal kurulumda da betik **çalıştı**. Yer işareti dosyası (`postinstall-calisti.txt`) bunu kanıtlıyor. Çıktısı varsayılan olarak gizlendiği için betiğin çalıştığı ekrana hiç yansımaz. Uyarı bir engel değildir.

Betikleri kapatmak bu yolu keser:

```bash
rm -rf node_modules postinstall-calisti.txt
npm install --offline --no-audit --no-fund --ignore-scripts
ls postinstall-calisti.txt
```

```text
added 1 package in 591ms
ls: cannot access 'postinstall-calisti.txt': No such file or directory
```

Pratikte:

- CI'da ve geliştirici makinelerinde `ignore-scripts=true` (`.npmrc`) varsayılan olsun. Gerçekten derleme gerektiren paketler (yerel eklentiler: `bcrypt`, `sharp`, `esbuild`) **izin listesiyle** çalıştırılır. pnpm 10'dan beri bağımlılık betiklerini varsayılan olarak çalıştırmaz ve izinli paketleri `onlyBuiltDependencies` ile listeler.
- Bağımlılık kurulum işi **sırsız** çalışmalıdır. `npm ci` adımına deploy jetonu gerekmez. Sırlar sadece onlara ihtiyaç duyan sonraki işlere verilir (Git kursundaki korumalı değişkenler ve ortamlar).
- Yeni yayımlanan sürümlere hemen geçme. Zararlı sürümler çoğunlukla saatler ya da günler içinde fark edilip kaldırılır. pnpm'deki `minimumReleaseAge` gibi bir "olgunlaşma süresi" ayarı ya da Renovate'in `minimumReleaseAge` seçeneği, bu pencerede kurulumu engeller.

## Kilit dosyası ve bütünlük

`package-lock.json`, her paketin tam sürümünü, kaynağını ve **içerik özetini** kaydeder:

```json
"node_modules/renkli-log": {
  "version": "1.0.0",
  "resolved": "file:../paketler/renkli-log/renkli-log-1.0.0.tgz",
  "integrity": "sha512-FhPGmzv1JsU6mbQA1POWLedp9dohb7nPzKtp1B16BaSlo8BKEfI1hdbPPSJRqt/IMpDeK0MjOJw/m7U8fFuv6A==",
  "hasInstallScript": true
}
```

Paketin içeriği **aynı ad ve sürümle** değişirse (ele geçirilmiş bir ayna ya da önbellek sunucusu), `npm ci` bunu reddeder:

```bash
# index.js değiştirilip aynı ad/sürümle yeniden paketlendi; boş önbellekle kurulum
npm ci --cache ../bos-cache --no-audit --no-fund --ignore-scripts
```

```text
npm error code EINTEGRITY
npm error sha512-FhPGmzv1JsU6mbQA1POWLedp9dohb7nPzKtp1B16BaSlo8BKEfI1hdbPPSJRqt/IMpDeK0MjOJw/m7U8fFuv6A== integrity checksum failed when using sha512: wanted sha512-FhPGmzv1JsU6mbQA1POWLedp9dohb7nPzKtp1B16BaSlo8BKEfI1hdbPPSJRqt/IMpDeK0MjOJw/m7U8fFuv6A== but got sha512-dUBFn3LOQnht21WyAUEUpUnfZVHBVftHIPSnlgQiQdspiiNf0FHfX8ZI06qXrZfA3zHwIX20IPpfcc34d7Rqhg==.
```

Deneyin ilk denemesinde değişiklik **fark edilmedi**. npm, paketi kendi önbelleğinden, **bütünlük değerini anahtar olarak** getirdi, yani değiştirilmiş dosya hiç okunmadı. Bu da aynı mekanizmanın bir sonucu. İçerik adresli önbellek, kilitteki özetle eşleşmeyen bir içeriği zaten veremez. Hatayı görmek için boş bir önbellek (`--cache`) gerekti.

Bütünlük kontrolünün sınırını bilmek gerekir. Kilit dosyası "dün kurduğumun aynısını kur" der, "kurduğum şey zararsız" demez. Zararlı bir sürüm kilit dosyasına **güncellemeyle** girerse, bütünlük kontrolü onu korur. Bu yüzden:

- CI'da her zaman `npm ci` kullanılır. Kilit dosyası ile `package.json` uyuşmazsa hata verir, kilidi asla güncellemez. `npm install` ise kilidi sessizce değiştirebilir.
- Kilit dosyasındaki değişiklikler kod incelemesinde **okunur**. Bir MR'da beklenmeyen yeni paket, değişen `resolved` adresi (başka kayıt defteri) ya da `hasInstallScript: true` dikkat işaretidir.

## Bağımlılık karışıklığını önlemek

```ini
# .npmrc — iç paketler kapsamla ve kendi kayıt defterinden
@sirket:registry=https://gitlab.sirket.com/api/v4/groups/42/-/packages/npm/
//gitlab.sirket.com/api/v4/groups/42/-/packages/npm/:_authToken=${CI_JOB_TOKEN}
ignore-scripts=true
```

- İç paketlerin hepsi bir **kapsam** (`@sirket/`) altında olmalı ve kapsam, iç kayıt defterine bağlanmalı. Kapsamsız bir iç paket adı, dış kayıt defterinden çözülebilir.
- Herkese açık kayıt defterinde kendi kapsamını (`@sirket`) **sahiplen**. Böylece başkası bu kapsamda paket yayımlayamaz.
- Bir vekil kayıt defteri (Nexus, Artifactory, GitLab bağımlılık vekili) kullanıyorsan, iç paket adlarının dış kaynaktan **hiç** gelmemesi için kural koy. "Önce iç, yoksa dış" sıralaması yeterli değildir. Saldırganın yüksek sürüm numarası bu sıralamayı aşabilir.

## SBOM: ne çalıştırdığını bilmek

Log4Shell (Aralık 2021) yayımlandığında herkes aynı soruyu sordu: "Log4j'yi nerede kullanıyoruz?" Birçok kuruluş haftalarca cevap aradı, çünkü kütüphane başka kütüphanelerin içinde, dolaylı bağımlılık olarak duruyordu. **SBOM** (Software Bill of Materials), bir yazılımın bileşen listesini makine tarafından okunabilir biçimde verir. Bu sorunun cevabını bir sorguya indirger. npm, SBOM'u kilit dosyasından doğrudan üretir:

```bash
npm sbom --sbom-format cyclonedx
```

```text
1.5 {
  "bom-ref": "renkli-log@1.0.0",
  "type": "library",
  "name": "renkli-log",
  "version": "1.0.0",
  "scope": "required",
  "purl": "pkg:npm/renkli-log@1.0.0",
  "externalReferences": [ { "type": "distribution", "url": "file:…/paketler/renkli-log/renkli-log-1.0.0.tgz" } ],
  "hashes": [ { "alg": "SHA-512", "content": "1613c69b3bf526c53a99b400d4f3962de769f5da216fb9cfccab69d41d7a05a4a5a3c04a11f23585d6cf3d2251aadfc83290de2b4323389c3f9bb53c7c5bafe8" } ]
}
bağımlılıklar: [{"ref":"uygulama@1.0.0","dependsOn":["renkli-log@1.0.0"]},{"ref":"renkli-log@1.0.0","dependsOn":[]}]
```

Çıktıdaki alanların her birinin bir işlevi var:

- **`purl`** (package URL), bileşeni ekosistemden bağımsız olarak tanımlar. Zafiyet veritabanları (OSV, GitHub Advisory) bu tanımlayıcıyla eşleştirme yapar.
- **`hashes`** alanındaki değer, kilit dosyasındaki `integrity` değerinin onaltılık gösterimidir. `FhPG...` ile `1613c6...` aynı baytlardır.

Pratikte SBOM:

- **Her derlemede** üretilir ve imajın yanında saklanır. Daha iyisi, imaja bir **attestation** olarak eklenir (aşağıda). Uygulama SBOM'u tek başına yetmez. Konteyner imajının SBOM'u, temel imajdaki işletim sistemi paketlerini de içerir. Bunun için Syft ya da Trivy kullanılır.
- Bir zafiyet tarayıcısına girdi olur. Dependency-Track ya da GitLab'ın bağımlılık listesi, yeni bir CVE yayımlandığında **hangi çalışan sürümlerin** etkilendiğini söyler.
- Standart biçimlerde üretilir: CycloneDX ya da SPDX. Kamu ihaleleri ve AB Siber Dayanıklılık Yasası (CRA), SBOM'u giderek zorunlu kılıyor.

## Zafiyet taraması ve güncelleme

`npm audit`, OSV-Scanner, Trivy ve GitLab Dependency Scanning bilinen zafiyetleri bulur. Zor olan, bulguyu **yönetmektir**:

- **Erişilebilirlik:** Zafiyetli fonksiyon kodda gerçekten çağrılıyor mu? Sadece test bağımlılığında mı? Bulgular bu sorularla önceliklendirilir. Tüm "high" bulguları aynı aciliyette ele almak, ekibi alarm yorgunluğuna sürükler.
- **Otomatik güncelleme:** Renovate ya da Dependabot, güncellemeleri küçük ve sürekli MR'lar olarak açar. Testleri geçen yama sürümleri otomatik birleştirilir. Yılda bir yapılan "büyük güncelleme", geri dönüşü en zor değişikliktir.
- **Az bağımlılık:** Her bağımlılık bir güven kararıdır. 10 satırlık bir yardımcı fonksiyon için paket eklemek yerine kodu yazmak, bakım yükünü artırır ama saldırı yüzeyini azaltır. Bu takası bilinçli yap.

## Derleme bütünlüğü: SLSA ve imzalama

Kaynak kod temiz olsa bile derleme sistemi ele geçirilebilir (SolarWinds). **SLSA** (Supply-chain Levels for Software Artifacts) bu riske karşı kademeli gereksinimler tanımlar. Derleme seviyeleri özetle şöyle:

| Seviye | Gereksinim | Neyi kanıtlar |
|---|---|---|
| Build L1 | Derleme betikli. **Provenance** (köken belgesi) üretilir: hangi kaynak, hangi commit, hangi derleyici | Çıktının nasıl üretildiğinin kaydı |
| Build L2 | Derleme barındırılan bir platformda çalışır, provenance o platform tarafından **imzalanır** | Belgenin sonradan uydurulmadığı |
| Build L3 | Derlemeler birbirinden yalıtılmış. İmza anahtarı derleme adımlarının erişemeyeceği yerde | Derleme sırasında çalışan kodun (bir bağımlılık bile) provenance'ı sahteleyemeyeceği |

İmzalama tarafında güncel yöntem, **Sigstore**'dur (cosign). Anahtar yönetmek yerine CI'ın OIDC kimliğiyle **anahtarsız imzalama** yapılır:

1. CI işi, OIDC jetonunu Sigstore'un CA'sına (Fulcio) sunar.
2. Fulcio, "bu imza `gitlab.sirket.com/platform/odeme-api` projesinin `main` dalındaki işten geliyor" bilgisini içeren, **10 dakika ömürlü** bir sertifika verir.
3. İmza ve sertifika, herkese açık bir şeffaflık defterine (Rekor) yazılır.

Doğrulayan taraf anahtar değil **kimlik** doğrular: "Bu imaj, bu deponun bu dalındaki CI işi tarafından mı imzalandı?"

```bash
# CI'da (GitLab id_tokens ile): imajı ÖZETİYLE imzala, SBOM'u attestation olarak ekle
cosign sign --yes "$CI_REGISTRY_IMAGE@$IMAJ_OZETI"
cosign attest --yes --type cyclonedx --predicate sbom.cdx.json "$CI_REGISTRY_IMAGE@$IMAJ_OZETI"

# Dağıtımda: kimliği doğrula
cosign verify "$CI_REGISTRY_IMAGE@$IMAJ_OZETI" \
  --certificate-identity "https://gitlab.sirket.com/platform/odeme-api//.gitlab-ci.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://gitlab.sirket.com"
```

> **Not:** Bu komutlar cosign ve canlı bir Sigstore/GitLab ortamı gerektirir. Bu kursta çalıştırılmadı, akışı göstermek için verildi. İmza ve doğrulamanın kriptografik temeli (Ed25519/ECDSA imzası, değişen mesajın reddedilmesi) kripto dersinde çalıştırıldı.

Doğrulamanın bir yere **bağlanması** gerekir, yoksa imza sadece bir süs olarak kalır. Kubernetes'te bir admission denetleyicisi (Kyverno `verifyImages` ya da Sigstore policy-controller), imzasız ya da beklenmeyen kimlikle imzalanmış imajı reddeder. Kubernetes kursundaki admission denetimi ile buradaki imzalama burada birleşir.

npm tarafında aynı fikrin karşılığı **güvenilir yayımlama** (trusted publishing) ve provenance'tır. Paket, uzun ömürlü bir npm jetonu yerine CI'ın OIDC kimliğiyle yayımlanır. Kayıt defteri de paketin hangi depo ve hangi iş tarafından üretildiğini gösterir. Bu yöntem, Shai-Hulud gibi jeton çalan saldırıların yayılma yolunu kapatır: Çalınacak bir yayımlama jetonu yoktur.

## CI'ın kendisi

CI hattı da bir tedarik zinciri halkasıdır:

- Dışarıdan alınan CI bileşenleri (GitLab `include`, GitHub Actions) **commit özetine** sabitlenir, etikete değil. Etiket değiştirilebilir. 2025'te `tj-actions/changed-files` eyleminin etiketleri zararlı bir commit'e taşındı ve binlerce deponun CI loglarına sırlar döküldü.
- CI iş imajları özetle (`@sha256:...`) sabitlenir. Git kursunda Bitnami imajlarından kendi araç imajımıza geçmemizin bir nedeni de buydu.
- Birleştirme isteği (MR) işleri, özellikle fork'lardan gelenler, korumalı sırlara erişemez.

```quiz
{
  "question": "Bir şirketin iç paketi `odeme-istemci` adıyla (kapsamsız) iç kayıt defterinde, 1.4.2 sürümüyle duruyor. CI, 'önce iç kayıt defteri, yoksa npmjs' sıralamasıyla çalışan bir vekil kullanıyor. Saldırgan npmjs'e `odeme-istemci@99.0.0` yayımlıyor. Ne olabilir?",
  "options": [
    "Hiçbir şey. İç kayıt defteri önce sorulduğu için iç paket kullanılır.",
    "Bağımlılık aralığı (`^1.4.0` gibi) 99.0.0'ı kapsamıyorsa ve kilit dosyası kullanılıyorsa etkilenmez. Ama aralık geniş, kilit yok ya da vekil iki kaynağı birleştirip en yüksek sürümü sunuyorsa zararlı paket kurulur ve kurulum betiği CI'da çalışır. Kalıcı çözüm: kapsamlı ad (`@sirket/`), kapsamın iç kayıt defterine bağlanması ve vekilde iç adların dışarıdan gelmesinin engellenmesi.",
    "npm sürüm numarası 99 olan paketleri kabul etmez.",
    "Kilit dosyası her durumda korur, başka önlem gerekmez."
  ],
  "answer": 1,
  "explanation": "Bağımlılık karışıklığı, ad çözümlemesinin birden fazla kaynağa açık olmasından doğar. Kilit dosyası mevcut kurulumları korur, ama yeni kurulumlar ve kilit güncellemeleri savunmasızdır. Kapsamlar ve kaynak kuralları kökten çözer."
}
```

```quiz
{
  "question": "Bir ekip imajlarını cosign ile imzalıyor ama Kubernetes'te hiçbir doğrulama yapılmıyor. Ayrıca imzalanan referans `odeme-api:2.4.1` etiketi. Bu düzenin zayıflıkları nelerdir?",
  "options": [
    "Zayıflık yok. İmza var olduğu sürece imaj güvenlidir.",
    "Doğrulama hiçbir yerde zorunlu tutulmadığı için imzasız bir imaj da dağıtılabilir. Ayrıca etiket değiştirilebilir bir işaretçidir. İmza özete (digest) bağlanmalı, dağıtım da özetle yapılmalı, admission denetleyicisi kimliği doğrulamalı.",
    "Sadece cosign yerine GPG kullanılmalı.",
    "Etiketle imzalamak daha güvenlidir, çünkü okunabilir."
  ],
  "answer": 1,
  "explanation": "İmza, ancak dağıtım kapısında doğrulanırsa bir kontroldür. İmzalanan ve dağıtılan nesne, değişmez olan özet olmalıdır. Doğrulama, imzalayanın kimliğini (depo, dal, iş) beklenen değerle karşılaştırmalıdır."
}
```

```lab
{
  "title": "Kendi tedarik zincirini denetle",
  "steps": [
    "Bir projende `npm ls --all` ile bağımlılık ağacını çıkar. Kaç doğrudan ve kaç dolaylı bağımlılık var? `package-lock.json` içinde `hasInstallScript: true` olan paketleri listele ve her birinin betiğine gerçekten ihtiyaç olup olmadığını değerlendir.",
    "`.npmrc`'ye `ignore-scripts=true` ekle, temiz bir `npm ci` yap ve uygulamanın testlerini çalıştır. Kırılan bir şey varsa, betik gerektiren paketleri belirleyip yalnızca onlar için `npm rebuild <paket>` adımı ekle.",
    "Bu dersteki renkli-log deneyini tekrarla, ama kurulumu `env -i PATH=\"$PATH\" HOME=\"$HOME\" npm ci` ile sırsız bir ortamda yap. Betiğin artık hangi değişkenleri gördüğünü karşılaştır.",
    "`npm sbom --sbom-format spdx` ile SPDX biçiminde SBOM üret. İçinde bir bağımlılığın sürümünü bulan küçük bir sorgu yaz (örneğin `node -e` ile). 'Şu paketin şu sürümünü kullanan bütün projeler' sorusunu nasıl cevaplarsın? Bir mimari öner.",
    "CI dosyalarında dış `include`/`uses` ve iş imajlarını listele. Hangileri özetle (SHA) sabitlenmiş, hangileri etiketle? Etiketle olanları sabitlemek için gereken değişikliği hazırla."
  ]
}
```

## Özet

- Tedarik zinciri saldırıları paylaşılan bileşeni hedefler: yazım benzerliği, bağımlılık karışıklığı, ele geçirilen bakımcı hesapları, kendini çoğaltan solucanlar, derleme sistemi.
- `npm install` kod çalıştırır. Kurulum betikleri kurulumu yapanın bütün sırlarını görür. npm'in `allowScripts` uyarısı bir engel değildir. Varsayılan `ignore-scripts=true` olsun, gerekenler izin listesine girsin, kurulum adımı sırsız çalışsın.
- CI'da `npm ci` kullan. Kilit dosyasındaki bütünlük özeti, değişen içeriği `EINTEGRITY` ile reddeder. Kilit değişikliklerini kod incelemesinde oku.
- Bağımlılık karışıklığına karşı: kapsamlı iç paket adları, kapsamın iç kayıt defterine bağlanması, vekilde iç adlar için kaynak kuralı.
- Her derlemede SBOM üret ve sakla (CycloneDX/SPDX). Zafiyet taramasını erişilebilirlikle önceliklendir, güncellemeleri küçük ve sürekli yap.
- SLSA ve Sigstore: provenance, anahtarsız (OIDC) imzalama, imza ve attestation'ın **özete** bağlanması, dağıtım kapısında kimlik doğrulama. Paket yayımlamada uzun ömürlü jeton yerine güvenilir yayımlama kullan.
- CI bileşenlerini ve iş imajlarını özetle sabitle. MR işleri korumalı sırlara erişemesin.
