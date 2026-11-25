# Performans: memo, useMemo, useCallback ve React Compiler

React varsayılan olarak hızlıdır: Render bir fonksiyon çağrısıdır ve DOM'a sadece farklar uygulanır. Performans sorunları genelde üç yerden çıkar: **gereksiz render'lar** (değişmeyen büyük alt ağaçların tekrar tekrar render olması), **render içinde pahalı hesaplamalar** ve **çok büyük listeler**. Bu derste önce **ölçmeyi**, sonra her soruna uygun aracı ve bu araçların çoğunu gereksiz kılan **React Compiler**'ı göreceğiz.

> Kural: Önce ölç, sonra optimize et. `memo`/`useMemo`/`useCallback`'i her yere serpmek kodu karmaşıklaştırır, çoğu zaman fark yaratmaz, bazen yavaşlatır.

## Bir bileşen neden render olur?

İlk dersten: (1) kendi state'i değişince, (2) okuduğu context değişince, (3) **ebeveyni render olunca**. Üçüncüsü sürprizdir: Props değişmese bile çocuk render olur.

```react
import { useState } from "react";

let renderSayisi = 0;
function Yavas({ etiket }) {
  renderSayisi++;
  const t0 = performance.now();
  while (performance.now() - t0 < 30) {}          // 30 ms'lik pahalı bir bileşeni taklit et
  return <p>{etiket} (bu bileşen {renderSayisi}. kez render oldu)</p>;
}

export default function App() {
  const [metin, setMetin] = useState("");
  return (
    <div>
      <input value={metin} onChange={(e) => setMetin(e.target.value)} placeholder="Hızlı yaz: gecikmeyi hisset" />
      <Yavas etiket="Ağır grafik" />
    </div>
  );
}
```

Yazarken her tuş vuruşunda `Yavas` da render oluyor (props'u hiç değişmiyor) ve 30 ms bekletiyor: girdi takılıyor.

### Ölçmek: React DevTools Profiler

Gerçek projede ilk adım tarayıcıya **React Developer Tools** eklentisini kurup **Profiler** sekmesinde kayıt almak: Her etkileşimde hangi bileşenin kaç kez, ne kadar sürede render olduğunu ve **neden** render olduğunu ("props changed", "parent rendered", "hooks changed") gösterir. Ayarlardaki "Highlight updates when components render" seçeneği, render olan bileşenleri ekranda yanıp söndürür. Üretim build'inde (`npm run build`) ölçmek de önemli: Geliştirme modu (StrictMode'un çift render'ı ve ek kontroller yüzünden) belirgin şekilde yavaştır.

## Çözüm 1: state'i aşağı taşı (kompozisyon)

Memoizasyondan önce yapıyı düzeltmek çoğu zaman yeterli. Sorun, sık değişen `metin` state'inin pahalı bileşenle **aynı ebeveynde** olması. State'i onu kullanan küçük bileşene taşı:

```react
import { useState } from "react";

function Yavas({ etiket }) {
  const t0 = performance.now();
  while (performance.now() - t0 < 30) {}
  console.log("Yavas render");
  return <p>{etiket}</p>;
}

function AramaKutusu() {                            // sık değişen state burada, izole
  const [metin, setMetin] = useState("");
  return <input value={metin} onChange={(e) => setMetin(e.target.value)} placeholder="Şimdi hızlı yaz" />;
}

export default function App() {
  return (
    <div>
      <AramaKutusu />
      <Yavas etiket="Ağır grafik" />
    </div>
  );
}
```

Artık yazarken sadece `AramaKutusu` render oluyor. Bir başka kompozisyon yöntemi: Pahalı içeriği **`children`** olarak vermek. `children`, ebeveynin ebeveyninde oluşturulduğu için state değişen bileşen render olunca yeniden oluşturulmaz.

## Çözüm 2: memo

Yapıyı değiştiremiyorsan, bileşeni `memo` ile sarmak "props'larım değişmediyse beni yeniden render etme" der:

```react
import { useState, memo } from "react";

const Yavas = memo(function Yavas({ etiket, ayarlar }) {
  const t0 = performance.now();
  while (performance.now() - t0 < 30) {}
  console.log("Yavas render:", etiket);
  return <p>{etiket} (renk: {ayarlar.renk})</p>;
});

export default function App() {
  const [metin, setMetin] = useState("");
  const ayarlar = { renk: "mavi" };                 // DİKKAT: her render'da yeni nesne
  return (
    <div>
      <input value={metin} onChange={(e) => setMetin(e.target.value)} placeholder="Yaz" />
      <Yavas etiket="Sabit props" ayarlar={{ renk: "mavi" }} />
      <Yavas etiket="Değişken nesne prop'u" ayarlar={ayarlar} />
    </div>
  );
}
```

İki `memo`'lu bileşen de her tuşta render oluyor: `ayarlar` prop'u her render'da **yeni bir nesne** (satır içi `{{ renk: "mavi" }}` de öyle). `memo`, props'u `Object.is` ile **yüzeysel** karşılaştırır: Yeni nesne, yeni fonksiyon, yeni dizi her zaman "değişmiş" sayılır. `memo`'nun işe yaraması için props'ların **referans olarak kararlı** olması gerekir. İşte `useMemo` ve `useCallback` burada devreye girer.

## Çözüm 3: useMemo ve useCallback

| Hook | Ne saklar | Kullanım |
|---|---|---|
| `useMemo(() => hesap, [bağımlılıklar])` | Bir hesaplamanın **sonucunu** | Pahalı hesaplamalar, `memo`'lu çocuğa verilen nesne/diziler |
| `useCallback(fn, [bağımlılıklar])` | **Fonksiyonun kendisini** | `memo`'lu çocuğa verilen olay işleyicileri, effect bağımlılığı olan fonksiyonlar |

`useCallback(fn, deps)` aslında `useMemo(() => fn, deps)`'in kısaltmasıdır.

```react
import { useState, memo, useMemo, useCallback } from "react";

const Liste = memo(function Liste({ ogeler, sec }) {
  console.log("Liste render");
  return <ul>{ogeler.map((o) => <li key={o.id}><button onClick={() => sec(o.id)}>{o.ad}</button></li>)}</ul>;
});

const tumu = Array.from({ length: 3000 }, (_, i) => ({ id: i, ad: `servis-${i}`, puan: (i * 7919) % 100 }));

export default function App() {
  const [metin, setMetin] = useState("");
  const [minPuan, setMinPuan] = useState(90);
  const [secili, setSecili] = useState(null);

  const filtreli = useMemo(() => {
    console.log("filtreleme hesaplandı");
    return tumu.filter((s) => s.puan >= minPuan).slice(0, 20);
  }, [minPuan]);                                    // sadece minPuan değişince yeniden hesapla

  const sec = useCallback((id) => setSecili(id), []);   // setSecili kararlı, bağımlılık yok

  return (
    <div>
      <input value={metin} onChange={(e) => setMetin(e.target.value)} placeholder="İlgisiz bir alana yaz" />
      <label> Min puan: <input type="number" value={minPuan} onChange={(e) => setMinPuan(Number(e.target.value))} style={{ width: 60 }} /></label>
      <p>Seçili: {secili ?? "yok"}</p>
      <Liste ogeler={filtreli} sec={sec} />
    </div>
  );
}
```

İlgisiz alana yazarken konsolda ne "filtreleme hesaplandı" ne de "Liste render" görünüyor: `filtreli` ve `sec` referansları aynı kaldı, `memo` render'ı atladı. Min puanı değiştirince ikisi de çalışıyor.

### Ne zaman kullanmalı?

`useMemo`/`useCallback`'in de bir maliyeti var: bağımlılık karşılaştırması, bellek, ve en önemlisi kodun okunurluğu. Kullanmaya değer durumlar:

- Hesaplama **ölçülebilir şekilde** pahalı (1 ms'nin üstü: `console.time` ile ölç). Birkaç yüz elemanlık bir `filter`/`map` genelde değildir.
- Değer `memo`'lu bir bileşene prop olarak veriliyor.
- Değer bir effect'in ya da başka bir hook'un bağımlılığı (gereksiz effect çalışmalarını önlemek için).

Bunların dışında genelde gereksizdir.

## React Compiler

Yukarıdaki elle memoizasyonun zahmetli ve hataya açık olması, React ekibini **React Compiler**'a götürdü: Build sırasında bileşenleri analiz edip gereken memoizasyonu **otomatik** ekleyen bir Babel eklentisi. React 19 ile kararlı sürüme ulaştı ve React 17/18 projelerinde de kullanılabilir.

```bash
npm install -D babel-plugin-react-compiler
```

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } })],
});
```

Compiler açıkken çoğu bileşende `memo`, `useMemo` ve `useCallback` yazmak gereksiz hâle gelir: Derleyici, bir değerin hangi girdilere bağlı olduğunu kendisi çıkarır ve render'lar arasında saklar. Ön koşulu, kodun **React kurallarına** (saf render, state'i değiştirmemek, hook kuralları) uyması: Kurala uymayan bileşenleri derleyici atlar. `eslint-plugin-react-hooks`'un yeni sürümlerindeki derleyici kuralları bu ihlalleri gösterir. Bu kursun başından beri vurguladığımız "saf bileşen" ilkesinin pratik karşılığı budur.

Yeni projelerde Compiler'ı açmak ve elle memoizasyonu ancak ölçülmüş bir sorun için kullanmak, güncel en iyi yaklaşım.

## Çözüm 4: büyük listeler

10.000 satırlık bir tabloyu DOM'a koymak, memoizasyon ne olursa olsun yavaştır: Tarayıcı on binlerce düğümü düzenlemek ve çizmek zorundadır. Çözüm **sanallaştırma** (virtualization): Sadece ekranda görünen satırları çiz, kaydırdıkça değiştir.

```react
import { useState } from "react";

const SATIR = 28, YUKSEKLIK = 280;
const veri = Array.from({ length: 100000 }, (_, i) => `log ${i + 1}: istek işlendi, süre ${(i * 37) % 900} ms`);

export default function App() {
  const [ust, setUst] = useState(0);
  const ilk = Math.floor(ust / SATIR);
  const adet = Math.ceil(YUKSEKLIK / SATIR) + 2;
  const gorunen = veri.slice(ilk, ilk + adet);
  return (
    <div>
      <p>{veri.length.toLocaleString("tr-TR")} satır, DOM'da sadece {gorunen.length} tane</p>
      <div onScroll={(e) => setUst(e.currentTarget.scrollTop)}
           style={{ height: YUKSEKLIK, overflow: "auto", border: "1px solid #94a3b8", fontFamily: "monospace", fontSize: 13 }}>
        <div style={{ height: veri.length * SATIR, position: "relative" }}>
          {gorunen.map((s, i) => (
            <div key={ilk + i} style={{ position: "absolute", top: (ilk + i) * SATIR, height: SATIR, lineHeight: SATIR + "px", paddingLeft: 6 }}>{s}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

100.000 satır akıcı kayıyor, çünkü DOM'da her an yaklaşık 12 satır var. Gerçek projede bunu elle yazmak yerine **TanStack Virtual** ya da **react-window** kullanılır (değişken satır yükseklikleri, yatay kaydırma, ızgaralar).

## Diğer kazanımlar

| Teknik | Ne sağlar |
|---|---|
| **Kod bölme**: `lazy(() => import("./Rapor"))` + Suspense | Kullanıcının hiç açmadığı sayfaların kodu ilk yüklemede indirilmez (Suspense dersi) |
| **`useTransition` / `useDeferredValue`** | Pahalı güncellemeleri "acil olmayan" olarak işaretle, girdi akıcı kalsın (Suspense dersi) |
| **Görsel optimizasyonu** | `loading="lazy"`, doğru boyutlar, modern biçimler (AVIF/WebP) |
| **Paket analizi** | `npx vite-bundle-visualizer` ile hangi kütüphanenin ne kadar yer kapladığını gör |
| **Web Vitals** | LCP, INP, CLS gibi gerçek kullanıcı metriklerini ölç (`web-vitals` paketi) |

## Alıştırma

Aşağıdaki bileşende her tuşta bütün kartlar render oluyor. Önce sebebini bul, sonra (a) kompozisyonla ve (b) `memo` + `useCallback` ile iki ayrı çözüm üret.

```react
import { useState } from "react";

function Kart({ servis, yeniden }) {
  console.log("Kart render:", servis);
  return <div style={{ border: "1px solid #94a3b8", padding: 6, margin: 4 }}>{servis} <button onClick={() => yeniden(servis)}>↻</button></div>;
}

export default function App() {
  const [not, setNot] = useState("");
  const [log, setLog] = useState([]);
  const yeniden = (s) => setLog((l) => [...l, s + " yeniden başlatıldı"]);
  return (
    <div>
      <input value={not} onChange={(e) => setNot(e.target.value)} placeholder="Not al" />
      {["api", "odeme", "katalog"].map((s) => <Kart key={s} servis={s} yeniden={yeniden} />)}
      <ul>{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </div>
  );
}
```

<details><summary>Çözüm</summary>

Sebep: `not` state'i kartlarla aynı ebeveynde. Her tuşta `App` render oluyor, kartlar da onunla. Ayrıca `yeniden` her render'da yeni bir fonksiyon, bu yüzden sadece `memo` eklemek yetmez.

(a) Kompozisyon: Not alanını kendi bileşenine taşı:

```react
import { useState } from "react";

function Kart({ servis, yeniden }) {
  console.log("Kart render:", servis);
  return <div style={{ border: "1px solid #94a3b8", padding: 6, margin: 4 }}>{servis} <button onClick={() => yeniden(servis)}>↻</button></div>;
}
function NotAlani() {
  const [not, setNot] = useState("");
  return <input value={not} onChange={(e) => setNot(e.target.value)} placeholder="Not al" />;
}
export default function App() {
  const [log, setLog] = useState([]);
  const yeniden = (s) => setLog((l) => [...l, s + " yeniden başlatıldı"]);
  return (
    <div>
      <NotAlani />
      {["api", "odeme", "katalog"].map((s) => <Kart key={s} servis={s} yeniden={yeniden} />)}
      <ul>{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </div>
  );
}
```

(b) memo + useCallback:

```react
import { useState, memo, useCallback } from "react";

const Kart = memo(function Kart({ servis, yeniden }) {
  console.log("Kart render:", servis);
  return <div style={{ border: "1px solid #94a3b8", padding: 6, margin: 4 }}>{servis} <button onClick={() => yeniden(servis)}>↻</button></div>;
});
export default function App() {
  const [not, setNot] = useState("");
  const [log, setLog] = useState([]);
  const yeniden = useCallback((s) => setLog((l) => [...l, s + " yeniden başlatıldı"]), []);
  return (
    <div>
      <input value={not} onChange={(e) => setNot(e.target.value)} placeholder="Not al" />
      {["api", "odeme", "katalog"].map((s) => <Kart key={s} servis={s} yeniden={yeniden} />)}
      <ul>{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </div>
  );
}
```

`useCallback`'in bağımlılık dizisi boş olabiliyor, çünkü güncelleme fonksiyonu (`l => ...`) sayesinde `log`'a bağımlı değil. (a) daha basit ve tercih edilir. React Compiler açık bir projede (b)'deki memoizasyonu derleyici otomatik yapar.

</details>

```quiz
`memo` ile sarılmış bir bileşen, her render'da `onClick={() => ...}` prop'u aldığı için yine render oluyor. Neden?
- memo çalışmıyor
- [x] Satır içi ok fonksiyonu her render'da yeni bir referans, memo'nun yüzeysel karşılaştırması onu "değişmiş" sayar
- onClick props'u karşılaştırılmaz
? Fonksiyonu useCallback ile kararlı yapmak ya da yapıyı değiştirmek gerekir.
```

```quiz
Performans sorununda ilk adım ne olmalı?
- Her bileşeni memo ile sarmak
- Bütün fonksiyonları useCallback'e almak
- [x] React DevTools Profiler ile hangi bileşenin neden ve ne kadar render olduğunu ölçmek
? Ölçmeden yapılan optimizasyon kodu karmaşıklaştırır ve çoğu zaman etkisizdir.
```

```quiz
React Compiler ne yapar?
- Kodu WebAssembly'ye çevirir
- [x] Build sırasında bileşenlere gereken memoizasyonu otomatik ekler, elle useMemo/useCallback/memo ihtiyacını büyük ölçüde kaldırır
- Sanal DOM'u kaldırır
? Ön koşulu React kurallarına (saf render, hook kuralları) uyan koddur.
```

## Özet

- Render sebepleri: state, context, ebeveynin render'ı. Önce Profiler ile ölç, üretim build'inde.
- İlk çözüm yapı: sık değişen state'i aşağı taşı, pahalı içeriği `children` olarak ver.
- `memo` (yüzeysel props karşılaştırması) + kararlı referanslar için `useMemo` (değer) ve `useCallback` (fonksiyon).
- React Compiler memoizasyonu otomatikleştirir. Saf, kurallara uyan kod şart.
- Büyük listeler için sanallaştırma (TanStack Virtual, react-window). Kod bölme ve transition'lar ileride.
