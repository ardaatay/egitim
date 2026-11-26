# Dallar, merge ve çakışma çözümü

Bir dal, bir commit'e işaret eden bir addır. Bunu bilince merge'ün de ne yaptığı netleşir: İki geçmişi birleştiren **yeni bir commit** oluşturmak (ya da birleştirilecek bir şey yoksa, sadece dalı ileri taşımak). Bu derste merge türlerini, Git'in birleştirmeyi nasıl hesapladığını (ortak ata), çakışmaları okumayı ve çözmeyi, ve dalları güvenle temizlemeyi ele alıyoruz.

Deneme deposu (ilk dersteki ortam değişkenleriyle; her commit'ten önce zamanı ilerletmek için kısa bir fonksiyon):

```bash
t() { export GIT_AUTHOR_DATE="2026-11-26T$1:00+03:00" GIT_COMMITTER_DATE="2026-11-26T$1:00+03:00"; }
cd ~/git-egitim && git init -b main merge && cd merge && git config core.autocrlf false
cat > config.yaml <<'EOF'
port: 8080
timeout: 30
log_level: info
replicas: 2
EOF
t 12:00; git add . && git commit -m "Yapılandırmayı ekle"
```

## Fast-forward

```bash
git switch -c log-seviyesi
sed -i 's/log_level: info/log_level: warn/' config.yaml
t 12:05; git commit -am "Log seviyesini warn yap"
git switch main
git merge log-seviyesi
git log --oneline --graph --all
```

```text
Updating f884006..b12aef7
Fast-forward
 config.yaml | 2 +-

* b12aef7 (HEAD -> main, log-seviyesi) Log seviyesini warn yap
* f884006 Yapılandırmayı ekle
```

`main`, dal açıldığından beri hiç ilerlememişti: `log-seviyesi` doğrudan onun devamı. Birleştirecek bir şey yok, Git `main` işaretçisini ileri **kaydırdı** (fast-forward). Yeni bir commit oluşmadı.

## Gerçek merge: üç yönlü birleştirme

İki dal da ilerlediğinde:

```bash
git switch -c timeout
sed -i 's/timeout: 30/timeout: 10/' config.yaml; t 12:10; git commit -am "Timeout'u 10 sn yap"
git switch main
sed -i 's/replicas: 2/replicas: 3/' config.yaml; t 12:15; git commit -am "Replika sayısını 3 yap"
git log --oneline --graph --all
git merge-base main timeout
```

```text
* 20ac33b (HEAD -> main) Replika sayısını 3 yap
| * 4d96e7d (timeout) Timeout'u 10 sn yap
|/
* b12aef7 Log seviyesini warn yap
* f884006 Yapılandırmayı ekle

b12aef72a002fadeeb755ffaf9b0073d3d42d0ba
```

`merge-base`, iki dalın **ortak atasını** buldu: b12aef7. Git birleştirmeyi bu üç anlık görüntüyle yapar (**üç yönlü merge**):

- Ortak atadan `main`'e ne değişti? `replicas: 2 → 3`
- Ortak atadan `timeout`'a ne değişti? `timeout: 30 → 10`
- İki taraf **farklı yerleri** değiştirdiyse ikisini de uygula. **Aynı yeri farklı şekilde** değiştirdiyse: çakışma.

```bash
t 12:20; git merge --no-edit timeout
git log --oneline --graph --all
git cat-file -p HEAD | head -3
cat config.yaml
```

```text
Auto-merging config.yaml
Merge made by the 'ort' strategy.

*   25d2e04 (HEAD -> main) Merge branch 'timeout'
|\
| * 4d96e7d (timeout) Timeout'u 10 sn yap
* | 20ac33b Replika sayısını 3 yap
|/
* b12aef7 (log-seviyesi) Log seviyesini warn yap
* f884006 Yapılandırmayı ekle

tree f9b5004bac857d82b49761c73161f0c8c32db184
parent 20ac33b1bfc56f8bdd985650f6c92e44a830c5ea
parent 4d96e7d53a29c1a9fcdafc1d6a5bac7f55519df8

port: 8080
timeout: 10
log_level: warn
replicas: 3
```

Bir **merge commit**, **iki ebeveyni** olan bir commit'tir: İlk ebeveyn içinde bulunduğun dal (`main`), ikincisi birleştirilen dal. İki değişiklik de dosyada. `ort` (2.33'ten beri varsayılan) Git'in birleştirme stratejisinin adıdır. Ortak ata yaklaşımı Git'i satır satır birleştirmede çok güvenilir yapar, ama dikkat: Git **metni** birleştirir, **anlamı** değil. Biri bir fonksiyonu yeniden adlandırırken diğeri başka bir dosyada eski adla çağırıyorsa, merge çakışmasız biter ama kod derlenmez. Merge'den sonra testlerin çalışması (CI bölümü) bu yüzden şarttır.

## Çakışmalar

İki dal aynı satırı farklı şekilde değiştirirse:

```bash
git switch -c port-a
sed -i 's/port: 8080/port: 9090/' config.yaml; t 12:25; git commit -am "Portu 9090 yap"
git switch main
sed -i 's/port: 8080/port: 8443/' config.yaml; t 12:30; git commit -am "Portu 8443 yap (TLS)"
t 12:35; git merge port-a
```

```text
Auto-merging config.yaml
CONFLICT (content): Merge conflict in config.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```bash
git status
cat config.yaml
```

```text
You have unmerged paths.
  (fix conflicts and run "git commit")
  (use "git merge --abort" to abort the merge)

Unmerged paths:
  (use "git add <file>..." to mark resolution)
	both modified:   config.yaml

<<<<<<< HEAD
port: 8443
=======
port: 9090
>>>>>>> port-a
timeout: 10
log_level: warn
replicas: 3
```

Git çakışmayan satırları birleştirdi, çakışan bölümü işaretçilerle bıraktı: `<<<<<<< HEAD` ile `=======` arası bizim taraf (`main`), `=======` ile `>>>>>>>` arası birleştirilen taraf. Merge **yarım** durumda: Henüz commit yok, ve her an `git merge --abort` ile başlamadan önceki duruma dönebilirsin.

### Ortak atayı da göster: zdiff3

Varsayılan gösterimde önemli bir bilgi eksik: Satırın **önceden** ne olduğu. "8443 mü 9090 mı?" sorusunu cevaplamak için, iki tarafın neyi değiştirdiğini bilmen gerekir:

```bash
git merge --abort
git config --global merge.conflictStyle zdiff3
git merge port-a
cat config.yaml
```

```text
<<<<<<< HEAD
port: 8443
||||||| 25d2e04
port: 8080
=======
port: 9090
>>>>>>> port-a
```

`|||||||` ile `=======` arası ortak atadaki hal: `8080`. Artık iki tarafın da `8080`'den farklı yönlere gittiği görülüyor: Biri TLS için 8443'e, diğeri 9090'a. Hangisinin doğru olduğu (ya da ikisinin birleşimi gerekip gerekmediği) bir **iş kararıdır**: İki commit'in mesajlarına ve yazarlarına bakılır. `zdiff3`'ü her zaman açık tut. Karmaşık çakışmalarda farkı yaratan bilgi budur.

Çakışma sırasında index'te dosyanın üç hali ayrı ayrı durur (aşama 1: ortak ata, 2: bizim, 3: onların):

```bash
git ls-files -u
git show :1:config.yaml | head -1
git show :2:config.yaml | head -1
git show :3:config.yaml | head -1
```

```text
100644 eaa63c6027995810216f5fa51e0a614b2097f5f7 1	config.yaml
100644 0a662496601d59d00c91712efea1aaa01fecee29 2	config.yaml
100644 5364b5c47e0b64e782f4c0cd34fe2b34ff15a776 3	config.yaml

port: 8080
port: 8443
port: 9090
```

Bir tarafın halini tamamen almak için: `git checkout --ours config.yaml` ya da `git checkout --theirs config.yaml` (sonra `git add`). Kilit dosyaları (`package-lock.json`) gibi elle birleştirilmemesi gereken dosyalarda kullanışlıdır: Bir tarafı al, sonra paket yöneticisiyle yeniden üret.

### Çözmek

Dosyayı istenen hale getir, işaretçileri sil, sonra `git add` ile çözüldüğünü bildir. Karar TLS portu:

```text
port: 8443
timeout: 10
log_level: warn
replicas: 3
```

```bash
git add config.yaml
t 12:40; git commit --no-edit
git log --oneline --graph -6
```

```text
*   490fce9 (HEAD -> main) Merge branch 'port-a'
|\
| * 5e4a6b0 (port-a) Portu 9090 yap
* | 04bd862 Portu 8443 yap (TLS)
|/
*   25d2e04 Merge branch 'timeout'
|\
| * 4d96e7d (timeout) Timeout'u 10 sn yap
* | 20ac33b Replika sayısını 3 yap
|/
```

Çakışma çözümünde dikkat edilecekler:

- **İşaretçileri unutmamak.** `<<<<<<<` içeren bir dosyanın commit edilmesi şaşırtıcı derecede yaygındır. `git diff --check` işaretçileri ve boşluk hatalarını bulur. Bir pre-commit hook'u ya da CI kontrolü bunu otomatikleştirir.
- **İki tarafın niyetini anla.** "Benimkini al" bir çözüm değildir. Diğer taraf başka bir hatayı düzeltiyor olabilir. Gerekirse o commit'in yazarına sor.
- **Çözümden sonra test et.** Çakışmasız birleşen kısımlar da dahil.
- Büyük, sık çakışan dallar bir **süreç** sorunudur: Dallar uzun yaşıyordur. Kısa ömürlü dallar ve sık entegrasyon (akışlar dersi) çakışmaları küçük tutar.
- Çakışma çözümünü öğrenen **rerere** ("reuse recorded resolution"): `git config --global rerere.enabled true`. Aynı çakışmayı bir kez çözdüğünde Git çözümü kaydeder, aynı çakışma tekrar çıkarsa (aynı dalı tekrar tekrar rebase ederken ya da merge'ü geri alıp yeniden yaparken) otomatik uygular.

## --no-ff: merge commit'ini zorlamak

Fast-forward mümkün olsa bile bir merge commit'i istenebilir:

```bash
git switch -c belge
echo "# Yapılandırma" > README.md && git add README.md
t 12:45; git commit -m "README ekle"
git switch main
t 12:50; git merge --no-ff --no-edit belge
git log --oneline --graph -3
```

```text
*   31b966e (HEAD -> main) Merge branch 'belge'
|\
| * bf98a48 (belge) README ekle
|/
*   490fce9 Merge branch 'port-a'
```

Fast-forward olsaydı, "README ekle" doğrudan `main`'in üzerine eklenmiş gibi görünürdü ve bir dalın varlığı tarihten silinirdi. `--no-ff`, bir özelliğin bütün commit'lerini tek bir merge commit'i altında gruplar: Bütün özelliği tek bir `git revert -m 1` ile geri almak mümkün olur (geri alma dersi). GitLab'ın varsayılan merge yöntemi de budur ("merge commit"). Ekipler bunun yerine "fast-forward merge" ya da "squash" da seçebilir. Hangisinin seçileceği bir ekip kararıdır (akışlar dersi).

## Dalları temizlemek

```bash
git branch --merged main
git branch -d belge port-a timeout log-seviyesi
```

```text
  belge
  log-seviyesi
* main
  port-a
  timeout

Deleted branch belge (was bf98a48).
Deleted branch port-a (was 5e4a6b0).
Deleted branch timeout (was 4d96e7d).
Deleted branch log-seviyesi (was b12aef7).
```

`--merged`, `main`'e tamamen birleştirilmiş dalları listeler: Bunları silmek hiçbir commit'i kaybettirmez. Birleştirilmemiş bir dalı silmeye çalışınca:

```bash
git switch -c yarim && echo x > yarim.txt && git add . && t 12:55 && git commit -m "yarim is" && git switch main
git branch -d yarim
```

```text
error: the branch 'yarim' is not fully merged
hint: If you are sure you want to delete it, run 'git branch -D yarim'
```

`-d` güvenlidir: Kaybolacak commit varsa reddeder. `-D` zorla siler. O commit'ler artık hiçbir daldan erişilemez, ama reflog sayesinde bir süre kurtarılabilir (geri alma dersi).

## Alıştırma

1. Yeni bir depoda iki dal oluştur: Biri bir dosyayı **silsin**, diğeri aynı dosyayı **değiştirsin**. Merge ettiğinde Git ne der, nasıl çözersin?
2. Bir merge commit'inin iki ebeveynini `git rev-parse` ile göster. `git log --first-parent --oneline` ne gösterir, ne işe yarar?
3. Bir çakışmayı çözdün ama sonra yanlış karar verdiğini fark ettin. Merge commit'i henüz yapılmadı. Baştan başlamak için ne yaparsın? Commit yapıldıysa ne yaparsın?

<details><summary>Çözüm</summary>

1. Git bir **değiştirme/silme çakışması** bildirir: `CONFLICT (modify/delete): dosya deleted in X and modified in HEAD`. Dosya, değiştirilmiş haliyle çalışma dizininde bırakılır. Karar: Dosya gerçekten silinmeli mi (`git rm dosya`), yoksa değişiklik korunmalı mı (`git add dosya`)? Sonra `git commit`. Bu tür çakışmalar özellikle refactoring sırasında çıkar: Bir taraf dosyayı taşıdı ya da böldü, diğer taraf eski yerinde bir hata düzeltti. Düzeltmenin yeni yere taşınması gerekir.

2. `git rev-parse HEAD^1 HEAD^2` iki ebeveyni verir. `git log --first-parent --oneline main`, sadece birinci ebeveyn zincirini izler: Dalların içindeki ara commit'leri göstermeden, `main`'e yapılan merge'lerin listesini verir. "Bu sürümde hangi özellikler birleştirildi?" sorusunun özeti budur, ve `git bisect --first-parent` ile hata ararken özellik dallarının ara (belki kırık) commit'lerini atlamak için kullanılır.

3. Commit'ten önce: `git checkout -m config.yaml` dosyayı çakışma işaretçileriyle yeniden oluşturur (sadece o dosya için), ya da `git merge --abort` ve merge'ü baştan yap. Commit'ten sonra ve henüz push etmediysen: `git reset --hard HEAD~1` merge'ü tamamen geri alır (dikkat: commit edilmemiş başka değişiklik varsa kaybolur), sonra merge'ü tekrar yap. Push ettiysen geçmişi yeniden yazma: Düzeltmeyi yeni bir commit olarak yap.

</details>

```quiz
`git merge feature` sonrası yeni bir commit oluşmadı, main sadece ileri gitti. Neden?
- Merge başarısız oldu
- [x] main, feature dalının açıldığı noktadan beri ilerlememişti; Git fast-forward yaptı
- Git merge commit'lerini gizler
? `--no-ff` ile merge commit'i zorlanabilir.
```

```quiz
Üç yönlü merge'de Git hangi üç anlık görüntüyü kullanır?
- İki dalın son commit'leri ve main'in ilk commit'i
- [x] İki dalın uçları ve ortak ataları (merge-base)
- Son üç commit
? Ortak atadan her iki tarafın ne değiştirdiğine bakılır; aynı yer farklı değiştiyse çakışma olur.
```

```quiz
Çakışma işaretçilerinde ortak atanın halini de görmek için hangi ayar kullanılır?
- merge.ff=false
- [x] merge.conflictStyle=zdiff3
- rerere.enabled=true
? `|||||||` bölümü, iki tarafın neyi değiştirdiğini anlamayı sağlar.
```

## Özet

- Fast-forward: hedef dal ilerlememişse sadece işaretçi kayar. `--no-ff` bir merge commit'i zorlar ve özelliği tek commit'te gruplar.
- Üç yönlü merge: ortak ata (`merge-base`) + iki uç. Merge commit'in iki ebeveyni var; ilki içinde bulunduğun dal.
- Git metni birleştirir, anlamı değil: merge'den sonra test.
- Çakışma: işaretçiler, `git status`, index'te üç aşama (`:1:`, `:2:`, `:3:`), `--ours`/`--theirs`. `merge.conflictStyle zdiff3` ile ortak ata görünür.
- Çöz → `git add` → `git commit`. `git merge --abort` ile vazgeç. `git diff --check` ile unutulmuş işaretçiler. `rerere` tekrar eden çakışmalar için.
- `branch --merged`, güvenli `-d`, zorla `-D`.
