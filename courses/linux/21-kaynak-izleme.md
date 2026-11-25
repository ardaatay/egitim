# Kaynak izleme: load, CPU, bellek, disk

"Sunucu yavaş" bir teşhis değil, bir semptom. Bu derste dört kaynağı (CPU, bellek, disk alanı, disk G/Ç) tek tek ele alıp her birinin hangi araçla ölçüldüğünü ve çıktısının **nasıl yorumlandığını** göreceğiz. Bir aracın sütun adlarını bilmek kolay. Zor olan, `free`'de "free: 200M" görünce paniğe kapılmamayı ya da load 8 iken sunucunun aslında boşta olabileceğini bilmek.

## Load average

```terminal
uptime
cat /proc/loadavg
```

Üç sayı, son 1, 5 ve 15 dakikanın üssel ağırlıklı ortalamasıdır. Neyin ortalaması? **Çalışmak isteyen süreç sayısının**: `R` durumundakiler (çalışan + CPU bekleyen) **artı `D` durumundakiler** (kesilemez G/Ç bekleyen).

Yorumlarken:

- Sayıyı **CPU sayısına** göre değerlendir: `nproc`. 4 çekirdekte load 4, CPU'nun tam dolu olduğu anlamına gelir. 4 çekirdekte load 12 ise süreçler kuyrukta bekliyor.
- Üç sayının **eğilimine** bak: `8.0 4.0 1.0` yeni başlamış ve artan bir yük. `1.0 4.0 8.0` geçmekte olan bir yük.
- Load yüksek ama CPU boştaysa (`top`'ta `id` yüksek) sebep neredeyse her zaman `D` durumundaki süreçlerdir: yavaş disk, dolu bir RAID, takılan NFS.

`/proc/loadavg`'daki dördüncü alan `çalışan/toplam` süreç (aslında iş parçacığı) sayısı, beşinci alan son verilen PID.

## CPU: top ve vmstat

Gerçek bir sunucuda `top` (ya da daha okunur `htop`) açtığında ilk satırlarda şunu görürsün:

```text
%Cpu(s): 12.5 us,  3.1 sy,  0.0 ni, 80.2 id,  3.9 wa,  0.0 hi,  0.3 si,  0.0 st
```

| Alan | Anlamı | Yüksekse |
|---|---|---|
| `us` | Kullanıcı alanı (uygulaman) | Uygulama CPU'ya bağımlı. Profiling zamanı |
| `sy` | Çekirdek (sistem çağrıları, ağ, dosya sistemi) | Çok fazla küçük G/Ç, bağlam değişimi, ağ trafiği |
| `ni` | Düşük öncelikli (nice) süreçler | Genelde arka plan işleri, sorun değil |
| `id` | Boşta | |
| `wa` | G/Ç beklerken boşta | Disk darboğazı. CPU sorunu **değil** |
| `hi`/`si` | Donanım/yazılım kesmeleri | Yoğun ağ trafiği (si) |
| `st` | **Steal**: hipervizör CPU'yu başka bir VM'e verdi | Bulutta "gürültülü komşu" ya da kredi tabanlı (burst) instance'ın kredisi bitmiş |

> `st` değeri sürekli %5-10'un üstündeyse sorun senin sunucunda değil, altındaki fiziksel makinede. Uygulamayı optimize etmek işe yaramaz, instance tipini değiştirmek gerekir.

`top` içinde faydalı tuşlar: `1` çekirdek başına göster, `P` CPU'ya göre, `M` belleğe göre sırala, `c` tam komut satırı, `H` iş parçacıkları.

`vmstat 1` her saniye tek satır basar ve zaman içindeki değişimi görmek için idealdir:

```text
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 3  0      0 201340  81200 2104400    0    0     4   120  900 1800 15  4 80  1  0
```

`r` çalıştırılmayı bekleyenler, `b` G/Ç'de bloklananlar (`D`), `si`/`so` swap'a giriş/çıkış. **`si`/`so` sürekli sıfırdan büyükse makine bellek sıkıntısında** ve muhtemelen her şey yavaş.

Tarayıcıdaki Linux'ta `vmstat` yok, ama aynı veriler doğrudan `/proc`'ta:

```terminal
head -1 /proc/stat
grep -E '^(procs_running|procs_blocked|ctxt)' /proc/stat
```

İlk satırdaki sayılar açılıştan beri `user nice system idle iowait irq softirq steal` sütunlarında harcanan zaman (jiffy cinsinden). `top`, bu değerleri iki an arasında karşılaştırıp yüzdeye çevirir.

## Bellek: free ve "available"

```terminal
free
```

Yeni başlayanların en çok yanıldığı çıktı. Linux boş belleği **disk önbelleği (page cache)** olarak kullanır, çünkü boş duran RAM boşa harcanmış RAM'dir. Bir uygulama bellek isteyince çekirdek bu önbelleği anında boşaltır.

| Sütun | Anlamı |
|---|---|
| `used` | Süreçlerin gerçekten kullandığı |
| `free` | Hiç kullanılmayan. **Düşük olması normaldir** |
| `buff/cache` | Disk önbelleği. Gerektiğinde geri alınabilir (çoğu) |
| `available` | Swap'a düşmeden yeni uygulamalara verilebilecek tahmini miktar. **Bakman gereken sütun budur** |

Kaynak `/proc/meminfo`:

```terminal
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|Shmem)' /proc/meminfo
```

### En çok bellek kullanan süreçler

```text
ps -eo pid,user,rss,args --sort=-rss | head
```

BusyBox `ps` sıralamayı desteklemiyor, ama `sort` ile aynı şeyi yaparız:

```terminal
ps -o rss,pid,args | sort -rn | head -5
```

### OOM killer

Bellek ve swap tamamen bittiğinde çekirdek bir "kurban" seçip `SIGKILL` ile öldürür. Seçim büyük ölçüde bellek kullanımına göre yapılır ve süreç başına ayarlanabilir (`/proc/PID/oom_score_adj`, -1000 ile 1000 arası).

```terminal
cat /proc/$$/oom_score
cat /proc/$$/oom_score_adj
```

Bir servis "sebepsiz yere" ölüyor ve logunda hiçbir şey yoksa ilk kontrol:

```text
dmesg -T | grep -i -E 'killed process|out of memory'
journalctl -k | grep -i oom
```

Konteynerlerde sınırı aşan süreç, makinede boş bellek olsa bile cgroup'un kendi OOM'u tarafından öldürülür. Çıkış kodu 137 olur (akışlar dersindeki 128+9).

## Disk alanı: df, du ve kayıp gigabaytlar

```terminal
df -h
```

İki ayrı şeyin dolabileceğini unutma:

```text
df -h    # bayt
df -i    # inode: dosya sayısı sınırı
```

`df -i` %100 iken diskte yer olsa bile yeni dosya oluşturulamaz. Sebep genelde milyonlarca küçük dosyadır: oturum dosyaları, mail kuyruğu, temizlenmeyen önbellek.

Yer kaplayan klasörü bulmak için `du`. Kökten başlayıp en büyüğe doğru in:

```terminal
du -sh /usr/* 2>/dev/null | sort -rh | head -5
```

Gerçek sunucuda `du -xh --max-depth=1 / | sort -rh | head` ile başlarsın (`-x` başka dosya sistemlerine geçme), sonra en büyük klasöre girip tekrarlarsın. `ncdu` varsa daha rahat.

### df dolu, du boş: silinmiş ama açık dosyalar

Klasik bir olay: biri dolan diski boşaltmak için 20 GB'lık log dosyasını `rm` ile siler ama `df` hiç değişmez. Sebep, uygulamanın dosyayı hâlâ açık tutmasıdır. Linux'ta `rm` sadece **adı** siler. Veri, son fd kapanana kadar diskte kalır.

Bunu canlandıralım. Bir süreç dosyayı açık tutsun, biz silelim:

```terminal
cd /tmp
dd if=/dev/zero of=buyuk.log bs=1M count=20 2>/dev/null
df -h /tmp
sh -c 'exec 3< /tmp/buyuk.log; sleep 600' &
TUTAN=$!
rm buyuk.log
ls /tmp
df -h /tmp
```

Dosya listede yok ama `df` 20 MB'ı hâlâ dolu gösteriyor. Hangi sürecin tuttuğunu bulalım:

```terminal
ls -l /proc/*/fd/* 2>/dev/null | grep deleted
```

Gerçek sunucuda kısa yolu `lsof +L1` ya da `lsof | grep deleted`. Çözüm iki türlü:

- Süreci yeniden başlat (fd kapanır, alan boşalır).
- Yeniden başlatamıyorsan dosyayı fd üzerinden sıfırla: `: > /proc/PID/fd/N`

```terminal
kill $TUTAN
sleep 1
df -h /tmp
cd ~
```

> Doğru alışkanlık: Açık bir log dosyasını silmek yerine **sıfırla**: `: > /var/log/app.log` ya da `truncate -s 0`. Kalıcı çözüm logrotate (servisler ve loglar bölümü).

## Disk G/Ç: iostat

Alan değil hız sorunu varsa (`wa` yüksek, `D` süreçler var) gerçek sunucuda:

```text
iostat -xz 1
```

```text
Device   r/s   w/s  rkB/s  wkB/s  r_await w_await aqu-sz  %util
nvme0n1  12.0 850.0  96.0 41200.0   0.40   18.50   15.7   98.0
```

- `r_await`/`w_await`: Bir isteğin ortalama bekleme süresi (ms). SSD'de birkaç ms'nin üstü sorun işaretidir.
- `aqu-sz`: Kuyruk uzunluğu.
- `%util`: Cihazın meşgul olduğu zaman oranı. Tek diskte %100 doygunluk demektir. NVMe/RAID gibi paralel cihazlarda tek başına yanıltıcı olabilir, `await`'e bak.

Hangi sürecin G/Ç yaptığını bulmak için `iotop -o` ya da `pidstat -d 1`.

Bu araçlar `sysstat` paketindedir ve minimal kurulumlarda yoktur. Olay anında kurmaya çalışmak yerine sunucu hazırlığında kur.

## Hepsi bir arada: ilk 60 saniye

Bir sunucuya "yavaş" şikâyetiyle bağlandığında sırasıyla:

```text
uptime                      # load ve eğilim
dmesg -T | tail             # OOM, disk hataları, çekirdek uyarıları
vmstat 1 5                  # r, b, si/so, us/sy/wa/st
free -h                     # available ve swap
df -h; df -i                # alan ve inode
iostat -xz 1 3              # disk gecikmesi
top / htop                  # sorumlu süreç
ss -s; ss -tanp | head      # bağlantı sayıları (ağ dersi)
journalctl -p err -S -1h    # son bir saatin hataları
```

Bu listeyi Sorun giderme bölümünde senaryolar üzerinden tekrar ele alacağız.

## Alıştırma

1. Bu Linux'ta kaç CPU var ve şu anki 1 dakikalık load, CPU sayısına oranla ne durumda?
2. `MemAvailable` değerini MB cinsinden yazdıran tek satırlık bir komut yaz.
3. `/tmp` altında 5 MB'lık bir dosya oluştur, arka planda açık tut, sil ve `/proc` üzerinden bul. Sonra **süreci öldürmeden** alanı geri kazan.

<details><summary>Cevaplar</summary>

```terminal
echo "cpu: $(nproc), load1: $(cut -d' ' -f1 /proc/loadavg)"
awk '/^MemAvailable/ {printf "%d MB\n", $2/1024}' /proc/meminfo
dd if=/dev/zero of=/tmp/x.log bs=1M count=5 2>/dev/null
sh -c 'exec 3< /tmp/x.log; sleep 600' &
rm /tmp/x.log
ls -l /proc/*/fd/* 2>/dev/null | grep 'x.log (deleted)'
```

Son komutun çıktısında `/proc/PID/fd/3` yolunu göreceksin. O yolu kullanarak dosyayı sıfırla (PID'i kendi çıktındakiyle değiştir), sonra `df -h /tmp` ile kontrol et:

```text
: > /proc/PID/fd/3
```

</details>

```quiz
`free` çıktısında `free: 150M`, `available: 5.2G` görüyorsun. Durum nedir?
- Bellek bitmek üzere, acil müdahale gerekli
- [x] Normal. Linux boş belleği önbellek olarak kullanıyor, uygulamalar için 5.2G hazır
- Swap kapalı olduğu için sorun var
? Bakılması gereken `available`. Düşük `free` sağlıklı bir sistemin işaretidir.
```

```quiz
8 çekirdekli bir sunucuda load 9 ama `top` CPU'yu %85 boşta (`id`) gösteriyor ve `wa` yüksek. Sebep büyük ihtimalle nedir?
- CPU yetersiz
- [x] Disk G/Ç bekleyen (`D` durumunda) süreçler load'u şişiriyor
- Ağ sorunu
? Linux'ta load average `D` durumundaki süreçleri de sayar. Boş CPU ve yüksek `wa` disk darboğazını gösterir.
```

```quiz
50 GB'lık log dosyasını sildin ama `df` hâlâ disk dolu diyor. İlk ne yaparsın?
- `fsck` çalıştırırım
- [x] `lsof +L1` ile dosyayı hâlâ açık tutan süreci bulurum
- Sunucuyu yeniden başlatırım
? Veri, son açık fd kapanana kadar diskte kalır. Süreci yeniden başlatmak ya da `/proc/PID/fd/N` üzerinden sıfırlamak alanı geri verir.
```

```quiz
Bulutta bir VM'de `top` sürekli `st` değerini %20 gösteriyor. Bu ne demek?
- Uygulama çok sistem çağrısı yapıyor
- [x] Hipervizör CPU zamanını başka VM'lere veriyor (ya da burst kredisi bitti)
- Swap kullanımı yüksek
? Steal time sunucunun kontrolü dışındadır. Çözüm instance tipini değiştirmektir.
```

## Özet

| Kaynak | Araç | Bakılacak |
|---|---|---|
| Genel yük | `uptime` | Load / `nproc`, eğilim |
| CPU | `top`, `vmstat 1` | `us`, `sy`, `wa`, `st`, `r` |
| Bellek | `free -h`, `/proc/meminfo` | `available`, `si`/`so`, `dmesg`'te OOM |
| Disk alanı | `df -h`, `df -i`, `du` | Bayt ve inode, silinmiş açık dosyalar |
| Disk G/Ç | `iostat -xz 1`, `iotop` | `await`, `%util`, `D` süreçler |
