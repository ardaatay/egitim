# Dosyaları okumak: cat, head, tail, less, wc

Sunucuda en çok yaptığın işlerden biri dosya okumaktır: bir ayar dosyasına bakmak, bir logun son satırlarını görmek, bir hatayı aramak. Bu derste bunun araçlarını öğreniyoruz.

Önce üzerinde çalışacak bir dosya üretelim. Aşağıdaki komut 1'den 200'e kadar sayıları, her satırda bir sayı olacak şekilde `sayilar.txt` dosyasına yazar. Nasıl çalıştığını şimdilik dert etme:

```terminal
cd ~
seq 1 200 > sayilar.txt
```

Bir de küçük bir "log" dosyası:

```terminal
printf "08:00 INFO uygulama başladı\n08:01 INFO veritabanına bağlanıldı\n08:05 WARN disk %%85 dolu\n08:07 ERROR ödeme servisi yanıt vermedi\n08:08 INFO yeniden denendi\n08:09 ERROR ödeme servisi yanıt vermedi\n08:10 INFO kapatılıyor\n" > uygulama.log
```

## cat: hepsini bas

```terminal
cat uygulama.log
```

`cat` kısa dosyalar için idealdir. Uzun bir dosyada ise ekran kayar gider:

```terminal
cat sayilar.txt
```

Satır numarasıyla görmek için `-n`:

```terminal
cat -n uygulama.log
```

`cat`'in adı *concatenate* (birleştir) kelimesinden gelir. Birden fazla dosyayı arka arkaya basar:

```terminal
cat uygulama.log uygulama.log
```

## head ve tail: başı ve sonu

`head` ilk 10 satırı, `tail` son 10 satırı gösterir. Sayıyı `-n` ile değiştirebilirsin:

```terminal
head sayilar.txt
tail -n 3 sayilar.txt
```

Log dosyalarında en yeni kayıtlar **sondadır**, bu yüzden `tail` en çok kullanacağın komutlardan biri olacak.

### tail -f: canlı izleme

`tail -f` dosyanın sonunu gösterir ve **beklemeye devam eder**. Dosyaya yeni satır eklendikçe ekrana basar. Çalışan bir uygulamanın logunu izlemenin standart yoludur:

```terminal
tail -f uygulama.log
```

Şimdi terminal bekliyor. Durdurmak için **Ctrl+C** (telefonda terminalin altındaki **^C** düğmesi) bas. Ctrl+C her zaman "çalışan komutu durdur" demektir.

> Docker'da `docker logs -f`, Kubernetes'te `kubectl logs -f` komutları da aynı mantıkla çalışır. `-f` (*follow*) gördüğün yerde "canlı takip et" diye düşün.

## less: sayfa sayfa gez

Uzun dosyaları okumanın asıl aracı `less`'tir. Dosyayı açar, sen yön tuşlarıyla gezersin:

| Tuş | İşlev |
|---|---|
| `Boşluk` / `b` | Bir sayfa ileri / geri |
| `g` / `G` | En başa / en sona |
| `/kelime` | İleri doğru ara, `n` sonrakini bulur |
| `q` | Çık |

> Bizim tarayıcı terminalimiz tam ekran programları düzgün gösteremiyor, bu yüzden `less`'i burada değil gerçek bir sunucuda deneyebilirsin. Burada yerine `head`, `tail` ve az sonra göreceğin `grep` ile idare edeceğiz.

## wc: say

`wc` (*word count*) satır, kelime ve bayt sayısını verir:

```terminal
wc uygulama.log
```

Çoğu zaman sadece satır sayısı istenir:

```terminal
wc -l sayilar.txt
```

## Önden bir bakış: grep

Bir dosyada belirli kelimeyi içeren satırları bulmak için `grep` kullanılır. Borular dersinde ayrıntılı göreceğiz, ama o kadar kullanışlı ki şimdiden tanış:

```terminal
grep ERROR uygulama.log
```

Bir de bunu `wc` ile birleştirelim. `|` (boru), soldaki komutun çıktısını sağdakine verir:

```terminal
grep ERROR uygulama.log | wc -l
```

Logda kaç hata olduğunu tek satırla saydık.

## Alıştırma

1. `sayilar.txt` dosyasının **sadece 50. satırını** göster. (İpucu: `head` ve `tail`'i boruyla birleştir.)
2. `/etc/passwd` dosyasında kaç kullanıcı olduğunu bul.
3. `uygulama.log` içinde `WARN` ya da `ERROR` olmayan, yani sadece `INFO` olan satırları göster.

<details><summary>Cevaplar</summary>

```terminal
head -n 50 sayilar.txt | tail -n 1
wc -l /etc/passwd
grep INFO uygulama.log
```

İlk komutta `head` ilk 50 satırı veriyor, `tail -n 1` bunların sonuncusunu, yani 50. satırı alıyor.

</details>

```quiz
Bir sunucuda uygulama logunu canlı izlemek istiyorsun. Hangi komut?
- `cat -f app.log`
- [x] `tail -f app.log`
- `head -f app.log`
? `tail -f` dosyanın sonunu izlemeye devam eder. Ctrl+C ile çıkılır.
```

```quiz
Çalışan bir komutu durdurmak için ne yaparsın?
- `q` yazarım
- `exit` yazarım
- [x] Ctrl+C basarım
? Ctrl+C çalışan komuta "dur" sinyali gönderir. `q` sadece `less` gibi programlardan çıkarken kullanılır.
```

## Özet

| Komut | Görevi |
|---|---|
| `cat dosya`, `cat -n` | Tamamını bas (satır numaralı) |
| `head -n 20`, `tail -n 20` | İlk / son satırlar |
| `tail -f` | Canlı izle (Ctrl+C ile çık) |
| `less` | Sayfa sayfa gez (`q` ile çık) |
| `wc -l` | Satır say |
| `grep kelime dosya` | Kelimeyi içeren satırlar |
