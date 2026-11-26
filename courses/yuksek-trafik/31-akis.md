# Olay akışları: bölümler, tüketici grupları ve sıralama

Önceki dersteki iş kuyruğunda bir iş bir kez tüketilir ve silinir. **Olay akışı** (Kafka, Redpanda, Pulsar, AWS Kinesis) farklı bir modeldir:

- Olaylar, yalnızca sonuna eklenen bir **günlüğe** (log) yazılır ve belirli bir süre (ya da sonsuza kadar) saklanır.
- Her tüketici günlükte **kendi konumunu** (ofset) tutar.
- Aynı olay akışını faturalama, arama indeksi, analitik ve bildirim gibi birbirinden habersiz birçok sistem, kendi hızında okur. Gerekirse geçmişe dönüp yeniden okur.

Bu ders, olay akışlarının ölçeklenme ve doğruluk açısından kritik üç kavramını ele alıyor: **bölümler**, **tüketici grupları** ve **ofset taahhüdü**. Bu ortamda bir Kafka kümesi yok. Kavramları, Kafka'nın modelini birebir izleyen küçük ve deterministik bir simülasyonla gösteriyoruz. Kafka'ya özgü ayarlar metin olarak verildi, çalıştırılmadı.

## Model

```text
Konu (topic): siparisler
  bölüm 0: [o0][o1][o2][o3] ...          ← her bölüm, sadece sonuna eklenen sıralı bir günlüktür
  bölüm 1: [o0][o1][o2] ...
  bölüm 2: [o0][o1][o2][o3][o4] ...
             ↑ ofset

Üretici: bölüm = hash(anahtar) mod bölüm_sayısı
Tüketici grubu "faturalama": her bölüm gruptaki TAM OLARAK BİR tüketiciye atanır
Tüketici grubu "arama":      aynı bölümleri bağımsız olarak, kendi ofsetleriyle okur
```

```js
// akis.mjs — bölümlenmiş günlük (Kafka modeli) simülasyonu
import crypto from "node:crypto";

const bolumSec = (anahtar, P) => crypto.createHash("md5").update(anahtar).digest().readUInt32BE(0) % P;

class Konu {
  constructor(P) { this.bolumler = Array.from({ length: P }, () => []); }
  yaz(anahtar, deger) { const b = bolumSec(anahtar, this.bolumler.length); this.bolumler[b].push({ anahtar, deger, ofset: this.bolumler[b].length }); return b; }
}
// Tüketici grubu: her bölüm gruptaki tam olarak bir tüketiciye atanır (aralık ataması)
function ata(P, tuketiciler) {
  const atama = Object.fromEntries(tuketiciler.map((t) => [t, []]));
  for (let b = 0; b < P; b++) atama[tuketiciler[Math.floor((b * tuketiciler.length) / P)]].push(b);
  return atama;
}

// --- 1) Sıra: aynı anahtarın olayları aynı bölümde, sırayla
const konu = new Konu(6);
const musteriler = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
for (let i = 1; i <= 4; i++) for (const m of musteriler) konu.yaz(m, `${m}-olay${i}`);
console.log("1) bölümler (6 bölüm, 8 müşteri x 4 olay):");
konu.bolumler.forEach((b, i) => console.log(`   bölüm ${i}: ${[...new Set(b.map((x) => x.anahtar))].join(",").padEnd(12)} -> ${b.filter((x) => x.anahtar === b[0]?.anahtar).map((x) => x.deger.split("-")[1]).join(" ")} ...`));

// --- 2) Paralellik bölüm sayısıyla sınırlı
console.log("\n2) tüketici sayısı ve atama (6 bölüm):");
for (const n of [2, 3, 6, 8]) {
  const a = ata(6, Array.from({ length: n }, (_, i) => `t${i + 1}`));
  const bos = Object.values(a).filter((x) => x.length === 0).length;
  console.log(`   ${n} tüketici: ${Object.entries(a).map(([t, b]) => `${t}=[${b}]`).join(" ")}${bos ? `   <- ${bos} tüketici boşta` : ""}`);
}

// --- 3) Sıcak bölüm: anahtar dağılımı çarpık
const konu2 = new Konu(6);
for (let i = 0; i < 10000; i++) konu2.yaz(i % 10 < 4 ? "kiraci:dev" : `kiraci:${i % 997}`, i);   // isteklerin %40'ı tek kiracıdan
const boy = konu2.bolumler.map((b) => b.length);
console.log(`\n3) çarpık anahtar (%40 tek kiracı): bölüm boyları ${boy.join(" / ")}  -> en büyük/ortalama = ${(Math.max(...boy) / (10000 / 6)).toFixed(2)}`);

// --- 4) Ofset taahhüdü ve çökme: önce taahhüt -> kayıp, sonra taahhüt -> tekrar
function tuket(strateji, cokmeAni) {
  const olaylar = Array.from({ length: 10 }, (_, i) => i);
  let taahhut = 0; const islenen = [];
  // birinci çalışma: cokmeAni'ndaki olayda süreç çöker (işleme ile taahhüt arasında ya da öncesinde)
  for (let o = taahhut; o < olaylar.length; o++) {
    if (strateji === "once-taahhut") { taahhut = o + 1; if (o === cokmeAni) break; islenen.push(o); }
    else { islenen.push(o); if (o === cokmeAni) break; taahhut = o + 1; }
  }
  // yeniden başlama: son taahhüt edilen ofsetten devam
  for (let o = taahhut; o < olaylar.length; o++) { islenen.push(o); taahhut = o + 1; }
  const kayip = olaylar.filter((o) => !islenen.includes(o));
  const tekrar = islenen.filter((o, i) => islenen.indexOf(o) !== i);
  return `işlenen=[${islenen.join(",")}]  kayıp=[${kayip}]  tekrar=[${tekrar}]`;
}
console.log("\n4) 6 numaralı olayda çökme:");
console.log(`   önce taahhüt, sonra işle (en fazla bir kez):  ${tuket("once-taahhut", 6)}`);
console.log(`   önce işle, sonra taahhüt (en az bir kez):     ${tuket("sonra-taahhut", 6)}`);
```

```bash
node akis.mjs
```

```text
1) bölümler (6 bölüm, 8 müşteri x 4 olay):
   bölüm 0:              ->  ...
   bölüm 1: m6           -> olay1 olay2 olay3 olay4 ...
   bölüm 2:              ->  ...
   bölüm 3: m2,m3,m4,m7  -> olay1 olay2 olay3 olay4 ...
   bölüm 4: m1,m8        -> olay1 olay2 olay3 olay4 ...
   bölüm 5: m5           -> olay1 olay2 olay3 olay4 ...

2) tüketici sayısı ve atama (6 bölüm):
   2 tüketici: t1=[0,1,2] t2=[3,4,5]
   3 tüketici: t1=[0,1] t2=[2,3] t3=[4,5]
   6 tüketici: t1=[0] t2=[1] t3=[2] t4=[3] t5=[4] t6=[5]
   8 tüketici: t1=[0] t2=[1] t3=[2] t4=[] t5=[3] t6=[4] t7=[5] t8=[]   <- 2 tüketici boşta

3) çarpık anahtar (%40 tek kiracı): bölüm boyları 1030 / 1114 / 998 / 1108 / 4735 / 1015  -> en büyük/ortalama = 2.84

4) 6 numaralı olayda çökme:
   önce taahhüt, sonra işle (en fazla bir kez):  işlenen=[0,1,2,3,4,5,7,8,9]  kayıp=[6]  tekrar=[]
   önce işle, sonra taahhüt (en az bir kez):     işlenen=[0,1,2,3,4,5,6,6,7,8,9]  kayıp=[]  tekrar=[6]
```

## Sıra: sadece bölüm içinde

Bir olay akışı **küresel** bir sıra garanti etmez. Sadece **bölüm içindeki** sırayı garanti eder. Aynı anahtarın olayları her zaman aynı bölüme gittiği için, bir müşterinin olayları (`olay1 olay2 olay3 olay4`) yazıldığı sırayla okunur. Farklı müşterilerin olayları arasında ise bir sıra yoktur.

Tasarımın ilk sorusu bu yüzden şudur: **Hangi olayların birbirine göre sıralı olması gerekiyor?** Bir siparişin "oluşturuldu → ödendi → kargolandı" olayları sıralı olmalıdır, yani anahtar `siparis_id` olur. Bir hesabın bakiye hareketleri sıralı olmalıdır, anahtar `hesap_id` olur. Anahtarsız (rastgele bölüme giden) olaylarda sıra yoktur.

Çıktının ilk bölümünde bir ayrıntı daha var: 8 anahtar 6 bölüme dağıldı, ama 0 ve 2 numaralı bölümler **boş** kaldı, 3 numaralı bölüme ise 4 anahtar düştü. Az sayıda anahtarla özetleme dengeli dağılmaz. Dengeli dağılım, anahtar sayısı bölüm sayısından çok büyük olduğunda ortaya çıkar.

Sırayı bozan yaygın hatalar:

- **Bölüm sayısını artırmak:** `hash mod P` değişir, aynı anahtar artık başka bir bölüme gider. Geçiş sırasında eski bölümde işlenmemiş olaylar ile yeni bölümdeki olaylar arasındaki sıra kaybolur. Bölüm sayısı baştan cömert seçilir. Önceki dersteki "mod N" sorununun aynısıdır.
- **Üreticide yeniden deneme:** Bir mesaj başarısız olup yeniden gönderilirken, arkasındaki mesaj başarılı olursa sıra değişir. Kafka'da idempotent üretici (`enable.idempotence=true`, güncel istemcilerde varsayılan) bunu sıra numaralarıyla önler.
- **Tüketicide paralel işleme:** Tek bir bölümden okunan olayları bir iş parçacığı havuzunda paralel işlemek, sırayı bozar. Paralellik **anahtar bazında** yapılmalıdır: Aynı anahtarın olayları aynı iş parçacığına gider.

## Paralellik: bölüm sayısı bir tavandır

Bir tüketici grubunda her bölüm **tek bir** tüketiciye atanır. 6 bölümlü bir konuda 8 tüketici çalıştırmak, 2 tüketicinin **boşta** kalması demektir (çıktının ikinci bölümü). Bölüm sayısı, bir tüketici grubunun azami paralelliğidir. Tüketiciler yetişemiyorsa ve hepsi zaten bir bölüm alıyorsa, kopya eklemek hiçbir şey değiştirmez.

Bölüm sayısını belirlerken:

- **Hedef verim / tüketici başına verim.** Tek bir tüketici saniyede 500 olay işleyebiliyor ve tepe yük saniyede 6000 ise, en az 12 bölüm gerekir. Büyüme payıyla 24 ya da 48 seçilir.
- **Fazlası da maliyetlidir.** Her bölüm aracıda dosyalar, bellek ve çoğaltma trafiği demektir. Yeniden dengeleme ve lider seçimi bölüm sayısıyla yavaşlar. Binlerce küçük konu ve on binlerce bölüm, işletme sorunlarına yol açar.

**Yeniden dengeleme** (rebalance): Bir tüketici gruba katıldığında ya da ayrıldığında (dağıtım, çökme, otomatik ölçekleme), bölümler yeniden atanır. Eski "eager" protokolde bütün grup durur ve bütün bölümler bırakılıp yeniden alınır. Kubernetes'teki her kayan güncelleme (rolling update), birkaç saniyelik bir tüketim duraklaması demekti. Artımlı (cooperative/incremental) yeniden dengeleme ve statik üyelik (`group.instance.id`) sadece taşınması gereken bölümleri durdurur. Kafka 4'teki yeni tüketici grup protokolü (KIP-848) bu koordinasyonu aracı tarafına taşır.

## Sıcak bölüm

Anahtar dağılımı çarpıksa, örneğin büyük bir kiracı trafiğin %40'ını üretiyorsa, o anahtarın bölümü diğerlerinin neredeyse **üç katı** (2,84) büyür. O bölümü okuyan tüketici geride kalır, diğerleri boşta bekler. Gecikme, en yavaş bölüm kadardır. Çözümler:

- **Anahtarı inceltmek:** `kiraci_id` yerine `kiraci_id + siparis_id`. Kiracı seviyesindeki sıra kaybolur, sipariş seviyesindeki sıra korunur. Gerçekten hangi sıranın gerektiği sorusuna geri dönülür.
- **Sıcak anahtarı tuzlamak:** `kiraci:dev#0..7` gibi alt anahtarlara bölmek. Okuma tarafında birleştirme gerekir.
- **Büyük kiracıyı ayırmak:** Ayrı bir konu ya da ayrı bir tüketici grubu kullanmak. Veritabanı parçalamasındaki "sıcak parça" ile aynı çözüm.

## Ofset taahhüdü: kayıp mı, tekrar mı?

Tüketici bir olayı işledikten sonra "buraya kadar okudum" diye ofsetini **taahhüt eder** (commit). Çökme olduğunda yeniden başlayan tüketici (ya da bölümü devralan başka bir tüketici) son taahhüt edilen ofsetten devam eder. Taahhüdün **işlemeden önce mi sonra mı** yapıldığı sonucu belirler:

| Strateji | 6. olayda çökme | Garanti |
|---|---|---|
| Önce taahhüt, sonra işle | 6 hiç işlenmedi (**kayıp**) | En fazla bir kez |
| Önce işle, sonra taahhüt | 6 iki kez işlendi (**tekrar**) | En az bir kez |

Önceki dersin sonucu burada da geçerli. Kayıp kabul edilemiyorsa, tek seçenek **en az bir kez + idempotent tüketicidir**. Pratikte:

- **Otomatik taahhüt tuzağı:** Birçok istemcinin varsayılanı, ofsetleri arka planda belirli aralıklarla (örneğin 5 sn) taahhüt etmektir. Olay işleyici asenkronsa ve işleme taahhütten sonra bitiyorsa, fiilen "önce taahhüt" yapılmış olur ve çökmede olaylar sessizce kaybolur. Taahhüdü işleme tamamlandıktan sonra **elle** yap.
- **Toplu taahhüt:** Her olaydan sonra taahhüt etmek pahalıdır. Genellikle bir grup olay işlendikten sonra yapılır. Çökmede o grubun tamamı tekrar işlenir. İdempotency bu yüzden şarttır.
- **"Tam olarak bir kez" (EOS):** Kafka'nın işlemsel API'si, **Kafka'dan oku, işle, Kafka'ya yaz** zincirinde, okunan ofsetlerin ve yazılan çıktıların atomik olarak taahhüt edilmesini sağlar. Bu garanti Kafka'nın **içinde** geçerlidir. Bir veritabanına yazmak, e-posta göndermek ya da bir API çağırmak gibi dış yan etkiler kapsamın dışındadır. Bunlar için yine idempotency, ya da ofsetin iş verisiyle aynı veritabanı işleminde saklanması gerekir (önceki dersteki inbox).

## Tüketici gecikmesi ve saklama

Bir olay akışının en önemli metriği **tüketici gecikmesidir** (consumer lag): bölümdeki son ofset eksi tüketicinin taahhüt ettiği ofset. Önceki dersteki "en eski işin yaşı" ile aynı rolü oynar. Zamana çevrilmiş hali (gecikme / tüketim hızı) daha anlamlıdır: "Arama indeksi 4 dakika geride." Otomatik ölçekleme (KEDA'nın Kafka ölçekleyicisi) bu metriğe göre yapılır, tavan ise bölüm sayısıdır.

**Saklama süresi** ise bir güvenlik payıdır. Bir tüketici 3 gün durduysa ve saklama süresi 7 günse, kaldığı yerden devam eder. Saklama 1 günse, olaylar silinmiştir ve tüketici veri kaybeder. Sıkıştırılmış konular (compacted topics) her anahtarın sadece **son** değerini süresiz saklar. Bir tablonun güncel durumunu akış olarak dağıtmak için kullanılır: Yeni bir tüketici, konuyu baştan okuyarak durumun tamamını elde eder.

## Aracıda dayanıklılık

Üreticinin "yazdım" demesi, verinin ne kadar güvende olduğunu ayarlara bağlar. Kafka'da:

```properties
# konu ve aracı: her bölüm 3 kopya, en az 2'si güncel olmadan yazma kabul edilmez
replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
# üretici: lider ve bütün güncel kopyalar yazdı mı? sıra ve tekrar koruması
acks=all
enable.idempotence=true
```

`acks=1` (sadece lider) daha hızlıdır, ama lider yazdıktan hemen sonra çökerse ve kopyalar henüz almadıysa, onaylanmış olay kaybolur. `acks=all` ile `min.insync.replicas=2` birlikte, onaylanan her olayın en az iki kopyada olmasını garanti eder. Veritabanındaki senkron ve asenkron replikasyon takasının aynısıdır.

> **Not:** Bu bölümdeki Kafka ayarları ve davranışları Kafka belgelerine dayanıyor. Bu kursta çalışan bir Kafka kümesinde denenmedi. Bölüm, atama, sıcak bölüm ve ofset taahhüdü sonuçları yukarıdaki simülasyondan geliyor.

## Kuyruk mu, akış mı?

| | İş kuyruğu (önceki ders, RabbitMQ, SQS) | Olay akışı (Kafka, Kinesis) |
|---|---|---|
| Mesaj ömrü | Tüketilince silinir | Saklama süresi boyunca durur, tekrar okunabilir |
| Tüketiciler | Bir işi bir işçi alır | Her tüketici grubu bütün akışı okur |
| Paralellik | İşçi ekle | Bölüm sayısıyla sınırlı |
| Sıra | Genellikle yok (ya da tek tüketiciyle) | Bölüm içinde, anahtar bazında |
| Tek mesajda yeniden deneme | Doğal (kira, ölü mektup) | Zor: Bir olayda takılmak bütün bölümü durdurur. Ayrı bir yeniden deneme konusu ya da DLQ konusu gerekir |
| Tipik kullanım | Görevler: e-posta gönder, PDF üret | Olaylar: "sipariş oluşturuldu", birçok sistemin bağımsız tepkisi, CDC, analitik |

Akışın son satırdaki zayıflığı önemlidir. Bölüm içinde sıra garanti edildiği için, işlenemeyen bir olay o bölümdeki **bütün** olayları bekletir. Bu yüzden akış tüketicilerinde zehirli bir olay ya ayrı bir yeniden deneme konusuna ya da DLQ konusuna aktarılıp geçilir, ya da (sıra kritikse) alarm verilip bölüm bilinçli olarak durdurulur.

```quiz
{
  "question": "12 bölümlü bir Kafka konusunun tüketici grubunda 12 tüketici var ve tüketici gecikmesi sürekli artıyor. HPA tüketici sayısını 30'a çıkarıyor, ama gecikme değişmiyor. Neden ve ne yapılmalı?",
  "options": [
    "HPA yanlış metrik kullanıyor.",
    "Bir tüketici grubunda her bölüm tek bir tüketiciye atanır. 12 bölümde en fazla 12 tüketici çalışır, fazlası boşta kalır. Bölüm sayısını artırmak (anahtar-bölüm eşlemesinin değişeceğini ve geçişte sıranın etkileneceğini bilerek), tüketici başına işleme hızını artırmak ya da tüketici içinde anahtar bazında paralel işlemek gerekir.",
    "Kafka aracısı yavaş, aracı eklemek gerekir.",
    "Tüketicilerin otomatik taahhüdünü kapatmak gecikmeyi düzeltir."
  ],
  "answer": 1,
  "explanation": "Bölüm sayısı, tüketici grubu paralelliğinin tavanıdır. Bu derste 6 bölüm ve 8 tüketiciyle 2 tüketicinin boşta kaldığını gördük. Bölüm sayısı baştan büyüme payıyla seçilmelidir."
}
```

```quiz
{
  "question": "Bir tüketici, Kafka'dan aldığı olayları asenkron bir fonksiyonla veritabanına yazıyor. İstemci 'enable.auto.commit=true' ile her 5 saniyede ofset taahhüt ediyor. Bir pod çöktükten sonra bazı olayların veritabanına hiç yazılmadığı fark ediliyor. Neden?",
  "options": [
    "Kafka olayları sildi.",
    "Otomatik taahhüt, asenkron işleme bitmeden ofseti ilerletebilir. Çökme anında taahhüt edilmiş ama işlenmemiş olaylar, yeniden başlamada atlanır ('önce taahhüt' = en fazla bir kez). Taahhüt, işleme tamamlandıktan sonra elle yapılmalı ve tüketici idempotent olmalıdır.",
    "Veritabanı yazmaları sessizce başarısız oluyor.",
    "Yeniden dengeleme olayları siler."
  ],
  "answer": 1,
  "explanation": "Taahhüt zamanlaması teslim garantisini belirler. Bu dersteki simülasyonda 'önce taahhüt' stratejisi çökmede 6 numaralı olayı kaybetti, 'sonra taahhüt' ise onu iki kez işledi."
}
```

```lab
{
  "title": "Akış modelini simülasyonla incele",
  "steps": [
    "akis.mjs'teki müşteri sayısını 8'den 1000'e çıkar ve bölüm boylarının dağılımına bak. Kaç anahtardan sonra dağılım dengeleniyor?",
    "Konuyu 6'dan 8 bölüme çıkaran bir senaryo yaz: Bölüm değiştirdiği için sırası bozulabilecek anahtarların oranını hesapla (önceki dersteki mod N sonucuyla karşılaştır).",
    "Sıcak bölüm örneğinde 'kiraci:dev' anahtarını 8 alt anahtara tuzla (`kiraci:dev#${i % 8}`) ve en büyük/ortalama oranının nasıl değiştiğini ölç. Bu kiracının olayları için hangi sıra garantisi kayboldu?",
    "tuket() fonksiyonunu toplu taahhüde çevir: Her 4 olayda bir taahhüt et. 6 numaralı olayda çökmede kaç olayın tekrar işlendiğini göster.",
    "Bir önceki dersteki inbox tablosuyla birleştir: Tüketici olay kimliğini (bölüm + ofset) iş verisiyle aynı işlemde saklasın ve yeniden başlamada ofseti Kafka'dan değil bu tablodan okusun. Bu yaklaşımın neden 'tam olarak bir kez etki' sağladığını açıkla."
  ]
}
```

## Özet

- Olay akışı, saklanan ve birden çok tüketici grubunun bağımsız okuduğu bölümlenmiş bir günlüktür.
- Sıra sadece bölüm içindedir. Sıralı olması gereken olaylar aynı anahtarı paylaşmalıdır. Bölüm sayısını artırmak eşlemeyi değiştirir. Üreticide idempotency, tüketicide anahtar bazında paralellik kullanılır.
- Bölüm sayısı bir tüketici grubunun paralellik tavanıdır: 6 bölümde 8 tüketicinin 2'si boşta kaldı. Bölüm sayısını büyüme payıyla seç, yeniden dengeleme için artımlı protokol ve statik üyelik kullan.
- Çarpık anahtar sıcak bölüm yaratır (ortalamanın 2,84 katı). Anahtarı incelt, tuzla ya da büyük kiracıyı ayır.
- Önce taahhüt kayba, sonra taahhüt tekrara yol açar. Doğru seçim: işlemeden sonra elle taahhüt ve idempotent tüketici. Kafka EOS, dış yan etkileri kapsamaz.
- Tüketici gecikmesini (zaman olarak) izle ve ona göre ölçekle. Saklama süresi bir güvenlik payıdır. Dayanıklılık için `acks=all`, `min.insync.replicas=2` ve `replication.factor=3` kullan.
- Görevler için kuyruk, birçok sistemin tepki verdiği olaylar için akış uygundur. Akışta zehirli olay bütün bölümü bekletir.
