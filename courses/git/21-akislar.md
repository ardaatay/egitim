# Dallanma stratejileri ve commit kuralları

Git, dallarla ne yapacağını söylemez. Ekip bunu bir **akış** (workflow) olarak kararlaştırır: Hangi dallar var, iş nereden başlar, nereye birleşir, sürümler nasıl çıkar, acil düzeltmeler nasıl yapılır. Yanlış akış, sürekli çakışmalar, haftalarca bekleyen dallar ve "hangi sürümde ne var?" belirsizliği olarak geri döner. Bu derste yaygın akışları, merge yöntemlerini (merge commit, squash, fast-forward) ve otomasyona uygun commit kurallarını ele alıyoruz.

## Kısa ömürlü dallar ve sık entegrasyon

Bütün iyi akışların ortak ilkesi: **Dallar kısa yaşamalı.** Bir dal ne kadar uzun yaşarsa, `main`'den o kadar uzaklaşır, birleştirme o kadar zorlaşır, ve içindeki değişiklik o kadar büyük ve riskli olur. "DevOps Research and Assessment" (DORA) araştırmalarının yüksek performanslı ekiplerde tekrar tekrar bulduğu özellik budur: Sık, küçük entegrasyonlar.

Pratik hedefler: Bir özellik dalı en fazla birkaç gün yaşasın. Bir merge request, incelemesi bir saatten kısa sürecek kadar küçük olsun (yüzlerce satır değil, onlarca). Büyük bir iş, her biri tek başına birleştirilebilir küçük adımlara bölünsün.

## Akışlar

### Trunk-based development

Herkes doğrudan ya da çok kısa ömürlü dallarla (saatler, en fazla bir iki gün) tek bir ana dala (`main`, "trunk") birleştirir. `main` her zaman yayınlanabilir durumdadır.

```text
main ──●──●──●──●──●──●──●──●──●──▶   (her commit test edilmiş, yayınlanabilir)
         \─●─/  \●/   \─●─●─/
         kısa dallar, merge request + CI
```

Bitmemiş işler nasıl birleştirilir? **Özellik bayraklarıyla** (feature flags): Kod `main`'e girer ama bir yapılandırma ya da bayrak servisiyle kapalıdır. Yayınlamak (deploy) ile kullanıma açmak (release) birbirinden ayrılır: Kod üretimde bekler, bayrak açılınca kullanıcılar görür, sorun çıkarsa bayrak kapatılır (geri deploy gerekmez).

Ön koşulları: güçlü otomatik testler (her merge request'te CI), hızlı inceleme kültürü, ve bayrak yönetimi disiplini (bayraklar özellik tamamlanınca kodla birlikte temizlenir, yoksa birikir). Sürekli deploy yapan web servisleri ve SaaS ürünleri için en yaygın ve önerilen akıştır.

### GitLab Flow

Trunk-based'in üzerine ortam ya da sürüm dalları ekler:

```text
main ────●──●──●──●──●──●──▶        (geliştirme, her şey önce buraya)
              \     \
production ────●─────●──────▶       (main'den seçilen noktalar production'a)
```

- **Ortam dalları** (`main` → `staging` → `production`): Bir ortama deploy, o dala merge ile yapılır, ve geçmiş "production'da ne zaman ne vardı"yı gösterir. Kubernetes kursundaki GitOps akışı buna benzer. Bugün çoğu ekip bunun yerine **aynı commit'i** (aynı imajı) ortamlar arasında terfi ettirmeyi tercih eder (React kursundaki CI/CD).
- **Sürüm dalları** (`release/1.4`, `release/1.5`): Birden çok sürümün aynı anda desteklendiği ürünlerde (müşteriye kurulan yazılım, mobil uygulamalar). Düzeltmeler önce `main`'e yapılır, sonra `cherry-pick -x` ile gereken sürüm dallarına taşınır ("upstream first"). Sürüm dalında yapılıp `main`'e taşınmayı unutulan bir düzeltme, bir sonraki sürümde hatanın geri dönmesi demektir.

### GitFlow

`develop`, `feature/*`, `release/*`, `hotfix/*`, `main` dallarıyla çalışan, 2010'ların yaygın modeli. Planlı, seyrek sürümler (aylık, üç aylık) çıkaran ve birden çok sürümü paralel yöneten ekipler için tasarlanmıştı. Sürekli deploy edilen servislerde gereksiz karmaşıktır: `develop` ile `main` arasında sürekli merge'ler, uzun yaşayan dallar ve çift kayıt. Modelin yazarı da bugün web uygulamaları için daha basit akışları önerir. Mevcut bir projede görürsen nasıl işlediğini bilmek yeterli, yeni bir projede başlamak için iyi bir seçim değil.

### Hangisi?

| Durum | Öneri |
|---|---|
| Sürekli deploy edilen web servisi, API, iç araç | Trunk-based + kısa dallar + özellik bayrakları |
| Aynı anda birden çok sürüm desteği (kurulumlu yazılım, kütüphane) | `main` + sürüm dalları, upstream first |
| Düzenleyici gereksinimler, onaylı sürüm süreci | `main` + sürüm dalları + korumalı etiketler, onaylı pipeline'lar |

## Merge yöntemleri

GitLab'da proje ayarı olarak seçilir (GitLab dersi). Aynı özellik dalının üç farklı sonucu:

**Merge commit** (`--no-ff`, GitLab varsayılanı): Dalın commit'leri olduğu gibi kalır, üzerine bir merge commit'i eklenir. Tam geçmiş, özelliği tek adımda geri alma (`revert -m 1`). Dezavantajı: Dalın içindeki "review düzeltmeleri" gibi commit'ler de `main`'in geçmişine girer.

**Squash**: Dalın bütün commit'leri **tek bir commit**'e sıkıştırılır:

```bash
git switch -c feat/odeme-iade
echo "iade" >> app.txt; git commit -am "feat(odeme): kısmi iade ucu ekle"
echo "test" > test.txt; git add .; git commit -m "test ekle"
echo "fix" >> app.txt; git commit -am "review düzeltmeleri"
git switch main
git merge --squash feat/odeme-iade
git status -s
git commit -m "feat(odeme): kısmi iade ucu ekle (!42)"
git log --oneline --graph
```

```text
Squash commit -- not updating HEAD
 app.txt  | 2 ++
 test.txt | 1 +

M  app.txt
A  test.txt

* d1b9452 (HEAD -> main) feat(odeme): kısmi iade ucu ekle (!42)
* 38e7813 (tag: v1.0.0) chore: projeyi başlat
```

`main`'de tek, temiz bir commit: Merge request numarası (`!42`) mesajda. Dağınık ara commit'ler yok. Dezavantajlar: Dalın içindeki yapı kaybolur (büyük bir özellikte, ayrı ayrı anlamlı olan commit'ler tek bir dev commit'e dönüşür), ve Git dalın birleştirildiğini **bilmez**:

```bash
git branch -d feat/odeme-iade
```

```text
error: the branch 'feat/odeme-iade' is not fully merged
```

Squash yeni bir commit oluşturduğu için, dalın commit'leri `main`'in geçmişinde yok. Dal silinmeli (`-D`), ve aynı daldan devam edilip tekrar squash edilmemeli (aynı değişiklikler çakışma olarak geri gelir).

**Fast-forward / rebase**: Dal `main`'in üzerine rebase edilir, merge commit'i olmadan eklenir. Doğrusal geçmiş, dalın commit'leri korunur. Commit'lerin her birinin anlamlı olmasını gerektirir (rebase dersindeki temizlik).

Yaygın ve sağlıklı bir seçim: **Küçük merge request'ler + squash** (her MR `main`'de tek bir anlamlı commit) ya da **temizlenmiş commit'ler + merge commit / fast-forward** (geçmişin ayrıntısı korunur). Önemli olan, ekibin bir seçim yapması ve GitLab ayarıyla zorlaması.

## Commit kuralları: Conventional Commits

Commit mesajlarına makinenin okuyabileceği bir yapı vermek, sürüm notlarını, sürüm numaralarını ve değişiklik takibini otomatikleştirir:

```text
<tür>(<kapsam>): <açıklama>

[gövde]

[altbilgi: BREAKING CHANGE: ..., Refs: #123]
```

| Tür | Anlam | SemVer etkisi |
|---|---|---|
| `feat` | Yeni özellik | MINOR |
| `fix` | Hata düzeltmesi | PATCH |
| `feat!` / `BREAKING CHANGE:` | Geriye uyumsuz değişiklik | MAJOR |
| `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build` | Diğer | yok |

Birkaç commit sonra bu yapı, sürüm notlarını basit bir `git log` sorgusuna dönüştürür:

```bash
echo "x" >> app.txt; git commit -am "fix(api): zaman aşımında 504 dön"
echo "y" >> app.txt; git commit -am "docs: kurulum adımlarını güncelle"
echo "z" >> app.txt; git commit -am "feat!: v1 uçlarını kaldır

BREAKING CHANGE: /api/v1 uçları kaldırıldı, /api/v2 kullanın."

echo "## Yeni özellikler"; git log v1.0.0..HEAD --format='- %s (%h)' --grep='^feat'
echo "## Düzeltmeler";     git log v1.0.0..HEAD --format='- %s (%h)' --grep='^fix'
echo "## Kırıcı değişiklikler"
git log v1.0.0..HEAD --format='%h %s%n%b' --grep='BREAKING CHANGE' | grep -E '^[0-9a-f]{7}|BREAKING'
```

```text
## Yeni özellikler
- feat!: v1 uçlarını kaldır (e75ad96)
- feat(odeme): kısmi iade ucu ekle (!42) (d1b9452)
## Düzeltmeler
- fix(api): zaman aşımında 504 dön (166275f)
## Kırıcı değişiklikler
e75ad96 feat!: v1 uçlarını kaldır
BREAKING CHANGE: /api/v1 uçları kaldırıldı, /api/v2 kullanın.
```

Kırıcı değişiklik olduğu için bir sonraki sürüm `v2.0.0` olmalı. Bunu elle yapmak yerine araçlar kullanılır (`semantic-release`, `release-please`, `git-cliff`): Commit'leri okuyup sürüm numarasını hesaplar, etiketi oluşturur, CHANGELOG'u yazar. Kuralı zorlamak için commit mesajı kontrolü: yerelde `commit-msg` hook'u (bir sonraki ders), merge request'te CI kontrolü (squash kullanılıyorsa MR başlığının kurala uyması yeterli).

## Kod sahipliği ve inceleme

- **CODEOWNERS** dosyası (GitLab, GitHub): Hangi dizinin hangi ekip ya da kişiye ait olduğunu tanımlar. O dizine dokunan merge request'ler otomatik olarak sahiplerinin onayını ister:

```text
# .gitlab/CODEOWNERS
*                     @platform-ekibi
/odeme/               @odeme-ekibi
/deploy/k8s/          @platform-ekibi @sre
*.sql                 @dba
```

- İnceleme kültürü: Küçük MR'lar, inceleyenin "neden"i anlayacağı açıklamalar (MR açıklaması commit gövdesinin büyük kardeşidir), otomatik kontrollerin (biçim, lint, test, güvenlik taraması) insan incelemesinden **önce** çalışması. İnsanlar mantığa ve tasarıma bakmalı, boşluk hatalarına değil.

## Alıştırma

1. Ekibin 3 haftalık bir özellik dalı var ve her `main` birleştirmesinde 30 çakışma çıkıyor. Kısa ve orta vadeli ne önerirsin?
2. Bir sürüm dalında (`release/2.3`) acil bir güvenlik düzeltmesi gerekiyor. Düzeltmeyi hangi sırayla ve hangi komutlarla uygularsın?
3. Squash merge kullanan bir projede, bir MR'ın 5 commit'i içinde biri "feat:", biri "fix:" ise sürüm aracı ne görür? Bu durumda hangi kuralı koyarsın?

<details><summary>Çözüm</summary>

1. Kısa vadede: Dalı her gün `main` ile birleştir ya da rebase et (çakışmalar küçük parçalar halinde gelir), `rerere`'yi aç. Orta vadede: Özelliği bağımsız birleştirilebilir parçalara böl ve bitmemiş kısımları bir özellik bayrağının arkasında `main`'e al. Büyük yeniden düzenlemeler (refactoring), davranış değişikliğinden **önce** ayrı ve küçük MR'lar olarak birleştirilmeli. Asıl sorun Git değil, entegrasyon sıklığı.

2. Upstream first: Düzeltmeyi önce `main`'e (bir MR ile) birleştir. Sonra `git switch release/2.3 && git cherry-pick -x <commit>`, test et, `v2.3.5` etiketiyle yayınla. `-x` mesajı, düzeltmenin `main`'deki kaynağını gösterir. Acil durumda sıra tersine çevrilebilir (önce sürüm dalı), ama o zaman `main`'e taşımayı aynı gün bir iş kaydıyla garanti altına al: Unutulan düzeltme bir sonraki sürümde hatayı geri getirir.

3. Squash'ta `main`'e tek bir commit girer ve mesajı genellikle **MR başlığıdır**. Sürüm aracı sadece onu görür; dalın içindeki commit'lerin türleri kaybolur. Kural: Squash kullanan projelerde Conventional Commits kontrolü **MR başlığına** uygulanır, ve MR tek bir amaç taşır (bir `feat` ya da bir `fix`). İki farklı türde değişiklik varsa iki MR açılır.

</details>

```quiz
Trunk-based development'ta bitmemiş bir özellik main'e nasıl birleştirilir?
- Birleştirilmez, bitene kadar dalda bekler
- [x] Bir özellik bayrağının arkasında, kapalı olarak birleştirilir; deploy ile kullanıma açma ayrılır
- Ayrı bir develop dalına birleştirilir
? Kısa ömürlü dallar ve sık entegrasyon çakışmaları ve riski küçük tutar.
```

```quiz
Squash merge sonrası `git branch -d ozellik` neden "not fully merged" hatası verir?
- Squash başarısız olmuştur
- [x] Squash, dalın commit'lerini içermeyen yeni bir commit oluşturur; Git dalın commit'lerini main'in geçmişinde bulamaz
- Dal korumalıdır
? Squash'tan sonra dal -D ile silinir ve aynı daldan devam edilmez.
```

```quiz
Conventional Commits'te `feat!:` ya da `BREAKING CHANGE:` içeren bir commit SemVer'de neyi artırır?
- PATCH
- MINOR
- [x] MAJOR
? feat MINOR'ı, fix PATCH'i artırır; araçlar sürüm numarasını commit'lerden hesaplayabilir.
```

## Özet

- Bütün iyi akışların ilkesi: kısa ömürlü dallar, küçük MR'lar, sık entegrasyon.
- Trunk-based + özellik bayrakları: sürekli deploy edilen servisler için. GitLab Flow: ortam ya da sürüm dalları, upstream first + `cherry-pick -x`. GitFlow: seyrek sürümler için tasarlanmış, servisler için ağır.
- Merge yöntemleri: merge commit (tam geçmiş, tek adımda geri alma), squash (MR başına tek commit; dal -D ile silinir), fast-forward/rebase (doğrusal, temiz commit'ler gerekir). Ekip seçer, GitLab zorlar.
- Conventional Commits: `feat`/`fix`/`!`; sürüm numarası ve CHANGELOG otomasyonu. Squash'ta kural MR başlığına uygulanır.
- CODEOWNERS ile kod sahipliği; otomatik kontroller insan incelemesinden önce.
