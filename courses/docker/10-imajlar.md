# İmaj katmanları, etiketler, digest ve registry

İmajın nasıl saklandığını bilmek üç pratik soruyu cevaplar: Neden 50 konteyner 50 kat disk kaplamıyor? Neden `latest` etiketiyle deploy etmek tehlikeli? Neden dün çalışan build bugün farklı bir sonuç veriyor? Bu derste imajın iç yapısını, etiket ile digest farkını ve registry'leri göreceğiz.

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker yoksa: curl -fsSL https://get.docker.com | sh
```

## İmaj = katmanlar + ayar

Bir imaj üç parçadan oluşur:

1. **Katmanlar**: Her biri bir dosya sistemi farkı (eklenen, değişen, silinen dosyalar) içeren tar arşivleri. Dockerfile'daki dosya sistemini değiştiren her talimat (`RUN`, `COPY`, `ADD`) bir katman üretir.
2. **Config**: Varsayılan komut (`CMD`, `ENTRYPOINT`), ortam değişkenleri, çalışma klasörü, kullanıcı, açık portlar, etiketler (label) ve katmanların sırası. Bir JSON belgesi.
3. **Manifest**: Config'in ve her katmanın **digest**'ini (SHA-256 özeti) listeleyen belge.

```bash
docker pull nginx:1.27-alpine
docker history nginx:1.27-alpine
docker image inspect nginx:1.27-alpine --format '{{json .RootFS.Layers}}' | tr ',' '\n'
docker image inspect nginx:1.27-alpine --format 'CMD={{.Config.Cmd}} ENTRYPOINT={{.Config.Entrypoint}} USER={{.Config.User}}'
```

`docker history` her katmanın hangi talimatla oluşturulduğunu ve boyutunu gösterir. `0B` olan satırlar dosya sistemini değiştirmeyen talimatlardır (`ENV`, `CMD`, `EXPOSE`) ve sadece config'i günceller.

### Katmanlar paylaşılır

Katmanlar **içerik adresli** saklanır: aynı içerik aynı digest'e, dolayısıyla aynı dosyaya karşılık gelir. Aynı temel imajı kullanan on farklı imaj, temel katmanları diskte bir kez saklar. `pull` sırasında "Already exists" yazan katmanlar budur.

```bash
docker pull nginx:1.27-alpine-slim 2>&1 | tail -5
docker system df -v | head -15
```

`SHARED SIZE` sütunu, imajların ortak katmanlarını gösterir.

### Konteyner = imaj + yazılabilir katman (overlayfs)

Konteyner başlarken Docker, imajın salt okunur katmanlarını alt alta dizer ve en üste konteynere özel, **boş, yazılabilir** bir katman ekler. Linux'un `overlayfs` dosya sistemi bunları tek bir ağaç olarak gösterir:

```text
  merged  (konteynerin gördüğü /)
    ▲
  upper   (yazılabilir katman, konteynere özel)   <- docker diff burayı gösterir
  lower3  (imaj katmanı, salt okunur)
  lower2  (imaj katmanı, salt okunur)
  lower1  (temel imaj, salt okunur)
```

Konteyner bir dosyayı değiştirirse, dosya önce alt katmandan üst katmana **kopyalanır** (copy-on-write), sonra değiştirilir. Silinen dosyalar üst katmanda özel bir "silindi" işaretiyle (whiteout) temsil edilir. Bu yüzden:

- 50 konteyner aynı imajı paylaşır, her biri sadece kendi değişiklikleri kadar ek yer kaplar.
- Büyük bir dosyada küçük bir değişiklik, dosyanın **tamamının** kopyalanmasına yol açar. Veritabanı dosyaları gibi yoğun yazılan veriler bu yüzden overlay'de değil **volume**'de tutulur.

Bunu kendi gözünle gör:

```bash
docker run -d --name ov nginx:1.27-alpine
docker inspect ov --format '{{json .GraphDriver.Data}}' | tr ',' '\n'
UP=$(docker inspect ov --format '{{.GraphDriver.Data.UpperDir}}')
docker exec ov sh -c 'echo deneme > /tmp/yeni.txt; rm /etc/nginx/conf.d/default.conf'
ls -la $UP/tmp $UP/etc/nginx/conf.d
docker diff ov
docker rm -f ov
```

`UpperDir` içinde yeni dosya duruyor. Silinen dosya ise `c---------` izinli, `0, 0` aygıt numaralı bir karakter aygıtı olarak görünüyor: whiteout işareti. (Bazı kurulumlar containerd'nin snapshotter'ını kullanır ve `GraphDriver` alanı farklı görünebilir. `docker info | grep -i storage` ile kontrol edebilirsin.)

### "Silinen dosya" imajı küçültmez

Katmanlar sadece eklenir. Bir katmanda eklenen dosyayı sonraki katmanda silmek, dosyayı **görünmez** yapar ama alt katmanda durmaya devam eder ve imajın boyutuna dahildir:

```dockerfile
RUN curl -o /tmp/buyuk.tar.gz https://...      # katman: +500 MB
RUN tar xzf /tmp/buyuk.tar.gz && rm /tmp/buyuk.tar.gz   # +açılmış dosyalar, 500 MB hâlâ bir alt katmanda
```

Doğrusu indirme, açma ve silmeyi **aynı `RUN`** içinde yapmak ya da multi-stage build kullanmak. Bir sonraki iki dersin ana konularından biri bu.

## İmaj adları

```text
registry.ornek.com:5000/takim/odeme-api:1.4.2@sha256:9f86d0...
└──────── registry ───┘└ ad alanı ┘└ repo ┘└ etiket┘└──── digest ────┘
```

Eksik kısımlar varsayılanlarla tamamlanır:

| Yazdığın | Gerçekte |
|---|---|
| `nginx` | `docker.io/library/nginx:latest` |
| `bitnami/redis` | `docker.io/bitnami/redis:latest` |
| `ghcr.io/ardaatay/egitim:1.0` | GitHub Container Registry |

`library/` ad alanı Docker Hub'daki **resmî imajlar** içindir (Docker'ın ve yazılımın geliştiricilerinin bakımını yaptığı imajlar).

## Etiket ve digest

**Etiket (tag)** değiştirilebilir bir işarettir. `nginx:1.27` bugün bir imajı, yarın 1.27'nin yeni yama sürümünü gösterebilir. `latest` ise sadece bir etiket adıdır: "en yeni" anlamına gelmesi garanti değildir, sadece etiket verilmediğinde varsayılan olarak kullanılır.

**Digest** imaj içeriğinin SHA-256 özetidir ve **değiştirilemez**. Aynı digest her zaman bit bit aynı imajı verir.

```bash
docker image inspect nginx:1.27-alpine --format '{{index .RepoDigests 0}}'
D=$(docker image inspect nginx:1.27-alpine --format '{{index .RepoDigests 0}}')
docker run --rm "$D" nginx -v
```

Etiket seçimi bir denge:

| Etiket | Ne zaman değişir | Kullanım |
|---|---|---|
| `nginx` / `nginx:latest` | Her yeni sürümde (büyük sürüm atlamaları dahil) | **Üretimde asla** |
| `nginx:1` | 1.x içindeki her sürümde | Riskli |
| `nginx:1.27` | 1.27.x yama sürümlerinde | Makul: güvenlik yamalarını alır |
| `nginx:1.27.3-alpine3.20` | Neredeyse hiç (yeniden build edilebilir) | Tekrarlanabilir build |
| `nginx@sha256:...` | Hiçbir zaman | Tam tekrarlanabilirlik, ama yamalar otomatik gelmez |

Pratik yaklaşım: Dockerfile ve Compose dosyalarında spesifik bir etiket (ya da etiket + digest: `nginx:1.27.3-alpine@sha256:...`) kullan, güncellemeleri **Renovate** ya da **Dependabot** gibi bir araçla pull request olarak al. Böylece hem tekrarlanabilirlik hem güncellik sağlanır.

Kendi imajlarında da aynı ilke: Deploy edilen imajı **değişmez** bir etiketle (git commit SHA'sı, sürüm numarası) etiketle. `odeme-api:latest` ile deploy edersen "üretimde şu an hangi kod çalışıyor?" ve "bir önceki sürüme nasıl dönerim?" sorularının cevabı olmaz.

## Çok mimarili imajlar

Aynı etiket, farklı işlemci mimarileri için farklı imajları gösterebilir. Etiket aslında bir **manifest listesini** (image index) gösterir ve Docker kendi mimarisine uygun olanı çeker:

```bash
docker buildx imagetools inspect nginx:1.27-alpine | head -25
docker image inspect nginx:1.27-alpine --format '{{.Os}}/{{.Architecture}}'
```

Apple Silicon (arm64) bir Mac'te build edilip amd64 bir sunucuya gönderilen imaj `exec format error` ile açılmaz. Çözüm `docker buildx build --platform linux/amd64,linux/arm64` ile çok mimarili build (CI dersi).

## Registry

Registry, imajların saklandığı HTTP sunucusudur. Yaygın olanlar: Docker Hub, GitHub Container Registry (ghcr.io), GitLab Registry, AWS ECR, Google Artifact Registry, Azure ACR, kendi kurduğun Harbor ya da `registry:2`.

Kendi yerel registry'mizi kurup push/pull akışını görelim:

```bash
docker run -d --name registry -p 5000:5000 registry:2
docker tag nginx:1.27-alpine localhost:5000/egitim/web:1.0
docker push localhost:5000/egitim/web:1.0
curl -s localhost:5000/v2/_catalog; echo
curl -s localhost:5000/v2/egitim/web/tags/list; echo
docker rmi localhost:5000/egitim/web:1.0
docker pull localhost:5000/egitim/web:1.0
```

İlk `push`'ta bütün katmanlar gönderildi. Aynı katmanları paylaşan başka bir etiketi göndermeyi dene:

```bash
docker tag nginx:1.27-alpine localhost:5000/egitim/web:1.0.1
docker push localhost:5000/egitim/web:1.0.1
```

Bu kez katmanlar "Layer already exists" olarak geçer ve sadece küçük manifest gönderilir: registry de katmanları içerik adresli saklar. Aynı registry'deki başka bir depoda zaten bulunan katmanlar da kopyalanmaz, "Mounted from" olarak bağlanır.

- `docker tag` yeni bir **isim** oluşturur, imajı kopyalamaz. Aynı imaj kimliğinin birden fazla adı olabilir (`docker images` çıktısında aynı IMAGE ID).
- `localhost` dışındaki bir registry'ye HTTPS olmadan push yapamazsın. Docker varsayılan olarak TLS ister (`insecure-registries` ayarı sadece test için).
- Özel registry'ler için `docker login registry.ornek.com`. Kimlik bilgileri `~/.docker/config.json`'a yazılır (bir credential helper yoksa base64 kodlu, yani **şifresiz**). CI'da kısa ömürlü token'lar kullan.

### Docker Hub sınırları

Docker Hub, kimliği doğrulanmamış (anonim) çekme isteklerini IP başına sınırlar. Sınırlar zaman içinde değişti ve daraldı. Paylaşılan IP'lerden (CI çalıştırıcıları, NAT arkasındaki sunucular) yoğun çekme yapıyorsan `toomanyrequests` hatasıyla karşılaşabilirsin. Çözümler: `docker login` ile kimlikli çekmek, kendi registry'nde ayna/önbellek (pull-through cache) çalıştırmak, ya da imajları kendi registry'ne kopyalamak.

## docker commit: konteynerden imaj

Bir konteynerin yazılabilir katmanını yeni bir imaj katmanı olarak dondurmak mümkün:

```bash
docker run -d --name elle nginx:1.27-alpine
docker exec elle sh -c 'apk add --no-cache curl >/dev/null && echo "<h1>elle yapıldı</h1>" > /usr/share/nginx/html/index.html'
docker commit -m "curl ve özel sayfa" elle egitim/web:elle
docker history egitim/web:elle | head -3
docker run --rm egitim/web:elle sh -c 'curl --version | head -1; cat /usr/share/nginx/html/index.html'
docker rm -f elle
```

Çalışıyor, ama **üretim imajları için kullanılmaz**:

- İmajın nasıl oluştuğu kayıt altında değil. `history` sadece "docker commit" der. Altı ay sonra kimse ne yapıldığını bilmez.
- Tekrarlanamaz: temel imajın güvenlik yaması çıktığında aynı adımları elle tekrarlamak gerekir.
- Konteynerde çalışırken oluşan geçici dosyalar, önbellekler ve hatta gizli bilgiler (geçmiş dosyaları, ortamdan yazılan dosyalar) imaja girer.

`commit`'in meşru kullanımı **teşhis**: sorunlu bir konteynerin o anki hâlini incelemek için dondurmak (`docker commit sorunlu-konteyner inceleme:1` sonra `docker run -it --entrypoint sh inceleme:1`). İmajlar her zaman bir Dockerfile'dan üretilmeli.

## İmajı dosya olarak taşımak

İnternet erişimi olmayan bir sunucuya:

```bash
docker save localhost:5000/egitim/web:1.0 | gzip > web.tar.gz
ls -lh web.tar.gz
docker rmi localhost:5000/egitim/web:1.0
gunzip -c web.tar.gz | docker load
docker images | grep egitim
docker rm -f registry
```

## Alıştırma (lab'da)

1. `python:3.12-slim` ve `python:3.12-alpine` imajlarını çek. Boyutlarını ve katman sayılarını karşılaştır.
2. `alpine:3.20` imajının yerel digest'ini bul. Aynı imajı digest ile çalıştır.
3. `nginx:1.27-alpine` imajını `localhost:5000/egitim/web:2.0` ve `localhost:5000/egitim/web:latest` olarak etiketle. `docker images` çıktısında IMAGE ID'lere bak. Kaç kopya var?

<details><summary>Çözüm</summary>

```bash
docker pull -q python:3.12-slim; docker pull -q python:3.12-alpine
docker images python
for t in 3.12-slim 3.12-alpine; do echo "$t: $(docker history -q python:$t | wc -l) katman satırı"; done

docker pull -q alpine:3.20
D=$(docker image inspect alpine:3.20 --format '{{index .RepoDigests 0}}'); echo $D
docker run --rm "$D" cat /etc/alpine-release

docker tag nginx:1.27-alpine localhost:5000/egitim/web:2.0
docker tag nginx:1.27-alpine localhost:5000/egitim/web:latest
docker images | grep -E 'nginx|egitim'
```

3: Hepsi aynı IMAGE ID'yi gösterir. Tek bir imaj var, sadece birden fazla adı var. `docker rmi localhost:5000/egitim/web:latest` sadece o adı kaldırır ("Untagged"), imaj diğer adlar varken silinmez.

</details>

```quiz
Dockerfile'da bir `RUN` adımında 300 MB'lık bir dosya indirip bir sonraki `RUN`'da sildin. İmaj boyutu ne olur?
- 300 MB küçülür
- [x] Değişmez, dosya alt katmanda durmaya devam eder
- Docker otomatik temizler
? Katmanlar sadece eklenir. İndirme ve silme aynı RUN'da olmalı ya da multi-stage build kullanılmalı.
```

```quiz
Üretim deploy'unda hangi imaj referansı tekrarlanabilirlik açısından en güvenilirdir?
- `odeme-api:latest`
- `odeme-api:1`
- [x] `odeme-api:4f9c2e1` (commit SHA) ya da digest ile
? `latest` ve geniş etiketler değişir. Değişmez etiket ya da digest, hangi kodun çalıştığını kesin olarak belirler.
```

```quiz
50 konteyner aynı 200 MB'lık imajdan çalışıyor. Disk kullanımı yaklaşık ne kadardır?
- 10 GB
- [x] 200 MB + her konteynerin kendi yazdığı değişiklikler
- 400 MB
? İmaj katmanları salt okunur ve paylaşılır. Her konteynerin sadece kendi yazılabilir katmanı vardır.
```

## Özet

- İmaj = içerik adresli katmanlar + config + manifest. Katmanlar paylaşılır.
- Konteyner = imaj katmanları + yazılabilir üst katman (overlayfs, copy-on-write).
- Silinen dosya alt katmanda kalır: indir-aç-sil aynı `RUN`'da.
- Etiket değişebilir, digest değişmez. Üretimde `latest` yok, kendi imajlarında commit SHA/sürüm.
- Çok mimarili imajlar manifest listesiyle. `exec format error` = yanlış mimari.
- `tag` yeni isim, `push/pull` katman bazında, `save/load` ile çevrimdışı taşıma.
