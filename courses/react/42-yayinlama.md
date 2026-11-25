# Build, ortam değişkenleri, Docker ve Kubernetes'e yayınlama

Kursun son dersinde bir Vite + React SPA'sını üretime taşıyoruz: üretim build'inin ne ürettiğini anlamak, ortam değişkenlerini doğru yönetmek, nginx ile sunmak, imajı çok aşamalı bir Dockerfile ile oluşturmak ve Kubernetes'e Ingress arkasında yayınlamak. Docker ve Kubernetes kurslarındaki her şey burada bir araya geliyor.

## Üretim build'i ne üretir?

```bash
npm run build          # tsc -b && vite build
npm run preview        # dist/'i yerelde üretim gibi sun (port 4173)
```

```text
dist/
├── index.html                         # tek HTML dosyası, aşağıdakilere referans verir
├── favicon.svg                        # public/ altındakiler olduğu gibi kopyalanır
└── assets/
    ├── index-B7xq2kLm.js              # ana paket (React + uygulama)
    ├── RaporEditoru-Dk91aQzP.js       # lazy() ile bölünen parça
    ├── vendor-charts-C3mT0e1w.js      # manualChunks ile ayrılan kütüphane
    └── index-Cf4d8sRw.css
```

İki şey önemli:

- **Dosya adlarındaki hash** içerikten hesaplanır. İçerik değişmedikçe ad aynı kalır, değişince yeni bir ad olur. Bu yüzden `assets/` altındaki her şey **sonsuza kadar** önbelleğe alınabilir (`Cache-Control: public, max-age=31536000, immutable`). `index.html` ise **asla** önbelleğe alınmamalı (`no-cache`): Yeni deploy'u kullanıcının görmesini sağlayan tek dosya o.
- Bu bir **statik dosya klasörüdür**. Çalışan bir Node süreci yoktur; nginx, S3 + CloudFront, GitHub Pages ya da herhangi bir statik sunucu yeterlidir.

Paket boyutunu takip et: `npx vite-bundle-visualizer` hangi kütüphanenin ne kadar yer kapladığını gösterir. Tipik suçlular: tüm `lodash`, `moment` (yerine `date-fns` ya da `Intl`), bütün ikon setini import etmek, grafik kütüphaneleri. Ağır ve nadir kullanılanları Suspense dersindeki gibi `lazy` ile böl:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: "hidden",                     // haritaları üret ama index'ten referans verme (Sentry'ye yükle)
    rollupOptions: {
      output: { manualChunks: { "vendor-charts": ["recharts"], "vendor-react": ["react", "react-dom", "react-router"] } },
    },
  },
});
```

## Ortam değişkenleri: build anı ve çalışma anı

Bu, SPA yayınlarken en sık yapılan hatadır. Vite'ta `import.meta.env.VITE_API_URL` **build anında** koda gömülür: Derlenmiş JS'te `"https://api.staging.ornek.com"` diye düz bir string olur.

```bash
# .env.production
VITE_API_URL=https://api.ornek.com
VITE_SENTRY_DSN=https://abc@sentry.io/123
```

```ts
const api = import.meta.env.VITE_API_URL;      // build'de string olarak değiştirilir
if (import.meta.env.DEV) console.log("geliştirme modu");
```

> **Dikkat:** `VITE_` önekli her değişken **tarayıcıya gönderilen JS'in içindedir**, herkes "Kaynağı görüntüle" ile okuyabilir. Veritabanı şifresi, gizli API anahtarı, JWT imzalama anahtarı gibi şeyler **asla** bir SPA'nın ortam değişkenine konmaz. Gizli bilgi gerekiyorsa çağrı backend'den (ya da bir BFF/proxy'den) yapılır. Vite, `VITE_` öneki olmayan değişkenleri istemci koduna sızdırmayı bu yüzden reddeder.

Sorun: Build anında gömülen değer, "bir kez build et, her ortama (staging, production) aynı imajı deploy et" ilkesini bozar. Docker kursunda konuştuğumuz bu ilke önemli: Staging'de test ettiğin imaj, production'a giden imajla **bayt bayt aynı** olmalı. Bunun için ortama özgü yapılandırmayı **çalışma anında** yükle:

```html
<!-- index.html: ana paketten önce -->
<script src="/config.js"></script>
```

```js
// public/config.js: geliştirme için varsayılan; konteynerde başlangıçta üzerine yazılır
window.__CONFIG__ = { apiUrl: "http://localhost:8080", ortam: "gelistirme" };
```

```ts
// src/config.ts
import { z } from "zod";
const Sema = z.object({ apiUrl: z.string().url(), ortam: z.enum(["gelistirme", "staging", "production"]) });
export const config = Sema.parse((window as any).__CONFIG__);   // yanlış yapılandırma açılışta fark edilir
```

Konteyner başlarken `config.js`'i ortam değişkenlerinden üretecek küçük bir betik yazacağız. `config.js` de `index.html` gibi önbelleğe alınmamalı.

## nginx yapılandırması

SPA için nginx'in üç görevi var: dosyaları doğru önbellek başlıklarıyla sunmak, bilinmeyen yolları `index.html`'e yönlendirmek (istemci tarafı routing) ve isteğe bağlı olarak `/api`'yi backend'e proxy'lemek.

```nginx
# deploy/nginx.conf (conf.d altına girer, yani http bloğunun içindedir)

# önbellek politikası yola göre: hash'li varlıklar sonsuz, geri kalan her şey her seferinde doğrulanır
map $uri $onbellek {
    ~^/assets/  "public, max-age=31536000, immutable";
    default     "no-cache";
}

server {
    listen 8080;                       # root olmayan kullanıcı için 1024 üstü port
    root /usr/share/nginx/html;
    server_tokens off;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    # başlıklar server seviyesinde: alt location'larda add_header OLMADIĞI için hepsine miras kalır
    add_header Cache-Control $onbellek always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'" always;

    # hash'li dosyalar: eksik parça 404 olsun, index.html değil
    location /assets/ {
        try_files $uri =404;
    }

    # sağlık kontrolü
    location = /healthz { access_log off; default_type text/plain; return 200 "ok\n"; }

    # istemci tarafı routing: /deploylar/42 gibi yollar index.html'e düşer
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

> **Dikkat:** nginx'te bir `location` içine tek bir `add_header` bile yazarsan, üst seviyedeki **bütün** `add_header`'lar o location için geçersiz olur. Önbellek başlığını her location'da ayrı ayrı vermeye kalkınca güvenlik başlıkları sessizce kaybolur. `map` ile tek bir yerden yönetmek bu tuzağı önler. `curl -sI` ile her yol tipinin başlıklarını kontrol et.

`try_files ... /index.html` olmadan, kullanıcı `/deploylar/42` sayfasını yenilediğinde nginx o yolda bir dosya arar ve **404** döner. Bu, "yerelde çalışıyordu, sunucuda sayfayı yenileyince bozuluyor" şikâyetinin bir numaralı sebebidir.

`/assets/` için ayrı kuralın sebebi: Eski bir `index.html`'i önbellekte tutan bir kullanıcı, yeni deploy'dan sonra artık var olmayan `RaporEditoru-Dk91aQzP.js`'i ister. Bu istek `index.html`'e düşerse tarayıcı HTML'i JS olarak çalıştırmaya çalışır ve anlaşılmaz bir "Unexpected token '<'" hatası alırsın. 404 dönmesi daha iyi; uygulamada lazy yükleme hatasını yakalayıp sayfayı yeniletmek (`window.location.reload()`) yaygın bir çözümdür. Eski parçaları bir deploy süresince tutmak (örneğin S3'te silmemek) ise sorunu tamamen ortadan kaldırır.

## Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
# --- 1. aşama: bağımlılıklar ve build ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

# --- 2. aşama: sadece statik dosyalar + nginx ---
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# 101 = imajdaki nginx kullanıcısı: config.js başlangıçta yeniden yazılabilsin
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
COPY --chmod=755 deploy/config.sh /docker-entrypoint.d/40-config.sh
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
```

```sh
#!/bin/sh
# deploy/config.sh: nginx başlamadan önce çalışır (resmi imajın entrypoint mekanizması)
set -eu
cat > /usr/share/nginx/html/config.js <<EOF
window.__CONFIG__ = {
  apiUrl: "${API_URL:?API_URL tanımlı değil}",
  ortam: "${ORTAM:-production}"
};
EOF
echo "config.js yazıldı: ortam=${ORTAM:-production}"
```

```text
# .dockerignore
node_modules
dist
.git
.env*
coverage
playwright-report
```

Docker kursundaki kalıplar burada:

- Çok aşamalı build: Son imajda Node, kaynak kod ya da `node_modules` yok, sadece nginx ve birkaç MB statik dosya. Son imaj yaklaşık 50 MB, build aşaması 500 MB'tan fazla.
- Katman sırası: `package*.json` önce kopyalanır, kod değişince `npm ci` katmanı önbellekten gelir.
- BuildKit önbellek bağlaması npm indirmelerini build'ler arasında saklar.
- `nginx-unprivileged` imajı root olmadan 8080'de dinler. `.dockerignore` `.env` dosyalarının imaja sızmasını önler.
- `${API_URL:?...}`: Değişken yoksa konteyner açıkça hata verip durur. Yanlış yapılandırmayla sessizce açılmaz.

```bash
docker build -t panel:dev .
docker run --rm -p 8080:8080 -e API_URL=https://api.staging.ornek.com -e ORTAM=staging panel:dev
curl -s localhost:8080/config.js
curl -sI localhost:8080/assets/$(ls dist/assets | grep '^index-.*\.js$') | grep -i cache-control
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/deploylar/42     # 200 (index.html)
```

## Kubernetes'e yayınlama

```yaml
# k8s/panel.yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: panel-config }
data:
  API_URL: https://api.ornek.com
  ORTAM: production
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: panel, labels: { app: panel } }
spec:
  replicas: 2
  revisionHistoryLimit: 5
  strategy: { rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  selector: { matchLabels: { app: panel } }
  template:
    metadata: { labels: { app: panel } }
    spec:
      securityContext: { runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: panel
          image: ghcr.io/ornek/panel:2.4.1     # her zaman sabit bir sürüm, asla :latest
          ports: [{ containerPort: 8080, name: http }]
          envFrom: [{ configMapRef: { name: panel-config } }]
          readinessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 20 }
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { memory: 64Mi }
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
---
apiVersion: v1
kind: Service
metadata: { name: panel }
spec:
  selector: { app: panel }
  ports: [{ port: 80, targetPort: http }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: panel
  annotations: { cert-manager.io/cluster-issuer: letsencrypt }
spec:
  ingressClassName: nginx
  tls: [{ hosts: [panel.ornek.com], secretName: panel-tls }]
  rules:
    - host: panel.ornek.com
      http:
        paths:
          - { path: /api, pathType: Prefix, backend: { service: { name: api, port: { number: 80 } } } }
          - { path: /, pathType: Prefix, backend: { service: { name: panel, port: { number: 80 } } } }
```

Bu manifestteki kararlar:

- **Aynı imaj, farklı ConfigMap:** staging ve production namespace'lerinde aynı `panel:2.4.1` imajı, farklı `API_URL` ile çalışır. Kustomize dersindeki overlay'ler bunun için biçilmiş kaftan: `base/` içinde bu manifest, `overlays/staging` ve `overlays/production` içinde sadece ConfigMap, replika sayısı ve host farkları.
- **Aynı domain altında `/api`:** Ingress `/api`'yi backend'e, geri kalanını SPA'ya yönlendirir. Tarayıcı açısından her şey aynı origin'den gelir: **CORS gerekmez**, çerezler basitleşir, CSP'de `connect-src 'self'` yeter.
- **Kaynaklar küçük:** Statik dosya sunan bir nginx için 10m CPU ve 32 MiB bellek fazlasıyla yeterli. Bellek limiti var, CPU limiti yok (Kubernetes kursundaki throttling tartışması).
- **`maxUnavailable: 0`** ve readiness probe: Yeni pod hazır olmadan eskisi kapanmaz, deploy sırasında kesinti olmaz.

ConfigMap değişikliği çalışan pod'lara otomatik yansımaz (`config.js` başlangıçta üretiliyor): `kubectl rollout restart deployment/panel` gerekir. Kustomize'ın `configMapGenerator`'ı ConfigMap adına bir hash ekleyerek bunu otomatikleştirir; içerik değişince ad değişir ve Deployment kendiliğinden yeniden başlar.

```bash
kubectl apply -f k8s/panel.yaml
kubectl rollout status deployment/panel
kubectl exec deploy/panel -- cat /usr/share/nginx/html/config.js
kubectl logs -l app=panel --tail=20
# sorun çıkarsa
kubectl rollout undo deployment/panel
```

## CI/CD hattı

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    tags: ["v*"]
jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck && npx eslint . && npm run test:ci
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.ref_name }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - run: |
          cd k8s/overlays/staging
          kustomize edit set image ghcr.io/ornek/panel=ghcr.io/${{ github.repository }}:${{ github.ref_name }}
          git config user.name ci && git config user.email ci@ornek.com
          git commit -am "staging: panel ${{ github.ref_name }}" && git push
  smoke:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npx playwright install --with-deps chromium
      - run: npx playwright test --grep @smoke
        env: { BASE_URL: https://panel.staging.ornek.com }
```

Akış: Bir sürüm etiketi (`v2.4.1`) testleri çalıştırır, imajı o etiketle registry'ye iter, GitOps deposundaki staging overlay'inde imaj etiketini günceller (Argo CD ya da Flux bunu kümeye uygular, GitOps dersi) ve staging'e karşı Playwright duman testlerini koşar. Production'a terfi, aynı imaj etiketini production overlay'ine yazan ve `environment: production` ile manuel onay isteyen ayrı bir adımdır. Yeni bir build yapılmaz.

> **Dikkat:** Duman testi Argo CD senkronizasyonundan **önce** başlayabilir. Gerçek bir hatta, testten önce yeni sürümün yayında olduğunu doğrula: Uygulamaya bir `/version.json` ekle (build sırasında `git describe` ile üretilir) ve beklenen sürümü görene kadar bekle.

## Üretimde gözlem

Bir SPA'nın hataları **kullanıcının tarayıcısında** olur: Sunucu loglarında görünmezler. Bu yüzden:

- **Hata izleme:** Sentry (ya da benzeri) ile yakalanmamış hatalar ve hata sınırlarının yakaladıkları raporlanır. React 19'da `createRoot(el, { onCaughtError, onUncaughtError, onRecoverableError })` tek bir bağlantı noktası sağlar. `sourcemap: "hidden"` ile üretilen haritaları CI'da Sentry'ye yükle, ama nginx'ten sunma: Yığın izleri okunur hale gelir, kaynak kodun herkese açılmaz.
- **Sürüm etiketi:** Her hata raporunda hangi sürümden geldiği olsun (`release: config.surum`). Deploy'dan sonra hata oranı arttıysa geri alma kararı birkaç dakikada verilir.
- **Web Vitals:** `web-vitals` paketiyle LCP, INP, CLS gerçek kullanıcılardan toplanır ve bir uç noktaya ya da analiz aracına gönderilir. Laboratuvar ölçümleri (Lighthouse) gerçek kullanıcı cihazlarını temsil etmez.
- **nginx tarafı:** Ingress controller'ın erişim logları ve metrikleri, 404 oranı (eski parça istekleri), yanıt süreleri.

## Alıştırma

Bir ekip arkadaşın şu sorunları bildiriyor. Her birinin sebebi ve çözümü ne?

1. "Production'da `/raporlar/2026` sayfasını yenileyince 404 alıyorum, ana sayfadan tıklayarak gidince çalışıyor."
2. "Staging'de test ettik, production'a deploy edince uygulama hâlâ staging API'sine istek atıyor."
3. "Deploy'dan sonra bazı kullanıcılar boş ekran görüyor, konsolda `Unexpected token '<'` var. Sayfayı yenileyince düzeliyor."
4. "Kullanıcılar yeni özelliği deploy'dan saatler sonra bile göremiyor."

<details><summary>Çözümler</summary>

1. **Sebep:** Sunucu `/raporlar/2026` yolunda bir dosya arıyor. **Çözüm:** nginx'te `try_files $uri $uri/ /index.html;`. Tıklayarak gidince çalışmasının sebebi, o durumda gezinmeyi React Router'ın tarayıcıda yapması ve sunucuya hiç istek gitmemesi.
2. **Sebep:** `VITE_API_URL` build anında gömülmüş, staging için yapılan build production'a terfi ettirilmiş. **Çözüm:** Çalışma anı yapılandırması (`config.js` + ConfigMap), ya da her ortam için ayrı build (önerilmez: test edilen imaj ile yayınlanan imaj farklı olur).
3. **Sebep:** Kullanıcının tarayıcısındaki eski `index.html`, yeni deploy'da artık var olmayan hash'li bir parçayı istiyor; nginx bunu `index.html`'e düşürüyor ve tarayıcı HTML'i JS olarak çalıştırmaya çalışıyor. **Çözüm:** `/assets/` için `try_files $uri =404`, lazy yükleme hatasında sayfayı bir kez yeniden yükle, mümkünse eski parçaları bir süre tut.
4. **Sebep:** `index.html` önbelleğe alınıyor (nginx'te ya da önündeki CDN'de). **Çözüm:** `index.html` ve `config.js` için `Cache-Control: no-cache`, CDN'de bu yollar için önbelleği kapat ya da deploy'da invalidate et. Hash'li dosyalar sonsuza kadar önbellekte kalabilir.

</details>

```quiz
`VITE_STRIPE_SECRET_KEY` adlı bir ortam değişkeni ne anlama gelir?
- Güvenli: Vite onu sunucuda tutar
- [x] Bir güvenlik açığı: `VITE_` önekli değişkenler tarayıcıya gönderilen JS'e gömülür, herkes okuyabilir
- Sadece geliştirme modunda kullanılır
? Gizli anahtarlar backend'de kalır; SPA sadece genel (public) yapılandırma taşır.
```

```quiz
Hash'li dosya adlarına (`index-B7xq2kLm.js`) sahip varlıklar için doğru önbellek politikası?
- no-cache
- [x] Uzun süreli ve immutable: içerik değişirse dosya adı da değişir
- max-age=60
? `index.html` ise no-cache olmalı, yeni sürümün adreslerini o taşır.
```

```quiz
SPA'yı ve API'yi aynı domain altında (`/` ve `/api`) Ingress ile sunmanın en büyük faydası?
- Daha hızlı build
- [x] Aynı origin: CORS gerekmez, çerez ve CSP yapılandırması basitleşir
- Daha az pod
? Tarayıcı açısından istekler aynı kaynaktan gelir.
```

## Özet

- Vite build'i statik dosyalardır: hash'li varlıklar sonsuz önbellek, `index.html` no-cache.
- `VITE_*` build anında gömülür ve herkese açıktır. Ortama özgü yapılandırmayı çalışma anında (`config.js`) yükle, "bir kez build et, her yere deploy et".
- nginx: `try_files ... /index.html` (istemci routing), `/assets/` için `=404`, önbellek ve güvenlik başlıkları, `/healthz`.
- Dockerfile: Node ile build, `nginx-unprivileged` ile sun, entrypoint betiği ile config üret, son imaj yaklaşık 50 MB.
- Kubernetes: ConfigMap ile ortam farkı, aynı domain altında `/api`, küçük kaynaklar, `maxUnavailable: 0`. ConfigMap değişince rollout restart ya da configMapGenerator.
- CI/CD: etiket, test, imaj, GitOps ile staging, duman testi, onaylı terfi. Üretimde Sentry + kaynak haritaları + Web Vitals.

Tebrikler, React kursunu bitirdin. Linux, Docker ve Kubernetes kurslarıyla birlikte artık bir uygulamayı yazıp, imaja çevirip, kümeye yayınlayıp üretimde izleyebilecek bütün parçalara sahipsin.
