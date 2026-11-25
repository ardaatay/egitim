# logrotate ve dolan diskler

Journal kendi boyutunu yönetir, ama nginx'in `access.log`'u, bir Java uygulamasının `app.log`'u ya da elle yazılmış bir betiğin çıktısı öyle değil. Bunlar biri müdahale edene kadar büyür. "Disk %100" alarmlarının büyük kısmının sebebi döndürülmeyen bir log dosyasıdır. Bu derste rotasyonun **neden** düşündüğümüzden zor olduğunu, sonra da `logrotate`'in bunu nasıl çözdüğünü göreceğiz.

## Asıl problem: dosya adı değil, inode

Önceki derslerden hatırla: Bir süreç dosyayı açtığında elinde **dosya adı değil, bir fd** vardır ve o fd diskteki **inode**'a bağlıdır. Dosyayı yeniden adlandırmak inode'u değiştirmez.

Bunu tarayıcıdaki Linux'ta görelim. Aşağıdaki "uygulama" log dosyasını bir kez açıyor ve her saniye bir satır yazıyor:

```terminal
cd /tmp
rm -f app.log*
sh -c 'exec >> /tmp/app.log; while true; do date; sleep 1; done' &
UYG=$!
sleep 3
ls -li app.log*
```

Şimdi logrotate'in yapacağı gibi dosyayı taşıyalım, yeni ve boş bir `app.log` oluşturalım:

```terminal
mv app.log app.log.1
touch app.log
sleep 3
ls -li app.log*
```

Sonuca bak: uygulama **`app.log.1`'e yazmaya devam ediyor**, yeni `app.log` boş kalıyor. `ls -i` ile gösterilen inode numarası, uygulamanın dosyayı taşımadan önceki inode'u takip ettiğini kanıtlıyor. Bu durumda `app.log.1`'i sıkıştırıp silmek, önceki derste gördüğümüz "silindi ama yer açılmadı" durumunu üretir.

Bu problemin iki çözümü var.

### Çözüm 1: uygulamaya dosyayı yeniden açtırmak

Taşıdıktan sonra uygulamaya bir sinyal gönderilir ve uygulama log dosyasını **adıyla** yeniden açar. nginx bunu `SIGUSR1` ile yapar, pek çok servis `SIGHUP` ile. Bizim mini uygulamamız sinyal anlamıyor, bu yüzden aynı etkiyi yeniden başlatarak simüle edelim:

```terminal
kill $UYG
sh -c 'exec >> /tmp/app.log; while true; do date; sleep 1; done' &
UYG=$!
sleep 3
ls -li app.log*
```

Artık yeni satırlar `app.log`'a gidiyor ve `app.log.1` güvenle sıkıştırılabilir. logrotate'te bu yöntemin karşılığı `create` + `postrotate` bloğudur.

### Çözüm 2: kopyala ve kes (copytruncate)

Uygulama sinyalle dosya yeniden açmayı bilmiyorsa (birçok Java/Node uygulaması), dosya **taşınmaz**. İçeriği kopyalanır, sonra orijinal dosya sıfıra kesilir. Böylece uygulama aynı inode'a yazmaya devam eder:

```terminal
cp app.log app.log.2
: > app.log
sleep 2
ls -li app.log*
kill $UYG
cd ~
```

Bu yöntemin iki bedeli var:

- **Kopyalama ile kesme arasında yazılan satırlar kaybolur.** Yoğun loglarda birkaç satır gidebilir.
- Uygulama dosyayı `O_APPEND` olmadan açtıysa, kesmeden sonra eski konumdan yazmaya devam eder ve dosyanın başı sıfırlarla dolu bir "seyrek dosya" (sparse file) oluşur. Bizim örnekte `>>` kullandığımız için sorun yok.

Seçim kuralı basit: **Uygulama yeniden açmayı destekliyorsa `create` + sinyal, desteklemiyorsa `copytruncate`.** En iyisi ise uygulamanın stdout'a yazıp logları journald'ye bırakması.

## logrotate

`logrotate` sürekli çalışan bir servis değildir. Günde bir kez tetiklenir, ayarlara bakar, gerekeni döndürür ve çıkar. Modern dağıtımlarda tetikleyici `logrotate.timer`, eskilerde `/etc/cron.daily/logrotate`:

```bash
systemctl list-timers logrotate.timer
```

Ayarlar:

- `/etc/logrotate.conf`: genel varsayılanlar
- `/etc/logrotate.d/*`: uygulama başına dosyalar. Paketler kendi dosyalarını buraya koyar (`nginx`, `rsyslog`, `apt`...)
- `/var/lib/logrotate/status`: her dosyanın en son ne zaman döndürüldüğü

Ubuntu'daki nginx dosyası iyi bir örnektir. Lab'da `cat /etc/logrotate.d/nginx` ile bakabilirsin:

```text
/var/log/nginx/*.log {
        daily
        missingok
        rotate 14
        compress
        delaycompress
        notifempty
        create 0640 www-data adm
        sharedscripts
        prerotate
                if [ -d /etc/logrotate.d/httpd-prerotate ]; then \
                        run-parts /etc/logrotate.d/httpd-prerotate; \
                fi \
        endscript
        postrotate
                invoke-rc.d nginx rotate >/dev/null 2>&1
        endscript
}
```

### Yönergeler

| Yönerge | Anlamı |
|---|---|
| `daily` / `weekly` / `monthly` | Ne sıklıkla döndürülür |
| `maxsize 500M` | Süreyi beklemeden bu boyutu geçince de döndür (logrotate çalıştığı anda kontrol edilir) |
| `rotate 14` | Kaç eski dosya saklanır. Fazlası silinir |
| `compress` | Eski dosyaları gzip'le |
| `delaycompress` | En yeni eski dosyayı (`.1`) sıkıştırma, bir sonraki turda sıkıştır. Uygulama sinyalden sonra hâlâ birkaç satır yazıyorsa onlar kaybolmaz |
| `missingok` | Dosya yoksa hata verme |
| `notifempty` | Boşsa döndürme |
| `create 0640 www-data adm` | Taşıdıktan sonra bu izin ve sahiplikle yeni dosya oluştur |
| `copytruncate` | Taşıma yerine kopyala + kes (yukarıdaki Çözüm 2) |
| `postrotate ... endscript` | Döndürmeden sonra çalışacak komut (sinyal ya da `systemctl reload`) |
| `sharedscripts` | Desen birden çok dosyayla eşleşse de betiği **bir kez** çalıştır |
| `dateext` | `.1` yerine `-20261125` gibi tarih eki |
| `su www-data adm` | Klasör root dışında birine aitse rotasyonu bu kimlikle yap |

## Kendi uygulaman için bir kural

Lab'da deneyelim. Önce sürekli log yazan bir uygulama ve klasörü:

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
logrotate Ubuntu'da hazır gelir.
```

```bash
mkdir -p /var/log/odeme-api
for i in $(seq 1 20000); do echo "$(date -Is) INFO istek id=$i"; done > /var/log/odeme-api/app.log
ls -lh /var/log/odeme-api/
```

Kural dosyası. Uygulama sinyalle yeniden açmayı bilmiyor varsayalım:

```bash
cat > /etc/logrotate.d/odeme-api <<'EOF'
/var/log/odeme-api/*.log {
    daily
    maxsize 100M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    dateext
    dateformat -%Y%m%d-%H%M%S
}
EOF
```

**Her zaman önce kuru çalıştır.** `-d` hiçbir şeyi değiştirmeden ne yapacağını anlatır:

```bash
logrotate -d /etc/logrotate.d/odeme-api
```

Çıktıda "considering log", "log needs rotating" ya da "log does not need rotating" satırlarını görürsün. Dosya yeni olduğu için logrotate muhtemelen "henüz bir gün olmadı" diyecek. Zorla döndürelim:

```bash
logrotate -f -v /etc/logrotate.d/odeme-api
ls -lh /var/log/odeme-api/
```

`-f` bir kez daha çalıştırınca `delaycompress` yüzünden bir önceki dosyanın şimdi sıkıştırıldığını gör:

```bash
sleep 1; logrotate -f /etc/logrotate.d/odeme-api
ls -lh /var/log/odeme-api/
```

Sinyalle yeniden açan bir servis olsaydı `copytruncate` yerine şunu yazardık:

```text
    create 0640 odeme odeme
    sharedscripts
    postrotate
        systemctl kill -s HUP odeme-api.service >/dev/null 2>&1 || true
    endscript
```

`systemctl kill -s HUP`, sinyali servisin cgroup'undaki süreçlere gönderir. PID dosyası aramaya gerek kalmaz. Sadece ana sürece göndermek için `--kill-whom=main` eklenir.

## Sık görülen sorunlar

- **"Döndürülmedi"**: `logrotate -d` çıktısını oku. Genelde süre dolmamıştır (`/var/lib/logrotate/status`'a bak), dosya boştur (`notifempty`) ya da desen eşleşmemiştir.
- **"error: skipping ... because parent directory has insecure permissions"**: Klasör root dışında birine yazılabilir. Kural içine `su kullanici grup` ekle.
- **Disk yine doldu**: logrotate günde bir kez çalışır. Saatte 50 GB log yazan bir uygulamada `maxsize` tek başına yetmez, çünkü kontrol sadece logrotate çalıştığında yapılır. Ya logrotate'i daha sık tetikle (timer'ı saatlik yap) ya da asıl sorunu, yani log hacmini düzelt.
- **Döndürüldü ama yer açılmadı**: Uygulama hâlâ eski dosyaya yazıyor. `lsof +L1` ile kontrol et, `copytruncate` ya da doğru `postrotate` sinyali ekle.

## Acil durum: disk %100

Olay anında sırayla:

```bash
df -h; df -i
du -xh --max-depth=1 /var/log | sort -rh | head
lsof +L1 | head                         # silinmiş ama açık dosyalar
journalctl --disk-usage
```

Yer açmanın güvenli yolları:

```bash
: > /var/log/odeme-api/app.log          # açık dosyayı silmek yerine sıfırla
gzip /var/log/odeme-api/app.log-2026*   # eski, döndürülmüş dosyaları sıkıştır
journalctl --vacuum-size=500M
apt-get clean
```

> **Dikkat:** Dolu bir disk kendi başına başka sorunlar da doğurur: veritabanları yazamaz ve salt okunur moda geçer, uygulamalar oturum dosyası açamaz. Yer açtıktan sonra servislerin durumunu kontrol et (`systemctl --failed`). Kök sebep giderilmediyse disk birkaç saat içinde yine dolar.

## Alıştırma

Tarayıcıdaki Linux'ta:

1. Yukarıdaki mini uygulamayı yeniden başlat. `copytruncate` yöntemini kullanarak `app.log`'u `app.log.1` olarak döndür ve `gzip` ile sıkıştır. Uygulamanın yeni satırları hâlâ `app.log`'a yazdığını doğrula.

Lab'da:

2. `/etc/logrotate.d/odeme-api` kuralını `rotate 3` yap. `logrotate -f`'i beş kez çalıştır ve klasörde en fazla kaç eski dosya kaldığını gözlemle.

<details><summary>Çözüm</summary>

```terminal
cd /tmp
rm -f app.log*
sh -c 'exec >> /tmp/app.log; while true; do date; sleep 1; done' &
UYG=$!
sleep 3
cp app.log app.log.1 && : > app.log
gzip app.log.1
sleep 2
ls -li app.log*
cat app.log
kill $UYG
cd ~
```

```bash
sed -i 's/rotate 7/rotate 3/' /etc/logrotate.d/odeme-api
for i in 1 2 3 4 5; do echo "satır $i" >> /var/log/odeme-api/app.log; sleep 1; logrotate -f /etc/logrotate.d/odeme-api; done
ls -l /var/log/odeme-api/
```

Klasörde `app.log` ve en fazla 3 eski dosya kalır.

</details>

```quiz
`mv app.log app.log.1` yaptıktan sonra uygulama neden hâlâ `app.log.1`'e yazıyor?
- mv komutu dosyayı kopyalamıştır
- [x] Uygulamanın fd'si aynı inode'u gösteriyor, yeniden adlandırma inode'u değiştirmez
- Dosya sistemi önbelleği güncellenmemiştir
? Çözüm: uygulamaya dosyayı yeniden açtırmak (sinyal) ya da `copytruncate`.
```

```quiz
`copytruncate` kullanmanın riski nedir?
- Dosya izinleri bozulur
- [x] Kopyalama ile kesme arasında yazılan satırlar kaybolabilir
- Uygulama yeniden başlatılır
? Kopyalama ile kesme arasındaki kısa aralıkta yazılanlar kaybolur. Uygulama destekliyorsa `create` + sinyal tercih edilir.
```

```quiz
Bir kuralın gerçekte ne yapacağını, hiçbir şeyi değiştirmeden görmek için?
- `logrotate -f`
- [x] `logrotate -d`
- `logrotate -v`
? `-d` (debug) kuru çalıştırmadır. `-f` zorlar, `-v` ayrıntılı çıktı verir ama işlemi yapar.
```

## Özet

- Süreçler dosyayı adıyla değil inode'uyla tutar. Rotasyonun bütün zorluğu bu.
- `create` + `postrotate` sinyali: kayıpsız, uygulama desteği gerekir.
- `copytruncate`: her uygulamada çalışır, birkaç satır kaybedebilir.
- Önce `logrotate -d`, sonra `-f -v`.
- Dolu diskte silme değil sıfırlama (`: > dosya`). Kök sebebi bul.
