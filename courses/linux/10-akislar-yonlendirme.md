# Akışlar, yönlendirme ve çıkış kodları

`cmd > /dev/null 2>&1` satırını muhtemelen yüzlerce kez yazdın. Bu derste o satırın kabuk ve çekirdek seviyesinde tam olarak ne yaptığını, sıranın neden önemli olduğunu ve betiklerde hataları sessizce yutmamanın yollarını göreceğiz.

## Dosya tanımlayıcıları

Her süreç çekirdekten numaralı bir **dosya tanımlayıcı (fd) tablosu** ile başlar. Kabuk bir komutu çalıştırdığında üç tanesi hazırdır:

| fd | Ad | Varsayılan |
|---|---|---|
| 0 | stdin | Terminal (klavye) |
| 1 | stdout | Terminal |
| 2 | stderr | Terminal |

Bunlar soyut kavramlar değil, `/proc` altında gerçekten görünürler. Kabuğun kendi tablosuna bak:

```terminal
ls -l /proc/$$/fd
```

`$$` kabuğun PID'i. 0, 1 ve 2'nin hepsi `/dev/ttyS0`'a, yani bu terminalin seri portuna bağlı. Listede gördüğün 10 numaralı fd'yi kabuk, iş kontrolü (Ctrl+Z, `fg`) için kendisi açar. Yönlendirme dediğimiz şey, kabuğun komutu çalıştırmadan hemen önce bu bağlantıları değiştirmesidir (`fork` sonrası, `exec` öncesi `dup2` çağrıları).

## Yönlendirme operatörleri

```terminal
cd ~
ls /etc /yok > cikti.txt
cat cikti.txt
```

`/yok` için hata mesajı yine ekrana geldi, çünkü `>` sadece fd 1'i dosyaya bağlar. Hata fd 2'den akar.

| Yazım | Anlamı |
|---|---|
| `> f` | fd 1 → f (sıfırla) |
| `>> f` | fd 1 → f (sona ekle, `O_APPEND`) |
| `2> f` | fd 2 → f |
| `2>&1` | fd 2 → **o anda** fd 1 neredeyse oraya |
| `&> f` | bash kısaltması: ikisi de f'ye (POSIX değil) |
| `< f` | fd 0 ← f |
| `n>&-` | fd n'i kapat |

### Sıra neden önemli?

Yönlendirmeler **soldan sağa** uygulanır ve `2>&1` bir kopyalamadır, kalıcı bir bağ değildir:

```terminal
ls /etc/hostname /yok > iki.txt 2>&1
cat iki.txt
ls /etc/hostname /yok 2>&1 > bir.txt
cat bir.txt
```

- İlkinde: önce fd 1 → dosya, sonra fd 2 → fd 1'in **şu anki** hedefi, yani dosya. İkisi de dosyada.
- İkincisinde: önce fd 2 → fd 1'in şu anki hedefi, yani **terminal**. Sonra fd 1 → dosya. Hata ekrana geldi.

### /dev/null

Yazılan her şeyi yutan, okunduğunda hemen EOF dönen bir karakter aygıtı. Cron işlerinde gürültüyü kesmek için kullanılır, ama dikkat:

> **Dikkat:** `>/dev/null 2>&1` hata mesajlarını da yok eder. Cron'da çalışan bir yedekleme betiği aylarca sessizce başarısız olabilir. stdout'u at, stderr'i bir log dosyasına yaz: `yedek.sh >/dev/null 2>>/var/log/yedek.err`

## Borular

`a | b`, `a`'nın fd 1'ini çekirdekteki bir boru tamponuna, `b`'nin fd 0'ını da aynı borunun öbür ucuna bağlar. İki süreç **aynı anda** çalışır, sırayla değil.

Sonuçlarından biri: boru stderr'i taşımaz.

```terminal
ls /etc/hostname /yok | wc -l
ls /etc/hostname /yok 2>&1 | wc -l
```

Bir diğer sonucu: okuyan taraf kapanınca yazan taraf `SIGPIPE` alır ve sessizce ölür. `yes | head -3` bu yüzden sonsuza kadar çalışmaz:

```terminal
yes | head -3
```

### tee: hem ekrana hem dosyaya

Uzun bir işlemin çıktısını izlerken aynı anda kaydetmek için:

```terminal
ls -l /etc | tee liste.txt | wc -l
head -3 liste.txt
```

`sudo` ile yazma izni olmayan bir dosyaya yazarken de klasik çözüm budur. `sudo echo x > /etc/f` çalışmaz, çünkü yönlendirmeyi `sudo` değil **senin kabuğun** yapar. Doğrusu: `echo x | sudo tee /etc/f >/dev/null` (eklemek için `tee -a`).

## Here-doc: çok satırlı girdi

Betiklerde ayar dosyası üretmenin en okunur yolu:

```terminal
SURUM=1.4.2
cat > uygulama.env <<EOF
APP_VERSION=$SURUM
APP_PORT=8080
EOF
cat uygulama.env
```

Sınırlayıcıyı tırnağa alırsan (`<<'EOF'`) değişkenler **genişletilmez**. İçinde `$` geçen bir nginx ya da systemd dosyası yazarken bunu kullan:

```terminal
cat > ornek.conf <<'EOF'
proxy_set_header X-Real-IP $remote_addr;
EOF
cat ornek.conf
```

## Çıkış kodları

Her süreç bitince 0-255 arası bir kod döner. **0 başarı**, diğer her şey hata. Son komutun kodu `$?` içindedir:

```terminal
ls /etc > /dev/null; echo $?
ls /yok 2> /dev/null; echo $?
grep -q root /etc/passwd; echo $?
grep -q olmayan /etc/passwd; echo $?
```

Bazı yaygın kodlar: `1` genel hata, `2` yanlış kullanım, `126` çalıştırılamıyor (izin), `127` komut bulunamadı, `128+N` N numaralı sinyalle öldü (örneğin `137` = 128+9, yani `SIGKILL`; Docker ve Kubernetes'te OOM ile öldürülen konteynerlerde göreceğin kod).

### && ve ||

```terminal
mkdir -p /tmp/deploy && cd /tmp/deploy && echo "hazır: $(pwd)"
cd /yok 2>/dev/null || echo "klasör yok, devam ediyorum"
cd ~
```

`a && b || c` bir if/else **değildir**: `b` başarısız olursa `c` de çalışır. Gerçek koşul için `if` kullan.

### Borularda çıkış kodu ve pipefail

Bir borunun çıkış kodu varsayılan olarak **son** komutun kodudur:

```terminal
false | true; echo $?
cat /yok | wc -l; echo $?
```

İkinci satırda `cat` başarısız oldu ama boru 0 döndü. Bir deploy betiğinde `curl ... | tar xz` satırı indirme başarısız olsa bile "başarılı" sayılabilir. Çözüm `pipefail`: boruda başarısız olan herhangi bir komut varsa boru da başarısız olur.

```terminal
set -o pipefail
cat /yok | wc -l; echo $?
set +o pipefail
```

Bash betiklerinin başına neredeyse her zaman yazılan `set -euo pipefail` satırını Bash betikleri bölümünde ayrıntılı ele alacağız.

## Komut ikamesi

`$(...)` içindeki komutun stdout'u metin olarak yerine konur:

```terminal
echo "Çekirdek: $(uname -r), süreç sayısı: $(ls -d /proc/[0-9]* | wc -l)"
YEDEK="yedek-$(date +%Y%m%d-%H%M%S).tar.gz"
echo $YEDEK
```

Eski yazım olan ters tırnak (`` `komut` ``) iç içe kullanılamadığı için tercih edilmez.

## Alıştırma

1. `/etc` altındaki her şeyi `ls -R` ile listele. stdout'u `liste.txt`'ye, hataları `hatalar.txt`'ye yaz, ekrana hiçbir şey basılmasın.
2. `/etc/passwd` içinde `root` geçiyorsa "var", geçmiyorsa "yok" yazan tek satırlık komutu yaz. `grep` çıktısı ekrana basılmasın.
3. Aşağıdaki satırın neden işe yaramadığını açıkla: `sort liste.txt > liste.txt`

<details><summary>Cevaplar</summary>

```terminal
ls -R /etc > liste.txt 2> hatalar.txt
grep -q root /etc/passwd && echo var || echo yok
```

3: Kabuk yönlendirmeyi komutu çalıştırmadan **önce** yapar. `> liste.txt` dosyayı sıfırlar, `sort` boş bir dosya okur. Sonuç: boş dosya. Doğrusu `sort -o liste.txt liste.txt` ya da geçici dosya kullanmak.

</details>

```quiz
`uygulama > log.txt 2>&1` ile `uygulama 2>&1 > log.txt` arasındaki fark nedir?
- Hiçbir fark yok
- [x] İlkinde stderr de dosyaya gider, ikincisinde stderr terminalde kalır
- İkincisi daha hızlıdır
? `2>&1` fd 2'yi fd 1'in **o anki** hedefine kopyalar. Sıra soldan sağa işler.
```

```quiz
Bir konteyner 137 çıkış koduyla bitti. Bu ne anlama gelir?
- Komut bulunamadı
- [x] SIGKILL (9) ile öldürüldü, çoğu zaman bellek sınırı (OOM)
- Uygulama normal kapandı
? 128 + 9 = 137. Bellek limiti aşılınca çekirdek süreci SIGKILL ile öldürür.
```

```quiz
`curl -s https://ornek.com/app.tgz | tar xz` satırında indirme başarısız oldu ama betik devam etti. En doğru düzeltme?
- `2>&1` eklemek
- [x] Betiğin başına `set -o pipefail` koymak (ve hatada durmak için `set -e`)
- `curl` yerine `wget` kullanmak
? Borunun kodu son komutun kodudur. `pipefail` borudaki herhangi bir hatayı borunun hatası yapar.
```

## Özet

- fd 0/1/2 süreç başına bir tablodur, `/proc/PID/fd` altında görünür.
- Yönlendirmeler soldan sağa uygulanır, `2>&1` bir kopyadır.
- Boru stderr'i taşımaz. Borunun kodu son komutun kodudur, `pipefail` bunu değiştirir.
- `sudo` ile dosyaya yazmak için `| sudo tee`.
- 137 = SIGKILL, 127 = komut yok, 126 = çalıştırma izni yok.
