# Uzak depolar, fetch/pull/push ve sürüm etiketleri

Git'te "sunucu" özel bir şey değildir: Uzak depo, bağlantı adresini bildiğin başka bir depodur. GitLab, GitHub ya da bir dosya sunucusundaki çıplak (bare) bir depo; hepsi aynı modelle çalışır. Bu derste iki geliştiricinin aynı depoda çalışmasını adım adım canlandırıyoruz: uzak izleme dalları, `fetch` ile `pull` farkı, reddedilen push'lar, zorla push'un güvenli yolu, ve sürümleri etiketlemek.

## Laboratuvar: bir sunucu ve iki geliştirici

Kendi makinende bir **çıplak depo** (çalışma dizini olmayan, sadece `.git` içeriği olan depo) sunucu rolünü oynayacak. Ayşe ve Mehmet onu klonlayacak:

```bash
ayse()   { export GIT_AUTHOR_NAME="Ayşe Demir"  GIT_AUTHOR_EMAIL="ayse@ornek.com"   GIT_COMMITTER_NAME="Ayşe Demir"  GIT_COMMITTER_EMAIL="ayse@ornek.com"; }
mehmet() { export GIT_AUTHOR_NAME="Mehmet Kaya" GIT_AUTHOR_EMAIL="mehmet@ornek.com" GIT_COMMITTER_NAME="Mehmet Kaya" GIT_COMMITTER_EMAIL="mehmet@ornek.com"; }
t() { export GIT_AUTHOR_DATE="2026-11-26T$1:00+03:00" GIT_COMMITTER_DATE="2026-11-26T$1:00+03:00"; }

mkdir -p ~/git-egitim/uzak && cd ~/git-egitim/uzak
git init --bare -b main sunucu.git

ayse; t 16:00
git clone sunucu.git ayse && cd ayse && git config core.autocrlf false
echo "port: 8080" > config.yaml && git add . && git commit -m "Yapılandırma"
git push -u origin main
git remote -v
git branch -vv
```

```text
origin	~/git-egitim/uzak/sunucu.git (fetch)
origin	~/git-egitim/uzak/sunucu.git (push)

* main 55ff75c [origin/main] Yapılandırma
```

`origin`, klonlanan deponun varsayılan adıdır. `-u` (`--set-upstream`), yerel `main`'in `origin/main`'i **takip** etmesini ayarladı: `[origin/main]`. Bundan sonra argümansız `git push` ve `git pull` nereye gideceğini bilir. (`push.autoSetupRemote true` ayarıyla yeni dallarda `-u` gerekmez.)

```bash
cd .. && mehmet
git clone sunucu.git mehmet && cd mehmet && git config core.autocrlf false
git config pull.rebase true
```

> **Dikkat:** Windows'ta Git for Windows'un sistem yapılandırması `core.autocrlf = true` içerir. Klonlamadan **sonra** `autocrlf false` dersen, çalışma dizinindeki dosyalar zaten CRLF ile çıkmıştır ve ilk `git add .` bütün satırları değişmiş olarak ekler. Bu derse hazırlanırken tam olarak bu yaşandı: Mehmet'in "README ekle" commit'i `config.yaml`'ın bütün satırlarını da değiştirdi ve sonraki rebase'de çakışma çıktı. Kalıcı çözüm, depoya bir `.gitattributes` koymaktır (günlük iş akışı dersi). Deneme için klonu `git clone -c core.autocrlf=false ...` ile yapabilirsin.

## Uzak izleme dalları ve fetch

Ayşe bir değişiklik push ediyor, Mehmet de bu arada kendi yerelinde bir commit yapıyor:

```bash
cd ../ayse; ayse
echo "timeout: 30" >> config.yaml; t 16:05; git commit -am "Timeout ekle"; git push

cd ../mehmet; mehmet
echo "# Servis" > README.md; git add .; t 16:06; git commit -m "README ekle"
git push
```

```text
To ~/git-egitim/uzak/sunucu.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to '~/git-egitim/uzak/sunucu.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
```

Push reddedildi. Push, sunucudaki dalı **sadece fast-forward ile** ilerletir: Mehmet'in `main`'i, sunucudaki `main`'i (Ayşe'nin commit'ini) içermiyor, ve kabul edilseydi Ayşe'nin commit'i kaybolurdu. Önce sunucudakini almak gerekiyor:

```bash
git fetch
git status -sb | head -1
git log --oneline --graph --all
```

```text
From ~/git-egitim/uzak/sunucu
   55ff75c..a408db0  main       -> origin/main

## main...origin/main [ahead 1, behind 1]

* 579a2aa (HEAD -> main) README ekle
| * a408db0 (origin/main, origin/HEAD) Timeout ekle
|/
* 55ff75c Yapılandırma
```

`fetch`, sunucudaki yeni commit'leri indirdi ve `origin/main`'i güncelledi. **Yerel `main`'e dokunmadı.** `origin/main` bir **uzak izleme dalıdır**: "Son fetch'te sunucudaki `main` buradaydı" bilgisini tutan, salt okunur bir yerel işaretçi. `[ahead 1, behind 1]`: Benim 1 commit'im onda yok, onun 1 commit'i bende yok. Detayı:

```bash
git log --oneline main..origin/main     # sunucuda olup bende olmayan
git log --oneline origin/main..main     # bende olup sunucuda olmayan
```

```text
a408db0 Timeout ekle
579a2aa README ekle
```

`fetch` **her zaman güvenlidir**: Hiçbir yerel dalı ya da dosyayı değiştirmez. Ne geleceğini görmeden birleştirmek istemiyorsan önce fetch et, incele, sonra birleştir. Birçok IDE arka planda düzenli fetch yapar.

## pull = fetch + birleştirme

`git pull`, `fetch` ve ardından mevcut dalı uzak izleme dalıyla birleştirmektir. Birleştirme yöntemi ayara bağlı:

- `pull.rebase false` (eski varsayılan): Merge. Her pull'da "Merge branch 'main' of ..." gibi anlamsız merge commit'leri oluşur.
- `pull.rebase true`: Yerel commit'lerini uzaktakilerin üzerine rebase et. Doğrusal geçmiş. Henüz push edilmemiş yerel commit'leri rebase etmek altın kurala uygundur (sadece senin commit'lerin).
- `pull.ff only`: Sadece fast-forward. Ayrışma varsa durur ve karar vermeni ister.

Mehmet `pull.rebase true` ayarladı:

```bash
t 16:07; git pull
git log --oneline --graph --all
git push
git status -sb | head -1
```

```text
Successfully rebased and updated refs/heads/main.

* 3c27d33 (HEAD -> main) README ekle
* a408db0 (origin/main, origin/HEAD) Timeout ekle
* 55ff75c Yapılandırma

## main...origin/main
```

Mehmet'in commit'i Ayşe'ninkinin üzerine taşındı (yeni hash: 3c27d33), push artık bir fast-forward ve kabul edildi.

## Zorla push ve --force-with-lease

Kendi özellik dalını rebase ettiğinde ya da `--amend` ile değiştirdiğinde, push zorunlu olarak reddedilir (sunucudaki commit'ler senin yeni geçmişinde yok). Zorla push gerekir. Ama `--force` tehlikelidir. Senaryo: Ayşe bir özellik dalı açıyor, Mehmet de aynı dala bir commit ekliyor, Ayşe haberi olmadan kendi commit'ini düzeltip zorla push ediyor:

```bash
cd ../ayse; ayse; git pull --rebase
git switch -c ozellik
echo "replicas: 2" >> config.yaml; t 16:10; git commit -am "Replika ekle"
git push -u origin ozellik

cd ../mehmet; mehmet
git fetch && git switch ozellik
echo "# replika notu" >> README.md; t 16:12; git commit -am "Replika notu"
git push

cd ../ayse; ayse
t 16:14; git commit --amend -m "Replika sayısını ekle"     # Ayşe Mehmet'in push'undan habersiz
git push --force-with-lease
```

```text
To ~/git-egitim/uzak/sunucu.git
 ! [rejected]        ozellik -> ozellik (stale info)
error: failed to push some refs to '~/git-egitim/uzak/sunucu.git'
```

```bash
git fetch && git log --oneline --graph ozellik origin/ozellik
```

```text
* bda495f (HEAD -> ozellik) Replika sayısını ekle
| * e0de567 (origin/ozellik) Replika notu
| * 46df04a Replika ekle
|/
* 3c27d33 (origin/main, main) README ekle
```

`--force-with-lease`, "sunucudaki dal hâlâ **benim son gördüğüm** yerdeyse (`origin/ozellik` = 46df04a) üzerine yaz" demektir. Sunucuda Mehmet'in e0de567'si vardı, beklenen değil, push reddedildi (`stale info`). `--force` olsaydı, Mehmet'in commit'i **sunucudan sessizce silinirdi**.

Kalan bir risk: `fetch` yapıp (ya da IDE arka planda yaptıysa) `origin/ozellik`'i güncellediysen, lease yeni değere göre kontrol edilir ve Mehmet'in commit'ini **incelemeden** ezersin. `--force-if-includes` (2.30+), uzaktaki ucun yerel geçmişine gerçekten dahil edildiğini de kontrol eder: `git config --global push.useForceIfIncludes true`. Paylaşılan dallarda (`main`, `release/*`) zorla push'u hiç yapma. GitLab'da korumalı dallarla zaten engellenir (GitLab dersi).

Doğru akış: Ayşe önce Mehmet'in commit'ini alır (`git pull --rebase`), sonra push eder.

## Sürüm etiketleri

Bir **etiket** (tag), bir commit'e kalıcı bir ad verir. Dallardan farkı: Etiketler hareket etmez.

```bash
git switch main
t 16:20; git tag -a v1.0.0 -m "İlk sürüm"     # açıklamalı etiket
git tag v1.0.0-hafif                            # hafif etiket
git cat-file -t v1.0.0
git cat-file -t v1.0.0-hafif
git cat-file -p v1.0.0
```

```text
tag
commit

object 3c27d33b5c68e67eba984493695a9407a458640f
type commit
tag v1.0.0
tagger Ayşe Demir <ayse@ornek.com> 1795699200 +0300

İlk sürüm
```

- **Açıklamalı** (`-a`) etiket, ilk dersteki modelin dördüncü nesne türüdür: kendi yazarı, zamanı ve mesajı olan bir **tag nesnesi**, imzalanabilir. Sürümler için her zaman bunu kullan.
- **Hafif** etiket, bir commit'e işaret eden düz bir referanstır, bir dal gibi ama hareket etmeyen. Yerel ve geçici işaretler için.

Etiketler `git push` ile **otomatik gönderilmez**:

```bash
git push origin v1.0.0           # tek bir etiket
# git push --follow-tags          # push edilen commit'lere bağlı açıklamalı etiketler
echo "z" >> config.yaml; t 16:25; git commit -am "Küçük düzeltme"
git describe --tags
git ls-remote --tags origin
```

```text
v1.0.0-1-gabefd80

57172a62ca40c3cc6f5794802c198e110f819802	refs/tags/v1.0.0
3c27d33b5c68e67eba984493695a9407a458640f	refs/tags/v1.0.0^{}
```

`git describe`: "en yakın etiketten bu yana 1 commit, şu an `abefd80`'deyim." Derleme sırasında uygulamaya gömülen sürüm dizgesi için idealdir (React kursundaki `/version.json` gibi). `ls-remote`'taki `^{}` satırı, etiket nesnesinin işaret ettiği commit'tir.

**Semantik sürümleme** (SemVer): `MAJOR.MINOR.PATCH`. Geriye uyumsuz değişiklikte MAJOR, yeni özellikte MINOR, hata düzeltmesinde PATCH artar. Yayınlanmış bir etiketi **asla taşıma ya da silip yeniden oluşturma**: Onu çeken herkesin ve her önbelleğin (Docker imajları, paket depoları) "v1.0.0" anlamı bozulur. Hata varsa v1.0.1 çıkar. GitLab'da etiketler korunabilir ve CI pipeline'ları etiket oluşturulduğunda sürüm yayınlayacak şekilde ayarlanır (CI dersleri).

## Uzak dalları temizlemek

```bash
git push origin --delete ozellik       # sunucudaki dalı sil

cd ../mehmet
git branch -r
git fetch --prune
git branch -r
```

```text
  origin/HEAD -> origin/main
  origin/main
  origin/ozellik

From ~/git-egitim/uzak/sunucu
 - [deleted]         (none)     -> origin/ozellik
 * [new tag]         v1.0.0     -> v1.0.0

  origin/HEAD -> origin/main
  origin/main
```

Sunucuda silinen dalların uzak izleme dalları, `--prune` olmadan yerelde sonsuza kadar kalır. `git config --global fetch.prune true` ile her fetch'te temizlenir. Merge request birleştirildiğinde kaynak dalın otomatik silinmesi GitLab'da bir proje ayarıdır.

## Kimlik doğrulama

- **SSH:** `ssh-keygen -t ed25519 -C "ayse@ornek.com"`, açık anahtarı GitLab'a ekle, `git@gitlab.com:grup/proje.git` biçiminde adres. Anahtarı parolayla koru ve `ssh-agent` kullan.
- **HTTPS + token:** Parola yerine kişisel erişim jetonu (GitLab'da Personal Access Token, kapsamı `read_repository`/`write_repository` ile sınırlı ve **son kullanma tarihli**). Jetonu bir kimlik bilgisi yardımcısında sakla (`git config --global credential.helper manager` Windows'ta, `osxkeychain` macOS'ta). Jetonu **asla** uzak adresin içine yazma (`https://kullanici:jeton@...`): `.git/config`'te düz metin olarak kalır ve loglara sızar.
- **Makineler için:** CI sistemleri ve sunucular kişisel hesaplarla değil, **deploy token** ya da **deploy key** (sadece belirli bir proje, sadece okuma) ile bağlanır. GitLab CI içinde `CI_JOB_TOKEN` otomatik sağlanır (CI dersleri).

## Alıştırma

1. Bir fork akışı: Sen `origin` olarak kendi kopyanı klonladın, asıl proje `upstream`. Asıl projedeki yenilikleri kendi `main`'ine nasıl alırsın?
2. `git pull` sonrası geçmişinde "Merge branch 'main' of gitlab.com:..." commit'leri birikiyor. Sebep ne, nasıl önlersin?
3. Yanlışlıkla `v2.0.0` etiketini yanlış commit'e koyup push ettin, ve CI bu etikete göre bir Docker imajı yayınladı. Ne yaparsın?

<details><summary>Çözüm</summary>

1.

```bash
git remote add upstream https://gitlab.com/asil-grup/proje.git
git fetch upstream
git switch main
git rebase upstream/main        # ya da: git merge --ff-only upstream/main
git push origin main
```

`git remote -v` artık iki uzak depo gösterir. Özellik dalları `upstream/main`'in üzerine açılır, push `origin`'e yapılır, merge request `origin`'deki daldan `upstream`'e açılır.

2. `pull` merge ile çalışıyor ve yerelde push edilmemiş commit'ler varken uzakta yeni commit'ler olduğunda her seferinde bir merge commit'i oluşuyor. Çözüm: `git config --global pull.rebase true` (yerel commit'leri uzaktakilerin üzerine taşı) ya da `pull.ff only` (ayrışmada dur, kararı sen ver). Takımca uygulanacak bir kural olarak yazılmalı.

3. Etiketi taşıma. Yayınlanmış bir imaj, onu çekmiş sistemler ve önbellekler var. Yanlış etiket artık "v2.0.0 = o commit" anlamını taşıyor. Doğru içerikle **v2.0.1** yayınla, ve v2.0.0'ın hatalı olduğunu sürüm notlarında belirt (gerekirse registry'de o imajı "kullanımdan kaldırıldı" olarak işaretle). Hiçbir sistemin çekmediğinden eminsen (dakikalar içinde fark edildiyse), etiketi silip (`git push origin --delete v2.0.0`, `git tag -d v2.0.0`) doğru commit'te yeniden oluşturmak mümkündür, ama bu istisnadır. Etiketleri korumalı yapmak, ve sürüm etiketlerini sadece CI'ın oluşturmasına izin vermek bu tür hataları azaltır.

</details>

```quiz
`git fetch` ile `git pull` arasındaki fark nedir?
- İkisi aynıdır
- [x] fetch sadece uzak izleme dallarını (origin/main) günceller, yerel dallara dokunmaz; pull fetch'ten sonra yerel dalı birleştirir (merge ya da rebase)
- fetch dosyaları, pull commit'leri indirir
? fetch her zaman güvenlidir; ne geleceğini görmeden birleştirmek istemiyorsan önce fetch.
```

```quiz
`git push --force-with-lease` neyi kontrol eder?
- Push yetkisini
- [x] Sunucudaki dalın, senin son gördüğün (uzak izleme dalındaki) değerde olup olmadığını; değilse push'u reddeder
- Commit imzalarını
? Başkasının push ettiği commit'leri sessizce silmeni önler; push.useForceIfIncludes ile daha güvenli.
```

```quiz
Yayınlanmış bir sürüm etiketi yanlış commit'e konduysa en doğru çözüm genellikle hangisidir?
- Etiketi silip doğru yere yeniden koymak
- [x] Etiketi olduğu gibi bırakıp düzeltilmiş içerikle yeni bir sürüm (patch) yayınlamak
- Commit'i amend etmek
? Etiketlere dayanan imajlar, paketler ve önbellekler değişmeyen anlamlara güvenir.
```

## Özet

- Uzak depo başka bir depodur; `origin` varsayılan ad. Takip (upstream) ile argümansız push/pull.
- `origin/main` uzak izleme dalıdır: son fetch'teki sunucu durumu. `fetch` güvenli, yerel dallara dokunmaz. `status -sb`'de ahead/behind, `main..origin/main`.
- Push sadece fast-forward ile ilerletir; reddedilirse önce al. `pull` = fetch + merge/rebase; `pull.rebase true` ya da `pull.ff only`.
- Zorla push: `--force-with-lease` (+ `push.useForceIfIncludes`), asla paylaşılan dallarda.
- Açıklamalı etiketler sürümler için; `--follow-tags`, `describe`. SemVer; yayınlanmış etiket taşınmaz.
- `fetch.prune`, uzak dal silme. SSH anahtarı ya da süreli token; makineler için deploy token/key.
