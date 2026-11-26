# Tehdit modelleme: varlıklar, güven sınırları ve STRIDE

Güvenlik açıklarının çoğu yazılırken değil, **tasarlanırken** oluşur: Kimin neye eriştiği, hangi verinin nereden geçtiği, hangi bileşenin hangisine güvendiği hiç sorulmamıştır. Tehdit modelleme bu soruları kod yazılmadan önce, sistematik olarak sormaktır. Bu derste bütün kurs boyunca kullanacağımız örnek sistemi, diğer kurslarda kurduğumuz **deploy platformunu**, tehdit modelleme yöntemiyle inceliyoruz.

Tehdit modellemenin dört sorusu (Adam Shostack'ın çerçevesi):

1. **Ne inşa ediyoruz?** (sistemin modeli)
2. **Ne ters gidebilir?** (tehditler)
3. **Bununla ilgili ne yapacağız?** (önlemler)
4. **İyi bir iş çıkardık mı?** (doğrulama)

## 1. Ne inşa ediyoruz? Veri akış diyagramı

Örnek sistem: Geliştiricilerin bir web paneli üzerinden deploy başlattığı, durumunu izlediği bir platform.

```text
                 ┌─────────────────────── İnternet ──────────────────────────┐
  Geliştirici ──▶│ Tarayıcı (React SPA)                                       │
  (insan)        └──────────────┬─────────────────────────────────────────────┘
                                │ HTTPS  (1)
        ═══════════ güven sınırı A: internet / şirket ağı ════════════════════
                                ▼
                      ┌──────────────────┐   OIDC (2)   ┌──────────────────┐
                      │ Ingress + API    │◀────────────▶│ Kimlik sağlayıcı │
                      │ (deploy-api)     │              │ (SSO)            │
                      └────┬───────┬─────┘              └──────────────────┘
               SQL (3)     │       │ Kubernetes API (4)
        ══════ güven sınırı B: uygulama / veri ══════   ═══ sınır C: küme yönetimi ═══
                           ▼       ▼
                 ┌──────────────┐ ┌────────────────────┐
                 │ Oracle       │ │ Kubernetes kümesi  │◀── GitLab CI (5): imaj, deploy
                 │ (deploylar,  │ │ (uygulama pod'ları)│
                 │  kullanıcılar)│ └────────────────────┘
                 └──────────────┘
```

Diyagramın öğeleri:

- **Dış varlıklar** (kontrol etmediğin şeyler): geliştirici, tarayıcısı, kimlik sağlayıcı.
- **Süreçler**: deploy-api, GitLab CI.
- **Veri depoları**: Oracle, container registry, Kubernetes'in etcd'si.
- **Veri akışları**: numaralı oklar.
- **Güven sınırları**: Verinin bir güven seviyesinden diğerine geçtiği yerler. Tehditlerin çoğu bu çizgilerde yaşar: İnternetten gelen bir istek, API'ye geçtiğinde "güvenilmeyen" veridir, veritabanına gittiğinde "veritabanının çalıştıracağı" bir şeydir.

Diyagramın mükemmel olması gerekmez. Bir tahtaya çizilmiş, ekibin üzerinde anlaştığı bir resim, hiç olmamasından çok daha değerlidir.

## Varlıklar: neyi koruyoruz?

| Varlık | Neden değerli | Kaybedilirse |
|---|---|---|
| Kümeye deploy yetkisi | Üretimde istenen kodu çalıştırmak | Tam sistem ele geçirme |
| Kullanıcı hesapları ve oturumlar | Başkası adına işlem yapmak | Yetkisiz deploy, veri erişimi |
| Veritabanındaki veriler (deploy geçmişi, kullanıcılar) | Kişisel veri, iş bilgisi | Gizlilik ihlali, KVKK bildirimi |
| Gizli bilgiler (veritabanı parolası, registry jetonu, kubeconfig) | Diğer her şeyin anahtarı | Zincirleme ele geçirme |
| Servisin erişilebilirliği | Deploy'lar ve geri alma yapılabilmeli | Olay anında müdahale edememek |
| Denetim kayıtları | Kim neyi ne zaman yaptı | Olayı anlayamamak, sorumluluk belirsizliği |

Varlıkları sıralamak, sınırlı güvenlik bütçesinin nereye harcanacağını belirler. Bu sistemde en değerli varlık açıkça **kümeye deploy yetkisi**: Onu ele geçiren her şeyi ele geçirir.

## 2. Ne ters gidebilir? STRIDE

STRIDE, her öğe için sorulacak altı tehdit kategorisidir:

| Kategori | İhlal edilen özellik | Soru | Örnek |
|---|---|---|---|
| **S**poofing (kimliğe bürünme) | Kimlik doğrulama | Biri başkası gibi davranabilir mi? | Çalınmış bir oturum çerezi |
| **T**ampering (kurcalama) | Bütünlük | Veri ya da kod değiştirilebilir mi? | Bir istekte `sunucu_id`'yi değiştirmek, registry'deki imajı değiştirmek |
| **R**epudiation (inkâr) | İnkâr edilemezlik | Biri yaptığını inkâr edebilir mi? | Denetim kaydı yoksa "o deploy'u ben yapmadım" |
| **I**nformation disclosure (bilgi sızması) | Gizlilik | Yetkisiz biri veriyi görebilir mi? | Hata mesajında yığın izi, loglarda parola |
| **D**enial of service (hizmet engelleme) | Erişilebilirlik | Sistem kullanılamaz hale getirilebilir mi? | Sınırsız boyutlu istek, pahalı bir sorguyu tekrar tekrar çağırmak |
| **E**levation of privilege (yetki yükseltme) | Yetkilendirme | Biri sahip olmadığı yetkiyi kazanabilir mi? | Normal kullanıcının admin uç noktasını çağırması |

Her öğe ve akış için uygulanabilir kategorileri sor. Örnek sistemden seçilmiş tehditler:

| # | Öğe | STRIDE | Tehdit | Mevcut önlem |
|---|---|---|---|---|
| T1 | Akış 1 (tarayıcı→API) | S | Oturum çerezinin XSS ile çalınması | ? |
| T2 | deploy-api | E | Developer rolündeki birinin `/api/deploy?ortam=production` çağırması | ? |
| T3 | deploy-api | T | Bir kullanıcının başka bir ekibin sunucusuna deploy için `sunucu_id`'yi değiştirmesi (IDOR) | ? |
| T4 | Akış 3 (API→Oracle) | T, I | Arama parametresiyle SQL enjeksiyonu | Bind değişkenleri (Oracle kursu) |
| T5 | deploy-api | I | Hata yanıtlarında yığın izi ve SQL metni | ? |
| T6 | Akış 4 (API→küme) | E | API'nin kube kimlik bilgisinin çalınması, kümede her şeyi yapabilmesi | ? |
| T7 | GitLab CI | T | Bir bağımlılığın ele geçirilmesi, build sırasında zararlı kod | ? |
| T8 | GitLab CI | E | Bir özellik dalından production gizli bilgilerine erişim | Korumalı değişkenler ve runner'lar (GitLab kursu) |
| T9 | deploy-api | D | Bir kullanıcının dakikada binlerce deploy isteği göndermesi | ? |
| T10 | Bütün sistem | R | Bir production deploy'unu kimin başlattığının belli olmaması | ? |
| T11 | Kullanıcı tablosu | I | Veritabanı yedeğinin sızması, parolaların okunması | ? |

`?` olan her satır, bu kursun bir dersine karşılık geliyor. T1 XSS dersinde, T2 ve T3 yetkilendirme dersinde, T11 parola saklama dersinde ele alınacak.

Tehdit bulmak için başka yardımcılar da var: **Saldırı ağaçları** (bir hedefe giden yolların ağacı: "production'a zararlı kod deploy etmek" → "geliştiricinin hesabını ele geçir" | "CI'ı ele geçir" | "registry'deki imajı değiştir"), **kötüye kullanım hikâyeleri** ("bir saldırgan olarak, başka bir ekibin sunucusuna deploy etmek istiyorum"), ve MITRE ATT&CK gibi gerçek saldırı teknikleri katalogları.

## 3. Ne yapacağız? Risk ve karar

Her tehdit aynı önemde değildir. Basit bir risk değerlendirmesi: **olasılık × etki**.

| # | Olasılık | Etki | Risk | Karar |
|---|---|---|---|---|
| T2 | Yüksek (tek bir unutulan kontrol yeter) | Kritik (production) | **Kritik** | Düzelt: sunucu tarafında rol kontrolü, testle |
| T3 | Yüksek | Yüksek | **Yüksek** | Düzelt: her istekte kaynak sahipliği kontrolü |
| T6 | Orta | Kritik | **Yüksek** | Düzelt: API'ye sadece kendi namespace'lerinde, sadece `deployments/patch` yetkisi |
| T9 | Orta | Orta | Orta | Düzelt: kullanıcı başına hız sınırı |
| T10 | Yüksek | Orta | Orta | Düzelt: denetim kaydı, kim/ne/ne zaman |
| T5 | Yüksek | Düşük | Düşük | Düzelt (ucuz): genel hata mesajı, ayrıntı sadece logda |

Her tehdit için dört seçenek var:

- **Azalt** (mitigate): önlem al. En yaygın.
- **Ortadan kaldır** (eliminate): özelliği kaldır ya da değiştir. "API'nin kümeye doğrudan erişimi olmasın, GitOps kullanalım" (T6'yı tamamen ortadan kaldırır).
- **Aktar** (transfer): başkasına devret (kimlik doğrulamayı bir SSO sağlayıcısına, ödeme verilerini bir ödeme kuruluşuna).
- **Kabul et** (accept): bilinçli olarak, yazılı ve bir sahibi olan bir kararla. "Kabul ettik" demek "unuttuk" demekle aynı şey değildir: Kabul edilen risk kayıt altına alınır ve belirli aralıklarla tekrar gözden geçirilir.

## 4. İyi bir iş çıkardık mı?

- Her "düzelt" kararı bir iş kaydına, mümkünse bir **teste** dönüşmeli: "Developer rolüyle production deploy isteği 403 döner" bir otomatik testtir, ve bir sonraki değişiklikte kontrolün kaldırılmasını yakalar.
- Tehdit modeli canlı bir belgedir: Yeni bir veri akışı, yeni bir dış bağımlılık, yeni bir güven sınırı eklendiğinde güncellenir. Pratik bir kural: Mimariyi değiştiren her MR'da "tehdit modeli etkileniyor mu?" sorusu, MR şablonunda bir satır olsun.
- Saldırı testleri (sızma testi, güvenlik testi dersi) modelin varsayımlarını sınar: Modelde olmayan bir saldırı yolu bulunursa, model eksiktir.

## Pratikte tehdit modelleme

Ağır süreçler kimsenin uygulamadığı süreçlerdir. Hafif ve tekrarlanabilir bir uygulama:

- **Ne zaman:** Yeni bir servis, yeni bir dış entegrasyon, kimlik/yetki/ödeme/kişisel veriye dokunan bir özellik, ya da bir güven sınırını değiştiren bir mimari değişiklik.
- **Kim:** Özelliği geliştiren ekip, mümkünse bir güvenlik bakış açısı olan biriyle. Bir saatlik bir oturum.
- **Çıktı:** Bir diyagram, bir tehdit tablosu, kararlar ve iş kayıtları. Deponun içinde (`docs/tehdit-modeli.md`), kodla birlikte sürümlenen.
- Araçlar: Tahta yeterlidir. Daha yapılandırılmış isteyenler için OWASP Threat Dragon, Microsoft Threat Modeling Tool, ya da diyagramları kod olarak tutan araçlar.

## Alıştırma

1. Örnek sisteme yeni bir özellik ekleniyor: "Deploy tamamlanınca, kullanıcının verdiği bir webhook adresine bir HTTP bildirimi gönderilecek." Diyagramda ne değişir? Bu özellik için en az üç STRIDE tehdidi yaz.
2. T6 için "ortadan kaldır" seçeneğini (GitOps) ve "azalt" seçeneğini (dar RBAC) karşılaştır. Hangisini seçerdin?

<details><summary>Çözüm</summary>

1. Yeni bir veri akışı: deploy-api'den **kullanıcının belirlediği bir adrese** giden bir HTTP isteği. Bu, güven sınırını tersinden geçen bir akış: Sunucu, bir saldırganın seçtiği adrese istek atıyor. Tehditler:
   - **SSRF (E, I):** Webhook adresi `http://169.254.169.254/latest/meta-data/` (bulut metadata servisi) ya da `http://oracle-db.internal:1521` gibi bir iç adres verilir, API iç ağa saldırganın adına istek atar ve yanıtı (ya da yanıt süresini) sızdırır. SSRF dersinin konusu.
   - **Bilgi sızması (I):** Bildirim yükü, deploy'la ilgili gereğinden fazla bilgi (iç adresler, commit mesajları, gizli değişken adları) içerir.
   - **Hizmet engelleme (D):** Webhook adresi çok yavaş yanıt veren bir sunucuya işaret eder ve API'nin iş parçacıkları/bağlantıları tükenir. Zaman aşımı ve eşzamanlılık sınırı gerekir.
   - **Kurcalama/kimliğe bürünme (T, S):** Alıcı, bildirimin gerçekten bu platformdan geldiğini nasıl bilecek? Bildirim bir HMAC imzasıyla imzalanmalı (kriptografi dersi).

2. GitOps tehdidi **ortadan kaldırır**: API'nin kümeye hiç erişimi yoktur, sadece bir Git deposuna yazar. Kümedeki GitOps aracının kendi yetkileri vardır ama o bir saldırı yüzeyi olarak çok daha küçüktür (dışarıdan istek almaz). Bedeli: mimari değişikliği ve deploy'un birkaç saniye yerine bir senkronizasyon döngüsü sürmesi. Dar RBAC tehdidi **azaltır**: Kimlik bilgisi çalınsa bile saldırgan sadece belirli namespace'lerdeki deployment'ların imajını değiştirebilir, ki bu hâlâ "o servislerde istediği kodu çalıştırmak" demektir. Kritik bir varlık için ortadan kaldırmak genellikle daha iyi bir yatırımdır. Kısa vadede ise ikisi birlikte uygulanabilir: hemen dar RBAC, planlı olarak GitOps'a geçiş.

</details>

```quiz
Tehdit modellemede "güven sınırı" nedir?
- Güvenlik duvarının bulunduğu yer
- [x] Verinin bir güven seviyesinden diğerine geçtiği yer; tehditlerin çoğu bu geçişlerde oluşur
- Şifrelenmiş bağlantı
? İnternetten API'ye, API'den veritabanına ve CI'dan kümeye geçişler örnek güven sınırlarıdır.
```

```quiz
STRIDE'daki "R" (Repudiation) tehdidine karşı tipik önlem hangisidir?
- Şifreleme
- [x] Değiştirilemez denetim kayıtları: kim, ne, ne zaman
- Hız sınırlama
? Kayıt yoksa bir işlemi kimin yaptığı inkâr edilebilir ve olay anlaşılamaz.
```

```quiz
Bir riski "kabul etmek" doğru şekilde nasıl yapılır?
- Hiçbir şey yapmayarak
- [x] Yazılı, bir sahibi olan ve belirli aralıklarla tekrar gözden geçirilen bilinçli bir kararla
- Riski gizleyerek
? Kabul edilen risk kayıt altına alınır; unutulan risk kabul edilmiş değildir.
```

## Özet

- Dört soru: ne inşa ediyoruz, ne ters gidebilir, ne yapacağız, iyi iş çıkardık mı.
- Veri akış diyagramı: dış varlıklar, süreçler, veri depoları, akışlar ve **güven sınırları**.
- Varlıkları sırala: güvenlik bütçesi en değerli varlığa.
- STRIDE: kimliğe bürünme, kurcalama, inkâr, bilgi sızması, hizmet engelleme, yetki yükseltme.
- Risk = olasılık × etki; azalt, ortadan kaldır, aktar ya da yazılı olarak kabul et.
- Kararlar iş kayıtlarına ve testlere dönüşür; model kodla birlikte yaşar, hafif ve tekrarlanabilir tutulur.
