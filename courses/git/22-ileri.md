# Büyük depolar, hook'lar, imzalama ve sızan gizli bilgiler

Bu ders, Git'i büyük ölçekte ve güvenle kullanmanın araçlarını bir araya getiriyor: Gigabaytlarca geçmişi olan depoları hızlı klonlamak (sığ ve kısmi klon, seyrek checkout), büyük ikili dosyalar (LFS), başka depoları içermek (submodule), yerel kontroller (hook'lar), commit'lerin gerçekten kimden geldiğini kanıtlamak (imzalama), ve en önemlisi: bir gizli bilgi commit edildiğinde ne yapılacağı.

## Klonu küçültmek

Bir deneme deposu: 40 commit boyunca sürekli değişen bir veri dosyası, ve bir kez eklenip silinen 5 MB'lık bir video:

```bash
cd ~/git-egitim && mkdir buyuk && cd buyuk
git init -b main kaynak && cd kaynak
mkdir -p servisler/odeme servisler/arama docs
for i in $(seq 1 40); do
  head -c 20000 /dev/urandom | base64 > servisler/odeme/veri.txt
  echo "arama $i" > servisler/arama/a.txt
  git add . && git commit -qm "Değişiklik $i"
done
head -c 5000000 /dev/urandom > docs/tanitim.mp4 && git add . && git commit -qm "Tanıtım videosu"
git rm -q docs/tanitim.mp4 && git commit -qm "Videoyu kaldır"
git gc -q && du -sh .git
cd ..
git clone --bare kaynak sunucu.git
git -C sunucu.git config uploadpack.allowFilter true     # kısmi klona izin ver (GitLab'da açık)
```

```text
5.7M
```

Video silindi ama depo 5,7 MB: Silinen dosya geçmişte duruyor (ilk dersteki model). Her klon onu da indirir. Üç farklı klon:

```bash
git clone "file://$PWD/sunucu.git" tam && du -sh tam/.git
git clone --depth 1 "file://$PWD/sunucu.git" sig && du -sh sig/.git && git -C sig log --oneline | wc -l
git clone --filter=blob:none "file://$PWD/sunucu.git" kismi && du -sh kismi/.git && git -C kismi log --oneline | wc -l
```

```text
5.7M          ← tam klon
102K   1      ← sığ klon: tek commit
130K   42     ← kısmi klon: bütün commit'ler
```

- **Sığ klon** (`--depth 1`): Sadece son commit ve onun dosyaları. CI işlerinde (kodu bir kez derleyip atacaksan) idealdir. GitLab CI varsayılan olarak `GIT_DEPTH: 20` ile çalışır. Ama geçmiş yok: `git log`, `blame`, `describe` ve geçmişe ihtiyaç duyan sürüm araçları (bir önceki derste) yanlış sonuç verir.
- **Kısmi klon** (`--filter=blob:none`): Bütün commit'ler ve tree'ler var, ama dosya içerikleri (blob'lar) **ihtiyaç duyuldukça** sunucudan indirilir. Geçmiş tam, klon küçük:

```bash
git -C kismi show HEAD~20:servisler/arama/a.txt
du -sh kismi/.git
```

```text
arama 22
136K
```

Eski bir dosyaya erişildiğinde, o blob arka planda indirildi (130K → 136K). Geliştirici makineleri için büyük depolarda en iyi denge budur.

### Seyrek checkout

Bir monorepo'da (tek depoda onlarca servis) sadece kendi servisinle çalışıyorsan:

```bash
git clone --filter=blob:none --sparse "file://$PWD/sunucu.git" seyrek
ls seyrek
git -C seyrek sparse-checkout set servisler/arama
ls seyrek seyrek/servisler
```

```text
(boş: sadece kök dizindeki dosyalar)

seyrek:
servisler

seyrek/servisler:
arama
```

Çalışma dizininde sadece `servisler/arama` var, ve kısmi klonla birleşince diğer servislerin içerikleri hiç indirilmez. Git, `status` ve `add` gibi komutlarda da sadece bu dizinlere bakar: Dev depolarda belirgin bir hız farkı.

### Büyük ikili dosyalar: Git LFS

Git, metin dosyaları için tasarlandı: Her sürüm tam olarak saklanır ve paketleme ikili dosyalarda delta ile yer kazanamaz. 200 MB'lık bir tasarım dosyasının 50 sürümü, deponun 10 GB olması demektir. **Git LFS** (Large File Storage), büyük dosyaların yerine depoya küçük bir **işaretçi** dosyası koyar, içeriği ayrı bir depolama alanına (GitLab'ın LFS deposu) yükler:

```bash
git lfs install                      # bir kez, kullanıcı için
git lfs track "*.mp4" "*.psd"        # .gitattributes'a kural ekler
git add .gitattributes docs/tanitim.mp4
git commit -m "Tanıtım videosunu LFS ile ekle"
git lfs ls-files
```

(Bu kursun deneme ortamında LFS sunucusu olmadığı için bu komutlar çalıştırılmadı.) Kurallar: LFS'i **dosyalar commit edilmeden önce** kur (sonradan geçmişteki dosyaları LFS'e taşımak `git lfs migrate` ile geçmişi yeniden yazmak demektir). Derleme çıktıları, bağımlılıklar ve veritabanı dökümleri Git'e de LFS'e de girmez: Onlar artifact deposuna (GitLab'ın package registry'si, S3) aittir.

### Submodule

Bir depo başka bir depoyu belirli bir commit'te içerebilir:

```bash
git submodule add https://gitlab.com/ortak/helm-sablonlari.git deploy/sablonlar
git commit -m "Helm şablonlarını submodule olarak ekle"
# başka bir makinede:
git clone --recurse-submodules <adres>
git submodule update --init --recursive
```

Submodule, üst depoda dizin yerine **bir commit hash'i** olarak saklanır (tree'de `160000` modlu bir girdi). Alt depoyu güncellemek, üst depoda "submodule'ü şu commit'e taşı" commit'i yapmaktır. Bu esneklik pahalıdır: Unutulan `--recurse-submodules`, "detached HEAD" durumundaki alt depolarda kaybolan işler, CI'da ek kimlik doğrulama. Alternatifler: paket yöneticisiyle sürümlü bağımlılık (npm, Helm chart deposu), ya da kodun doğrudan kopyalanması (`git subtree`). Submodule'ü sadece gerçekten bağımsız sürümlenen ve nadiren değişen bileşenler için kullan.

## Hook'lar: yerel kontroller

Git, belirli olaylarda `.git/hooks/` altındaki betikleri çalıştırır. En kullanışlıları:

| Hook | Ne zaman | Sıfırdan farklı çıkış kodu |
|---|---|---|
| `pre-commit` | Commit oluşturulmadan önce | Commit'i durdurur |
| `commit-msg` | Mesaj yazıldıktan sonra | Commit'i durdurur |
| `pre-push` | Push'tan önce | Push'u durdurur |
| `post-checkout`, `post-merge` | Dal değişimi/merge sonrası | Bilgilendirme (bağımlılıkları güncelle uyarısı) |

Gizli bilgi kalıpları arayan bir `pre-commit` ve Conventional Commits kuralını uygulayan bir `commit-msg`:

```bash
cd tam
cat > .git/hooks/pre-commit <<'EOF'
#!/bin/sh
# eklenen satırlarda gizli bilgi kalıpları ara
if git diff --cached -U0 | grep -nE '^\+.*(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(password|parola|secret)[[:space:]]*[:=][[:space:]]*[^[:space:]$])'; then
  echo "HATA: commit'te gizli bilgi olabilir. Kontrol et; emin değilsen commit etme." >&2
  exit 1
fi
EOF
cat > .git/hooks/commit-msg <<'EOF'
#!/bin/sh
if ! head -1 "$1" | grep -qE '^(feat|fix|docs|test|refactor|perf|chore|ci|build)(\([a-z0-9-]+\))?!?: .+'; then
  echo "HATA: mesaj Conventional Commits biçiminde değil: '$(head -1 "$1")'" >&2
  exit 1
fi
EOF
chmod +x .git/hooks/pre-commit .git/hooks/commit-msg
```

Deneyelim:

```bash
echo 'db_password = "Gizli123"' > ayar.ini && git add ayar.ini
git commit -m "feat: ayar ekle"

echo 'db_password = ${DB_PASSWORD}' > ayar.ini && git add ayar.ini
git commit -m "ayar ekledim"
git commit -m "feat(ayar): veritabanı ayarını ekle"
```

```text
7:+db_password = "Gizli123"
HATA: commit'te gizli bilgi olabilir. Kontrol et; emin değilsen commit etme.

HATA: mesaj Conventional Commits biçiminde değil: 'ayar ekledim'

(üçüncü commit başarılı)
```

Düz metin parola reddedildi. Ortam değişkenine başvuru (`${DB_PASSWORD}`) kabul edildi, ama mesaj kurala uymadığı için ikinci commit durdu. Bu desen ilk denemede değişken başvurusunu da yakalıyordu (`[^[:space:]]+`): Kendi yazdığın kontrolleri hem "yakalaması gereken" hem "yakalamaması gereken" örneklerle dene. Çok gürültülü bir kontrol, insanları onu atlamaya iter.

Hook'ların sınırları:

- **Paylaşılmaz.** `.git/hooks/` depoyla gelmez: Her geliştirici kendisi kurmalı. Çözüm: hook'ları depoda bir dizinde tut ve `git config core.hooksPath .githooks`, ya da `pre-commit` (Python) / `husky` (Node) / `lefthook` gibi bir çerçeveyle yönet.
- **Atlatılabilir.** `git commit --no-verify` hook'ları çalıştırmaz. Hook'lar geliştiriciye **hızlı geri bildirim** içindir, güvenlik kontrolü değildir. Gerçek kontrol sunucu tarafında yapılır: GitLab CI'da secret detection, push kuralları ve korumalı dallar (GitLab dersleri).
- Hızlı olmalı: Her commit'te 30 saniye süren bir hook, insanları `--no-verify`'a alıştırır. Yavaş kontroller (bütün test paketi) CI'a.

Kalıp aramayla gizli bilgi tespiti her şeyi yakalamaz. `gitleaks` ve `trufflehog` gibi araçlar yüzlerce bilinen anahtar biçimini ve entropi analizini kullanır, ve hem hook olarak hem CI'da çalışır.

## Commit imzalamak

`user.name` ve `user.email` sadece yapılandırmadır: Herkes istediği adı yazabilir. Bir commit'in gerçekten senin olduğunu kanıtlamak için **imza** gerekir. En kolay yol SSH anahtarıyla imzalamaktır (2.34+, GPG kurulumu gerektirmez):

```bash
ssh-keygen -t ed25519 -C "ayse@ornek.com" -f ~/.ssh/imza_anahtari    # parola ver!
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/imza_anahtari.pub
git config --global commit.gpgSign true                              # her commit'i imzala

# yerelde doğrulama için güvenilen anahtarlar listesi
echo "ayse@ornek.com $(cat ~/.ssh/imza_anahtari.pub)" > ~/.ssh/izinli_imzalar
git config --global gpg.ssh.allowedSignersFile ~/.ssh/izinli_imzalar

git commit -S -m "docs: imzalı commit"
git log --show-signature -1 --format='%h %s'
git log --format='%h %G? %s' -3
```

```text
Good "git" signature for ayse@ornek.com with ED25519 key SHA256:SNQe7Wnb1z2TR3LqOUdGrstp+OD1guKmtoNW2EqCyGk
0527f0d docs: imzalı commit

0527f0d G docs: imzalı commit
95a6330 N x
46f783e N feat(ayar): veritabanı ayarını ekle
```

`%G?`: `G` geçerli imza, `N` imza yok, `B` bozuk, `U` geçerli ama güvenilmeyen anahtar. (Anahtar parmak izi senin ortamında farklı olacaktır.) Açık anahtarı GitLab profilinde "imzalama anahtarı" olarak eklediğinde, GitLab commit'lerin yanında "Verified" gösterir, ve korumalı dallarda **sadece imzalı commit'leri kabul et** kuralı konabilir. İmzalama, ele geçirilmiş bir hesabın ya da kimliğe bürünmenin geçmişe sızmasını zorlaştırır: Tedarik zinciri güvenliğinde (güvenlik kursu) önemli bir halkadır.

## Bir gizli bilgi commit edildi: ne yapmalı?

Senaryo: Biri `.env` dosyasını commit etmiş, sonra fark edip silmiş.

```bash
cd ~/git-egitim/buyuk && git init -b main temizle && cd temizle
echo "app" > app.txt && git add . && git commit -qm "app"
echo "AWS_SECRET=abc123" > .env && git add . && git commit -qm "env ekle"
git rm -q --cached .env && echo ".env" > .gitignore && git add .gitignore && git commit -qm "env'i kaldır"
echo "x" >> app.txt && git commit -qam "devam"

git log --oneline --all -- .env
git show HEAD~2:.env
```

```text
144d834 env'i kaldır
0754e0c env ekle

AWS_SECRET=abc123
```

Dosya "kaldırıldı" ama geçmişte duruyor. Sırası çok önemli:

**1. Önce anahtarı iptal et ve yenile.** Depo push edildiyse, gizli bilgi **sızmıştır**: Klonlarda, CI önbelleklerinde, fork'larda, belki botların taradığı herkese açık bir projede (herkese açık depolardaki AWS anahtarları dakikalar içinde otomatik olarak bulunup kullanılır). Geçmişi temizlemek bunu geri almaz. İlk iş, o anahtarın sağlayıcısında (AWS, veritabanı, API) anahtarı iptal etmek ve yenisini üretmek, sonra o anahtarla neler yapıldığını erişim loglarından kontrol etmek.

**2. Sonra geçmişten temizle** (depo boyutu, ve eski anahtarın tekrar yanlışlıkla kullanılmaması için). Önerilen araç `git filter-repo`'dur (ayrıca kurulur, `pip install git-filter-repo`):

```bash
git filter-repo --invert-paths --path .env
```

Kurulum gerektirmeyen ama yavaş ve artık önerilmeyen yerleşik araç `filter-branch` ile aynı iş (burada çalıştırılan):

```bash
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm -q --cached --ignore-unmatch .env' -- --all
git log --oneline
git log --oneline --all -- .env
```

```text
Ref 'refs/heads/main' was rewritten

2367392 devam
3daebf8 env'i kaldır
ca0a8cc env ekle
982f4a2 app

144d834 env'i kaldır       ← hâlâ görünüyor!
0754e0c env ekle
```

Bütün commit'ler yeniden yazıldı (yeni hash'ler), ama `--all` ile bakınca eski commit'ler hâlâ orada. `filter-branch` eski hali bir yedek referansta tutar:

```bash
git for-each-ref refs/original
git update-ref -d refs/original/refs/heads/main
git reflog expire --expire=now --all
git gc -q --prune=now
git rev-list --all --objects | grep -c "\.env"
```

```text
193bcf0a3027da9d4ea5d94e143fd5e6c4a8d495 commit	refs/original/refs/heads/main

0
```

Yedek referans, reflog ve çöp nesneler temizlendi, gizli bilgi yerel depoda artık yok. (`filter-repo` bu adımları kendisi yapar.)

**3. Sunucuyu ve klonları güncelle.** Yeniden yazılmış geçmiş zorla push edilir (`git push --force --all`, korumalı dallarda geçici olarak izin vermek gerekir). Herkes depoyu **yeniden klonlamalı**: Eski klonlar hâlâ gizli bilgiyi içerir ve bir sonraki push'ta onu geri getirebilir. GitLab'da eski nesneler sunucudan hemen silinmez: Proje ayarlarındaki "repository cleanup" ile `filter-repo`'nun ürettiği eşleme dosyası yüklenir ve önbellekler temizlenir. Açık merge request'lerin diff'lerinde de kalabilir.

Bu kadar zahmetli olduğu için asıl çözüm **önlemek**: `.gitignore` şablonları, pre-commit hook'ları, GitLab'da push kuralları ("gizli bilgi içeren commit'leri reddet") ve secret detection taraması, ve gizli bilgilerin hiç dosyada değil bir secret manager'da durması (Kubernetes kursu).

## Alıştırma

1. Bir monorepo'da 30 servis ve 8 GB geçmiş var. Yeni bir geliştiricinin sadece `servisler/odeme` üzerinde çalışması için hangi klon komutlarını önerirsin? CI için?
2. `pre-commit` hook'una, 1 MB'dan büyük bir dosya eklenmeye çalışıldığında commit'i durduran bir kontrol ekle.
3. Bir geliştirici veritabanı parolasını içeren bir commit'i bir saat önce `main`'e push etti. Adım adım ne yaparsın?

<details><summary>Çözüm</summary>

1. Geliştirici: `git clone --filter=blob:none --sparse <adres>` ve `git sparse-checkout set servisler/odeme ortak/` (servisin bağımlı olduğu ortak dizinlerle). Tam geçmiş var, sadece gereken içerik iner. CI: `--depth` ile sığ klon (GitLab CI'da `GIT_DEPTH`), geçmiş gerektiren işler (sürüm hesaplama) için ayrı ve derin klon. Ayrıca CI'da sadece değişen servisleri derlemek için `rules:changes` (CI dersleri).

2.

```sh
# pre-commit'e ekle
git diff --cached --name-only --diff-filter=AM | while read -r f; do
  boyut=$(git cat-file -s ":$f")
  if [ "$boyut" -gt 1048576 ]; then
    echo "HATA: $f $boyut bayt (1 MB sınırı). Büyük dosyalar için Git LFS kullan." >&2
    exit 1
  fi
done || exit 1
```

`git cat-file -s ":dosya"`, index'teki (commit'e girecek) halin boyutunu verir, çalışma dizinindekinin değil. `while` bir alt kabukta çalıştığı için çıkış kodunu `|| exit 1` ile dışarı taşıyoruz. Sunucu tarafında aynı kural GitLab push kuralıyla ("maksimum dosya boyutu") zorlanır.

3. (a) Parolayı **hemen** değiştir: Veritabanında kullanıcının parolasını yenile, uygulamaların secret'larını güncelle (Kubernetes Secret, Vault), uygulamaları yeniden başlat. (b) Veritabanı denetim kayıtlarında (Oracle kursundaki unified audit) o kullanıcıyla beklenmeyen bir erişim var mı kontrol et. (c) Olayı güvenlik ekibine bildir. (d) Gerekirse geçmişi temizle (`filter-repo`, zorla push, GitLab repository cleanup, herkes yeniden klonlasın). Parola zaten değiştirildiği için bu adım aciliyetini kaybeder ve bazı ekipler bunu yapmamayı seçer. (e) Kök sebebi düzelt: Neden bir dosyadaydı? Secret detection CI'da neden yakalamadı?

</details>

```quiz
`git clone --filter=blob:none` ile `git clone --depth 1` arasındaki fark?
- İkisi aynıdır
- [x] Kısmi klon bütün commit geçmişini indirir ama dosya içeriklerini ihtiyaç duyuldukça çeker; sığ klon sadece son commit'leri indirir
- Kısmi klon sadece LFS dosyaları içindir
? Geliştirici makineleri için kısmi klon, tek seferlik CI işleri için sığ klon.
```

```quiz
Bir pre-commit hook'u neden güvenlik kontrolü olarak yeterli değildir?
- Hook'lar yavaştır
- [x] Depoyla paylaşılmaz ve `--no-verify` ile atlatılabilir; gerçek kontrol sunucu tarafında (CI, push kuralları) yapılmalıdır
- Hook'lar sadece Linux'ta çalışır
? Hook'lar hızlı geri bildirim içindir.
```

```quiz
Push edilmiş bir commit'te gizli bir API anahtarı fark edildi. İlk adım?
- Geçmişi filter-repo ile temizlemek
- [x] Anahtarı sağlayıcıda iptal edip yenilemek; geçmişi temizlemek sızıntıyı geri almaz
- Commit'i revert etmek
? Push edilmiş gizli bilgi sızmış kabul edilir; temizlik ikinci adımdır.
```

## Özet

- Silinen dosyalar geçmişte kalır ve her klona iner. Sığ klon (`--depth`) CI için, kısmi klon (`--filter=blob:none`) geliştirici için, seyrek checkout monorepo'lar için.
- Büyük ikili dosyalar LFS'e (baştan), derleme çıktıları artifact deposuna. Submodule'ler sadece bağımsız sürümlenen bileşenler için.
- Hook'lar: `pre-commit`, `commit-msg`, `pre-push`. Paylaşmak için `core.hooksPath` ya da bir çerçeve; atlatılabilirler, gerçek kontrol sunucuda. Kontrolleri olumlu ve olumsuz örneklerle dene.
- SSH ile commit imzalama: `gpg.format ssh`, `user.signingkey`, `allowedSignersFile`, `%G?`. GitLab'da "Verified" ve imza zorunluluğu.
- Sızan gizli bilgi: önce iptal et ve yenile, sonra `filter-repo` ile temizle (filter-branch'te `refs/original`, reflog ve gc), zorla push, herkes yeniden klonlasın, GitLab repository cleanup. Önleme: hook + CI secret detection + secret manager.
