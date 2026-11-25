# RBAC, ServiceAccount, securityContext ve Pod Security

Docker kursunun güvenlik dersinde tek bir konteyneri sıkılaştırdık. Kubernetes'te iki ayrı soru daha eklenir: **API'ye kim erişebilir ve ne yapabilir?** (bir geliştirici, bir CI hattı, kümedeki bir Pod) ve **Kümedeki bütün Pod'ların güvenlik ayarları nasıl zorunlu kılınır?** Bu derste RBAC ile yetkilendirmeyi, Pod'ların API kimliği olan ServiceAccount'ları, `securityContext` ile Pod sıkılaştırmayı ve Pod Security Admission ile kuralları namespace düzeyinde zorunlu kılmayı göreceğiz.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
```

## API isteğinin yolu

```text
istek ──▶ Kimlik doğrulama (kim?)  ──▶ Yetkilendirme (izinli mi?) ──▶ Kabul denetimi (admission) ──▶ etcd
          sertifika, token, OIDC        RBAC                          Pod Security, webhook'lar
```

- **Kimlik doğrulama**: Kubernetes'te "kullanıcı" nesnesi yoktur. İnsanlar istemci sertifikası ya da (yönetilen kümelerde ve kurumsal kurulumlarda) **OIDC** ile şirketin kimlik sağlayıcısından (Google, Azure AD, Okta, Keycloak) gelir. Pod'lar ise **ServiceAccount** token'larıyla.
- **Yetkilendirme**: **RBAC**: Bu kimliğin bu kaynak üzerinde bu işlemi yapmaya izni var mı?
- **Kabul denetimi**: İzin olsa bile isteği değiştirebilen ya da reddedebilen kurallar: Pod Security Admission, ResourceQuota/LimitRange (önceki ders), Kyverno/OPA Gatekeeper politikaları.

## RBAC

Dört nesne:

| Nesne | Kapsam | İçerik |
|---|---|---|
| `Role` | Namespace | İzinler: hangi kaynaklar, hangi fiiller |
| `ClusterRole` | Küme geneli | Aynısı, küme genelindeki kaynaklar (node'lar, PV'ler) ya da her namespace için yeniden kullanılabilir tanım |
| `RoleBinding` | Namespace | Bir Role'ü (ya da ClusterRole'ü) bir kimliğe, **o namespace'te** bağlar |
| `ClusterRoleBinding` | Küme geneli | Bir ClusterRole'ü bir kimliğe **bütün kümede** bağlar |

İzinler sadece **verilir**, RBAC'ta "yasakla" kuralı yoktur. Hiçbir izin verilmemişse her şey reddedilir.

Fiiller: `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`, ayrıca `exec` gibi alt kaynaklar için `create` (`pods/exec`), `pods/log` için `get`.

### Bir geliştirici rolü

Senaryo: `ayse`, `odeme` namespace'inde Deployment'ları ve Pod'ları görebilsin, logları okuyabilsin, Deployment'ları yeniden başlatabilsin (`rollout restart` bir `patch`'tir), ama Secret'ları okuyamasın ve başka namespace'lere erişemesin.

```bash
kubectl create namespace odeme
kubectl -n odeme create deployment api --image=nginx:1.27-alpine
kubectl -n odeme create secret generic db --from-literal=parola=gizli

cat > rbac.yaml <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: gelistirici
  namespace: odeme
rules:
  - apiGroups: [""]
    resources: [pods, pods/log, services, configmaps, events]
    verbs: [get, list, watch]
  - apiGroups: ["apps"]
    resources: [deployments, replicasets]
    verbs: [get, list, watch, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ayse-gelistirici
  namespace: odeme
subjects:
  - kind: User
    name: ayse
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: gelistirici
  apiGroup: rbac.authorization.k8s.io
EOF
kubectl apply -f rbac.yaml
```

`apiGroups`: Pod, Service, ConfigMap gibi çekirdek kaynaklar `""` grubunda, Deployment `apps` grubunda (`kubectl api-resources` çıktısındaki APIVERSION sütunu).

İzinleri, kimliğe bürünerek (impersonation) test edelim:

```bash
kubectl auth can-i list pods -n odeme --as ayse
kubectl auth can-i get pods/log -n odeme --as ayse
kubectl auth can-i patch deployments -n odeme --as ayse
kubectl auth can-i get secrets -n odeme --as ayse
kubectl auth can-i create pods/exec -n odeme --as ayse
kubectl auth can-i list pods -n default --as ayse
kubectl auth can-i --list -n odeme --as ayse
kubectl -n odeme rollout restart deploy/api --as ayse
kubectl -n odeme get secret db --as ayse
```

`kubectl auth can-i`, bir RBAC kuralını yazdıktan sonra doğrulamanın en hızlı yolu. `--as` için senin (yönetici) kimliğinin impersonation yetkisi olması gerekir.

### RBAC'ta gözden kaçan yetki yükseltmeleri

Bazı izinler göründüğünden çok daha güçlüdür:

| İzin | Neden tehlikeli |
|---|---|
| `secrets` üzerinde `list` ya da `watch` | `get` vermesen bile, `list` Secret'ların **değerlerini** döndürür |
| `pods` üzerinde `create` | Namespace'teki herhangi bir Secret'ı ya da ServiceAccount'u bağlayan bir Pod oluşturup onları okuyabilir. `hostPath` izinliyse node'a erişir |
| `pods/exec` üzerinde `create` | Çalışan her Pod'da kabuk: Pod'un ServiceAccount token'ı ve ortamındaki gizli bilgiler |
| `deployments` üzerinde `create`/`update` | Dolaylı olarak Pod oluşturma (yukarıdaki risk) |
| `rolebindings` üzerinde `create` + `bind` / `escalate` | Kendine yetki verebilir |
| Herhangi bir şey üzerinde `*` | Bugün ve gelecekte eklenecek her şey |
| `nodes/proxy` | Kubelet API'si üzerinden Pod'larda komut çalıştırma |

İlke: **En az yetki**, namespace düzeyinde `Role`, `ClusterRoleBinding` sadece gerçekten küme geneli işler için. Hazır ClusterRole'ler: `view` (Secret hariç okuma), `edit` (Secret dahil değiştirme, RBAC hariç), `admin` (namespace yöneticisi), `cluster-admin` (her şey). İnsanlara genelde `view`/`edit`, CI'a kendi namespace'inde dar bir rol.

```bash
kubectl create rolebinding ayse-view --clusterrole=view --user=ayse -n odeme --dry-run=client -o yaml
kubectl get clusterrole view -o yaml | grep -c resources
```

### Gruplar

Kimlik sağlayıcısındaki grupları bağlamak, kişileri tek tek bağlamaktan çok daha yönetilebilirdir:

```yaml
subjects:
  - kind: Group
    name: odeme-takimi          # OIDC token'ındaki "groups" iddiası
    apiGroup: rbac.authorization.k8s.io
```

## ServiceAccount: Pod'ların kimliği

Kümedeki her Pod bir ServiceAccount ile çalışır (belirtilmezse namespace'in `default` ServiceAccount'u) ve API'ye o kimlikle erişir.

```bash
kubectl -n odeme run sa-deneme --image=curlimages/curl:8.10.1 --restart=Never -- sleep 3600
kubectl -n odeme wait --for=condition=Ready pod/sa-deneme
kubectl -n odeme get pod sa-deneme -o jsonpath='{.spec.serviceAccountName}{"\n"}'
kubectl -n odeme exec sa-deneme -- ls /var/run/secrets/kubernetes.io/serviceaccount/
kubectl -n odeme exec sa-deneme -- sh -c 'TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token); curl -s --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt -H "Authorization: Bearer $TOKEN" https://kubernetes.default.svc/api/v1/namespaces/odeme/pods | head -c 300'
```

Pod'a otomatik olarak bir token bağlandı. `default` ServiceAccount'un hiçbir izni olmadığı için API `403 Forbidden` döndü. Ama bir saldırgan için bu token, kümeyle konuşmanın başlangıç noktasıdır.

İki önlem:

1. **API'ye erişmesi gerekmeyen Pod'larda token'ı bağlama** (çoğu uygulama):

```yaml
spec:
  automountServiceAccountToken: false
```

2. **API'ye erişmesi gerekenlere ayrı, dar yetkili bir ServiceAccount**:

```bash
kubectl -n odeme create serviceaccount pod-okuyucu
kubectl -n odeme create role pod-okuyucu --verb=get,list --resource=pods
kubectl -n odeme create rolebinding pod-okuyucu --role=pod-okuyucu --serviceaccount=odeme:pod-okuyucu
kubectl auth can-i list pods -n odeme --as system:serviceaccount:odeme:pod-okuyucu
kubectl auth can-i list secrets -n odeme --as system:serviceaccount:odeme:pod-okuyucu
```

Pod'da `spec.serviceAccountName: pod-okuyucu`. Kubernetes 1.24'ten beri token'lar **kısa ömürlü** ve Pod'a bağlıdır (projected token): Pod silinince geçersiz olur, kubelet düzenli yeniler. CI ya da kümenin dışındaki bir araç için token gerekiyorsa `kubectl create token <sa> --duration=1h`.

Bulutta Pod'ların bulut kaynaklarına (S3, SQS) erişmesi için de ServiceAccount kullanılır: **IRSA/EKS Pod Identity** (AWS), **Workload Identity** (GCP, Azure). Pod'a erişim anahtarı vermek yerine ServiceAccount bir bulut rolüyle eşlenir.

## securityContext

Docker kursundaki konteyner sıkılaştırmasının her ayarının Kubernetes karşılığı:

```bash
cat > sikin.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: sikin
  namespace: odeme
spec:
  automountServiceAccountToken: false
  securityContext:                    # Pod düzeyi
    runAsNonRoot: true
    runAsUser: 101
    runAsGroup: 101
    fsGroup: 101
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: web
      image: nginxinc/nginx-unprivileged:1.27-alpine
      ports: [{ containerPort: 8080 }]
      securityContext:                # konteyner düzeyi
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      volumeMounts:
        - { name: tmp, mountPath: /tmp }
        - { name: cache, mountPath: /var/cache/nginx }
      resources:
        requests: { cpu: 10m, memory: 16Mi }
        limits: { memory: 64Mi }
  volumes:
    - { name: tmp, emptyDir: {} }
    - { name: cache, emptyDir: {} }
EOF
kubectl apply -f sikin.yaml
kubectl -n odeme wait --for=condition=Ready pod/sikin
kubectl -n odeme exec sikin -- id
kubectl -n odeme exec sikin -- sh -c 'touch /etc/x' 2>&1
kubectl -n odeme exec sikin -- grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/1/status
```

| securityContext | Docker karşılığı |
|---|---|
| `runAsUser`, `runAsGroup`, `runAsNonRoot` | `-u`, `USER`. `runAsNonRoot: true` imaj root ise Pod'u başlatmaz |
| `allowPrivilegeEscalation: false` | `--security-opt no-new-privileges` |
| `readOnlyRootFilesystem: true` + `emptyDir` | `--read-only` + `--tmpfs` |
| `capabilities.drop: [ALL]` | `--cap-drop ALL` |
| `seccompProfile: RuntimeDefault` | Docker'ın varsayılan seccomp profili. **Kubernetes'te varsayılan olarak uygulanmaz** (açıkça istenmeli) |
| `privileged: true` | `--privileged`: asla |
| `fsGroup` | Volume dosyalarının grubunu ayarlar, root olmayan kullanıcının volume'e yazabilmesi için |

`CapEff: 0000000000000000` (hiç capability yok), `NoNewPrivs: 1`, `Seccomp: 2` (filtre modu).

Bir root imajı `runAsNonRoot` ile çalıştırmayı dene:

```bash
kubectl -n odeme run root-deneme --image=nginx:1.27-alpine --overrides='{"spec":{"securityContext":{"runAsNonRoot":true}}}'
sleep 5; kubectl -n odeme get pod root-deneme
kubectl -n odeme describe pod root-deneme | grep -i 'non-root\|Error' | head -2
```

`CreateContainerConfigError`: "container has runAsNonRoot and image will run as root". Kubernetes imajın root olarak çalışacağını fark edip başlatmadı.

## Pod Security Admission

Her ekibin her Pod'a bu ayarları yazmasını beklemek yerine, kurallar namespace düzeyinde zorunlu kılınır. Kubernetes'in yerleşik **Pod Security Admission** denetleyicisi üç hazır seviye tanımlar (**Pod Security Standards**):

| Seviye | Ne engeller |
|---|---|
| `privileged` | Hiçbir şey (sistem bileşenleri için) |
| `baseline` | Bilinen yetki yükseltmeleri: `privileged`, `hostNetwork`, `hostPID`, `hostPath`, tehlikeli capability'ler |
| `restricted` | Baseline + root olmayan kullanıcı, `allowPrivilegeEscalation: false`, `drop: [ALL]`, seccomp profili zorunlu |

Üç mod:

| Mod | Etki |
|---|---|
| `enforce` | Kurala uymayan Pod'lar **reddedilir** |
| `audit` | Kabul edilir, denetim loguna yazılır |
| `warn` | Kabul edilir, kullanıcıya uyarı gösterilir |

Namespace etiketleriyle ayarlanır:

```bash
kubectl label namespace odeme \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/enforce-version=latest
kubectl -n odeme run kurala-uymayan --image=nginx:1.27-alpine 2>&1 | tail -3
kubectl -n odeme delete pod sikin --wait=false; kubectl apply -f sikin.yaml && echo "sıkı Pod kabul edildi"
```

İlk Pod reddedildi ve hata mesajı hangi alanların eksik olduğunu tek tek listeledi. Docker kursundaki sıkı ayarlarla yazılmış Pod kabul edildi.

> **Dikkat:** `enforce` etiketi var olan Pod'ları silmez, sadece yenilerini engeller. Ama var olan bir Deployment'ın Pod'u yeniden oluşturulurken (node kaybı, rollout) reddedilir ve uygulama sessizce azalabilir. Geçişte önce `warn` ve `audit` ile başla, ihlalleri düzelt, sonra `enforce` aç. Deployment oluşturulurken uyarı gelir ama asıl ret ReplicaSet olaylarında görünür: `kubectl get events`.

Daha ayrıntılı politikalar (belirli registry'lerden imaj zorunluluğu, `latest` etiketi yasağı, her Pod'da resources zorunluluğu, imaj imzası doğrulama) için **Kyverno**, **OPA Gatekeeper** ya da Kubernetes'in yerleşik **ValidatingAdmissionPolicy** (CEL ifadeleri) kullanılır.

## Kümenin kendisi

- **API sunucusunu internete açma**: Yönetilen kümelerde özel uç nokta ya da IP izin listesi.
- **etcd şifrelemesi** ve etcd'ye erişimin kısıtlanması (Secret dersi).
- **Denetim (audit) logları**: Kim, hangi nesnede, ne yaptı.
- **Güncel tut**: Kubernetes her sürümü yaklaşık 14 ay destekler. Operasyon dersinde yükseltme.
- **Denetim araçları**: `kube-bench` (CIS Kubernetes Benchmark), `kubescape`, `trivy k8s` (kümedeki imajlar ve yanlış yapılandırmalar).

## Temizlik

```bash
kubectl delete namespace odeme
```

## Alıştırma (lab'da)

1. `ci-deploy` adında bir ServiceAccount oluştur. `staging` namespace'inde sadece Deployment'ların imajını güncelleyebilsin (`get`, `patch` deployments) ve rollout durumunu izleyebilsin (`get`, `list`, `watch` replicasets ve pods). `kubectl auth can-i` ile Secret okuyamadığını ve Pod oluşturamadığını doğrula.
2. `restricted` seviyeli bir namespace'te önceki derslerdeki `whoami` Deployment'ını çalıştırmayı dene. Hata mesajındaki her eksik alanı ekleyerek kabul edilmesini sağla.

<details><summary>Çözüm</summary>

```bash
kubectl create namespace staging
kubectl -n staging create serviceaccount ci-deploy
cat > ci-rbac.yaml <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: ci-deploy, namespace: staging }
rules:
  - apiGroups: ["apps"]
    resources: [deployments]
    verbs: [get, patch]
  - apiGroups: ["apps"]
    resources: [replicasets]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ci-deploy, namespace: staging }
subjects: [{ kind: ServiceAccount, name: ci-deploy, namespace: staging }]
roleRef: { kind: Role, name: ci-deploy, apiGroup: rbac.authorization.k8s.io }
EOF
kubectl apply -f ci-rbac.yaml
SA=system:serviceaccount:staging:ci-deploy
for k in "patch deployments" "get secrets" "create pods" "list pods" "delete deployments"; do echo "$k: $(kubectl auth can-i $k -n staging --as $SA)"; done

kubectl create namespace sikidenetim
kubectl label namespace sikidenetim pod-security.kubernetes.io/enforce=restricted
kubectl -n sikidenetim create deployment w --image=traefik/whoami:v1.10
sleep 5; kubectl -n sikidenetim get events --field-selector reason=FailedCreate | tail -2
kubectl -n sikidenetim patch deploy w --type=json -p '[
 {"op":"add","path":"/spec/template/spec/securityContext","value":{"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}}},
 {"op":"add","path":"/spec/template/spec/containers/0/securityContext","value":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]'
kubectl -n sikidenetim rollout status deploy/w --timeout=60s
kubectl delete ns staging sikidenetim
```

2: whoami 80 portunu dinler. Pod Security `restricted` seviyesi capability'leri kaldırmayı zorunlu kılar, ama Docker kursunda gördüğümüz gibi konteynerin ağında düşük port kısıtı genelde kaldırıldığı için (çalışma zamanının `ip_unprivileged_port_start` ayarı) root olmayan kullanıcı 80'i yine de açabilir. Açamazsa uygulamayı yüksek bir portta çalıştırmak gerekir (whoami için `--port 8080` argümanı).

</details>

```quiz
Bir kullanıcıya `secrets` üzerinde sadece `list` izni verdin, `get` vermedin. Secret değerlerini görebilir mi?
- Hayır, sadece adları görür
- [x] Evet, `list` yanıtı değerleri de içerir
- Sadece base64 olmayanları
? Secret'lar için list ve watch, get kadar hassastır.
```

```quiz
Kubernetes API'sine hiç erişmesi gerekmeyen bir web uygulaması için ServiceAccount açısından en iyi ayar?
- cluster-admin vermek
- `default` ServiceAccount'u kullanmak
- [x] `automountServiceAccountToken: false` ile token'ı hiç bağlamamak
? Token, ele geçirilmiş bir Pod'dan kümeyle konuşmanın başlangıç noktasıdır.
```

```quiz
Namespace'e `pod-security.kubernetes.io/enforce=restricted` etiketi ekledin. Var olan Pod'lara ne olur?
- Hemen silinirler
- [x] Çalışmaya devam ederler, ama yeniden oluşturulduklarında kurala uymuyorlarsa reddedilirler
- Otomatik olarak sıkılaştırılırlar
? Geçişte önce warn/audit, ihlalleri düzelt, sonra enforce.
```

## Özet

- İstek: kimlik doğrulama → RBAC → kabul denetimi. İnsanlar OIDC/sertifika, Pod'lar ServiceAccount.
- Role/ClusterRole + RoleBinding/ClusterRoleBinding. Sadece izin verilir. `kubectl auth can-i --as`.
- Tehlikeli izinler: secrets list/watch, pods create, pods/exec, `*`, bind/escalate.
- ServiceAccount: gerekmiyorsa `automountServiceAccountToken: false`, gerekiyorsa dar yetkili ayrı SA. Bulut erişimi için Workload Identity.
- securityContext: runAsNonRoot, allowPrivilegeEscalation false, readOnlyRootFilesystem, drop ALL, seccomp RuntimeDefault.
- Pod Security Admission: privileged/baseline/restricted, enforce/audit/warn namespace etiketleriyle. Daha fazlası için Kyverno, Gatekeeper, ValidatingAdmissionPolicy.
