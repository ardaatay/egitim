# Log analizi: grep, awk, sort, uniq

Bir olay anında ilk 5 dakikada sorulan sorular hep benzerdir: Hata oranı ne zaman arttı? Hangi endpoint? Hangi IP'ler? Yanıt süreleri ne durumda? Bir ELK ya da Grafana yoksa ya da sunucuya doğrudan bağlandıysan, bu soruların cevabı birkaç satırlık boru hattıdır.

## Örnek log

Önce üzerinde çalışacağımız, nginx biçiminde 3000 satırlık bir erişim logu üretelim. Aşağıdaki blok küçük bir awk programı yazıp çalıştırıyor. **Terminalde çalıştır**'a basman yeterli:

```terminal
cd ~
cat > uret.awk <<'EOF'
BEGIN {
  srand(7)
  n = split("203.0.113.5 198.51.100.7 192.0.2.44 203.0.113.9 198.51.100.23 10.0.0.12 203.0.113.77", ip, " ")
  m = split("/ /api/orders /api/login /static/app.js /api/products /health /api/orders /api/products", yol, " ")
  for (i = 0; i < 3000; i++) {
    p = yol[int(rand() * m) + 1]
    r = rand()
    st = (r < 0.82) ? 200 : (r < 0.88) ? 304 : (r < 0.94) ? 404 : (r < 0.98) ? 500 : 502
    if (i >= 1800 && i < 2100 && p == "/api/orders" && rand() < 0.6) st = 502
    x = rand(); sure = x * x * x * 0.8
    if (p == "/api/orders") sure += rand() * 1.5
    if (p == "/health") sure = 0.002
    yontem = (p ~ /^\/api/ && rand() < 0.3 && st != 304) ? "POST" : "GET"
    y = rand()
    printf "%s - - [25/Nov/2026:10:%02d:%02d +0300] \"%s %s HTTP/1.1\" %d %d %.3f\n", ip[int(y * y * n) + 1], int(i / 60), i % 60, yontem, p, st, int(rand() * 5000) + 200, sure
  }
}
EOF
awk -f uret.awk > access.log
wc -l access.log
head -3 access.log
```

Satır biçimi, nginx'in `combined` biçiminin sadeleştirilmiş ve sonuna yanıt süresi (`$request_time`) eklenmiş hâli:

```text
203.0.113.5 - - [25/Nov/2026:10:00:01 +0300] "GET /api/orders HTTP/1.1" 200 4953 0.738
$1          $2 $3 $4                    $5     $6   $7         $8        $9  $10  $11
```

awk alanları boşluğa göre böler. Ezberlenecek alanlar: **`$1` IP, `$4` zaman, `$6` yöntem (başında `"` var), `$7` yol, `$9` durum kodu, `$10` bayt, `$NF` son alan (yanıt süresi)**.

> Gerçek nginx'te `log_format` ile `$request_time` ve `$upstream_response_time` alanlarını eklemek, bu tür analizleri mümkün kılan en ucuz yatırımdır.

## grep: filtrele

```terminal
grep -c '" 502 ' access.log
grep '" 50[0-9] ' access.log | head -5
grep -v '/health' access.log | wc -l
```

Sık kullanılan seçenekler:

| Seçenek | İşlev |
|---|---|
| `-c` | Eşleşen satır sayısı |
| `-v` | Eşleşmeyenler |
| `-i` | Büyük/küçük harf duyarsız |
| `-E` | Genişletilmiş regex (`a\|b`, `+`, `{3}`) |
| `-o` | Satırın sadece eşleşen kısmı |
| `-A n`, `-B n`, `-C n` | Eşleşmenin sonrasından/öncesinden n satır (stack trace'ler için) |
| `-F` | Regex değil düz metin (hızlı, `.` ve `[` sorun olmaz) |
| `-r` | Klasörde özyinelemeli ara |

> Desene `" 502 ` gibi çevresiyle yazmak, `502` sayısının bayt alanında ya da IP'de geçtiği satırları yanlışlıkla saymanı engeller. Alan bazlı filtre için awk daha güvenlidir: `awk '$9 == 502'`.

## Sayma kalıbı: sort | uniq -c | sort -rn

Log analizinin en çok kullanılan kalıbı. `uniq` sadece **ardışık** tekrarları birleştirdiği için önce `sort` gerekir:

```terminal
awk '{print $9}' access.log | sort | uniq -c | sort -rn
```

En çok istek atan IP'ler:

```terminal
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -5
```

Sadece hatalı isteklerde en sık görülen endpoint'ler:

```terminal
awk '$9 >= 500 {print $7}' access.log | sort | uniq -c | sort -rn
```

## Zaman ekseni: sorun ne zaman başladı?

`$4` alanı `[25/Nov/2026:10:31:07` biçiminde. Dakika hassasiyetinde gruplamak için ilk 18 karakteri alalım:

```terminal
awk '$9 == 502 {print substr($4, 2, 17)}' access.log | uniq -c
```

Logda zaman zaten sıralı olduğu için burada `sort` gerekmedi. Çıktıda 10:30 civarında başlayan ve birkaç dakika süren bir sıçrama görmelisin. Hangi endpoint? Dakika ve yol ikilisini sayıp sadece 3'ten fazla tekrar edenleri gösterelim:

```terminal
awk '$9 == 502 {print substr($4, 14, 5), $7}' access.log | sort | uniq -c | awk '$1 > 3'
```

Bir olayın **başlangıç zamanını** bulmak, deploy geçmişiyle karşılaştırmanın ilk adımıdır: "10:30'da ne değişti?"

## awk ile hesaplama

awk tam bir programlama dili: değişkenler, ilişkisel diziler, `BEGIN` ve `END` blokları.

Ortalama yanıt süresi:

```terminal
awk '{s += $NF; n++} END {printf "ortalama: %.3f sn, istek: %d\n", s/n, n}' access.log
```

Endpoint başına istek sayısı ve ortalama süre. İlişkisel diziler burada devreye giriyor:

```terminal
awk '{n[$7]++; s[$7] += $NF} END {for (y in n) printf "%-18s %5d istek  ort %.3f sn\n", y, n[y], s[y]/n[y]}' access.log | sort -k5 -rn
```

Durum koduna göre hata oranı (yüzde):

```terminal
awk '{t++} $9 >= 500 {e++} END {printf "5xx oranı: %%%.2f (%d/%d)\n", 100*e/t, e, t}' access.log
```

### Persentil: ortalama yalan söyler

Ortalama, yavaş isteklerin kuyruğunu gizler. SLO'lar genelde p95 ya da p99 üzerinden tanımlanır. awk'ın yerleşik sıralaması yok, ama `sort -n` ile birleşince kolay:

```terminal
awk '{print $NF}' access.log | sort -n | awk '{a[NR] = $1} END {print "p50:", a[int(NR*0.50)], " p95:", a[int(NR*0.95)], " p99:", a[int(NR*0.99)], " max:", a[NR]}'
```

Aynı hesabı tek bir endpoint için yap. `/api/orders`'ın p95'i genelin kaç katı?

```terminal
awk '$7 == "/api/orders" {print $NF}' access.log | sort -n | awk '{a[NR] = $1} END {print "orders p95:", a[int(NR*0.95)]}'
```

## cut, tr, sed

awk her şeyi yapar, ama bazen daha kısa araçlar yeterli:

```terminal
cut -d' ' -f1,9 access.log | head -3
cut -d'"' -f2 access.log | head -3
awk '{print $6}' access.log | tr -d '"' | sort | uniq -c
```

`sed` akış düzenleyicisidir. En sık kullanımı bul-değiştir:

```terminal
head -3 access.log | sed -E 's/^[0-9.]+/x.x.x.x/'
```

Bu, bir log parçasını bir yere yapıştırmadan önce IP'leri maskelemek için kullanışlıdır. `sed -i` dosyayı yerinde düzenler (ayar dosyalarında sık kullanılır, ama önce yedek al: `sed -i.bak ...`).

## Canlı log üzerinde

Şimdiye kadar yaptığımız her şey `tail -f` ile birleşince canlı izlemeye dönüşür. Gerçek bir sunucuda:

```text
tail -f /var/log/nginx/access.log | awk '$9 >= 500'
tail -F /var/log/nginx/access.log | grep --line-buffered ' 502 ' | awk '{print $1, $7}'
```

İki önemli ayrıntı:

- **`tail -F`** (büyük F): dosya `logrotate` ile yeniden adlandırılıp yenisi açılınca yeni dosyayı izlemeye devam eder. `-f` eski dosyada takılı kalır.
- **`--line-buffered`**: `grep` çıktısı terminal yerine boruya gidince satır satır değil blok blok yazılır. Bu seçenek olmadan zincirin sonunda hiçbir şey görmeyebilirsin.

Sıkıştırılmış eski loglar için: `zcat access.log.2.gz | ...` ya da `zgrep`.

## Alıştırma

1. 404 alan en sık 3 yolu bul.
2. Dakika başına toplam istek sayısını çıkar, en yoğun 3 dakikayı listele.
3. Yanıt süresi 1 saniyeyi aşan isteklerin, endpoint'e göre dağılımını bul.
4. `/api/login`'e en çok POST atan IP hangisi? (Kaba kuvvet tespitinin ilk adımı.)

<details><summary>Cevaplar</summary>

```terminal
awk '$9 == 404 {print $7}' access.log | sort | uniq -c | sort -rn | head -3
awk '{print substr($4, 14, 5)}' access.log | uniq -c | sort -rn | head -3
awk '$NF > 1 {print $7}' access.log | sort | uniq -c | sort -rn
awk '$6 == "\"POST" && $7 == "/api/login" {print $1}' access.log | sort | uniq -c | sort -rn | head -1
```

Dördüncüde `$6` alanının başında çift tırnak olduğuna dikkat: `"POST`.

</details>

```quiz
`awk '{print $1}' access.log | uniq -c` neden yanlış sonuç verir?
- `awk` IP'yi `$1`'de tutmaz
- [x] `uniq` sadece ardışık tekrarları birleştirir, önce `sort` gerekir
- `uniq -c` sayım yapmaz
? Doğru kalıp: `sort | uniq -c | sort -rn`.
```

```quiz
Ortalama yanıt süresi 120 ms ama kullanıcılar yavaşlıktan şikâyetçi. Hangi metrik daha açıklayıcıdır?
- İstek sayısı
- [x] p95 / p99 yanıt süresi
- Toplam bayt
? Ortalama uzun kuyruğu gizler. Yavaş isteklerin %5'i ortalamayı az etkiler ama kullanıcıların önemli bir kısmını etkiler.
```

```quiz
logrotate gece logu döndürdükten sonra `tail -f` yeni satır göstermiyor. Neden?
- Disk doldu
- [x] `-f` eski dosyanın fd'sini izliyor, yeni dosyaya geçmek için `-F` gerekir
- nginx durdu
? `tail -F` dosya adını takip eder ve yeniden açar.
```

## Özet

| Amaç | Kalıp |
|---|---|
| Sayma | `awk '{print $N}' \| sort \| uniq -c \| sort -rn` |
| Koşullu filtre | `awk '$9 >= 500'` |
| Gruplu ortalama | `awk '{n[$7]++; s[$7]+=$NF} END {...}'` |
| Persentil | `... \| sort -n \| awk '{a[NR]=$1} END {print a[int(NR*0.95)]}'` |
| Zaman ekseni | `awk '{print substr($4,14,5)}' \| uniq -c` |
| Canlı | `tail -F ... \| grep --line-buffered ...` |
