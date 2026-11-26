# Konteyner, Kubernetes ve bulut güvenliği

Uygulama katmanında yaptığımız her şey, altındaki platform kadar güvenlidir. Uygulamadaki bir RCE açığının sonucunu, uygulamanın **nerede ve hangi yetkilerle** çalıştığı belirler. Sonuç, tek bir konteynerde salt okunur bir dosya sistemi de olabilir, bütün bulut hesabı da. Bu ders, Docker ve Kubernetes kurslarındaki yapı taşlarını bir saldırganın gözüyle yeniden ele alıyor: Ele geçirilen bir konteynerden **nereye kadar gidilebilir**?

## Konteyner: varsayılanlar cömerttir

Yerelde zaten bulunan `nginx:alpine` imajıyla, aynı küçük betiği üç farklı ayarla çalıştıralım. Betik kimliğe, yetkilere (capabilities), dosya sistemine ve cihazlara bakıyor:

```bash
S='echo "kimlik: $(id)"; echo "CapEff: $(grep CapEff /proc/self/status | cut -f2)";
   echo "NoNewPrivs: $(grep NoNewPrivs /proc/self/status | cut -f2)";
   (echo x > /usr/share/nginx/html/index.html && echo "kök dosya sistemine yazma: BAŞARILI") 2>/dev/null || echo "kök dosya sistemine yazma: REDDEDİLDİ";
   (echo x > /tmp/a && echo "/tmp yazma: BAŞARILI") 2>/dev/null || echo "/tmp yazma: REDDEDİLDİ";
   echo "/dev girdi sayısı: $(ls /dev | wc -l)"'

docker run --rm --entrypoint sh nginx:alpine -c "$S"
docker run --rm --entrypoint sh --user 65534:65534 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 64m nginx:alpine -c "$S"
docker run --rm --entrypoint sh --privileged nginx:alpine -c "$S"
```

```text
##### varsayılan
kimlik: uid=0(root) gid=0(root) groups=0(root),0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel),11(floppy),20(dialout),26(tape),27(video)
CapEff: 00000000a80425fb
NoNewPrivs: 0
kök dosya sistemine yazma: BAŞARILI
/tmp yazma: BAŞARILI
/dev girdi sayısı: 15
##### sıkılaştırılmış
kimlik: uid=65534(nobody) gid=65534(nobody) groups=65534(nobody)
CapEff: 0000000000000000
NoNewPrivs: 1
kök dosya sistemine yazma: REDDEDİLDİ
/tmp yazma: BAŞARILI
/dev girdi sayısı: 15
##### --privileged
kimlik: uid=0(root) gid=0(root) groups=0(root),0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel),11(floppy),20(dialout),26(tape),27(video)
CapEff: 000001ffffffffff
NoNewPrivs: 0
kök dosya sistemine yazma: BAŞARILI
/tmp yazma: BAŞARILI
/dev girdi sayısı: 158
```

`CapEff` bir bit maskesidir. Çözüldüğünde:

```text
00000000a80425fb 14 CHOWN DAC_OVERRIDE FOWNER FSETID KILL SETGID SETUID SETPCAP NET_BIND_SERVICE NET_RAW SYS_CHROOT MKNOD AUDIT_WRITE SETFCAP
000001ffffffffff 41 CHOWN DAC_OVERRIDE DAC_READ_SEARCH ... NET_ADMIN ... SYS_MODULE SYS_RAWIO ... SYS_PTRACE ... SYS_ADMIN ... BPF CHECKPOINT_RESTORE
```

Üç ayarın farkı şöyle:

- **Varsayılan:** root olarak ve 14 yetkiyle çalışır. `NET_RAW` ile ham paket gönderebilir, ARP sahteciliği yapabilir. `DAC_OVERRIDE` ile dosya izinlerini yok sayar. Dosya sistemine yazabildiği için saldırgan araçlarını indirip kalıcı hale getirebilir. Konteyner sınırı hâlâ vardır, ama çekirdekte bir açık (container escape) bulunduğunda root olmak işi kolaylaştırır.
- **Sıkılaştırılmış:** Ayrıcalıksız kullanıcı, sıfır yetki ve `no_new_privs` (setuid ikili dosyaları yetki kazandırmaz). Kök dosya sistemi salt okunurdur. Yazılabilir tek yer `noexec` bağlanmış küçük bir `/tmp`'dir, yani oraya indirilen ikili dosya çalıştırılamaz.
- **`--privileged`:** 41 yetkinin tamamı açık, ayrıca ana makinenin bütün cihazları (158 girdi) görünür. `SYS_ADMIN` ve cihaz erişimiyle ana makinenin diskini bağlamak, çekirdek modülü yüklemek ya da cgroup üzerinden ana makinede komut çalıştırmak bilinen ve kolay yollardır. **Ayrıcalıklı konteyner, ana makinede root demektir.** Aynı şey `/var/run/docker.sock` bağlanmış konteyner için de geçerlidir: Soket üzerinden `--privileged` yeni bir konteyner başlatılabilir.

### Kaynak limitleri de güvenliktir

`--pids-limit` olmadan bir süreç bombası (fork bomb) ana makinenin süreç tablosunu doldurur, yani **komşu** konteynerleri de etkiler. Limitle denendiğinde:

```bash
docker run -d --rm --name pids-deneme --pids-limit 32 --entrypoint sleep nginx:alpine 120
docker exec pids-deneme sh -c 'while :; do sleep 120 & done'
docker stats --no-stream --format '{{.PIDs}}' pids-deneme
```

```text
sh: can't fork: Resource temporarily unavailable
31
```

Döngü 32. süreçte durdu, etkisi konteynerin içinde kaldı. Bellek limiti (`--memory`) ve CPU limiti de aynı mantıkla bir **hizmet dışı bırakma** sınırıdır. Kubernetes'teki `resources.limits` bu sınırları uygular.

## İmaj: katmanlar unutmaz

Bir Dockerfile, derleme için gereken bir sırrı (özel kayıt defteri jetonu) kopyalıyor, kullanıyor ve "temizlik" için siliyor:

```dockerfile
FROM nginx:alpine
COPY .npmrc /root/.npmrc
RUN echo "bağımlılıklar kuruldu (npm ci burada çalışırdı)" && rm /root/.npmrc
COPY index.html /usr/share/nginx/html/
```

```bash
docker run --rm --entrypoint sh egitim-katman:deneme -c 'ls -la /root/.npmrc'
docker save egitim-katman:deneme -o imaj.tar && tar -xf imaj.tar
for f in $(find blobs -type f); do
  tar -tf "$f" 2>/dev/null | grep -q '^root/.npmrc$' && { echo "bulundu: $f"; tar -xOf "$f" root/.npmrc; }
done
```

```text
ls: /root/.npmrc: No such file or directory
bulundu: blobs/sha256/492466774ae80be67a9b6dd23e331728742a6cc4263577551389aad78b8643f5
NPM_TOKEN=npm_ornekGizli123
```

Son imajda dosya yok, ama `COPY` adımının katmanında **olduğu gibi duruyor**. İmajı çekebilen herkes sırrı okur. Bu kişiler kayıt defterine erişimi olan herkestir, imaj yanlışlıkla herkese açık bir depoya gittiyse de bütün dünyadır. `RUN rm` sadece yeni bir katmanda "silindi" işareti koyar.

Doğru yöntem, Docker kursunda gördüğümüz BuildKit sır bağlamasıdır. Sır, sadece o `RUN` adımı süresince bir dosya olarak görünür ve hiçbir katmana yazılmaz:

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --ignore-scripts
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t odeme-api .
```

İmaj hijyeninin geri kalanı:

- **En küçük taban:** distroless ya da `scratch` gibi, kabuğu ve paket yöneticisi olmayan imajlar. Saldırganın kullanacağı araç yoksa, RCE'nin bir sonraki adımı zorlaşır. Ayrıca tarayıcıların bulduğu CVE sayısı da düşer.
- **Çok aşamalı derleme:** Derleyiciler, test araçları ve kaynak kod son imaja girmez.
- **Özetle sabitleme ve tarama:** Taban imaj `@sha256:` ile sabitlenir. Trivy ve Grype gibi tarayıcılar CI'da ve kayıt defterinde **sürekli** çalışır, çünkü dün temiz olan imaj bugün yayımlanan bir CVE ile etkilenir.
- **İmza ve doğrulama:** Önceki ders.

## Kubernetes: saldırganın yolu

Bir pod'da RCE elde eden saldırganın tipik adımları, savunmanın da haritasıdır:

| Saldırganın adımı | Nasıl | Önlem |
|---|---|---|
| Servis hesabı jetonunu okumak | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Gerekmiyorsa `automountServiceAccountToken: false`. Gerekiyorsa en az yetki |
| API'de ne yapabileceğine bakmak | `kubectl auth can-i --list` | RBAC'ta tehlikeli fiilleri tanı (aşağıda) |
| Komşu servislere ulaşmak | Küme içi DNS ile Redis, veritabanı, iç paneller | NetworkPolicy: varsayılan reddet |
| Bulut kimliğine ulaşmak | `169.254.169.254` metadata servisi | IMDSv2 ve hop limiti 1, metadata için NetworkPolicy, iş yükü kimliği (IRSA / Workload Identity) |
| Düğüme kaçmak | Ayrıcalıklı pod, `hostPath: /`, `hostPID`, `hostNetwork` | Pod Security Admission `restricted` |
| Kalıcılık | Yeni bir DaemonSet, CronJob ya da webhook | RBAC, admission politikaları, denetim logu ve alarm |

### Güvenli varsayılanlar: bir şablon

Aşağıdaki manifest, bu dersin ve önceki derslerin önerilerini bir araya getiriyor. YAML olarak doğrulandı, canlı bir kümeye uygulanmadı:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: odeme
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: odeme-api
  namespace: odeme
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: odeme-api
  namespace: odeme
spec:
  replicas: 3
  selector:
    matchLabels: { app: odeme-api }
  template:
    metadata:
      labels: { app: odeme-api }
    spec:
      serviceAccountName: odeme-api
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: api
          image: registry.sirket.com/platform/odeme-api@sha256:9f2c4e7d0b1a8c3e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e
          ports: [{ containerPort: 8080 }]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { memory: 256Mi }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
            - { name: sirlar, mountPath: /var/run/secrets/app, readOnly: true }
      volumes:
        - name: tmp
          emptyDir: { medium: Memory, sizeLimit: 16Mi }
        - name: sirlar
          secret: { secretName: odeme-api-sirlar, defaultMode: 0400 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: varsayilan-reddet
  namespace: odeme
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: odeme-api
  namespace: odeme
spec:
  podSelector:
    matchLabels: { app: odeme-api }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: ingress-nginx }
      ports: [{ port: 8080 }]
  egress:
    - to:
        - podSelector:
            matchLabels: { app: odeme-db }
      ports: [{ port: 5432 }]
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports: [{ port: 53, protocol: UDP }, { port: 53, protocol: TCP }]
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: cikis-vekili }
      ports: [{ port: 3128 }]
```

Bu şablondaki seçimlerin gerekçeleri:

- **Pod Security Admission `restricted`:** Ad alanı seviyesinde, kurallara uymayan pod'ları **reddeder**. Bu şablondaki ayarların hepsi zaten bu profilin gerektirdikleridir. Böylece bir geliştiricinin `privileged: true` eklemesi uygulama aşamasında durdurulur.
- **İki NetworkPolicy:** İlki ad alanındaki her şeyi her iki yönde kapatır. İkincisi sadece gerekeni açar: ingress denetleyicisinden gelen trafik, veritabanı, DNS ve dışarıya çıkış için **sadece** çıkış vekili. SSRF dersindeki çıkış kısıtlamasının küme karşılığı budur. NetworkPolicy'yi uygulayan bir CNI (Calico, Cilium) olmadan bu nesneler **sessizce etkisizdir**. Kurulumdan sonra gerçekten trafik engellendiğini bir testle doğrula.
- **Sırlar dosya olarak:** Salt okunur ve `0400` izinli birim olarak bağlanır, ortam değişkeni olarak verilmez (önceki ders).
- **Bellek limiti var, CPU limiti yok:** Bu kasıtlı. CPU limiti kısıtlamaya (throttling) ve gecikme sıçramalarına yol açar. Bellek limiti ise sınırsız büyümeyi durdurur. Yüksek Trafik kursunda bu dengeyi ayrıntılı ele alacağız.

### RBAC'ta tehlikeli yetkiler

Bazı yetkiler, adları masum göründüğü halde fiilen **küme yöneticiliğine** eşittir:

| Yetki | Neden tehlikeli |
|---|---|
| `create pods` (herhangi bir ad alanında) | Ayrıcalıklı ya da `hostPath: /` bağlanmış bir pod oluşturup düğümü ele geçirmek. Ad alanındaki **bütün servis hesaplarının** jetonuyla pod çalıştırmak |
| `get/list secrets` | Bütün sırlar, diğer servis hesaplarının jetonları da dahil. `list`, `get` kadar güçlüdür |
| `create pods/exec`, `pods/attach` | Çalışan pod'larda komut çalıştırmak, onların sırlarını ve kimliklerini kullanmak |
| `escalate`, `bind` (roles) | Sahip olmadığı yetkileri kendine vermek |
| `impersonate` | Başka bir kullanıcı ya da grup (örneğin `system:masters`) gibi davranmak |
| `nodes/proxy` | Kubelet API'si üzerinden düğümdeki her pod'da komut çalıştırmak |
| `patch/update` webhook yapılandırmaları | Her API isteğini kendi kontrolündeki bir sunucuya yönlendirmek |
| CSR `approve` + `create` | Kendine istenen gruplarla istemci sertifikası çıkarmak |

CI/CD'nin dağıtım hesabı genellikle en geniş yetkili hesaptır. Mümkünse **GitOps** (Argo CD, Flux) kullan: Küme, Git'teki durumu kendisi çeker, CI'ın kümeye yazma yetkisi olmaz. Böylece CI'ın ele geçirilmesi doğrudan küme yetkisine dönüşmez.

### Kontrol düzlemi ve tespit

- **API sunucusu internete açık olmamalı.** Yönetilen kümelerde özel uç nokta ya da IP izin listesi kullan.
- **etcd'de sır şifrelemesi** KMS sağlayıcısıyla açılır. Yönetilen kümelerde bu bir ayardır.
- **Denetim logu (audit log):** Kim, hangi kaynağı, ne zaman değiştirdi? Özellikle `secrets` okumaları, `pods/exec`, RBAC değişiklikleri ve yeni admission webhook'ları alarm kaynağıdır.
- **Çalışma zamanı tespiti:** Falco ya da Tetragon (eBPF) gibi araçlar konteyner içinde beklenmeyen davranışları yakalar: kabuk başlatılması, `/etc/shadow` okunması, beklenmeyen dış bağlantı. Distroless bir imajda "kabuk başlatıldı" alarmı neredeyse hiç yanlış pozitif üretmez.

## Bulut: kimlik yeni çevre sınırıdır

Bulutta güvenlik sınırı ağ değil, **kimlik ve yetkidir** (IAM). Büyük bulut sızıntılarının çoğu bir açıktan değil, bir **yapılandırma hatasından** gelir.

| Hata | Sonuç | Önlem |
|---|---|---|
| Uzun ömürlü erişim anahtarları (`AKIA...`) Git'te, CI değişkeninde, dizüstünde | Sızıntıda kalıcı erişim | İş yükü kimliği ve OIDC federasyonu (CI → bulut). İnsanlar için SSO ve kısa ömürlü oturum |
| Geniş yetkili roller (`*:*`, `AdministratorAccess`) | Tek bir uygulama açığı bütün hesaba dönüşür | En az yetki. Erişim analizörleri (IAM Access Analyzer, Recommender) ile kullanılmayan yetkileri bulup daraltma |
| Herkese açık depolama (S3 kovası, blob) | Yedekler ve loglar internete açılır | Hesap seviyesinde "herkese açık erişimi engelle", sadece CDN ile ve imzalı URL'lerle sunma |
| IMDSv1 açık | SSRF ile rol kimlik bilgileri çalınır (SSRF dersi) | IMDSv2 zorunlu, hop limiti 1 |
| Denetim logu kapalı ya da uygulama hesabında | Olay sonrasında hiçbir şey bilinmez, saldırgan logu siler | CloudTrail / Audit Logs ayrı bir **log hesabına**, değiştirilemez (object lock) |
| Elle yapılan değişiklikler | Yapılandırma kayması, incelenmemiş güvenlik grupları | Altyapı kod olarak (Terraform/OpenTofu), MR ile inceleme, CI'da checkov/tfsec/trivy config taraması |

Kuruluş seviyesinde **koruma rayları**, tek tek hesapların yanlış yapılandırılmasını sınırlar. AWS'de SCP'ler, GCP'de organizasyon politikaları ve Azure Policy ile şu kurallar konabilir: "Bu bölgelerin dışında kaynak açılamaz", "denetim logu kapatılamaz", "herkese açık kova oluşturulamaz". Bunlar, bir hesabın yöneticisinin bile aşamayacağı kurallardır. Kubernetes'teki admission politikalarının bulut karşılığıdır.

Bulut güvenlik duruşu araçları (CSPM: Security Hub, Security Command Center, Defender for Cloud ya da açık kaynak Prowler) bu kontrolleri sürekli tarar. Bulguları zafiyet taramasında olduğu gibi önceliklendirmek gerekir. "Herkese açık + hassas veri + internete açık işlem gücü" kombinasyonu, tek başına bir "MFA kapalı test hesabı" bulgusundan çok daha acildir.

```quiz
{
  "question": "Bir ekip, log toplama ajanının çalışabilmesi için bir DaemonSet'e `hostPath: /var/run/docker.sock` bağlıyor ve 'sadece log okuyor' diyor. Risk nedir?",
  "options": [
    "Risk yok. Soket sadece okuma için kullanılıyor.",
    "Docker soketine erişim, Docker API'sine tam erişimdir. Ajan ele geçirilirse `--privileged` ve ana makine kökünü bağlayan yeni bir konteyner başlatılabilir, yani her düğümde root elde edilir. Ajan bir DaemonSet olduğu için bu bütün düğümler demektir.",
    "Sadece performans etkisi olur.",
    "Docker soketi Kubernetes'te çalışmaz, bu yüzden risk yok."
  ],
  "answer": 1,
  "explanation": "Unix soketinde okuma ve yazma diye bir ayrım yoktur. API'ye erişen her şeyi yapabilir. Log toplama için konteyner runtime'ının log dosyalarını salt okunur bağlamak ya da CRI uyumlu araçlar kullanmak gerekir. Pod Security restricted, hostPath'i zaten reddeder."
}
```

```quiz
{
  "question": "Bir geliştiriciye 'sadece kendi ad alanında pod oluşturabilsin' diye `create pods` yetkisi veriliyor, `get secrets` yetkisi verilmiyor. Bu ad alanında yüksek yetkili bir CI servis hesabı da var. Geliştirici ne yapabilir?",
  "options": [
    "Sadece kendi pod'larını oluşturabilir, sırlara erişemez.",
    "`serviceAccountName` alanına CI servis hesabını yazan bir pod oluşturur. Pod'un içinden o hesabın jetonunu okur ve onun yetkileriyle hareket eder. Ayrıca sırları birim olarak bağlayan bir pod ile `get secrets` olmadan sırları okuyabilir.",
    "Pod Security Admission bunu her durumda engeller.",
    "Hiçbir şey. Servis hesabı jetonları sadece yöneticilere görünür."
  ],
  "answer": 1,
  "explanation": "create pods, ad alanındaki bütün servis hesaplarının ve sırların fiilen kullanılabilmesi demektir. Yüksek yetkili hesapları ayrı ad alanlarına koy, admission politikasıyla hangi servis hesaplarının kullanılabileceğini kısıtla ve geliştirici yetkilerini GitOps üzerinden ver."
}
```

```lab
{
  "title": "Bir konteynerden ne kadar uzağa gidilir?",
  "steps": [
    "Kendi uygulama imajını bu dersteki betikle üç ayarda çalıştır: varsayılan, sıkılaştırılmış ve `--read-only --cap-drop ALL --user`. Uygulama sıkılaştırılmış ayarda çalışıyor mu? Çalışmıyorsa hangi dizine yazmaya ya da hangi yetkiye ihtiyaç duyuyor? Bunları tek tek ekle.",
    "Bir imajının `docker history --no-trunc` çıktısını ve `docker save` ile katmanlarını incele. Herhangi bir katmanda `.npmrc`, `.env`, `id_rsa` ya da `*.pem` var mı?",
    "Bir Kubernetes kümen varsa (kind veya k3d ile yerel bir küme de olur): Bu dersteki manifesti uygula, ardından ad alanına `privileged: true` içeren bir pod göndermeyi dene ve reddedildiğini gör. Bir test pod'u ile veritabanı dışındaki bir servise bağlanmayı dene ve NetworkPolicy'nin trafiği engellediğini doğrula.",
    "Bir kümede `kubectl auth can-i --list --as=system:serviceaccount:<ad-alani>:default` ile varsayılan servis hesaplarının yetkilerini incele. Bu dersteki tehlikeli yetkiler tablosundan herhangi biri var mı?",
    "Bulut hesabında (ya da Terraform kodunda) uzun ömürlü erişim anahtarlarını, `*` içeren IAM politikalarını ve herkese açık erişime izin veren depolama yapılandırmalarını listele. Bir CSPM aracının (örneğin Prowler) çıktısını önceliklendir."
  ]
}
```

## Özet

- Konteyner varsayılanları cömerttir: root, 14 yetki, yazılabilir dosya sistemi. Sıkılaştırma bunları kapatır: root olmayan kullanıcı, `cap-drop ALL`, `no-new-privileges`, salt okunur kök ve `noexec` tmp, süreç ve bellek limitleri. Ayrıcalıklı konteyner ve Docker soketi, ana makinede root demektir.
- İmaj katmanları silinen dosyaları saklar. Derleme sırlarını `--mount=type=secret` ile ver. Küçük taban, çok aşamalı derleme, özetle sabitleme ve sürekli tarama uygula.
- Kubernetes'te saldırganın yolu: servis hesabı jetonu, komşu servisler, metadata ve düğüm. Önlemler: `automountServiceAccountToken: false`, varsayılan reddeden NetworkPolicy (ve bunu uygulayan CNI), Pod Security `restricted`, en az yetkili RBAC.
- `create pods`, `list secrets`, `pods/exec`, `escalate/bind/impersonate` ve `nodes/proxy` fiilen yönetici yetkisidir. CI'ın kümeye yazma yetkisini GitOps ile kaldır.
- Bulutta sınır kimliktir: uzun ömürlü anahtar yerine federasyon, en az yetki, IMDSv2, herkese açık depolama engeli, ayrı log hesabında değiştirilemez denetim logu, altyapı kod olarak ve kuruluş seviyesinde koruma rayları.
