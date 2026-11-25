# useEffect: senkronizasyon, temizlik ve gereksiz effect'ler

`useEffect` React'in en çok yanlış kullanılan API'sidir. Çoğu zaman "bileşen yüklenince şunu yap", "şu değişince bunu güncelle" gibi düşünülür ve sonuç sonsuz döngüler, eski verilerle yarışan istekler, temizlenmeyen zamanlayıcılar ve gereksiz render'lar olur. Doğru zihinsel model şu: **Effect, bileşeni React dışındaki bir sistemle senkronize tutar.** Bu derste bu modeli, temizliği, bağımlılık dizisini ve en önemlisi effect'e **ihtiyacın olmayan** durumları göreceğiz.

## Ne zaman çalışır?

```text
render → commit (DOM güncellendi) → ekrana çizildi → effect'ler çalışır
                                                      (bir sonraki çalışmadan önce, ya da bileşen kaldırılırken: temizlik)
```

Effect'ler render sırasında değil, **commit'ten sonra** çalışır: Render saf kalır (ilk ders), yan etkiler sonra yapılır.

```react
import { useState, useEffect } from "react";

export default function App() {
  const [sayi, setSayi] = useState(0);
  const [baska, setBaska] = useState(0);

  console.log("1. render");
  useEffect(() => { console.log("2a. her render'dan sonra"); });
  useEffect(() => { console.log("2b. sadece ilk render'dan sonra"); }, []);
  useEffect(() => { console.log("2c. sayi değişince:", sayi); }, [sayi]);

  return (
    <div>
      <button onClick={() => setSayi(sayi + 1)}>sayi: {sayi}</button>
      <button onClick={() => setBaska(baska + 1)}>başka: {baska}</button>
    </div>
  );
}
```

Butonlara basıp konsolu izle:

| Bağımlılık dizisi | Ne zaman çalışır |
|---|---|
| Yok | Her render'dan sonra |
| `[]` | Sadece bileşen eklendiğinde (mount) |
| `[a, b]` | İlk render'da ve `a` ya da `b` bir önceki render'dakinden farklıysa (`Object.is` ile) |

> Geliştirme modunda `StrictMode`, her bileşeni eklerken effect'leri **bir kez çalıştırıp temizler, sonra tekrar çalıştırır**. Bu, temizliği eksik effect'leri ortaya çıkarmak için bilinçli bir davranış. Effect'in iki kez çalışmaya dayanıklı değilse, üretimde de bir gün (bileşen yeniden eklendiğinde) sorun çıkarır. (Bu sayfadaki oyun alanı StrictMode kullanmıyor.)

## Senkronizasyon ve temizlik

Effect'i "bir şeyi başlat ve bileşen giderken ya da bağımlılıklar değişince durdur" olarak düşün: abonelik, zamanlayıcı, WebSocket, olay dinleyicisi, harici bir kütüphane.

```react
import { useState, useEffect } from "react";

function CanliSaat({ aralikMs }) {
  const [simdi, setSimdi] = useState(new Date());
  useEffect(() => {
    console.log("zamanlayıcı başladı:", aralikMs, "ms");
    const id = setInterval(() => setSimdi(new Date()), aralikMs);
    return () => {                                  // TEMİZLİK
      clearInterval(id);
      console.log("zamanlayıcı durdu:", aralikMs, "ms");
    };
  }, [aralikMs]);
  return <p>{simdi.toLocaleTimeString()}.{String(simdi.getMilliseconds()).padStart(3, "0").slice(0, 1)}</p>;
}

export default function App() {
  const [goster, setGoster] = useState(true);
  const [aralik, setAralik] = useState(1000);
  return (
    <div>
      <button onClick={() => setGoster(!goster)}>{goster ? "Gizle" : "Göster"}</button>
      <button onClick={() => setAralik(aralik === 1000 ? 100 : 1000)}>Aralık: {aralik} ms</button>
      {goster && <CanliSaat aralikMs={aralik} />}
    </div>
  );
}
```

Aralığı değiştirince konsolda önce eski zamanlayıcının **temizliği**, sonra yenisinin başlangıcı. Gizleyince temizlik. Temizlik fonksiyonu olmasaydı, her aralık değişikliğinde yeni bir zamanlayıcı **eklenir**, eskileri çalışmaya devam ederdi: bellek sızıntısı ve gittikçe hızlanan bir saat.

Kural: Effect bir şey **başlatıyorsa** (abone olma, bağlanma, zamanlayıcı, dinleyici), temizlik fonksiyonu onu **durdurmalıdır**.

```jsx
useEffect(() => {
  function boyut() { setGenislik(window.innerWidth); }
  window.addEventListener("resize", boyut);
  return () => window.removeEventListener("resize", boyut);
}, []);
```

## Bağımlılık dizisi bir tercih değildir

Bağımlılık dizisi "ne zaman çalışsın istiyorum" değil, "effect **hangi değerleri kullanıyor**" listesidir. Effect'in içinde kullanılan, render sırasında tanımlanan her değer (props, state, onlardan türetilenler, bileşen içindeki fonksiyonlar) dizide olmalıdır. Aksi hâlde effect **eski bir render'ın değerlerini** görür:

```react
import { useState, useEffect } from "react";

export default function App() {
  const [sayi, setSayi] = useState(0);
  const [adim, setAdim] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setSayi(sayi + adim);        // HATA: sayi ve adim ilk render'ın değerleri, dizide yoklar
    }, 1000);
    return () => clearInterval(id);
  }, []);                          // "sadece bir kez" isteniyor ama yalan söylüyor

  return (
    <div>
      <p>Sayı: {sayi} (her saniye +{adim} olmalı)</p>
      <button onClick={() => setAdim(adim + 1)}>adım +1</button>
    </div>
  );
}
```

Sayı 1'de takılı kaldı: Zamanlayıcı her saniye `setSayi(0 + 1)` çağırıyor (önceki dersteki anlık görüntü). Adımı artırmak da etkisiz. Çözüm "dizideki değerleri artırmak" değil, effect'in onlara **ihtiyacını azaltmak**:

```react
import { useState, useEffect } from "react";

export default function App() {
  const [sayi, setSayi] = useState(0);
  const [adim, setAdim] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setSayi((s) => s + adim);    // güncelleme fonksiyonu: sayi'ya bağımlılık kalktı
    }, 1000);
    return () => clearInterval(id);
  }, [adim]);                      // adim kullanılıyor, dizide

  return (
    <div>
      <p>Sayı: {sayi} (her saniye +{adim})</p>
      <button onClick={() => setAdim(adim + 1)}>adım +1</button>
    </div>
  );
}
```

Projelerde `eslint-plugin-react-hooks` kuralı (`exhaustive-deps`) eksik bağımlılıkları otomatik bulur: Vite'ın React şablonunda varsayılan olarak açık. Uyarıyı bastırmak yerine kodu düzelt.

### Nesne ve fonksiyon bağımlılıkları

```jsx
function Arama({ kategori }) {
  const secenekler = { kategori, limit: 20 };       // her render'da YENİ nesne
  useEffect(() => { ara(secenekler); }, [secenekler]);   // her render'da çalışır!
}
```

Render içinde oluşturulan nesne ve fonksiyonlar her render'da **yeni referanstır**, `Object.is` karşılaştırması her seferinde "değişti" der. Çözüm: Nesneyi effect'in **içinde** oluştur ve ilkel değerlere bağımlı ol: `useEffect(() => { ara({ kategori, limit: 20 }); }, [kategori])`. Gerekirse `useMemo`/`useCallback` (performans dersi).

## Veri çekme ve yarış koşulu

Effect'le veri çekmenin klasik tuzağı: Kullanıcı hızlıca seçim değiştirdiğinde **eski** istek yeni istekten **sonra** dönerse ekranda yanlış veri kalır.

```react
import { useState, useEffect } from "react";

// Sahte API: "1" yavaş (1500 ms), diğerleri hızlı (300 ms) cevap veriyor
function getirKullanici(id) {
  const sure = id === "1" ? 1500 : 300;
  return new Promise((res) => setTimeout(() => res({ id, ad: "Kullanıcı " + id }), sure));
}

function Profil({ id, korumali }) {
  const [kullanici, setKullanici] = useState(null);
  useEffect(() => {
    let iptal = false;
    setKullanici(null);
    getirKullanici(id).then((k) => {
      if (korumali && iptal) { console.log("eski cevap atıldı:", k.id); return; }
      setKullanici(k);
    });
    return () => { iptal = true; };
  }, [id, korumali]);
  return <p>{korumali ? "Korumalı" : "Korumasız"}: {kullanici ? kullanici.ad : "yükleniyor…"} (seçili: {id})</p>;
}

export default function App() {
  const [id, setId] = useState("2");
  return (
    <div>
      <p>Önce 1'e, hemen ardından 3'e bas:</p>
      {["1", "2", "3"].map((x) => <button key={x} onClick={() => setId(x)}>{x}</button>)}
      <Profil id={id} korumali={false} />
      <Profil id={id} korumali={true} />
    </div>
  );
}
```

Korumasız bileşen önce "Kullanıcı 3"ü, 1,5 saniye sonra yavaş dönen "Kullanıcı 1"i gösterdi: Seçili 3 ama ekranda 1 yazıyor. Korumalı bileşen, temizlikte `iptal = true` yaparak eski isteğin cevabını attı. Gerçek `fetch` isteklerinde aynı iş `AbortController` ile yapılır ve istek ağ seviyesinde de iptal edilir:

```jsx
useEffect(() => {
  const kontrol = new AbortController();
  fetch(`/api/kullanici/${id}`, { signal: kontrol.signal })
    .then((r) => r.json())
    .then(setKullanici)
    .catch((e) => { if (e.name !== "AbortError") setHata(e); });
  return () => kontrol.abort();
}, [id]);
```

Effect ile veri çekmenin başka sorunları da var: önbellek yok (aynı veri her bileşende tekrar çekilir), yükleniyor/hata durumlarını her seferinde elle yazmak, yeniden deneme yok, sunucu tarafında çalışmaz. Üretimde veri çekme için **TanStack Query** gibi bir kütüphane, çerçevelerin veri yükleme mekanizmaları (React Router loader'ları) ya da React 19'un `use` + Suspense kalıbı kullanılır (ilerideki dersler). Effect'le veri çekmeyi bilmek yine de önemli: Altta yatan sorunları anlamanı sağlar.

## Effect'e ihtiyacın olmayabilir

Effect'ler React dışındaki sistemlerle senkronizasyon içindir. React **içindeki** veri akışı için çoğu zaman gereksizdir ve zararlıdır:

### 1. Türetilmiş veri için

```jsx
// Kötü: fazladan state + fazladan render + kopma riski
const [tamAd, setTamAd] = useState("");
useEffect(() => { setTamAd(ad + " " + soyad); }, [ad, soyad]);

// İyi: render sırasında hesapla (önceki ders)
const tamAd = ad + " " + soyad;
```

### 2. Kullanıcı olayına tepki için

```jsx
// Kötü: "gonderildi" state'i değişince effect ile istek at
useEffect(() => { if (gonderildi) post("/api/siparis", form); }, [gonderildi]);

// İyi: olayın kendisinde yap
function gonder() { post("/api/siparis", form); }
```

Kural: Kod **bileşen ekranda göründüğü için** mi çalışmalı (effect), yoksa **kullanıcı bir şey yaptığı için** mi (olay işleyicisi)? Bir siparişi göndermek, bir bildirimi göstermek, bir analitik olayı yollamak kullanıcının eylemine bağlıdır.

### 3. Props değişince state'i sıfırlamak için

```jsx
// Kötü: önce eski değerle render, sonra effect, sonra bir render daha
useEffect(() => { setYorum(""); }, [kullaniciId]);

// İyi: key ile (önceki ders)
<YorumKutusu key={kullaniciId} kullaniciId={kullaniciId} />
```

### 4. Ebeveyne veri bildirmek için

```jsx
// Kötü: çocuk kendi state'ini değiştirip effect ile ebeveyni haberdar ediyor
useEffect(() => { onDegisti(acik); }, [acik]);

// İyi: ikisini aynı olay işleyicisinde güncelle ya da state'i ebeveyne taşı
function degistir() { const yeni = !acik; setAcik(yeni); onDegisti(yeni); }
```

Zincirleme effect'ler ("A değişince B'yi set et, B değişince C'yi set et") özellikle tehlikelidir: Her halka fazladan bir render ekler ve akışı takip etmek imkânsızlaşır. Bunları tek bir olay işleyicisinde ya da reducer'da topla.

## Alıştırma

1. Aşağıdaki bileşen sonsuz döngüye giriyor. Neden? Düzelt.

```react
import { useState, useEffect } from "react";

export default function App() {
  const [filtre, setFiltre] = useState({ seviye: "hata" });
  const [sonuc, setSonuc] = useState([]);
  const [calismaSayisi, setCalismaSayisi] = useState(0);

  useEffect(() => {
    if (calismaSayisi > 20) return;          // tarayıcı kilitlenmesin diye güvenlik
    setCalismaSayisi((n) => n + 1);
    setSonuc(["kayıt 1", "kayıt 2"].map((k) => `${filtre.seviye}: ${k}`));
    setFiltre({ seviye: filtre.seviye });
  }, [filtre]);

  return <div><p>Effect {calismaSayisi} kez çalıştı</p><ul>{sonuc.map((s) => <li key={s}>{s}</li>)}</ul></div>;
}
```

2. Pencerenin genişliğini ve "mobil" olup olmadığını (< 640 px) gösteren bir bileşen yaz. Pencere yeniden boyutlandırılınca güncellensin ve bileşen kaldırılınca dinleyici temizlensin.

<details><summary>Çözüm</summary>

1: Effect `filtre`'ye bağımlı ve içinde `setFiltre({ ... })` ile her seferinde **yeni bir nesne** koyuyor. Yeni nesne → yeni referans → bağımlılık "değişti" → effect tekrar çalışır → yeni nesne... Ayrıca `sonuc` türetilebilir bir değer, ne state'e ne effect'e ihtiyacı var:

```react
import { useState } from "react";

export default function App() {
  const [filtre, setFiltre] = useState({ seviye: "hata" });
  const sonuc = ["kayıt 1", "kayıt 2"].map((k) => `${filtre.seviye}: ${k}`);   // türetilmiş
  return (
    <div>
      <button onClick={() => setFiltre({ seviye: filtre.seviye === "hata" ? "uyari" : "hata" })}>Seviye: {filtre.seviye}</button>
      <ul>{sonuc.map((s) => <li key={s}>{s}</li>)}</ul>
    </div>
  );
}
```

2:

```react
import { useState, useEffect } from "react";

function PencereBilgisi() {
  const [genislik, setGenislik] = useState(window.innerWidth);
  useEffect(() => {
    const boyut = () => setGenislik(window.innerWidth);
    window.addEventListener("resize", boyut);
    return () => window.removeEventListener("resize", boyut);
  }, []);
  return <p>Genişlik: {genislik}px, {genislik < 640 ? "mobil" : "masaüstü"}</p>;
}

export default function App() {
  const [goster, setGoster] = useState(true);
  return <div><button onClick={() => setGoster(!goster)}>Aç/kapa</button>{goster && <PencereBilgisi />}</div>;
}
```

(Önizleme kutusunun kenarından sürükleyerek yeniden boyutlandırıp dene.) Bir sonraki dersin konusu olan özel hook'larla bu mantık `useGenislik()` olarak yeniden kullanılabilir hâle gelir.

</details>

```quiz
Effect'in bağımlılık dizisine ne yazılmalıdır?
- Effect'in ne zaman çalışmasını istediğin değerler
- [x] Effect'in içinde kullanılan, render sırasında tanımlanan bütün değerler (props, state, onlardan türetilenler)
- Her zaman boş dizi
? Eksik bağımlılık effect'in eski değerleri görmesine yol açar. Bağımlılığı azaltmak için kodu değiştir, diziyi değil.
```

```quiz
Kullanıcı "Kaydet"e basınca API isteği atılmalı. Nerede yapılmalı?
- `kaydedildi` state'ine bağlı bir useEffect'te
- [x] Butonun olay işleyicisinde
- Render sırasında
? Kullanıcı eylemine bağlı yan etkiler olay işleyicisine aittir. Effect'ler bileşenin görünmesine bağlı senkronizasyon içindir.
```

```quiz
Hızlıca farklı öğeler seçildiğinde ekranda eski isteğin sonucu kalıyor. Çözüm?
- İstekleri sıraya koymak
- [x] Effect'in temizliğinde isteği iptal etmek (AbortController) ya da eski cevabı yok saymak
- Bağımlılık dizisini boşaltmak
? Temizlik, bağımlılık değişince bir önceki effect için çalışır.
```

## Özet

- Effect = React dışındaki bir sistemle senkronizasyon. Commit'ten sonra çalışır.
- Bir şey başlatan effect, temizlik fonksiyonunda onu durdurur. StrictMode bunu bilerek test eder.
- Bağımlılık dizisi = effect'in kullandığı değerler. Bağımlılığı azaltmak için güncelleme fonksiyonu, effect içinde nesne oluşturma. `exhaustive-deps` kuralını dinle.
- Veri çekmede yarış koşulu: temizlikte `AbortController`/iptal bayrağı. Üretimde TanStack Query ya da çerçeve mekanizmaları.
- Effect gerektirmeyenler: türetilmiş veri, kullanıcı olayları, props değişince sıfırlama (`key`), ebeveyni haberdar etme.
