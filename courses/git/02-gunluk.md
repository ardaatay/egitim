# Günlük iş akışı: index, commit hijyeni, diff ve log

Bir projenin Git geçmişi, aylar sonra "bu satır neden böyle?" sorusunun cevabını verebilmeli. Bu, ancak her commit'in **tek bir mantıklı değişikliği** içermesi ve bunu açıklayan bir mesajı olmasıyla mümkün. Bu derste günlük iş akışının araçlarını bu gözle ele alıyoruz: index'i bir düzenleme alanı olarak kullanmak (`add -p`), farkları doğru okumak, iyi commit mesajları, `.gitignore` ve takipten çıkarmak, satır sonları, ve geçmişte arama.

## Yapılandırma

Git ayarları üç seviyededir: sistem (`/etc/gitconfig`), kullanıcı (`~/.gitconfig`) ve depo (`.git/config`). Alttaki üsttekini ezer. Bir ayarın nereden geldiğini görmek:

```bash
git config --show-origin --list | head -5
```

```text
file:C:/Program Files/Git/etc/gitconfig	diff.astextplain.textconv=astextplain
file:C:/Program Files/Git/etc/gitconfig	filter.lfs.clean=git-lfs clean -- %f
...
```

Yeni bir makinede ilk yapılandırma:

```bash
git config --global user.name "Ayşe Demir"
git config --global user.email "ayse@ornek.com"
git config --global init.defaultBranch main
git config --global pull.rebase true          # pull'da merge commit yerine rebase (uzak depolar dersi)
git config --global push.autoSetupRemote true # yeni dalı ilk push'ta takip ayarlı it
git config --global rerere.enabled true       # çözülmüş çakışmaları hatırla (merge dersi)
git config --global diff.algorithm histogram  # daha okunur farklar
```

İş ve kişisel projeler için farklı e-postalar gerekiyorsa, dizine göre koşullu yapılandırma: `~/.gitconfig` içinde `[includeIf "gitdir:~/is/"] path = ~/.gitconfig-is`.

Bu dersin deneme deposu (önceki dersteki ortam değişkenleriyle):

```bash
cd ~/git-egitim && git init -b main gunluk && cd gunluk
git config core.autocrlf false
export GIT_AUTHOR_DATE="2026-11-26T11:00:00+03:00" GIT_COMMITTER_DATE="2026-11-26T11:00:00+03:00"
cat > app.js <<'EOF'
const PORT = 3000;
function baslat() {
  console.log("basliyor");
}
function durdur() {
  console.log("duruyor");
}
baslat();
EOF
git add app.js && git commit -m "Uygulama girişini ekle"
```

## Index bir düzenleme alanıdır

Çalışırken genellikle birden fazla şeyi aynı anda değiştirirsin: Bir hata düzeltmesi yaparken bir ayarı da değiştirdin. İkisini tek bir commit'e koymak, birini geri almak gerektiğinde diğerini de geri almak demektir. Index, commit'i **parça parça** oluşturmana izin verir.

İki bağımsız değişiklik:

```bash
sed -i 's/3000/8080/' app.js
sed -i 's/"duruyor"/"duruyor, baglantilar kapatiliyor"/' app.js
git diff
```

```text
diff --git a/app.js b/app.js
index 7861697..5131131 100644
--- a/app.js
+++ b/app.js
@@ -1,8 +1,8 @@
-const PORT = 3000;
+const PORT = 8080;
 function baslat() {
   console.log("basliyor");
 }
 function durdur() {
-  console.log("duruyor");
+  console.log("duruyor, baglantilar kapatiliyor");
 }
 baslat();
```

Fark çıktısını okumak: `@@ -1,8 +1,8 @@` eski dosyanın 1. satırından itibaren 8 satır, yeni dosyanın 1. satırından itibaren 8 satır. `-` ile başlayanlar çıkarılan, `+` ile başlayanlar eklenen satırlar, boşlukla başlayanlar bağlam. Değişiklikler birbirine yakın olduğu için Git onları tek bir **parça** (hunk) olarak gösterdi.

`git add -p` (patch) her parçayı tek tek sorar. `s` ile parçayı böl, ilkini (port) ekle, ikincisini (kapanış mesajı) ekleme:

```bash
git add -p app.js
```

```text
(1/1) Stage this hunk [y,n,q,a,d,s,e,p,P,?]? s
Split into 2 hunks.
@@ -1,5 +1,5 @@
-const PORT = 3000;
+const PORT = 8080;
 function baslat() {
...
(1/2) Stage this hunk [y,n,q,a,d,k,K,j,J,g,/,e,p,P,?]? y
@@ -2,7 +2,7 @@
...
-  console.log("duruyor");
+  console.log("duruyor, baglantilar kapatiliyor");
...
(2/2) Stage this hunk [y,n,q,a,d,K,J,g,/,e,p,P,?]? n
```

Şimdi aynı dosyanın iki hali var: index'teki (sadece port) ve çalışma dizinindeki (ikisi birden):

```bash
git diff --staged      # index ile son commit arası: commit'e girecek olan
git diff               # çalışma dizini ile index arası: henüz eklenmemiş olan
git status -s
```

```text
diff --git a/app.js b/app.js
index 7861697..30e18dd 100644
@@ -1,4 +1,4 @@
-const PORT = 3000;
+const PORT = 8080;
...
diff --git a/app.js b/app.js
index 30e18dd..5131131 100644
@@ -3,6 +3,6 @@ function baslat() {
...
-  console.log("duruyor");
+  console.log("duruyor, baglantilar kapatiliyor");

MM app.js
```

`git status -s`'deki iki sütun bu üç alanı özetler: Soldaki index'in son commit'e göre durumu, sağdaki çalışma dizininin index'e göre durumu. `MM`: hem index'te hem çalışma dizininde değişiklik var. `git diff HEAD` ise ikisini birlikte (çalışma dizini ile son commit) gösterir.

İki ayrı commit:

```bash
GIT_AUTHOR_DATE="2026-11-26T11:05:00+03:00" GIT_COMMITTER_DATE="2026-11-26T11:05:00+03:00" git commit -m "Varsayılan portu 8080 yap"
git add app.js
GIT_AUTHOR_DATE="2026-11-26T11:10:00+03:00" GIT_COMMITTER_DATE="2026-11-26T11:10:00+03:00" git commit -m "Kapanışta bağlantıları kapat"
```

Şimdi port değişikliği sorun çıkarırsa, sadece o commit geri alınabilir (geri alma dersi). `git commit -a` (bütün değişiklikleri ekle ve commit et) bu kontrolü atlar. Hızlıdır, ama değişikliklerini gözden geçirmeden commit etmek demektir. `add -p` aynı zamanda bir **son kontrol**dür: commit'e girecek her satırı bir kez daha görürsün, unutulmuş `console.log`'ları ve hata ayıklama kodlarını yakalarsın.

## İyi commit mesajı

```text
Kapanışta bağlantıları kapat                         ← özet: 50 karakter civarı, emir kipi, nokta yok

Uygulama SIGTERM aldığında açık veritabanı             ← boş satır, sonra gövde: 72 karakterde satır kır
bağlantılarını kapatmadan çıkıyordu. Kubernetes
pod'u kapatırken bu, veritabanında yarım kalan
transaction'lara ve ORA-03113 hatalarına yol
açıyordu.

Bağlantı havuzu artık kapanış sinyalinde
boşaltılıyor ve en fazla 10 saniye bekleniyor.

Refs: #142                                           ← ilgili iş kaydı
```

- **Özet satırı** ne yaptığını söyler, emir kipiyle: "ekle", "düzelt", "kaldır" ("ekledim", "eklendi" değil). `git log --oneline`'da, GitLab'ın commit listesinde ve e-posta konularında bu satır görünür.
- **Gövde** **neden**'i anlatır. "Ne"yi kod zaten söylüyor. Sorun neydi, neden bu çözüm seçildi, hangi alternatif neden reddedildi? Altı ay sonra bu satırı `git blame` ile bulan kişi (büyük ihtimalle sen) bu bilgiye ihtiyaç duyacak.
- "düzeltme", "wip", "asdf" gibi mesajlar geçmişi işe yaramaz hale getirir. Çalışırken ara commit'ler yapmak sorun değil, ama paylaşmadan önce onları düzenle (rebase dersi).

Birçok ekip **Conventional Commits** biçimini kullanır (`fix:`, `feat:`, `chore:` önekleri): Sürüm numaraları ve değişiklik notları otomatik üretilebilir. Akışlar dersinde ele alacağız.

### Son commit'i düzeltmek

```bash
printf 'test\n' > test.js && git add test.js && git commit -m "tset ekle"
git commit --amend -m "Test dosyasını ekle"
git log --oneline -2
```

```text
6482d78 tset ekle                ← amend'den önce
ef85a90 Test dosyasını ekle      ← amend'den sonra: farklı hash
952f8f4 ...
```

`--amend` son commit'i **değiştirmez**, yerine yeni bir commit oluşturur (önceki derste gördük: mesaj commit'in içeriğinde olduğu için hash değişir). Unutulan bir dosyayı eklemek için de: `git add unutulan.js && git commit --amend --no-edit`. Kural: Sadece henüz paylaşılmamış (push edilmemiş) commit'leri değiştir. Paylaşılmış bir commit'i değiştirmek, onu çeken herkesin geçmişiyle çakışır (uzak depolar dersi).

## .gitignore ve takipten çıkarmak

Bağımlılıklar, derleme çıktıları, yerel ayarlar ve **gizli bilgiler** depoya girmemeli:

```text
# .gitignore
node_modules/
.env
*.log
```

Bir dosyanın neden yok sayıldığını (ya da sayılmadığını) bulmak:

```bash
git check-ignore -v .env hata.log node_modules/x/i.js
```

```text
.gitignore:2:.env	.env
.gitignore:3:*.log	hata.log
.gitignore:1:node_modules/	node_modules/x/i.js
```

Hangi dosyanın hangi satırı. Birden fazla `.gitignore` (alt dizinlerde, `~/.config/git/ignore` gibi genel bir dosya, `.git/info/exclude`) olduğunda bu, sorunun kaynağını hemen gösterir.

`.gitignore` sadece **takip edilmeyen** dosyaları etkiler. Zaten commit edilmiş bir dosyayı `.gitignore`'a eklemek onu takipten çıkarmaz:

```bash
echo "SECRET=1" > .env
git add -f .env && git commit -m "yanlislikla env"       # -f: ignore'u ez (yapma!)
git rm --cached .env                                     # takipten çıkar, dosyayı silme
git add .gitignore && git commit -m "env dosyasını takipten çıkar, gitignore güncelle"
ls .env && git ls-files
```

```text
.env
.gitignore
app.js
```

Dosya diskte duruyor ama artık takip edilmiyor. **Ama:** `.env` dosyasının içeriği, "yanlışlıkla env" commit'inde **hâlâ duruyor**: `git show HEAD~1:.env` onu gösterir, ve depo push edildiyse herkes erişebilir. Bir gizli bilgi bir kez commit edilip paylaşıldıysa, onu **sızmış kabul et ve değiştir** (parolayı, anahtarı yenile). Geçmişten tamamen silmenin yolu (`git filter-repo`) ve sızıntıları baştan önlemenin yolu (pre-commit hook'ları, GitLab secret detection) ileri konular dersinde.

## Satır sonları

Windows CRLF (`\r\n`), Linux ve macOS LF (`\n`) kullanır. Ekipte iki tür işletim sistemi varsa, ayar yapılmamış bir depoda her dosya ilk kaydedişte "bütün satırları değişmiş" görünür, ve bir kabuk betiği CRLF ile Linux'ta `\r: command not found` hatası verir.

```bash
printf 'satir1\r\nsatir2\r\n' > win.txt && git add win.txt
git ls-files --eol win.txt app.js
```

```text
i/lf    w/lf    attr/                   app.js
i/crlf  w/crlf  attr/                   win.txt
```

`i/` index'teki (depoya giden), `w/` çalışma dizinindeki satır sonu. `win.txt` depoya CRLF olarak girmek üzere. Çözüm, kuralı **depoya** koymak: `.gitattributes` herkes için geçerlidir, kişisel `core.autocrlf` ayarlarından bağımsız.

```text
# .gitattributes
* text=auto eol=lf
*.png binary
*.bat text eol=crlf
```

```bash
git add --renormalize .
git ls-files --eol win.txt
```

```text
i/lf    w/crlf  attr/text=auto eol=lf   win.txt
```

Depoda artık LF. `--renormalize`, mevcut dosyaları yeni kurala göre yeniden ekler. Kural: Her yeni depoya ilk iş olarak bir `.gitattributes` ekle. Önceki derste `core.autocrlf false` dememizin sebebi de, çıktıların her işletim sisteminde aynı olmasıydı.

## Geri almadan önce: restore

Çalışma dizinindeki ya da index'teki değişiklikleri geri almak (commit edilmemiş işler için):

```bash
echo "bozuk" > app.js
git status -s            #  M app.js
git restore app.js       # index'teki haline döndür: değişiklik kaybolur!
git status -s            # (temiz)

echo "zz" >> test.js && git add test.js
git restore --staged test.js     # index'ten çıkar, çalışma dizininde kalsın
git status -s            #  M test.js
```

`git restore` ve `git switch` (2.23+), eskiden `git checkout`'un yaptığı iki farklı işi ayırır: dosya geri almak ve dal değiştirmek. Eski belgelerde `git checkout -- dosya` görürsün, aynı iştir. `git restore dosya` **commit edilmemiş değişikliği geri dönüşü olmayan şekilde siler**: Git o içeriği hiçbir yerde saklamamıştı (index'e eklenmediyse). Emin değilsen önce `git stash` (geri alma dersi).

## Geçmişte arama

```bash
git log --oneline --graph
git log --stat -1 --format='%h %an %ad %s' --date=short
git log -S'8080' --oneline                                  # "8080" metnini ekleyen/çıkaran commit
git log --format='%h %ad %s' --date=format:'%H:%M' -- app.js   # sadece app.js'i değiştirenler
```

```text
* ef85a90 Test dosyasını ekle
* 952f8f4 env dosyasini takipten cikar, gitignore guncelle
* 6b35240 yanlislikla env
* 16a2edd Kapanışta bağlantıları kapat
* dd8eaf7 Varsayılan portu 8080 yap
* 9f58172 Uygulama girişini ekle

ef85a90 Ayşe Demir 2026-11-26 Test dosyasını ekle

 test.js | 1 +
 1 file changed, 1 insertion(+)

dd8eaf7 Varsayılan portu 8080 yap

16a2edd 11:10 Kapanışta bağlantıları kapat
dd8eaf7 11:05 Varsayılan portu 8080 yap
9f58172 11:00 Uygulama girişini ekle
```

- `-S'metin'` ("pickaxe"): Bir metnin **geçiş sayısını** değiştiren commit'ler. "Bu sabit ne zaman eklendi?", "bu fonksiyon ne zaman silindi?" sorularının en hızlı cevabı. `-G'regex'` ise farkında düzenli ifadeye uyan satır olan commit'ler.
- `-- yol`: sadece o dosya ya da dizini değiştirenler. Yeniden adlandırılmış dosyalarda `--follow`.
- `--since="2 weeks ago"`, `--author="Ayşe"`, `--grep="ORA-"` (mesajda arama).

Bir satırın kimden geldiği:

```bash
git blame -s app.js
```

```text
dd8eaf74 1) const PORT = 8080;
^9f58172 2) function baslat() {
^9f58172 3)   console.log("basliyor");
^9f58172 4) }
^9f58172 5) function durdur() {
16a2edde 6)   console.log("duruyor, baglantilar kapatiliyor");
^9f58172 7) }
^9f58172 8) baslat();
```

Her satırın son değiştiği commit (`^` işareti: ilk commit'ten beri değişmemiş). Bu çıktı, mantıklı ve küçük commit'lerin değerini gösteriyor: 1. satırın sebebi "Varsayılan portu 8080 yap", 6. satırınki "Kapanışta bağlantıları kapat". Hepsi tek bir "değişiklikler" commit'inde olsaydı, blame hiçbir şey anlatmazdı. Kullanışlı seçenekler: `-w` (boşluk değişikliklerini yok say), `-C` (başka dosyalardan taşınan satırları takip et), ve büyük biçimlendirme commit'lerini atlamak için `--ignore-revs-file .git-blame-ignore-revs` (GitLab bu dosyayı otomatik tanır).

Eski bir hali görmek: `git show HEAD~4:app.js` (dosyanın o andaki içeriği), `git show dd8eaf7` (bir commit'in farkı ve mesajı).

## Alıştırma

1. `app.js`'te üç bağımsız değişiklik yap (en üste bir yorum satırı, `baslat` içine bir log, en alta yeni bir fonksiyon). `git add -p` ile üç ayrı commit oluştur ve `git log -p` ile kontrol et.
2. Bir projede `dist/` dizini yanlışlıkla commit edilmiş ve 400 dosya içeriyor. `.gitignore`'a ekleyip takipten çıkaran komutları yaz. Dosyalar diskten silinmemeli.
3. Bir yapılandırma dosyasındaki `timeout: 30` değerinin ne zaman ve neden `timeout: 5` yapıldığını nasıl bulursun?

<details><summary>Çözüm</summary>

1. Değişiklikler birbirinden uzaksa `git add -p` onları zaten ayrı parçalar olarak sorar (her birinde `y` ve sonraki `n`'lerle bir commit). Yakınsa `s` ile bölünür, bölünemeyecek kadar iç içeyse `e` ile parça bir düzenleyicide elle düzenlenir.

2.

```bash
echo "dist/" >> .gitignore
git rm -r --cached dist
git add .gitignore
git commit -m "Derleme çıktısını takipten çıkar"
```

`-r` dizin için, `--cached` sadece index'ten. Takım arkadaşları bu commit'i çektiğinde, onların diskindeki `dist/` dosyaları **silinir** (Git, takipten çıkan dosyaları çalışma dizininden de kaldırır). Derleme çıktısı yeniden üretilebilir olduğu için sorun değil, ama bir yapılandırma dosyası için bu sürpriz olabilir: Ekibi uyar.

3. `git log -S'timeout: 5' -- config.yaml` (ya da değer biçimi belirsizse `git log -G'timeout:\s*5' -- config.yaml`) değişikliği yapan commit'i bulur. `git show <hash>` ile farkı ve mesajı okursun. Mesaj "neden"i anlatıyorsa cevap oradadır, anlatmıyorsa commit'in bağlı olduğu merge request'e (GitLab'da commit sayfasında görünür) bakarsın. `git blame -L '/timeout/,+1' config.yaml` da aynı satırın son değiştiği commit'i verir.

</details>

```quiz
`git status -s` çıktısında `MM app.js` ne anlama gelir?
- Dosya iki kez değiştirildi
- [x] Dosyanın index'te commit'e hazır değişikliği var, ve çalışma dizininde index'e eklenmemiş başka değişiklikleri var
- Dosyada çakışma var
? Soldaki sütun index'in durumu, sağdaki çalışma dizininin durumu.
```

```quiz
Daha önce commit edilmiş bir dosyayı .gitignore'a eklemek ne yapar?
- Dosyayı depodan siler
- [x] Hiçbir şey; .gitignore sadece takip edilmeyen dosyaları etkiler. Takipten çıkarmak için `git rm --cached`
- Dosyayı geçmişten temizler
? Dosyanın içeriği eski commit'lerde kalır: gizli bilgiyse sızmış kabul et.
```

```quiz
Ekipte Windows ve Linux kullanıcıları varken satır sonu sorunlarını önlemenin en sağlam yolu?
- Herkesin core.autocrlf ayarını kontrol etmek
- [x] Depoya kuralları koyan bir .gitattributes eklemek (`* text=auto eol=lf`)
- Sadece Linux kullanmak
? .gitattributes depoyla gelir, kişisel ayarlardan bağımsız herkese uygulanır.
```

## Özet

- Yapılandırma seviyeleri ve `--show-origin`. Başlangıç ayarları: kimlik, `pull.rebase`, `rerere`, `histogram`.
- Index bir düzenleme alanıdır: `add -p` ile bir dosyadaki değişiklikleri ayrı commit'lere böl. `diff` / `diff --staged` / `diff HEAD`.
- Bir commit = bir mantıklı değişiklik. Mesaj: kısa emir kipi özet + "neden"i anlatan gövde. `--amend` yeni commit yapar; paylaşılmışları değiştirme.
- `.gitignore` takip edilmeyenler içindir; `check-ignore -v`, `rm --cached`. Commit edilmiş gizli bilgi sızmıştır.
- `.gitattributes` ile satır sonlarını depo seviyesinde sabitle; `ls-files --eol`, `add --renormalize`.
- `restore` ve `switch`; `restore` commit edilmemiş değişikliği kalıcı siler.
- `log -S/-G/-- yol/--follow`, `blame -w -C`, `show rev:yol`.
