# React'in modeli: UI = f(state), JSX ve render

Klasik DOM programlamasında arayüzü **adım adım değiştirirsin**: "butona basılınca bu elemanın metnini değiştir, şu listeye bir `li` ekle, şu sınıfı kaldır". Uygulama büyüdükçe her olayın arayüzün hangi parçalarını nasıl etkilediğini takip etmek imkânsızlaşır ve arayüz ile veri birbirinden kopar.

React'in fikri, Kubernetes kursundaki **bildirimsel modelin** arayüzdeki karşılığı: Arayüzün **nasıl değişeceğini** değil, verinin her hâli için **neye benzemesi gerektiğini** yazarsın. Veri değişince React, ekranı yeni tanıma getirmek için gereken en küçük değişiklikleri kendisi bulur.

```text
UI = f(state)
```

## İlk bileşen

Aşağıdaki blok canlı: **▶ Çalıştır**'a bas, sonra kodu değiştirip tekrar çalıştır.

```react
export default function App() {
  const ad = "Arda";
  const saat = new Date().getHours();
  return (
    <div>
      <h2>{saat < 12 ? "Günaydın" : "İyi günler"}, {ad}</h2>
      <p>Şu an saat {saat}.</p>
    </div>
  );
}
```

Bir **bileşen**, büyük harfle başlayan ve **JSX döndüren** bir JavaScript fonksiyonudur. React bu fonksiyonu çağırır, dönen tanımı ekrana çizer.

## JSX aslında ne?

JSX, HTML'e benzeyen bir **söz dizimi**dir, tarayıcı onu tanımaz. Derleyici (bu sayfada Babel, projelerde Vite'ın kullandığı esbuild/SWC) onu sıradan fonksiyon çağrılarına çevirir:

```jsx
<h2 className="baslik">Merhaba {ad}</h2>
```

```js
// derlenmiş hâli (React 17+ "otomatik runtime")
import { jsx as _jsx } from "react/jsx-runtime";
_jsx("h2", { className: "baslik", children: ["Merhaba ", ad] });
```

Sonuç, ekranda ne olması gerektiğini anlatan küçük bir **JavaScript nesnesidir** (React elemanı): `{ type: "h2", props: { className: "baslik", children: [...] } }`. DOM'a dokunmaz. Görelim:

```react
export default function App() {
  const eleman = <h2 className="baslik">Merhaba</h2>;
  console.log("type:", eleman.type, "props:", eleman.props);
  return eleman;
}
```

Konsolda elemanın sadece bir nesne olduğunu gördün. Bundan çıkan JSX kuralları:

| Kural | Neden |
|---|---|
| Süslü parantez `{}` içinde herhangi bir JavaScript **ifadesi** | `{ad}`, `{a + b}`, `{kosul ? x : y}`, `{liste.map(...)}`. `if`/`for` gibi **deyimler** yazılamaz (fonksiyon argümanı olamazlar) |
| `class` yerine `className`, `for` yerine `htmlFor` | JSX, JavaScript'tir ve `class` ayrılmış bir kelime |
| Öznitelikler camelCase: `onClick`, `tabIndex`, `strokeWidth` | DOM özellik adları |
| `style` bir nesne: `style={{ color: "red", fontSize: 14 }}` | Dış süslü parantez ifade, içteki nesne |
| Tek bir kök eleman döndürülür, gerekirse `<>...</>` (Fragment) | Bir fonksiyon tek bir değer döndürür |
| Her etiket kapatılır: `<img />`, `<br />` | XML kuralları |
| Küçük harfli etiket = HTML elemanı, büyük harfli = bileşen | `<div>` vs `<Kart>` |

JSX'teki metinler otomatik olarak **kaçışlanır** (escape): `{kullaniciGirdisi}` içinde `<script>` olsa bile metin olarak görünür. XSS'e karşı varsayılan koruma. Bunu kapatan tek yol adı bilerek korkutucu seçilmiş `dangerouslySetInnerHTML`'dir.

## Render ve commit

Bir bileşenin ekrana gelmesi iki aşamadır:

```text
1. Render  : React bileşen fonksiyonunu ÇAĞIRIR ve yeni eleman ağacını alır. (Saf hesaplama, DOM'a dokunulmaz)
2. Commit  : Önceki ağaçla karşılaştırır (reconciliation) ve DOM'a sadece FARKLARI uygular
```

Ne zaman render olur?

- İlk açılışta (`createRoot(...).render(<App />)`).
- Bileşenin **state**'i değiştiğinde (bir sonraki dersler).
- **Ebeveyni** render olduğunda (varsayılan olarak bütün çocukları da render olur).

Render, DOM'u yeniden oluşturmak **değildir**. React her render'da bütün fonksiyonu çağırır, ama DOM'da sadece değişen düğümleri günceller. Görelim: Saat her saniye değişiyor, ama giriş kutusuna yazdığın metin kaybolmuyor:

```react
import { useState, useEffect } from "react";

export default function App() {
  const [simdi, setSimdi] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setSimdi(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  console.log("render:", simdi.toLocaleTimeString());
  return (
    <div>
      <p>Saat: <b>{simdi.toLocaleTimeString()}</b></p>
      <input placeholder="Buraya bir şey yaz" />
      <p><small>Kutuya yazdıkların her saniyeki render'da korunuyor.</small></p>
    </div>
  );
}
```

Konsolda her saniye bir render. Ama React `input` elemanını yeniden oluşturmadı, sadece `<b>` içindeki metni değiştirdi. (useState ve useEffect'i ileride ayrıntılı göreceğiz.)

## Saf bileşenler

React'in bu modeli çalıştırabilmesi için bileşenlerin **saf** olması gerekir: Aynı girdilere (props, state) her zaman aynı JSX'i döndürmeli ve render sırasında **dışarıdaki hiçbir şeyi değiştirmemeli**.

```react
let ziyaretci = 0;

function Kart() {
  ziyaretci = ziyaretci + 1;          // YANLIŞ: render sırasında dış değişkeni değiştiriyor
  return <p>Sen {ziyaretci}. ziyaretçisin</p>;
}

export default function App() {
  return <><Kart /><Kart /><Kart /></>;
}
```

1, 2, 3 bekliyorsun, ama sonuç render'ın kaç kez çağrıldığına bağlı. React render'ı istediği zaman, istediği kadar çağırabilir: geliştirme modundaki `StrictMode` hataları yakalamak için her bileşeni **bilerek iki kez** render eder, gelecekteki özellikler (eşzamanlı render, transition'lar) render'ı yarıda bırakıp tekrar başlatabilir. Render sırasında yan etki (dış değişken değiştirmek, ağ isteği atmak, DOM'u elle değiştirmek) bu yüzden yasak. Yan etkiler **olay işleyicilerinde** ya da **effect**'lerde yapılır.

## Kendi bilgisayarında proje

Tarayıcıdaki bloklar öğrenmek için yeterli. Gerçek bir proje için (Node.js 20+ kurulu):

```bash
npm create vite@latest magaza -- --template react-ts
cd magaza
npm install
npm run dev
```

**Vite**, geliştirme sunucusu (anlık yenileme, HMR) ve üretim build'i (`npm run build` → `dist/` klasöründe statik dosyalar) sağlar. Linux kursundaki nginx ile ya da Docker kursundaki gibi bir imajla yayınlanır (son bölüm).

```text
magaza/
├── index.html          # tek HTML sayfası, <div id="root">
├── src/
│   ├── main.tsx        # createRoot(document.getElementById("root")).render(<App />)
│   └── App.tsx         # kök bileşen
├── package.json
└── vite.config.ts
```

### Hangi çerçeve?

| Seçenek | Ne zaman |
|---|---|
| **Vite + React** (SPA) | Kimlik doğrulamalı paneller, iç araçlar, mevcut bir API'nin önyüzü. Statik dosya olarak her yerde yayınlanır |
| **React Router** (framework modu) | SPA + sunucu tarafı veri yükleme ve render |
| **Next.js** | SEO gerektiren siteler, Server Components, tam yığın uygulamalar. Bir Node sunucusu (ya da Vercel gibi bir platform) gerekir |

Kursun büyük kısmı çerçeveden bağımsız: Bileşenler, state, hook'lar her yerde aynı. Server Components dersinde Next.js'e geçeceğiz.

## Alıştırma

Aşağıdaki bloğu düzenle:

1. `kullanici` nesnesindeki bilgileri bir kart olarak göster. `admin` ise adın yanında "(yönetici)" yazsın.
2. `etiketler` dizisini virgülle ayrılmış olarak göster.
3. Kartın arka plan rengini `style` ile, `admin` ise açık sarı, değilse açık gri yap.

```react
const kullanici = { ad: "Ayşe", unvan: "Platform mühendisi", admin: true, etiketler: ["kubernetes", "go", "react"] };

export default function App() {
  return (
    <div>
      <h3>{kullanici.ad}</h3>
    </div>
  );
}
```

<details><summary>Bir çözüm</summary>

```react
const kullanici = { ad: "Ayşe", unvan: "Platform mühendisi", admin: true, etiketler: ["kubernetes", "go", "react"] };

export default function App() {
  const arkaPlan = kullanici.admin ? "#fef9c3" : "#f1f5f9";
  return (
    <div style={{ background: arkaPlan, padding: 16, borderRadius: 12, color: "#0f172a" }}>
      <h3 style={{ margin: 0 }}>
        {kullanici.ad} {kullanici.admin && <small>(yönetici)</small>}
      </h3>
      <p>{kullanici.unvan}</p>
      <p>{kullanici.etiketler.join(", ")}</p>
    </div>
  );
}
```

`{kosul && <X />}` kalıbı: Koşul doğruysa elemanı, yanlışsa hiçbir şey çizer. Dikkat: Koşul `0` olursa React `0`'ı ekrana yazar (`false`, `null`, `undefined` ise hiçbir şey yazmaz). Sayılarla `{sayi > 0 && ...}` yaz.

</details>

```quiz
JSX `<p>{ad}</p>` derlendiğinde ne olur?
- Doğrudan bir DOM elemanı oluşturulur
- [x] Ekranda ne olması gerektiğini anlatan bir JavaScript nesnesi (React elemanı) üreten bir fonksiyon çağrısına dönüşür
- HTML metnine dönüşür
? JSX sadece söz dizimidir. DOM'u React, commit aşamasında günceller.
```

```quiz
Bir bileşen render olduğunda DOM'a ne olur?
- Bütün DOM yeniden oluşturulur
- [x] React yeni eleman ağacını öncekiyle karşılaştırır ve DOM'a sadece farkları uygular
- Hiçbir şey, DOM sadece sayfa yenilenince değişir
? Render (fonksiyon çağrısı) ile commit (DOM güncellemesi) ayrı aşamalardır.
```

```quiz
Render sırasında bir API isteği atmak neden yanlıştır?
- JSX buna izin vermez
- [x] Render saf olmalı: React onu istediği kadar çağırabilir (StrictMode'da iki kez), her seferinde istek atılır
- Fetch tarayıcıda çalışmaz
? Yan etkiler olay işleyicilerine ya da effect'lere aittir.
```

## Özet

- React bildirimseldir: UI = f(state). Ne istediğini yazarsın, React DOM'u ona getirir.
- Bileşen = büyük harfle başlayan, JSX döndüren fonksiyon. JSX = `jsx()` çağrıları = eleman nesneleri.
- JSX: `{ifade}`, `className`, camelCase, nesne `style`, tek kök ya da Fragment. Metinler otomatik kaçışlanır.
- Render (fonksiyonu çağır) → commit (DOM'a sadece farklar). State değişince ve ebeveyn render olunca render olur.
- Bileşenler saf olmalı. Yan etkiler olay işleyicilerinde ve effect'lerde.
- Gerçek proje: `npm create vite@latest`. SEO ve sunucu tarafı için Next.js.
