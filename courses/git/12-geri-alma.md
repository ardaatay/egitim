# Geri alma ve kurtarma: reset, revert, reflog, bisect

"Yanlışlıkla `reset --hard` yaptım, her şey gitti" cümlesi çoğu zaman doğru değildir. Git, commit edilmiş hemen her şeyi bir süre saklar. Bu derste geri almanın doğru aracını seçmeyi (`reset` mi, `revert` mi?), kaybolmuş commit'leri reflog ile kurtarmayı, yarım işi bir kenara koymayı (`stash`), bir commit'i başka bir dala taşımayı (`cherry-pick`), ve hatayı getiren commit'i otomatik bulmayı (`bisect`) ele alıyoruz.

Deneme deposu: 12 commit'lik bir geçmiş, ve 7. değişiklikte gizlenmiş bir hata (toplama fonksiyonu çıkarma yapmaya başlıyor):

```bash
t() { export GIT_AUTHOR_DATE="2026-11-26T$1:00+03:00" GIT_COMMITTER_DATE="2026-11-26T$1:00+03:00"; }
cd ~/git-egitim && git init -b main geri && cd geri && git config core.autocrlf false
printf '#!/bin/sh\ntopla() { echo $(( $1 + $2 )); }\n' > hesap.sh
t 15:00; git add .; git commit -qm "Toplama fonksiyonu"
for i in 1 2 3 4 5 6 7 8 9 10 11; do
  if [ $i = 7 ]; then
    sed -i 's/\$1 + \$2/$1 - $2/' hesap.sh; m="Hesaplamayı sadeleştir"
  else
    echo "# not $i" >> notlar.txt; m="Değişiklik $i"
  fi
  t 15:$(printf %02d $((i*2))); git add .; git commit -qm "$m"
done
git log --oneline | head -3
```

```text
d5167af Değişiklik 11
53f5d1e Değişiklik 10
585b93f Değişiklik 9
```

## reset: dalı başka bir commit'e taşımak

`git reset <commit>`, **içinde bulunduğun dalı** belirtilen commit'e taşır. Üç modu, index'e ve çalışma dizinine ne olacağını belirler:

| Mod | Dal | Index | Çalışma dizini | Kullanım |
|---|---|---|---|---|
| `--soft` | taşınır | dokunulmaz | dokunulmaz | Son birkaç commit'i tek commit'e birleştirmek |
| `--mixed` (varsayılan) | taşınır | commit'e eşitlenir | dokunulmaz | Commit'i geri al, değişiklikler dosyalarda kalsın |
| `--hard` | taşınır | eşitlenir | eşitlenir | Her şeyi o commit'e döndür (commit edilmemiş değişiklikler **silinir**) |

### --soft: son iki commit'i birleştir

```bash
git reset --soft HEAD~2
git status -s
git log --oneline -1
t 15:30; git commit -m "Değişiklik 10 ve 11 birlikte"
```

```text
M  notlar.txt
585b93f Değişiklik 9
```

Dal iki commit geri gitti, ama iki commit'in değişiklikleri index'te bekliyor (`M ` sol sütunda). Yeni bir commit, ikisini tek commit olarak kaydetti. İnteraktif rebase'deki `squash`'ın hızlı yolu.

### --mixed: commit'i geri al, işi koru

```bash
echo "# gecici" >> notlar.txt; git add .; t 15:31; git commit -m "gecici"
git reset HEAD~1
git status -s
```

```text
Unstaged changes after reset:
M	notlar.txt
 M notlar.txt
```

Commit gitti, değişiklik dosyada duruyor. "Yanlış şeyi commit ettim, düzenleyip yeniden commit edeceğim" durumu.

### --hard ve reflog: kayıp commit'leri geri getirmek

```bash
git checkout -- notlar.txt
git log --oneline -3
git reset --hard HEAD~3
git log --oneline -1
```

```text
1378f92 Değişiklik 10 ve 11 birlikte
585b93f Değişiklik 9
9629819 Değişiklik 8

HEAD is now at 07dd0e5 Hesaplamayı sadeleştir
07dd0e5 Hesaplamayı sadeleştir
```

Üç commit "gitti": `git log` artık onları göstermiyor. Ama Git, **HEAD'in her hareketini** yerel bir günlükte tutar:

```bash
git reflog -4
```

```text
07dd0e5 HEAD@{0}: reset: moving to HEAD~3
1378f92 HEAD@{1}: reset: moving to HEAD~1
a56f01b HEAD@{2}: commit: gecici
1378f92 HEAD@{3}: commit: Değişiklik 10 ve 11 birlikte
```

`HEAD@{1}`, reset'ten hemen önceki konum. Geri dön:

```bash
git reset --hard HEAD@{1}
git log --oneline -1
```

```text
HEAD is now at 1378f92 Değişiklik 10 ve 11 birlikte
1378f92 Değişiklik 10 ve 11 birlikte
```

Hiçbir şey kaybolmamıştı. Reflog hakkında:

- **Yereldir.** Sunucuda ya da başka bir klonda yoktur. Senin makinende, senin hareketlerinin kaydıdır.
- Varsayılan olarak erişilebilir girdiler 90 gün, erişilemez olanlar 30 gün tutulur (`gc.reflogExpire`, `gc.reflogExpireUnreachable`). Bu süre dolana kadar çöp toplayıcı commit'leri silmez.
- **Kurtaramadığı tek şey:** Hiç commit edilmemiş ve index'e de eklenmemiş değişiklikler. `git reset --hard` ve `git restore` bunları gerçekten siler. Index'e eklenmiş ama commit edilmemiş içerik ise blob olarak depodadır ve `git fsck --lost-found` ile bulunabilir.
- Her dalın kendi reflog'u da var: `git reflog show main`, `main@{yesterday}`.

### Silinmiş bir dalı kurtarmak

```bash
git switch -c deneme; echo "deneme" > deneme.txt; git add .; t 15:35; git commit -m "Deneme özelliği"
git switch main
git branch -D deneme
git reflog -3
```

```text
Deleted branch deneme (was d0a5dec).

1378f92 HEAD@{0}: checkout: moving from deneme to main
d0a5dec HEAD@{1}: commit: Deneme özelliği
1378f92 HEAD@{2}: checkout: moving from main to deneme
```

`-D` mesajı zaten son hash'i söylüyor (`was d0a5dec`), reflog da gösteriyor. Dalı geri oluştur:

```bash
git branch deneme-geri d0a5dec
git log --oneline -1 deneme-geri
```

```text
d0a5dec Deneme özelliği
```

## bisect: hatayı getiren commit'i bulmak

Kullanıcılar toplama sonucunun yanlış olduğunu bildiriyor:

```bash
sh -c '. ./hesap.sh; topla 2 3'
```

```text
-1
```

İlk commit'te doğru çalıştığını biliyoruz. Arada 11 commit var. `git bisect`, aradaki commit'lerde **ikili arama** yapar: Her adımda aralığı yarıya böler. 1.000 commit'lik bir aralıkta bile yaklaşık 10 adımda biter. Daha iyisi, testi bir betikle verirsen bütün aramayı kendisi yapar:

```bash
cat > /tmp/test_hesap.sh <<'EOF'
#!/bin/sh
. ./hesap.sh
[ "$(topla 2 3)" = "5" ]
EOF

git bisect start HEAD "$(git rev-list --max-parents=0 HEAD)"   # kötü: HEAD, iyi: ilk commit
git bisect run sh /tmp/test_hesap.sh
```

```text
Bisecting: 4 revisions left to test after this (roughly 2 steps)
[030eaa13cefb0f674359df23b331a771c832b393] Değişiklik 5
running 'sh' '/tmp/test_hesap.sh'
Bisecting: 2 revisions left to test after this (roughly 1 step)
[07dd0e553c0a370ebfaa51a45afae533278a9c0e] Hesaplamayı sadeleştir
running 'sh' '/tmp/test_hesap.sh'
Bisecting: 0 revisions left to test after this (roughly 0 steps)
[7e49915de7df341cfb3f6a8baaf87e9d3a0ec85d] Değişiklik 6
running 'sh' '/tmp/test_hesap.sh'
07dd0e553c0a370ebfaa51a45afae533278a9c0e is the first 'bad' commit
commit 07dd0e553c0a370ebfaa51a45afae533278a9c0e
Author: Ayşe Demir <ayse@ornek.com>
Date:   Thu Nov 26 15:14:00 2026 +0300

    Hesaplamayı sadeleştir

 hesap.sh | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
bisect found first 'bad' commit
```

```bash
git bisect reset          # başladığın yere dön
```

Üç adımda, hatayı getiren commit bulundu. Betiğin çıkış kodu iletişimi sağlar: `0` iyi, `1–127` kötü, `125` "bu commit test edilemez, atla" (örneğin derlenmiyorsa). Elle kullanımda her adımda `git bisect good` / `git bisect bad` yazarsın.

`bisect`'in en değerli olduğu yer, "geçen ay çalışıyordu, şimdi çalışmıyor, arada 400 commit var" durumlarıdır: Bir performans gerilemesi, bir uyumluluk hatası. Bu da küçük ve tek amaçlı commit'lerin (günlük iş akışı dersi) bir başka faydası: Bisect, sorunu tek bir küçük değişikliğe daraltır. 300 satırlık bir "çeşitli düzeltmeler" commit'ine daraltması ise pek yardımcı olmaz.

## revert: paylaşılmış bir commit'i geri almak

Hatalı commit çoktan `main`'e push edildi ve başkaları üzerine çalışıyor. `reset` burada **kullanılmaz**: Geçmişi yeniden yazar (rebase dersindeki altın kural). `revert`, hatalı commit'in değişikliğini **tersine çeviren yeni bir commit** oluşturur:

```bash
git revert --no-edit 07dd0e5
sh -c '. ./hesap.sh; topla 2 3'
git log --oneline -2
```

```text
[main de81813] Revert "Hesaplamayı sadeleştir"
 1 file changed, 1 insertion(+), 1 deletion(-)

5

de81813 Revert "Hesaplamayı sadeleştir"
1378f92 Değişiklik 10 ve 11 birlikte
```

Hata düzeldi, geçmiş korundu, ve hem hatanın hem geri alınmasının kaydı var. Commit mesajını düzenleyip **neden** geri alındığını yazmak (`git revert` varsayılan olarak düzenleyiciyi açar) iyi bir alışkanlıktır.

### Merge commit'ini geri almak

Bütün bir özelliği geri almak gerekirse, merge commit'i geri alınır. Ama merge'ün iki ebeveyni var, Git hangi tarafa döneceğini bilmek ister:

```bash
git switch -c ozellik; echo "ozellik" > ozellik.txt; git add .; t 15:40; git commit -m "Özellik"
echo "2" >> ozellik.txt; t 15:41; git commit -am "Özellik devamı"
git switch main; t 15:45; git merge --no-ff --no-edit ozellik

git revert --no-edit HEAD
git revert --no-edit -m 1 HEAD
ls ozellik.txt
git log --oneline -3
```

```text
error: commit bc839fdee7b9f55feb5266f62b2b368b4646d74d is a merge but no -m option was given.
fatal: revert failed

[main 6d703f2] Revert "Merge branch 'ozellik'"
 1 file changed, 2 deletions(-)
 delete mode 100644 ozellik.txt

ls: cannot access 'ozellik.txt': No such file or directory

6d703f2 Revert "Merge branch 'ozellik'"
bc839fd Merge branch 'ozellik'
f4fe20f Özellik devamı
```

`-m 1`: "birinci ebeveyne (`main`'in merge öncesi haline) göre geri al." Bütün özellik tek commit'le gitti. Bu, merge dersindeki `--no-ff`'nin pratik faydası.

> **Dikkat:** Geri alınmış bir merge'ün dalını daha sonra **tekrar** merge etmek istersen, Git o commit'lerin zaten birleştirildiğini düşünür ve hiçbir şey getirmez (değişiklikler revert ile silindi ama commit'ler geçmişte duruyor). Özelliği geri getirmek için önce **revert commit'ini revert et** (`git revert 6d703f2`), sonra yeni düzeltmeleri merge et.

## stash: yarım işi bir kenara koymak

Bir dalda çalışırken acil bir iş geldi, ama değişiklikler commit edilecek durumda değil:

```bash
echo "yarim is" >> hesap.sh
echo "yeni" > yeni.txt
git stash push -u -m "hesap düzenlemesi"
git status -s
git stash list
```

```text
Saved working directory and index state On main: hesap düzenlemesi
                                          (git status -s: temiz)
stash@{0}: On main: hesap düzenlemesi
```

Çalışma dizini temiz, başka bir dala geçip acil işi yapabilirsin. `-u` takip edilmeyen dosyaları (`yeni.txt`) da saklar, yoksa onlar geride kalır. Geri dönünce:

```bash
git stash pop
git status -s
```

```text
 M hesap.sh
?? yeni.txt
Dropped refs/stash@{0} (d4566b183db4e6fe91480f02fe40767ec9b2183c)
```

`pop` uygular ve listeden siler, `apply` uygular ama listede tutar. Stash bir yığındır (`stash@{0}`, `stash@{1}`...) ve kolayca unutulur: Uzun süre duran bir stash'in hangi bağlamda yapıldığını hatırlamak zordur. Birkaç saatten uzun sürecek yarım işler için bir dalda "wip" commit'i daha iyidir (sonra interaktif rebase ile temizlenir). Bir stash'ten dal oluşturmak: `git stash branch yeni-dal`.

## cherry-pick: bir commit'i başka bir dala kopyalamak

Bir düzeltme `main`'e girdi, ama eski bir sürüm dalına (`release/1.4`) da lazım:

```bash
git switch -c hotfix HEAD~10
git cherry-pick deneme-geri
git log --oneline -2
```

```text
[hotfix 0071b17] Deneme özelliği
 1 file changed, 1 insertion(+)
 create mode 100644 deneme.txt

0071b17 Deneme özelliği
1f4b8c5 Değişiklik 3
```

`cherry-pick` commit'in değişikliğini mevcut dala **yeni bir commit** olarak uygular (farklı hash, aynı içerik ve mesaj). Kullanım alanları: hotfix'leri bakım dallarına taşımak, yanlış dala yapılmış bir commit'i doğru dala almak. `-x` seçeneği mesaja "(cherry picked from commit ...)" ekler: Bakım dallarında hangi düzeltmenin nereden geldiğini izlemek için kullan. Çok sayıda commit'i sürekli cherry-pick ediyorsan, bu dallanma stratejinde bir sorun olduğunu gösterir (akışlar dersi).

## Hangi araç?

| Durum | Araç |
|---|---|
| Commit edilmemiş değişikliği at | `git restore dosya` (kalıcı!) |
| Index'ten çıkar | `git restore --staged dosya` |
| Son commit'in mesajını/içeriğini düzelt (paylaşılmadıysa) | `git commit --amend` |
| Paylaşılmamış son commit'leri geri al, işi koru | `git reset HEAD~n` |
| Paylaşılmamış son commit'leri tamamen at | `git reset --hard HEAD~n` |
| **Paylaşılmış** bir commit'i geri al | `git revert <commit>` (merge için `-m 1`) |
| "Az önce yaptığım şey her şeyi bozdu" | `git reflog` + `git reset --hard HEAD@{n}` |
| Silinmiş dal | `git reflog` / `-D` mesajındaki hash + `git branch ad <hash>` |
| Yarım işi kenara koy | `git stash push -u` |
| Bir commit'i başka dala al | `git cherry-pick -x` |
| Hatayı getiren commit'i bul | `git bisect run` |

## Alıştırma

1. `git reset --hard` ile yanlışlıkla 5 commit'i "sildin" ve ardından başka işler yaptın (birkaç commit, bir dal değişimi). O 5 commit'i nasıl bulup geri getirirsin?
2. `main`'deki bir commit bir sabit değeri yanlış değiştirdi ve 20 commit önceydi. Arada aynı dosyada başka değişiklikler var. `revert` ne yapar? Çakışma çıkarsa ne demektir?
3. Bir regresyonu bisect ile arıyorsun ama aradaki bazı commit'ler derlenmiyor. Test betiğin bu durumda ne döndürmeli?

<details><summary>Çözüm</summary>

1. `git reflog` çıktısında `reset: moving to ...` satırını bul. Onun **bir altındaki** girdi (reset'ten önceki konum) kaybolan commit'lerin ucudur. Arada başka hareketler olduğu için `HEAD@{1}` artık o değildir. Doğru satırı mesajından ve sırasından tanı. Sonra mevcut işini bozmamak için `git branch kurtarilan <hash>` ile o commit'lere bir dal ver, ve gerekirse `git merge` ya da `git cherry-pick` ile mevcut dala getir.

2. `revert`, o commit'in farkını tersine çevirip mevcut hale uygular. Arada aynı satırlar değiştiyse (bağlam artık farklıysa) revert çakışma verir. Bu, sonraki değişikliklerin geri alınan değişikliğe **dayandığı** anlamına gelir: Körü körüne geri almak onları bozabilir. Çakışmayı çözerken sonraki commit'lerin niyetini de korumalısın. Bazen revert yerine, doğru değeri yazan yeni bir düzeltme commit'i daha anlaşılırdır.

3. `125`: "Bu commit test edilemez, atla." Bisect o commit'i atlayıp bir komşusunu dener. Derleme adımı betiğin içinde olmalı: Derleme başarısızsa `exit 125`, test başarısızsa `exit 1`, geçerse `exit 0`.

</details>

```quiz
`git reset --hard HEAD~3` ile kaybolan commit'leri geri getirmenin yolu?
- Kaybolanlar geri getirilemez
- [x] `git reflog` ile reset'ten önceki konumu bulup `git reset --hard HEAD@{n}` (ya da o hash'e bir dal oluşturmak)
- `git revert HEAD~3`
? Reflog HEAD'in her hareketini yerel olarak kaydeder; commit'ler süre dolana kadar silinmez.
```

```quiz
Başkalarının da çektiği main'deki hatalı bir commit'i nasıl geri alırsın?
- `git reset --hard` ile ve zorla push
- [x] `git revert <commit>`: değişikliği tersine çeviren yeni bir commit, geçmiş korunur
- `git commit --amend`
? Paylaşılmış geçmişi yeniden yazmak, başkalarının geçmişiyle çatışır.
```

```quiz
`git bisect run` için test betiği hangi çıkış kodunu döndürmelidir?
- Her zaman 0
- [x] İyi commit'te 0, kötü commit'te 1–127 (125 hariç), test edilemeyen commit'te 125
- Sadece 1 ya da 2
? Bisect çıkış koduna göre aralığı yarıya böler.
```

## Özet

- `reset`: dalı taşır. `--soft` (index'te kalsın), `--mixed` (dosyalarda kalsın), `--hard` (her şeyi eşitle; commit edilmemiş değişiklikler gider). Sadece paylaşılmamış commit'lerde.
- `reflog`: HEAD'in yerel hareket günlüğü. Reset, rebase, silinmiş dal: hepsi buradan geri gelir. Kurtaramadığı: hiç eklenmemiş değişiklikler.
- `revert`: paylaşılmış commit'i yeni bir commit'le geri al; merge için `-m 1`; geri alınmış merge'ü tekrar getirmek için revert'ü revert et.
- `stash push -u`, `pop`/`apply`; uzun süreli işler için wip commit'i.
- `cherry-pick -x`: commit'i başka dala kopyala.
- `bisect run`: ikili aramayla hatayı getiren commit; çıkış kodları 0/1/125.
