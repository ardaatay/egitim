# cron ve systemd timer

Yedekler, rapor üretimi, önbellek temizliği, sertifika yenileme... Her sunucuda zamanlanmış işler vardır ve bunlar sessizce bozulmayı en iyi bilen işlerdir. Bu derste cron'un tuzaklarını, örtüşen çalışmaları ve aynı işi daha izlenebilir yapan systemd timer'ları göreceğiz.

## crontab biçimi

```text
┌───────── dakika (0-59)
│ ┌─────── saat (0-23)
│ │ ┌───── ayın günü (1-31)
│ │ │ ┌─── ay (1-12)
│ │ │ │ ┌─ haftanın günü (0-7, 0 ve 7 = pazar)
│ │ │ │ │
30 3 * * *   /usr/local/bin/yedek.sh
```

| İfade | Anlamı |
|---|---|
| `*/5 * * * *` | 5 dakikada bir |
| `0 */2 * * *` | 2 saatte bir, saat başında |
| `0 9-18 * * 1-5` | Hafta içi 09:00-18:00 arası her saat başı |
| `15 2 1 * *` | Her ayın 1'i, 02:15 |
| `@reboot` | Açılışta bir kez |
| `@daily` | `0 0 * * *` ile aynı |

> Ayın günü ve haftanın günü **birlikte** verilirse cron ikisinden **biri** tuttuğunda çalıştırır (VE değil VEYA). `0 3 1 * 1` "ayın 1'i pazartesiye denk gelirse" değil, "her ayın 1'i ve her pazartesi" demektir.

İfadeleri doğrulamak için crontab.guru gibi araçlar ya da timer'lar için aşağıda göreceğimiz `systemd-analyze calendar` kullanılabilir.

### Nereye yazılır?

| Yer | Biçim | Kullanım |
|---|---|---|
| `crontab -e` | 5 alan + komut | Kullanıcının kendi işleri. `/var/spool/cron/crontabs/` altında saklanır |
| `/etc/cron.d/dosya` | 5 alan + **kullanıcı** + komut | Sistem işleri. Sürüm kontrolüne ve Ansible'a uygun |
| `/etc/cron.daily/` vb. | Çalıştırılabilir betikler | `run-parts` ile çalışır. Dosya adında nokta olmamalı (`yedek.sh` çalışmaz, `yedek` çalışır) |

## Tarayıcıda cron

Tarayıcıdaki Linux'ta BusyBox `crond` var. Önce cron'un işleri hangi **ortamda** çalıştırdığını görelim. Bu, cron sorunlarının bir numaralı kaynağıdır.

Gerçek bir sunucuda `crond` açılışta systemd tarafından neredeyse boş bir ortamla başlatılır. Burada aynısını `env -i` (boş ortamla çalıştır) ile taklit ediyoruz:

```terminal
mkdir -p /var/spool/cron/crontabs
echo '* * * * * env > /tmp/cron-env.txt' | crontab -
crontab -l
env -i $(command -v crond) -b
echo "Bir dakika içinde /tmp/cron-env.txt oluşacak. Bu arada okumaya devam et."
```

Dakika dolunca karşılaştır:

```terminal
cat /tmp/cron-env.txt
echo "---- etkileşimli kabuk ----"
env | sort | head -20
```

Cron'un ortamı neredeyse boştur. Burada `PATH` bile yok. Debian/Ubuntu'daki cron en azından `PATH=/usr/bin:/bin` tanımlar, ama `/usr/local/bin` ve `/usr/sbin` yine yoktur. Senin kabuğunda tanımladığın değişkenler de yok, `.bashrc` ya da `.profile` okunmamış. "Elle çalıştırınca çalışıyor, cron'da çalışmıyor" şikâyetinin cevabı budur.

### Cron'un altı tuzağı

1. **PATH**: Komutlarda tam yol kullan ya da crontab'ın başına `PATH=/usr/local/bin:/usr/bin:/bin` yaz.
2. **Ortam değişkenleri**: Betik bir `.env` dosyasına ihtiyaç duyuyorsa onu kendisi yüklemeli.
3. **`%` karakteri**: crontab satırında `%` yeni satır anlamına gelir. `date +%F` yazacaksan `date +\%F` yaz.
4. **Çıktı**: Çıktı yönlendirilmezse e-posta ile gönderilmeye çalışılır (`MAILTO`). Mail sunucusu yoksa kaybolur. Hep yönlendir, hataları da kaydet:

   ```text
   30 3 * * * /usr/local/bin/yedek.sh >> /var/log/yedek.log 2>&1
   30 3 * * * /usr/local/bin/yedek.sh 2>&1 | logger -t yedek
   ```

5. **Saat dilimi**: cron sunucunun saat diliminde çalışır. Yaz saati geçişlerinde 02:30'daki iş bir gün hiç çalışmayabilir ya da iki kez çalışabilir. Kritik işleri 01:00-03:00 aralığına koyma.
6. **Örtüşme**: 5 dakikada bir çalışan iş bir gün 7 dakika sürerse, ikinci kopya ilki bitmeden başlar. Aşağıda.

## Örtüşmeyi önlemek: flock

`flock`, bir kilit dosyası üzerinde çekirdek seviyesinde kilit alır. Süreç ölünce kilit kendiliğinden bırakılır, bu yüzden "kilit dosyası kaldı" sorunu yaşanmaz.

Tarayıcıda görelim. 10 saniye süren bir iş başlatalım, ilki çalışırken ikincisini deneyelim:

```terminal
cat > /tmp/uzun-is.sh <<'EOF'
#!/bin/sh
echo "$(date +%T) başladı (PID $$)"
sleep 10
echo "$(date +%T) bitti (PID $$)"
EOF
chmod +x /tmp/uzun-is.sh
flock -n /tmp/uzun-is.lock /tmp/uzun-is.sh &
sleep 1
flock -n /tmp/uzun-is.lock /tmp/uzun-is.sh || echo "$(date +%T) zaten çalışıyor, atlandı (çıkış kodu $?)"
```

`-n` kilit alınamazsa beklemeden çıkar. Cron satırı şöyle olur:

```text
*/5 * * * * flock -n /run/lock/rapor.lock /usr/local/bin/rapor.sh >> /var/log/rapor.log 2>&1
```

Bekleyip sırayla çalışması istenirse `-n` yerine `-w 60` (en fazla 60 sn bekle).

Deneme işini temizle:

```terminal
crontab -r
killall crond
```

## systemd timer

Timer'lar aynı işi bir `.service` + bir `.timer` birimiyle yapar. İki dosya fazla görünebilir, ama cron'un tuzaklarının çoğunu ortadan kaldırırlar:

| | cron | systemd timer |
|---|---|---|
| Loglar | Kendin yönlendirirsin | Otomatik journal'da (`journalctl -u`) |
| Son çalışma ve sonucu | Bilinmez | `systemctl status`, `list-timers` |
| Örtüşme | `flock` gerekir | Servis zaten çalışıyorsa yeni çalışma başlatılmaz |
| Sunucu kapalıyken kaçan iş | Kaçar | `Persistent=true` ile açılışta telafi edilir |
| Kaynak sınırı, kullanıcı, sıkılaştırma | Yok | systemd dersindeki her şey |
| Rastgele gecikme (sürü etkisini önleme) | Yok | `RandomizedDelaySec=` |
| Elle tetikleme | Komutu kopyala yapıştır | `systemctl start yedek.service` (aynı ortam) |

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Aşağıdaki timer'ı gerçek bir systemd'de kur.
```

### Örnek: gece yedeği

Önce işi yapan servis. `Type=oneshot`: çalışır, biter. Sürekli çalışan bir süreç değil:

```bash
mkdir -p /srv/data /var/backups/data
echo "önemli veri" > /srv/data/kayit.txt

cat > /usr/local/bin/yedek.sh <<'EOF'
#!/bin/bash
set -euo pipefail
hedef="/var/backups/data/data-$(date +%Y%m%d-%H%M%S).tar.gz"
tar czf "$hedef" -C /srv data
find /var/backups/data -name 'data-*.tar.gz' -mtime +7 -delete
echo "yedek alındı: $hedef ($(du -h "$hedef" | cut -f1))"
EOF
chmod +x /usr/local/bin/yedek.sh

cat > /etc/systemd/system/yedek.service <<'EOF'
[Unit]
Description=Gece veri yedeği

[Service]
Type=oneshot
ExecStart=/usr/local/bin/yedek.sh
Nice=19
IOSchedulingClass=idle
EOF
```

Sonra timer:

```bash
cat > /etc/systemd/system/yedek.timer <<'EOF'
[Unit]
Description=Gece veri yedeği zamanlayıcısı

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now yedek.timer
systemctl list-timers yedek.timer
```

Dikkat: **timer'ı enable edersin, servisi değil.** Servisin `[Install]` bölümü yok, çünkü onu timer başlatır.

- `OnCalendar=`: takvim ifadesi. `daily`, `hourly`, `Mon..Fri 09:00`, `*-*-01 02:15` gibi.
- `Persistent=true`: Sunucu 03:30'da kapalıysa, açılınca kaçırılan çalışmayı hemen yapar.
- `RandomizedDelaySec=`: 100 sunucunun aynı anda yedek almaya başlayıp depolamayı ezmesini önler.
- `Nice=19` ve `IOSchedulingClass=idle`: yedek, üretim trafiğinin önüne geçmez.

Takvim ifadesini doğrula, bir sonraki çalışma zamanlarını gör:

```bash
systemd-analyze calendar --iterations=3 "*-*-* 03:30:00"
systemd-analyze calendar --iterations=3 "Mon..Fri *-*-* 09..18:00:00"
```

İşi beklemeden elle tetikle ve sonucuna bak:

```bash
systemctl start yedek.service
systemctl status yedek.service --no-pager
journalctl -u yedek.service -n 5 --no-pager
ls -lh /var/backups/data/
```

Elle tetiklemek, işi **zamanlanmış çalışmayla tamamen aynı ortamda** çalıştırır. cron'daki "elle çalışıyor, cron'da çalışmıyor" problemi burada yoktur.

### Monoton zamanlayıcılar

Takvim yerine "şu olaydan bu kadar sonra":

```ini
[Timer]
OnBootSec=5min            # açılıştan 5 dk sonra
OnUnitActiveSec=15min     # son çalışmadan 15 dk sonra tekrar
```

"Her 15 dakikada bir, ama bir önceki çalışma bittikten sonra say" davranışı için idealdir.

### Başarısızlıktan haberdar olmak

Bir yedeğin 3 hafta boyunca sessizce başarısız olduğunu fark etmek, yedeğe ihtiyacın olduğu güne denk gelir. İki yaklaşım:

1. Servise `OnFailure=yedek-alarm.service` ekle. Bu ikinci servis bir webhook'a (Slack, e-posta, PagerDuty) istek atar.
2. Daha sağlamı **"ölü adam" izleme**: İş başarıyla bitince bir izleme servisine (Healthchecks.io, Uptime Kuma, Cronitor) ping atar. Ping belirli sürede gelmezse alarm çalar. Böylece işin hiç çalışmadığı durum da yakalanır.

```bash
# yedek.sh'ın son satırı olarak:
curl -fsS -m 10 --retry 3 https://hc-ping.com/<senin-uuid> > /dev/null
```

`set -euo pipefail` sayesinde betik hata verirse bu satıra hiç ulaşılmaz ve ping gitmez.

## Hangisini seçmeli?

- Yeni işler için: **systemd timer.** Loglar, durum, örtüşme koruması ve kaynak sınırları bedavaya gelir.
- Kullanıcı seviyesinde basit işler ya da systemd olmayan ortamlar (bazı konteynerler, Alpine) için: **cron + flock + log yönlendirme.**
- Kubernetes'te ikisi de değil: **CronJob** nesnesi. Orada da `concurrencyPolicy: Forbid` ile örtüşme yönetilir. Bunu Kubernetes kursunda göreceğiz.

## Alıştırma

Tarayıcıda:

1. Her dakika `/tmp/disk.log` dosyasına tarih ve `/tmp`'nin doluluk yüzdesini yazan bir cron işi kur. Satırda `date +%F` kullanmayı unutma, `%` karakterine dikkat. Bir iki dakika bekleyip dosyayı kontrol et, sonra işi kaldır.

Lab'da:

2. `yedek.timer`'ı 2 dakikada bir çalışacak şekilde değiştir, `list-timers` ile bir sonraki çalışmayı doğrula ve iki çalışmanın journal kayıtlarını gör.

<details><summary>Çözüm</summary>

```terminal
mkdir -p /var/spool/cron/crontabs
echo '* * * * * echo "$(date +\%F_\%T) $(df /tmp | awk '"'"'NR==2 {print $5}'"'"')" >> /tmp/disk.log' | crontab -
crontab -l
env -i $(command -v crond) -b
```

Bir iki dakika sonra:

```terminal
cat /tmp/disk.log
crontab -r
killall crond
```

Tek tırnak içinde tek tırnak kullanmak gerektiği için `'"'"'` kalıbı kullanıldı. Bu tür karmaşık satırları bir betik dosyasına koyup cron'dan sadece betiği çağırmak her zaman daha okunurdur.

```bash
systemctl edit yedek.timer
```

```ini
[Timer]
OnCalendar=
OnCalendar=*:0/2
RandomizedDelaySec=0
```

```bash
systemctl daemon-reload
systemctl restart yedek.timer
systemctl list-timers yedek.timer
sleep 250
journalctl -u yedek.service --no-pager | tail
```

</details>

```quiz
Betik elle çalıştırınca sorunsuz, cron'dan çalışınca "command not found" veriyor. En olası sebep?
- Cron devre dışı
- [x] Cron'un PATH'i kısa ve kabuk ayar dosyaları okunmuyor
- Betikte yazım hatası var
? Tam yollar kullan ya da crontab'ın başına PATH tanımla.
```

```quiz
`*/5 * * * *` ile çalışan bir iş bazen 8 dakika sürüyor. Aynı anda iki kopya çalışmasını nasıl önlersin?
- Çalışma aralığını 10 dakikaya çıkarırım
- [x] `flock -n /run/lock/is.lock komut` ile sararım (ya da systemd timer'a geçerim)
- `nice` ile önceliğini düşürürüm
? Aralığı artırmak sorunu sadece erteler. `flock` kilit alamazsa çıkar, timer ise servis zaten çalışıyorsa yenisini başlatmaz.
```

```quiz
Sunucu 03:30'da bakımdaydı ve gece yedeği kaçtı. Timer'da bunu telafi eden ayar?
- `RandomizedDelaySec=`
- [x] `Persistent=true`
- `OnBootSec=`
? `Persistent=true` son çalışma zamanını diske yazar ve açılışta kaçırılan çalışmayı hemen yapar.
```

## Özet

- cron: tam yollar, çıktıyı yönlendir, `%` için kaçış, örtüşmeye karşı `flock -n`.
- Timer = `.service` (`Type=oneshot`) + `.timer`. Timer'ı enable et.
- `Persistent=true`, `RandomizedDelaySec=`, `systemd-analyze calendar`.
- Elle tetikleme: `systemctl start is.service`, loglar `journalctl -u`.
- Sessiz başarısızlığa karşı: `OnFailure=` ya da başarı ping'i ile ölü adam izleme.
