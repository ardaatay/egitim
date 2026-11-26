# Git'in iç modeli: blob, tree, commit ve referanslar

Git komutları ilk bakışta tutarsız görünür: `reset` üç farklı iş yapar, `checkout` hem dal değiştirir hem dosya geri alır, rebase "geçmişi değiştirir". Bunların hepsi, çok küçük ve tutarlı bir veri modelinin üzerine kurulu. Model oturunca, "şu komut ne yapar?" sorusu "şu komut hangi işaretçiyi nereye taşır?" sorusuna dönüşür, ve cevabı tahmin edilebilir olur. Bu ders o modeli, Git'in kendi düşük seviye komutlarıyla (plumbing) içini açarak kuruyor.

## Deneme deposu

Bu kursta her derste temiz bir deneme deposu oluşturuyoruz. Çıktıların seninkilerle **birebir aynı** olması için yazar bilgisini ve zamanı sabitliyoruz. Git'in hash'leri içerikten hesaplandığı için, aynı içerik ve aynı meta veri her bilgisayarda aynı hash'i üretir:

```bash
export GIT_AUTHOR_NAME="Ayşe Demir"     GIT_AUTHOR_EMAIL="ayse@ornek.com"
export GIT_COMMITTER_NAME="Ayşe Demir"  GIT_COMMITTER_EMAIL="ayse@ornek.com"
export GIT_AUTHOR_DATE="2026-11-26T10:00:00+03:00"
export GIT_COMMITTER_DATE="2026-11-26T10:00:00+03:00"

mkdir -p ~/git-egitim && cd ~/git-egitim
git init -b main model && cd model
git config core.autocrlf false        # Windows'ta: satır sonlarını değiştirme (sonraki derste)
```

Windows'ta Git Bash kullan. PowerShell'de değişkenler `$env:GIT_AUTHOR_NAME = "..."` biçiminde verilir.

## Blob: dosyanın içeriği

```bash
printf 'merhaba\n' > README.md
git hash-object README.md
find .git/objects -type f | wc -l
```

```text
e995d8e1c89654fd0a6453c2da61fb6e9da262e6
0
```

`hash-object`, dosyanın Git'teki kimliğini hesapladı ama henüz bir şey kaydetmedi. Bu kimlik, içeriğin **SHA-1** özetidir. Tam olarak neyin özeti olduğunu görelim:

```bash
printf 'blob 8\0merhaba\n' | sha1sum
```

```text
e995d8e1c89654fd0a6453c2da61fb6e9da262e6  -
```

Aynı hash. Git, içeriğin önüne bir başlık (`blob`, boşluk, bayt sayısı, sıfır baytı) ekleyip özetini alır. Sonucu:

- **Aynı içerik her yerde aynı hash'i üretir.** Dosyanın adı, yeri, ne zaman oluşturulduğu hash'e girmez. Bir dosyanın 100 kopyası depoda tek bir blob olarak saklanır.
- **İçerik değişirse hash değişir.** Bir bit bile. Bir nesne hash'iyle adreslendiği için, sonradan fark edilmeden değiştirilemez. Git'in bütünlük garantisi buradan gelir.

Dosyayı **index**'e (staging alanı) ekleyelim:

```bash
git add README.md
find .git/objects -type f
git ls-files --stage
```

```text
.git/objects/e9/95d8e1c89654fd0a6453c2da61fb6e9da262e6

100644 e995d8e1c89654fd0a6453c2da61fb6e9da262e6 0	README.md
```

`git add` iki iş yaptı: İçeriği bir **blob nesnesi** olarak `.git/objects/` altına yazdı (hash'in ilk iki karakteri dizin, kalanı dosya adı), ve **index** dosyasına "README.md şu blob'dur" diye bir satır ekledi. Dikkat: Commit henüz yok, ama içerik zaten depoda. `add` edilip commit edilmemiş içerik de bu yüzden kurtarılabilir (geri alma dersi).

Nesne dosyası sıkıştırılmış haldedir. İçini açalım:

```bash
python -c "import zlib; print(zlib.decompress(open('.git/objects/e9/95d8e1c89654fd0a6453c2da61fb6e9da262e6','rb').read()))"
```

```text
b'blob 8\x00merhaba\n'
```

Hash'i alınan içeriğin ta kendisi, zlib ile sıkıştırılmış. Git'in deposu, temelde **içerikle adreslenen bir anahtar-değer deposudur**. Bir nesnenin içeriğini Git'e sormanın normal yolu:

```bash
git cat-file -t e995d8e
git cat-file -p e995d8e
```

```text
blob
merhaba
```

Hash'in ilk birkaç karakteri, depoda tekil olduğu sürece yeterlidir.

## Commit ve tree

```bash
git commit -m "README ekle"
find .git/objects -type f | sort
```

```text
.git/objects/9d/bb1c6dd0cbfe33c3b0f3d6ce90b5b9871c0f74
.git/objects/a9/2c6c51863f406f1d0dba0ed211926555ec1f18
.git/objects/e9/95d8e1c89654fd0a6453c2da61fb6e9da262e6
```

Commit iki yeni nesne oluşturdu. Commit nesnesine bakalım:

```bash
git cat-file -p HEAD
```

```text
tree 9dbb1c6dd0cbfe33c3b0f3d6ce90b5b9871c0f74
author Ayşe Demir <ayse@ornek.com> 1795676400 +0300
committer Ayşe Demir <ayse@ornek.com> 1795676400 +0300

README ekle
```

Bir **commit** şunlardan ibarettir: bir **tree** (projenin o andaki kök dizini), yazar ve commit eden (isim, e-posta, Unix zaman damgası, saat dilimi), mesaj, ve (ilk commit hariç) **ebeveyn** commit'lerin hash'leri. Commit bir fark (diff) saklamaz: Projenin **tam bir anlık görüntüsüne** (tree) işaret eder. `git show` ya da `git log -p`'deki farklar, iki anlık görüntü karşılaştırılarak o an hesaplanır.

```bash
git cat-file -p 'HEAD^{tree}'
```

```text
100644 blob e995d8e1c89654fd0a6453c2da61fb6e9da262e6	README.md
```

**Tree**, bir dizinin listesidir: her girdi için mod (`100644` normal dosya, `100755` çalıştırılabilir, `040000` alt dizin, `120000` sembolik bağ), tür, hash ve ad. Dosya **adları** blob'larda değil tree'lerde durur.

Bir commit daha, bu sefer bir alt dizin ve aynı içerikte ikinci bir dosyayla:

```bash
mkdir src
printf 'console.log("v1")\n' > src/app.js
printf 'merhaba\n' > KOPYA.md
git add .
GIT_AUTHOR_DATE="2026-11-26T10:05:00+03:00" GIT_COMMITTER_DATE="2026-11-26T10:05:00+03:00" \
  git commit -m "uygulama iskeleti"

git cat-file -p HEAD
git ls-tree HEAD
```

```text
tree 7dfd44fecf8763b6affb8a19beeee98d996509d6
parent a92c6c51863f406f1d0dba0ed211926555ec1f18
author Ayşe Demir <ayse@ornek.com> 1795676700 +0300
committer Ayşe Demir <ayse@ornek.com> 1795676700 +0300

uygulama iskeleti

100644 blob e995d8e1c89654fd0a6453c2da61fb6e9da262e6	KOPYA.md
100644 blob e995d8e1c89654fd0a6453c2da61fb6e9da262e6	README.md
040000 tree a21a8a928a6b4ec0a2ff47c595aa87eb5a18a50b	src
```

`KOPYA.md` ve `README.md` **aynı blob'a** işaret ediyor: İçerik bir kez saklandı. `src` bir alt tree. Commit'in `parent` satırı önceki commit'i gösteriyor: Commit'ler birbirine ebeveynleriyle bağlı bir **zincir** (aslında yönlü, döngüsüz bir çizge, DAG) oluşturur.

Bütün yapı:

```text
commit 5b20c20 ──parent──▶ commit a92c6c5
   │                          │
   ▼ tree 7dfd44f             ▼ tree 9dbb1c6
   ├── KOPYA.md  ─┐           └── README.md ─┐
   ├── README.md ─┼──────────────────────────┴──▶ blob e995d8e ("merhaba")
   └── src/  (tree a21a8a9)
        └── app.js ──▶ blob ae24b40
```

Bu yapının en önemli özelliği: Bir commit'in hash'i tree'sinin hash'ini, tree'nin hash'i içindeki blob'ların hash'lerini, ve commit ebeveyninin hash'ini içerir. Yani bir commit hash'i, **o ana kadarki bütün geçmişi** kapsar. Geçmişteki tek bir dosyanın tek bir baytı değişse, o commit'ten sonraki bütün commit'lerin hash'leri değişir. "Geçmişi yeniden yazmak" (rebase, amend) bu yüzden **yeni** commit'ler oluşturmak demektir: Eskiler değiştirilemez, sadece yerlerine yenileri yapılır.

## Referanslar: dallar sadece işaretçidir

Hash'ler insanların hatırlayacağı şeyler değil. **Referanslar** (refs), hash'lere verilen adlardır:

```bash
cat .git/HEAD
cat .git/refs/heads/main
git branch ozellik
ls .git/refs/heads
cat .git/refs/heads/ozellik
```

```text
ref: refs/heads/main
5b20c201ef2df08f4d8446a546e30b17567d54d0

main
ozellik
5b20c201ef2df08f4d8446a546e30b17567d54d0
```

Bir **dal** (branch), içinde 40 karakterlik bir hash olan bir dosyadır. Bu kadar. Yeni bir dal oluşturmak 41 baytlık bir dosya yazmaktır: Dosya kopyalanmaz, geçmiş çoğaltılmaz. Git'te dalların bu kadar ucuz olmasının ve ekiplerin her iş için dal açmasının sebebi budur.

`HEAD` ise **şu an nerede olduğunu** gösteren özel bir referanstır. Normalde bir dala işaret eder (`ref: refs/heads/main`): Sembolik bir referanstır. Yeni bir commit yaptığında Git:

1. Yeni commit nesnesini, ebeveyni `HEAD`'in gösterdiği commit olacak şekilde oluşturur,
2. `HEAD`'in işaret ettiği **dalı** yeni commit'e taşır.

```bash
git log --oneline --graph --all --decorate
```

```text
* 5b20c20 (HEAD -> main, ozellik) uygulama iskeleti
* a92c6c5 README ekle
```

`HEAD -> main`: HEAD main'e işaret ediyor; `ozellik` de aynı commit'te. Şimdi `main`'de bir commit yaparsak sadece `main` ilerler, `ozellik` yerinde kalır.

### Detached HEAD

`HEAD` bir dal yerine doğrudan bir commit'e işaret edebilir:

```bash
git switch --detach HEAD~1
cat .git/HEAD
git status | head -1
git switch main
```

```text
a92c6c51863f406f1d0dba0ed211926555ec1f18
HEAD detached at a92c6c5
```

Bu "kopuk HEAD" durumunda yapılan commit'ler hiçbir dala bağlı değildir. Başka bir dala geçtiğinde onlara işaret eden bir ad kalmaz, ve bir süre sonra çöp toplayıcı tarafından silinirler (geri alma dersinde reflog ile kurtarmayı göreceğiz). Eski bir sürümü incelemek için güvenli ve kullanışlıdır. O durumda iş yapacaksan önce bir dal oluştur: `git switch -c yeni-dal`.

### Revizyon ifadeleri

Git'in çoğu komutu bir commit'i farklı yollardan kabul eder, ve `rev-parse` onları hash'e çevirir:

```bash
git rev-parse HEAD HEAD~1 'HEAD^{tree}' main ozellik
```

```text
5b20c201ef2df08f4d8446a546e30b17567d54d0
a92c6c51863f406f1d0dba0ed211926555ec1f18
7dfd44fecf8763b6affb8a19beeee98d996509d6
5b20c201ef2df08f4d8446a546e30b17567d54d0
5b20c201ef2df08f4d8446a546e30b17567d54d0
```

- `HEAD~1` (ya da `HEAD~`): bir önceki commit (birinci ebeveyn). `HEAD~3`: üç adım geri.
- `HEAD^2`: ikinci ebeveyn (merge commit'lerinde, birleştirilen dal).
- `HEAD^{tree}`: commit'in tree'si.
- `main@{2}`, `HEAD@{yesterday}`: reflog'a göre (geri alma dersi).
- `main..ozellik`: ozellik'te olup main'de olmayan commit'ler; `main...ozellik`: iki taraftan birinde olup ortak olmayanlar.

## Paketleme

Her nesnenin ayrı, sıkıştırılmış bir dosya olması küçük projelerde sorun değil, ama bir dosyanın 1.000 sürümü 1.000 ayrı tam kopya demektir. Git zaman zaman nesneleri **paket dosyalarına** (packfile) toplar ve benzer nesneleri **delta** olarak (birbirinin farkı olarak) saklar:

```bash
printf 'console.log("v2")\n' > src/app.js
git add src/app.js
GIT_AUTHOR_DATE="2026-11-26T10:10:00+03:00" GIT_COMMITTER_DATE="2026-11-26T10:10:00+03:00" git commit -q -m "v2"
git count-objects -v | head -2
git gc -q
git count-objects -v | head -4
ls .git/objects/pack
```

```text
count: 11
size: 0

count: 0
size: 0
in-pack: 11
packs: 1

pack-6a4c66f0f96a59b960076d3f0d94c2b9f0d9ea9f.idx
pack-6a4c66f0f96a59b960076d3f0d94c2b9f0d9ea9f.pack
pack-6a4c66f0f96a59b960076d3f0d94c2b9f0d9ea9f.rev
```

11 ayrı nesne dosyası, tek bir paket dosyasına toplandı. Mantıksal model değişmedi: Her commit hâlâ tam bir anlık görüntüdür. Paketleme sadece fiziksel depolamanın bir optimizasyonudur. `git gc` normalde arka planda kendiliğinden çalışır, ve ağ üzerinden aktarımlar (clone, fetch, push) da paket dosyalarıyla yapılır.

Not: Git, uzun süredir SHA-1'den SHA-256'ya geçişi hazırlıyor (`git init --object-format=sha256`). Yeni depolarda varsayılan hâlâ SHA-1'dir (`git rev-parse --show-object-format` → `sha1`), ve iki format arasında birlikte çalışabilirlik sınırlıdır. Kavramlar aynıdır, sadece hash'ler 64 karakterdir.

## Üç alan

Model oturunca, günlük Git kullanımının "üç alanı" net hale gelir:

| Alan | Nerede | Ne tutar |
|---|---|---|
| **Çalışma dizini** | Diskteki dosyalar | Düzenlediğin hal |
| **Index** (staging) | `.git/index` | Bir sonraki commit'in tree'si: dosya adı → blob eşlemesi |
| **Depo** | `.git/objects` + `.git/refs` | Commit'ler, tree'ler, blob'lar ve onlara işaret eden adlar |

`git add`: çalışma dizini → index (ve blob'lar depoya). `git commit`: index → yeni tree ve commit, dal ilerler. `git switch`/`checkout`: HEAD'i taşır, index'i ve çalışma dizinini o commit'in tree'sine göre günceller. Sonraki derslerdeki her komutu bu üç alan ve "hangi işaretçi nereye taşınıyor" sorusuyla okuyacağız.

## Alıştırma

1. Aynı deneme deposunda `docs/` adında bir dizin oluştur ve içine `README.md` ile **aynı içerikte** bir dosya koy. Commit'ten sonra kaç yeni nesne oluştu? Hangileri?
2. Bir dal oluştur, onu `git branch -d` yerine `.git/refs/heads/` altındaki dosyayı silerek "sil", sonra `git log --all` ile kontrol et. Commit'ler kayboldu mu?
3. `git cat-file -p` ile "uygulama iskeleti" commit'indeki (`v1`) `src/app.js`'in içeriğini, ara hash'leri elle takip ederek bul. (1. alıştırmadan sonra bu commit `HEAD~2`'dir.)

<details><summary>Çözüm</summary>

```bash
mkdir docs && printf 'merhaba\n' > docs/OKU.md
git add docs
GIT_AUTHOR_DATE="2026-11-26T10:15:00+03:00" GIT_COMMITTER_DATE="2026-11-26T10:15:00+03:00" git commit -q -m "docs ekle"
git count-objects -v | head -1
git ls-tree -r HEAD
```

```text
count: 3
100644 blob e995d8e1c89654fd0a6453c2da61fb6e9da262e6	KOPYA.md
100644 blob e995d8e1c89654fd0a6453c2da61fb6e9da262e6	README.md
100644 blob e995d8e1c89654fd0a6453c2da61fb6e9da262e6	docs/OKU.md
100644 blob 64d0be26fd68188ab4f3faf2c993a2a6285af325	src/app.js
```

(`count: 3`, son `gc`'den sonra oluşan gevşek nesne sayısı.)

Yeni blob **oluşmadı**: `docs/OKU.md`, var olan `e995d8e` blob'una işaret ediyor. Üç yeni nesne: `docs` için bir tree, yeni kök tree (içinde `docs` girdisi değiştiği için), ve commit.

2. Dal dosyasını silmek dalı siler, ama commit nesneleri `.git/objects`'te kalır. O commit'ler başka bir daldan erişilebiliyorsa (örneğin `main`'in geçmişindeyse) hiçbir şey kaybolmaz. Sadece o dala özgü commit'ler varsa, artık `git log --all`'da görünmezler (hiçbir ad onlara işaret etmez), ama reflog'dan bulunup kurtarılabilirler. Çöp toplayıcı onları ancak reflog süresi dolunca (varsayılan 30–90 gün) siler. (`.git` içindeki dosyaları elle düzenlemek, modeli anlamak için iyi bir deneydir; normal kullanımda `git branch -D` kullan. Ayrıca büyük depolarda refs, `.git/packed-refs` dosyasında ya da yeni `reftable` formatında tutulabilir; o zaman her dal ayrı bir dosya değildir.)

3.

```bash
git cat-file -p HEAD~2            # tree satırındaki hash'i al
git cat-file -p <kök-tree-hash>   # src satırındaki tree hash'ini al
git cat-file -p <src-tree-hash>   # app.js'in blob hash'i
git cat-file -p <blob-hash>       # console.log("v1")
```

Ya da kısaca: `git cat-file -p HEAD~2:src/app.js` → `console.log("v1")`. `revizyon:yol` sözdizimi, bir commit'teki bir dosyanın içeriğini doğrudan verir: `git show HEAD~3:config.yaml` ile eski bir yapılandırmayı görmek gibi.

</details>

```quiz
Git bir commit'te ne saklar?
- Önceki commit'e göre farkları (diff)
- [x] Projenin tam anlık görüntüsüne işaret eden bir tree, ebeveyn commit'ler, yazar bilgisi ve mesaj
- Sadece değişen dosyaları
? Farklar gösterilirken iki anlık görüntü karşılaştırılarak hesaplanır; depolama tarafında paketleme delta kullanır.
```

```quiz
Git'te yeni bir dal oluşturmak neden çok ucuzdur?
- Git dosyaları sıkıştırır
- [x] Dal, bir commit hash'i içeren küçük bir referans dosyasıdır; hiçbir şey kopyalanmaz
- Dallar sadece uzak sunucuda tutulur
? Bir commit yapıldığında HEAD'in işaret ettiği dal yeni commit'e taşınır.
```

```quiz
Geçmişteki bir commit'in mesajını değiştirmek neden sonraki bütün commit'lerin hash'lerini değiştirir?
- Git bütün hash'leri her gün yeniden hesaplar
- [x] Her commit ebeveyninin hash'ini içerir; ebeveyn değişince çocuğun içeriği, dolayısıyla hash'i de değişir
- Mesajlar tree'de saklanır
? "Geçmişi yeniden yazmak" yeni commit'ler oluşturmaktır; eskiler değiştirilemez.
```

## Özet

- Git, içerikle adreslenen bir nesne deposudur: hash = SHA-1(`tür boyut\0içerik`). Aynı içerik bir kez saklanır, bir bit değişse hash değişir.
- Blob: dosya içeriği (ad yok). Tree: dizin (ad → blob/tree). Commit: tree + ebeveyn(ler) + yazar + mesaj; tam bir anlık görüntü.
- Commit hash'i bütün geçmişi kapsar: geçmişi yeniden yazmak yeni commit'ler oluşturmaktır.
- Dal = bir hash içeren referans. HEAD = şu anki konum, genellikle bir dala işaret eder. Detached HEAD'de commit'ler dalsızdır.
- Revizyon ifadeleri: `~`, `^`, `^{tree}`, `rev:yol`, `a..b`, `a...b`.
- Paket dosyaları ve delta depolamanın optimizasyonudur; mantıksal model anlık görüntüdür.
- Üç alan: çalışma dizini, index, depo.
