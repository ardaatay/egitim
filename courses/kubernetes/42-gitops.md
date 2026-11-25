# GitOps: Argo CD ile dağıtım

Docker kursunun CI dersinde **push tabanlı** deploy gördük: CI, sunucuya bağlanıp değişikliği uygular. Kubernetes'te bunun karşılığı, CI'ın `kubectl apply` ya da `helm upgrade` çalıştırmasıdır. İşe yarar, ama sorunları var: CI'ın kümeye yönetici erişimi olur, kümede elle yapılan değişiklikler (drift) fark edilmez, "şu an kümede ne çalışıyor?" sorusunun cevabı CI loglarına dağılmıştır.

**GitOps** bunu tersine çevirir: İstenen durumun tek kaynağı bir **git deposudur**. Küme içinde çalışan bir ajan (**Argo CD** ya da **Flux**) depoyu sürekli izler ve kümeyi depodaki hâle getirir. Mimari dersindeki uzlaştırma döngüsünün, git'i istenen durum olarak kullanan hâli.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
Bu derste GitHub'da herkese açık bir depo kullanacağız. Kendi deponla denemek için GitHub hesabın yeterli.
```

## İlkeler

1. **Bildirimsel**: Sistemin tamamı manifest'lerle tanımlanır (önceki derslerdeki Kustomize/Helm).
2. **Sürümlü ve değişmez**: İstenen durum git'tedir. Her değişiklik bir commit: kim, ne zaman, neden.
3. **Çekme (pull) tabanlı**: Küme içindeki ajan değişikliği çeker. Dışarıdan kümeye erişim gerekmez.
4. **Sürekli uzlaştırma**: Ajan farkı (drift) algılar ve düzeltir ya da raporlar.

```text
 Geliştirici ──PR──▶ uygulama deposu ──CI──▶ imaj (ghcr.io/...:sha-4f9c2e1)
                                                │
                                                └──▶ CI, yapılandırma deposunda imaj etiketini günceller (commit/PR)
                                                              │
 Kümede Argo CD ◀───────izler───────────────── yapılandırma deposu (Kustomize/Helm)
     │
     └──▶ kubectl apply eşdeğeri (sadece fark), sağlık durumu, drift tespiti
```

Yaygın düzen iki depo: **uygulama deposu** (kod, Dockerfile, CI) ve **yapılandırma deposu** (ortam overlay'leri). Böylece kod commit'leri ile deploy geçmişi ayrışır ve yapılandırma deposuna yazma yetkisi deploy yetkisi anlamına gelir.

## Argo CD kurulumu

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deploy/argocd-server --timeout=300s
kubectl -n argocd get pods
```

Bileşenler: `argocd-server` (API ve web arayüzü), `argocd-repo-server` (depoları çeker, Helm/Kustomize çıktısını üretir), `argocd-application-controller` (uzlaştırma döngüsü), `argocd-redis` (önbellek), `argocd-applicationset-controller`, `argocd-dex-server` (SSO).

CLI ve ilk giriş:

```bash
curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
chmod +x /usr/local/bin/argocd
kubectl -n argocd patch svc argocd-server -p '{"spec":{"type":"NodePort","ports":[{"name":"https","port":443,"targetPort":8080,"nodePort":30843}]}}'
PAROLA=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)
argocd login localhost:30843 --username admin --password "$PAROLA" --insecure
argocd version --short
```

(Web arayüzünü görmek istersen Killercoda'nın port açma menüsünden 30843'ü aç. İlk girişten sonra admin parolasını değiştirip `argocd-initial-admin-secret`'ı silmek önerilir.)

## İlk uygulama

Argo CD'nin kendi örnek deposunu kullanalım (herkese açık, Kustomize ve Helm örnekleri içerir):

```bash
cat > app.yaml <<'EOF'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: guestbook
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: HEAD
    path: kustomize-guestbook
  destination:
    server: https://kubernetes.default.svc
    namespace: guestbook
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
EOF
kubectl apply -f app.yaml
sleep 10
argocd app get guestbook
```

Durum `OutOfSync`: Argo CD depodaki istenen durumu okudu, kümede henüz yok. Otomatik senkronizasyon kapalı olduğu için bekliyor.

```bash
argocd app diff guestbook | head -20
argocd app sync guestbook
argocd app wait guestbook --health --timeout 120
argocd app get guestbook
kubectl -n guestbook get all
```

Artık `Synced` ve `Healthy`.

İki ayrı durum var:

| Durum | Anlamı |
|---|---|
| **Sync status** (`Synced` / `OutOfSync`) | Kümedeki nesneler depodaki tanımla aynı mı? |
| **Health status** (`Healthy` / `Progressing` / `Degraded` / `Missing`) | Nesneler gerçekten çalışıyor mu? (Deployment rollout'u bitti mi, Pod'lar hazır mı) |

Bir uygulama `Synced` ama `Degraded` olabilir: Tanım uygulandı, ama Pod'lar CrashLoopBackOff'ta.

## Drift: elle değişiklik

GitOps'un en güçlü yanlarından biri: Kümede elle yapılan değişiklikleri fark etmesi.

```bash
kubectl -n guestbook scale deploy kustomize-guestbook-ui --replicas=5
sleep 5
argocd app get guestbook | grep -E 'Sync Status|Health'
argocd app diff guestbook
```

`OutOfSync`: Argo CD, kümedeki replika sayısının depodakinden farklı olduğunu gördü. Şimdi otomatik senkronizasyonu ve **kendi kendini iyileştirmeyi** açalım:

```bash
argocd app set guestbook --sync-policy automated --self-heal --auto-prune
sleep 15
kubectl -n guestbook get deploy
kubectl -n guestbook scale deploy kustomize-guestbook-ui --replicas=5
sleep 15
kubectl -n guestbook get deploy
```

Replika sayısı her seferinde depodaki değere geri döndü.

| Ayar | Anlamı |
|---|---|
| `automated` | Depoda değişiklik olunca otomatik senkronize et (varsayılan olarak yaklaşık 3 dakikada bir kontrol, webhook ile anında) |
| `selfHeal` | Kümede elle yapılan değişiklikleri de geri al |
| `prune` | Depodan **silinen** nesneleri kümeden de sil. Kapalıyken silinen nesneler kümede yetim kalır |

> `selfHeal` açıkken acil bir durumda `kubectl edit` ile yapılan değişiklik dakikalar içinde geri alınır. Bu bilinçli bir tasarım: Değişiklik git'ten yapılmalı. Gerçek bir acil durumda uygulamanın otomatik senkronizasyonu geçici olarak kapatılır (`argocd app set guestbook --sync-policy none`), sonra değişiklik git'e işlenip tekrar açılır.

HPA kullanan Deployment'larda `replicas` alanı Argo CD ile HPA arasında sürekli çekişmeye yol açar. Çözüm: manifest'ten `replicas`'ı kaldırmak ya da Application'da `ignoreDifferences` ile bu alanı yok saymak.

## Kendi deponla tam akış

Kendi GitHub hesabında (örneğin `egitim-gitops` adında, herkese açık) bir depo oluşturup önceki dersteki Kustomize yapısını koy:

```text
egitim-gitops/
└── siparis/
    ├── base/          (önceki dersteki dosyalar)
    └── overlays/
        ├── staging/
        └── uretim/
```

Her ortam için bir Application:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: siparis-staging
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/<kullanici>/egitim-gitops.git
    targetRevision: main
    path: siparis/overlays/staging
  destination:
    server: https://kubernetes.default.svc
    namespace: staging
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true]
```

Deploy akışı artık şöyle:

1. Uygulama deposunda CI imajı build eder ve `sha-4f9c2e1` etiketiyle gönderir (Docker kursu).
2. CI, yapılandırma deposunda `overlays/staging/kustomization.yaml` içindeki `newTag` alanını günceller ve commit eder (ya da bir PR açar).
3. Argo CD değişikliği görür ve staging'i senkronize eder.
4. Üretime geçiş: aynı etiketi `overlays/uretim`'e yazan bir **PR**. Onay ve birleştirme = deploy. Geri alma = `git revert`.

Docker kursundaki deploy betiğinin SSH anahtarı, sudo kuralı ve kilit dosyasının hiçbiri gerekmez: CI'ın kümeye hiç erişimi yoktur, sadece bir depoya yazar.

Bu adımı otomatikleştiren araçlar da var: **Argo CD Image Updater** ve **Flux'un image automation** denetleyicileri, registry'deki yeni etiketleri izleyip yapılandırma deposuna kendileri commit atar.

## Diğer önemli Argo CD kavramları

| Kavram | Ne için |
|---|---|
| **AppProject** | Hangi depolardan, hangi kümelere ve namespace'lere, hangi nesne türlerinin dağıtılabileceğini sınırlar (ekip bazlı yetki) |
| **ApplicationSet** | Şablondan çok sayıda Application üretir: her ortam, her küme, depodaki her klasör ya da her açık PR için (önizleme ortamları) |
| **App of Apps** | Bir Application'ın, diğer Application tanımlarını içeren bir klasörü yönetmesi: bütün kümenin yapılandırmasını tek bir kökten kurmak |
| **Sync waves ve hook'lar** | `argocd.argoproj.io/sync-wave` ile sıralama (önce namespace ve CRD'ler, sonra uygulama), `PreSync` hook'uyla migration Job'ı |
| **Çoklu küme** | Tek bir Argo CD birden fazla kümeyi yönetebilir (`argocd cluster add`) |

### Argo CD mi, Flux mi?

İkisi de CNCF'in mezun (graduated) projeleri ve aynı modeli uygular. **Argo CD** zengin bir web arayüzü, uygulama merkezli bir görünüm ve kolay başlangıç sunar. **Flux** daha modüler, tamamen CRD ve CLI tabanlıdır, arayüzü yoktur (üçüncü taraf arayüzler var). Ekiplerin çoğu için Argo CD daha hızlı benimsenir.

## Gizli bilgiler

Git her şeyin kaynağıysa Secret'lar nerede? ConfigMap/Secret dersindeki seçenekler burada zorunlu hâle gelir: **Sealed Secrets** (şifreli Secret git'te), **SOPS** (Argo CD eklentisi ya da Flux'un yerleşik desteğiyle) ya da **External Secrets Operator** (git'te sadece referans, değer Vault/bulut gizli bilgi yöneticisinde). Düz Secret YAML'ı yapılandırma deposuna asla girmez.

## Temizlik

```bash
argocd app delete guestbook --yes
kubectl delete namespace guestbook --ignore-not-found
```

Argo CD'yi bir sonraki derslerde kullanmak istersen bırakabilirsin.

## Alıştırma

1. Kendi GitHub hesabında herkese açık bir depo oluştur, Kustomize dersindeki `siparis` yapısını koy ve `siparis/overlays/staging` için bir Application tanımla. Otomatik senkronizasyonu aç.
2. Depoda `overlays/staging/replika.yaml`'daki replika sayısını değiştirip commit et. Kümeye ne kadar sürede yansıdı? (`argocd app get` ve `kubectl get deploy -n staging -w`)
3. Bir commit'te bilerek var olmayan bir imaj etiketi yaz. Argo CD'deki sync ve health durumları ne gösteriyor? `git revert` ile geri al.

<details><summary>Beklenen sonuçlar</summary>

2: Varsayılan yoklama aralığı yaklaşık 3 dakika. Anında yansıması için GitHub'da depoya bir webhook (`https://<argocd-adresi>/api/webhook`) eklenir, ya da `argocd app sync` ile elle tetiklenir.

3: Sync `Synced` olur (tanım uygulandı), ama health `Progressing` ve süre dolunca `Degraded`: yeni Pod `ImagePullBackOff`'ta. Deployment dersindeki `maxUnavailable: 0` sayesinde eski Pod'lar çalışmaya devam eder. `git revert` ve push sonrası Argo CD eski etiketi uygular ve uygulama tekrar `Healthy` olur. Geri almanın kaydı git geçmişinde kalır.

</details>

```quiz
GitOps'ta CI'ın kümeye doğrudan erişimi neden gerekmez?
- CI zaten küme içinde çalışır
- [x] Küme içindeki ajan (Argo CD/Flux) git deposunu izler ve değişiklikleri kendisi uygular. CI sadece depoyu günceller
- CI, kubeconfig'i git'e koyar
? Çekme tabanlı model, kümeye dışarıdan yönetici erişimi verme ihtiyacını ortadan kaldırır.
```

```quiz
`selfHeal` açık bir uygulamada `kubectl scale` ile replika sayısını değiştirdin. Ne olur?
- Değişiklik kalıcı olur
- [x] Argo CD farkı algılar ve replika sayısını depodaki değere geri döndürür
- Uygulama silinir
? Kalıcı değişiklik git'ten yapılmalı. HPA ile çakışmayı önlemek için replicas alanı manifest'ten çıkarılır ya da ignoreDifferences kullanılır.
```

```quiz
Argo CD'de bir uygulama `Synced` ama `Degraded`. Bu ne anlama gelir?
- Depo erişilemez
- [x] Tanımlar kümeye uygulandı, ama kaynaklar sağlıklı değil (örneğin Pod'lar çalışmıyor)
- Elle değişiklik yapıldı
? Sync durumu tanım farkını, health durumu gerçek çalışma durumunu gösterir.
```

## Özet

- GitOps: git tek kaynak, küme içi ajan çeker ve sürekli uzlaştırır. CI kümeye erişmez.
- Argo CD Application: `source` (repo, path, revision) → `destination` (küme, namespace).
- Sync (tanım farkı) ve health (çalışma durumu) ayrı. `automated`, `selfHeal`, `prune`.
- Deploy = yapılandırma deposunda imaj etiketini değiştiren commit/PR. Geri alma = `git revert`.
- AppProject, ApplicationSet, App of Apps, sync wave ve hook'lar.
- Gizli bilgiler: Sealed Secrets, SOPS, External Secrets. Düz Secret git'e girmez.
