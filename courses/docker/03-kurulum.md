# Kurulum, sürümler, Docker Hub ve ilk ayarlar

Bu derste Docker'ı Linux sunucuya üretime uygun şekilde, Mac ve Windows'a geliştirme için kurmayı, Docker'ın ürün ve sürüm yapısını, Docker Hub'ı ve kurulumdan hemen sonra yapılması gereken ayarları göreceğiz.

## Hangi Docker?

| Ürün | Ne | Lisans |
|---|---|---|
| **Docker Engine** (Docker CE) | Linux'ta çalışan daemon (`dockerd`), CLI, containerd, buildx ve compose eklentileri | Açık kaynak (Apache 2.0), ücretsiz |
| **Docker Desktop** | Mac, Windows (ve Linux) için grafik uygulama: arka planda bir Linux VM'inde Docker Engine + arayüz + Kubernetes + uzantılar | Ticari. Kişisel kullanım, eğitim, ticari olmayan açık kaynak ve küçük işletmeler için ücretsiz. Büyük şirketlerde (250+ çalışan ya da yıllık 10 milyon dolar üstü gelir) **ücretli abonelik** gerekir |
| Docker Hub | İmaj registry'si | Ücretsiz plan + ücretli planlar |

Eski adlandırmayla karşılaşabilirsin: Docker **CE** (Community Edition) bugünkü Docker Engine'dir. Docker **EE** (Enterprise Edition) 2019'da Mirantis'e satıldı ve Mirantis Container Runtime adını aldı.

Sunucularda **Docker Engine** kullanılır, Desktop değil. Desktop geliştirici bilgisayarı içindir.

### Sürümler

Docker Engine sürümleri `25.0`, `26.1`, `27.3`, `28.x` gibi ilerler. Her ana sürüm, eski API'leri ve özellikleri kaldırabilir. Sürüm notlarını okumadan ana sürüm atlamak, özellikle eski Compose dosyaları ve depolama sürücüleriyle sürprizlere yol açabilir. Üretimde sürümü paket yöneticisinde sabitle ve güncellemeyi bilinçli yap.

```bash
docker version     # istemci ve sunucu ayrı ayrı. API sürümü de burada
```

## Linux: resmî paket deposundan kurulum (Ubuntu)

Önceki derslerde lab'da kullandığımız `get.docker.com` betiği hızlıdır ama ne kurduğunu ve hangi sürümü seçtiğini senin yerine belirler. Üretim sunucusunda Docker'ın kendi apt deposunu ekle:

```lab
Killercoda: Ubuntu playground
https://killercoda.com/playgrounds/scenario/ubuntu
Docker zaten kuruluysa adımları okuyup son bölümdeki ayarlara geçebilirsin.
```

```bash
# Dağıtımın eski paketleri varsa kaldır (docker.io, podman-docker vb.)
for p in docker.io docker-doc docker-compose podman-docker containerd runc; do apt-get remove -y $p 2>/dev/null; done

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Belirli bir sürümü kurmak ve sabitlemek:

```bash
apt-cache madison docker-ce | head -5
# apt-get install -y docker-ce=<sürüm> docker-ce-cli=<sürüm>
apt-mark hold docker-ce docker-ce-cli containerd.io
```

Kontrol:

```bash
systemctl is-enabled docker; systemctl is-active docker
docker run --rm hello-world | head -3
docker compose version
docker buildx version
```

Ubuntu'nun kendi deposundaki `docker.io` paketi de çalışır, ama genelde daha eski bir sürümdür ve Compose v2 eklentisi ayrı paketlenir. RHEL/Rocky/Alma için Docker'ın `dnf` deposu, Debian için `/linux/debian` deposu kullanılır.

### docker grubu ve rootless mod

Varsayılan olarak `docker` komutu root (ya da `sudo`) ister. Bir kullanıcıyı `docker` grubuna eklemek sudo'yu kaldırır:

```bash
usermod -aG docker arda      # oturumu kapatıp açınca geçerli olur
```

Mimari dersinden hatırla: **`docker` grubu = parolasız root.** Sunucularda bu yetkiyi sadece zaten root olabilecek kişilere ver. Alternatif, daemon'u da yetkisiz bir kullanıcı olarak çalıştıran **rootless mod**:

```bash
apt-get install -y uidmap docker-ce-rootless-extras
# yetkisiz kullanıcı olarak:
dockerd-rootless-setuptool.sh install
```

Rootless modda konteynerdeki root, host'ta o kullanıcının yetkilerine eşlenir (user namespace). Bedeli: 1024 altındaki portlar, bazı ağ ve depolama özellikleri ek ayar ister. Güvenlik dersinde ayrıntılı.

## Mac

- **Docker Desktop**: Docker'ın resmî uygulaması. Apple Silicon (arm64) ve Intel sürümleri ayrı. Arka planda bir Linux VM'i çalıştırır.
- Alternatifler: **OrbStack** (hızlı ve hafif, ticari kullanım için lisanslı), **Colima** (açık kaynak, komut satırından), **Rancher Desktop** ve **Podman Desktop** (açık kaynak).

Apple Silicon'da dikkat edilmesi gereken tek önemli nokta mimari: Mac'te build ettiğin imaj varsayılan olarak `linux/arm64` olur. amd64 bir sunucuya gönderirken `--platform linux/amd64` ile build et (imajlar dersi, `exec format error`).

Dosya paylaşımı (bind mount) Mac'te VM sınırını geçtiği için Linux'a göre yavaştır. `node_modules` gibi binlerce dosyalı klasörleri bind mount yerine volume'de tutmak geliştirme ortamını hızlandırır.

## Windows

- **Docker Desktop + WSL2**: Windows 10/11'in Home dahil bütün sürümlerinde çalışır. Linux konteynerleri WSL2'nin Linux çekirdeğinde çalışır. Eski Hyper-V arka ucu da seçilebilir (Pro/Enterprise).
- WSL2'de doğrudan Docker Engine: WSL içindeki bir Ubuntu'ya yukarıdaki Linux kurulumunu yapmak da mümkündür, Desktop lisansı gerektirmez.
- **Docker Toolbox** (Windows 7/8 için VirtualBox tabanlı eski çözüm) artık desteklenmiyor.

Performans ipucu: Proje dosyalarını Windows dosya sisteminde (`C:\...`) değil, **WSL'in kendi dosya sisteminde** (`\\wsl$\Ubuntu\home\...`) tut. Windows dosyalarını konteynere bağlamak çok yavaştır.

## Play with Docker

Hiçbir şey kurmadan denemek için: **labs.play-with-docker.com**. Docker Hub hesabıyla girilir, 4 saatlik oturumda **birden fazla** Docker sunucusu (node) açabilirsin. Swarm bölümünde çok sunuculu bir küme kurmak için kullanacağız.

## Docker Hub

Docker Hub varsayılan registry'dir: `docker pull nginx` aslında `docker.io/library/nginx`'i çeker.

- **Resmî imajlar** (`library/`): Docker ve yazılımın geliştiricileri tarafından bakımı yapılır, düzenli güncellenir. İlk tercih bunlar olmalı.
- **Verified Publisher** ve **Sponsored OSS** rozetli imajlar: doğrulanmış şirket ve projeler.
- Diğer kullanıcı imajları: herkes yükleyebilir. İçinde ne olduğunu, ne zaman güncellendiğini ve Dockerfile'ının açık olup olmadığını kontrol etmeden üretimde kullanma.

Hesap açtıktan sonra:

```bash
docker login                     # kullanıcı adı + parola yerine Personal Access Token kullan
docker info | grep -i username
```

Docker Hub'ın web arayüzünden **Personal Access Token** oluştur ve CI'da parola yerine onu kullan. Token'lar tek tek iptal edilebilir ve salt okunur izinle sınırlanabilir. Kimliksiz çekmelerin sınırları imajlar dersinde.

## Kurulumdan hemen sonra: daemon.json

Daemon ayarları `/etc/docker/daemon.json` dosyasındadır. Varsayılan ayarlarda gözden kaçan en önemli konu **log boyutu**: Docker varsayılan olarak konteyner loglarını `json-file` sürücüsüyle **sınırsız** büyüyen dosyalara yazar. Gürültülü bir konteyner, haftalar içinde diski doldurabilir (Linux kursundaki "disk doldu" senaryosu).

```bash
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  },
  "live-restore": true
}
EOF
systemctl restart docker
docker info --format 'log={{.LoggingDriver}} live-restore={{.LiveRestoreEnabled}}'
```

- **`log-driver: local`** ve **`max-size`/`max-file`**: Konteyner başına en fazla 5 × 20 MB log, sıkıştırılmış olarak. (`json-file` sürücüsü kullanmaya devam edeceksen aynı `log-opts`'u onunla da verebilirsin.) Bu ayar sadece **yeni oluşturulan** konteynerlere uygulanır.
- **`live-restore`**: Docker daemon'u yeniden başlatıldığında ya da güncellendiğinde çalışan konteynerler durmaz.

Diğer sık kullanılan ayarlar:

| Ayar | Ne zaman |
|---|---|
| `"data-root": "/srv/docker"` | İmajlar ve volume'ler varsayılan `/var/lib/docker` yerine ayrı, büyük bir diskte dursun |
| `"default-address-pools"` | Docker'ın konteyner ağları için seçtiği `172.17-31.x.x` aralıkları şirket ağıyla çakışıyorsa |
| `"registry-mirrors"` | Docker Hub için ayna/önbellek |
| `"userns-remap": "default"` | User namespace ile konteyner root'unu host'ta yetkisiz bir UID'ye eşle |

> **Dikkat:** `daemon.json`'da bir JSON sözdizimi hatası Docker'ın açılmasını engeller. Değiştirdikten sonra `dockerd --validate --config-file /etc/docker/daemon.json` ile doğrula, sonra yeniden başlat. Hata olursa `journalctl -u docker -n 30` sebebini söyler.

## Alıştırma (lab'da)

1. Kurulu Docker Engine, containerd ve Compose sürümlerini bul.
2. `daemon.json`'a log sınırlarını ekle. Ayardan **önce** başlatılmış bir konteyner ile **sonra** başlatılmış bir konteynerin log ayarlarını `docker inspect` ile karşılaştır.

<details><summary>Çözüm</summary>

```bash
docker version --format 'engine={{.Server.Version}} api={{.Server.APIVersion}}'
containerd --version
docker compose version --short

docker run -d --name once alpine sleep 3600
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" }, "live-restore": true }
EOF
systemctl restart docker
docker run -d --name sonra alpine sleep 3600
docker inspect -f '{{.Name}} {{.HostConfig.LogConfig}}' once sonra
docker rm -f once sonra
```

`once` eski log sürücüsüyle (`json-file`, sınırsız) devam ederken `sonra` yeni ayarı aldı. Var olan konteynerler yeni ayarı almak için **yeniden oluşturulmalıdır** (sadece yeniden başlatmak yetmez). `live-restore` sayesinde `once`, daemon yeniden başlarken durmadı.

</details>

```quiz
Şirketinde 400 kişi çalışıyor ve geliştiriciler Mac'te Docker Desktop kullanmak istiyor. Ne gerekir?
- Hiçbir şey, Docker ücretsiz
- [x] Docker Desktop için ücretli abonelik (ya da Colima/Podman gibi açık kaynak alternatifler)
- Sadece sunucular için lisans
? Docker Engine ücretsizdir. Docker Desktop büyük şirketlerde ücretli abonelik gerektirir.
```

```quiz
Bir sunucuda disk dolmuş ve `/var/lib/docker/containers` altında 40 GB'lık `-json.log` dosyaları var. Kalıcı çözüm?
- Dosyaları elle silmek
- [x] `daemon.json`'da log sürücüsü ve `max-size`/`max-file` sınırı tanımlayıp konteynerleri yeniden oluşturmak
- Docker'ı yeniden başlatmak
? Varsayılan json-file sürücüsü logları sınırsız büyütür. Sınır yeni oluşturulan konteynerlere uygulanır.
```

## Özet

- Sunucuda **Docker Engine** (resmî apt/dnf deposu, sürüm sabitlenmiş), bilgisayarda **Docker Desktop** ya da açık kaynak alternatifleri.
- Desktop büyük şirketlerde ücretli. Windows'ta WSL2, Mac'te mimari (arm64/amd64) farkına dikkat.
- `docker` grubu = root. Alternatif rootless mod.
- Docker Hub: resmî imajları tercih et, CI'da Personal Access Token.
- `daemon.json`: log sınırları (ilk iş), `live-restore`, `data-root`, adres havuzları.
