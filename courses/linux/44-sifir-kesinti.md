# Release klasörleri, symlink ve geri alma

En riskli deploy yöntemi, çalışan uygulamanın klasörüne `git pull` ya da `rsync` yapmaktır. Kopyalama sürerken uygulama yarısı eski yarısı yeni dosyalarla çalışır, bağımlılık kurulumu yarıda kalırsa uygulama açılmaz ve geri dönmek için "önceki hâli" bir yerden bulman gerekir.

Bu derste Capistrano, Deployer ve benzeri araçların kullandığı, sadece klasörler ve bir symlink'le kurulan düzeni öğreneceğiz. Her sürüm ayrı bir klasöre hazırlanır, hazır olunca tek bir **atomik** işlemle aktif hâle getirilir, geri almak da aynı işlemin tersidir.

## Düzen

```text
/srv/odeme-api/
├── releases/
│   ├── 20261124-091500/      eski
│   ├── 20261125-103000/      bir önceki
│   └── 20261125-151200/      yeni
├── shared/                   sürümler arasında kalıcı olanlar
│   ├── .env
│   ├── uploads/
│   └── venv/ (ya da node_modules önbelleği)
└── current -> releases/20261125-151200
```

- Servis, nginx ve cron her zaman **`current`** üzerinden çalışır: `WorkingDirectory=/srv/odeme-api/current`.
- Sürüme ait olmayan her şey (`.env`, yüklenen dosyalar) `shared/` altında durur ve her sürüme symlink ile bağlanır.
- Eski sürümler diskte kalır. Geri almak = `current`'i bir önceki klasöre çevirmek.

## Tarayıcıda kuralım

Bu dersin büyük kısmı tarayıcıdaki Linux'ta çalışıyor. Önce iskelet ve "deploy edilecek" bir uygulama üreten küçük bir yardımcı:

```terminal
B=/srv/odeme-api
mkdir -p $B/releases $B/shared/uploads
echo "DATABASE_URL=postgres://db/odeme" > $B/shared/.env
echo "kullanıcı yüklemesi" > $B/shared/uploads/fatura-1.pdf

paket_uret() {
  echo "#!/bin/sh"                         >  /tmp/app.sh
  echo "echo \"odeme-api sürüm $1 çalışıyor (klasör: \$(dirname \$(readlink -f \$0)))\"" >> /tmp/app.sh
  chmod +x /tmp/app.sh
}
tree $B
```

### İlk deploy

Her deploy aynı adımları izler: yeni klasör, kodu koy, paylaşılanları bağla, hazırla, **en son** `current`'i çevir.

```terminal
deploy() {
  SURUM=$1
  R=$B/releases/$(date +%Y%m%d-%H%M%S)
  mkdir -p $R
  paket_uret $SURUM && cp /tmp/app.sh $R/app.sh
  ln -s $B/shared/.env $R/.env
  ln -s $B/shared/uploads $R/uploads
  echo "$SURUM" > $R/SURUM
  ln -s $R $B/current.yeni && mv -T $B/current.yeni $B/current
  echo "aktif: $(readlink $B/current)"
}
deploy 1.0.0
$B/current/app.sh
ls -la $B/current/
```

`ls -la` çıktısında `.env` ve `uploads`'ın `shared/`'a giden link'ler olduğunu gör.

### Atomik geçiş: neden `mv -T`?

En çok görülen yazım `ln -sfn yeni_klasor current`'tir. Ama `ln -sf` arka planda iki sistem çağrısı yapar: önce eski link'i **siler** (`unlink`), sonra yenisini **oluşturur** (`symlink`). Arada çok kısa bir an `current` diye bir şey yoktur ve tam o anda gelen bir istek ya da servisin yeniden başlaması "No such file or directory" ile karşılaşabilir.

`mv -T` ise `rename()` sistem çağrısını kullanır. POSIX, `rename`'in **atomik** olduğunu garanti eder: `current` ya eskiyi ya yeniyi gösterir, arası yoktur. Bu yüzden yeni link'i geçici bir adla oluşturup üzerine taşıdık. (`-T`, hedef bir klasörse "içine taşıma, kendisinin yerine geç" demektir. Onsuz `mv` link'i `current`'in gösterdiği klasörün **içine** taşırdı.)

### İkinci deploy ve çalışan süreçler

Şimdi önemli bir ayrıntı: Çalışan bir süreç `current` symlink'ini değil, **başladığı andaki gerçek klasörü** tutar. Uygulamanın uzun süre çalışan bir süreç olduğunu varsayalım ve onu `current` içinden başlatalım:

```terminal
cd $B/current && sh -c 'while true; do sleep 1; done' &
UYG=$!
cd ~
sleep 1
deploy 1.1.0
echo "current: $(readlink $B/current)"
echo "çalışan süreç: $(readlink /proc/$UYG/cwd)"
```

`current` yeni sürümü gösteriyor ama çalışan süreç hâlâ eski klasörde. Symlink'i değiştirmek **çalışan uygulamayı değiştirmez**. Yeni kodun devreye girmesi için süreç yeniden başlatılmalı ya da yeniden yüklenmeli (gunicorn HUP, `systemctl reload`). Python ve Node gibi dillerde kod başlangıçta belleğe yüklendiği için bu her zaman böyledir. PHP-FPM'de ise her istek dosyaları yeniden çözümler, ama OPcache yol önbelleği yüzünden FPM'in de yeniden yüklenmesi gerekir.

```terminal
kill $UYG
$B/current/app.sh
```

Bu yüzden deploy betiği symlink'ten sonra mutlaka servisi yeniden başlatır ve sağlık kontrolü yapar.

### Geri alma

1.1.0 sorunlu çıktı. Geri almak, bir önceki release klasörünü bulup `current`'i ona çevirmektir:

```terminal
geri_al() {
  SIMDIKI=$(readlink $B/current)
  ONCEKI=$(ls -1d $B/releases/* | sort | awk -v s="$SIMDIKI" '$0 < s' | tail -n 1)
  [ -z "$ONCEKI" ] && { echo "geri dönülecek sürüm yok"; return 1; }
  ln -s $ONCEKI $B/current.yeni && mv -T $B/current.yeni $B/current
  echo "geri alındı: $SIMDIKI -> $ONCEKI"
}
geri_al
$B/current/app.sh
```

`awk '$0 < s'` aktif sürümden **daha eski** olanları seçer, `tail -n 1` bunların en yenisini alır. Gerçek sunucuda bunu `systemctl restart odeme-api` ve sağlık kontrolü izler. Bütün geri alma birkaç saniye sürer, çünkü hiçbir şey yeniden kurulmaz ya da derlenmez.

> **Dikkat:** Kod geri alınabilir, **veritabanı göçleri (migration) her zaman geri alınamaz.** Bir sütunu silen ya da yeniden adlandıran bir göç, eski kodu bozar. Güvenli yol "genişlet / daralt" (expand/contract): önce eski ve yeni kodun birlikte çalışabileceği göçü yap (yeni sütunu ekle, ikisine birden yaz), kod tamamen yerleşince eski sütunu sonraki bir deploy'da kaldır. Böylece kodu geri almak her zaman güvenli kalır.

### Eski sürümleri temizlemek

Release klasörleri diski doldurmasın. Son 3 sürümü tut, kalanını sil. Ama **aktif olanı asla**:

```terminal
deploy 1.2.0; sleep 1; deploy 1.3.0; sleep 1; deploy 1.4.0
ls -1 $B/releases
temizle() {
  AKTIF=$(readlink $B/current)
  ls -1d $B/releases/* | sort -r | tail -n +4 | grep -v "^$AKTIF\$" | while read d; do
    echo "siliniyor: $d"; rm -rf "$d"
  done
}
temizle
ls -1 $B/releases
readlink $B/current
```

Release adlarının `YYYYMMDD-HHMMSS` biçiminde olması, düz metin sıralamasının zaman sıralamasıyla aynı olmasını sağlar. Bu yüzden `ls -t` (değişiklik zamanı, yanıltıcı olabilir) yerine `sort` kullandık.

## Gerçek sunucuda tam akış

Tarayıcıdaki fonksiyonların gerçek hâli bir deploy betiğidir. Bash betikleri bölümünde bunu hata yönetimiyle birlikte baştan yazacağız. Adımlar:

```text
1. Yeni release klasörü oluştur           mkdir releases/$(date +%Y%m%d-%H%M%S)
2. Kodu koy                               git archive | tar x   ya da CI paketini aç
3. Paylaşılanları bağla                   ln -s ../../shared/.env .env
4. Bağımlılıklar / derleme                pip install, npm ci --omit=dev
5. (gerekirse) veritabanı göçü            geriye uyumlu olmalı
6. current'i atomik çevir                 ln -s ... current.yeni && mv -T current.yeni current
7. Servisi yeniden yükle/başlat           systemctl reload|restart odeme-api
8. Sağlık kontrolü                        başarısızsa otomatik geri al
9. Eski release'leri temizle              son 5'i tut
```

Önemli olan sıralama: 6. adıma kadar çalışan sistem hiç etkilenmez. 4. adım başarısız olursa yarım kalan klasör silinir ve hiçbir kullanıcı bir şey fark etmez.

### Python venv nereye?

İki yaklaşım var:

- **Her release'in kendi venv'i** (`releases/X/venv`): Her sürüm bağımlılıklarıyla birlikte tam ve bağımsızdır. Geri alma bağımlılıkları da geri alır. Bedeli: her deploy'da kurulum süresi ve disk. pip önbelleği ya da önceden derlenmiş wheel'ler bu süreyi kısaltır. **Önerilen yol budur.**
- **Paylaşılan venv** (`shared/venv`): Hızlıdır ama bağımlılık değiştiğinde çalışan eski sürüm de etkilenir ve geri alma bağımlılıkları geri almaz.

Node'da da `node_modules` her release'in içinde olmalı (`npm ci` hızlı ve önbellekli).

### Gerçekten sıfır kesinti

Symlink yöntemi geçişi atomik yapar, ama **servisin yeniden başlaması** hâlâ birkaç saniyelik bir boşluk bırakabilir. Önceki derste gördük: `restart` sırasında gelen istekler 502 alır. Seçenekler:

| Yöntem | Nasıl | Not |
|---|---|---|
| **Graceful reload** | gunicorn/puma/unicorn HUP ile yeni worker'lar açar, dinleyen soket hiç kapanmaz | En basiti. Ancak gunicorn'un ana süreci eski klasörde kalır, kodun doğru yüklenmesi için `--chdir` ve uygulamanın yeniden içe aktarılması gerekir. Ayrıntıları uygulama sunucusunun belgelerinde kontrol et |
| **systemd soket etkinleştirme** | Soketi systemd tutar, uygulama yeniden başlarken bağlantılar kuyrukta bekler | Uygulama sunucusunun desteklemesi gerekir |
| **nginx'te yeniden deneme** | `proxy_next_upstream error timeout http_502;` ve iki upstream | Tek sunucuda iki örnek gerekir |
| **Blue-green** | `odeme@8001` ve `odeme@8002` iki örnek. Yenisini başlat, sağlık kontrolü geçince nginx upstream'ini çevir (`reload`), eskisini durdur | Gerçek sıfır kesinti. Kubernetes'in rolling update'i bunun otomatikleştirilmiş hâli |

Çoğu iç uygulama için symlink + graceful reload + sağlık kontrolü yeterlidir. Saniyelik kesintinin bile kabul edilmediği yerlerde blue-green kullanılır.

## Alıştırma

Tarayıcıda (yukarıdaki fonksiyonlar tanımlıyken):

1. `deploy` fonksiyonunu, yeni sürümde `app.sh` çalıştırılamıyorsa (`$R/app.sh` sıfır olmayan kodla çıkıyorsa) `current`'i **hiç çevirmeyecek** ve yarım kalan release klasörünü silecek şekilde değiştir. Bunu, `paket_uret` yerine bilerek bozuk bir `app.sh` (`exit 1`) üreterek dene.

<details><summary>Çözüm</summary>

```terminal
guvenli_deploy() {
  SURUM=$1; BOZUK=$2
  R=$B/releases/$(date +%Y%m%d-%H%M%S)
  mkdir -p $R
  if [ "$BOZUK" = "bozuk" ]; then printf '#!/bin/sh\nexit 1\n' > $R/app.sh; chmod +x $R/app.sh
  else paket_uret $SURUM && cp /tmp/app.sh $R/app.sh; fi
  ln -s $B/shared/.env $R/.env
  ln -s $B/shared/uploads $R/uploads
  if ! $R/app.sh > /dev/null; then
    echo "ön kontrol başarısız, deploy iptal: $R"
    rm -rf "$R"
    return 1
  fi
  ln -s $R $B/current.yeni && mv -T $B/current.yeni $B/current
  echo "aktif: $(readlink $B/current)"
}
sleep 1; guvenli_deploy 2.0.0 bozuk
readlink $B/current
sleep 1; guvenli_deploy 2.0.0
$B/current/app.sh
```

Gerçek bir deploy'da bu "ön kontrol" uygulamayı geçici bir portta başlatıp `/health` uç noktasını çağırmak, ya da en azından `python -c "import app"` / `node --check` gibi bir duman testi olur.

</details>

```quiz
`ln -sfn yeni current` ile `ln -s yeni current.tmp && mv -T current.tmp current` arasındaki fark?
- İkisi aynı
- [x] İlki unlink + symlink yapar, arada `current` kısa süre yoktur. İkincisi `rename()` ile atomiktir
- İkincisi sadece BusyBox'ta çalışır
? `rename()` POSIX'te atomiktir: hedef ya eskiyi ya yeniyi gösterir.
```

```quiz
`current` symlink'ini yeni sürüme çevirdin ama uygulama hâlâ eski kodu çalıştırıyor. Neden?
- Symlink yanlış oluşturuldu
- [x] Çalışan süreç başlarken çözümlenen eski klasörde ve kodu bellekte, yeniden başlatılması/yüklenmesi gerekiyor
- nginx önbelleği
? Symlink sadece yeni açılan yolları etkiler. `/proc/PID/cwd` sürecin gerçekte nerede olduğunu gösterir.
```

```quiz
Yeni sürüm bir sütunu silen bir göç içeriyor. Kodu geri almak neden tehlikeli?
- Symlink geri alınamaz
- [x] Eski kod silinmiş sütunu bekler ve çalışmaz. Göçler eski kodla uyumlu (expand/contract) yapılmalı
- Release klasörü silinmiş olur
? Önce ekle ve iki tarafa yaz, kod yerleşince sonraki deploy'da eskiyi kaldır.
```

## Özet

- Her sürüm `releases/ZAMAN/` altında, kalıcı olanlar `shared/`, aktif sürüm `current` symlink'i.
- Geçiş: `ln -s yeni current.yeni && mv -T current.yeni current` (atomik).
- Symlink'ten sonra servis yeniden başlatılır/yüklenir, sağlık kontrolü yapılır, başarısızsa geri alınır.
- Geri alma = `current`'i önceki klasöre çevirmek + restart. Göçler geriye uyumlu olmalı.
- Son N sürümü tut, aktif olanı asla silme.
