# Servis kullanıcıları, izinler, sudo

Deploy sırasında karşılaşılan hataların büyük kısmı izin hatasıdır: uygulama upload klasörüne yazamaz, deploy kullanıcısı dosyaları değiştiremez, nginx statik dosyaları okuyamaz ve 403 döner, biri sorunu "çözmek" için `chmod -R 777` yapar. Bu derste bir web uygulaması için **doğru** kullanıcı ve izin düzenini kuruyoruz.

## Hedef düzen

Tipik bir sunucuda üç farklı kimlik vardır:

| Kimlik | Örnek | Ne yapabilmeli |
|---|---|---|
| **Uygulama kullanıcısı** | `odeme` | Kodunu okumak, sadece kendi veri/upload/log klasörlerine yazmak. Giriş yapamaz |
| **Deploy kullanıcısı** | `deploy` ya da sen | Yeni sürümü sunucuya koymak, servisi yeniden başlatmak (sınırlı sudo ile) |
| **Web sunucusu** | `www-data` (nginx) | Statik dosyaları okumak, uygulamaya proxy etmek |

İlke: **en az yetki**. Uygulama ele geçirilirse saldırgan, uygulama kullanıcısının yapabildiklerini yapabilir. Uygulama root olarak çalışıyorsa sunucunun tamamını ele geçirmiş olur. Kendi koduna yazabiliyorsa kalıcı arka kapı bırakabilir.

## Kullanıcılar ve gruplar

Her süreç bir **UID** ve bir ana **GID** ile, ayrıca bir dizi ek grupla çalışır. Kullanıcı adları sadece `/etc/passwd` içindeki sayıların etiketidir.

```terminal
id
cat /etc/passwd | head -3
cat /etc/group | head -3
```

`/etc/passwd` satırı: `ad:x:UID:GID:açıklama:ev:kabuk`. Parolalar `/etc/shadow`'dadır ve sadece root okuyabilir.

### Sistem kullanıcısı oluşturmak

Gerçek bir Ubuntu/Debian sunucusunda:

```bash
useradd --system --no-create-home --home-dir /srv/odeme-api --shell /usr/sbin/nologin odeme
```

- `--system`: 1000'in altında bir UID verir (giriş yapan insanlardan ayrılır), parola süre politikası uygulanmaz.
- `--shell /usr/sbin/nologin`: Bu kullanıcıyla SSH ya da `su` ile oturum açılamaz.

Tarayıcıdaki BusyBox'ta karşılığı `addgroup`/`adduser`. Bir grup, bir uygulama kullanıcısı ve bir de deploy yapan insan kullanıcı oluşturalım:

```terminal
addgroup -S webapp
adduser -S -D -H -G webapp -s /sbin/nologin odeme
mkdir -p /home
adduser -D -G webapp -s /bin/sh ayse
id odeme
id ayse
```

## İzin bitleri

```terminal
ls -l /etc/passwd /etc/shadow
ls -ld /tmp /root
```

`-rw-r--r--` dört parçadır: tür (`-` dosya, `d` klasör, `l` link), sonra sahip / grup / diğerleri için üçer bit: **r**ead, **w**rite, e**x**ecute.

Dosyalarda anlamları açıktır. **Klasörlerde** farklıdır ve çoğu izin hatası buradan çıkar:

| Bit | Dosyada | Klasörde |
|---|---|---|
| `r` | İçeriği oku | İçindeki **adları listele** (`ls`) |
| `w` | Değiştir | İçinde dosya **oluştur, sil, yeniden adlandır** |
| `x` | Çalıştır | İçine **gir** ve içindeki dosyalara erişmek için geç (`cd`, yol çözümleme) |

İki önemli sonuç:

1. Bir dosyayı okuyabilmek için, dosyanın `r` bitine ek olarak, **kökten dosyaya kadar her klasörde `x`** gerekir. nginx'in `/home/arda/site/index.html` dosyasında 403 vermesinin klasik sebebi `/home/arda`'nın `700` olmasıdır. `namei -l /home/arda/site/index.html` yol boyunca her klasörün iznini gösterir.
2. Bir dosyayı **silmek** için dosyanın değil, **içinde bulunduğu klasörün** `w` izni gerekir. Kendi okuyamadığın bir dosyayı silebilirsin. Hemen görelim.

### Sayısal gösterim

`r=4, w=2, x=1`. Her grup için toplanır:

| Sayı | Bitler | Tipik kullanım |
|---|---|---|
| `644` | `rw-r--r--` | Normal dosya |
| `640` | `rw-r-----` | Gizli bilgi içeren ayar dosyası (sahip + grup) |
| `600` | `rw-------` | Özel anahtar, `.env` |
| `755` | `rwxr-xr-x` | Klasör, çalıştırılabilir dosya |
| `750` | `rwxr-x---` | Sadece sahibi ve grubunun girebildiği klasör |
| `775` / `2775` | `rwxrwxr-x` | Grup ile paylaşılan klasör (aşağıda) |

## Paylaşılan uygulama klasörü

Senaryo: `/srv/odeme-api` klasörüne `webapp` grubundaki herkes (deploy yapanlar) yazabilsin, uygulama okuyabilsin.

```terminal
mkdir -p /srv/odeme-api
chown root:webapp /srv/odeme-api
chmod 775 /srv/odeme-api
ls -ld /srv/odeme-api
su -s /bin/sh ayse -c 'mkdir /srv/odeme-api/releases; touch /srv/odeme-api/releases/a.txt'
ls -l /srv/odeme-api /srv/odeme-api/releases
```

Ayşe klasör oluşturabildi, ama çıktıda iki sorun saklı:

1. `releases` klasörü `drwxr-xr-x`: **grup yazamıyor.** Ekipteki bir başkası bu klasöre yeni release koyamaz. Sebep Ayşe'nin `umask`'ı (aşağıda).
2. Yeni klasörün grubu, üst klasörden değil **Ayşe'nin ana grubundan** geldi. Burada Ayşe'nin ana grubu tesadüfen `webapp` olduğu için doğru görünüyor. Gerçek hayatta her geliştiricinin kendi grubu olur (`ayse:ayse`) ve dosyalar ekibin ortak grubuna ait olmaz.

### setgid: grubu miras al

Klasörde **setgid** biti (`2xxx`, `ls`'te `s`) açıksa, içinde oluşturulan her şey **klasörün grubunu** alır, alt klasörler de bu biti miras alır:

```terminal
chmod 2775 /srv/odeme-api
ls -ld /srv/odeme-api
su -s /bin/sh ayse -c 'umask 002; mkdir /srv/odeme-api/shared; touch /srv/odeme-api/shared/b.txt'
ls -l /srv/odeme-api /srv/odeme-api/shared
```

`shared` klasöründe de `s` biti var ve dosyanın grubu `webapp`.

### umask: varsayılan izinler

Yeni dosyaların izni `666 & ~umask`, klasörlerinki `777 & ~umask` olarak belirlenir. Varsayılan `022` umask ile grup yazamaz:

```terminal
umask
touch /tmp/u1; (umask 002; touch /tmp/u2); (umask 077; touch /tmp/u3)
ls -l /tmp/u1 /tmp/u2 /tmp/u3
```

Ortak klasörlerde `002`, gizli dosya üreten süreçlerde `077` kullanılır. systemd servislerinde `UMask=0027` gibi ayarlanır.

### Silme izni klasöre aittir

Root'a ait, sadece root'un okuyabildiği bir dosya oluşturalım ve Ayşe'nin onu silmeye çalışmasını izleyelim:

```terminal
echo "çok gizli" > /srv/odeme-api/shared/gizli.txt
chmod 600 /srv/odeme-api/shared/gizli.txt
ls -l /srv/odeme-api/shared/
su -s /bin/sh ayse -c 'cat /srv/odeme-api/shared/gizli.txt'
su -s /bin/sh ayse -c 'rm -f /srv/odeme-api/shared/gizli.txt'
ls -l /srv/odeme-api/shared/
```

Ayşe dosyayı okuyamadı ama **silebildi**, çünkü klasöre yazma izni var. Bunu önleyen şey **sticky bit**'tir (`1xxx`, `ls`'te `t`): Klasörde sadece dosyanın sahibi (ya da klasörün sahibi, ya da root) silebilir. `/tmp` bu yüzden `1777`'dir:

```terminal
ls -ld /tmp
```

Birden çok kullanıcının yazdığı upload ya da paylaşım klasörlerinde düşünülmesi gereken bir ayardır.

## chmod -R 777 neden çözüm değil?

"Permission denied" hatasında `chmod -R 777` her şeyi açar ve hata kaybolur. Ama:

- Sunucudaki **her** kullanıcı ve süreç (ele geçirilmiş bir eklenti, başka bir uygulama) dosyaları değiştirebilir.
- Kodun da yazılabilir olur. Bir dosya yükleme açığı, PHP/Python dosyası yükleyip çalıştırmaya dönüşür.
- `-R`, dosyalara da `x` verir. Bazı araçlar (ssh, sudo, postgres) çok açık izinli dosyaları güvenlik nedeniyle reddeder.

Doğru yaklaşım: **Kim, neye, neden** erişemiyor? Hata mesajındaki yolu bul, `namei -l` ya da `ls -ld` ile yol boyunca izinlere bak, sadece o kimliğe sadece o izni ver. Klasör ve dosyaları ayrı ayrı ayarlamak için:

```bash
find /srv/odeme-api/current -type d -exec chmod 755 {} +
find /srv/odeme-api/current -type f -exec chmod 644 {} +
```

## Uygulama klasör düzeni

Bu bölümün geri kalanında kullanacağımız düzen:

```text
/srv/odeme-api/                  root:webapp     2775  (deploy grubu yazar)
├── releases/                    deploy:webapp   2775
│   ├── 20261125-103000/         kod (uygulama sadece okur)
│   └── 20261125-151200/
├── current -> releases/20261125-151200          aktif sürüm (symlink)
└── shared/                      kalıcı veriler
    ├── uploads/                 odeme:webapp    2770  (uygulama yazar)
    └── .env                     root:odeme      0640  (uygulama okur)
/var/log/odeme-api/              odeme:adm       0750
```

- Kod, uygulama kullanıcısına ait **değil**. Uygulama kendi kodunu değiştiremez.
- Uygulamanın yazması gereken yerler (`uploads`, log) ayrı ve sadece onlar yazılabilir.
- `.env` root'a ait, grup `odeme`, `640`: uygulama okur, değiştiremez, diğer kullanıcılar göremez.

## sudo: sınırlı yetki

Deploy kullanıcısının tüm sunucuda root olmasına gerek yok. Sadece servisi yeniden başlatabilsin yeter. sudo kuralları `/etc/sudoers.d/` altına ve **her zaman `visudo` ile** yazılır. visudo, sözdizimi hatası varsa dosyayı kaydetmez. Bozuk bir sudoers dosyası seni sunucudan kilitleyebilir.

```bash
visudo -f /etc/sudoers.d/deploy
```

```text
# deploy kullanıcısı sadece bu komutları parolasız çalıştırabilir
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart odeme-api, /usr/bin/systemctl reload nginx, /usr/bin/systemctl status odeme-api
```

- Komutlar **tam yol ve tam argümanlarla** yazılır. `NOPASSWD: /usr/bin/systemctl` yazmak, `systemctl edit` ile istediği servisi root olarak çalıştırmasına izin vermek demektir, yani tam root.
- Benzer şekilde `sudo vim`, `sudo less`, `sudo tar`, `sudo find` gibi izinler kabuğa kaçışa izin verir. GTFOBins sitesi hangi komutların bu şekilde kötüye kullanılabileceğini listeler.

Kontrol:

```bash
sudo -l -U deploy
```

## SSH erişimi için hızlı kontrol listesi

Deploy kullanıcısı genelde SSH ile bağlanır. Sunucu tarafında `/etc/ssh/sshd_config` (ya da `sshd_config.d/*.conf`):

```text
PasswordAuthentication no
PermitRootLogin no            # ya da prohibit-password
AllowUsers deploy arda
```

`~/.ssh` klasörü `700`, `authorized_keys` `600` ve sahibi kullanıcının kendisi olmalı. Aksi hâlde sshd anahtarı sessizce reddeder ve sadece `journalctl -u ssh` içinde "bad ownership or modes" yazar.

> **Dikkat:** sshd ayarını değiştirdikten sonra `sshd -t` ile doğrula ve mevcut oturumunu **kapatmadan** yeni bir terminalden bağlanmayı dene. Bir hata seni sunucunun dışında bırakabilir.

## Alıştırma

Tarayıcıda:

1. `/srv/site` klasörü oluştur. `webapp` grubundakiler içinde dosya oluşturabilsin, yeni dosyalar otomatik olarak `webapp` grubuna ait olsun ve kimse başkasının dosyasını silemesin.
2. Ayşe olarak bir dosya oluştur, sonra `odeme` kullanıcısının (aynı grupta) bu dosyayı **silemediğini** doğrula.

<details><summary>Çözüm</summary>

```terminal
mkdir -p /srv/site
chown root:webapp /srv/site
chmod 3775 /srv/site
ls -ld /srv/site
su -s /bin/sh ayse -c 'umask 002; echo merhaba > /srv/site/ayse.txt'
ls -l /srv/site
su -s /bin/sh odeme -c 'rm -f /srv/site/ayse.txt'
ls -l /srv/site
```

`3775` = setgid (2) + sticky (1) + `775`. `ls` çıktısında `rwxrwsr-t` görürsün. `odeme` kullanıcısı aynı gruptan olduğu ve klasöre yazabildiği hâlde sticky bit yüzünden Ayşe'nin dosyasını silemez.

</details>

```quiz
nginx `/home/arda/site/index.html` için 403 veriyor. Dosya `644`. En olası sebep?
- nginx root olarak çalışmıyor
- [x] Yol üzerindeki bir klasörde (örneğin `/home/arda`, `700`) nginx kullanıcısının `x` izni yok
- Dosya çalıştırılabilir değil
? Bir dosyaya ulaşmak için yol boyunca her klasörde `x` gerekir. `namei -l yol` ile kontrol et.
```

```quiz
Kullanıcı bir dosyayı okuyamıyor ama silebiliyor. Bu nasıl mümkün?
- Bir hata, olmamalı
- [x] Silme izni dosyanın değil, bulunduğu klasörün `w` iznine bağlıdır
- Kullanıcı root
? Sticky bit (`chmod +t`) bunu sadece dosya sahibiyle sınırlar.
```

```quiz
Deploy kullanıcısına hangi sudo kuralı en güvenlidir?
- `deploy ALL=(ALL) NOPASSWD: ALL`
- `deploy ALL=(root) NOPASSWD: /usr/bin/systemctl`
- [x] `deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart odeme-api`
? Argümansız `systemctl` izni pratikte tam root yetkisidir. Komut ve argümanlar tam yazılmalı.
```

## Özet

- Uygulama ayrı, giriş yapamayan bir kullanıcıyla çalışır ve kendi kodunu değiştiremez.
- Klasörde `x` = geçiş, `w` = oluştur/sil. Silme klasörün iznidir.
- Ortak klasör: `chown root:grup` + `chmod 2775` (setgid) + `umask 002`. Gerekirse sticky (`3775`).
- `777` yerine: hangi kimlik, hangi yol, hangi izin?
- sudo: `visudo -f /etc/sudoers.d/...`, tam yol ve argümanlarla dar kurallar.
