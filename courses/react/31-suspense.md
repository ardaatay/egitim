# Suspense, lazy, transition'lar ve hata sınırları

Önceki derslerde her bileşen kendi yükleniyor ve hata durumunu `if (isPending) return ...` ile yönetiyordu. Bu iki sorun yaratır: Ekranda birbirinden habersiz onlarca dönen gösterge belirir ve her bileşen aynı kalıbı tekrar eder. React'in cevabı, bu durumları **bildirimsel olarak** ağacın daha yukarısına taşımak: yükleniyor için **Suspense**, hatalar için **hata sınırları** (error boundaries). Bunlara React 18'in eşzamanlı render'ı eklenince, **transition**'larla "acil" ve "acil olmayan" güncellemeleri ayırabilirsin.

## Suspense: "hazır değilim" demek

Bir bileşen render sırasında henüz hazır olmayan bir şeye ihtiyaç duyarsa (tembel yüklenen kod, `use(promise)` ile beklenen veri) **askıya alınır**. React en yakın `<Suspense>` sınırını bulur ve onun `fallback`'ini gösterir. Hazır olunca asıl içeriği çizer.

```react
import { use, Suspense } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const onbellek = new Map();
function getir(anahtar, ms) {
  if (!onbellek.has(anahtar)) onbellek.set(anahtar, bekle(ms).then(() => `${anahtar} verisi (${ms} ms)`));
  return onbellek.get(anahtar);
}

function Kutu({ anahtar, ms }) {
  const veri = use(getir(anahtar, ms));
  return <div style={{ border: "1px solid #94a3b8", borderRadius: 8, padding: 8, margin: 4 }}>{veri}</div>;
}

const Iskelet = ({ metin }) => <div style={{ background: "#e2e8f0", color: "#64748b", borderRadius: 8, padding: 8, margin: 4 }}>{metin}</div>;

export default function App() {
  return (
    <div>
      <h4>Tek sınır: hepsi birlikte gelir</h4>
      <Suspense fallback={<Iskelet metin="Panel yükleniyor…" />}>
        <Kutu anahtar="A" ms={600} />
        <Kutu anahtar="B" ms={1800} />
      </Suspense>
      <h4>Ayrı sınırlar: hazır olan hemen görünür</h4>
      <Suspense fallback={<Iskelet metin="C yükleniyor…" />}><Kutu anahtar="C" ms={600} /></Suspense>
      <Suspense fallback={<Iskelet metin="D yükleniyor…" />}><Kutu anahtar="D" ms={1800} /></Suspense>
    </div>
  );
}
```

Sınırları nereye koyacağın bir **tasarım kararı**: Birlikte anlamlı olan parçalar (bir kartın başlığı ve içeriği) aynı sınırda, birbirinden bağımsız parçalar (bir panodaki farklı grafikler) ayrı sınırlarda olmalı. Böylece arayüz "patlamış mısır" gibi parça parça zıplamaz ama yavaş bir parça da hepsini bekletmez.

Suspense'i tetikleyen şeyler: `lazy` ile yüklenen bileşenler, `use(promise)`, Suspense destekli veri kütüphaneleri (TanStack Query'nin `useSuspenseQuery`'si, Relay, Apollo), çerçeveler (Next.js, React Router'ın `Await`'i) ve Server Components. **Effect içinde yapılan veri çekme Suspense'i tetiklemez.**

## lazy: kodu ihtiyaç anında yüklemek

Uygulamanın bütün kodunu ilk açılışta indirmek yerine, ağır ve nadir kullanılan parçaları ayrı dosyalara böl:

```jsx
import { lazy, Suspense } from "react";

const RaporEditoru = lazy(() => import("./RaporEditoru"));   // ayrı bir JS dosyası olur

function Panel() {
  const [acik, setAcik] = useState(false);
  return (
    <>
      <button onClick={() => setAcik(true)}>Rapor editörünü aç</button>
      {acik && (
        <Suspense fallback={<p>Editör yükleniyor…</p>}>
          <RaporEditoru />
        </Suspense>
      )}
    </>
  );
}
```

Vite (ve diğer paketleyiciler) `import()` gördüğü yerde kodu ayrı bir parçaya (chunk) böler. Kullanıcı butona basana kadar o dosya indirilmez. Oyun alanında bunu bir modülle taklit edelim:

```react
import { lazy, Suspense, useState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const AgirGrafik = lazy(async () => {
  console.log("grafik modülü indiriliyor…");
  await bekle(1200);                                  // ağdan indirme taklidi
  return { default: function AgirGrafik() {
    return <svg width="240" height="80">{[30, 55, 20, 70, 45, 60].map((h, i) => <rect key={i} x={i * 40} y={80 - h} width="30" height={h} fill="#0284c7" />)}</svg>;
  } };
});

export default function App() {
  const [goster, setGoster] = useState(false);
  return (
    <div>
      <button onClick={() => setGoster(!goster)}>{goster ? "Gizle" : "Grafiği göster"}</button>
      {goster && <Suspense fallback={<p>Grafik yükleniyor…</p>}><AgirGrafik /></Suspense>}
    </div>
  );
}
```

İlk açışta 1,2 saniye bekledi, gizleyip tekrar açınca anında: Modül bir kez yüklenir ve önbellekte kalır. React Router dersindeki `lazy` rotalar aynı mekanizmayı kullanır. Bölünecek en mantıklı yerler: **rotalar** (her sayfa), modallar, editörler, grafik ve harita kütüphaneleri.

## Hata sınırları

Render sırasında fırlatılan bir hata, yakalanmazsa **bütün uygulamayı** boş bir ekrana çevirir. Hata sınırı, alt ağacındaki render hatalarını yakalayıp yerine bir yedek arayüz gösterir. Hâlâ bir **sınıf bileşeni** olarak yazılması gereken tek React özelliğidir (ya da `react-error-boundary` paketi kullanılır):

```react
import { Component, Suspense, use, useState } from "react";

class HataSiniri extends Component {
  state = { hata: null };
  static getDerivedStateFromError(hata) { return { hata }; }
  componentDidCatch(hata, bilgi) { console.log("hata raporlandı:", hata.message); }   // Sentry vb. buraya
  render() {
    if (this.state.hata) {
      return (
        <div style={{ border: "1px solid #dc2626", borderRadius: 8, padding: 8, color: "#dc2626" }}>
          Bu bölüm yüklenemedi: {this.state.hata.message}{" "}
          <button onClick={() => { this.props.sifirla?.(); this.setState({ hata: null }); }}>Tekrar dene</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
let deneme = 0;
const onbellek = new Map();
function getir(anahtar) {
  if (!onbellek.has(anahtar)) {
    deneme++;
    const basarili = deneme > 1;                       // ilk deneme başarısız, sonraki başarılı
    onbellek.set(anahtar, bekle(700).then(() => { if (!basarili) throw new Error("sunucu 503 döndü"); return "Metrikler: CPU %42, bellek %61"; }));
  }
  return onbellek.get(anahtar);
}

function Metrikler() { return <p>{use(getir("metrikler"))}</p>; }

export default function App() {
  const [surum, setSurum] = useState(0);
  return (
    <div>
      <p>Pano başlığı her zaman çalışır.</p>
      <HataSiniri key={surum} sifirla={() => { onbellek.delete("metrikler"); setSurum((s) => s + 1); }}>
        <Suspense fallback={<p>Metrikler yükleniyor…</p>}>
          <Metrikler />
        </Suspense>
      </HataSiniri>
    </div>
  );
}
```

İlk yükleme başarısız oldu, ama sadece metrik bölümü hata gösterdi, sayfanın geri kalanı çalışıyor. "Tekrar dene" önbelleği temizleyip sınırı `key` ile sıfırladı ve ikinci deneme başarılı oldu. Konsoldaki kırmızı satır beklenen bir şey: React 19, bir sınırın yakaladığı hataları geliştirme sırasında `console.error` ile de raporlar. Üretimde bu raporlamayı `createRoot(el, { onCaughtError, onUncaughtError })` seçenekleriyle tek bir yerden kendi izleme servisine yönlendirebilirsin.

Hata sınırları **yakalamaz**: olay işleyicilerindeki hatalar (orada `try/catch` kullanılır), asenkron kod (`setTimeout`, Promise zincirleri, eğer bir render'a bağlanmamışsa), sunucu tarafı render hataları ve sınırın kendisindeki hatalar. Suspense ile birlikte kullanılınca, `use(promise)`'in reddedilen Promise'leri sınıra düşer.

Yerleşim, Suspense'e benzer bir tasarım kararı: En üstte bütün uygulamayı saran bir sınır (beyaz ekran yerine "bir şeyler ters gitti" sayfası), ve bağımsız bölümlerin (her rota, panodaki her kart) etrafında daha küçük sınırlar. React Router'ın `errorElement`'i rota seviyesinde bir hata sınırıdır.

## Transition'lar: acil olmayan güncellemeler

Her güncelleme aynı aciliyette değildir. Bir arama kutusuna yazmak **acil**dir: Tuş anında görünmeli. Arama sonuçlarının yeniden çizilmesi **acil değildir**: Birkaç yüz milisaniye gecikebilir. React 18'den beri, acil olmayan bir güncellemeyi `startTransition` ile işaretlersen React onu **kesintiye uğratılabilir** şekilde render eder: Bu sırada yeni bir acil güncelleme (bir sonraki tuş) gelirse, yarım kalan render'ı bırakıp önce acil olanı işler.

```react
import { useState, useTransition, memo } from "react";

const Sonuclar = memo(function Sonuclar({ sorgu }) {
  const ogeler = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now(); while (performance.now() - t0 < 0.6) {}   // her satır yavaş
    ogeler.push(<li key={i}>{sorgu} için sonuç #{i + 1}</li>);
  }
  return <ul style={{ height: 120, overflow: "auto" }}>{ogeler}</ul>;
});

export default function App() {
  const [girdi, setGirdi] = useState("");
  const [sorgu, setSorgu] = useState("");
  const [gecisli, setGecisli] = useState(true);
  const [isPending, startTransition] = useTransition();

  function degisti(e) {
    setGirdi(e.target.value);                         // ACİL: kutu hemen güncellenir
    if (gecisli) startTransition(() => setSorgu(e.target.value));   // ACİL DEĞİL
    else setSorgu(e.target.value);
  }

  return (
    <div>
      <label><input type="checkbox" checked={gecisli} onChange={(e) => setGecisli(e.target.checked)} /> transition kullan</label><br />
      <input value={girdi} onChange={degisti} placeholder="Hızlı yaz" />
      {isPending && <small> güncelleniyor…</small>}
      <div style={{ opacity: isPending ? 0.5 : 1 }}><Sonuclar sorgu={sorgu} /></div>
    </div>
  );
}
```

Onay kutusu açıkken hızlı yaz: Kutu akıcı, sonuçlar arkadan geliyor. Kapatıp tekrar dene: Her tuş yaklaşık 180 ms donuyor. Aynı hesaplama, ama transition React'e "bunu bekletebilirsin" bilgisini veriyor.

### useDeferredValue

Değeri değiştiren koda erişimin yoksa (props olarak geliyorsa), aynı etkiyi `useDeferredValue` ile değeri tüketen tarafta elde edersin:

```jsx
function AramaSonuclari({ sorgu }) {
  const gecikmeli = useDeferredValue(sorgu);
  const eski = sorgu !== gecikmeli;
  return <div style={{ opacity: eski ? 0.5 : 1 }}><Sonuclar sorgu={gecikmeli} /></div>;
}
```

Bu, özel hook dersindeki zamanlayıcıyla yapılan debounce'tan farklıdır: Sabit bir gecikme yoktur, cihaz hızlıysa neredeyse anında güncellenir, yavaşsa React acil işler bitene kadar bekletir. Ağ isteklerini azaltmak için debounce, render maliyetini yönetmek için `useDeferredValue`.

### Transition ve Suspense birlikte

Zaten içerik gösteren bir alan, transition içinde yapılan bir güncelleme sonucu askıya alınırsa React **fallback'e geri dönmez**: Yeni içerik hazır olana kadar eski içeriği gösterir. Bir sekmeyi değiştirirken bütün sayfanın yerine aniden bir yükleniyor göstergesinin gelmesini önleyen budur:

```react
import { use, Suspense, useState, useTransition } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const onbellek = new Map();
function sekmeVerisi(ad) {
  if (!onbellek.has(ad)) onbellek.set(ad, bekle(900).then(() => `${ad} sekmesinin içeriği`));
  return onbellek.get(ad);
}
function Icerik({ ad }) { return <p>{use(sekmeVerisi(ad))}</p>; }

export default function App() {
  const [sekme, setSekme] = useState("Özet");
  const [isPending, startTransition] = useTransition();
  const [gecisli, setGecisli] = useState(true);
  const sec = (ad) => (gecisli ? startTransition(() => setSekme(ad)) : setSekme(ad));
  return (
    <div>
      <label><input type="checkbox" checked={gecisli} onChange={(e) => setGecisli(e.target.checked)} /> transition kullan</label><br />
      {["Özet", "Loglar", "Metrikler", "Ayarlar"].map((s) => <button key={s} onClick={() => sec(s)} style={{ fontWeight: s === sekme ? 700 : 400 }}>{s}</button>)}
      <div style={{ opacity: isPending ? 0.5 : 1, minHeight: 40 }}>
        <Suspense fallback={<p>Yükleniyor…</p>}><Icerik ad={sekme} /></Suspense>
      </div>
    </div>
  );
}
```

Transition açıkken yeni sekmeye geçince eski içerik soluklaşarak kalıyor, kapalıyken içerik kaybolup "Yükleniyor…" geliyor. React Router'ın gezinmeleri de varsayılan olarak transition içinde yapılır.

## Alıştırma

Bir pano sayfası tasarla:

1. Üç bağımsız kart: "Küme durumu" (500 ms), "Son deploy'lar" (1500 ms), "Maliyet" (her zaman hata veriyor). Her biri `use` ile veri okusun.
2. Bir kartın yavaşlığı diğerlerini bekletmesin, bir kartın hatası sayfanın geri kalanını bozmasın.

<details><summary>Bir çözüm</summary>

```react
import { Component, Suspense, use } from "react";

class Sinir extends Component {
  state = { hata: null };
  static getDerivedStateFromError(hata) { return { hata }; }
  render() { return this.state.hata ? <div style={{ color: "#dc2626" }}>⚠ {this.state.hata.message}</div> : this.props.children; }
}

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const onbellek = new Map();
function getir(ad, ms, hata) {
  if (!onbellek.has(ad)) onbellek.set(ad, bekle(ms).then(() => { if (hata) throw new Error(`${ad} servisi yanıt vermedi`); return `${ad}: hazır`; }));
  return onbellek.get(ad);
}

function KartIcerik({ ad, ms, hata }) { return <p>{use(getir(ad, ms, hata))}</p>; }

function Kart({ baslik, ...p }) {
  return (
    <section style={{ border: "1px solid #94a3b8", borderRadius: 10, padding: 10, marginBottom: 8 }}>
      <b>{baslik}</b>
      <Sinir>
        <Suspense fallback={<p style={{ color: "#64748b" }}>yükleniyor…</p>}>
          <KartIcerik {...p} />
        </Suspense>
      </Sinir>
    </section>
  );
}

export default function App() {
  return (
    <div>
      <Kart baslik="Küme durumu" ad="Küme" ms={500} />
      <Kart baslik="Son deploy'lar" ad="Deploy" ms={1500} />
      <Kart baslik="Maliyet" ad="Maliyet" ms={800} hata />
    </div>
  );
}
```

Her kartın kendi Suspense ve hata sınırı var: Hızlı kart hemen görünür, yavaş kart kendi göstergesini gösterir, hatalı kart sadece kendini etkiler.

</details>

```quiz
Bir bileşen `use(promise)` ile askıya alındığında React ne yapar?
- Hata fırlatır
- [x] En yakın üst Suspense sınırının fallback'ini gösterir, Promise çözülünce içeriği çizer
- Bileşeni atlar
? Effect içinde yapılan veri çekme Suspense'i tetiklemez.
```

```quiz
Bir olay işleyicisinde (`onClick`) fırlatılan hatayı hata sınırı yakalar mı?
- Evet
- [x] Hayır: hata sınırları render sırasındaki hataları yakalar. Olay işleyicilerinde try/catch kullanılır
- Sadece üretimde
? Asenkron kod ve sunucu tarafı render hataları da yakalanmaz.
```

```quiz
Arama kutusuna yazarken sonuç listesinin pahalı render'ı girdiyi kasıyor. React'in yerleşik çözümü?
- useMemo ile listeyi sabitlemek
- [x] Sonuç güncellemesini `startTransition` ile acil olmayan olarak işaretlemek (ya da useDeferredValue)
- setTimeout ile geciktirmek
? Transition render'ı kesintiye uğratılabilir yapar, acil güncellemeler önce işlenir.
```

## Özet

- Suspense: askıya alınan bileşen için en yakın sınırın fallback'i. Sınırları birlikte anlamlı parçalara göre yerleştir.
- `lazy(() => import(...))` ile kod bölme: rotalar, modallar, ağır kütüphaneler.
- Hata sınırı (sınıf bileşeni ya da react-error-boundary): render hatalarını yakalar, olay ve asenkron hataları yakalamaz. Sıfırlama için `key`.
- `startTransition`/`useTransition`: acil olmayan güncellemeler kesintiye uğratılabilir. `useDeferredValue`: tüketen tarafta erteleme.
- Transition içindeki güncelleme Suspense'i tetiklerse eski içerik kalır, fallback'e dönülmez.
