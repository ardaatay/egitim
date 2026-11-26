# Rebase, interaktif rebase ve temiz geçmiş

Merge iki geçmişi birleştirir ve dalların varlığını korur. **Rebase** ise bir dalın commit'lerini alıp başka bir noktanın üzerine **yeniden uygular**: Sanki dalı en baştan oraya açmışsın gibi. Sonuç doğrusal, okunması kolay bir geçmiştir. Bunun bedeli, commit'lerin **yeni** commit'ler olmasıdır (ilk dersteki model: Ebeveyn değişirse hash değişir). Bu ders rebase'in ne yaptığını, interaktif rebase ile paylaşmadan önce geçmişi düzenlemeyi, ve ne zaman rebase **yapılmaması** gerektiğini anlatıyor.

Deneme deposu:

```bash
t() { export GIT_AUTHOR_DATE="2026-11-26T$1:00+03:00" GIT_COMMITTER_DATE="2026-11-26T$1:00+03:00"; }
cd ~/git-egitim && git init -b main rebase && cd rebase && git config core.autocrlf false
printf 'def saglik():\n    return "ok"\n' > api.py
t 13:00; git add . && git commit -m "Sağlık ucunu ekle"

git switch -c metrikler
printf 'def metrikler():\n    return {}\n' > metrik.py; git add .; t 13:05; git commit -m "Metrik ucunu ekle"
printf 'def metrikler():\n    return {"istek": 0}\n' > metrik.py; t 13:10; git commit -am "Metriklere istek sayısı ekle"

git switch main
printf 'def saglik():\n    return "ok"\n\ndef surum():\n    return "1.4.0"\n' > api.py
t 13:15; git commit -am "Sürüm ucunu ekle"
git log --oneline --graph --all
```

```text
* 9d14556 (HEAD -> main) Sürüm ucunu ekle
| * f2f96af (metrikler) Metriklere istek sayısı ekle
| * 59fdfb8 Metrik ucunu ekle
|/
* 8054d9b Sağlık ucunu ekle
```

## Rebase ne yapar?

```bash
git switch metrikler
t 13:20; git rebase main
git log --oneline --graph --all
```

```text
Successfully rebased and updated refs/heads/metrikler.

* f1b4baf (HEAD -> metrikler) Metriklere istek sayısı ekle
* 82fb3b6 Metrik ucunu ekle
* 9d14556 (main) Sürüm ucunu ekle
* 8054d9b Sağlık ucunu ekle
```

Git:

1. `metrikler`'in `main`'de olmayan commit'lerini (59fdfb8, f2f96af) buldu,
2. `metrikler`'i `main`'in ucuna taşıdı,
3. O commit'lerin değişikliklerini (farklarını) sırayla yeniden uyguladı ve **yeni commit'ler** oluşturdu: 82fb3b6 ve f1b4baf. Mesajlar, yazar ve içerik aynı, ama ebeveynler (ve commit zamanı) farklı, dolayısıyla hash'ler farklı.

Eski commit'ler (59fdfb8, f2f96af) silinmedi: Artık hiçbir dal onlara işaret etmiyor, ama reflog'da duruyorlar (geri alma dersi). Şimdi `main`'e birleştirmek bir fast-forward'dır:

```bash
git switch main
git merge --ff-only metrikler
git log --oneline --graph
```

```text
Updating 9d14556..f1b4baf
Fast-forward
 metrik.py | 2 ++

* f1b4baf (HEAD -> main, metrikler) Metriklere istek sayısı ekle
* 82fb3b6 Metrik ucunu ekle
* 9d14556 Sürüm ucunu ekle
* 8054d9b Sağlık ucunu ekle
```

Merge commit'i yok, dallanma yok: Düz bir çizgi. `--ff-only`, fast-forward mümkün değilse merge'ü reddeder. "Önce rebase et" politikasını uygulamanın güvenli yolu budur.

## Altın kural

> **Dikkat:** Başkalarının üzerine çalıştığı (push edilmiş, paylaşılmış) commit'leri rebase etme.

Rebase eski commit'leri yenileriyle **değiştirir**. Sen `main`'i rebase edip zorla push edersen, takım arkadaşlarının yerelindeki `main` hâlâ eski commit'lere dayanır. Bir sonraki pull'da Git iki farklı geçmiş görür: Aynı değişiklikler iki kez görünür, çakışmalar çıkar, ve birinin işi kolayca kaybolur.

Pratik kural:

- **Kendi özellik dalın, henüz kimse üzerine çalışmıyorsa:** Rebase serbest. `main`'deki yenilikleri almak için `git rebase main`, geçmişi temizlemek için interaktif rebase.
- **Paylaşılan dallar** (`main`, `release/*`, birden çok kişinin çalıştığı özellik dalları): Asla rebase yok, sadece merge.
- Kendi dalını rebase edip push ettiysen, zorla push gerekir: Her zaman `git push --force-with-lease` kullan, `--force` değil (uzak depolar dersi).

## İnteraktif rebase: paylaşmadan önce geçmişi düzenlemek

Çalışırken commit'ler genellikle dağınıktır: "wip", hata ayıklama dosyaları, "yazım hatası düzelt". Bunları paylaşmadan önce mantıklı commit'lere dönüştürmek, inceleyenin işini (ve gelecekte `blame` okuyan herkesin işini) kolaylaştırır.

```bash
git switch -c onbellek
printf 'CACHE = {}\n' > cache.py
printf 'def test_bos():\n    assert CACHE == {}\n' > test_cache.py
git add .; t 13:25; git commit -m "Önbellek ekle"
printf 'CACHE = {}\nTTL = 60\n' > cache.py; t 13:30; git commit -am "wip"
printf 'print("debug")\n' > debug.py; git add .; t 13:35; git commit -m "debug dosyasi"
printf 'CACHE = {}\nTTL = 60\nMAX = 1000\n' > cache.py; t 13:40; git commit -am "Önbelleğe boyut sınırı ekle"
git log --oneline main..
```

```text
dff33a8 Önbelleğe boyut sınırı ekle
028e0e1 debug dosyasi
feedc29 wip
7f2d6b3 Önbellek ekle
```

`git rebase -i main` bir düzenleyicide bu commit'lerin listesini (eskiden yeniye) açar:

```text
pick 7f2d6b3 Önbellek ekle
pick feedc29 wip
pick 028e0e1 debug dosyasi
pick dff33a8 Önbelleğe boyut sınırı ekle

# Commands:
# p, pick   = commit'i olduğu gibi kullan
# r, reword = commit'i kullan, mesajını düzenle
# e, edit   = commit'i kullan, ama değiştirmek için dur
# s, squash = bir öncekiyle birleştir, mesajları da birleştir
# f, fixup  = bir öncekiyle birleştir, bu commit'in mesajını at
# d, drop   = commit'i sil
# (satırların sırasını değiştirmek commit'lerin sırasını değiştirir)
```

(Git'in açıklama satırları İngilizcedir; burada kısaltılıp Türkçeleştirildi.) "wip"i bir önceki commit'e katıp, debug dosyasını atalım:

```text
pick 7f2d6b3 Önbellek ekle
fixup feedc29 wip
drop 028e0e1 debug dosyasi
pick dff33a8 Önbelleğe boyut sınırı ekle
```

Kaydet ve kapat:

```text
Successfully rebased and updated refs/heads/onbellek.
```

```bash
git log --oneline main..
git show --stat HEAD~1 | tail -3
```

```text
09349c5 Önbelleğe boyut sınırı ekle
91cbda4 Önbellek ekle

 cache.py      | 2 ++
 test_cache.py | 2 ++
 2 files changed, 4 insertions(+)
```

Dört dağınık commit, iki anlamlı commit oldu. "Önbellek ekle" artık TTL satırını da içeriyor (`cache.py | 2 ++`), ve hata ayıklama dosyası hiç yokmuş gibi.

### fixup! ve autosquash

İnceleme sırasında "Önbellek ekle" commit'inde bir eksik fark edildi: Test dosyası import'u unutmuş. Düzeltmeyi yeni bir commit olarak yap, ama hangi commit'i düzelttiğini Git'e söyle:

```bash
printf 'from cache import CACHE\n\ndef test_bos():\n    assert CACHE == {}\n' > test_cache.py
t 13:45; git commit -a --fixup=HEAD~1
git log --oneline main..
```

```text
3edb851 fixup! Önbellek ekle
09349c5 Önbelleğe boyut sınırı ekle
91cbda4 Önbellek ekle
```

```bash
git rebase -i --autosquash main     # liste zaten düzenlenmiş olarak açılır, kaydet ve kapat
git log --oneline main..
git show HEAD~1:test_cache.py
```

```text
13d3c1c Önbelleğe boyut sınırı ekle
3a77120 Önbellek ekle

from cache import CACHE

def test_bos():
    assert CACHE == {}
```

`--autosquash`, `fixup! <mesaj>` commit'lerini otomatik olarak hedeflerinin hemen altına `fixup` olarak taşıdı. Düzeltme, orijinal commit'in içine girdi. İnceleme turlarında bu akış çok kullanışlıdır: İnceleyen kişi düzeltmeleri ayrı commit'ler olarak görür, birleştirmeden önce tek komutla temizlenir. `git config --global rebase.autoSquash true` ile her `rebase -i`'de otomatik olur.

Dikkat: Bir fixup, hedef commit'ten **sonraki** commit'lerin değiştirdiği satırlara dokunuyorsa, onu öne taşımak çakışma çıkarır (fixup, sonraki commit'lerin değişikliklerinden önce uygulanır). Düzeltmeler küçük ve hedefli olduğunda autosquash sorunsuz çalışır.

## --onto: bir dalı başka bir tabana taşımak

`ozellik-b`'yi yanlışlıkla `ozellik-a`'nın üzerinde açtın, ama B'nin A'ya hiçbir bağımlılığı yok. B'nin A olmadan `main`'e gidebilmesi için:

```bash
git switch main
git switch -c ozellik-a; echo a > a.txt; git add .; t 13:50; git commit -m "A özelliği"
git switch -c ozellik-b; echo b > b.txt; git add .; t 13:55; git commit -m "B özelliği (A'ya bağlı değil)"
git log --oneline --graph main..ozellik-b
git rebase --onto main ozellik-a ozellik-b
git log --oneline --graph main..ozellik-b
```

```text
* 7df4c20 (ozellik-b) B özelliği (A'ya bağlı değil)
* 8d12665 (ozellik-a) A özelliği

* c281889 (HEAD -> ozellik-b) B özelliği (A'ya bağlı değil)
```

`git rebase --onto YENİ_TABAN ESKİ_TABAN DAL`: "`DAL`'ın `ESKİ_TABAN`'dan sonraki commit'lerini al, `YENİ_TABAN`'ın üzerine koy." B artık doğrudan `main`'in üzerinde, A'dan bağımsız. Birbirine bağlı dallar zinciri (stacked branches) ile çalışırken, `git rebase --update-refs` zincirdeki bütün dalları tek seferde günceller.

## Rebase sırasında çakışma

Rebase, commit'leri tek tek uyguladığı için her commit'te çakışma çıkabilir:

```bash
git switch main
printf 'def saglik():\n    return "ok"\n\ndef surum():\n    return "1.5.0"\n' > api.py
t 14:00; git commit -am "Sürümü 1.5.0 yap"
git switch -c surum-yukselt HEAD~1
sed -i 's/1.4.0/2.0.0/' api.py; t 14:05; git commit -am "Sürümü 2.0.0 yap"
git rebase main
```

```text
CONFLICT (content): Merge conflict in api.py
error: could not apply 33ef371... Sürümü 2.0.0 yap
hint: Resolve all conflicts manually, mark them as resolved with
hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
hint: You can instead skip this commit: run "git rebase --skip".
hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
```

Merge'deki gibi çöz, sonra `--continue`:

```bash
# api.py'yi düzenle: 2.0.0 kalsın
git add api.py
git rebase --continue
git log --oneline -3
```

```text
Successfully rebased and updated refs/heads/surum-yukselt.

c43a429 (HEAD -> surum-yukselt) Sürümü 2.0.0 yap
a9c765e (main) Sürümü 1.5.0 yap
f1b4baf (metrikler) Metriklere istek sayısı ekle
```

Bir fark: Rebase sırasında `ours` ve `theirs` **ters** anlama gelir. Rebase, senin commit'lerini hedefin üzerine uyguladığı için "ours" hedef dal (`main`), "theirs" senin uygulanmakta olan commit'indir. `git checkout --ours` kullanırken bu karışıklığa dikkat et.

Dalda 15 commit varsa ve hepsi aynı satıra dokunuyorsa, rebase aynı çakışmayı 15 kez sorabilir. O durumda ya önce commit'leri interaktif rebase ile birleştir, ya `rerere`'yi aç (önceki ders), ya da merge kullan (tek bir çakışma çözümü).

## Rebase ve reflog

Rebase'in ne yaptığı reflog'da adım adım görünür:

```bash
git reflog -6
```

```text
c43a429 HEAD@{0}: rebase (finish): returning to refs/heads/surum-yukselt
c43a429 HEAD@{1}: rebase (continue): Sürümü 2.0.0 yap
a9c765e HEAD@{2}: rebase (start): checkout main
33ef371 HEAD@{3}: commit: Sürümü 2.0.0 yap
f1b4baf HEAD@{4}: checkout: moving from main to surum-yukselt
a9c765e HEAD@{5}: commit: Sürümü 1.5.0 yap
```

`HEAD@{3}` (33ef371) rebase'den önceki halin: Rebase sonucu beğenmezsen `git reset --hard 33ef371` ya da `git reset --hard ORIG_HEAD` ile her şey eskisi gibi olur. Rebase'den korkmana gerek yok: Bozduğun her şey reflog'da duruyor (bir sonraki ders).

## Merge mi, rebase mi?

İkisi de doğru araçtır, farklı işler için:

| | Merge | Rebase |
|---|---|---|
| Geçmiş | Gerçekte olduğu gibi: paralel geliştirme görünür | Doğrusal, "sanki sırayla yazılmış" |
| Commit'ler | Değişmez | Yeni commit'ler (yeni hash'ler) |
| Paylaşılan dallar | Güvenli | **Asla** |
| Çakışmalar | Bir kez çözülür | Her commit'te ayrı ayrı çıkabilir |
| Bir özelliği geri almak | `revert -m 1 <merge>` tek adım | Her commit ayrı ayrı |

Yaygın ve sağlıklı bir ekip pratiği ikisini birleştirir:

- Kendi dalında: `main`'deki yenilikleri almak için `git pull --rebase` / `git rebase main`, paylaşmadan önce `rebase -i` ile temizlik.
- `main`'e birleştirirken: merge request üzerinden, GitLab'ın seçilen merge yöntemiyle (merge commit, fast-forward ya da squash; akışlar dersi).

## Alıştırma

1. Beş commit'lik bir dalda ikinci ve dördüncü commit'in sırasını değiştir, üçüncünün mesajını düzelt. İnteraktif rebase listesi nasıl görünmeli?
2. Bir arkadaşın `ortak-ozellik` dalına push etmiş. Sen o dalı rebase edip `--force` ile push ettin. Arkadaşın ne yaşar, ve bunu nasıl önlersin?
3. Rebase'in ortasındasın, çakışmalar beklediğinden karmaşık. Hiçbir şey olmamış gibi geri dönmek için ne yaparsın? Rebase bitti ama sonuç yanlış, şimdi ne yaparsın?

<details><summary>Çözüm</summary>

1.

```text
pick   1111111 birinci
pick   4444444 dördüncü
reword 3333333 üçüncü
pick   2222222 ikinci
pick   5555555 beşinci
```

Satırların sırası commit'lerin yeni sırasıdır. Sıralama değişikliği, commit'ler birbirine bağlıysa (dördüncü, ikincinin eklediği bir satırı değiştiriyorsa) çakışma çıkarabilir.

2. Arkadaşının yerelindeki `ortak-ozellik` eski commit'lere dayanıyor. `git pull` yaptığında Git, eski ve yeni commit'leri farklı geçmişler olarak görür ve birleştirmeye çalışır: Aynı değişiklikler iki kez görünür, çakışmalar çıkar. Arkadaşın yerelinde push etmediği commit'ler varsa, onları yeni tabana taşıması gerekir (`git rebase --onto origin/ortak-ozellik <eski-taban>`). Daha kötüsü: Sen push etmeden hemen önce arkadaşın da push ettiyse, `--force` onun commit'lerini **sunucudan siler**. Önlem: Paylaşılan dalları rebase etme. Kendi dalını zorla push etmek gerekiyorsa `--force-with-lease` kullan: Sunucudaki dal senin son gördüğünden farklıysa push reddedilir. GitLab'da `main` gibi dallar için zorla push korumalı dal ayarıyla tamamen kapatılır.

3. Ortasındayken: `git rebase --abort`, rebase başlamadan önceki hale döner. Bittikten sonra: `git reflog` ile rebase'den önceki commit'i bul (`rebase (start)` satırından bir önceki) ve `git reset --hard <o-hash>`, ya da hemen sonrasındaysan `git reset --hard ORIG_HEAD`.

</details>

```quiz
Rebase sonrası commit'lerin hash'leri neden değişir?
- Git rebase'de mesajları değiştirir
- [x] Commit'ler yeni bir ebeveynin üzerine yeniden uygulanır; ebeveyn hash'i (ve commit zamanı) commit'in içeriğinde olduğu için yeni commit'ler oluşur
- Hash'ler rastgele üretilir
? Eski commit'ler silinmez, reflog'dan erişilebilir kalır.
```

```quiz
Hangi durumda rebase yapılmamalıdır?
- Kendi özellik dalını main'in güncel haline taşırken
- [x] Başkalarının üzerine çalıştığı, paylaşılmış commit'lerde (örneğin main)
- Paylaşmadan önce commit'leri temizlerken
? Paylaşılmış geçmişi yeniden yazmak, başkalarının yerel geçmişiyle çatışır.
```

```quiz
`git commit --fixup=<hash>` ve `git rebase -i --autosquash` birlikte ne sağlar?
- Commit'i siler
- [x] Düzeltme commit'i, rebase sırasında otomatik olarak hedef commit'in içine katılır
- Commit'in mesajını değiştirir
? İnceleme turlarında düzeltmeleri ayrı tutup birleştirmeden önce temizlemek için.
```

## Özet

- Rebase, dalın commit'lerini yeni bir tabanın üzerine yeniden uygular: yeni hash'ler, doğrusal geçmiş. Sonra `merge --ff-only`.
- Altın kural: paylaşılmış commit'leri rebase etme. Kendi dalını zorla push ederken `--force-with-lease`.
- İnteraktif rebase: `pick`, `reword`, `edit`, `squash`, `fixup`, `drop`, sıralama. Paylaşmadan önce temizlik.
- `--fixup` + `--autosquash` inceleme düzeltmeleri için.
- `--onto` ile bir dalı başka bir tabana taşı; `--update-refs` zincirli dallar için.
- Rebase'de çakışma her commit'te çıkabilir; `--continue`, `--skip`, `--abort`. `ours`/`theirs` ters.
- Reflog ve `ORIG_HEAD` ile her rebase geri alınabilir.
