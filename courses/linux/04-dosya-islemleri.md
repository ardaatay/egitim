# Klasör ve dosya oluşturma, kopyalama, silme

Bu derste kendi küçük proje klasörümüzü kurup üzerinde oynayacağız. Terminal ev klasöründe başlıyor, oradan ilerleyelim.

## mkdir: klasör oluştur

```terminal
cd ~
mkdir proje
ls
```

İç içe birden çok klasörü tek seferde oluşturmak istersen `-p` (*parents*) kullan. `-p` olmadan, üst klasör yoksa hata alırsın:

```terminal
mkdir proje/src/lib
mkdir -p proje/src/lib
tree proje
```

İlk komut hata verdi, ikincisi `src`'yi de oluşturdu. `-p`'nin bir güzelliği daha var: klasör zaten varsa hata vermez. Bu yüzden betiklerde hep `mkdir -p` kullanılır.

## touch ve echo: dosya oluştur

`touch` boş bir dosya oluşturur. Dosya zaten varsa sadece tarihini günceller.

```terminal
cd proje
touch README.md notlar.txt
ls -l
```

İçinde bir şey olan dosya oluşturmanın en kısa yolu `echo` ile **yönlendirme** (`>`):

```terminal
echo "Merhaba" > selam.txt
cat selam.txt
```

`>` komutun çıktısını ekrana değil dosyaya yazar. **Dikkat:** dosya varsa içeriğini silip üzerine yazar. Sonuna eklemek için `>>` kullan:

```terminal
echo "Bir satır daha" >> selam.txt
cat selam.txt
```

Yönlendirmeleri ileride ayrı bir derste ayrıntılı göreceğiz.

> Gerçek sunucularda dosya düzenlemek için `nano` (kolay) ya da `vi`/`vim` (güçlü ama alışmak zaman ister) kullanılır. Bizim tarayıcı terminalimiz tam ekran programları gösteremediği için burada dosyaları `echo` ve `cat` ile oluşturacağız.

## cp: kopyala

```text
cp kaynak hedef
```

```terminal
cp selam.txt selam-yedek.txt
ls
```

Hedef bir klasörse, dosya aynı adla o klasöre kopyalanır:

```terminal
cp selam.txt src/
ls src
```

Klasör kopyalamak için `-r` (*recursive*, alt klasörlerle birlikte) şart:

```terminal
cp src src-yedek
cp -r src src-yedek
tree
```

İlk komut "klasörü atlıyorum" diye uyardı, ikincisi kopyaladı.

## mv: taşı ve yeniden adlandır

Linux'ta ayrı bir "yeniden adlandır" komutu yoktur. Adını değiştirmek, dosyayı aynı klasörde yeni bir isme **taşımaktır**:

```terminal
mv notlar.txt notlarim.txt
ls
```

Başka klasöre taşımak:

```terminal
mv selam-yedek.txt src/lib/
tree
```

`mv`, `cp`'nin aksine klasörlerde `-r` istemez.

> **Dikkat:** `cp` ve `mv` hedefte aynı adlı bir dosya varsa **sormadan** üzerine yazar. Sorması için `-i` (*interactive*) ekleyebilirsin: `cp -i a.txt b.txt`.

## rm: sil

```terminal
rm selam.txt
ls
```

Linux'ta **çöp kutusu yoktur.** `rm` ile silinen dosya gider.

Boş klasörü `rmdir` siler. İçi dolu klasör için `rm -r` gerekir:

```terminal
rmdir src-yedek
rm -r src-yedek
ls
```

`rmdir` "klasör boş değil" dedi, `rm -r` sildi.

### rm -rf hakkında

`-f` (*force*) "sorma, hata da verme" demek. `rm -rf klasor` en hızlı ve en tehlikeli silme biçimidir. İnternette şaka olarak görebileceğin `rm -rf /` bütün sistemi siler.

Gerçek sunucularda `rm -rf` yazmadan önce şu alışkanlığı edin:

1. Önce aynı yolu `ls` ile listele, gerçekten silmek istediğin şey mi bak.
2. Sonra komutta `ls` yerine `rm -r` yaz.

> **Dikkat:** Özellikle betiklerde `rm -rf $KLASOR/` gibi bir satırda değişken boş kalırsa komut `rm -rf /` olur. Değişkenli silmelerde ekstra dikkat.

Bu tarayıcı Linux'unu bozmak serbest. Merak ediyorsan dene, ↻ düğmesi her şeyi geri getirir.

## Alıştırma

Ev klasöründe aşağıdaki yapıyı oluştur, sonra `tree` ile kontrol et:

```text
site/
├── index.html      (içinde "<h1>Merhaba</h1>" yazsın)
├── css/
│   └── stil.css    (boş)
└── js/
    └── app.js      (boş)
```

Sonra `site` klasörünün `site-yedek` adında bir kopyasını al, ardından orijinal `site` klasörünü sil.

<details><summary>Bir çözüm</summary>

```terminal
cd ~
mkdir -p site/css site/js
echo "<h1>Merhaba</h1>" > site/index.html
touch site/css/stil.css site/js/app.js
tree site
cp -r site site-yedek
rm -r site
ls
```

</details>

```quiz
`mkdir -p a/b/c` ile `mkdir a/b/c` arasındaki fark nedir?
- [x] `-p` eksik üst klasörleri de oluşturur ve klasör zaten varsa hata vermez
- `-p` klasörü gizli yapar
- Hiçbir fark yok
```

```quiz
`rapor.txt` dosyasının adını `rapor-eski.txt` yapmak için hangi komut?
- `cp rapor.txt rapor-eski.txt`
- `rename rapor.txt rapor-eski.txt`
- [x] `mv rapor.txt rapor-eski.txt`
? `cp` kopya oluşturur, orijinal yerinde kalır. Ad değiştirmek `mv` ile yapılır.
```

```quiz
`echo "yeni" > log.txt` komutu çalıştığında `log.txt` içinde 100 satır vardı. Sonra ne olur?
- "yeni" dosyanın sonuna eklenir
- [x] Dosyada sadece "yeni" kalır
- Hata verir
? `>` üzerine yazar. Sona eklemek için `>>` kullanılır.
```

## Özet

| Komut | Görevi |
|---|---|
| `mkdir -p yol` | Klasör(ler) oluştur |
| `touch dosya` | Boş dosya oluştur |
| `echo "metin" > dosya` / `>>` | Dosyaya yaz / sonuna ekle |
| `cp a b`, `cp -r` | Kopyala (klasörse `-r`) |
| `mv a b` | Taşı veya yeniden adlandır |
| `rm dosya`, `rm -r klasor` | Sil (geri dönüşü yok) |
