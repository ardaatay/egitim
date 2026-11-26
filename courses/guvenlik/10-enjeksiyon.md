# Enjeksiyon: SQL, komut ve dosya yolu

Bütün enjeksiyon açıklarının kökü aynıdır: **Veri, kod olarak yorumlanan bir bağlama karıştırılır.** SQL sorgusu, kabuk komutu, dosya yolu, LDAP filtresi, şablon motoru... Hepsinin bir dili vardır. Kullanıcı girdisi bu dile metin birleştirme ile eklendiğinde, girdinin içindeki özel karakterler (`'`, `;`, `&&`, `../`) o dilin sözdizimi olur. Çözüm de her seferinde aynıdır: Veri ile kodu **ayrı kanallardan** gönder. Bunu yapmak mümkün değilse, girdiyi **izin listesiyle** kısıtla.

Bu derste üç açığı da bir sunucuda canlı olarak gösteriyoruz:

1. Açıklı sunucuya saldırıyoruz.
2. Aynı sunucunun düzeltilmiş halinde saldırının boşa çıktığını görüyoruz.

## Deney sunucusu

Sunucunun üç uç noktası var:

- `/sunucular?bolge=` bölgeye göre veritabanında arama yapıyor.
- `/rapor?ad=` sunucu adıyla bir komut çalıştırıyor.
- `/indir?dosya=` rapor dizininden dosya okuyor.

`GUVENLI=1` ortam değişkeni verildiğinde düzeltilmiş kod yolları çalışıyor. Sunucu sadece `127.0.0.1` adresini dinliyor.

```js
// enjeksiyon.mjs — AÇIKLI ÖRNEK SUNUCU: sadece 127.0.0.1, sadece eğitim için
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE sunucular (id INTEGER PRIMARY KEY, ad TEXT, bolge TEXT, ekip TEXT);
  CREATE TABLE kullanicilar (id INTEGER PRIMARY KEY, eposta TEXT, parola_hash TEXT, rol TEXT);
  INSERT INTO sunucular (ad, bolge, ekip) VALUES
    ('srv-001','ist','odeme'), ('srv-002','fra','arama'), ('srv-003','ist','arama');
  INSERT INTO kullanicilar (eposta, parola_hash, rol) VALUES
    ('ayse@ornek.com', 'scrypt$9f2c...a81', 'admin'),
    ('mehmet@ornek.com', 'scrypt$41be...07c', 'developer');
`);

const RAPOR_DIZINI = path.resolve("raporlar");
fs.mkdirSync(RAPOR_DIZINI, { recursive: true });
fs.writeFileSync(path.join(RAPOR_DIZINI, "kasim.txt"), "Kasım raporu: 42 deploy\n");
fs.writeFileSync(path.resolve("gizli.env"), "DB_PAROLA=Cok$Gizli2026\n");

const GUVENLI = process.env.GUVENLI === "1";

function json(res, kod, veri) {
  res.writeHead(kod, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(veri));
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams;
  try {
    // 1) SQL: bölgeye göre sunucu arama
    if (url.pathname === "/sunucular") {
      const bolge = q.get("bolge") ?? "";
      const satirlar = GUVENLI
        ? db.prepare("SELECT ad, bolge, ekip FROM sunucular WHERE bolge = ?").all(bolge)
        : db.prepare(`SELECT ad, bolge, ekip FROM sunucular WHERE bolge = '${bolge}'`).all();
      return json(res, 200, satirlar);
    }
    // 2) Komut: sunucu adıyla bir "rapor" komutu
    if (url.pathname === "/rapor") {
      const ad = q.get("ad") ?? "";
      if (GUVENLI) {
        if (!/^srv-\d{3}$/.test(ad)) return json(res, 400, { hata: "geçersiz sunucu adı" });
        return execFile("node", ["-e", "console.log('rapor: ' + process.argv[1])", ad], (err, out) =>
          json(res, 200, { cikti: out.trim() }));
      }
      return exec(`node -e "console.log('rapor: ' + process.argv[1])" ${ad}`, (err, out) =>
        json(res, 200, { cikti: out.trim() }));
    }
    // 3) Dosya yolu: rapor indirme
    if (url.pathname === "/indir") {
      const dosya = q.get("dosya") ?? "";
      let yol;
      if (GUVENLI) {
        yol = path.resolve(RAPOR_DIZINI, dosya);
        if (!yol.startsWith(RAPOR_DIZINI + path.sep)) return json(res, 400, { hata: "geçersiz dosya" });
      } else {
        yol = path.join(RAPOR_DIZINI, dosya);
      }
      return json(res, 200, { icerik: fs.readFileSync(yol, "utf8") });
    }
    json(res, 404, { hata: "yok" });
  } catch (e) {
    json(res, 500, GUVENLI ? { hata: "sunucu hatası" } : { hata: e.message });
  }
}).listen(Number(process.env.PORT ?? 3001), "127.0.0.1", () =>
  console.log(`dinleniyor ${process.env.PORT ?? 3001} (güvenli=${GUVENLI})`));
```

İki kopyayı yan yana başlat. 3001 açıklı, 3002 düzeltilmiş. `DB_PAROLA`, uygulamanın ortamındaki bir sırrı temsil ediyor:

```bash
PORT=3001 DB_PAROLA='Cok$Gizli2026' node enjeksiyon.mjs &
PORT=3002 GUVENLI=1 DB_PAROLA='Cok$Gizli2026' node enjeksiyon.mjs &
```

```text
dinleniyor 3001 (güvenli=false)
dinleniyor 3002 (güvenli=true)
```

> **İpucu:** `curl -G --data-urlencode` girdiyi URL kodlamasıyla gönderir. Böylece boşluk, `'` ve `&` gibi karakterleri elle kodlamakla uğraşmazsın. Saldırgan da aynısını yapar: Tarayıcının adres çubuğu ya da form bir engel değildir.

## SQL enjeksiyonu

Normal kullanım:

```bash
curl -s "http://127.0.0.1:3001/sunucular?bolge=ist"
```

```text
[{"ad":"srv-001","bolge":"ist","ekip":"odeme"},{"ad":"srv-003","bolge":"ist","ekip":"arama"}]
```

### Koşulu etkisiz kılmak

Girdi `x' OR '1'='1` olduğunda sorgu `WHERE bolge = 'x' OR '1'='1'` olur. Girdideki tırnak, string'i kapatıp yeni bir koşul açtı:

```bash
curl -s -G "http://127.0.0.1:3001/sunucular" --data-urlencode "bolge=x' OR '1'='1"
```

```text
[{"ad":"srv-001","bolge":"ist","ekip":"odeme"},{"ad":"srv-002","bolge":"fra","ekip":"arama"},{"ad":"srv-003","bolge":"ist","ekip":"arama"}]
```

Burada sonuç "fazladan sunucu görmek" gibi zararsız görünüyor. Ama aynı kalıp `WHERE eposta = '...' AND parola = '...'` sorgusunda **kimlik doğrulamayı atlatır**. `WHERE kiraci_id = ...` sorgusunda da **başka kiracının verisini** açar.

### UNION ile başka tabloyu okumak

Saldırgan sorgunun sütun sayısını (deneme yanılmayla ya da hata mesajlarıyla) öğrendikten sonra kendi `SELECT`'ini ekler. Sondaki `--` ise orijinal sorgunun geri kalanını yorum satırına çevirir:

```bash
curl -s -G "http://127.0.0.1:3001/sunucular" \
  --data-urlencode "bolge=x' UNION SELECT eposta, parola_hash, rol FROM kullanicilar --"
```

```text
[{"ad":"ayse@ornek.com","bolge":"scrypt$9f2c...a81","ekip":"admin"},{"ad":"mehmet@ornek.com","bolge":"scrypt$41be...07c","ekip":"developer"}]
```

Bu uç nokta sadece sunucu listelemek için yazılmıştı. Şimdi kullanıcı tablosunu döndürüyor. Hangi tabloların olduğunu da veritabanının kendi kataloğu söyler. SQLite'ta bu `sqlite_master`, Oracle'da `ALL_TABLES`, PostgreSQL'de `information_schema`:

```bash
curl -s -G "http://127.0.0.1:3001/sunucular" \
  --data-urlencode "bolge=x' UNION SELECT name, sql, type FROM sqlite_master --"
```

```text
[{"ad":"kullanicilar","bolge":"CREATE TABLE kullanicilar (id INTEGER PRIMARY KEY, eposta TEXT, parola_hash TEXT, rol TEXT)","ekip":"table"},{"ad":"sunucular","bolge":"CREATE TABLE sunucular (id INTEGER PRIMARY KEY, ad TEXT, bolge TEXT, ekip TEXT)","ekip":"table"}]
```

### Hata mesajları saldırganın haritasıdır

Tek bir tırnak göndermek, açığı keşfetmenin ilk adımıdır:

```bash
curl -s -G "http://127.0.0.1:3001/sunucular" --data-urlencode "bolge='"
```

```text
{"hata":"unrecognized token: \"'''\""}
```

Bu yanıt saldırgana iki şey söyler. Birincisi, girdinin sorguya ham olarak girdiğini. İkincisi, hata metninin biçiminden veritabanının türünü. Ham veritabanı hatası istemciye dönmemeli. Hata sunucu tarafında bir korelasyon kimliğiyle loglanmalı, istemciye genel bir mesaj ve o kimlik gitmeli.

> **Dikkat:** Hata mesajını gizlemek açığı **kapatmaz**. Bu durumda saldırgan "kör" (blind) tekniklere geçer. Boolean tabanlı teknikte `AND substr(parola_hash,1,1)='s'` gibi bir koşul ekler ve sonucun değişip değişmediğine bakar. Zaman tabanlı teknikte de yanıt süresini ölçer. Araçlar (sqlmap gibi) bunu otomatik yapar. Hata gizleme sadece keşfi yavaşlatır.

### Düzeltme: bind değişkenleri

Düzeltilmiş sunucuda sorgu metni sabittir: `WHERE bolge = ?`. Değer, sorgu derlendikten **sonra**, ayrı bir kanaldan bağlanır. Veritabanı onu hiçbir zaman SQL olarak ayrıştırmaz. Aynı saldırılar 3002'de:

```bash
curl -s -G "http://127.0.0.1:3002/sunucular" --data-urlencode "bolge=x' OR '1'='1"
curl -s -G "http://127.0.0.1:3002/sunucular" \
  --data-urlencode "bolge=x' UNION SELECT eposta, parola_hash, rol FROM kullanicilar --"
curl -s -G "http://127.0.0.1:3002/sunucular" --data-urlencode "bolge='"
```

```text
[]
[]
[]
```

Üçü de "bölgesi tam olarak bu metin olan sunucu" olarak arandı ve sonuç boş döndü. Hata da yok, çünkü tırnak artık sadece bir karakter. Oracle kursundaki bind değişkenleri ve `EXECUTE IMMEDIATE ... USING` dersi, buradaki düzeltmenin aynısıdır. Orada aynı teknik bir de performans (paylaşılan imleç) nedeniyle önemliydi.

### Bind edilemeyen yerler: tanımlayıcılar

Bind değişkeni sadece **değer** yerine geçer. Tablo adı, sütun adı, `ORDER BY` yönü ya da `IN` listesinin uzunluğu bind edilemez. Bunlarda kaçış (escape) fonksiyonları yerine **izin listesi** kullan:

```js
const SIRALAMA = { ad: "ad", bolge: "bolge", ekip: "ekip" };   // girdi -> sütun
const YON = { artan: "ASC", azalan: "DESC" };

function sunucuListesi(sirala, yon) {
  const sutun = SIRALAMA[sirala] ?? "ad";       // listede yoksa varsayılan
  const y = YON[yon] ?? "ASC";
  return db.prepare(`SELECT ad, bolge, ekip FROM sunucular ORDER BY ${sutun} ${y}`).all();
}

// IN listesi: yer tutucu sayısı dinamik, değerler yine bind
function bolgelerde(bolgeler) {
  const yer = bolgeler.map(() => "?").join(",");
  return db.prepare(`SELECT ad FROM sunucular WHERE bolge IN (${yer})`).all(...bolgeler);
}
```

Burada SQL metnine giren her parça **senin kodundaki sabitlerden** gelir. Kullanıcı girdisi sadece hangi sabitin seçileceğini belirler.

ORM kullanmak bu sorunu tek başına çözmez. ORM'lerin hepsinde bir ham sorgu kapısı vardır: `raw`, `query` ya da `$queryRawUnsafe` gibi. Bazı ORM'lerin `where` metotları da string kabul eder. Kod incelemesinde aranacak kalıp şu: SQL metni içinde şablon string (`${...}`) ya da `+` ile birleştirme.

## Komut enjeksiyonu

`exec`, komutu **bir kabuğa** (`/bin/sh -c`, Windows'ta `cmd.exe /c`) verir. Kabuk metni ayrıştırırken `&&`, `;`, `|`, `$(...)` ve ters tırnak gibi karakterleri kendi dilinin parçası olarak yorumlar. Normal kullanım:

```bash
curl -s "http://127.0.0.1:3001/rapor?ad=srv-001"
```

```text
{"cikti":"rapor: srv-001"}
```

Saldırgan girdinin sonuna ikinci bir komut ekliyor. Bu komut, uygulamanın ortam değişkenlerindeki sırrı basıyor:

```bash
curl -s -G "http://127.0.0.1:3001/rapor" --data-urlencode "ad=srv-001 && node -p process.env.DB_PAROLA"
```

```text
{"cikti":"rapor: srv-001\nCok$Gizli2026"}
```

Saldırgan artık uygulamanın kullanıcısıyla, uygulamanın ağ erişimiyle ve uygulamanın sırlarıyla **istediği komutu çalıştırabiliyor**. Bu, ele geçirmenin en ağır biçimidir (RCE, uzaktan kod çalıştırma). Konteyner kursundaki önlemler bu noktada sonucu sınırlar:

- root olmayan kullanıcı
- salt okunur kök dosya sistemi
- sırların ortam değişkeni yerine dosyadan okunması
- çıkış trafiğini kısıtlayan NetworkPolicy

Ama bu önlemler açığı kapatmaz.

### Düzeltme: kabuksuz çalıştırma ve doğrulama

İki katman uygulanır:

1. **`execFile` ya da `spawn`, argümanlar dizi olarak:** Kabuk hiç yoktur. Program doğrudan çalışır ve her dizi elemanı programa **tek bir argüman** olarak geçer. `&&` artık bir operatör değil, argümanın içindeki iki karakterdir.
2. **Girdi doğrulama:** Sunucu adının biçimi bellidir (`srv-` ve üç rakam). Biçime uymayan girdi kod yoluna hiç girmez.

```bash
curl -s -G "http://127.0.0.1:3002/rapor" --data-urlencode "ad=srv-001 && node -p process.env.DB_PAROLA"
```

```text
{"hata":"geçersiz sunucu adı"}
```

Kabuksuz çalıştırmanın da bir tuzağı var: **argüman enjeksiyonu**. Girdi `-` ile başlıyorsa, program onu bir seçenek olarak yorumlayabilir. Örnekler:

- `git` için `--upload-pack=...`
- `tar` için `--checkpoint-action=exec=...`
- `curl` için `-o /etc/...`

Bunun önlemleri:

- Girdiyi `--` ayırıcısından sonra ver. Çoğu program `--`'den sonrasını seçenek olarak okumaz.
- Doğrulamada `-` ile başlayan girdileri reddet.
- En iyisi: Bir dış program çağırmak yerine işi kütüphane ile yap. `ping` yerine bir TCP bağlantısı, `convert` yerine bir görüntü kütüphanesi kullanmak gibi.

```js
// yine execFile, ama girdi '--' sonrasında ve '-' ile başlayamaz
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(dal)) throw new Error("geçersiz dal adı");
execFile("git", ["log", "--oneline", "-n", "5", "--", dal]);
```

> **Dikkat:** `shell: true` seçeneği `spawn`/`execFile`'ı yeniden `exec` yapar. Windows'ta da bir istisna var: `.bat`/`.cmd` dosyaları her durumda `cmd.exe` üzerinden çalışır. Node bu yüzden 2024'te (CVE-2024-27980) `.bat` dosyalarını `shell` olmadan çalıştırmayı reddetmeye başladı. Windows'ta toplu iş dosyasına kullanıcı girdisi geçiren kod en riskli sınıftır.

## Dosya yolu geçişi (path traversal)

Normal kullanım:

```bash
curl -s "http://127.0.0.1:3001/indir?dosya=kasim.txt"
```

```text
{"icerik":"Kasım raporu: 42 deploy\n"}
```

`path.join` yolu **normalleştirir**: `raporlar/../gizli.env` önce `gizli.env` olur, rapor dizininin dışına çıkılır:

```bash
curl -s -G "http://127.0.0.1:3001/indir" --data-urlencode "dosya=../gizli.env"
```

```text
{"icerik":"DB_PAROLA=Cok$Gizli2026\n"}
```

Gerçek hedefler şunlardır: uygulamanın kendi kaynak kodu ve yapılandırması, `.env` dosyaları, `/proc/self/environ` (sürecin ortam değişkenleri) ve `/var/run/secrets/kubernetes.io/serviceaccount/token` (pod'un servis hesabı jetonu). Yazma yapan uç noktalarda (dosya yükleme, arşiv açma) durum daha ağırdır. Hedef bu kez kod çalıştırmaktır: cron dosyaları, `.ssh/authorized_keys` ya da uygulamanın yüklediği bir modül üzerine yazmak.

Hata mesajı yine bilgi sızdırıyor. Açıklı sunucu var olmayan bir dosya için **sunucudaki tam yolu** döndürüyor. Bu çıktıda kullanıcıya ait yol kısmı `…` ile kısaltıldı:

```bash
curl -s -G "http://127.0.0.1:3001/indir" --data-urlencode "dosya=yok.txt"
```

```text
{"hata":"ENOENT: no such file or directory, open '…\\sec\\raporlar\\yok.txt'"}
```

### Düzeltme: çöz, sonra sınırı kontrol et

Düzeltilmiş kod üç adım izler:

1. `path.resolve` ile yolu **mutlak ve normalleştirilmiş** hale getirir.
2. Sonucun rapor dizininin **içinde** olduğunu kontrol eder.
3. Kontrolü `RAPOR_DIZINI + path.sep` ile yapar.

Ayırıcı olmadan yapılan bir `startsWith` kontrolü, `/srv/raporlar-eski/...` gibi kardeş bir dizini de geçirirdi:

```bash
curl -s -G "http://127.0.0.1:3002/indir" --data-urlencode "dosya=../gizli.env"
curl -s -G "http://127.0.0.1:3002/indir" --data-urlencode "dosya=raporlar/../../gizli.env"
curl -s -G "http://127.0.0.1:3002/indir" --data-urlencode "dosya=/etc/passwd"
curl -s -G "http://127.0.0.1:3002/indir" --data-urlencode "dosya=yok.txt"
```

```text
{"hata":"geçersiz dosya"}
{"hata":"geçersiz dosya"}
{"hata":"geçersiz dosya"}
{"hata":"sunucu hatası"}
```

Mutlak yol (`/etc/passwd`) da reddedildi, çünkü `path.resolve` mutlak bir argüman görünce baştaki dizini bırakır ve sınır kontrolü bunu yakalar. Bu kontrolün de bilinen zayıflıkları var:

- **Sembolik bağlar:** Dizin içinde dışarıyı gösteren bir symlink varsa, metin üzerinde yapılan kontrol geçer. Gerekiyorsa `fs.realpathSync` ile gerçek yolu çözüp kontrolü onun üzerinde yap.
- **Kod çözme sırası:** URL kodlaması iki kez çözülürse (`%252e%252e%252f`), ilk çözümden sonra yapılan kontrol `../`'ı görmez. Sınır kontrolünü dosya sistemi çağrısından **hemen önce**, son haliyle yap.
- **Arşiv açma (Zip Slip):** ZIP/TAR içindeki dosya adları da girdidir. `../../etc/cron.d/x` adlı bir arşiv girdisi, açılırken dizin dışına yazar. Her girdi için aynı resolve ve sınır kontrolü gerekir.

En sağlam çözüm, kullanıcıdan **dosya yolu almamaktır**. Kullanıcı bir kimlik (`rapor_id=42`) gönderir. Yol sunucu tarafında, veritabanındaki ya da sabit bir eşlemedeki değerden kurulur. Bu kimlik üzerinde ayrıca yetki kontrolü de yapılır (IDOR, bkz. yetkilendirme dersi):

```js
const RAPORLAR = new Map([["2026-11", "kasim.txt"], ["2026-10", "ekim.txt"]]);
const dosya = RAPORLAR.get(q.get("ay"));
if (!dosya) return json(res, 404, { hata: "rapor yok" });
return json(res, 200, { icerik: fs.readFileSync(path.join(RAPOR_DIZINI, dosya), "utf8") });
```

## Aynı kalıbın diğer kılıkları

| Bağlam | Açıklı kalıp | Düzeltme |
|---|---|---|
| NoSQL (MongoDB) | `find({ eposta: req.body.eposta, parola: req.body.parola })`. Gövde `{"parola": {"$ne": null}}` olursa koşul her kaydı eşler | Tip doğrulama (şema): `parola` bir **string** olmalı. Operatör içeren nesneleri reddet |
| LDAP | `(&(uid=${kullanici})(objectClass=person))`. Girdi `*)(uid=*` olursa | Kütüphanenin filtre kaçışı (RFC 4515) ya da izin listesi |
| Şablon motoru (SSTI) | Kullanıcı metnini **şablon olarak** derlemek: `render(kullaniciMetni)` | Kullanıcı metni şablona sadece **değişken** olarak verilir |
| Log | Girdiyi ham olarak loglamak. `\n` içeren girdi sahte log satırları üretir | Yapılandırılmış (JSON) log. Değerler alan olarak yazılır |
| HTTP başlığı | `res.setHeader("Location", girdi)`. CRLF ile başlık enjeksiyonu | Node CRLF içeren başlık değerini reddeder (`ERR_INVALID_CHAR`). Açık yönlendirme için yine izin listesi gerekir |
| `eval`, `new Function`, `vm` | Kullanıcı ifadesini çalıştırmak | Hiç yapma. Gerekiyorsa sınırlı bir ifade dili ayrıştırıcısı kullan. `vm` bir güvenlik sınırı **değildir** |

Tablonun ortak dersi şu: Doğru araç bağlamın **kendi ayrım mekanizmasıdır**. SQL için bind, kabuk için argüman dizisi, şablon için değişken, MongoDB için tip kontrolü. El yapımı kaçış fonksiyonları her zaman bir köşe durumunu kaçırır: çok baytlı karakter setleri, farklı tırnak türleri, ikinci bir çözme adımı.

## Tespit ve test

- **Statik analiz (SAST):** Semgrep ve CodeQL gibi araçlar "kullanıcı girdisi (kaynak), `exec`/`query`/`readFile` çağrısına (hedef) ulaşıyor mu" sorusunu veri akışıyla izler. GitLab'ın SAST şablonu da bunu CI'da çalıştırır (test dersinde).
- **Kod incelemesi:** Şablon string içinde SQL, `exec(` ve `shell: true`, `path.join(..., girdi)`, `eval`, `$where` aranır. Bunlar grep ile bile bulunur.
- **Dinamik test (DAST):** Çalışan uygulamaya tırnak, `../` ve `&&` gönderip yanıtların değişip değişmediğine bakmak. Sadece **yetkili olduğun** sistemlerde.
- **Çalışma zamanı:** Veritabanı hata oranındaki ani artış (`syntax error`, `ORA-00933`, `unrecognized token`) ile WAF loglarındaki `UNION SELECT` ve `../` kalıpları birer alarm kaynağıdır. WAF bir **ek** katmandır: Kodlama hileleriyle atlatılır, bind değişkeninin yerini tutmaz.

```quiz
{
  "question": "Bir arama uç noktası sıralama sütununu kullanıcıdan alıyor: `ORDER BY ${req.query.sirala}`. Ekip bunu bind değişkenine çevirmek istiyor: `ORDER BY ?`. Bu düzeltmenin sonucu ne olur?",
  "options": [
    "Açık kapanır ve sıralama doğru çalışır.",
    "Açık kapanır ama sıralama çalışmaz: Bind edilen değer sütun adı değil sabit bir string olur ve her satır için aynıdır.",
    "Sorgu derlenmez, çünkü ORDER BY bind değişkeni hiç kabul etmez.",
    "Açık kapanmaz, çünkü ORDER BY içindeki bind değişkeni yine SQL olarak ayrıştırılır."
  ],
  "answer": 1,
  "explanation": "Bind değişkeni sadece değer yerine geçer. Çoğu veritabanında `ORDER BY ?` derlenir, ama sabit bir değere göre sıralar, yani sıralama etkisiz olur. Tanımlayıcılar (sütun, tablo, yön) için doğru çözüm izin listesidir: Girdi sadece koddaki sabitlerden hangisinin seçileceğini belirler."
}
```

```quiz
{
  "question": "Bir servis `execFile('convert', [girdiDosyasi, ciktiDosyasi])` kullanıyor, kabuk yok. Saldırgan dosya adını kontrol edebiliyor. Hâlâ geçerli olan risk hangisi?",
  "options": [
    "Yok. Kabuk olmadığı için girdi her zaman tek bir argümandır ve zararsızdır.",
    "`;` ve `&&` ile ikinci bir komut eklenebilir.",
    "Argüman enjeksiyonu: `-` ile başlayan bir dosya adı programın seçeneği olarak yorumlanabilir. Ayrıca program kendi biçim ayrıştırıcısıyla dosya içeriğini yorumlar.",
    "Ortam değişkenleri otomatik olarak çocuk sürece geçmez, bu yüzden risk yok."
  ],
  "answer": 2,
  "explanation": "Kabuksuz çalıştırma kabuk metakarakterlerini etkisiz kılar, ama hedef programın kendi argüman ayrıştırıcısı hâlâ oradadır. `-` ile başlayan girdiyi reddet ve `--` ayırıcısını kullan. Mümkünse dış programın yerine bir kütüphane kullan."
}
```

```lab
{
  "title": "Açığı kendin bul ve kapat",
  "steps": [
    "Yukarıdaki enjeksiyon.mjs dosyasına `/kullanici?eposta=` uç noktasını ekle. Bu uç nokta `SELECT eposta, rol FROM kullanicilar WHERE eposta = '...'` sorgusunu şablon string ile kursun. `x' OR '1'='1` ile tüm kullanıcıların döndüğünü doğrula.",
    "Hata mesajlarını kapatıp (500 + genel mesaj) yalnızca boolean tabanlı kör enjeksiyonla `ayse@ornek.com` kullanıcısının rolünün ilk harfini bul: `ayse@ornek.com' AND substr(rol,1,1)='a' --`. Yanıtın boş olup olmamasının bir bilgi kanalı olduğunu gör.",
    "Uç noktayı bind değişkenine çevir ve iki saldırının da boş sonuç döndüğünü doğrula.",
    "`/indir` uç noktasına `raporlar` içinde `ln -s ../gizli.env kisayol.txt` ile bir sembolik bağ ekle (Linux/macOS). Düzeltilmiş sunucunun `dosya=kisayol.txt` isteğini **geçirdiğini** gör, sonra kontrolü `fs.realpathSync` ile güçlendir.",
    "Kendi kod tabanında `exec(`, `shell: true`, SQL içinde `${` ve `path.join(` ile kullanıcı girdisi arayan bir grep komutu yaz. Bulguları 'girdi kaynağı kullanıcıdan mı?' sorusuyla ayıkla."
  ]
}
```

## Özet

- Enjeksiyonun kökü, verinin kod olarak yorumlanan bir bağlama metin birleştirme ile girmesidir. Çözüm veri ile kodu ayrı kanallardan göndermektir.
- SQL: Bind değişkenleri. Tanımlayıcılar ve `IN` listeleri için izin listesi ve dinamik yer tutucu. ORM'in ham sorgu kapılarına dikkat.
- Komut: `exec` yerine `execFile`/`spawn` ve argüman dizisi, ayrıca biçim doğrulama. Kabuksuz çalıştırmada bile argüman enjeksiyonu (`-` ile başlayan girdi) var. `--` ayırıcısını kullan.
- Dosya yolu: `path.resolve` ve ayırıcılı sınır kontrolü. Symlink için `realpath`, arşiv açarken her girdi için aynı kontrol. En iyisi: Kullanıcıdan yol değil kimlik al.
- Ham hata mesajları (veritabanı hatası, tam dosya yolu) keşfi kolaylaştırır. Gizlemek gerekli ama tek başına yeterli değildir, çünkü kör teknikler kalır.
- Hepsine ek katmanlar: en az yetkili veritabanı kullanıcısı, root olmayan ve salt okunur konteyner, sırların ortam değişkeni yerine dosyada tutulması, SAST ve alarmlar.
