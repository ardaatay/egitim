# Linux nedir, terminal neden önemli?

Bu kursta Linux'u **komut satırından** öğreneceğiz. Hiçbir şey kurmana gerek yok: sağ alttaki **`>_`** düğmesine bastığında tarayıcının içinde küçük ama gerçek bir Linux açılır. Derslerdeki komutların yanında **▶ Terminalde çalıştır** düğmesi var. İstersen ona bas, istersen komutu kendin yaz.

## Linux aslında ne?

Linux bir **çekirdek** (kernel). Çekirdek, donanımla programlar arasındaki katmandır: işlemciyi programlar arasında paylaştırır, belleği yönetir, diske ve ağa erişimi sağlar.

Günlük dilde "Linux" dediğimizde çoğunlukla çekirdeğin üstüne araçlar, paket yöneticisi ve ayarlar eklenmiş bir **dağıtımı** kastederiz:

| Dağıtım | Nerede sık görülür |
|---|---|
| Ubuntu, Debian | Sunucular, masaüstü, Docker imajları |
| RHEL, Rocky, AlmaLinux, Oracle Linux | Kurumsal sunucular, Oracle veritabanları |
| Alpine | Küçük Docker imajları |
| Buildroot | Gömülü cihazlar (bu kurstaki terminal de bu) |

Dağıtımlar arasında paket yöneticisi gibi farklar olsa da **temel komutların hepsi aynıdır**. Burada öğrendiğin `ls`, `cd`, `grep` her Linux'ta çalışır.

## Neden terminal?

Sunucuların neredeyse hiçbirinde grafik arayüz yoktur. Docker konteynerlerine, Kubernetes pod'larına ve Oracle sunucularına bağlandığında karşına hep aynı şey çıkar: bir **kabuk (shell)** ve yanıp sönen bir imleç.

Terminal ilk başta yavaş görünür, ama:

- **Tekrarlanabilir:** Yazdığın komutu bir dosyaya koyarsın, yarın aynısını tek seferde çalıştırırsın.
- **Uzaktan çalışır:** SSH ile dünyanın öbür ucundaki sunucuda aynı komutları yazarsın.
- **Birleştirilebilir:** Küçük komutları borularla (`|`) birbirine bağlayıp büyük işler yaparsın.

## Kabuk, terminal, komut satırı

Bu kelimeler sık karıştırılır:

- **Terminal:** Yazı yazdığın pencere. Buradaki siyah panel bir terminal.
- **Kabuk (shell):** Yazdığını okuyup çalıştıran program. En yaygını `bash`. Bizim terminalde daha küçük bir kardeşi olan `sh` (BusyBox) var.
- **İstem (prompt):** Kabuğun "hazırım, yaz" dediği işaret. Bizde `~ #` gibi görünür. `#` işareti **root** (yönetici) olduğunu gösterir, normal kullanıcıda bu `$` olur.

> **Dikkat:** Root her şeyi yapabilir, silinen şeyi geri getiren bir "çöp kutusu" yoktur. Bu kurstaki Linux tarayıcında çalışan bir kum havuzu, istediğin kadar boz. Sayfayı yenilediğinde ya da ↻ düğmesine bastığında sıfırdan açılır. Gerçek sunucularda ise root olarak çalışırken iki kez düşün.

## İlk komutun

Terminali aç ve şunu çalıştır:

```terminal
echo "Merhaba Linux"
```

`echo` kendisine verdiğin metni ekrana geri yazar. Basit, ama ileride betiklerde çok kullanacağız.

Şimdi sistemin kendini tanıtmasını iste:

```terminal
uname -a
```

`uname` çekirdek bilgisini verir. `-a` (all) "hepsini göster" demek. Çıktıda `Linux` kelimesini, çekirdek sürümünü ve `i686` gibi bir işlemci mimarisini görürsün.

## Komutların yapısı

Neredeyse her komut aynı kalıba uyar:

```text
komut  [seçenekler]  [argümanlar]
uname  -a
ls     -l            /etc
```

- **Seçenekler** genelde `-` ile başlar: `-l`, `-a`. Birden fazlasını birleştirebilirsin: `-l -a` yerine `-la`.
- Uzun biçimli seçenekler `--` ile başlar: `--help`.
- **Argümanlar** komutun üzerinde çalışacağı şeydir, örneğin bir dosya ya da klasör adı.

```quiz
`ls -la /tmp` komutunda `/tmp` nedir?
- Bir seçenek
- [x] Bir argüman
- Komutun adı
? `-la` seçenek, `/tmp` ise komutun üzerinde çalışacağı argüman (klasör).
```

```quiz
İstemin sonunda `#` görüyorsan ne anlama gelir?
- Komut hatalı yazılmış
- [x] Root (yönetici) kullanıcısısın
- Kabuk meşgul
? `#` root, `$` normal kullanıcı demektir.
```

## Özet

- Linux bir çekirdek, Ubuntu ve Alpine gibi şeyler onun üstüne kurulmuş dağıtımlar.
- Sunucu, Docker ve Kubernetes dünyasında asıl araç terminal.
- Komutlar `komut seçenek argüman` kalıbında yazılır.

Sonraki derste dosya sisteminde gezinmeye başlıyoruz.
