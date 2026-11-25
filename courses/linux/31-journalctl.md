# journalctl ile log takibi

systemd'li bir sunucuda servislerin stdout ve stderr çıktıları, çekirdek mesajları ve syslog kayıtları tek bir yerde toplanır: **journal**. Uygulamanın kendi log dosyası yazmasına gerek kalmaz. Ekrana (stdout) yazması yeterlidir, gerisini `systemd-journald` halleder.

Bu dersteki komutlar için lab:

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Önceki dersteki odeme-api servisini kurduysan aynı ortamda devam edebilirsin. Kurmadıysan aşağıdaki "Hazırlık" bloğu yeterli.
```

## Hazırlık

Log üreten küçük bir servis kuralım. Her 2 saniyede bir satır yazıyor, arada bir de hata ve uyarı basıyor:

```bash
cat > /usr/local/bin/log-uret.sh <<'EOF'
#!/bin/bash
i=0
while true; do
  i=$((i+1))
  echo "istek işlendi id=$i sure_ms=$((RANDOM % 400))"
  if (( i % 7 == 0 )); then echo "<4>yavaş sorgu id=$i sure_ms=2300"; fi
  if (( i % 11 == 0 )); then echo "<3>ödeme servisi yanıt vermedi id=$i" >&2; fi
  sleep 2
done
EOF
chmod +x /usr/local/bin/log-uret.sh

cat > /etc/systemd/system/log-uret.service <<'EOF'
[Unit]
Description=Log üreten deneme servisi

[Service]
ExecStart=/usr/local/bin/log-uret.sh
SyslogIdentifier=odeme
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now log-uret
```

Satırların başındaki `<4>`, `<3>` gibi önekler journald'nin anladığı **öncelik** işaretleridir (`SyslogLevelPrefix=`, varsayılan açık). Uygulaman log seviyesini bu şekilde ya da syslog/journal kütüphanesiyle belirtirse, aşağıda göreceğin `-p` filtresi çalışır.

## Temel kullanım

```bash
journalctl -u log-uret              # servisin tüm logları (less ile açılır)
journalctl -u log-uret -n 20        # son 20 satır
journalctl -u log-uret -f           # canlı takip (tail -f)
journalctl -u log-uret -e           # less'i en sondan aç
journalctl -u log-uret --no-pager | tail
```

Birden fazla birimi birlikte izlemek, bir isteğin nginx'ten uygulamaya geçişini takip ederken çok işe yarar:

```bash
journalctl -u nginx -u odeme-api -f
```

## Zaman ve açılış filtreleri

Olay incelemesinin temel sorusu "o saatte ne oldu?":

```bash
journalctl -u log-uret --since "10 min ago"
journalctl -u log-uret -S "2026-11-25 10:25" -U "2026-11-25 10:40"
journalctl -u log-uret -S today
journalctl -S -1h -p err            # son bir saatte TÜM sistemdeki hatalar
```

Açılış (boot) bazında:

```bash
journalctl --list-boots
journalctl -b                       # bu açılış
journalctl -b -1 -p warning         # bir önceki açılıştaki uyarılar ve üstü
journalctl -b -1 -n 50              # sunucu neden yeniden başladı? Önceki açılışın son satırları
```

> `-b -1`'in çalışması için journal'ın **kalıcı** olması gerekir (aşağıda). Aksi hâlde loglar `/run` altında bellekte tutulur ve yeniden başlatmada kaybolur. Beklenmedik bir yeniden başlatmanın sebebini aradığında bunu öğrenmek için geç kalmış olursun.

## Öncelik filtreleri

| Sayı | Ad | |
|---|---|---|
| 0 | emerg | Sistem kullanılamaz |
| 1 | alert | |
| 2 | crit | |
| 3 | err | Hata |
| 4 | warning | Uyarı |
| 5 | notice | |
| 6 | info | Varsayılan |
| 7 | debug | |

`-p` verilen seviye **ve daha ciddilerini** gösterir:

```bash
journalctl -u log-uret -p warning -n 10
journalctl -u log-uret -p err -n 10
journalctl -u log-uret -p 4..4      # sadece warning
```

## İçerikte arama

```bash
journalctl -u log-uret -g "ödeme"            # --grep, regex destekler
journalctl -u log-uret -g "sure_ms=2[0-9]{3}"
journalctl -u log-uret --no-pager -o cat | awk '{print $1, $2}' | sort | uniq -c
```

`-g` desen tamamen küçük harfse büyük/küçük harf duyarsız arar, desende büyük harf varsa duyarlı (`--case-sensitive=` ile değiştirilebilir).

`-o cat` sadece mesaj metnini verir (zaman ve sunucu adı olmadan). Log analizi dersindeki `awk | sort | uniq -c` kalıpları burada da çalışır.

## Çıktı biçimleri ve alanlar

Journal düz metin değil, **yapılandırılmış** kayıtlar tutar. Her kaydın onlarca alanı vardır:

```bash
journalctl -u log-uret -n 1 -o json-pretty
```

Göreceğin alanlardan bazıları: `MESSAGE`, `PRIORITY`, `_PID`, `_UID`, `_SYSTEMD_UNIT`, `SYSLOG_IDENTIFIER`, `_HOSTNAME`, `_BOOT_ID`, `__REALTIME_TIMESTAMP`. Başında `_` olanlar journald'nin kendisinin eklediği, güvenilir alanlardır. Uygulama bunları taklit edemez.

Alanlara göre filtre:

```bash
journalctl _PID=1234
journalctl _UID=$(id -u www-data) -S -1h
journalctl SYSLOG_IDENTIFIER=odeme -n 5
journalctl -F _SYSTEMD_UNIT | head     # bir alanın aldığı tüm değerler
```

Diğer kullanışlı biçimler:

| `-o` | Ne zaman |
|---|---|
| `short-iso` | Zaman damgası ISO biçiminde, saat dilimiyle |
| `short-precise` | Mikrosaniye hassasiyeti (sıralama sorunlarında) |
| `cat` | Sadece mesaj, analiz için |
| `json` | Satır başına bir JSON, `jq` ile işlemek ya da bir yere göndermek için |
| `verbose` | Bütün alanlar |

```bash
apt-get install -y jq >/dev/null    # lab'da jq yoksa
journalctl -u log-uret -n 50 -o json --no-pager | jq -r 'select(.PRIORITY=="3") | .MESSAGE'
```

## Çekirdek mesajları

```bash
journalctl -k -b                    # dmesg'in journal karşılığı
journalctl -k -g "oom|killed process"
journalctl -k -g "i/o error|ext4|xfs" -S -1d
```

Kaynak izleme dersindeki OOM ve disk hatası kontrolleri bu komutlarla yapılır.

## Kendi betiklerinden journal'a yazmak

Cron işleri ve betikler de journal'a yazabilir. Böylece her şey aynı yerden aranır:

```bash
logger -t yedek -p user.err "yedekleme başarısız: disk dolu"
echo "yedek tamamlandı" | systemd-cat -t yedek -p info
journalctl -t yedek -n 5
```

`-t` etiketi `SYSLOG_IDENTIFIER` olur, `journalctl -t yedek` ile filtrelenir.

## Disk kullanımı ve kalıcılık

```bash
journalctl --disk-usage
ls /var/log/journal 2>/dev/null && echo "kalıcı" || echo "geçici (/run)"
```

Kalıcılık ve sınırlar `/etc/systemd/journald.conf` dosyasında (ya da `journald.conf.d/` altındaki drop-in'lerde) ayarlanır:

```ini
[Journal]
Storage=persistent        # auto: /var/log/journal varsa kalıcı
SystemMaxUse=2G           # toplam üst sınır
SystemKeepFree=4G         # diskte en az bu kadar boş bırak
MaxRetentionSec=1month
RateLimitIntervalSec=30s  # bir servis bu sürede...
RateLimitBurst=10000      # ...bundan fazla satır yazarsa fazlası atılır
```

```bash
systemctl restart systemd-journald
```

Disk dolduğunda acil temizlik:

```bash
journalctl --vacuum-size=500M
journalctl --vacuum-time=7d
```

> **Dikkat:** journald hız sınırına takılınca loglar sessizce atılır ve journal'a `Suppressed N messages from odeme-api.service` satırı düşer. Hata anında log seviyesi debug'a çekilmiş bir servis, en önemli satırları tam bu sırada kaybedebilir. Bu satırı görürsen servisin log hacmini düşür ya da `RateLimitBurst`'ü artır.

## Merkezi loglama hakkında

Journal tek bir sunucunun logudur. Birden fazla sunucun varsa loglar bir merkeze gönderilir: `rsyslog`/`syslog-ng` ile uzak syslog, `systemd-journal-remote`, ya da journal'ı okuyup Loki, Elasticsearch veya bir bulut hizmetine gönderen ajanlar (Promtail, Vector, Fluent Bit). Bu ajanlar genelde `journalctl -o json` ile aynı alanları okur, yani burada öğrendiğin alan adları oralarda da geçerlidir.

## Alıştırma (lab'da)

1. `log-uret` servisinin son 5 dakikadaki **sadece hata** satırlarını, zaman damgası ISO biçiminde göster.
2. Son 10 dakikada kaç "yavaş sorgu" uyarısı yazıldığını tek komutla say.
3. `log-uret` servisini durdur, sonra journal'da servisin durdurulduğu anı ve systemd'nin bununla ilgili yazdığı satırları bul.
4. Bu sunucuda journal kalıcı mı? Değilse kalıcı yap ve `--list-boots` ile doğrula.

<details><summary>Çözüm</summary>

```bash
journalctl -u log-uret -p err -S -5min -o short-iso --no-pager
journalctl -u log-uret -S -10min -g "yavaş sorgu" --no-pager -o cat | wc -l
systemctl stop log-uret
journalctl -u log-uret -n 5 --no-pager
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
journalctl --list-boots
```

Üçüncü adımda "Stopping...", "Deactivated successfully" ve "Stopped..." satırlarını görürsün. Bunlar `_PID=1` (systemd) tarafından yazılır, servisin kendisi tarafından değil.

</details>

```quiz
Sunucu gece kendiliğinden yeniden başladı. Önceki açılışın son loglarını görmek için?
- `journalctl -f`
- [x] `journalctl -b -1 -n 100` (journal kalıcıysa)
- `dmesg`
? `-b -1` önceki açılışı seçer. Journal geçiciyse (`/run`) bu loglar yeniden başlatmayla kaybolmuştur.
```

```quiz
`journalctl -p warning` neleri gösterir?
- Sadece warning seviyesini
- [x] warning ve daha ciddi seviyeleri (err, crit, alert, emerg)
- warning ve daha az ciddi seviyeleri
? `-p` bir eşik belirtir. Tek seviye için aralık yazılır: `-p 4..4`.
```

```quiz
Bir servisin hata anındaki logları eksik, journal'da "Suppressed 4821 messages" satırı var. Sebep?
- Disk doldu
- [x] journald'nin hız sınırı (`RateLimitBurst`) aşıldı
- Servis çöktü
? Çok hızlı log yazan servisin fazla satırları atılır. Çözüm log hacmini azaltmak ya da sınırı servis/ihtiyaca göre yükseltmek.
```

## Özet

| Amaç | Komut |
|---|---|
| Servisi canlı izle | `journalctl -u app -f` |
| Zaman aralığı | `-S "10 min ago"`, `-S ... -U ...` |
| Önceki açılış | `-b -1` (kalıcı journal gerekir) |
| Sadece hatalar | `-p err` |
| İçerikte ara | `-g "regex"` |
| Analiz için | `-o cat`, `-o json \| jq` |
| Çekirdek | `-k` |
| Yer aç | `--vacuum-size=500M`, `--vacuum-time=7d` |
