# systemd: servis birimi yazmak

Bir uygulamayı `nohup ./app &` ile başlatmak, ilk çöküşünde ya da sunucunun ilk yeniden başlatılmasında unutulmasına razı olmaktır. Bunun yerine uygulamayı bir **systemd servisi** yaparız. systemd onu açılışta başlatır, çökünce yeniden başlatır, loglarını toplar, kaynaklarını sınırlar ve kapatırken önceki derste gördüğümüz SIGTERM → SIGKILL sırasını uygular.

Bu ders ve bölümün geri kalanı tam bir dağıtım gerektiriyor. Tarayıcıdaki küçük Linux systemd yerine BusyBox `init` kullanıyor:

```terminal
ps -o pid,args | head -3
```

Uygulamalar için aşağıdaki gerçek Ubuntu sunucusunu kullan:

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Ücretsiz, tarayıcıda açılan gerçek bir Ubuntu sunucusu (root yetkili, yaklaşık 1 saat). İlk girişte GitHub ya da Google hesabıyla oturum açman istenir. Bu dersteki `bash` bloklarını oraya kopyalayıp çalıştırabilirsin.
```

## systemd'nin modeli

systemd PID 1 olarak çalışır ve her şeyi **unit** (birim) olarak yönetir. En çok kullanacakların:

| Tür | Örnek | Ne yönetir |
|---|---|---|
| `.service` | `nginx.service` | Süreç(ler) |
| `.timer` | `logrotate.timer` | Zamanlanmış tetikleme (cron alternatifi) |
| `.target` | `multi-user.target` | Birim grupları, eski runlevel'ların karşılığı |
| `.socket` | `docker.socket` | Soket etkinleştirme |
| `.mount` | `srv-data.mount` | Bağlama noktaları |

Her servis kendi **cgroup**'unda çalışır. Bu sayede systemd bir servisin fork ettiği bütün çocukları bilir, birlikte öldürür ve CPU/bellek sınırlarını hepsine birden uygular. Docker konteynerlerinin kaynak sınırlaması da aynı çekirdek mekanizmasıdır.

### Birim dosyaları nerede?

| Yol | Kim yazar | Öncelik |
|---|---|---|
| `/etc/systemd/system/` | **Sen** (yönetici) | En yüksek |
| `/run/systemd/system/` | Çalışma zamanı | Orta |
| `/lib/systemd/system/` (ya da `/usr/lib/...`) | Paketler (`apt`) | En düşük |

> **Dikkat:** Paketin getirdiği dosyayı (`/lib/systemd/system/nginx.service`) asla doğrudan düzenleme, paket güncellemesinde değişikliğin silinir. Bunun yerine **drop-in** kullan: `systemctl edit nginx` komutu `/etc/systemd/system/nginx.service.d/override.conf` dosyasını açar, sadece değiştirmek istediğin satırları yazarsın.

## systemctl: günlük komutlar

```bash
systemctl status nginx            # durum, PID, bellek, son log satırları
systemctl start|stop|restart nginx
systemctl reload nginx            # ayarları yeniden oku (ExecReload, genelde SIGHUP)
systemctl enable --now nginx      # açılışta başlat + şimdi başlat
systemctl disable nginx
systemctl is-active nginx; systemctl is-enabled nginx   # betikler için: çıkış kodu döner
systemctl list-units --type=service --state=running
systemctl --failed                # başarısız olan birimler
systemctl cat nginx               # birim dosyası + drop-in'ler birleşik hâlde
systemctl show nginx -p MainPID -p NRestarts -p ActiveEnterTimestamp
```

`status` çıktısı yoğundur, ama bir bakışta şunları okuyabilmelisin:

```text
● odeme-api.service - Ödeme API
     Loaded: loaded (/etc/systemd/system/odeme-api.service; enabled; preset: enabled)
     Active: active (running) since Tue 2026-11-25 10:31:07 +03; 2h 4min ago
   Main PID: 4123 (node)
      Tasks: 11 (limit: 4557)
     Memory: 182.4M (max: 512.0M available: 329.5M)
        CPU: 1min 12.441s
     CGroup: /system.slice/odeme-api.service
             └─4123 /usr/bin/node /srv/odeme-api/current/server.js
```

- **Loaded** satırı: hangi dosyadan yüklendi, `enabled` mı (açılışta başlar mı).
- **Active** satırı: durum ve **ne zamandır** bu durumda. Bir deploy'dan sonra servisin gerçekten yeniden başladığını buradan doğrularsın.
- **Main PID**, **Memory** ve **CGroup**: hangi süreç ağacının bu servise ait olduğu.

`restart` ile `reload` farkı önemlidir: `restart` süreci öldürüp yeniden başlatır (bağlantılar kopar), `reload` çalışan sürece ayarları yeniden okumasını söyler. nginx, haproxy ve postgres gibi servisler bunu destekler. Desteklemeyen bir serviste `reload` hata verir. `systemctl reload-or-restart` ikisini birleştirir.

## İlk servis birimimiz

Senaryo: `/srv/odeme-api` altında 8080 portunu dinleyen bir uygulama var. Lab'da uygulama yerine Python'un yerleşik web sunucusunu kullanacağız, ama birim dosyası bir Node, Go ya da Java uygulaması için de aynıdır.

Önce uygulama için **ayrı bir kullanıcı** ve klasör oluştur. Uygulama asla root olarak çalışmamalı:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin odeme
mkdir -p /srv/odeme-api
echo "<h1>odeme-api calisiyor</h1>" > /srv/odeme-api/index.html
chown -R odeme:odeme /srv/odeme-api
```

Gizli değerleri birim dosyasına değil ayrı, izinleri kısıtlı bir dosyaya koy:

```bash
cat > /etc/odeme-api.env <<'EOF'
PORT=8080
DATABASE_URL=postgres://odeme:gizli@db.internal/odeme
EOF
chmod 640 /etc/odeme-api.env
chown root:odeme /etc/odeme-api.env
```

Şimdi birim dosyası:

```bash
cat > /etc/systemd/system/odeme-api.service <<'EOF'
[Unit]
Description=Ödeme API
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
User=odeme
Group=odeme
WorkingDirectory=/srv/odeme-api
EnvironmentFile=/etc/odeme-api.env
ExecStart=/usr/bin/python3 -m http.server ${PORT} --bind 0.0.0.0
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
```

Satır satır:

**[Unit]**: Birimin kimliği ve diğer birimlerle ilişkisi.

- `After=network-online.target` sadece **sıralama** belirtir: "ağ hazır olduktan sonra başla". `Wants=` ise o hedefi de **başlatır**. İkisi birlikte kullanılır. `After=` tek başına bir bağımlılık oluşturmaz, bu en sık yapılan hatadır.
- `StartLimitIntervalSec` ve `StartLimitBurst`: 60 saniyede 5'ten fazla çökerse yeniden denemeyi bırak. Sonsuz bir çöküş döngüsünün diski logla doldurmasını engeller.

**[Service]**: Sürecin nasıl çalıştırılacağı.

- `Type=exec`: süreç exec edildiği anda "başladı" sayılır. Eski `simple` türünden farkı, çalıştırılabilir dosya bulunamazsa `start` komutunun hemen hata vermesidir. Uygulama systemd'ye "hazırım" bildirimi gönderiyorsa (`sd_notify`) `Type=notify` daha doğrudur. Kendini arka plana atan (daemonize eden) eski programlar için `Type=forking` vardır, ama modern bir uygulamayı ön planda çalıştırıp `exec` kullanmak her zaman tercih edilir.
- `User=`, `Group=`: servisin kimliği. 1024 altındaki portları dinlemesi gerekiyorsa root yapmak yerine `AmbientCapabilities=CAP_NET_BIND_SERVICE` ekle ya da önüne nginx koy.
- `EnvironmentFile=`: `KEY=VALUE` satırları. Başına `-` koyarsan (`EnvironmentFile=-/etc/...`) dosya yoksa hata vermez. Tek tük değerler için `Environment=NODE_ENV=production` de olur.
- `ExecStart=`: **tam yol** gerekir, `PATH` aranmaz. `${PORT}` gibi değişkenler systemd tarafından genişletilir, ama bu bir kabuk değildir: `|`, `>`, `&&` çalışmaz. Gerekirse `/bin/sh -c '...'` ile sar.
- `Restart=on-failure`: sıfır olmayan çıkış kodu, sinyalle ölme ya da zaman aşımında yeniden başlat. `always`, düzgün çıkışta bile yeniden başlatır.
- `TimeoutStopSec=20`: `stop` sırasında SIGTERM'den sonra SIGKILL'e kadar beklenen süre (varsayılan 90 sn).

**[Install]**: `enable` edildiğinde ne olacağı. `WantedBy=multi-user.target`, `multi-user.target.wants/` klasörüne bir symlink oluşturur. Normal açılışta bu hedef başlatılınca servisin de başlatılmasını sağlar.

Çalıştıralım:

```bash
systemctl daemon-reload
systemctl enable --now odeme-api
systemctl status odeme-api --no-pager
curl -s localhost:8080
```

> `daemon-reload`'u unutmak klasik bir hatadır. Birim dosyasını her değiştirdiğinde systemd'ye yeniden okumasını söylemelisin. Unutursan `systemctl status` sana "Warning: The unit file changed on disk" diye hatırlatır.

## Restart davranışını görmek

Servisi `kill -9` ile öldürüp systemd'nin onu geri getirdiğini izle:

```bash
systemctl show odeme-api -p MainPID -p NRestarts
kill -9 $(systemctl show odeme-api -p MainPID --value)
sleep 4
systemctl show odeme-api -p MainPID -p NRestarts
journalctl -u odeme-api -n 5 --no-pager
```

PID değişti, `NRestarts` arttı ve journal'da "Main process exited, code=killed, status=9/KILL" satırını görürsün.

`systemctl stop` ise yeniden başlatmayı tetiklemez, çünkü durdurma isteği senden geldi.

Bir de başlangıç sınırını deneyelim. `ExecStart`'ı bilerek bozup servisi döngüye sokalım:

```bash
systemctl edit odeme-api
```

Açılan düzenleyiciye şunu yaz ve kaydet (drop-in dosyasında `ExecStart`'ı önce boş değerle sıfırlamak gerekir, yoksa ikinci bir ExecStart eklenmiş olur):

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -c "import sys; sys.exit(3)"
```

```bash
systemctl restart odeme-api
sleep 20
systemctl status odeme-api --no-pager
```

Durumun `failed` olduğunu ve "Start request repeated too quickly" yazdığını görmelisin. Düzeltmek için drop-in'i geri al ve hata sayacını sıfırla:

```bash
systemctl revert odeme-api
systemctl reset-failed odeme-api
systemctl start odeme-api
```

## Kaynak sınırları

Her servis kendi cgroup'unda olduğu için sınır koymak birkaç satır:

```ini
[Service]
MemoryMax=512M          # aşarsa cgroup içinde OOM ile öldürülür
MemoryHigh=400M         # bu noktadan sonra çekirdek belleği geri almaya zorlar (yavaşlatır)
CPUQuota=150%           # en fazla 1.5 çekirdek
TasksMax=200            # süreç + iş parçacığı sınırı (fork bombasına karşı)
LimitNOFILE=65536       # açık dosya sınırı ("Too many open files")
```

> `ulimit -n` ile `/etc/security/limits.conf` systemd servislerini **etkilemez**. Bunlar PAM üzerinden oturum açan kullanıcılar içindir. Servislerde `LimitNOFILE=` kullanılır. "limits.conf'u değiştirdim ama servis hâlâ 1024 diyor" şikâyetinin cevabı budur. Doğrulamak için `cat /proc/$(systemctl show odeme-api -p MainPID --value)/limits`.

Anlık kullanım için `systemd-cgtop`, servis başına özet için `systemctl status`.

## Güvenlik sıkılaştırma

systemd, Docker'a benzer izolasyonu birkaç satırla verir. Bir web uygulaması için makul bir başlangıç:

```ini
[Service]
NoNewPrivileges=yes         # setuid ile yetki yükseltme yok
PrivateTmp=yes              # servise özel /tmp
ProtectSystem=strict        # tüm dosya sistemi salt okunur...
ReadWritePaths=/srv/odeme-api/uploads /var/lib/odeme-api   # ...bunlar hariç
ProtectHome=yes             # /home, /root görünmez
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```

`systemd-analyze security odeme-api` her ayarı tek tek değerlendirip 0-10 arası bir maruz kalma puanı verir. Bir ayarı ekledikten sonra uygulama yazamadığı için hata veriyorsa, journal'da "Read-only file system" satırını görürsün ve ilgili yolu `ReadWritePaths=`'e eklersin.

## Sorun giderme

Servis başlamıyorsa sırayla:

```bash
systemctl status odeme-api --no-pager -l     # son loglar ve çıkış kodu
journalctl -u odeme-api -b --no-pager | tail -30
systemd-analyze verify /etc/systemd/system/odeme-api.service   # sözdizimi
systemctl cat odeme-api                       # gerçekte uygulanan birim (drop-in'lerle)
sudo -u odeme /usr/bin/python3 -m http.server 8080   # aynı kullanıcıyla elle dene
```

Sık görülen çıkış durumları:

| status satırı | Anlamı |
|---|---|
| `status=203/EXEC` | `ExecStart` yolu yanlış ya da çalıştırma izni yok |
| `status=217/USER` | `User=` diye bir kullanıcı yok |
| `status=200/CHDIR` | `WorkingDirectory` yok ya da erişilemiyor |
| `status=226/NAMESPACE` | Sıkılaştırma ayarındaki bir yol yok |
| `code=killed, status=9/KILL` | SIGKILL: OOM ya da `TimeoutStopSec` aşıldı |
| `Start request repeated too quickly` | `StartLimitBurst` aşıldı, önce `reset-failed` |

Açılış süresini analiz etmek için `systemd-analyze blame` ve `systemd-analyze critical-chain`.

## Alıştırma (lab'da)

1. `odeme-api` servisine `MemoryMax=64M` ekle (drop-in ile), `systemctl status`'ta sınırın göründüğünü doğrula.
2. Servisin `LimitNOFILE` değerini 4096 yap ve `/proc/PID/limits` ile doğrula.
3. `systemd-analyze security odeme-api` puanını not al. Yukarıdaki sıkılaştırma bloğunu ekleyip tekrar ölç. Servis hâlâ çalışıyor mu?

<details><summary>Çözüm</summary>

```bash
mkdir -p /etc/systemd/system/odeme-api.service.d
cat > /etc/systemd/system/odeme-api.service.d/limits.conf <<'EOF'
[Service]
MemoryMax=64M
LimitNOFILE=4096
EOF
systemctl daemon-reload
systemctl restart odeme-api
systemctl status odeme-api --no-pager | grep -i memory
grep 'open files' /proc/$(systemctl show odeme-api -p MainPID --value)/limits
systemd-analyze security odeme-api | tail -1
```

`systemctl edit` yerine drop-in dosyasını elle yazmak, aynı işi betiklerde ve Ansible gibi araçlarda yapmanın yoludur.

</details>

```quiz
`After=postgresql.service` yazdın ama postgres kapalıyken uygulaman yine de başladı ve bağlanamadı. Neden?
- `After=` yanlış yazılmış
- [x] `After=` sadece sıralama belirtir, postgres'i başlatmaz. `Wants=` ya da `Requires=` da gerekir
- systemd postgres'i tanımıyor
? Sıralama (`After/Before`) ve bağımlılık (`Wants/Requires`) ayrı kavramlardır. Uygulama yine de bağlantı hatalarına karşı tekrar denemeli.
```

```quiz
`/etc/security/limits.conf` içinde `nofile 65535` var, ama servis "Too many open files" hatası veriyor. Çözüm?
- Sunucuyu yeniden başlatmak
- [x] Birim dosyasına `LimitNOFILE=65535` ekleyip `daemon-reload` ve `restart`
- `ulimit -n 65535` komutunu çalıştırmak
? limits.conf PAM oturumları içindir, systemd servislerini etkilemez.
```

```quiz
Paketle gelen `nginx.service` dosyasında bir ayarı değiştirmenin doğru yolu?
- `/lib/systemd/system/nginx.service` dosyasını düzenlemek
- [x] `systemctl edit nginx` ile drop-in oluşturmak
- Dosyayı silip yeniden yazmak
? Drop-in'ler `/etc/systemd/system/nginx.service.d/` altında durur ve paket güncellemelerinden etkilenmez.
```

```quiz
`systemctl status` çıktısında `status=203/EXEC` görüyorsun. İlk neye bakarsın?
- Bellek sınırına
- [x] `ExecStart` yolunun doğru ve çalıştırılabilir olduğuna
- Ağ ayarlarına
? 203, systemd'nin programı exec edemediğini söyler: yanlış yol, çalıştırma izni yok ya da betiğin shebang satırı bozuk.
```

## Özet

- Kendi birimlerin `/etc/systemd/system/`'de. Paket birimlerini `systemctl edit` ile değiştir.
- Değişiklikten sonra `daemon-reload`, ilk kurulumda `enable --now`.
- Servis ayrı kullanıcıyla, `EnvironmentFile` ile, `Restart=on-failure` ve başlangıç sınırıyla çalışmalı.
- `After=` sıralama, `Wants=` bağımlılık.
- Kaynak sınırları ve `LimitNOFILE` birim dosyasında, `limits.conf`'ta değil.
- Başlamayan servis: `status` → `journalctl -u` → `systemctl cat` → aynı kullanıcıyla elle çalıştır.
