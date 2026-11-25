# ConfigMap ve Secret

Docker kursunda "aynı imaj, farklı yapılandırma" ilkesini ve gizli bilgilerin neden ortam değişkeninde durmaması gerektiğini görmüştük. Kubernetes'te yapılandırma **ConfigMap**, gizli bilgi **Secret** nesnelerinde tutulur ve Pod'lara ortam değişkeni ya da dosya olarak verilir. Bu derste ikisini, aralarındaki gerçek farkı (beklediğinden az) ve en çok şaşırtan davranışı (değişiklik Pod'a ne zaman yansır?) göreceğiz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## ConfigMap oluşturmak

```bash
kubectl create configmap uygulama-ayar \
  --from-literal=LOG_LEVEL=info \
  --from-literal=ORTAM=staging \
  --dry-run=client -o yaml

mkdir -p ayar && cat > ayar/nginx.conf <<'EOF'
server {
    listen 80;
    location /health { return 200 "ok\n"; }
    location / { return 200 "ortam: $ortam\n"; }
    set $ortam "staging";
}
EOF
echo "ozellik_x=acik" > ayar/flags.properties
kubectl create configmap web-ayar --from-file=ayar/ --dry-run=client -o yaml | head -20
```

Bildirimsel hâli:

```bash
cat > cm.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: uygulama-ayar
data:
  LOG_LEVEL: "info"
  ORTAM: "staging"
  MAX_BAGLANTI: "20"          # değerler her zaman metin: sayıları tırnakla
  uygulama.yaml: |
    ozellikler:
      yeni_odeme: true
    zaman_asimi_sn: 30
EOF
kubectl apply -f cm.yaml
kubectl describe configmap uygulama-ayar
```

Her anahtar ya kısa bir değer (ortam değişkeni için) ya da bir dosyanın içeriği (dosya olarak bağlamak için) olabilir. ConfigMap'in boyut sınırı 1 MiB'dir: büyük veriler için uygun değildir.

## Pod'a vermenin üç yolu

```bash
cat > pod-cm.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: cm-deneme
spec:
  containers:
    - name: uygulama
      image: busybox:1.36
      command: ["sh", "-c", "env | grep -E 'LOG|ORTAM|BAGLANTI|SEVIYE'; echo ---; ls -l /ayar; cat /ayar/uygulama.yaml; sleep 3600"]
      env:
        - name: SEVIYE                    # 1) tek anahtar, farklı adla
          valueFrom:
            configMapKeyRef:
              name: uygulama-ayar
              key: LOG_LEVEL
      envFrom:                            # 2) bütün anahtarlar ortam değişkeni olarak
        - configMapRef:
            name: uygulama-ayar
      volumeMounts:                       # 3) dosya olarak
        - name: ayar
          mountPath: /ayar
          readOnly: true
  volumes:
    - name: ayar
      configMap:
        name: uygulama-ayar
        items:                            # sadece seçilen anahtarlar (verilmezse hepsi)
          - key: uygulama.yaml
            path: uygulama.yaml
EOF
kubectl apply -f pod-cm.yaml
kubectl wait --for=condition=Ready pod/cm-deneme
kubectl logs cm-deneme
```

- `envFrom` ile bütün anahtarlar ortama geldi. Ortam değişkeni adı olamayacak anahtarlar (`uygulama.yaml` gibi nokta içerenler) **atlanır** (olay olarak raporlanır).
- Volume olarak bağlanınca her anahtar bir dosya oldu.

### Dosya olarak bağlamanın ayrıntıları

```bash
kubectl exec cm-deneme -- ls -la /ayar
```

Dosyalar aslında `..data` adlı bir klasöre işaret eden **symlink**'ler. Kubernetes güncellemeyi atomik yapmak için yeni içeriği yeni bir klasöre yazıp `..data` symlink'ini çevirir: Linux kursundaki release klasörleri ve `mv -T` yönteminin aynısı.

Bir volume'ü bir klasöre bağlamak o klasörün **içeriğini gizler** (Docker kursundaki bind mount davranışı). `/etc/nginx/conf.d` gibi bir klasöre tek bir dosya eklemek istiyorsan `subPath` kullanılır:

```yaml
volumeMounts:
  - name: ayar
    mountPath: /etc/nginx/conf.d/default.conf
    subPath: nginx.conf
```

Ama `subPath` ile bağlanan dosyalar ConfigMap güncellendiğinde **güncellenmez** (aşağıda).

## Değişiklik Pod'a ne zaman yansır?

En çok karıştırılan konu:

| Nasıl verildi | ConfigMap değişince |
|---|---|
| Ortam değişkeni (`env`, `envFrom`) | **Hiçbir zaman** (Pod yeniden oluşturulana kadar). Linux kursundaki "ortam süreç başlarken okunur" kuralı |
| Volume (dosya) | Birkaç saniye ile ~1-2 dakika içinde dosya güncellenir (kubelet senkronizasyonu) |
| Volume + `subPath` | **Hiçbir zaman** |

Dosya güncellense bile, uygulamanın dosyayı yeniden okuması gerekir: çoğu uygulama ayarı sadece açılışta okur.

```bash
kubectl patch configmap uygulama-ayar -p '{"data":{"LOG_LEVEL":"debug","uygulama.yaml":"ozellikler:\n  yeni_odeme: false\n"}}'
sleep 60
kubectl exec cm-deneme -- sh -c 'echo "ortam: $LOG_LEVEL"; echo "dosya:"; cat /ayar/uygulama.yaml'
```

Ortam değişkeni hâlâ `info`, dosya güncellenmiş.

Pratikte iki yaygın yöntem:

1. **Değişiklikte yeniden başlat**: ConfigMap'i güncelledikten sonra `kubectl rollout restart deployment/x`. Ya da daha iyisi, ConfigMap içeriğinin özetini Pod şablonuna bir annotation olarak koymak (`checksum/config: <sha256>`): İçerik değişince şablon değişir ve Deployment otomatik rolling update yapar. Helm şablonlarında yaygın bir kalıp.
2. **Değişmez ConfigMap'ler**: Her değişiklikte yeni adla yeni bir ConfigMap (`uygulama-ayar-v2` ya da içeriğin özetiyle `uygulama-ayar-7f3c9a`) oluşturup Deployment'ı ona çevirmek. Değişiklik normal bir rollout olur, **geri alınabilir** ve eski Pod'lar eski ayarla çalışmaya devam eder. Kustomize'ın `configMapGenerator`'ı bunu otomatik yapar (Kustomize dersi).

```yaml
metadata:
  name: uygulama-ayar-v2
immutable: true      # değiştirilemez: kazara değişikliği engeller, API sunucusunun izleme yükünü azaltır
```

## Secret

```bash
kubectl create secret generic db-kimlik \
  --from-literal=kullanici=app \
  --from-literal=parola='c0k-G!zli' \
  --dry-run=client -o yaml
```

Çıktıdaki değerler **base64**. Bu bir şifreleme değil, kodlamadır:

```bash
echo 'YzBrLUchemxp' | base64 -d; echo
```

Elle YAML yazarken base64'le uğraşmamak için `stringData` kullanılır, Kubernetes kendisi kodlar:

```bash
cat > secret.yaml <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: db-kimlik
type: Opaque
stringData:
  kullanici: app
  parola: "c0k-G!zli"
EOF
kubectl apply -f secret.yaml
kubectl get secret db-kimlik -o jsonpath='{.data.parola}' | base64 -d; echo
```

> Bu YAML dosyası **git'e girmemeli**: içinde düz metin parola var. Aşağıda "Secret'ları git'te yönetmek" bölümüne bak.

Pod'a vermek ConfigMap ile aynı (`secretKeyRef`, `secretRef`, `secret` volume):

```bash
cat > pod-secret.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: secret-deneme
spec:
  securityContext:
    runAsUser: 1000
    fsGroup: 1000
  containers:
    - name: uygulama
      image: busybox:1.36
      command: ["sh", "-c", "id; ls -la /run/secrets/db; echo \"parola dosyadan: $(cat /run/secrets/db/parola)\"; sleep 3600"]
      env:
        - name: DB_PASSWORD_FILE
          value: /run/secrets/db/parola
      volumeMounts:
        - name: db
          mountPath: /run/secrets/db
          readOnly: true
  volumes:
    - name: db
      secret:
        secretName: db-kimlik
        defaultMode: 0440
EOF
kubectl apply -f pod-secret.yaml
kubectl wait --for=condition=Ready pod/secret-deneme
kubectl logs secret-deneme
kubectl exec secret-deneme -- mount | grep secrets
```

- Secret volume'leri node'da **tmpfs** (bellek) üzerindedir, diske yazılmaz (Swarm secret'ları gibi).
- `defaultMode` ve `fsGroup` ile dosyalar sadece uygulamanın kullanıcısı ve grubu tarafından okunabilir.
- Docker kursundaki öneri burada da geçerli: Mümkünse **dosya olarak** ver, `*_FILE` kalıbıyla oku. Ortam değişkenleri `kubectl describe pod` ve `/proc/PID/environ` üzerinden sızabilir ve çocuk süreçlere geçer.

### Secret ne kadar gizli?

Varsayılan kurulumda Secret'lar:

- etcd'de **şifrelenmeden** (sadece base64) saklanır. etcd'ye ya da yedeğine erişen herkes okuyabilir.
- `get secret` yetkisi olan herkes (ve o namespace'te Pod oluşturabilen herkes, çünkü Pod'a bağlayıp okuyabilir) değerleri görebilir.

Sertleştirme:

| Önlem | Ne sağlar |
|---|---|
| **etcd'de şifreleme** (`EncryptionConfiguration`, KMS sağlayıcısı) | etcd ve yedekleri ele geçse bile Secret'lar okunamaz. Yönetilen kümelerde genelde bir ayar |
| **RBAC** | `secrets` üzerinde `get/list/watch` yetkisini sadece gerekenlere ver. `list` yetkisi de değerleri döndürür! (Güvenlik dersi) |
| **Dış gizli bilgi yöneticisi** | Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager. **External Secrets Operator** bunları Kubernetes Secret'larına senkronize eder ya da CSI Secrets Store sürücüsü doğrudan volume olarak bağlar |

### Secret türleri

```bash
kubectl create secret docker-registry ghcr-kimlik --docker-server=ghcr.io --docker-username=kullanici --docker-password=token --dry-run=client -o yaml | head -8
```

| Tür | Kullanım |
|---|---|
| `Opaque` | Genel amaçlı (varsayılan) |
| `kubernetes.io/dockerconfigjson` | Özel registry'den imaj çekmek: Pod'da `imagePullSecrets` |
| `kubernetes.io/tls` | `tls.crt` + `tls.key`: Ingress'te TLS (cert-manager üretir) |
| `kubernetes.io/service-account-token` | Eski tip ServiceAccount token'ları |

Özel registry kullanımı:

```yaml
spec:
  imagePullSecrets:
    - name: ghcr-kimlik
  containers:
    - image: ghcr.io/ardaatay/siparis-api:sha-4f9c2e1
```

Bunu her Pod'a yazmak yerine namespace'in `default` ServiceAccount'una ekleyebilirsin: `kubectl patch serviceaccount default -p '{"imagePullSecrets":[{"name":"ghcr-kimlik"}]}'`.

## Secret'ları git'te yönetmek

Bildirimsel çalışma ve GitOps "her şey git'te" der, ama Secret'lar düz metin olarak git'e girmemeli. Yaygın çözümler:

| Araç | Yöntem |
|---|---|
| **Sealed Secrets** | Kümede bir denetleyici bir anahtar çifti tutar. Secret'ı açık anahtarla şifreleyip (`kubeseal`) `SealedSecret` olarak git'e koyarsın. Sadece küme içindeki denetleyici çözebilir |
| **SOPS** (+ age/KMS) | YAML'daki değerleri şifreler, anahtarları açık bırakır. Argo CD/Flux eklentileriyle deploy sırasında çözülür |
| **External Secrets Operator** | Git'te sadece "şu Secret, Vault'taki şu yoldan gelsin" tanımı durur. Değerin kendisi hiç git'e girmez |

## Temizlik

```bash
kubectl delete pod cm-deneme secret-deneme
kubectl delete configmap uygulama-ayar
kubectl delete secret db-kimlik
```

## Alıştırma (lab'da)

1. `ayar/nginx.conf` dosyasından bir ConfigMap oluştur ve nginx Deployment'ında `/etc/nginx/conf.d/default.conf` olarak bağla (`subPath` ile). `/health` uç noktasının çalıştığını doğrula.
2. ConfigMap'teki `staging` kelimesini `production` yap. Pod'daki dosya değişti mi? Değişikliği Pod'lara yansıtmanın en güvenli yolu nedir? Uygula.
3. Bir Secret'ın değerini `kubectl` ile tek komutta düz metin olarak okuyan bir satır yaz. Bu sana RBAC hakkında ne söylüyor?

<details><summary>Çözüm</summary>

```bash
kubectl create configmap web-ayar --from-file=default.conf=ayar/nginx.conf
cat > web.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          volumeMounts:
            - { name: ayar, mountPath: /etc/nginx/conf.d/default.conf, subPath: default.conf }
      volumes:
        - name: ayar
          configMap: { name: web-ayar }
EOF
kubectl apply -f web.yaml && kubectl rollout status deploy/web
P=$(kubectl get pod -l app=web -o name | head -1)
kubectl exec $P -- wget -q -O - localhost/health
kubectl exec $P -- wget -q -O - localhost/

kubectl get configmap web-ayar -o yaml | sed 's/staging/production/' | kubectl apply -f -
sleep 60; kubectl exec $P -- wget -q -O - localhost/
kubectl rollout restart deploy/web && kubectl rollout status deploy/web
kubectl exec $(kubectl get pod -l app=web -o name | head -1) -- wget -q -O - localhost/

kubectl create secret generic deneme --from-literal=token=abc123
kubectl get secret deneme -o jsonpath='{.data.token}' | base64 -d; echo
kubectl delete secret deneme
kubectl delete -f web.yaml; kubectl delete configmap web-ayar
```

2: `subPath` ile bağlandığı için dosya hiç değişmedi. En basit yol `rollout restart`. En güvenli yol, değiştirilmiş içerikle **yeni adlı** bir ConfigMap oluşturup Deployment'ı ona çevirmek: değişiklik bir rollout olur, readinessProbe varsa bozuk bir ayar Pod'ları hazır yapmaz ve rollout durur, `rollout undo` eski ConfigMap'e döner.

3: `kubectl get secret X -o jsonpath='{.data.anahtar}' | base64 -d`. Secret'ları okuma (`get`) yetkisi değerleri okuma yetkisidir. base64 bir koruma değildir.

</details>

```quiz
ConfigMap'teki bir değeri değiştirdin. Pod'da `envFrom` ile alınan ortam değişkeni ne zaman güncellenir?
- Birkaç saniye içinde
- 1-2 dakika içinde
- [x] Hiçbir zaman, Pod yeniden oluşturulana kadar
? Ortam değişkenleri süreç başlarken okunur. Dosya olarak bağlanan volume'ler (subPath hariç) güncellenir.
```

```quiz
Secret'taki değerler base64 ile kodlanmış. Bu ne kadar koruma sağlar?
- Güçlü şifreleme
- [x] Hiçbir koruma sağlamaz, sadece kodlamadır. Gerçek koruma RBAC, etcd şifrelemesi ve dış gizli bilgi yöneticileridir
- Sadece root çözebilir
? `base64 -d` ile herkes çözebilir.
```

```quiz
Ayar değişikliklerinin geri alınabilir olmasını istiyorsun. En iyi yöntem?
- ConfigMap'i `kubectl edit` ile değiştirmek
- [x] Her değişiklikte yeni adlı (değişmez) bir ConfigMap oluşturup Deployment'ı ona çevirmek
- Ayarları imaja gömmek
? Deployment'taki değişiklik bir rollout olur ve `rollout undo` eski ConfigMap'e döner.
```

## Özet

- ConfigMap: yapılandırma. Secret: gizli bilgi (base64, şifreleme değil). İkisi de 1 MiB sınırlı.
- Pod'a: `env.valueFrom`, `envFrom`, volume (dosya). Gizli bilgiler için dosya + `*_FILE`.
- Ortam değişkenleri hiç, volume dosyaları ~1 dk içinde, `subPath` hiç güncellenmez. Uygulama yeniden okumalı.
- Değişiklikleri `rollout restart`, checksum annotation'ı ya da değişmez sürümlü ConfigMap'lerle yay.
- Secret güvenliği: RBAC (get/list), etcd şifrelemesi, External Secrets / Sealed Secrets / SOPS. Düz Secret YAML'ı git'e girmez.
