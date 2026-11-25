# Ağ ve portlar: ss, lsof, curl

"Uygulama çalışıyor ama dışarıdan erişilemiyor", "port zaten kullanımda", "bağlantılar zaman aşımına uğruyor", "binlerce `TIME_WAIT` var, sorun mu?", "DNS mi, ağ mı, uygulama mı?". Bu derste bir isteğin yolunu katman katman takip etmeyi ve her katmanı tek komutla doğrulamayı öğreneceğiz.

Tarayıcıdaki küçük Linux'un dış dünyaya bağlantısı yok, sadece kendi içinde (loopback) konuşabiliyor. Temel kavramları orada, gerçek ağ işlerini lab'da yapacağız:

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
İnternet erişimi olan gerçek bir Ubuntu. Eksik araçlar için: apt-get install -y dnsutils netcat-openbsd tcpdump
```

## Bir isteğin yolu

`curl https://odeme.ornek.com/api/health` çalıştığında sırayla:

```text
1. DNS        odeme.ornek.com -> 203.0.113.10          (getent, dig)
2. Yönlendirme 203.0.113.10'a hangi arabirimden/ağ geçidinden?   (ip route get)
3. TCP        203.0.113.10:443'e bağlantı (SYN / SYN-ACK)          (nc -zv, ss)
4. Güvenlik duvarı  arada ya da hedefte paket düşürülüyor mu?        (nft, ufw, bulut security group)
5. Dinleyen süreç   hedefte 443'ü kim dinliyor?                      (ss -tlnp)
6. TLS        el sıkışma, sertifika                                  (openssl s_client)
7. HTTP       nginx -> uygulama                                      (curl -v, loglar)
```

Sorun giderirken bu sırayı aşağıdan yukarı ya da yukarıdan aşağı takip et ve her adımı bir komutla **doğrula**. "Ağ sorunu" dediğimiz şey çoğu zaman bu katmanlardan sadece birindedir.

## Arabirimler ve rotalar: ip

Tarayıcıda deneyelim. Bu küçük Linux'ta loopback arabirimi bile kapalı başlıyor:

```terminal
ip addr
ip link set lo up
ip addr show lo
ip route
```

- `lo` (loopback, `127.0.0.1`): makinenin kendi kendine konuştuğu arabirim. Hiçbir zaman dışarı çıkmaz.
- `eth0`: fiziksel/sanal ağ kartı. Burada IP adresi yok, bu yüzden `ip route` boş.

Gerçek bir sunucuda (lab'da) çıktı daha zengindir:

```bash
ip -br addr                 # kısa özet: arabirim, durum, adresler
ip route                    # varsayılan ağ geçidi: "default via 10.0.0.1 dev eth0"
ip route get 1.1.1.1        # bu adrese giden paket hangi yoldan çıkar?
ip -s link show eth0        # paket ve hata sayaçları (RX/TX errors, dropped)
```

`ip -s link` çıktısındaki `errors` ve `dropped` sayaçları sürekli artıyorsa sorun fiziksel katmanda ya da sürücüdedir (USE yöntemindeki "Errors").

> Eski `ifconfig`, `route`, `netstat` komutları (`net-tools` paketi) yeni dağıtımlarda varsayılan olarak gelmez. Karşılıkları `ip addr`, `ip route` ve `ss`.

## Dinleyen portlar: ss

`ss`, çekirdeğin soket tablosunu doğrudan okur ve `netstat`'tan çok daha hızlıdır.

```bash
ss -tlnp            # TCP, dinleyen, sayısal, süreç bilgisiyle
ss -ulnp            # UDP
ss -tanp            # TÜM TCP bağlantıları, durumlarıyla
ss -s               # özet: kaç bağlantı, hangi durumda
```

| Seçenek | Anlamı |
|---|---|
| `-t` / `-u` | TCP / UDP |
| `-l` | Sadece dinleyenler |
| `-a` | Hepsi (dinleyen + bağlı) |
| `-n` | İsim çözme, sayı göster (`:443`, `https` değil) |
| `-p` | Hangi süreç (root gerekir, başkalarının süreçleri için) |

Lab'da iki sunucu başlatıp farkı görelim:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 >/dev/null 2>&1 &
python3 -m http.server 8081 >/dev/null 2>&1 &
sleep 1
ss -tlnp | grep -E '808[01]'
```

```text
LISTEN 0  5   127.0.0.1:8080   0.0.0.0:*   users:(("python3",pid=2101,fd=3))
LISTEN 0  5     0.0.0.0:8081   0.0.0.0:*   users:(("python3",pid=2102,fd=3))
```

**Yerel adres sütunu**, "uygulama çalışıyor ama dışarıdan erişilemiyor" sorununun yarısını çözer:

| Yerel adres | Kim bağlanabilir? |
|---|---|
| `127.0.0.1:8080` | Sadece bu makine. Dışarıdan erişim **mümkün değil** |
| `0.0.0.0:8081` | Bütün IPv4 arabirimleri, yani dışarısı da (güvenlik duvarı izin verirse) |
| `[::]:8081` | Bütün IPv6 (ve sistem ayarına göre IPv4) arabirimleri |
| `10.0.0.5:8081` | Sadece o IP'ye sahip arabirim |

nginx'in arkasındaki bir uygulama için `127.0.0.1` doğru olandır (nginx dersi). Ama bir Docker konteynerinin içinde `127.0.0.1` dinleyen uygulama **konteyner dışından erişilemez**. Docker kursunda sık göreceğin bir hatadır.

`Recv-Q` dinleyen sokette kabul edilmeyi bekleyen bağlantı sayısı, `Send-Q` ise kuyruğun üst sınırı (backlog). `Recv-Q` sürekli `Send-Q`'ya yakınsa uygulama yeni bağlantıları yeterince hızlı kabul edemiyor demektir.

### Port kimde? "Address already in use"

```bash
python3 -m http.server 8081
ss -tlnp 'sport = :8081'
lsof -i :8081
fuser -v 8081/tcp
```

İkinci sunucu `OSError: [Errno 98] Address already in use` ile açılmadı (strace dersindeki `EADDRINUSE`). Üç komut da portu tutan süreci gösterir. Sık görülen sebepler: servisin eski bir kopyası hâlâ çalışıyor (yeniden başlatma yarıda kalmış), aynı portu kullanan başka bir uygulama, ya da systemd soket etkinleştirmesi portu zaten tutuyor.

## Bağlantı durumları

```bash
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn
```

| Durum | Anlamı | Çok sayıda görürsen |
|---|---|---|
| `ESTAB` | Açık, aktif bağlantı | Normal. Sınırlara (fd, worker, bağlantı havuzu) yakın mı bak |
| `LISTEN` | Dinleyen soket | |
| `SYN-SENT` | Bağlanmaya çalışıyoruz, cevap yok | Hedef paketleri düşürüyor (güvenlik duvarı) ya da kapalı |
| `SYN-RECV` | Gelen bağlantı yarım | SYN flood ya da uygulama/kuyruk dolu |
| `TIME-WAIT` | Bağlantıyı **biz** kapattık, çekirdek 60 sn bekletiyor | Genelde zararsız. Binlercesi, her istek için yeni bağlantı açıldığını gösterir (keepalive yok) |
| `CLOSE-WAIT` | Karşı taraf kapattı, **bizim uygulama** soketi kapatmadı | **Uygulama hatası.** Sürekli artıyorsa fd sızıntısı, sonunda "Too many open files" |

`TIME-WAIT` ile `CLOSE-WAIT` karıştırılmamalı: biri çekirdeğin normal davranışı, öbürü uygulamanın bir soketi kapatmayı unuttuğunun kanıtıdır. Hangi uzak adrese karşı biriktiğini görmek için:

```bash
ss -tan state close-wait | awk 'NR>1 {print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn | head
ss -tan state established '( dport = :5432 )' | wc -l     # veritabanına açık bağlantı sayısı
```

### Çekirdeğin gözünden: /proc/net/tcp

`ss` bu bilgileri çekirdekten alır. Ham hâli tarayıcıda da görülebilir:

```terminal
cat /proc/net/tcp
grep -E '^[a-z]' /etc/services | head -5
grep -w -E '22/tcp|80/tcp|443/tcp|5432/tcp' /etc/services
```

`/proc/net/tcp`'de adres ve portlar onaltılık yazılır (`0100007F:1F90` = `127.0.0.1:8080`), `st` sütunu durum kodudur (`0A` = LISTEN, `01` = ESTABLISHED, `06` = TIME_WAIT, `08` = CLOSE_WAIT). Bu küçük Linux'ta dinleyen bir şey olmadığı için tablo boş. `/etc/services` ise port numaralarının geleneksel adlarını tutar. `ss` `-n` olmadan bu adları gösterir.

## Bağlantıyı test etmek: nc ve curl

### Port açık mı?

```bash
nc -zv -w 3 127.0.0.1 8081          # açık
nc -zv -w 3 127.0.0.1 9999          # kapalı: hemen "Connection refused"
nc -zv -w 3 10.255.255.1 80         # cevap yok: 3 sn sonra zaman aşımı
```

İki farklı hata iki farklı şey söyler (strace dersi):

- **Connection refused** (hemen): Hosta ulaşıldı, o portta dinleyen yok. Servis kapalı ya da yanlış porttadır.
- **Timed out** (bekledikten sonra): Paketler bir yerde sessizce düşürülüyor. Güvenlik duvarı, bulut security group ya da yanlış IP/rota.

Aynı ayrım tarayıcıda da görülebilir. Loopback açıkken dinlenmeyen bir porta bağlanmayı dene:

```terminal
ip link set lo up
curl -sS -m 3 http://127.0.0.1:8080/; echo "curl çıkış kodu: $?"
```

curl çıkış kodu `7` ("couldn't connect") verdi, çünkü 127.0.0.1'de 8080'i dinleyen kimse yok ve çekirdek bağlantıyı anında reddetti. Zaman aşımında bu kod `28` olur. Betiklerde curl çıkış kodlarına göre davranmak bu yüzden faydalıdır.

### curl -v ve zaman dağılımı

`curl -v` isteğin her katmanını gösterir: DNS sonucu, TCP bağlantısı, TLS el sıkışması, gönderilen ve alınan başlıklar.

```bash
curl -v -o /dev/null https://letsencrypt.org 2>&1 | grep -E '^\*|^> |^< ' | head -25
```

"Yavaş ama nerede yavaş?" sorusu için `-w` ile zaman dağılımı:

```bash
cat > /tmp/curl-zaman.txt <<'EOF'
     dns: %{time_namelookup}s
     tcp: %{time_connect}s
     tls: %{time_appconnect}s
 ilk bayt: %{time_starttransfer}s
   toplam: %{time_total}s
     kod: %{http_code}
EOF
curl -s -o /dev/null -w @/tmp/curl-zaman.txt https://letsencrypt.org
```

Değerler **kümülatiftir**. Yorumlama:

- `dns` yüksek → DNS çözümleyicisi yavaş (aşağıda).
- `tcp - dns` yüksek → ağ gecikmesi ya da uzak sunucu yük altında.
- `tls - tcp` yüksek → TLS el sıkışması yavaş (uzak mesafe, OCSP, zayıf sunucu).
- `ilk bayt - tls` yüksek → **sunucu tarafı işleme süresi**: uygulama yavaş.

Belirli bir sunucuyu DNS'i atlayarak test etmek (yük dengeleyicinin arkasındaki tek bir sunucu, yeni sunucuya geçiş öncesi):

```bash
curl -s -o /dev/null -w '%{http_code}\n' --resolve odeme.ornek.com:443:203.0.113.10 https://odeme.ornek.com/health
curl -s -H 'Host: odeme.ornek.com' http://127.0.0.1/health
```

## DNS

```bash
getent hosts letsencrypt.org     # sistemin kullandığı çözümleme (/etc/hosts + DNS), uygulamaların gördüğü
dig +short letsencrypt.org       # doğrudan DNS sorgusu (/etc/hosts'a bakmaz)
dig letsencrypt.org @1.1.1.1     # belirli bir DNS sunucusuna sor
dig +trace letsencrypt.org       # kökten itibaren yetkili sunuculara kadar
cat /etc/resolv.conf
resolvectl status 2>/dev/null | head -20   # systemd-resolved kullanılıyorsa
```

`getent` ile `dig` farklı sonuç veriyorsa, aradaki fark genelde `/etc/hosts`'taki bir satırdır. `/etc/hosts` her zaman DNS'ten önce gelir (`/etc/nsswitch.conf`'taki `hosts: files dns` sırası).

```terminal
cat /etc/hosts
```

Sık DNS sorunları:

- **Değişiklik yayılmadı:** Kayıt değiştirildi ama eski IP dönüyor. `dig` çıktısındaki TTL süresi kadar çözümleyiciler eski cevabı önbellekte tutar. Taşıma öncesi TTL'i düşürmek bu yüzden önemlidir.
- **Uygulama eski IP'de takılı:** Bazı çalışma ortamları (özellikle JVM) DNS sonucunu kendi içinde uzun süre önbelleğe alır. Hedef IP değişince uygulama yeniden başlatılana kadar eski adrese gider.
- **Her istekte 5 saniye gecikme:** `/etc/resolv.conf`'taki ilk sunucu cevap vermiyor. Ya da IPv6 (AAAA) sorgusu zaman aşımına uğruyor.

## Güvenlik duvarı

Ubuntu'da en yaygın arayüz `ufw`. Arka planda nftables (eski sistemlerde iptables) kuralları üretir:

```bash
ufw status verbose
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
nft list ruleset | head -40          # gerçekte uygulanan kurallar
```

> **Dikkat:** Uzak bir sunucuda güvenlik duvarını açmadan önce SSH portuna izin verdiğinden emin ol. `ufw enable` sırasında SSH kuralı yoksa oturumun kopar ve sunucuya geri giremezsin. Bulut sağlayıcıların web konsolundaki seri konsol tek kurtuluş yolu olabilir.

Bulut sunucularında işletim sistemindeki güvenlik duvarına ek olarak **sağlayıcının kendi güvenlik duvarı** (AWS Security Group, Azure NSG, GCP firewall rules) vardır. `ss` portun `0.0.0.0` üzerinde dinlendiğini, `ufw` izin verdiğini gösterse bile dışarıdan zaman aşımı alıyorsan, bir sonraki bakılacak yer orasıdır.

## Paketleri görmek: tcpdump

Son çare, kabloda gerçekte ne olduğuna bakmak:

```bash
tcpdump -ni any port 8081 -c 10
```

Başka bir terminalde `curl 127.0.0.1:8081` çalıştırınca SYN, SYN-ACK, ACK ve HTTP paketlerini görürsün. "İstek sunucuya hiç ulaşıyor mu?" sorusunun kesin cevabı budur. SYN gelip SYN-ACK gitmiyorsa sorun bu makinede, SYN hiç gelmiyorsa ağda ya da güvenlik duvarında. `-w dosya.pcap` ile kaydedip Wireshark'ta açabilirsin.

## Alıştırma (lab'da)

1. 8081'de `0.0.0.0` dinleyen Python sunucusunu, sadece `127.0.0.1` dinleyecek şekilde yeniden başlat ve `ss` ile doğrula.
2. `curl -w` ile `https://github.com` için zaman dağılımını çıkar. Zamanın büyük kısmı hangi aşamada geçiyor?
3. `/etc/hosts`'a `127.0.0.1 odeme.local` ekle. `getent hosts odeme.local` ile `dig +short odeme.local` neden farklı sonuç veriyor?
4. Sunucudaki bağlantıları duruma göre say.

<details><summary>Çözüm</summary>

```bash
pkill -f 'http.server 8081'
python3 -m http.server 8081 --bind 127.0.0.1 >/dev/null 2>&1 &
sleep 1; ss -tlnp | grep 8081

curl -s -o /dev/null -w @/tmp/curl-zaman.txt https://github.com

echo "127.0.0.1 odeme.local" >> /etc/hosts
getent hosts odeme.local
dig +short odeme.local

ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn
```

3: `getent` sistemin çözümleme sırasını (`/etc/nsswitch.conf`: önce `files`, yani `/etc/hosts`) kullanır, `dig` ise doğrudan DNS sunucusuna sorar ve `/etc/hosts`'u hiç okumaz. Uygulamalar `getent` gibi davranır. Bu yüzden DNS sorunlarını teşhis ederken ikisine birden bakmak gerekir.

</details>

```quiz
`ss -tlnp` uygulamanın `127.0.0.1:3000` dinlediğini gösteriyor. Başka bir makineden erişilemiyor. Sebep?
- Güvenlik duvarı
- [x] Uygulama sadece loopback'i dinliyor, dış arabirimlerden gelen bağlantıları kabul etmez
- DNS
? Dışarıdan erişim için `0.0.0.0` (ya da belirli bir IP) dinlemeli, ya da önüne nginx konmalı.
```

```quiz
Sunucuda `CLOSE-WAIT` durumundaki bağlantı sayısı saatlerdir artıyor. Bu neyin işareti?
- Normal TCP davranışı
- Ağ kartı hatası
- [x] Uygulama, karşı tarafın kapattığı soketleri kapatmıyor (soket/fd sızıntısı)
? CLOSE-WAIT, kapatma sırasının uygulamada beklediğini gösterir. TIME-WAIT ise çekirdeğin normal bekleme durumudur.
```

```quiz
`nc -zv sunucu 5432` 30 saniye bekleyip zaman aşımına uğruyor. Hangisi en olası?
- PostgreSQL kapalı
- [x] Arada bir güvenlik duvarı paketleri sessizce düşürüyor (ya da IP/rota yanlış)
- Parola yanlış
? Servis kapalı olsaydı hemen "Connection refused" gelirdi. Zaman aşımı, paketlerin cevapsız kaldığını gösterir.
```

```quiz
`curl -w` çıktısında `tls: 0.08s`, `ilk bayt: 2.9s`. Yavaşlık nerede?
- DNS
- TLS el sıkışması
- [x] Sunucu tarafında, isteğin işlenmesinde (uygulama/veritabanı)
? İlk bayt ile TLS arasındaki fark, sunucunun isteği işleyip ilk baytı göndermesine kadar geçen süredir.
```

## Özet

- Bir isteğin yolu: DNS → rota → TCP → güvenlik duvarı → dinleyen süreç → TLS → HTTP. Her katmanı ayrı doğrula.
- `ip -br addr`, `ip route get`, `ip -s link`.
- `ss -tlnp`: kim, hangi adres:port. `127.0.0.1` sadece yerel, `0.0.0.0` herkes.
- `TIME-WAIT` zararsız, `CLOSE-WAIT` uygulama hatası.
- Refused = dinleyen yok, timeout = paket düşüyor. `curl -w` ile aşama aşama süre.
- `getent` (uygulamanın gördüğü) ile `dig` (sadece DNS) farkı.
