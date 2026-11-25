# İlk komutlar: nerede, ne var?

Terminalde kaybolmamak için önce üç soruyu cevaplayabilmen gerekir: **Neredeyim? Burada ne var? Başka yere nasıl giderim?** Bu üç sorunun cevabı üç komut: `pwd`, `ls`, `cd`.

## pwd: neredeyim?

`pwd` (*print working directory*) şu an içinde bulunduğun klasörü yazar.

```terminal
pwd
```

Çıktı `/root` olmalı. Bu, root kullanıcısının **ev klasörü** (home directory). Terminal açıldığında hep buradan başlarsın. İstemdeki `~` işareti de ev klasörünün kısaltmasıdır.

> Normal kullanıcıların ev klasörü genelde `/home/kullaniciadi` olur, örneğin `/home/arda`. Root'unki istisna olarak `/root`.

## ls: burada ne var?

`ls` (*list*) bulunduğun klasörün içeriğini listeler.

```terminal
ls
```

Sadece isimleri gördün. Daha fazla ayrıntı için `-l` (*long*) seçeneğini ekle:

```terminal
ls -l
```

Her satır bir dosya ya da klasör. Satırın başındaki harfe bak:

- `d` ile başlıyorsa **klasör** (directory)
- `-` ile başlıyorsa **normal dosya**
- `l` ile başlıyorsa **kısayol** (link)

Satırın kalanında izinler, sahibi, boyutu ve tarihi var. İzinleri ayrı bir derste ayrıntılı göreceğiz.

### Gizli dosyalar

Adı nokta (`.`) ile başlayan dosyalar **gizlidir**, `ls` onları göstermez. Görmek için `-a` (*all*) ekle:

```terminal
ls -la
```

Şimdi `.ash_history` gibi dosyalar da göründü. Bu dosya, yazdığın komutların geçmişini tutar. Linux'ta ayar dosyaları genelde böyle gizli dosyalardır: `.bashrc`, `.profile`, `.ssh` gibi.

Listede `.` ve `..` adında iki tuhaf girdi de var:

- `.` **bulunduğun klasörün kendisi**
- `..` **bir üst klasör**

Bunlar bir sonraki komutta çok işimize yarayacak.

### Başka bir klasörü listelemek

`ls`'e argüman olarak bir klasör verirsen, oraya gitmeden içine bakarsın:

```terminal
ls /etc
```

Faydalı birkaç seçenek daha:

| Komut | Ne yapar |
|---|---|
| `ls -lh` | Boyutları okunur yazar (`4.0K`, `12M`) |
| `ls -lt` | En yeniden eskiye sıralar |
| `ls -R` | Alt klasörlerin içini de listeler |
| `ls -1` | Her satıra tek isim yazar |

## cd: başka yere git

`cd` (*change directory*) klasör değiştirir.

```terminal
cd /etc
pwd
```

Şimdi `/etc` içindesin. Bir üst klasöre çıkmak için `..` kullan:

```terminal
cd ..
pwd
```

`/` en tepedeki klasördür, ona **kök** (root) denir. Daha yukarısı yok.

Eve dönmenin üç yolu var, hepsi aynı işi yapar:

```terminal
cd
cd ~
cd /root
```

Bir de çok kullanışlı bir kısayol: `cd -` **bir önceki** bulunduğun klasöre döner. İki klasör arasında gidip gelirken çok işe yarar.

```terminal
cd /etc
cd /tmp
cd -
pwd
```

## Yardım almak

Gerçek sunucularda `man ls` yazarak bir komutun kılavuzunu açabilirsin. Bizim küçük Linux'ta `man` yok, ama neredeyse her komut `--help` seçeneğini anlar:

```terminal
ls --help
```

> **İpucu:** Bir komutun adını yazmaya başlayıp **Tab** tuşuna basarsan kabuk gerisini tamamlar. Telefonda bunun için terminalin altındaki **Tab** düğmesini kullan. **↑** ise önceki komutu geri getirir.

## clear ve history

- `clear` ekranı temizler.
- `history` daha önce yazdığın komutları numarasıyla listeler.

```terminal
history
```

## Alıştırma

Terminalde sırayla şunları yap, sonra cevaplarına bak:

1. `/usr` klasörüne git ve içinde kaç klasör olduğunu bul.
2. Oradan **tek komutla** ev klasörüne dön.
3. `/etc` içindeki gizli dosyaları da gösteren ayrıntılı listeyi al.

<details><summary>Cevaplar</summary>

```terminal
cd /usr
ls -l
cd
ls -la /etc
```

`ls -l` çıktısında `d` ile başlayan satırları sayabilirsin.

</details>

```quiz
`/var/log` içindeyken `cd ..` yazarsan nereye gidersin?
- `/`
- [x] `/var`
- `/root`
? `..` her zaman bir üst klasör demek: `/var/log` → `/var`.
```

```quiz
Adı `.env` olan bir dosyayı `ls` ile göremiyorsun. Neden?
- Dosya bozuk
- [x] Nokta ile başladığı için gizli, `ls -a` gerekiyor
- Root olmadığın için
? Nokta ile başlayan dosyalar gizlidir; `-a` seçeneği onları da gösterir.
```

## Özet

| Komut | Görevi |
|---|---|
| `pwd` | Neredeyim? |
| `ls`, `ls -la` | Burada ne var? (gizliler dahil) |
| `cd yol`, `cd ..`, `cd`, `cd -` | Git, yukarı çık, eve dön, geri dön |
| `komut --help` | Kısa yardım |
