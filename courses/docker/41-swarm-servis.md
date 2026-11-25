# Servisler, ölçekleme, rolling update ve overlay ağ

Swarm'ın asıl değeri servis yönetiminde: kaç kopya, hangi node'larda, hangi kaynaklarla, yeni sürüme nasıl geçileceği ve bir şey ters giderse nasıl geri dönüleceği. Bu derste servisleri ayrıntılı olarak, ardından node'lar arasında konteynerleri birbirine bağlayan **overlay ağları** ve dışarıdan gelen trafiği dağıtan **routing mesh**'i göreceğiz.

```lab
Play with Docker
https://labs.play-with-docker.com/
Önceki dersteki 3 node'lu küme yoksa: üç node aç, node1'de "docker swarm init --advertise-addr $(hostname -i)", diğerlerinde çıktıdaki join komutu.
```

Bu dersteki komutlar **manager**'da (node1) çalıştırılır.

## Servis oluşturmak

```bash
docker service create --name api \
  --replicas 3 \
  --publish 8080:80 \
  --limit-cpu 0.5 --limit-memory 128M \
  --reserve-memory 64M \
  --env ORTAM=lab \
  --health-cmd "wget -q -O /dev/null http://127.0.0.1/ || exit 1" --health-interval 5s \
  nginx:1.27-alpine
docker service ls
docker service ps api
docker service inspect api --pretty | head -30
```

`docker run` seçeneklerinin çoğunun servis karşılığı var. Farklı olanlar:

- **`--limit-*`**: Sert sınır (`--memory`, `--cpus`).
- **`--reserve-*`**: **Zamanlama** için: Swarm bu servisi sadece bu kadar boş kaynağı olan node'lara yerleştirir. Hiçbir node'da yer yoksa task `Pending` kalır.
- Healthcheck: Swarm'da **anlamı var**. `unhealthy` olan task öldürülüp yerine yenisi başlatılır ve rolling update sırasında yeni task'ın sağlıklı olması beklenir (tek başına Docker'daki durumdan farklı).

### Replicated ve global

```bash
docker service create --name ajan --mode global alpine sleep 1d
docker service ps ajan
```

- **replicated** (varsayılan): Belirttiğin sayıda kopya, Swarm nereye koyacağına karar verir.
- **global**: **Her node'da tam bir kopya**. Yeni node eklenince ona da otomatik başlar. Log toplayıcıları, izleme ajanları (node-exporter), güvenlik ajanları için.

### Ölçekleme

```bash
docker service scale api=6
docker service ps api --filter desired-state=running
docker service scale api=2
```

## Nereye yerleşecek: placement

Önceki derste node'lara etiket vermiştik. Kısıtlar (constraints) **zorunludur**, tercihler (preferences) **dağıtım** içindir:

```bash
docker node update --label-add disk=ssd node2 2>/dev/null
docker service create --name db-benzeri --constraint 'node.labels.disk==ssd' alpine sleep 1d
docker service ps db-benzeri

docker service create --name sadece-worker --constraint 'node.role==worker' --replicas 2 alpine sleep 1d
docker service ps sadece-worker
```

`sadece-worker` servisi, bütün node'lar manager olduğu için (önceki dersteki `promote`) `Pending` kalır: kısıtı sağlayan node yok. `docker service ps` çıktısındaki hata sütunu "no suitable node" der.

Sık kullanılan kısıtlar: `node.role==manager|worker`, `node.hostname==node2`, `node.labels.X==Y`, `node.platform.arch==x86_64`.

Tercih örneği: replikaları `bolge` etiketine göre eşit dağıt (bir bölge kaybedilse bile her bölgede kopya olsun):

```bash
docker service create --name dagitik --replicas 4 --placement-pref 'spread=node.labels.bolge' alpine sleep 1d
docker service ps dagitik
docker service rm ajan db-benzeri sadece-worker dagitik
```

> **Durumlu servisler (veritabanları):** Swarm bir task'ı başka node'a taşıdığında, eski node'daki **yerel volume onunla gelmez**. Veritabanını Swarm'da çalıştırıyorsan ya bir node'a sabitle (`node.hostname==...` ya da etiket kısıtı) ya da paylaşımlı depolama (NFS, bulut diski için volume eklentisi) kullan. Pek çok ekip veritabanlarını orkestratörün dışında, yönetilen bir veritabanı hizmetinde çalıştırmayı tercih eder.

## Rolling update

Servisin imajını değiştirelim ve Swarm'ın replikaları nasıl değiştirdiğini izleyelim:

```bash
docker service scale api=4
docker service update \
  --update-parallelism 1 \
  --update-delay 5s \
  --update-order start-first \
  --update-failure-action rollback \
  --update-monitor 10s \
  --image nginx:1.27.3-alpine api
docker service ps api
```

| Ayar | Anlamı |
|---|---|
| `--update-parallelism 1` | Aynı anda kaç task güncellensin |
| `--update-delay 5s` | Gruplar arasında bekleme |
| `--update-order start-first` | Önce **yeni** task'ı başlat, sağlıklı olunca **eskiyi** durdur. Varsayılan `stop-first` kısa süre kapasiteyi düşürür |
| `--update-monitor 10s` | Her yeni task'ı bu süre izle. Bu sürede çökerse güncelleme "başarısız" sayılır |
| `--update-failure-action rollback` | Başarısızlıkta otomatik **geri dön** (varsayılan `pause`: dur ve bekle) |
| `--update-max-failure-ratio` | Ne oranda başarısızlık tolere edilsin |

`start-first` + healthcheck birlikte, Compose'da yaşadığımız yeniden başlatma boşluğunu ortadan kaldırır: eski task, yeni task sağlıklı olana kadar trafik almaya devam eder.

Güncelleme sırasında başka bir terminalde istek atarak kesinti olup olmadığını görebilirsin:

```bash
for i in $(seq 1 60); do curl -s -o /dev/null -w '%{http_code} ' localhost:8080; sleep 0.5; done; echo
```

### Bozuk sürüm ve otomatik geri alma

Var olmayan bir imaj ya da açılışta çöken bir sürüm deploy edelim:

```bash
docker service update --image nginx:1.27-alpine --entrypoint "sh -c 'exit 1'" api
sleep 30
docker service ps api | head -8
docker service inspect api --format '{{.UpdateStatus.State}}: {{.UpdateStatus.Message}}'
```

Yeni task'lar çöktü, Swarm güncellemeyi başarısız saydı ve **otomatik olarak önceki tanıma geri döndü** (`rollback_completed`). Uygulama boyunca eski task'lar trafik almaya devam etti.

Elle geri alma da tek komut:

```bash
docker service rollback api
```

Swarm, servisin **bir önceki** tanımını saklar. Rollback ayarları da güncelleme ayarlarına paraleldir (`--rollback-parallelism`, `--rollback-order`...).

## Overlay ağlar

Farklı node'lardaki konteynerlerin birbiriyle konuşabilmesi için **overlay** ağ gerekir. Overlay, node'lar arasında VXLAN tünelleri (4789/udp) üzerinden çalışan sanal bir ağdır. Konteynerler aynı L2 ağdaymış gibi birbirini görür.

```bash
docker network create --driver overlay --attachable uygulama-ag
docker service create --name redis --network uygulama-ag redis:7-alpine
docker service create --name istemci --network uygulama-ag --replicas 3 alpine sh -c 'while true; do sleep 3600; done'
docker service ps istemci
```

`istemci` task'ları farklı node'larda. Herhangi birinde `redis`'e adıyla ulaşalım. Bulunduğun node'da çalışan bir `istemci` konteyneri seç:

```bash
C=$(docker ps --filter name=istemci -q | head -1)
docker exec $C sh -c 'apk add -q redis >/dev/null 2>&1; redis-cli -h redis ping'
docker exec $C nslookup redis 2>/dev/null | tail -2
docker exec $C nslookup tasks.redis 2>/dev/null | tail -2
```

### VIP ve DNS round-robin

Servis adı (`redis`) tek bir **sanal IP**'ye (VIP) çözülür. Bu IP'ye gelen bağlantıları çekirdekteki IPVS, servisin sağlıklı task'larına dağıtır. `tasks.redis` ise her task'ın gerçek IP'sini döner.

| | Çözümleme | Ne zaman |
|---|---|---|
| `--endpoint-mode vip` (varsayılan) | Tek VIP, yük dağıtımı çekirdekte | Çoğu durum |
| `--endpoint-mode dnsrr` | DNS her task'ın IP'sini döner | İstemci kendi yük dağıtımını yapacaksa |

VIP'in bir sonucu: Compose'daki "nginx DNS'i sadece açılışta çözer" sorunu burada yok. VIP sabit kalır, arkasındaki task'lar değişse bile.

### Ağ seçenekleri

- `--attachable`: `docker run --network` ile tekil konteynerlerin (servis olmayan) de bu ağa katılmasına izin verir. Teşhis için kullanışlı.
- `--opt encrypted`: Node'lar arası overlay trafiğini IPsec ile şifreler. Ağ güvenilir değilse (bulutta farklı bölgeler, paylaşımlı ağ). Küçük bir performans bedeli var.
- `--internal`: Dışarıya çıkışı olmayan overlay ağ (Compose'daki gibi).

## Routing mesh

`--publish 8080:80` ile yayınlanan bir porta **herhangi bir node'un** IP'sinden bağlanabilirsin, o node'da task olmasa bile:

```bash
docker service scale api=1
docker service ps api --filter desired-state=running
for n in node1 node2 node3; do echo -n "$n: "; curl -s -o /dev/null -w '%{http_code}\n' $(getent hosts $n | awk '{print $1}'):8080 2>/dev/null || echo "?"; done
```

(Play with Docker'da node adları birbirini çözemeyebilir. O durumda her node'un `hostname -i` çıktısındaki IP'yi kullan.)

Bu, Swarm'ın **ingress** adlı özel overlay ağı ve her node'daki IPVS yük dengeleyicisi sayesinde olur: gelen bağlantı, task'ın çalıştığı node'a yönlendirilir. Önüne bir dış yük dengeleyici (bulut LB, haproxy) koyup bütün node'ları hedef olarak vermek yeterli olur.

İki bedeli var:

- Ek bir ağ atlaması ve NAT: İstemcinin **gerçek IP'si** uygulamaya ulaşmaz.
- Bazı durumlarda istenmez (her node'da bir tane çalışan reverse proxy gibi).

Alternatif **host modu** yayınlama:

```bash
docker service create --name kenar --mode global --publish mode=host,target=80,published=8088 nginx:1.27-alpine
```

Her node'da task'ın kendisi doğrudan host portunu dinler: gerçek istemci IP'si korunur, ama o portu sadece o node'daki task kullanır ve bir node'da birden fazla replika olamaz. Kenar proxy'leri (Traefik, nginx) genelde `global` + `mode=host` ile çalıştırılır.

## Loglar ve teşhis

```bash
docker service logs api --tail 5
docker service logs -f --raw redis &
sleep 3; kill %1
docker service ps api --no-trunc --format '{{.Name}} {{.Node}} {{.CurrentState}} {{.Error}}'
```

`docker service logs` bütün node'lardaki task'ların loglarını tek akışta toplar (task adı ve node önekiyle). `service ps --no-trunc`'taki `Error` sütunu, task'ların neden başlamadığını söyler: imaj çekilemedi, kaynak yetersiz, kısıt sağlanmadı, healthcheck başarısız.

## Temizlik

```bash
docker service rm api redis istemci kenar 2>/dev/null
docker network rm uygulama-ag
```

## Alıştırma (lab'da)

1. `traefik/whoami` imajından 4 replikalı bir servis oluştur, 8090 portundan yayınla. Arka arkaya istek atıp cevaplardaki `Hostname` alanının değiştiğini gör.
2. Servisi `--update-order start-first --update-parallelism 2` ile `--env SURUM=2` ekleyerek güncelle. Güncelleme sırasında istek atmaya devam eden bir döngüyle kesinti olup olmadığını kontrol et.
3. Servisi elle bir önceki sürüme geri al ve `docker service inspect --pretty` ile ortam değişkeninin kalktığını doğrula.

<details><summary>Çözüm</summary>

```bash
docker service create --name who --replicas 4 --publish 8090:80 traefik/whoami
sleep 5
for i in 1 2 3 4 5 6; do curl -s localhost:8090 | grep Hostname; done

(for i in $(seq 1 80); do curl -s -o /dev/null -w '%{http_code} ' localhost:8090; sleep 0.25; done; echo) &
docker service update --update-order start-first --update-parallelism 2 --env-add SURUM=2 who
wait

docker service rollback who
docker service inspect who --pretty | grep -A3 -i env
docker service rm who
```

1: VIP üzerinden gelen istekler task'lara dağıtılır, her cevapta farklı bir konteyner adı görürsün.

2: Döngünün çıktısında hepsi `200` olmalı. `start-first` sayesinde yeni task hazır olmadan eskisi durdurulmadı.

3: Rollback sonrası `SURUM` değişkeni yok.

</details>

```quiz
Rolling update sırasında kısa süreli 502 hataları oluyor. Hangi ayar en çok yardımcı olur?
- `--update-parallelism 10`
- [x] `--update-order start-first` ve sağlıklı bir healthcheck
- `--update-delay 0s`
? Varsayılan stop-first önce eskiyi durdurur. start-first yeni task sağlıklı olana kadar eskiyi tutar.
```

```quiz
Swarm'da bir servise `redis` adıyla bağlanınca DNS tek bir IP dönüyor. Bu IP nedir?
- Rastgele bir task'ın IP'si
- [x] Servisin sanal IP'si (VIP). Bağlantılar IPVS ile task'lara dağıtılır
- Manager'ın IP'si
? Her task'ın IP'si için `tasks.redis` sorgulanır.
```

```quiz
Uygulama loglarında bütün istemci IP'leri aynı (ingress ağının adresi) görünüyor. Gerçek IP'yi korumanın yolu?
- `--endpoint-mode dnsrr`
- [x] Portu `mode=host` ile yayınlamak (genelde global bir kenar proxy ile)
- Overlay ağı şifrelemek
? Routing mesh NAT yaptığı için kaynak IP kaybolur. Host modu yayınlamada task host portunu doğrudan dinler.
```

```quiz
Veritabanı servisinin task'ı başka bir node'a taşındı ve veriler "kayboldu". Neden?
- Swarm verileri siler
- [x] Yerel volume eski node'da kaldı, yeni node'da boş bir volume oluşturuldu
- Overlay ağ bağlantısı koptu
? Durumlu servisler bir node'a sabitlenmeli ya da paylaşımlı depolama kullanmalı.
```

## Özet

- `service create/ls/ps/inspect/scale/update/rollback/logs`. Replicated ve global modlar.
- `--limit-*` sert sınır, `--reserve-*` zamanlama. Healthcheck Swarm'da task değiştirmeyi tetikler.
- Placement: `--constraint` zorunlu, `--placement-pref spread=` dağıtım. Durumlu servisleri sabitle.
- Rolling update: `parallelism`, `delay`, `order start-first`, `monitor`, `failure-action rollback`.
- Overlay ağ: node'lar arası, servis adı → VIP, `tasks.<servis>` → task IP'leri, `--attachable`, `--opt encrypted`.
- Routing mesh: her node'dan erişim, kaynak IP kaybolur. Alternatif `mode=host`.
