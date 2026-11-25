# Dosya sistemi ağacı ve yollar

Windows'ta her disk ayrı bir harftir: `C:\`, `D:\`. Linux'ta ise **tek bir ağaç** vardır ve her şey `/` (kök) klasörünün altında durur. Başka bir disk, USB bellek ya da ağ klasörü takıldığında bile bu ağacın bir dalına **bağlanır** (mount).

## Ağacın ana dalları

Kök klasöre bak:

```terminal
ls /
```

Bu klasörlerin çoğu her Linux'ta aynı isimle ve aynı görevle bulunur. Ezberlemen gerekmez ama ne işe yaradıklarını bilmek, bir sunucuda bir şeyi ararken nereye bakacağını söyler:

| Klasör | İçinde ne var |
|---|---|
| `/bin`, `/usr/bin` | Komutların kendisi (`ls`, `cp`...) |
| `/sbin`, `/usr/sbin` | Yönetici komutları |
| `/etc` | **Ayar dosyaları.** Neredeyse her programın ayarı burada |
| `/home` | Normal kullanıcıların ev klasörleri |
| `/root` | Root kullanıcısının ev klasörü |
| `/var` | Sürekli değişen veriler: **loglar** (`/var/log`), önbellekler, veritabanı dosyaları |
| `/tmp` | Geçici dosyalar. Yeniden başlatınca silinebilir |
| `/usr` | Kurulu programlar ve kütüphaneleri |
| `/opt` | Elle kurulan büyük paketler. Oracle burada yaşar: `/opt/oracle` |
| `/dev` | Donanım aygıtları dosya gibi görünür: diskler, terminaller |
| `/proc`, `/sys` | Çekirdeğin canlı bilgileri. Gerçek dosya değil |
| `/mnt`, `/media` | Takılan diskler ve paylaşımlar |

> Bizim küçük Linux'ta `/home` yok, çünkü sadece root kullanıcısı var. Ubuntu gibi tam bir dağıtımda olur.

### "Her şey bir dosyadır"

Linux'un en ünlü fikri budur. Çekirdek bilgileri bile dosya gibi okunur. Örneğin işlemci bilgisi:

```terminal
cat /proc/cpuinfo
```

Bellek durumu:

```terminal
cat /proc/meminfo
```

`cat` dosyanın içeriğini ekrana basar. Bunlar diskte duran dosyalar değil, sen okuduğun anda çekirdeğin ürettiği bilgiler. Docker ve Kubernetes'in konteyner sınırlarını (CPU, bellek) nasıl koyduğunu öğrenirken `/proc` ve `/sys` ile tekrar karşılaşacağız.

## Mutlak ve göreli yollar

Bir dosyanın yerini iki şekilde yazabilirsin.

**Mutlak yol** `/` ile başlar ve kökten itibaren tam adresi verir. Nerede olursan ol aynı yeri gösterir:

```text
/etc/hostname
/var/log
```

**Göreli yol** `/` ile başlamaz ve **bulunduğun yerden** itibaren yorumlanır:

```text
log          → bulunduğun klasördeki "log"
../etc       → bir üst klasördeki "etc"
./betik.sh   → bulunduğun klasördeki betik.sh
```

Deneyelim. Önce `/var` klasörüne git:

```terminal
cd /var
ls log
ls /var/log
```

İkisi de aynı yeri listeledi. Biri göreli, biri mutlak yol.

Şimdi ev klasöründen `/etc`'ye göreli yolla gidelim. Ev klasörü `/root`, yani önce bir üste çıkıp oradan `etc`'ye inmeliyiz:

```terminal
cd ~
cd ../etc
pwd
```

> **Ne zaman hangisi?** Betiklerde ve ayar dosyalarında **mutlak yol** kullan, çünkü betik nereden çalıştırılırsa çalıştırılsın doğru yeri bulur. Elle çalışırken göreli yollar daha kısa ve pratiktir.

## Ağacı görmek: tree

`tree` bir klasörün altını ağaç biçiminde gösterir:

```terminal
tree /etc
```

Çok uzun çıktılar için `-L` ile derinliği sınırlayabilirsin: `tree -L 1 /usr`.

## Biraz keşif

Bu küçük Linux'un adını ve sürümünü veren ayar dosyası:

```terminal
cat /etc/os-release
```

Kullanıcı listesi de bir metin dosyasıdır:

```terminal
cat /etc/passwd
```

Her satır bir kullanıcı. İlk alan kullanıcı adı, sondaki ise o kullanıcının giriş kabuğu. Gerçek bir sunucuda burada onlarca satır görürsün, çoğu programların kendi kullanıcılarıdır (`www-data`, `oracle`, `postgres` gibi).

## Alıştırma

1. `/proc` klasörünü listele. Sayılardan oluşan klasör adları sence ne?
2. `/root` içindeyken `/etc/hostname` dosyasını **göreli yolla** ekrana yazdır.

<details><summary>Cevaplar</summary>

1. Her sayı çalışan bir sürecin (programın) numarası. `ps` ile karşılaştır, aynı numaraları görürsün. Süreçler dersinde ayrıntısıyla göreceğiz.
2. ```terminal
   cd /root
   cat ../etc/hostname
   ```

</details>

```quiz
Bir programın ayar dosyasını arıyorsun. İlk nereye bakarsın?
- `/bin`
- [x] `/etc`
- `/tmp`
? Ayar dosyaları geleneksel olarak `/etc` altında durur.
```

```quiz
Hangisi mutlak yoldur?
- `log/syslog`
- `../etc/passwd`
- [x] `/var/log/syslog`
? Mutlak yollar her zaman `/` ile başlar.
```

```quiz
Bir uygulamanın logları büyük ihtimalle nerededir?
- `/etc`
- [x] `/var/log`
- `/usr/bin`
? `/var` değişen verilerin yeri, loglar da `/var/log` altında tutulur.
```

## Özet

- Linux'ta tek bir ağaç var, kökü `/`.
- Ayarlar `/etc`, loglar `/var/log`, geçici dosyalar `/tmp`, ev klasörleri `/home`.
- `/` ile başlayan yol mutlaktır, diğerleri bulunduğun yere göre yorumlanır.
- `.` bulunduğun yer, `..` bir üst klasör, `~` ev klasörü.
