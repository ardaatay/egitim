# Uçtan uca deploy betiği

Bu derste bölümdeki her şeyi tek bir betikte topluyoruz: release klasörleri, paylaşılan dosyalar, atomik symlink geçişi, servis yeniden başlatma, sağlık kontrolü, **başarısızlıkta otomatik geri alma**, eski sürümlerin temizliği, kilit ve kuru çalıştırma.

Betik POSIX `sh` ile yazıldı. Böylece hem tarayıcıdaki BusyBox'ta hem de gerçek sunucuda bash ya da dash ile değişmeden çalışır. Sunucuya özel kısımlar (servisi yeniden başlatma, sağlık kontrolü) ortam değişkenleriyle dışarıdan verilir. Tarayıcıda bunları basit komutlarla taklit edeceğiz, sunucuda `systemctl` ve `curl` olacaklar.

## Paket: deploy edilen şey

Betik, CI'ın ürettiği bir **tar paketini** alır. Kaynak kodu sunucuda derlemek yerine hazır paket dağıtmak, her sunucuya birebir aynı içeriğin gitmesini ve deploy'un hızlı olmasını sağlar.

Tarayıcıda üç paket üretelim: iki sağlam sürüm ve sağlık kontrolünden geçemeyen bozuk bir sürüm. Uygulamamız `--health` ile çağrılınca sağlık durumunu bildiren küçük bir betik:

```terminal
mkdir -p /tmp/ci && cd /tmp/ci
paket() {
  rm -rf build && mkdir build
  cat > build/app.sh <<EOF
#!/bin/sh
if [ "\${1:-}" = "--health" ]; then
  [ "$2" = "saglam" ] && { echo "ok"; exit 0; } || { echo "veritabanına bağlanamadım" >&2; exit 1; }
fi
echo "odeme-api $1"
EOF
  chmod +x build/app.sh
  echo "$1" > build/VERSION
  tar cf - -C build . | gzip > "odeme-api-$1.tgz" && echo "paket hazır: /tmp/ci/odeme-api-$1.tgz"
}
paket 1.0.0 saglam
paket 1.1.0 saglam
paket 1.2.0 bozuk
ls -l /tmp/ci/*.tgz
cd ~
```

## Betik

Aşağıdaki bloğu çalıştırınca betik `/usr/local/bin/deploy` olarak kaydedilir. Önce bütün hâlini oku, ardından bölüm bölüm açıklayacağız.

```terminal
unset -f deploy 2>/dev/null   # önceki dersten kalan aynı adlı fonksiyon varsa kaldır
mkdir -p /usr/local/bin; export PATH="/usr/local/bin:$PATH"   # küçük Linux'ta bu klasör yok
cat > /usr/local/bin/deploy <<'BETIK'
#!/bin/sh
# deploy: tar paketini release olarak kurar, current'i çevirir,
# sağlık kontrolü yapar, başarısızsa önceki sürüme döner.
set -eu

APP_ROOT=${APP_ROOT:-/srv/odeme-api}
KEEP=${KEEP:-3}
RESTART_CMD=${RESTART_CMD:-systemctl restart odeme-api}
HEALTH_CMD=${HEALTH_CMD:-curl -fsS -m 2 http://127.0.0.1:8000/health}
HEALTH_TRIES=${HEALTH_TRIES:-10}
SHARED_LINKS=${SHARED_LINKS:-.env uploads}

KURU=0
log()  { printf '%s deploy: %s\n' "$(date +%T)" "$*" >&2; }
olum() { log "HATA: $*"; exit 1; }
calistir() { if [ "$KURU" -eq 1 ]; then log "[kuru] $*"; else "$@"; fi; }

kullanim() { echo "Kullanım: deploy [-n] <paket.tgz> | deploy --rollback" >&2; exit 2; }

paketi_ac() { gzip -dc "$1" | tar xf - -C "$2"; }

symlink_cevir() {   # $1: hedef release klasörü (atomik)
  calistir ln -sfn "$1" "$APP_ROOT/current.yeni"
  calistir mv -T "$APP_ROOT/current.yeni" "$APP_ROOT/current"
}

saglikli_mi() {
  i=1
  while [ "$i" -le "$HEALTH_TRIES" ]; do
    if sh -c "$HEALTH_CMD" >/dev/null 2>&1; then log "sağlık kontrolü geçti ($i. deneme)"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

onceki_release() {  # current'ten daha eski olanların en yenisi
  ls -1d "$APP_ROOT"/releases/* 2>/dev/null | sort | awk -v s="$1" '$0 < s' | tail -n 1
}

temizle() {
  aktif=$(readlink "$APP_ROOT/current" 2>/dev/null || true)
  ls -1d "$APP_ROOT"/releases/* 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r d; do
    [ "$d" = "$aktif" ] && continue
    log "eski release siliniyor: ${d##*/}"
    calistir rm -rf "$d"
  done
}

rollback() {
  simdiki=$(readlink "$APP_ROOT/current") || olum "current yok"
  onceki=$(onceki_release "$simdiki")
  [ -n "$onceki" ] || olum "geri dönülecek release yok"
  log "geri alınıyor: ${simdiki##*/} -> ${onceki##*/}"
  symlink_cevir "$onceki"
  calistir sh -c "$RESTART_CMD"
  saglikli_mi || olum "geri alınan sürüm de sağlıksız, elle müdahale gerekli"
}

deploy() {
  paket=$1
  [ -f "$paket" ] || olum "paket bulunamadı: $paket"
  R="$APP_ROOT/releases/$(date +%Y%m%d-%H%M%S)"
  [ -e "$R" ] && olum "release zaten var: $R"
  onceki=$(readlink "$APP_ROOT/current" 2>/dev/null || true)

  log "release hazırlanıyor: ${R##*/}"
  calistir mkdir -p "$R"
  # Hazırlık sırasında hata olursa yarım release'i sil
  trap 'log "hazırlık başarısız, temizleniyor"; rm -rf "$R"' EXIT
  calistir gzip -t "$paket"            # paket bozuk mu? (yarım kopyalanmış dosya vb.)
  calistir paketi_ac "$paket" "$R"
  for l in $SHARED_LINKS; do
    calistir ln -sfn "$APP_ROOT/shared/$l" "$R/$l"
  done
  trap - EXIT

  log "current çevriliyor: ${onceki##*/} -> ${R##*/}"
  symlink_cevir "$R"
  log "servis yeniden başlatılıyor"
  calistir sh -c "$RESTART_CMD"

  if [ "$KURU" -eq 1 ] || saglikli_mi; then
    log "deploy başarılı: $(cat "$R/VERSION" 2>/dev/null || echo "${R##*/}")"
    temizle
  else
    log "sağlık kontrolü başarısız!"
    if [ -n "$onceki" ]; then
      rollback
      log "sorunlu release incelenmek üzere bırakıldı: $R"
    fi
    exit 1
  fi
}

# --- ana akış ---
[ "${1:-}" = "-n" ] && { KURU=1; shift; }
[ $# -eq 1 ] || kullanim
mkdir -p "$APP_ROOT/releases" "$APP_ROOT/shared"
exec 9> "$APP_ROOT/.deploy.lock"
flock -n 9 || olum "başka bir deploy çalışıyor"

case $1 in
  --rollback) rollback ;;
  *) deploy "$1" ;;
esac
BETIK
chmod +x /usr/local/bin/deploy
deploy; echo "kod: $?"
```

Son satır argümansız çağırdı ve kullanım mesajını verdi (çıkış kodu 2).

> Paketi `tar czf` yerine `tar cf - | gzip` ile oluşturup `gzip -dc | tar xf -` ile açıyoruz. BusyBox'ın `tar`'ı `-z` seçeneğini desteklemiyor, boru biçimi ise her sistemde çalışır. Açmadan önce `gzip -t` ile paketin bütünlüğü kontrol ediliyor. Boru içindeki `gzip` hatası `set -e`'yi tetiklemeyebileceği için (POSIX `sh`'ta `pipefail` her zaman yok) bu ayrı kontrol önemli.

## Tarayıcıda deneyelim

Sunucuya özel kısımları taklit eden ayarlar: yeniden başlatma bir log satırı, sağlık kontrolü uygulamanın `--health` çağrısı. Paylaşılan dosyaları da hazırlayalım:

```terminal
export APP_ROOT=/srv/odeme-api
export RESTART_CMD='echo "(servis yeniden başlatıldı)" >&2'
export HEALTH_CMD="$APP_ROOT/current/app.sh --health"
export HEALTH_TRIES=3
rm -rf $APP_ROOT
mkdir -p $APP_ROOT/shared/uploads
echo "DATABASE_URL=postgres://db/odeme" > $APP_ROOT/shared/.env
```

Önce **kuru çalıştırma**. Hiçbir şey değişmeden ne yapılacağını görelim:

```terminal
deploy -n /tmp/ci/odeme-api-1.0.0.tgz
ls $APP_ROOT/releases
```

Şimdi gerçek deploy'lar:

```terminal
deploy /tmp/ci/odeme-api-1.0.0.tgz
sleep 1
deploy /tmp/ci/odeme-api-1.1.0.tgz
$APP_ROOT/current/app.sh
ls -la $APP_ROOT/current/
```

Ve bozuk sürüm. Sağlık kontrolünden geçemeyecek ve betik kendiliğinden geri alacak:

```terminal
sleep 1
deploy /tmp/ci/odeme-api-1.2.0.tgz; echo "deploy çıkış kodu: $?"
$APP_ROOT/current/app.sh
ls -1 $APP_ROOT/releases
```

Çalışan sürüm hâlâ 1.1.0. Bozuk release diskte incelenmek üzere duruyor ve betik **sıfır olmayan kodla** çıktı. CI/CD hattı bunu görüp deploy'u başarısız olarak işaretler.

Elle geri alma ve eski sürümlerin temizliği:

```terminal
deploy --rollback
$APP_ROOT/current/app.sh
for v in 1.1.0 1.0.0 1.1.0 1.0.0; do sleep 1; deploy /tmp/ci/odeme-api-$v.tgz 2>&1 | grep -E 'başarılı|siliniyor'; done
ls -1 $APP_ROOT/releases
```

`KEEP=3` olduğu için en fazla 3 release kaldı ve aktif olan hiçbir zaman silinmedi.

Son olarak kilidi deneyelim. Sağlık kontrolünü yavaşlatıp iki deploy'u aynı anda başlatalım:

```terminal
(HEALTH_CMD="sleep 3; true" deploy /tmp/ci/odeme-api-1.1.0.tgz 2>&1 | tail -1 &) ; sleep 1; deploy /tmp/ci/odeme-api-1.0.0.tgz; sleep 4
```

İkinci deploy "başka bir deploy çalışıyor" diyerek hemen çıktı.

## Betiğin önemli kararları

**Hazırlık hatasında temizlik.** `tar` ya da bağlantı adımında hata olursa `set -e` betiği durdurur ve `trap ... EXIT` yarım kalan release klasörünü siler. `current`'e dokunulmadan önce `trap - EXIT` ile bu temizlik kaldırılır, çünkü artık release kullanımda olabilir.

**Sağlık kontrolü tekrar denemeli.** Uygulama yeniden başlatıldıktan hemen sonra henüz hazır olmayabilir. Tek denemelik bir kontrol sağlam sürümleri de geri alır. `HEALTH_TRIES` ve aradaki `sleep` bunu çözer. `Type=notify` kullanan servislerde `systemctl restart` uygulama hazır olunca döndüğü için deneme sayısı az olabilir.

**Geri alma da doğrulanır.** Geri alınan sürüm de sağlıksızsa (örneğin sorun veritabanındaysa) betik bunu gizlemez, açık bir hatayla durur. Otomasyonun "çözemediği" durumu insana net olarak bildirmesi gerekir.

**Bozuk release silinmez.** Logları ve dosyaları incelemek için diskte kalır. Bir sonraki başarılı deploy'daki temizlik onu zamanı gelince kaldırır.

**Tek kopya.** `flock` ile aynı anda iki deploy'un aynı `current`'i çevirmesi engellenir. Kilit fd 9'a bağlı, betik nasıl biterse bitsin kalkar.

## Gerçek sunucuda kullanım

Sunucuda ortam değişkenlerinin varsayılanları zaten gerçek komutlar. CI hattından (GitHub Actions, GitLab CI) tipik çağrı:

```bash
scp odeme-api-1.4.0.tgz deploy@sunucu:/tmp/
ssh deploy@sunucu 'sudo /usr/local/bin/deploy /tmp/odeme-api-1.4.0.tgz'
```

Deploy kullanıcısının sudo kuralı, izinler dersindeki gibi sadece bu betikle sınırlanır:

```text
deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy
```

Bu durumda betiğin kendisi root'a ait olmalı ve başkası tarafından yazılabilir olmamalı (`chown root:root`, `chmod 755`). Aksi hâlde deploy kullanıcısı betiği değiştirip root olarak istediğini çalıştırabilir.

Python uygulaması için hazırlık adımına venv kurulumu eklenir (release başına venv, önceki derste tartıştık):

```bash
calistir python3 -m venv "$R/venv"
calistir "$R/venv/bin/pip" install -q --no-index --find-links "$R/wheels" -r "$R/requirements.txt"
```

`--no-index --find-links` ile bağımlılıklar CI'da önceden indirilip pakete konmuş wheel'lerden kurulur. Deploy sırasında PyPI'a erişim gerekmez, sürümler sabitlenir.

## Ne zaman bir araca geçmeli?

Bu betik tek sunucu ve basit bir uygulama için yeterli ve her satırını anladığın için hata ayıklaması kolay. Şunlar gerekmeye başlayınca hazır araçlara geç:

- **Birden fazla sunucu**, sıralı (rolling) deploy, sunucu gruplarına göre farklı ayar: **Ansible**.
- **Konteyner** ve imaj tabanlı dağıtım: Docker kursu.
- **Otomatik ölçekleme**, bildirimsel (declarative) durum, kendi kendini iyileştirme: Kubernetes kursu.

Bu araçların hepsi, burada elle yaptığın adımları (paket, atomik geçiş, sağlık kontrolü, geri alma) farklı soyutlamalarla otomatikleştirir.

## Alıştırma

1. Betiğe bir `--list` seçeneği ekle: release'leri listelesin ve aktif olanın yanına `*` koysun.
2. `RESTART_CMD` başarısız olursa (örneğin `false`) ne oluyor? `set -e` yüzünden betik geri almadan çıkıyor mu? Deneyerek bul ve davranışı düzelt: yeniden başlatma başarısız olursa da geri alınsın.

<details><summary>İpuçları ve çözüm</summary>

1: `case` bloğuna bir dal:

```text
  --list)
    aktif=$(readlink "$APP_ROOT/current" 2>/dev/null || true)
    for d in $(ls -1d "$APP_ROOT"/releases/* | sort); do
      [ "$d" = "$aktif" ] && echo "* ${d##*/}" || echo "  ${d##*/}"
    done ;;
```

2: Dene:

```terminal
sleep 1; RESTART_CMD=false deploy /tmp/ci/odeme-api-1.1.0.tgz; echo "kod: $?"
readlink $APP_ROOT/current
```

`current` yeni release'e çevrilmiş ama yeniden başlatma başarısız olduğu için `set -e` betiği durdurdu, geri alma çalışmadı. Gerçek sunucuda bu, symlink yeni sürümü gösterirken eski kodun (ya da hiçbir şeyin) çalışması demek. Düzeltme: yeniden başlatmayı sağlık kontrolünün parçası yap.

```text
  if [ "$KURU" -eq 1 ] || { sh -c "$RESTART_CMD" && saglikli_mi; }; then
```

(ve önceki `calistir sh -c "$RESTART_CMD"` satırını kaldır). `if` bağlamında `set -e` devre dışı olduğu için başarısızlık artık `else` dalına, yani geri almaya düşer. Bu, önceki dersteki "`set -e` her şeyi yakalamaz, kritik adımları açıkça kontrol et" kuralının tam örneği.

</details>

```quiz
Deploy betiği sağlık kontrolünü neden tek seferde değil, birkaç denemeyle yapıyor?
- Ağ güvenilmez olduğu için
- [x] Uygulama yeniden başladıktan hemen sonra henüz hazır olmayabilir. Tek deneme sağlam sürümleri de geri alır
- Daha uzun sürmesi daha güvenli olduğu için
? Tekrar sayısı ve aralık uygulamanın açılış süresine göre ayarlanır.
```

```quiz
Deploy kullanıcısına `NOPASSWD: /usr/local/bin/deploy` sudo izni verdin. Betik dosyası hangi koşulu sağlamalı?
- Deploy kullanıcısına ait olmalı
- [x] Root'a ait olmalı ve başkası tarafından yazılamamalı
- Çalıştırma izni olmamalı
? Betiği değiştirebilen biri root olarak istediği komutu çalıştırabilir.
```

## Özet

- Paket (CI çıktısı) → yeni release → paylaşılanları bağla → atomik geçiş → restart → sağlık kontrolü → başarısızsa geri al → temizle.
- Hazırlık hatasında yarım release `trap` ile silinir, `current`'e dokunulmaz.
- Sağlık kontrolü tekrar dener, geri alma da doğrulanır, bozuk release incelenmek üzere kalır.
- `flock` ile tek deploy, `-n` ile kuru çalıştırma, sıfır olmayan çıkış kodu ile CI'a bildirim.
