# Teşhis akışı: ilk 60 saniye

Bu derste kursta öğrendiğin araçları bir **yönteme** bağlıyoruz. Olay anında en büyük hata, ilk akla gelen teoriye atlayıp onu doğrulamaya çalışmaktır ("kesin veritabanı"). Doğrusu, belirtilerden geniş bir tarama ile başlayıp her adımda olasılıkları daraltmaktır.

Dersin ikinci yarısında tarayıcıdaki Linux'ta **arıza üreten bir betik** çalıştıracağız. Hangi arızayı ürettiği sana söylenmeyecek ve sen onu bu derste öğrendiğin akışla bulacaksın.

## Yöntem: USE

Brendan Gregg'in **USE** yöntemi her kaynak için üç soru sorar:

| | Soru | Örnek |
|---|---|---|
| **U**tilization | Ne kadar meşgul? | CPU %90, disk `%util` 100 |
| **S**aturation | Kuyrukta bekleyen iş var mı? | load > CPU sayısı, `vmstat r`, swap kullanımı, disk `aqu-sz` |
| **E**rrors | Hata var mı? | `dmesg`'te disk/OOM hataları, ağ arabirimi hataları, uygulama 5xx |

Kaynaklar: CPU, bellek, disk G/Ç, disk alanı, ağ, ve yazılım kaynakları (dosya tanımlayıcıları, bağlantı havuzu, worker sayısı). Her kaynak için U-S-E'ye bakmak, hiçbir şeyi atlamadan hızlıca tarama yapmanı sağlar.

## İlk 60 saniye

Bir sunucuya "sorun var" çağrısıyla bağlandığında, teori kurmadan önce sırayla:

```bash
uptime                           # 1. load ve eğilim (artıyor mu, geçiyor mu?)
dmesg -T | tail -20              # 2. çekirdek: OOM, disk hatası, segfault
journalctl -p err -S -30min      # 3. son yarım saatin hataları, tüm servisler
systemctl --failed               # 4. çökmüş servis var mı?
vmstat 1 5                       # 5. r, b, si/so, us/sy/wa/st
free -h                          # 6. available, swap
df -h; df -i                     # 7. alan ve inode
iostat -xz 1 3                   # 8. disk gecikmesi ve doluluk
ss -s; ss -tanp state established | head   # 9. bağlantı sayıları
top -o %CPU  (ya da htop)        # 10. sorumlu süreç
```

Bu 10 adımın amacı sorunu çözmek değil, **hangi kaynağa** odaklanacağına karar vermek.

Bir de **zaman** sorusu var: Sorun ne zaman başladı ve o anda ne değişti? Deploy, ayar değişikliği, trafik artışı, bir cron işi, sertifika yenilemesi... Log analizi dersindeki zaman ekseni çıkarma (`awk '{print substr($4,14,5)}' | uniq -c`) ile deploy geçmişini yan yana koymak, olayların büyük kısmını çözer.

## Senaryolar

### "Site yavaş"

```text
1. Yavaş olan her şey mi, belirli bir uç nokta mı?
   -> nginx access log: $request_time / $upstream_response_time, endpoint bazında p95 (log analizi dersi)
2. Yavaşlık uygulamada mı, önündeki katmanda mı?
   -> request_time ≈ upstream_response_time  => uygulama yavaş
   -> request_time >> upstream_response_time => istemci/ağ yavaş ya da nginx kuyruğu
3. Uygulama yavaşsa: kaynak mı bekliyor, CPU mu harcıyor?
   -> top: süreç %100 CPU => CPU'ya bağımlı (döngü, regex, serileştirme)
   -> CPU düşük, yanıt yavaş => bir şey bekliyor: veritabanı, dış API, kilit, DNS
4. Bekliyorsa ne bekliyor?
   -> uygulama logları, yavaş sorgu logu, ss ile dış bağlantılar, strace (sonraki ders)
```

Sık görülen kök sebepler: tek bir yavaş sorgu (eksik indeks), tükenen veritabanı bağlantı havuzu, dış servise zaman aşımı olmadan yapılan çağrı, `st` (steal) yüksek bir VM, swap'a düşmüş bellek.

### "502 / 504 Bad Gateway"

```text
502 -> nginx error log: "connect() failed (111: Connection refused)"
       -> systemctl status app; ss -tlnp | grep 8000  => uygulama dinliyor mu?
       -> journalctl -u app -n 50                     => çöktü mü, neden? (OOM => dmesg)
502 -> "upstream prematurely closed connection"
       -> uygulama yanıt verirken öldü: worker timeout, OOM, segfault
504 -> "upstream timed out (110)"
       -> uygulama cevap veremeyecek kadar yavaş ya da bütün worker'lar meşgul
       -> gunicorn WORKER TIMEOUT, worker sayısı, yavaş uç noktalar
```

### "Disk doldu"

```text
df -h            -> hangi dosya sistemi?
df -i            -> bayt mı, inode mu?
du -xh --max-depth=1 /var | sort -rh | head   -> hangi klasör?
lsof +L1         -> silinmiş ama açık dosyalar (df dolu, du boş)
journalctl --disk-usage ; ls -lh /var/log/*.gz | tail
```

Önce yer aç (sıfırla, sıkıştır, `--vacuum`), servisleri kontrol et (`systemctl --failed`), sonra kök sebep: döndürülmeyen log, debug seviyesinde unutulmuş loglama, temizlenmeyen release'ler, Docker imajları (`docker system df`).

### "Servis açılmıyor"

```text
systemctl status app -l --no-pager    -> çıkış kodu (203/EXEC, 217/USER, ...)
journalctl -u app -b -n 50            -> uygulamanın kendi hatası
systemctl cat app                     -> gerçekte uygulanan birim
sudo -u app <ExecStart satırı>        -> aynı kullanıcıyla elle çalıştır
ss -tlnp | grep :8000                 -> "Address already in use" ise portu kim tutuyor?
```

### "Sunucu kendiliğinden yeniden başladı"

```text
last -x | head                        -> reboot/shutdown kayıtları
journalctl --list-boots
journalctl -b -1 -n 100               -> önceki açılışın son satırları
journalctl -b -1 -k | grep -i -E 'panic|oom|watchdog|mce|thermal'
```

Son satırlarda düzenli bir kapanış (`Stopping ...`, `Reached target Shutdown`) varsa biri ya da bir şey (otomatik güncelleme, `unattended-upgrades` + `Automatic-Reboot`) yeniden başlattı. Hiçbir iz yoksa ani güç kesintisi, çekirdek paniği ya da hipervizör kaynaklıdır.

## Değişiklik yapmadan önce

Olay anında yapılan her şey yeni bir değişkendir:

- **Önce kanıt topla, sonra müdahale et.** Servisi yeniden başlatmak sorunu geçici olarak çözer ama kanıtı (süreç durumu, bellek, açık bağlantılar) yok eder. Mümkünse yeniden başlatmadan önce `ps`, `ss`, `top -b -n 1`, ilgili `/proc/PID/` bilgilerini bir dosyaya kaydet.
- **Her adımı not al.** Saat, komut, sonuç. Olay sonrası değerlendirmenin (postmortem) ham maddesi bu notlardır.
- **Bir seferde tek değişiklik.** Üç şeyi aynı anda değiştirirsen hangisinin işe yaradığını bilemezsin.

Kanıt toplamak için hızlı bir anlık görüntü:

```bash
d=/tmp/olay-$(date +%H%M%S); mkdir -p $d
uptime > $d/uptime; free -m > $d/free; df -h > $d/df
ps auxww --sort=-%cpu > $d/ps; top -b -n 1 > $d/top
ss -tanp > $d/ss; dmesg -T | tail -200 > $d/dmesg
journalctl -S -1h --no-pager > $d/journal
echo "kanıtlar: $d"
```

## Uygulama: gizemli arızalar

Şimdi tarayıcıdaki Linux'ta bir **arıza üreteci** kuralım. Çalıştırdığında rastgele bir sorun yaratır ama ne olduğunu söylemez. Senin işin onu ilk 60 saniye akışıyla bulmak.

```terminal
cat > /usr/bin/ariza <<'EOF'
#!/bin/sh
# Rastgele bir arıza üretir. Kullanım: ariza [1-4]   (numara verilmezse rastgele)
n=${1:-$(( $(date +%s) % 4 + 1 ))}
echo "$n" > /root/.ariza
mkdir -p /var/lib/rapor /srv/app
case $n in
1) cat > /usr/bin/rapor-uret <<'X'
#!/bin/sh
while :; do :; done
X
   chmod +x /usr/bin/rapor-uret; (rapor-uret >/dev/null 2>&1 &) ;;
2) dd if=/dev/zero of=/tmp/.cache-blob bs=1M count=44 2>/dev/null ;;
3) dd if=/dev/zero of=/tmp/app-debug.log bs=1M count=30 2>/dev/null
   (sh -c 'exec 3>>/tmp/app-debug.log; rm /tmp/app-debug.log; while :; do sleep 60; done' &) ;;
4) dd if=/dev/zero of=/run/oturum-onbellek bs=1M count=40 2>/dev/null ;;
esac
echo "Bir şeyler ters gidiyor... Kullanıcılar sunucunun yavaşladığından ve hata aldığından şikâyetçi."
EOF
chmod +x /usr/bin/ariza
echo "hazır. 'ariza' yazarak başla."
```

Arızayı başlat:

```terminal
ariza
```

Şimdi teşhis et. Kullanabileceğin komutlar (tarayıcıdaki Linux'ta olanlar):

```terminal
uptime; echo; free; echo; df -h; echo; top -b -n 1 | head -12
```

Arıza bulunca çözümünü uygula ve doğrula. Ardından yeni bir arıza için önce ↻ düğmesiyle terminali sıfırla (ya da her şeyi temizlediğinden emin ol), sonra tekrar `ariza` yaz. Dört farklı arıza var, hepsini bulmaya çalış. Belirli bir arızayı denemek için `ariza 3` gibi numara da verebilirsin.

<details><summary>İpucu: belirtiler</summary>

- `top`'ta bir süreç CPU'nun tamamını kullanıyorsa → CPU senaryosu.
- `df -h` bir dosya sisteminin dolduğunu gösteriyorsa, `du` ile o dosya sisteminde ne olduğuna bak. `du` toplamı `df`'in söylediğiyle uyuşmuyorsa → silinmiş ama açık dosya.
- `free`'de `available` çok düştüyse ve `shared`/`buff/cache` yüksekse → tmpfs (RAM'de duran dosya sistemi) dolu olabilir. `df -h` ile `tmpfs` satırlarına bak.

</details>

<details><summary>Çözümler (önce kendin dene)</summary>

Hangi arızanın üretildiğini görmek için: `cat /root/.ariza`

**1. CPU'yu yiyen süreç.** `top -b -n 1 | head` en üstte `rapor-uret`'i %90+ CPU ile gösterir. Load average yükselir.

```terminal
top -b -n 1 | head -8
pidof rapor-uret
kill $(pidof rapor-uret)
sleep 1; top -b -n 1 | head -4
```

Gerçek hayatta öldürmeden önce sorulacaklar: Bu süreç ne? (`/proc/PID/cmdline`, `ls -l /proc/PID/exe`) Kim başlattı? (PPID, cron, systemd birimi) Durdurursam ne olur? Ve kalıcı çözüm: neden sonsuz döngüde?

**2. Disk (tmpfs) dolu.** `df -h /tmp` %85'in üstünde. `du` büyük, gizli bir dosya gösterir.

```terminal
df -h /tmp
du -ah /tmp 2>/dev/null | sort -rh | head -5
rm /tmp/.cache-blob
df -h /tmp
```

Gizli dosyaların (`.` ile başlayan) `ls` ve `du -sh /tmp/*` ile görünmediğine dikkat: `/tmp/*` deseni gizli dosyaları eşleştirmez (joker karakterler dersi). `du -ah` ya da `ls -la` kullan.

**3. Silinmiş ama açık log dosyası.** `df -h /tmp` 30 MB dolu gösterir, ama `du` ve `ls` hiçbir şey bulamaz.

```terminal
df -h /tmp
du -sh /tmp
ls -l /proc/*/fd/* 2>/dev/null | grep deleted
```

Çıktıdaki `/proc/PID/fd/3` yolunu kullanarak dosyayı süreci öldürmeden sıfırla ya da süreci yeniden başlat:

```text
: > /proc/PID/fd/3        (PID'i kendi çıktındakiyle değiştir)
```

**4. Belleği dolduran tmpfs.** `free`'de `available` belirgin şekilde düşük, `shared` yüksek. Sebep: `/run` gibi bir tmpfs'e yazılan dosyalar diske değil **RAM'e** yazılır ve bellekten düşer.

```terminal
free
df -h | grep tmpfs
ls -lh /run
rm /run/oturum-onbellek
free
```

Bu, gerçek sunucularda `/dev/shm`'i dolduran uygulamalarda ya da `/tmp`'nin tmpfs olduğu dağıtımlarda büyük geçici dosya yazan işlerde karşılaşılan, gözden kaçması kolay bir durumdur. `ps` hiçbir sürecin çok bellek kullanmadığını söyler, ama bellek yine de doludur.

</details>

```quiz
Sunucuya bağlandın, şikâyet "her şey yavaş". İlk ne yaparsın?
- Uygulamayı yeniden başlatırım
- Veritabanı loglarına bakarım
- [x] `uptime`, `dmesg`, `vmstat`, `free`, `df` ile geniş tarama yapıp hangi kaynağın sorunlu olduğunu belirlerim
? Teori kurmadan önce geniş tarama. Yeniden başlatmak kanıtı yok eder.
```

```quiz
nginx `$request_time` 8 sn, `$upstream_response_time` 0.2 sn gösteriyor. Sorun büyük ihtimalle nerede?
- Uygulamada
- Veritabanında
- [x] İstemci ile nginx arasında (yavaş istemci/ağ) ya da nginx tarafında
? Uygulama 0.2 sn'de cevap vermiş. Kalan süre istemcinin isteği göndermesi/yanıtı alması sırasında geçmiş.
```

```quiz
`ps` hiçbir sürecin çok bellek kullanmadığını gösteriyor ama `free` `available: 50M` diyor ve `shared` yüksek. Ne kontrol edersin?
- Swap ayarlarını
- [x] tmpfs dosya sistemlerini (`df -h | grep tmpfs`, `/dev/shm`, `/run`)
- CPU kullanımını
? tmpfs'teki dosyalar RAM'de durur ve hiçbir sürecin RSS'inde görünmez.
```

## Özet

- USE: her kaynak için kullanım, doygunluk, hata.
- İlk 60 saniye: `uptime`, `dmesg`, `journalctl -p err`, `systemctl --failed`, `vmstat`, `free`, `df`, `iostat`, `ss`, `top`.
- "Ne zaman başladı, o anda ne değişti?" sorusu.
- Müdahaleden önce kanıt topla, tek seferde tek değişiklik, her adımı not al.
