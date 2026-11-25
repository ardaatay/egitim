# Joker karakterler: *, ? ve []

Diyelim ki bir klasörde yüzlerce dosya var ve sadece `.log` ile bitenleri silmek istiyorsun. Tek tek yazmak yerine **joker karakterler** (wildcards, globbing) kullanırsın.

Önce deneme dosyalarımızı oluşturalım:

```terminal
mkdir -p ~/joker && cd ~/joker
touch rapor1.txt rapor2.txt rapor10.txt notlar.txt resim.png resim.jpg app.log hata.log eski.log.bak
ls
```

## * : herhangi bir şey

`*` "sıfır ya da daha fazla herhangi bir karakter" demek.

```terminal
ls *.txt
ls rapor*
ls *log*
```

- `*.txt` → `.txt` ile bitenler
- `rapor*` → `rapor` ile başlayanlar
- `*log*` → içinde `log` geçenler (`eski.log.bak` dahil)

## ? : tam bir karakter

`?` tam olarak **bir** karakterin yerini tutar:

```terminal
ls rapor?.txt
```

`rapor10.txt` gelmedi, çünkü `10` iki karakter.

## [] : bu karakterlerden biri

Köşeli parantez, içindeki karakterlerden **bir tanesi** demek:

```terminal
ls resim.[pj]*
ls rapor[12].txt
```

Aralık da verebilirsin: `[0-9]` herhangi bir rakam, `[a-z]` herhangi bir küçük harf.

```terminal
ls rapor[0-9].txt
```

## Bunu aslında kim yapıyor?

Önemli bir ayrıntı: joker karakterleri `ls` değil, **kabuk** çözer. Sen `ls *.txt` yazdığında kabuk önce `*.txt`'yi eşleşen dosya adlarına çevirir, sonra `ls`'e `ls notlar.txt rapor1.txt rapor10.txt rapor2.txt` olarak verir.

Bunu `echo` ile görebilirsin:

```terminal
echo *.txt
echo *.log
```

Bu yüzden joker karakterler **her komutta** çalışır: `cp`, `mv`, `rm`, `cat`...

```terminal
mkdir -p yedek
cp *.txt yedek/
cat *.log
ls yedek
```

Hiçbir dosya eşleşmezse kabuk deseni olduğu gibi bırakır:

```terminal
echo *.pdf
```

## Joker karakterlerle silmek

`rm` ile birlikte kullanırken altın kural yine aynı: **önce `ls` ile bak, sonra sil.**

```terminal
ls *.log
rm *.log
ls
```

> **Dikkat:** `rm * .log` ile `rm *.log` arasında sadece bir boşluk fark var. İlki "her şeyi sil, bir de `.log` adlı dosyayı sil" demektir. Joker karakterli silmelerde komutu Enter'a basmadan önce bir kez daha oku.

## Gizli dosyalar ve *

`*` nokta ile başlayan gizli dosyaları eşleştirmez:

```terminal
touch .gizli
echo *
echo .*
```

## Alıştırma

`~/joker` klasöründe:

1. Adında rakam geçen bütün dosyaları listele.
2. `resim` ile başlayan dosyaları `resimler` adında yeni bir klasöre taşı.
3. `rapor1.txt` ve `rapor2.txt`'yi listele ama `rapor10.txt`'yi listeleme (iki farklı yolla).

<details><summary>Cevaplar</summary>

```terminal
ls *[0-9]*
mkdir resimler
mv resim* resimler/
ls rapor?.txt
ls rapor[12].txt
```

</details>

```quiz
`ls a?c` hangisini eşleştirir?
- `ac`
- [x] `abc`
- `abbc`
? `?` tam olarak bir karakter demek.
```

```quiz
`*.conf` desenini kim dosya adlarına çevirir?
- `ls` komutu
- [x] Kabuk (shell)
- Çekirdek
? Kabuk deseni genişletip komuta hazır dosya listesi verir. Bu yüzden her komutla çalışır.
```

## Özet

| Desen | Anlamı | Örnek |
|---|---|---|
| `*` | Herhangi sayıda karakter | `*.log` |
| `?` | Tam bir karakter | `rapor?.txt` |
| `[abc]` | Listeden bir karakter | `resim.[pj]*` |
| `[0-9]` | Aralıktan bir karakter | `log[0-9]` |

Bir sonraki bölümde yönlendirmeler ve borularla komutları birbirine bağlamayı öğreneceğiz.
