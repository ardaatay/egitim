# set -euo pipefail, trap, tırnaklama

Kabuk betikleri varsayılan olarak **hataları yok sayar**: bir komut başarısız olur, betik bir sonraki satıra geçer. Tanımsız bir değişken sessizce boş metne dönüşür. Boşluk içeren bir dosya adı iki ayrı argümana bölünür. Bir yedek ya da deploy betiğinde bu üç davranış birleşince `rm -rf "$HEDEF/"*` satırı yanlış yeri silebilir.

Bu derste betikleri **varsayılan olarak güvenli** hâle getiren alışkanlıkları kuruyoruz.

> Tarayıcıdaki terminalde `bash` değil, BusyBox'ın `ash` kabuğu var. Bu dersteki her şey ikisinde de aynı çalışır. Sadece bash'e özgü özellikler (diziler, `trap ... ERR`) `bash` bloklarında ve "bash'te" diye belirtilerek anlatılıyor.

## Betiğin ilk satırları

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```

- **Shebang** (`#!`): Betiği hangi yorumlayıcının çalıştıracağı. `#!/bin/sh` POSIX kabuğu demektir. Debian/Ubuntu'da bu `dash`'tir ve bash özelliklerini desteklemez. bash özelliği kullanıyorsan shebang `bash` olmalı.
- **`set -e`**: Bir komut sıfır olmayan kodla biterse betikten çık.
- **`set -u`**: Tanımsız değişken kullanılırsa hata ver ve çık.
- **`set -o pipefail`**: Borudaki herhangi bir komut başarısız olursa boru başarısız sayılır (akışlar dersinde görmüştük).
- **`IFS`**: Kelime bölmenin sadece yeni satır ve tab'da yapılması. Boşluklu dosya adlarına karşı ek bir önlem.

Her birini tarayıcıda görelim.

### set -e

```terminal
cat > /tmp/e1.sh <<'EOF'
#!/bin/sh
cd /olmayan/klasor
echo "şu an buradayım: $(pwd)"
echo "rm -rf * çalışsaydı burayı silerdi"
EOF
sh /tmp/e1.sh
echo "----- set -e ile -----"
sed -i '2i set -e' /tmp/e1.sh
sh /tmp/e1.sh; echo "çıkış kodu: $?"
```

`set -e` olmadan `cd` başarısız oldu ve betik **yanlış klasörde** devam etti.

#### set -e'nin bilinmesi gereken istisnaları

`set -e` her başarısızlığı yakalamaz. Kasıtlı olarak tetiklenmediği yerler:

```terminal
sh -c 'set -e
if grep -q yok /etc/passwd; then echo bulundu; fi
grep -q yok /etc/passwd || echo "bulunamadı ama sorun değil"
! false
echo "if, ||, && ve ! içindeki hatalar betiği durdurmaz"'
```

Bunlar kasıtlıdır: `if grep ...` gibi kontrollerde başarısızlık bir **cevaptır**, hata değil. Ama tuzak olan durumlar da var:

```terminal
sh -c 'set -e
kontrol() { false; echo "fonksiyon devam etti!"; }
kontrol || echo "çağıran tarafta || olduğu için fonksiyon içinde -e kapandı"'
```

Bir fonksiyon `if`, `||` ya da `&&` bağlamında çağrılırsa, **fonksiyonun içindeki** `set -e` de devre dışı kalır. Kritik adımlarda dönüş kodunu açıkça kontrol et.

Bir diğeri: `local x=$(komut)` satırında `local`'in kendi dönüş kodu (0) komutunkini gizler. Doğrusu iki satır:

```text
local x
x=$(komut)
```

### set -u

```terminal
sh -c 'HEDEF_KLASOR=/srv/yedek
echo "silinecek: $HEDEF_KLSOR/*"'
sh -c 'set -u
HEDEF_KLASOR=/srv/yedek
echo "silinecek: $HEDEF_KLSOR/*"'
```

İlkinde yazım hatası yüzünden yol `/*` oldu. Bunun önünde `rm -rf` olsaydı... İkincisinde `set -u` betiği durdurdu.

Bir değişkenin tanımsız olması **beklenen** bir durumsa varsayılan değer ver:

```terminal
sh -c 'set -u
ORTAM=${ORTAM:-staging}
echo "ortam: $ORTAM"
echo "ilk argüman: ${1:-verilmedi}"'
```

Zorunlu bir değişken için açıklayıcı hata mesajı:

```terminal
sh -c 'set -u; : "${DEPLOY_SURUM:?DEPLOY_SURUM tanımlanmalı, örn: DEPLOY_SURUM=1.4.0 ./deploy.sh}"'
```

## Tırnaklama

Kural basit: **Her değişken genişletmesini çift tırnağa al**: `"$dosya"`, `"$@"`, `"$(komut)"`. Tırnaksız genişletme iki şey yapar: değeri boşluklardan **böler** ve her parçayı **joker karakter** olarak yorumlar.

```terminal
cd /tmp && rm -rf trn && mkdir trn && cd trn
touch "aylik rapor.pdf" diger.txt
f="aylik rapor.pdf"
ls $f
ls "$f"
d="*"
echo $d
echo "$d"
cd ~
```

- `ls $f` iki ayrı dosya aradı: `aylik` ve `rapor.pdf`.
- `echo $d` joker karakter olarak genişledi ve klasördeki dosyaları listeledi. Tırnaksız `rm $d` neyi silerdi, düşün.

Argümanları başka bir komuta aktarırken her zaman `"$@"`:

```terminal
cat > /tmp/sarici.sh <<'EOF'
#!/bin/sh
echo "argüman sayısı: $#"
for a in "$@"; do echo "  [$a]"; done
EOF
sh /tmp/sarici.sh "bir iki" üç
sh -c 'sh /tmp/sarici.sh $@' _ "bir iki" üç
sh -c 'sh /tmp/sarici.sh "$@"' _ "bir iki" üç
```

## Parametre genişletme

Basit metin işlemleri için `sed`/`awk`/`basename` çağırmaya gerek yok:

```terminal
f="/srv/yedek/db-20261125.sql.gz"
echo "${f##*/}"        # en uzun */ önekini at: dosya adı
echo "${f%/*}"         # en kısa /* sonekini at: klasör
echo "${f%.gz}"        # .gz uzantısını at
echo "${f%%.*}"        # ilk noktadan sonrasını at
echo "${#f}"           # uzunluk
echo "${f/yedek/arsiv}" # ilk eşleşmeyi değiştir (bash ve ash)
```

| Yazım | Anlamı |
|---|---|
| `${v:-x}` | Boş/tanımsızsa `x` kullan |
| `${v:=x}` | Boş/tanımsızsa `x` ata ve kullan |
| `${v:?mesaj}` | Boş/tanımsızsa mesajla çık |
| `${v#desen}` / `${v##desen}` | Baştan en kısa / en uzun eşleşmeyi at |
| `${v%desen}` / `${v%%desen}` | Sondan en kısa / en uzun eşleşmeyi at |

## trap: her durumda temizlik

Betik başarıyla bitse de, hata verse de, Ctrl+C ile kesilse de çalışması gereken temizlik için `trap ... EXIT`:

```terminal
cat > /tmp/trap.sh <<'EOF'
#!/bin/sh
set -eu
CALISMA=$(mktemp -d)
temizle() {
  rc=$?
  rm -rf "$CALISMA"
  echo "temizlendi: $CALISMA (çıkış kodu $rc)"
}
trap temizle EXIT
echo "geçici klasör: $CALISMA"
touch "$CALISMA/ara-dosya"
[ "${1:-}" = "hata" ] && false
echo "iş başarıyla bitti"
EOF
sh /tmp/trap.sh
sh /tmp/trap.sh hata; echo "dış çıkış kodu: $?"
```

İki durumda da temizlik çalıştı ve çıkış kodu korundu (`rc=$?` ilk satırda alınmalı, sonraki komutlar onu ezer).

bash'te ayrıca hata veren satırı raporlamak çok faydalıdır:

```bash
trap 'echo "HATA: satır $LINENO, komut: $BASH_COMMAND (kod $?)" >&2' ERR
```

## Kilit: aynı betik iki kez çalışmasın

Zamanlanmış işler dersindeki `flock`, betiğin içinden de alınabilir:

```terminal
cat > /tmp/kilitli.sh <<'EOF'
#!/bin/sh
set -eu
exec 9> /tmp/kilitli.lock
if ! flock -n 9; then echo "başka bir kopya çalışıyor, çıkıyorum"; exit 0; fi
echo "kilidi aldım (PID $$), çalışıyorum..."
sleep 5
EOF
sh /tmp/kilitli.sh & sleep 1; sh /tmp/kilitli.sh; wait
```

`exec 9>` dosyayı fd 9 olarak açar ve betik bitene kadar açık tutar. Kilit fd'ye bağlı olduğu için betik nasıl biterse bitsin (çökme, `kill -9` dahil) kilit kalkar.

## Okunabilir betik yapısı

Uzun betiklerde iyi işleyen bir iskelet:

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly BETIK_ADI=${0##*/}
log()  { printf '%s [%s] %s\n' "$(date +%T)" "$BETIK_ADI" "$*" >&2; }
olum() { log "HATA: $*"; exit 1; }

kullanim() {
  cat <<EOF
Kullanım: $BETIK_ADI [-n] <surum>
  -n   kuru çalıştırma, hiçbir şeyi değiştirme
EOF
  exit 2
}

KURU=0
while getopts ":nh" opt; do
  case $opt in
    n) KURU=1 ;;
    h) kullanim ;;
    *) kullanim ;;
  esac
done
shift $((OPTIND - 1))
[[ $# -eq 1 ]] || kullanim
SURUM=$1

calistir() {   # kuru modda komutu sadece yazdır
  if (( KURU )); then log "[kuru] $*"; else log "> $*"; "$@"; fi
}

main() {
  command -v curl >/dev/null || olum "curl gerekli"
  calistir mkdir -p "/srv/app/releases/$SURUM"
  log "bitti"
}
main "$@"
```

- Loglar **stderr**'e gider, stdout betiğin gerçek çıktısı için temiz kalır.
- `olum` (die) fonksiyonu hata mesajı + çıkış kodunu tek yerde toplar.
- `getopts` ile seçenekler, `kullanim` ile yardım.
- `calistir` ile **kuru çalıştırma** (`-n`) desteği: Bir betiği ilk kez üretimde çalıştırmadan önce ne yapacağını görmenin en ucuz yolu.
- `main "$@"` en sonda: Betik dosyası yarım indirilmişse bile hiçbir şey çalışmaz, çünkü fonksiyonlar ancak dosya tamamen okunduktan sonra çağrılır.

### bash dizileri

Komut argümanlarını bir değişkende biriktirmek gerektiğinde metin birleştirme değil **dizi** kullan. Metin birleştirme tırnaklama sorunlarına yol açar:

```bash
args=(--archive --compress --delete)
[[ $KURU -eq 1 ]] && args+=(--dry-run)
args+=(--exclude "node_modules" --exclude "*.log")
rsync "${args[@]}" ./ "sunucu:/srv/app/releases/$SURUM/"
```

`"${args[@]}"` her elemanı ayrı ve bölünmemiş bir argüman olarak verir.

## ShellCheck

Bu dersteki hataların neredeyse tamamını **ShellCheck** otomatik yakalar: tırnaksız değişkenler, `local x=$(...)`, `cd` sonrası kontrol eksikliği, `[ $a == $b ]` gibi taşınabilirlik sorunları. Editörüne eklentisini kur ve CI'da çalıştır:

```bash
apt-get install -y shellcheck
shellcheck deploy.sh
```

Her uyarının bir kodu (örneğin `SC2086`) ve açıklama sayfası vardır. Bilinçli bir istisna için satırın üstüne `# shellcheck disable=SC2086` yazılır.

## Alıştırma

Tarayıcıda, aşağıdaki betiği oluştur. Bilerek kötü yazıldı. Sorunları bul ve düzelt:

```terminal
cat > /tmp/kotu.sh <<'EOF'
#!/bin/sh
YEDEK_KLASORU=$1
GECICI=/tmp/yedek-calisma
mkdir $GECICI
cp /etc/passwd /etc/group $GECICI
tar cf - -C $GECICI . | gzip > $YEDEK_KLASORU/yedek.tgz
rm -rf $GECICI
echo "yedek alındı: $YEDEK_KLASORU/yedek.tgz"
EOF
sh /tmp/kotu.sh "/tmp/benim yedeklerim"; echo "kod: $?"
ls /tmp | head
```

<details><summary>Sorunlar ve çözüm</summary>

1. `set -eu` ve `pipefail` yok: hedef klasör yokken yazma başarısız oldu ama betik "yedek alındı" yazdı.

(Tarayıcıdaki BusyBox `tar`'ı `-z` desteklemediği için sıkıştırmayı `| gzip` ile yaptık. Bash ve ash `set -o pipefail`'i destekler. Debian'daki `dash` gibi eski POSIX kabuklarında desteklenmeyebilir, betiğin shebang'i bu yüzden önemli.)
2. Argüman verilmezse `$1` boş, tar `/yedek.tgz` köke yazmaya çalışır.
3. Tırnaksız değişkenler: Bu örnekte değişken sadece yönlendirme hedefinde geçtiği için bölünmedi (kabuk yönlendirme hedefini bölmez), ama aynı değişken `cp`, `tar` ya da `rm` argümanı olarak kullanılsaydı boşluktan ikiye ayrılırdı. Tırnaklamayı duruma göre değil her zaman yap.
4. Sabit geçici klasör: iki kopya aynı anda çalışırsa birbirini ezer. İkinci çalıştırmada `mkdir` hata verir. Hata olursa da temizlenmez.

```terminal
cat > /tmp/iyi.sh <<'EOF'
#!/bin/sh
set -eu
set -o pipefail
YEDEK_KLASORU=${1:?Kullanım: iyi.sh <yedek-klasörü>}
[ -d "$YEDEK_KLASORU" ] || { echo "klasör yok: $YEDEK_KLASORU" >&2; exit 1; }
GECICI=$(mktemp -d)
trap 'rm -rf "$GECICI"' EXIT
cp /etc/passwd /etc/group "$GECICI"
HEDEF="$YEDEK_KLASORU/yedek-$(date +%Y%m%d-%H%M%S).tgz"
tar cf - -C "$GECICI" . | gzip > "$HEDEF"
echo "yedek alındı: $HEDEF"
EOF
sh /tmp/iyi.sh; echo "kod: $?"
sh /tmp/iyi.sh "/tmp/benim yedeklerim"; echo "kod: $?"
mkdir -p "/tmp/benim yedeklerim" && sh /tmp/iyi.sh "/tmp/benim yedeklerim"; echo "kod: $?"
ls -l "/tmp/benim yedeklerim"
```

</details>

```quiz
`set -e` olan bir betikte `kontrol || echo hata` satırındaki `kontrol` fonksiyonunun içinde bir komut başarısız oluyor. Ne olur?
- Betik hemen çıkar
- [x] Fonksiyon içinde `-e` devre dışı kalır, fonksiyon devam eder
- Sözdizimi hatası verir
? `||`, `&&`, `if` ve `!` bağlamında çağrılan fonksiyonlarda `set -e` etkisizdir. Kritik adımları açıkça kontrol et.
```

```quiz
`rm -rf "$BUILD_DIR/"*` satırında `BUILD_DIR` yanlış yazılmış bir değişken adı. Hangisi en iyi korur?
- `set -e`
- [x] `set -u` (ya da `${BUILD_DIR:?}`)
- `set -o pipefail`
? Tanımsız değişken `set -u` ile hataya dönüşür. `${VAR:?}` tek bir satırda aynı korumayı sağlar.
```

```quiz
Bir değişkenin içinde boşluklu bir dosya adı var. Doğru kullanım hangisi?
- `cp $dosya /yedek/`
- [x] `cp "$dosya" /yedek/`
- `cp '$dosya' /yedek/`
? Çift tırnak genişletmeye izin verir ama bölmeyi ve joker yorumunu engeller. Tek tırnak değişkeni hiç genişletmez.
```

## Özet

- `#!/usr/bin/env bash` + `set -euo pipefail`. `-e`'nin `if/||/&&` istisnalarını bil.
- Her genişletmeyi tırnakla: `"$v"`, `"$@"`, `"$(...)"`.
- Varsayılan `${v:-x}`, zorunlu `${v:?mesaj}`.
- `mktemp -d` + `trap ... EXIT` ile temizlik. `flock` ile tek kopya.
- Loglar stderr'e, `main "$@"` sonda, `-n` kuru çalıştırma, ShellCheck.
