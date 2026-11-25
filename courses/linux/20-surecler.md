# Süreç modeli, /proc ve sinyaller

"Servisi yeniden başlattım ama port hâlâ dolu", "`kill` ettim ama ölmüyor", "`ps`'te bir sürü `<defunct>` var" gibi sorunların hepsi süreç modelini bilince kolayca açıklanır. Bu derste o modeli kuruyoruz.

## fork + exec

Linux'ta yeni bir program çalıştırmanın tek yolu iki adımlıdır:

1. **fork()**: Süreç kendinin neredeyse birebir kopyasını oluşturur. Kopya (çocuk) yeni bir PID alır. Bellek sayfaları copy-on-write ile paylaşılır, yani bu adım ucuzdur.
2. **exec()**: Çocuk, kendi bellek görüntüsünü yeni programla değiştirir. PID **aynı kalır**, açık fd'ler (kapatılmadıysa) devralınır.

Kabuğa `ls` yazdığında olan budur: kabuk fork eder, çocuk yönlendirmeleri ayarlar (önceki derste gördüğün `dup2`), sonra `ls`'i exec eder, ebeveyn `wait()` ile bekler.

Bundan çıkan sonuçlar:

- Her sürecin bir **ebeveyni (PPID)** vardır. Ağacın kökünde PID 1 (`init` ya da `systemd`) durur.
- Ortam değişkenleri, çalışma klasörü, ulimit'ler ve açık fd'ler fork sırasında **kopyalanır**. Çocuk sonradan değiştirse ebeveyn etkilenmez. Bu yüzden bir betikte `cd` ya da `export` yapmak, betiği çağıran kabuğu değiştirmez.

```terminal
echo "kabuğum: $$"
sh -c 'echo "çocuk: $$, ebeveyni: $PPID"'
```

## ps

`ps`'in iki farklı söz dizimi vardır (BSD ve System V) ve gerçek sunucularda ikisini de görürsün:

```text
ps aux                       # BSD: tüm süreçler, kullanıcı, %CPU, %MEM, RSS, STAT
ps -ef                       # SysV: UID, PID, PPID, başlangıç, komut
ps -eo pid,ppid,user,stat,rss,etime,args --sort=-rss | head    # özel sütunlar, belleğe göre
ps -ef --forest              # ağaç görünümü (pstree de olur)
```

Bizim BusyBox `ps`'i daha sınırlı ama sütun seçimini destekliyor:

```terminal
ps -o pid,ppid,stat,rss,vsz,args
```

| Sütun | Anlamı |
|---|---|
| `RSS` | Fiziksel bellekte duran kısım (KB). Paylaşılan kütüphaneler her süreçte ayrı sayılır, bu yüzden toplamı yanıltıcıdır |
| `VSZ` | Sanal adres alanı. Ayrılmış ama kullanılmamış alanı da içerir, tek başına pek anlamlı değil |
| `STAT` | Süreç durumu (aşağıda) |
| `etime` | Ne kadar süredir çalıştığı. "Servis gerçekten yeniden başladı mı?" sorusunun en hızlı cevabı |

### Süreç durumları

| Durum | Anlamı | Not |
|---|---|---|
| `R` | Çalışıyor ya da çalışmaya hazır | Load average'a dahil |
| `S` | Uykuda, kesilebilir (bir olay bekliyor) | Çoğu süreç çoğu zaman burada |
| `D` | Uykuda, **kesilemez** (genelde disk/NFS G/Ç) | `kill -9` bile etkilemez. Load average'a **dahil** |
| `Z` | Zombi: bitti ama ebeveyni çıkış kodunu almadı | Kaynak tutmaz, sadece süreç tablosunda bir satır |
| `T` | Durdurulmuş (Ctrl+Z ya da `SIGSTOP`) | |

Ek harfler: `s` oturum lideri, `l` çok iş parçacıklı, `+` ön plan grubu, `<` yüksek öncelik, `N` düşük öncelik.

> CPU'ları boş olduğu hâlde load average'ı yüksek bir sunucu gördüğünde ilk bakılacak yer `D` durumundaki süreçlerdir: `ps -eo stat,pid,args | grep '^D'`. Genelde cevap yavaş bir disk ya da takılan bir NFS bağlantısıdır.

## /proc/PID: sürecin içi

`ps`, `top` ve benzerleri bilgiyi `/proc`'tan okur. Doğrudan okumak, araç olmayan minimal konteynerlerde hayat kurtarır.

```terminal
P=$$
grep -E '^(Name|State|PPid|Threads|VmRSS|VmSwap)' /proc/$P/status
tr '\0' ' ' < /proc/$P/cmdline; echo
ls -l /proc/$P/cwd
ls -l /proc/$P/fd
cat /proc/$P/limits | head -10
```

| Dosya | Ne söyler |
|---|---|
| `status` | Durum, PPID, bellek (VmRSS, VmSwap), iş parçacığı sayısı |
| `cmdline` | Tam komut satırı (NUL ayraçlı) |
| `environ` | Süreç başladığındaki ortam değişkenleri (NUL ayraçlı). "Servis hangi `DATABASE_URL` ile çalışıyor?" |
| `cwd`, `exe` | Çalışma klasörü ve çalıştırılabilir dosya (symlink) |
| `fd/` | Açık dosyalar, soketler, borular |
| `limits` | Uygulanan ulimit'ler. "Too many open files" hatasında ilk bakılacak yer |

> **Dikkat:** `environ` sürecin **başladığı andaki** ortamı gösterir. `.env` dosyasını değiştirip servisi yeniden başlatmadıysan yeni değer burada görünmez. Ayrıca bu dosya gizli bilgi içerebilir, okumak için sürecin sahibi ya da root olmak gerekir.

Silinmiş ama hâlâ açık tutulan bir log dosyası, `df`'in dolu `du`'nun boş göstermesinin klasik sebebidir. `/proc/*/fd` altında `(deleted)` diye görünür. Bunu kaynak izleme dersinde uygulamalı göreceğiz.

## Arka plan işleri

```terminal
sleep 300 &
echo "son arka plan PID: $!"
jobs
kill $!
```

- `komut &` arka planda başlatır. `$!` son arka plan işinin PID'i.
- `jobs` bu kabuğun işlerini listeler. `fg %1` öne getirir, Ctrl+Z durdurur, `bg` arka planda devam ettirir.
- Kabuk kapanınca (SSH koptuğunda) arka plan işlerine `SIGHUP` gider ve çoğu ölür. Bunu önlemek için `nohup komut &`, `disown`, ya da daha iyisi `tmux`/`screen` kullanılır. Uzun ömürlü her şey ise bir **servis** olmalıdır (systemd bölümü).

## Sinyaller

Sinyal, çekirdeğin bir sürece gönderdiği küçük asenkron bildirimdir. `kill` aslında "sinyal gönder" komutudur, adı yanıltıcıdır.

```terminal
kill -l
```

Operasyonda bilmen gerekenler:

| Sinyal | No | Varsayılan | Kullanım |
|---|---|---|---|
| `SIGTERM` | 15 | Sonlan | `kill`'in varsayılanı. "Lütfen düzgünce kapan": bağlantıları bitir, dosyaları kapat |
| `SIGKILL` | 9 | Sonlan | Yakalanamaz, yok sayılamaz. Temizlik yapılamaz. **Son çare** |
| `SIGINT` | 2 | Sonlan | Ctrl+C |
| `SIGHUP` | 1 | Sonlan | Terminal kapandı. Pek çok servis bunu **"ayarları yeniden oku"** olarak yorumlar (nginx, sshd, rsyslog) |
| `SIGQUIT` | 3 | Core dump | Ctrl+\\. Java'da thread dump alır |
| `SIGUSR1/2` | 10/12 | Sonlan | Uygulamaya özel. nginx `USR1` ile log dosyalarını yeniden açar |
| `SIGSTOP`/`SIGCONT` | 19/18 | Durdur/devam | Yakalanamaz. Süreci dondurup çözer |
| `SIGCHLD` | 17 | Yok say | Çocuk bitti, ebeveyn `wait()` yapmalı |

### Doğru kapatma sırası

Bir süreci elle durdurman gerektiğinde, systemd ve Docker'ın da yaptığı şeyi yap:

1. `kill PID` (SIGTERM), birkaç saniye bekle.
2. Hâlâ yaşıyorsa `kill -9 PID`.

`docker stop` önce SIGTERM gönderir, 10 saniye sonra SIGKILL. Kubernetes'te bu süre `terminationGracePeriodSeconds` (varsayılan 30 sn). Uygulaman SIGTERM'i yakalayıp düzgün kapanmıyorsa, her deploy'da bekleyen istekler kesilir.

### Sinyali yakalamak: trap

Betikler de sinyal yakalayabilir. Geçici dosyaları temizlemek için standart kalıp:

```terminal
cat > is.sh <<'EOF'
#!/bin/sh
TMP=$(mktemp)
trap 'echo "temizleniyor: $TMP"; rm -f "$TMP"; exit 0' TERM INT
echo "çalışıyorum, PID $$"
while true; do sleep 1; done
EOF
chmod +x is.sh
./is.sh &
IS=$!
sleep 1
kill $IS
sleep 1
ls /proc/$IS 2>/dev/null || echo "is.sh kapandı"
```

`kill -9` gönderseydin `trap` çalışmayacak, geçici dosya kalacaktı.

### PID 1 sorunu

Çekirdek PID 1'e özel davranır: PID 1, işleyici tanımlamadığı sinyalleri **almaz**. Bir konteynerde uygulaman doğrudan PID 1 olarak çalışıyor ve SIGTERM işleyicisi yoksa, `docker stop` 10 saniye bekleyip SIGKILL atar. Ayrıca PID 1, yetim kalan süreçlerin ebeveyni olur ve onları `wait()` ile toplaması gerekir. Docker'da `--init` ya da `tini` bu yüzden vardır. Docker kursunda tekrar karşılaşacağız.

## Zombiler

Çocuk bittiğinde çekirdek çıkış kodunu saklar ve ebeveyn `wait()` çağırana kadar süreç tablosunda `Z` olarak tutar. Ebeveyn hiç çağırmazsa zombi kalır. Bilerek bir tane üretelim. Burada `sh`, arka planda `sleep 1` başlatıyor, sonra kendini `sleep 60` ile değiştiriyor (exec). Yeni program çocuğu hiç beklemeyecek:

```terminal
sh -c 'sleep 1 & exec sleep 60' &
sleep 2
ps -o pid,ppid,stat,args | grep -E ' Z |PID'
```

`Z` durumundaki satırın PPID'ine bak. Zombi **`kill -9` ile ölmez**, çünkü zaten ölü. Çözüm ebeveyni düzeltmek ya da öldürmek: ebeveyn ölünce zombi PID 1'e devredilir ve PID 1 onu toplar.

Birkaç zombi zararsızdır. Binlercesi PID alanını tüketir (`/proc/sys/kernel/pid_max`) ve yeni süreç açılamaz. Bu da bir hatalı ebeveynin işaretidir.

## pgrep, pkill, pidof, killall

```text
pgrep -a nginx          # isme göre PID + komut satırı
pgrep -u www-data       # kullanıcıya göre
pkill -HUP nginx        # isme göre sinyal
pidof nginx             # sadece PID'ler
```

> **Dikkat:** `pkill` ve `killall` desen eşleştirir. `pkill java` sunucudaki **bütün** Java süreçlerini etkiler. Önce `pgrep -a` ile neyi vuracağını gör.

## Öncelik: nice

CPU zamanı paylaşımında öncelik `-20` (en yüksek) ile `19` (en düşük) arasındaki **nice** değeriyle belirlenir. Yedekleme ya da sıkıştırma gibi işleri üretim trafiğinin önüne geçmemesi için düşük öncelikle çalıştır:

```text
nice -n 19 tar czf yedek.tgz /srv/data
ionice -c3 nice -n 19 rsync ...     # disk G/Ç önceliğini de düşür
renice -n 10 -p 12345               # çalışan süreci yavaşlat
```

## Alıştırma

1. `sleep 500` komutunu arka planda başlat. `/proc` üzerinden durumunu, ebeveynini ve RSS'ini bul. Sonra SIGTERM ile kapat ve kapandığını doğrula.
2. Kendi kabuğunun açık fd'lerini listele. Kabuk 0, 1 ve 2 dışında hangi fd'leri açık tutuyor?
3. Bir servis SIGTERM'den sonra 30 saniye kapanmıyor. Ne yaparsın ve bunun uzun vadeli çözümü ne olmalı?

<details><summary>Cevaplar</summary>

```terminal
sleep 500 &
P=$!
grep -E '^(State|PPid|VmRSS)' /proc/$P/status
kill $P
sleep 1
ls /proc/$P 2>/dev/null || echo "kapandı"
ls -l /proc/$$/fd
```

3: Kısa vadede `kill -9`. Ama önce mümkünse ne beklediğine bak: `cat /proc/PID/stack` (root), `ls -l /proc/PID/fd`, durumu `D` mi? Uzun vadede uygulama SIGTERM'i yakalayıp yeni istek almayı bırakmalı, açık işleri bitirip çıkmalı. systemd'de `TimeoutStopSec`, Kubernetes'te `terminationGracePeriodSeconds` bu süreyi uygulamanın gerçek kapanma süresine göre ayarlamalı.

</details>

```quiz
`kill -9` ile öldürülemeyen bir süreç `D` durumunda. Sebep büyük ihtimalle nedir?
- Süreç root'a ait
- Süreç zombi
- [x] Kesilemez bir çekirdek G/Ç işlemi bekliyor (disk, NFS)
? `D` durumunda süreç çekirdek içinde bekler, sinyaller G/Ç bitene kadar işlenmez.
```

```quiz
nginx'in ayarlarını bağlantıları koparmadan yeniden yüklemek için hangi sinyal kullanılır?
- SIGKILL
- SIGTERM
- [x] SIGHUP
? `nginx -s reload` ve `systemctl reload nginx` arka planda ana sürece SIGHUP gönderir.
```

```quiz
Bir betiğin içinde `export API_URL=...` ve `cd /srv/app` yaptın. Betik bitince çağıran kabukta ne olur?
- Değişken ve klasör değişmiş olur
- [x] Hiçbiri değişmez, çünkü betik ayrı bir çocuk süreçte çalıştı
- Sadece klasör değişir
? Çocuk süreç ebeveynin ortamını değiştiremez. Kabuğu etkilemek için betiği `. ./betik.sh` (source) ile çalıştırmak gerekir.
```

```quiz
Konteynerin `docker stop` ile her seferinde tam 10 saniyede kapanmasının en olası nedeni?
- Disk yavaş
- [x] Uygulama PID 1 olarak çalışıyor ve SIGTERM'i işlemiyor, Docker 10 sn sonra SIGKILL atıyor
- Ağ zaman aşımı
? PID 1 işleyicisi olmayan sinyalleri almaz. Çözüm: SIGTERM işleyicisi yazmak ya da `--init`/`tini` kullanmak.
```

## Özet

- Yeni süreç = `fork` + `exec`. Ortam ve fd'ler kopyalanır, çocuk ebeveyni değiştiremez.
- `STAT`: `R` çalışıyor, `S` uyuyor, `D` kesilemez G/Ç, `Z` zombi, `T` durdurulmuş.
- `/proc/PID/{status,cmdline,environ,fd,limits}` her aracın kaynağıdır.
- Önce SIGTERM, sonra SIGKILL. SIGHUP çoğu serviste "yeniden yükle" demektir.
- Zombi öldürülmez, ebeveyni düzeltilir.
