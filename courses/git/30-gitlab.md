# GitLab: projeler, yetkiler, korumalı dallar ve merge request'ler

Git dağıtık bir araçtır, ama ekipler bir merkez etrafında çalışır: kodun bulunduğu, incelemenin yapıldığı, pipeline'ların çalıştığı, kimin neye dokunabileceğinin belirlendiği yer. Bu bölümde o merkez **GitLab**. Bu ders GitLab'ın Git'in üzerine eklediği kontrol katmanını ele alıyor: grup ve proje yapısı, roller, korumalı dallar ve etiketler, merge request (MR) akışı ve otomasyon için kimlik bilgileri.

Bu bölümdeki ekranlar ve ayarlar GitLab.com'un ücretsiz katmanında ya da kendi kurduğun GitLab'da (Community Edition) bulunur. Bazı özellikler (çoklu onay kuralları, push kuralları gibi) ücretli katmanlardadır: Derste belirtiliyor.

```lab
GitLab.com: ücretsiz hesap
https://gitlab.com/users/sign_up
Bu bölümdeki alıştırmalar için kişisel bir grup ve deneme projesi oluştur. Ücretsiz katmanda paylaşımlı runner'lar üzerinde aylık CI dakikası verilir; kendi runner'ını bağlamak (runner dersi) dakika sınırını kaldırır.
```

## Gruplar, projeler ve roller

```text
sirket/                          ← üst grup: SSO, faturalama, genel ayarlar
├── platform/                    ← alt grup: ekip
│   ├── altyapi                  ← proje (bir Git deposu + issue'lar, MR'lar, CI, registry)
│   └── helm-sablonlari
└── odeme/
    ├── odeme-api
    └── fatura-servisi
```

Yetkiler yukarıdan aşağı miras alınır: `odeme` grubunda Developer olan biri, altındaki bütün projelerde Developer'dır. Bu yüzden yetkileri projeler yerine **gruplar** üzerinden yönet: Ekibe katılan kişi gruba eklenir, ayrılınca gruptan çıkarılır.

| Rol | Tipik yetkiler |
|---|---|
| Guest | Issue görmek ve açmak (özel projelerde kodu göremez) |
| Planner | Issue, epik ve planlama araçlarını yönetmek |
| Reporter | Kodu okumak, issue'ları yönetmek, pipeline'ları görmek |
| **Developer** | Dal oluşturmak, push etmek (korumasız dallara), MR açmak, pipeline çalıştırmak |
| **Maintainer** | Korumalı dallara merge, proje ayarları, CI değişkenleri, runner'lar |
| Owner | Grubu/projeyi silmek, üyelik ve faturalama |

En az yetki ilkesi (Oracle güvenlik dersindeki gibi): Geliştiricilerin çoğu Developer olmalı. Maintainer, korumalı dallara merge yetkisi ve **CI değişkenlerine (gizli bilgilere) erişim** demektir: Az sayıda kişiye verilmeli.

## Korumalı dallar ve etiketler

**Settings → Repository → Protected branches.** `main` için tipik ayar:

| Ayar | Değer | Sebep |
|---|---|---|
| Allowed to merge | Maintainers (ya da Developers + Maintainers) | Kim MR'ı birleştirebilir |
| Allowed to push and merge | **No one** | Doğrudan push yok: her değişiklik bir MR'dan geçer |
| Allowed to force push | **Kapalı** | Uzak depolar dersindeki zorla push felaketi imkânsız |
| Code owner approval | Açık (Premium) | CODEOWNERS'taki sahiplerin onayı zorunlu |

"Allowed to push: No one", ekibin en önemli tek ayarıdır: Bundan sonra `main`'e giren her satır bir merge request'ten, dolayısıyla bir incelemeden ve bir pipeline'dan geçer. Joker karakterli kurallar da yazılabilir: `release/*` gibi.

**Korumalı etiketler** (`v*`): Sadece Maintainer'ların (ya da sadece CI'ın) sürüm etiketi oluşturabilmesi. Etiket oluşturulduğunda yayın pipeline'ı çalışıyorsa (CI dersleri), etiket oluşturma yetkisi **üretime deploy etme** yetkisidir.

## Merge request akışı

```bash
git switch -c feat/odeme-iade
# ... değişiklikler, commit'ler ...
git push -u origin feat/odeme-iade
```

GitLab push çıktısında MR oluşturma bağlantısı verir. Push sırasında MR'ı doğrudan oluşturmak da mümkündür (GitLab'ın **push seçenekleri**):

```bash
git push -u origin feat/odeme-iade \
  -o merge_request.create \
  -o merge_request.target=main \
  -o merge_request.title="feat(odeme): kısmi iade ucu ekle" \
  -o merge_request.draft
```

İyi bir MR:

- **Küçük ve tek amaçlı** (akışlar dersi). Başlık, squash kullanılıyorsa `main`'deki commit mesajı olacağı için kurala uygun.
- **Açıklama** neyin değiştiğini, **neden** değiştiğini, nasıl test edildiğini ve inceleyenin özellikle bakması gereken yerleri anlatır. Bir proje MR şablonu (`.gitlab/merge_request_templates/Varsayilan.md`) bunu standartlaştırır.
- **İlgili issue'yu bağlar:** Açıklamadaki `Closes #123`, MR birleştirildiğinde issue'yu otomatik kapatır.
- Hazır değilse **Draft** olarak açılır: Erken geri bildirim alınır, yanlışlıkla birleştirilemez.
- **Hızlı eylemler** (quick actions) açıklamada ya da yorumda: `/assign @ayse`, `/label ~odeme`, `/milestone %"2026-Q4"`, `/draft`, `/ready`.

### İnceleme

- Yorumlar satırlara bağlanır ve **çözülmesi gereken tartışmalar** (threads) olarak işaretlenir. "All threads must be resolved" ayarıyla, açık bir tartışma varken birleştirme yapılamaz.
- **Öneriler** (suggestions): İnceleyen, değişikliği doğrudan önerir. Yazar tek tıkla commit olarak uygular:

````text
```suggestion:-0+0
    timeout_sn = 10
```
````

- İnceleme turlarında düzeltmeleri `--fixup` commit'leri olarak itmek, inceleyenin "son incelemeden beri ne değişti?" sorusunu kolaylaştırır. GitLab'ın "Changes since last review" görünümü bunu da gösterir. Birleştirmeden önce autosquash ya da squash ile temizlenir.

### Birleştirme koşulları

**Settings → Merge requests:**

- **Merge method:** Merge commit / Merge commit with semi-linear history / Fast-forward merge (akışlar dersi). "Semi-linear": Merge commit oluşturulur ama dal önce `main`'in üzerinde olmalıdır (rebase gerekir): Hem gruplanmış hem doğrusal okunabilen geçmiş.
- **Squash commits when merging:** Do not allow / Allow / Encourage / Require.
- **Pipelines must succeed:** Pipeline başarısızsa birleştirme düğmesi kapalıdır. Bu ayar olmadan CI sadece bir öneridir.
- **All threads must be resolved.**
- **Delete source branch** varsayılan olarak işaretli: Birleşen dallar birikmez.
- **Onaylar:** Ücretsiz katmanda isteğe bağlı onay; Premium'da zorunlu onay sayısı, CODEOWNERS onayı, "yazarın kendi MR'ını onaylayamaması", "yeni commit gelince onayların sıfırlanması".

**Merge when pipeline succeeds** (auto-merge): İnceleme bitti ama pipeline sürüyorsa, "pipeline başarılı olunca birleştir" denir ve beklenmez. **Merge trains** (Premium): Birden çok MR sıraya girer, her biri öncekilerle birlikte test edilir. Sık birleştirilen `main` dallarında "iki MR ayrı ayrı yeşildi ama birlikte kırıldı" sorununu çözer.

## Otomasyon için kimlik bilgileri

İnsan hesaplarıyla otomasyon yapılmaz: Kişi ayrılınca otomasyon bozulur, ve kişinin bütün yetkileri otomasyona geçer.

| Kimlik | Kapsam | Ne için |
|---|---|---|
| **CI_JOB_TOKEN** | Sadece pipeline süresince, otomatik | CI'dan aynı ya da izin verilen projelere erişim, registry'ye push |
| **Deploy token** | Bir proje ya da grup; registry/depo okuma/yazma | Kubernetes'in registry'den imaj çekmesi, harici sistemlerin klonlaması |
| **Deploy key** | Bir SSH anahtarı, bir ya da birkaç proje, salt okunur ya da yazma | Sunucuların depoyu klonlaması |
| **Project/Group access token** | Proje ya da grup üzerinde bir rol ve kapsam, son kullanma tarihli | API otomasyonu, botlar |
| Personal access token | Kişinin bütün yetkileri | Sadece kişisel kullanım; otomasyonda değil |

Her jeton için: **en dar kapsam** (`read_registry` yeterliyse `api` verme), **son kullanma tarihi** (GitLab artık en fazla bir yıl ile sınırlar), ve bir secret manager'da saklama. GitLab, herkese açık projelere push edilen kendi jetonlarını tespit edip otomatik iptal eder (secret detection), ama diğer sağlayıcıların anahtarları için bunu yapamaz.

## Alıştırma

1. Yeni bir proje için korumalı dal ve MR ayarlarını öneren bir kontrol listesi yaz. Ekipte 6 geliştirici ve 2 kıdemli var.
2. Bir geliştirici "acil bir düzeltme için `main`'e doğrudan push etmem lazım, korumayı kaldırır mısın?" diyor. Ne önerirsin?
3. Kubernetes kümesinin GitLab registry'deki özel imajları çekmesi gerekiyor. Hangi kimlik bilgisini, hangi kapsamla oluşturursun?

<details><summary>Çözüm</summary>

1. `main`: push → No one, merge → Maintainers (2 kıdemli) ya da Developers + Maintainers (onay kuralı varsa), force push kapalı. MR: Pipelines must succeed, All threads must be resolved, Delete source branch, merge yöntemi ekibin seçimi (örneğin squash: Require ya da Encourage), en az 1 onay ve yazarın kendi onayı sayılmaz (Premium). Etiketler: `v*` korumalı, sadece Maintainer'lar. 6 Developer, 2 Maintainer; CI değişkenleri Maintainer'larda. CODEOWNERS ile kritik dizinler (deploy, veritabanı migration'ları) kıdemlilerin onayına bağlı.

2. Korumayı kaldırma. Acil düzeltme de bir MR'dan geçer, ama hızlandırılmış olarak: Küçük bir MR, pipeline'ın sadece gerekli kısmı (ya da tamamı; acil durumda kırık bir düzeltmeyi deploy etmek daha kötü), ve hızlı bir onay. Pipeline'ın kendisi acil bir düzeltme için çok yavaşsa sorun pipeline'dadır, ve o ayrıca düzeltilmelidir. Gerçekten acil durumlar için bir "break glass" prosedürü yazılı olmalı (kim, nasıl, sonrasında nasıl gözden geçirilir), ve doğrudan push kayıtları denetlenmeli.

3. Bir **deploy token** (projede ya da imajların bulunduğu grupta), sadece `read_registry` kapsamıyla ve son kullanma tarihli. Kubernetes'te bir `docker-registry` türünde Secret olarak saklanır ve pod'ların `imagePullSecrets`'ında kullanılır (Kubernetes kursu). Asla kişisel bir jeton ya da `write_registry` kapsamı değil.

</details>

```quiz
`main` dalı için "Allowed to push and merge: No one" ayarı neyi sağlar?
- Kimse main'e merge edemez
- [x] Doğrudan push mümkün değildir; her değişiklik bir merge request'ten (inceleme ve pipeline'dan) geçer
- Sadece Owner push edebilir
? Merge yetkisi ayrıca "Allowed to merge" ile verilir.
```

```quiz
"Pipelines must succeed" ayarı olmadan ne olur?
- Pipeline'lar çalışmaz
- [x] Pipeline başarısız olsa bile MR birleştirilebilir; CI sadece bir öneri olur
- MR'lar otomatik birleştirilir
? Kontrollerin zorunlu olması için birleştirme koşulu olarak ayarlanmalıdır.
```

```quiz
Bir Kubernetes kümesinin GitLab registry'den imaj çekmesi için hangi kimlik bilgisi uygundur?
- Bir geliştiricinin kişisel erişim jetonu
- [x] Sadece read_registry kapsamlı, süreli bir deploy token
- Maintainer kullanıcı adı ve parolası
? Otomasyon kişisel hesaplarla yapılmaz; en dar kapsam ve son kullanma tarihi.
```

## Özet

- Grup → alt grup → proje; yetkiler miras alınır, gruplar üzerinden yönet. Roller: Developer çoğunluk, Maintainer az (korumalı dallar ve CI gizli bilgileri).
- Korumalı dallar: push "No one", force push kapalı; korumalı etiketler (etiket = sürüm = deploy yetkisi).
- MR: küçük, açıklamalı, `Closes #n`, Draft, quick actions; çözülmesi gereken tartışmalar, öneriler, fixup'lar.
- Birleştirme koşulları: merge yöntemi, squash, pipelines must succeed, threads resolved, onaylar, auto-merge, merge trains.
- Otomasyon: CI_JOB_TOKEN, deploy token/key, proje/grup jetonları; en dar kapsam, son kullanma tarihi, secret manager. Kişisel jetonlar otomasyonda kullanılmaz.
