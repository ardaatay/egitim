# Güvenli tasarım ilkeleri ve OWASP Top 10

Belirli açıkları (enjeksiyon, XSS, IDOR) tek tek öğrenmek gerekli ama yetmez: Yarın karşına çıkacak açık, adı henüz konmamış bir şey olabilir. Onlara karşı korunmanın yolu, birkaç temel ilkeyi tasarımın her katmanında uygulamaktır. Bu derste bu ilkeleri örneklerle ele alıyor, sonra OWASP Top 10 listesini bu kursun dersleriyle eşleştiriyoruz.

## İlkeler

### En az yetki (least privilege)

Her bileşen, her kullanıcı, her jeton sadece işini yapmaya **yetecek kadar** yetkiye sahip olmalı. Kursun her yerinde gördük: Oracle'da uygulama kullanıcısının tablolara değil pakete `EXECUTE` yetkisi, Kubernetes'te pod'un servis hesabının hiçbir yetkisi olmaması, GitLab'da `read_registry` kapsamlı deploy token. En az yetki bir şeyi **önlemez**, bir açığın **sonucunu sınırlar**: Ele geçirilen bileşen, sahip olmadığı yetkileri kullanamaz.

Pratik sorular: Bu servis hesabı neden `cluster-admin`? Bu jetonun neden `api` kapsamı var? Bu konteyner neden root? Cevap "kolaydı" ise, bu bir bulgudur.

### Derinlemesine savunma (defense in depth)

Tek bir kontrol her zaman bir gün başarısız olur. Kontrolleri **katmanlar** halinde koy, birinin başarısızlığı diğerleriyle telafi edilsin. SQL enjeksiyonu için örnek: bind değişkenleri (birinci katman), uygulama kullanıcısının sadece gereken tablolara erişimi (en az yetki), VPD ile satır seviyesi kısıtlama, ağ seviyesinde veritabanına sadece uygulama pod'larından erişim (NetworkPolicy), denetim kayıtları ve alarm (tespit). Bir geliştirici bind değişkenini unutsa bile saldırgan çok daha az şey elde eder.

### Güvenli varsayılan ve güvenli başarısızlık (fail closed)

Bir kontrol **hata verdiğinde** ne olur? Bir yetki servisinin zaman zaman yanıt vermediği bir senaryo:

```js
// yetki servisi bazen hata veriyor (zaman aşımı, ağ)
async function yetkiServisi(kullanici, eylem) {
  if (kullanici === "zaman-asimi") throw new Error("yetki servisi yanıt vermedi");
  return kullanici === "admin" || eylem === "oku";
}

async function izinVarMiKotu(kullanici, eylem) {
  try {
    return await yetkiServisi(kullanici, eylem);
  } catch (e) {
    console.log("  uyarı:", e.message, "-> devam ediliyor");
    return true;                       // "kullanıcıyı engellemeyelim"
  }
}

async function izinVarMi(kullanici, eylem) {
  try {
    return await yetkiServisi(kullanici, eylem);
  } catch (e) {
    console.log("  hata:", e.message, "-> reddedildi");
    return false;                      // güvenli varsayılan: şüphede reddet
  }
}
```

```bash
node failopen.mjs
```

```text
ayse deploy: kötü=false
ayse deploy: doğru=false
admin deploy: kötü=true
admin deploy: doğru=true
  uyarı: yetki servisi yanıt vermedi -> devam ediliyor
zaman-asimi deploy: kötü=true          ← yetkisiz kullanıcı deploy edebildi
  hata: yetki servisi yanıt vermedi -> reddedildi
zaman-asimi deploy: doğru=false
```

"Kullanıcıyı engellemeyelim" iyi niyetli bir karardır, ama saldırgan için bir anahtardır: Yetki servisini yavaşlatabilen ya da hata verdirebilen biri (çok büyük bir istek, ağ seviyesinde bir saldırı) bütün kontrolleri atlar. Güvenlik kontrolleri **kapalı başarısız olmalı**: belirsizlikte reddet. Erişilebilirlik ihtiyacı (yetki servisi çökünce her şey durmasın) gerçekse, çözüm kontrolü açmak değil, yetki servisini dayanıklı yapmaktır (önbellek, yedeklilik). Yüksek trafik kursunun konusu.

Aynı ilkenin başka yüzleri:

- **İzin listesi, yasak listesi değil.** "Şu karakterleri engelle" yerine "sadece şunlara izin ver". Yasak listesi her zaman eksiktir.
- **Güvenli varsayılanlar.** Yeni bir hesap en düşük rolle başlar, yeni bir uç nokta kimlik doğrulama gerektirir, yeni bir S3 kovası özeldir. Güvensiz olan, bilinçli bir ayarla açılmalı.
- **Hata mesajları.** Kullanıcıya genel bir mesaj ve bir olay kimliği ("Bir hata oluştu, kod: 7f3a"), ayrıntılar (yığın izi, SQL metni) sadece sunucu loglarında.

### Saldırı yüzeyini küçült

Var olmayan bir uç nokta saldırıya uğramaz. Kullanılmayan özellikleri, eski API sürümlerini, hata ayıklama uçlarını (`/debug`, `/actuator`), varsayılan yönetim panellerini kaldır. İç servisleri internete açma (Kubernetes'te `ClusterIP`, veritabanı portunu `127.0.0.1`'e bağlamak: Oracle kursunun ilk dersi). Konteyner imajlarında kabuk ve paket yöneticisi bile bir saldırı yüzeyidir (distroless imajlar, altyapı dersi).

### Girdiyi doğrula, çıktıyı bağlama göre kodla

Enjeksiyon ailesinin (SQL, komut, XSS, LDAP, şablon) ortak sebebi, **veri** ile **kodun** karışmasıdır: Kullanıcının verdiği bir değer, bir yorumlayıcının (veritabanı, kabuk, tarayıcı) **kod** olarak çalıştırdığı bir metnin içine girer. İki ayrı savunma:

- **Girdi doğrulama**: Beklenen biçimi kontrol et (tip, uzunluk, aralık, izin verilen değerler). React kursundaki Zod şemaları burada. Bu bir güvenlik **katmanıdır**, tek başına çözüm değildir: Geçerli bir isim de (`O'Brien`) SQL'i bozabilir.
- **Bağlama göre kodlama/ayırma**: Veriyi, gideceği yorumlayıcıya **veri olarak** ver: SQL'de bind değişkenleri, kabukta argüman dizisi (kabuksuz çalıştırma), HTML'de bağlama uygun kaçış (React'in varsayılanı). Asıl çözüm budur.

### Gizli bilgileri koddan ayır

Parolalar, anahtarlar, jetonlar koda, yapılandırma dosyalarına, imajlara ve loglara girmez. Bir secret manager'dan çalışma anında gelir, düzenli olarak döndürülür (rotation), ve sızdığında iptal edilebilir. Git kursunun son dersleri ve gizli bilgi yönetimi dersi.

### Güvenliği gözlemlenebilir yap

Bir saldırıyı önleyemediysen, en azından **fark etmelisin**. Başarısız girişler, yetki reddi oranları, beklenmeyen ülkelerden erişimler, gizli bilgiye erişimler loglanmalı ve alarm üretebilmeli. Olay müdahalesi dersinin konusu. Tespit etmediğin bir ihlal, aylarca sürebilir.

### Kendi kriptografini yazma

Şifreleme algoritmaları, parola saklama, oturum jetonları, rastgele sayı üretimi için kanıtlanmış kütüphaneleri ve yüksek seviyeli API'leri kullan. "XOR ile gizledik", "parolayı MD5 ile sakladık", "kendi JWT doğrulamamızı yazdık" cümlelerinin her biri gerçek ihlallerin başlangıcıdır. Kriptografi dersi.

## OWASP Top 10

OWASP (Open Worldwide Application Security Project), web uygulamalarındaki en kritik risk kategorilerinin bir listesini periyodik olarak yayımlar. 2021 sürümü uzun süre referans oldu. Kasım 2025'te yeni sürüm yayımlandı. Kategorilerin adları ve sıraları sürümler arasında değişse de içerik büyük ölçüde örtüşür. Güncel listeyi `owasp.org/Top10` adresinden kontrol et. 2025 sürümünün kategorileri ve bu kurstaki karşılıkları:

| 2025 | Kategori | Özü | Ders |
|---|---|---|---|
| A01 | Broken Access Control | Yetkisiz erişim, IDOR, yetki yükseltme. Yine birinci sırada | Yetkilendirme |
| A02 | Security Misconfiguration | Varsayılan parolalar, açık yönetim panelleri, ayrıntılı hata mesajları, yanlış CORS | XSS/CORS, altyapı |
| A03 | Software Supply Chain Failures | Ele geçirilmiş bağımlılıklar, build sistemleri, imajlar (2021'deki "vulnerable and outdated components"ın genişletilmiş hali) | Tedarik zinciri |
| A04 | Cryptographic Failures | Şifresiz veri, zayıf algoritmalar, kötü anahtar yönetimi | Kriptografi |
| A05 | Injection | SQL, komut, XSS (artık bu kategoride) | Enjeksiyon, XSS |
| A06 | Insecure Design | Tasarım seviyesindeki eksiklikler: tehdit modellenmemiş akışlar | Tehdit modelleme, bu ders |
| A07 | Authentication Failures | Zayıf parolalar, kaba kuvvete açık girişler, oturum yönetimi hataları | Kimlik doğrulama |
| A08 | Software or Data Integrity Failures | İmzasız güncellemeler, güvenilmeyen serileştirme, CI/CD bütünlüğü | Tedarik zinciri, SSRF ve sunucu tarafı |
| A09 | Logging & Alerting Failures | Tespit edilemeyen saldırılar | Olay müdahalesi |
| A10 | Mishandling of Exceptional Conditions | Hata durumlarında güvensiz davranış (bu dersteki fail-open örneği) | Bu ders |

2021'de ayrı bir kategori olan SSRF, 2025'te erişim kontrolü altına alındı. Bu kurs onu ayrıca ele alıyor, çünkü bulut ortamlarında etkisi çok büyük.

Listeyi bir **kontrol listesi** olarak değil, bir **farkındalık aracı** olarak kullan: "Top 10'da olmayan açıklara karşı güvendeyiz" anlamına gelmez. Daha ayrıntılı ve doğrulanabilir bir gereksinim seti için **OWASP ASVS** (Application Security Verification Standard): seviye seviye, test edilebilir güvenlik gereksinimleri.

## Alıştırma

1. Kendi projendeki bir servisi düşün. En az yetki ilkesine aykırı üç şey bul (bir servis hesabı, bir veritabanı kullanıcısı, bir CI jetonu, bir konteyner ayarı...).
2. Bir ekip, "dosya adlarında `../` geçerse reddediyoruz, path traversal'a karşı güvendeyiz" diyor. Bu yaklaşımın iki zayıflığını söyle ve izin listesi yaklaşımını öner.
3. Bir hız sınırlama servisi (rate limiter) Redis'e erişemediğinde ne yapmalı: bütün istekleri geçirmek mi, hepsini reddetmek mi? Gerekçelendir.

<details><summary>Çözüm</summary>

1. Örnekler: uygulamanın veritabanına şema sahibiyle bağlanması (Oracle güvenlik dersi), Kubernetes'te `default` servis hesabının otomatik bağlanan jetonu ve bir `ClusterRoleBinding`, CI'da `api` kapsamlı ve süresiz bir kişisel jeton, konteynerin root olarak ve yazılabilir kök dosya sistemiyle çalışması, bir S3 erişim anahtarının `s3:*` yetkisi.

2. (a) Kodlama varyasyonları: URL kodlaması (`%2e%2e%2f`), çift kodlama, Windows'ta `..\`, Unicode normalizasyonu, ve bazı kütüphanelerin yolu sizin kontrolünüzden **sonra** çözmesi. (b) Mutlak yollar: `../` hiç içermeyen `/etc/passwd` ya da `C:\Windows\...`. İzin listesi yaklaşımı: Kullanıcıdan dosya **adı** değil bir **kimlik** al (veritabanındaki dosya kaydının id'si), gerçek yolu sunucu kendisi oluştursun. Ad gerekiyorsa sadece `[a-zA-Z0-9_-]+\.(pdf|png)` gibi bir desene izin ver, sonra yolu çöz (`path.resolve`) ve sonucun izin verilen dizinin içinde olduğunu **çözümlenmiş hali üzerinde** kontrol et. Enjeksiyon dersinde bunu uyguluyoruz.

3. Duruma bağlı, ve bu bir **bilinçli karar** olmalı. Hız sınırı bir güvenlik kontrolüyse (giriş uç noktasında kaba kuvvet koruması), kapalı başarısız olmalı: Redis yokken giriş denemeleri sınırsız olursa saldırgan bunu kullanır (Redis'i düşürmek saldırının bir parçası olabilir). Hız sınırı bir kapasite koruması ise (bütün API'yi aşırı yükten korumak), Redis'in çökmesi yüzünden bütün trafiği reddetmek kendi kendine bir kesinti yaratır. Orada açık başarısızlık + yerel (süreç içi) bir yedek sınırlayıcı makul bir orta yoldur. Her iki durumda da Redis erişilemezliği bir alarm üretmeli.

</details>

```quiz
Bir yetki kontrolü servisi hata verdiğinde güvenli davranış hangisidir?
- İsteğe izin vermek, kullanıcıyı engellememek
- [x] İsteği reddetmek (fail closed); erişilebilirlik ihtiyacı servisi dayanıklı yaparak karşılanır
- Hatayı yok saymak
? Kontrolü hata verdirebilen bir saldırgan, açık başarısızlıkla bütün kontrolleri atlar.
```

```quiz
Enjeksiyon açıklarına karşı asıl çözüm hangisidir?
- Girdideki tehlikeli karakterleri silmek
- [x] Veriyi yorumlayıcıya veri olarak vermek: bind değişkenleri, argüman dizileri, bağlama uygun kaçış
- Uzun girdileri reddetmek
? Girdi doğrulama bir katmandır; veri ile kodun ayrılması asıl savunmadır.
```

```quiz
En az yetki ilkesi bir açığa karşı ne sağlar?
- Açığı tamamen önler
- [x] Ele geçirilen bileşenin yapabileceklerini sınırlar, açığın etkisini küçültür
- Açığın tespit edilmesini sağlar
? Derinlemesine savunmanın katmanlarından biridir.
```

## Özet

- En az yetki: açığın etkisini sınırla. Derinlemesine savunma: birbirini tamamlayan katmanlar.
- Güvenli varsayılanlar ve kapalı başarısızlık: belirsizlikte reddet; izin listesi; genel hata mesajı, ayrıntı logda.
- Saldırı yüzeyini küçült: kullanılmayanı kaldır, iç servisleri açma.
- Veri ile kodu ayır: girdi doğrulama bir katman, bağlama göre kodlama asıl çözüm.
- Gizli bilgiler koddan ayrı; güvenlik gözlemlenebilir; kendi kriptografini yazma.
- OWASP Top 10 (2025): erişim kontrolü, yanlış yapılandırma, tedarik zinciri, kriptografi, enjeksiyon, güvensiz tasarım, kimlik doğrulama, bütünlük, loglama, istisnai durumlar. Farkındalık aracı; doğrulanabilir gereksinimler için ASVS.
