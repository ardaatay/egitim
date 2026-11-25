# find ve xargs ile toplu işler

"7 günden eski logları sil", "son bir saatte değişen ayar dosyalarını bul", "herkese yazılabilir klasörleri listele", "100 MB'tan büyük dosyaları bul", "bütün `.conf` dosyalarında bir değeri değiştir"... Bunların hepsi aynı kalıptır: **dosyaları ölçüte göre bul, her birine bir işlem uygula.** Araçları `find` ve `xargs`.

## Deneme klasörü

```terminal
rm -rf /tmp/proje && mkdir -p /tmp/proje/logs /tmp/proje/uploads/2026 /tmp/proje/cache && cd /tmp/proje
for g in 01 05 10 15 20; do touch -d "2026-11-$g 03:00" "logs/app-2026-11-$g.log"; done
touch logs/app.log
dd if=/dev/zero of="uploads/2026/aylik rapor.pdf" bs=1024 count=200 2>/dev/null
dd if=/dev/zero of=uploads/2026/fatura.pdf bs=1024 count=100 2>/dev/null
dd if=/dev/zero of=cache/blob.bin bs=1024 count=3072 2>/dev/null
dd if=/dev/zero of=uploads/2026/video.mp4 bs=1024 count=1500 2>/dev/null
chmod 777 uploads/2026
mkdir cache/bos
tree .
```

## find'ın yapısı

```text
find  [nerede]  [ölçütler]  [eylem]
find  /var/log  -name '*.log' -mtime +7   -print
```

Ölçütler soldan sağa değerlendirilir ve varsayılan olarak **VE** ile bağlanır. Eylem verilmezse `-print` varsayılır.

### İsim ve tür

```terminal
find . -name '*.log'
find . -type d
find . -type f -name '*.pdf'
find . -iname '*.PDF'
```

> Deseni **tırnak içine al**: `find . -name *.log` yazarsan kabuk `*.log`'u bulunduğun klasördeki dosyalara genişletir ve `find` beklemediğin bir argüman alır (joker karakterler dersi).

`-type` değerleri: `f` dosya, `d` klasör, `l` symlink, `s` soket, `p` adlandırılmış boru.

### Zaman

| Ölçüt | Anlamı |
|---|---|
| `-mtime +7` | İçeriği 7 günden **daha önce** değişmiş |
| `-mtime -1` | Son 24 saat içinde değişmiş |
| `-mmin -60` | Son 60 dakikada değişmiş |
| `-newer dosya` | Bu dosyadan daha yeni |
| `-atime`, `-ctime` | Erişim ve durum (izin/sahip) değişikliği zamanı |

```terminal
find logs -name '*.log' -mtime +7
find . -type f -mmin -10
```

`+7` "tam 7 günden fazla" anlamına gelir ve gün sayısı aşağı yuvarlanarak hesaplanır. Sınırdaki dosyalarda bir gün kayma görebilirsin. Kesin bir eşik gerekiyorsa bir referans dosyası oluşturup `-newer`/`! -newer` kullan.

Olay incelemesinde altın değerinde bir kalıp: "son bir saatte `/etc` altında ne değişti?"

```text
find /etc -type f -mmin -60 -ls
```

### Boyut

```terminal
find . -type f -size +1024k
find . -type f -size -1k
find . -empty
```

GNU find (Ubuntu, RHEL) `-size +100M` ve `-size +1G` gibi birimleri de kabul eder. Tarayıcıdaki BusyBox sadece `c` (bayt), `k` ve `b` (512 bayt) biliyor, bu yüzden `+1024k` yazdık.

Diski dolduran büyük dosyaları bulmak için gerçek sunucuda:

```text
find / -xdev -type f -size +500M -exec ls -lh {} + 2>/dev/null | sort -k5 -rh | head
```

`-xdev` başka dosya sistemlerine (ağ diskleri, `/proc`) geçmez.

### İzin ve sahiplik

```terminal
find . -perm -0002 -type d
find . -user root -type f | wc -l
```

`-perm -0002`: "diğerleri için yazma biti açık olanlar" (herkese yazılabilir). Güvenlik denetiminde sık kullanılır. Benzer şekilde `-perm -4000` setuid dosyaları, `-nouser` sahibi silinmiş kullanıcı olan dosyaları bulur.

### Mantık: VEYA, DEĞİL, budama

```terminal
find . -name '*.pdf' -o -name '*.mp4'
find . -type f ! -name '*.log'
find . -path ./cache -prune -o -type f -print
```

- `-o` VEYA, `!` DEĞİL. Karışık ifadelerde gruplamak için `\( ... \)`.
- `-prune` bir klasörün içine hiç girmez. `node_modules`, `.git` ya da büyük önbellek klasörlerini taramadan atlamak için kullanılır. Sondaki açık `-print` gereklidir, yoksa budanan klasörün adı da yazdırılır.

## Bulunanlarla bir şey yapmak

### -exec

```terminal
find logs -name '*.log' -mtime +7 -exec ls -l {} \;
find logs -name '*.log' -mtime +7 -exec ls -l {} +
```

- `{} \;` komutu **her dosya için ayrı ayrı** çalıştırır (1000 dosya = 1000 süreç).
- `{} +` dosyaları gruplayıp komutu **mümkün olduğunca az sayıda** çalıştırır. Çok daha hızlıdır ve neredeyse her zaman tercih edilmelidir.

Silmek için GNU find'da `-delete` vardır. BusyBox'ta yok, ikisinde de çalışan yol `-exec rm`:

```terminal
find logs -name '*.log' -mtime +7 -exec rm -v {} +
ls logs
```

> **Dikkat:** Silme komutunu çalıştırmadan önce aynı `find` ifadesini **eylemsiz** çalıştırıp listeye bak. Özellikle `-o` kullanırken: `find . -name '*.tmp' -o -name '*.bak' -delete` ifadesinde `-delete` sadece ikinci koşula bağlanır, çünkü VE (örtük) VEYA'dan önce gelir. Doğrusu `find . \( -name '*.tmp' -o -name '*.bak' \) -delete`.

## xargs

`xargs`, stdin'den okuduğu satırları başka bir komutun **argümanlarına** çevirir. `find` dışındaki kaynaklarla (grep, bir dosya listesi, bir API çıktısı) çalışırken gerekir.

```terminal
seq 1 6 | xargs echo
seq 1 6 | xargs -n 2 echo
```

### Boşluklu dosya adları: -print0 ve -0

`xargs` varsayılan olarak boşluk ve yeni satırdan böler. Boşluklu bir dosya adı iki argüman olur:

```terminal
find uploads -name '*.pdf' | xargs ls -l
find uploads -name '*.pdf' -print0 | xargs -0 ls -l
```

İlkinde `aylik` ve `rapor.pdf` diye iki olmayan dosya arandı. `-print0` dosya adlarını NUL karakteriyle ayırır (dosya adında bulunamayan tek karakter), `xargs -0` da NUL'dan böler. **find ile xargs'ı her zaman böyle bağla.**

### Paralel çalıştırma: -P

`-P N` aynı anda N süreç çalıştırır. Resim küçültme, dosya sıkıştırma, çok sayıda sunucuya istek atma gibi işlerde süreyi ciddi kısaltır:

```terminal
s=$(date +%s); seq 1 4 | xargs -I{} sh -c 'sleep 1; echo "iş {} bitti"'; echo "süre: $(( $(date +%s) - s )) sn"
s=$(date +%s); seq 1 4 | xargs -P 4 -I{} sh -c 'sleep 1; echo "iş {} bitti"'; echo "süre: $(( $(date +%s) - s )) sn"
```

`-I{}` her girdi satırını komuttaki `{}` yerine koyar (satır başına bir çalıştırma).

Gerçek bir örnek: bir klasördeki bütün logları 4 çekirdekte paralel sıkıştırmak:

```text
find /var/log/app -name '*.log' -mtime +1 -print0 | xargs -0 -P 4 -n 10 gzip
```

## Sık kullanılan tarifler

```text
# 30 günden eski release yedeklerini sil
find /var/backups -name '*.tar.gz' -mtime +30 -exec rm {} +

# Kodda bir dizgeyi ara (node_modules ve .git hariç)
find . \( -name node_modules -o -name .git \) -prune -o -type f -name '*.js' -print0 | xargs -0 grep -n 'TODO'

# Bütün .conf dosyalarında eski IP'yi yenisiyle değiştir (önce yedekle!)
find /etc/odeme -name '*.conf' -exec sed -i.bak 's/10\.0\.0\.5/10.0.0.7/g' {} +

# Bir klasördeki dosya ve klasör izinlerini düzelt
find /srv/site -type d -exec chmod 755 {} + ; find /srv/site -type f -exec chmod 644 {} +

# Klasörde en çok yer kaplayan dosya türleri
find . -type f -printf '%s %f\n' | awk '{n=split($2,a,"."); e=(n>1)?a[n]:"(yok)"; s[e]+=$1} END {for (e in s) printf "%10.1f MB  %s\n", s[e]/1048576, e}' | sort -rn | head

# Son 24 saatte değişen dosyalar, en yeniden eskiye
find /srv/app -type f -mtime -1 -printf '%TY-%Tm-%Td %TH:%TM  %p\n' | sort -r | head
```

`-printf` GNU find'a özgüdür ve tarayıcıdaki BusyBox'ta yoktur.

## Alıştırma

`/tmp/proje` klasöründe:

1. `cache` klasörünü hariç tutarak 1 MB'tan büyük dosyaları bul.
2. `uploads` altındaki bütün PDF'lerin toplam boyutunu bul (boşluklu dosya adına dikkat).
3. Herkese yazılabilir klasörlerin iznini `755` yap ve sonucu doğrula.
4. Boş klasörleri sil.

<details><summary>Çözüm</summary>

```terminal
cd /tmp/proje
find . -path ./cache -prune -o -type f -size +1024k -print
find uploads -name '*.pdf' -print0 | xargs -0 du -c | tail -1
find . -type d -perm -0002 -exec chmod 755 {} +
find . -type d -perm -0002
find . -type d -empty -exec rmdir {} +
tree .
cd ~
```

İkincide `du -c` sona toplam satırı ekler. `-print0 | xargs -0` olmadan `aylik rapor.pdf` iki ayrı (olmayan) dosya olarak görülür.

</details>

```quiz
`find /var/log -name *.log` komutu bazen çalışıyor bazen "paths must precede expression" hatası veriyor. Neden?
- find'ın sürümü eski
- [x] Desen tırnaksız, kabuk onu bulunduğun klasördeki dosyalara genişletiyor
- /var/log'a erişim izni yok
? Bulunduğun klasörde .log dosyası varsa kabuk deseni genişletir. Desen her zaman tırnak içinde yazılmalı.
```

```quiz
10.000 dosyayı silmek için hangisi daha verimli?
- `find . -name '*.tmp' -exec rm {} \;`
- [x] `find . -name '*.tmp' -exec rm {} +`
- İkisi aynı
? `\;` her dosya için ayrı bir `rm` süreci başlatır. `+` dosyaları gruplar.
```

```quiz
`find . -name '*.pdf' | xargs rm` neden tehlikeli olabilir?
- rm çok yavaştır
- [x] Boşluk ya da yeni satır içeren dosya adları bölünür ve yanlış dosyalar silinebilir
- xargs dosyaları sıralar
? Doğrusu `find ... -print0 | xargs -0 rm` ya da doğrudan `find ... -exec rm {} +`.
```

## Özet

- `find NEREDE ÖLÇÜTLER EYLEM`. Desenleri tırnakla.
- `-name/-type/-mtime/-mmin/-size/-perm/-user`, `-o`, `!`, `\( \)`, `-prune`.
- `-exec ... {} +` (gruplar) tercih et, `\;` her dosya için ayrı süreç.
- find → xargs: her zaman `-print0 | xargs -0`. Paralel için `-P`.
- Silmeden önce aynı ifadeyi eylemsiz çalıştırıp listeye bak.
