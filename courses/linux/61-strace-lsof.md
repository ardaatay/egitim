# strace, lsof ve dmesg ile derine inmek

Loglar sessiz kaldığında ("uygulama takılıyor ama hiçbir şey yazmıyor", "servis başlamıyor ve hata mesajı anlamsız") bir sürecin **çekirdekle ne konuştuğuna** bakarız. Her dosya açma, ağ bağlantısı, okuma ve bekleme bir sistem çağrısıdır. `strace` bunları canlı gösterir, `lsof` sürecin elindeki kaynakları listeler, `/proc` sürecin o an nerede beklediğini söyler, `dmesg` çekirdeğin kendi gözlemlerini anlatır.

`strace` tarayıcıdaki Linux'ta yok, bu kısımlar lab'da:

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
strace ve lsof kurulu değilse: apt-get install -y strace lsof
```

## strace temelleri

```bash
strace -f -tt -T -o /tmp/iz.txt <komut>     # yeni bir komutu izle
strace -f -tt -T -p <PID>                     # çalışan bir sürece bağlan
```

| Seçenek | İşlev |
|---|---|
| `-f` | Çocuk süreçleri ve iş parçacıklarını da izle (neredeyse her zaman gerekli) |
| `-p PID` | Çalışan sürece bağlan. Ctrl+C ile ayrılınca süreç çalışmaya devam eder |
| `-e trace=file` | Sadece dosya çağrıları (`open`, `stat`, `access`...). Ayrıca `network`, `process`, `read,write` |
| `-tt` | Mikrosaniyeli zaman damgası |
| `-T` | Her çağrının ne kadar sürdüğü (satır sonunda `<0.000123>`) |
| `-s 200` | Metin argümanlarını 200 karaktere kadar göster (varsayılan 32) |
| `-c` | Ayrıntı yerine özet tablo: hangi çağrı kaç kez, toplam ne kadar sürdü |
| `-o dosya` | Çıktıyı dosyaya yaz (uygulamanın kendi çıktısıyla karışmaz) |

Bir çıktı satırı şöyle okunur:

```text
10:31:07.412311 openat(AT_FDCWD, "/etc/odeme/config.yml", O_RDONLY) = -1 ENOENT (No such file or directory) <0.000021>
zaman           çağrı  (argümanlar)                                 = dönüş  hata kodu                       süre
```

> **Dikkat:** strace her sistem çağrısında süreci durdurup yeniden başlatır. Yoğun bir üretim sürecini birkaç kat yavaşlatabilir. Kısa süre bağlan, `-e` ile filtrele, işin bitince ayrıl. Sürekli izleme için eBPF tabanlı araçlar (`bpftrace`, `bcc` araçları) çok daha düşük maliyetlidir.

## Senaryo 1: "Ayar dosyası bulunamadı" ama hangisi?

Uygulama "config not found" diyor ama hangi yollara baktığını söylemiyor. strace söyler:

```bash
cat > /tmp/uyg.py <<'EOF'
import os, sys
for yol in ["./config.yml", os.path.expanduser("~/.odeme/config.yml"), "/etc/odeme/config.yml"]:
    if os.path.exists(yol):
        print("ayar:", yol); sys.exit(0)
print("config not found", file=sys.stderr); sys.exit(1)
EOF
strace -f -e trace=file python3 /tmp/uyg.py 2>&1 | grep -E 'config|ENOENT' | grep config
```

Üç `stat`/`newfstatat` çağrısını ve her birinin `ENOENT` döndüğünü görürsün. Aynı yöntem "bu program hangi kütüphaneyi/sertifika dosyasını/ayarı yüklüyor?" sorusunun da cevabıdır.

## Senaryo 2: "Permission denied" ama hangi dosya?

```bash
mkdir -p /srv/gizli && echo x > /srv/gizli/anahtar && chmod 700 /srv/gizli
useradd -r -s /usr/sbin/nologin deneme 2>/dev/null || true
sudo -u deneme strace -e trace=file cat /srv/gizli/anahtar 2>&1 | grep -E 'EACCES|EPERM'
```

Hata, dosyanın değil **klasörün** izninden kaynaklanıyor ve strace tam olarak hangi yolun `EACCES` döndüğünü gösteriyor (izinler dersindeki "yol boyunca `x`" kuralı).

## Senaryo 3: Takılan süreç ne bekliyor?

Bir süreç hiçbir şey yapmıyor gibi görünüyor. Önce strace'e bile gerek kalmadan `/proc`'a bak:

```bash
sleep 300 &
P=$!
cat /proc/$P/status | grep State
cat /proc/$P/wchan; echo
cat /proc/$P/stack 2>/dev/null | head -5
```

`wchan` sürecin çekirdekte beklediği fonksiyonu gösterir (`hrtimer_nanosleep`, `do_select`, `pipe_read`, `io_schedule`...). `stack` (root gerekir) çekirdek yığınının tamamını verir. `D` durumunda takılan bir süreçte burada genelde dosya sistemi ya da NFS fonksiyonları görürsün.

Şimdi bir ağ isteğinde takılan süreç. Yanıt vermeyen bir adrese bağlanmaya çalışan bir istemci:

```bash
timeout 8 strace -f -tt -T -e trace=network,poll,select curl -s -m 5 http://10.255.255.1/ 2>&1 | tail -6
kill $P
```

`connect(...) = -1 EINPROGRESS` ve ardından `poll(...)` çağrısının 5 saniye beklediğini görürsün: hedef paketlere cevap vermiyor (güvenlik duvarı paketi sessizce düşürüyor). Hemen `ECONNREFUSED` dönseydi, adres erişilebilir ama port kapalı demekti. Bu ayrım, "ağ sorunu mu, servis kapalı mı?" sorusunun cevabıdır.

### DNS gecikmesi

Uygulama her istekte 5 saniye bekliyorsa ve strace'te `connect(... port 53 ...)` ile `recvfrom` arasında uzun bir boşluk görüyorsan, yavaşlık DNS'tedir. `/etc/resolv.conf`'taki ilk sunucu cevap vermiyor ve çözümleyici zaman aşımından sonra ikinciye geçiyor olabilir. Doğrulama:

```bash
time getent hosts letsencrypt.org
cat /etc/resolv.conf
```

## Senaryo 4: Nereye zaman harcıyor? (-c)

```bash
strace -f -c -o /tmp/ozet.txt find /usr -name '*.so' > /dev/null
head -15 /tmp/ozet.txt
```

Özet tablo, sürecin zamanının hangi çağrılarda geçtiğini gösterir. Binlerce küçük `read`/`write` çağrısı tamponlamanın yokluğuna, çok sayıda `stat` gereksiz dosya sistemi taramasına, çok sayıda `futex` ise iş parçacıkları arasında kilit çekişmesine işaret eder.

## lsof: sürecin elindekiler

"Her şey bir dosyadır": açık dosyalar, soketler, borular, silinmiş dosyalar. `lsof` hepsini listeler.

```bash
lsof -p <PID>                 # bir sürecin açık her şeyi
lsof -i :8000                 # 8000 portunu kim kullanıyor (dinleyen ve bağlı olanlar)
lsof -i TCP -s TCP:LISTEN     # dinleyen tüm TCP soketleri
lsof +L1                      # silinmiş ama açık dosyalar
lsof /var/log/nginx/access.log   # bu dosyayı kim açık tutuyor
lsof +D /srv/odeme-api        # bu klasördeki dosyaları kim açık tutuyor (umount edilemiyorsa)
lsof -u odeme | wc -l         # kullanıcının açık dosya sayısı
```

Port sorgusunun daha hızlı karşılığı `ss -tlnp 'sport = :8000'`.

### "Too many open files"

```bash
P=$(pgrep -f gunicorn | head -1)
ls /proc/$P/fd | wc -l
grep 'open files' /proc/$P/limits
lsof -p $P | awk '{print $5}' | sort | uniq -c | sort -rn | head
```

Açık fd sayısı sınıra yaklaşıyorsa son komut neyin biriktiğini gösterir: `IPv4` (kapatılmayan bağlantılar), `REG` (kapatılmayan dosyalar). Sınırı yükseltmek (`LimitNOFILE`, systemd dersi) zaman kazandırır, ama sürekli artış bir **sızıntıdır** ve uygulamada düzeltilmelidir.

Tarayıcıdaki Linux'ta da BusyBox `lsof` var, daha sade bir çıktıyla:

```terminal
sh -c 'exec 3< /etc/passwd 4> /tmp/yazilan.txt; sleep 300' &
P=$!
sleep 1
lsof | grep "^$P"
ls -l /proc/$P/fd
kill $P
```

## dmesg: çekirdeğin anlattıkları

Çekirdek, kullanıcı alanındaki logların göremeyeceği olayları kendi halka tamponuna yazar:

```terminal
dmesg | tail -15
dmesg | grep -i -E 'error|fail|warn' | head
```

Gerçek sunucularda arayacağın kalıplar:

| Kalıp | Anlamı |
|---|---|
| `Out of memory: Killed process 1234 (java)` | OOM killer bir süreci öldürdü. Hemen öncesindeki satırlar o anki bellek dağılımını verir |
| `Memory cgroup out of memory` | Bir servisin/konteynerin kendi bellek sınırı aşıldı (`MemoryMax`, Docker `--memory`) |
| `segfault at ... ip ... error 4 in libfoo.so` | Bir süreç geçersiz bellek erişimiyle çöktü |
| `I/O error, dev sda, sector ...` | Disk hatası. Disk değişimi gündemde |
| `EXT4-fs error` / `remounting filesystem read-only` | Dosya sistemi hatası, salt okunur moda geçti. Uygulamalar yazamaz |
| `nf_conntrack: table full, dropping packet` | Bağlantı izleme tablosu dolu. Yoğun trafikte rastgele bağlantı hataları |
| `TCP: request_sock_TCP: Possible SYN flooding on port 443` | Dinleme kuyruğu taşıyor (`somaxconn`, uygulamanın `backlog`'u) ya da gerçek bir saldırı |
| `task ... blocked for more than 120 seconds` | Bir süreç uzun süre `D` durumunda kaldı, genelde depolama sorunu |

`dmesg -T` zaman damgalarını okunur yapar (ama askıya alma/devam ettirme sonrası kayabilir). `journalctl -k` aynı bilgiyi journal'ın zaman damgası ve filtreleriyle verir.

## Hangi araç ne zaman?

| Soru | Araç |
|---|---|
| Süreç hangi dosyaya/ayara bakıyor, neden bulamıyor? | `strace -e trace=file` |
| Süreç ne bekliyor? | `/proc/PID/wchan`, `stack`, `strace -p` |
| Bağlantı mı reddediliyor, paket mi düşüyor? | `strace -e trace=network`, `curl -v`, `ss` |
| Zaman nereye gidiyor (sistem çağrıları)? | `strace -c` |
| Zaman nereye gidiyor (uygulama kodu)? | Profiler: `perf top`, `py-spy dump/top`, Node `--inspect`, Java `jstack`/async-profiler |
| Bu dosyayı/portu kim tutuyor? | `lsof`, `ss -tlnp`, `fuser` |
| Süreç neden öldü? | `journalctl -u`, `dmesg` (OOM/segfault), çıkış kodu (137, 139) |

`py-spy` özellikle değerli: çalışan bir Python sürecine (gunicorn worker'ı dahil) dokunmadan bağlanır ve o an hangi Python satırında olduğunu gösterir: `py-spy dump --pid PID`. "Worker takıldı ama neden?" sorusunun en hızlı cevabı.

## Alıştırma (lab'da)

1. `ls /olmayan` komutunu strace ile çalıştır ve hata mesajını üreten sistem çağrısını bul.
2. `python3 -m http.server 8080 &` başlat. `lsof -i :8080` ve `ss -tlnp` ile portu kimin dinlediğini doğrula. Sonra ikinci bir `python3 -m http.server 8080` çalıştırmayı dene ve hatayı strace ile sistem çağrısı seviyesinde gör.
3. `strace -c` ile `ls -R /usr > /dev/null` komutunun en çok zaman harcadığı üç sistem çağrısını bul.

<details><summary>Çözüm</summary>

```bash
strace ls /olmayan 2>&1 | grep -E 'olmayan'
python3 -m http.server 8080 >/dev/null 2>&1 &
sleep 1; lsof -i :8080; ss -tlnp | grep 8080
strace -f -e trace=network python3 -m http.server 8080 2>&1 | grep -E 'bind|EADDRINUSE'
kill %1
strace -c ls -R /usr > /dev/null 2> /tmp/c.txt; head -8 /tmp/c.txt
```

1: `statx(...)` ya da `newfstatat(...)` çağrısı `-1 ENOENT` döner. `ls` hata mesajını bundan üretir.

2: `bind(3, {sa_family=AF_INET, sin_port=htons(8080), ...}) = -1 EADDRINUSE (Address already in use)`. Bu, "servis açılmıyor" senaryosundaki "Address already in use" hatasının çekirdek tarafındaki karşılığı.

3: Genelde `getdents64` (klasör okuma), `newfstatat`/`statx` ve `write` öne çıkar.

</details>

```quiz
Bir istemci bir sunucuya bağlanırken strace'te `connect() = -1 ECONNREFUSED` hemen dönüyor. Bu ne anlama gelir?
- Paketler güvenlik duvarında sessizce düşürülüyor
- [x] Sunucuya ulaşılıyor ama o portta dinleyen bir süreç yok
- DNS çözümlenemedi
? Paketler düşürülseydi bağlantı zaman aşımına kadar beklerdi. Hemen gelen ret, hostun RST gönderdiğini gösterir.
```

```quiz
Servis "Address already in use" diyerek açılmıyor. Portu kimin tuttuğunu nasıl bulursun?
- `dmesg | grep port`
- [x] `ss -tlnp 'sport = :8000'` ya da `lsof -i :8000`
- `journalctl -k`
? İkisi de dinleyen sürecin PID'ini ve adını gösterir.
```

```quiz
Bir Java servisi gece öldü, uygulama logunda hiçbir şey yok. İlk bakılacak yer?
- Uygulama ayar dosyası
- [x] `dmesg -T` / `journalctl -k` içinde OOM kayıtları ve `journalctl -u` içinde çıkış durumu
- nginx access log
? Çekirdeğin SIGKILL ile öldürdüğü süreç kendi loguna yazamaz. İz çekirdek logunda ve systemd'nin çıkış kaydındadır.
```

## Özet

- `strace -f -tt -T -e trace=...` ile süreç ile çekirdek arasındaki konuşmayı gör. Üretimde kısa süre ve filtreli kullan.
- `ENOENT` bulunamadı, `EACCES` izin, `ECONNREFUSED` port kapalı, uzun `poll` paket düşüyor.
- `/proc/PID/wchan` ve `stack` ile sürecin nerede beklediğini gör.
- `lsof -p`, `lsof -i :port`, `lsof +L1`. fd sızıntısı için `/proc/PID/fd` sayımı.
- `dmesg`/`journalctl -k`: OOM, segfault, disk ve dosya sistemi hataları.
