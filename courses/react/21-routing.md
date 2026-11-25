# React Router ile sayfalar ve veri yükleme

Tek sayfalık bir uygulamada (SPA) "sayfalar" aslında aynı HTML'in içinde, adres çubuğundaki URL'e göre değişen bileşenlerdir. **React Router** bunu yönetir: URL'i bileşen ağacına eşler, tarayıcının geri/ileri tuşlarını ve yer imlerini çalıştırır, ve sürüm 6.4'ten beri her sayfanın verisini **o sayfa çizilmeden önce** yükleyebilir. Bu derste React Router 7'nin "data" modunu göreceğiz.

> Oyun alanı izole bir çerçevede çalıştığı için örneklerde gerçek adres çubuğu yerine bellekte tutulan bir geçmiş (`createMemoryRouter`) kullanıyoruz. Kendi projende aynı kod `createBrowserRouter` ile çalışır, sadece bu satır değişir. Örneklerde mevcut adresi görebilmen için küçük bir adres göstergesi ekledik.

React Router 7'de paket adı `react-router`'dır (eski `react-router-dom` onunla birleşti):

```bash
npm install react-router
```

## Rotalar ve iç içe düzen

```react
import { createMemoryRouter, RouterProvider, Link, NavLink, Outlet, useLocation, useParams } from "react-router@7";

function Adres() {
  const { pathname, search } = useLocation();
  return <code style={{ display: "block", background: "#f1f5f9", color: "#0f172a", padding: "2px 6px", marginBottom: 8 }}>{pathname}{search}</code>;
}

function Duzen() {
  const stil = ({ isActive }) => ({ marginRight: 12, fontWeight: isActive ? 700 : 400 });
  return (
    <div>
      <Adres />
      <nav>
        <NavLink to="/" end style={stil}>Ana sayfa</NavLink>
        <NavLink to="/servisler" style={stil}>Servisler</NavLink>
        <NavLink to="/hakkinda" style={stil}>Hakkında</NavLink>
      </nav>
      <hr />
      <Outlet />                      {/* alt rotanın bileşeni buraya */}
    </div>
  );
}

const servisler = [{ id: "api", ad: "siparis-api" }, { id: "odeme", ad: "odeme-api" }];

function ServisListesi() {
  return <ul>{servisler.map((s) => <li key={s.id}><Link to={`/servisler/${s.id}`}>{s.ad}</Link></li>)}</ul>;
}

function ServisDetay() {
  const { id } = useParams();
  const s = servisler.find((x) => x.id === id);
  if (!s) return <p>Servis bulunamadı: {id}</p>;
  return <div><h3>{s.ad}</h3><Link to="..">← listeye dön</Link></div>;
}

const router = createMemoryRouter([
  {
    path: "/",
    element: <Duzen />,
    children: [
      { index: true, element: <p>Panoya hoş geldin.</p> },
      { path: "servisler", element: <ServisListesi /> },
      { path: "servisler/:id", element: <ServisDetay /> },
      { path: "hakkinda", element: <p>Eğitim platformu, sürüm 1.</p> },
      { path: "*", element: <p>404: sayfa yok</p> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
```

- **İç içe rotalar** iç içe düzenler üretir: `Duzen` (menü + `<Outlet />`) bütün alt sayfalarda kalır, sadece `Outlet` değişir.
- `index: true`: Ebeveynin kendi adresinde (`/`) gösterilen alt rota.
- `:id` bir **parametre**: `useParams()` ile okunur. `*` eşleşmeyen her şey.
- `<Link>` sayfayı yeniden yüklemeden URL'i değiştirir. `<a href>` kullanırsan tarayıcı sayfayı baştan yükler ve bütün state kaybolur. `<NavLink>` aktif olduğunda stil alabilir. `to=".."` bir üst rota.

## Veri yükleme: loader

Effect ile veri çekmenin sorunlarını (yükleniyor durumu, şelale istekler, yarış koşulu) hatırla. React Router'da her rota bir **loader** tanımlayabilir: Kullanıcı bağlantıya tıkladığında, yeni sayfa çizilmeden **önce** loader çalışır, bileşen veriyi hazır alır.

```react
import { createMemoryRouter, RouterProvider, Link, Outlet, useLoaderData, useNavigation, useRouteError, isRouteErrorResponse } from "react-router@7";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const vt = {
  api: { ad: "siparis-api", replika: 3, surum: "1.4.2" },
  odeme: { ad: "odeme-api", replika: 2, surum: "2.0.0" },
};

async function servislerLoader() {
  await bekle(600);                               // ağ gecikmesi taklidi
  return Object.entries(vt).map(([id, s]) => ({ id, ...s }));
}

async function servisLoader({ params }) {
  await bekle(600);
  const s = vt[params.id];
  if (!s) throw new Response("Servis bulunamadı", { status: 404 });
  return { id: params.id, ...s };
}

function Duzen() {
  const nav = useNavigation();                    // "idle" | "loading" | "submitting"
  return (
    <div>
      <nav><Link to="/">Servisler</Link> · <Link to="/s/api">api</Link> · <Link to="/s/yok">olmayan</Link></nav>
      <div style={{ opacity: nav.state === "loading" ? 0.4 : 1, transition: "opacity .2s" }}>
        {nav.state === "loading" && <small>yükleniyor…</small>}
        <Outlet />
      </div>
    </div>
  );
}

function Liste() {
  const servisler = useLoaderData();
  return <ul>{servisler.map((s) => <li key={s.id}><Link to={`/s/${s.id}`}>{s.ad}</Link> ({s.replika} replika)</li>)}</ul>;
}

function Detay() {
  const s = useLoaderData();
  return <p><b>{s.ad}</b>, sürüm {s.surum}, {s.replika} replika</p>;
}

function Hata() {
  const hata = useRouteError();
  if (isRouteErrorResponse(hata)) return <p style={{ color: "crimson" }}>{hata.status}: {hata.data}</p>;
  return <p style={{ color: "crimson" }}>Beklenmeyen hata: {String(hata)}</p>;
}

const router = createMemoryRouter([
  {
    path: "/",
    element: <Duzen />,
    HydrateFallback: () => <p>İlk yükleme…</p>,
    children: [
      { index: true, element: <Liste />, loader: servislerLoader },
      { path: "s/:id", element: <Detay />, loader: servisLoader, errorElement: <Hata /> },
    ],
  },
]);

export default function App() { return <RouterProvider router={router} />; }
```

Bağlantılara tıkla: Sayfa, veri gelene kadar **eski içerikle** kalıyor (soluklaşarak), veri gelince yeni sayfa tek seferde, eksiksiz çiziliyor. "olmayan" bağlantısı loader'ın fırlattığı 404 cevabını `errorElement`'e düşürüyor.

Kazanımlar:

- **Yarış koşulu yok**: Kullanıcı hızlıca başka bir bağlantıya tıklarsa React Router önceki yüklemeyi iptal eder (loader'a verilen `request.signal` ile `fetch`'i de iptal edebilirsin).
- **Şelale yok**: İç içe rotaların loader'ları **paralel** çalışır. Effect'lerde ebeveyn veriyi çekip render olana kadar çocuk isteğe başlayamazdı.
- **Hata yönetimi rota bazında**: Bir sayfanın hatası bütün uygulamayı değil, en yakın `errorElement`'i etkiler.
- `useNavigation()` ile geçiş sırasında global bir yükleniyor göstergesi.

## URL'deki state: arama parametreleri

Filtreler, sıralama, sayfa numarası, sekmeler gibi **paylaşılabilir** ve **yenilemeye dayanıklı** olması gereken state'in doğru yeri URL'dir:

```react
import { createMemoryRouter, RouterProvider, useSearchParams, useLocation } from "react-router@7";

const loglar = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, seviye: ["bilgi", "uyari", "hata"][i % 3], mesaj: `olay ${i + 1}` }));

function LogSayfasi() {
  const [params, setParams] = useSearchParams();
  const { search } = useLocation();
  const seviye = params.get("seviye") ?? "hepsi";
  const sayfa = Number(params.get("sayfa") ?? 1);
  const filtreli = loglar.filter((l) => seviye === "hepsi" || l.seviye === seviye);
  const gorunen = filtreli.slice((sayfa - 1) * 5, sayfa * 5);
  const degistir = (yeni) => setParams((p) => { Object.entries(yeni).forEach(([k, v]) => p.set(k, v)); return p; });

  return (
    <div>
      <code style={{ display: "block", background: "#f1f5f9", color: "#0f172a", padding: "2px 6px" }}>/loglar{search}</code>
      <select value={seviye} onChange={(e) => degistir({ seviye: e.target.value, sayfa: 1 })}>
        {["hepsi", "bilgi", "uyari", "hata"].map((s) => <option key={s}>{s}</option>)}
      </select>
      <ul>{gorunen.map((l) => <li key={l.id}>{l.seviye}: {l.mesaj}</li>)}</ul>
      <button disabled={sayfa <= 1} onClick={() => degistir({ sayfa: sayfa - 1 })}>‹</button>
      <span> sayfa {sayfa} / {Math.max(1, Math.ceil(filtreli.length / 5))} </span>
      <button disabled={sayfa * 5 >= filtreli.length} onClick={() => degistir({ sayfa: sayfa + 1 })}>›</button>
    </div>
  );
}

const router = createMemoryRouter([{ path: "/loglar", element: <LogSayfasi /> }], { initialEntries: ["/loglar?seviye=hata"] });
export default function App() { return <RouterProvider router={router} />; }
```

State tasarımı dersindeki "tek doğruluk kaynağı" ilkesinin bir uzantısı: Filtre değeri hem `useState`'te hem URL'de tutulursa iki kaynak birbirinden kopar. URL'i kaynak kabul et, değerleri ondan **türet**.

## Formlar ve action'lar

Veri değiştiren işlemler için rotalar bir **action** tanımlayabilir. React Router'ın `<Form>` bileşeni, tarayıcının yerleşik form gönderimini taklit eder: Gönderilince ilgili rotanın action'ı çalışır, sonra sayfadaki **bütün loader'lar otomatik yeniden çalışır** ve ekran güncel veriyi gösterir. Elle "listeyi yenile" kodu yok.

```react
import { createMemoryRouter, RouterProvider, Form, useLoaderData, useNavigation, useActionData, redirect } from "react-router@7";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
let notlar = [{ id: 1, metin: "PDB ekle" }];

const router = createMemoryRouter([
  {
    path: "/",
    loader: async () => { await bekle(300); return [...notlar]; },
    action: async ({ request }) => {
      const form = await request.formData();
      const metin = String(form.get("metin") ?? "").trim();
      await bekle(700);
      if (form.get("islem") === "sil") { notlar = notlar.filter((n) => n.id !== Number(form.get("id"))); return null; }
      if (metin.length < 3) return { hata: "En az 3 karakter yaz" };
      notlar.push({ id: Date.now(), metin });
      return redirect("/");
    },
    Component: function Notlar() {
      const liste = useLoaderData();
      const sonuc = useActionData();
      const nav = useNavigation();
      const gonderiliyor = nav.state === "submitting";
      return (
        <div>
          <Form method="post">
            <input name="metin" placeholder="Yeni not" />
            <button disabled={gonderiliyor}>{gonderiliyor ? "Kaydediliyor…" : "Ekle"}</button>
            {sonuc?.hata && <p style={{ color: "crimson" }}>{sonuc.hata}</p>}
          </Form>
          <ul>
            {liste.map((n) => (
              <li key={n.id}>{n.metin}
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="id" value={n.id} />
                  <button name="islem" value="sil">✕</button>
                </Form>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  },
]);

export default function App() { return <RouterProvider router={router} />; }
```

Formun `useState`'i yok: Değerler gönderim anında `FormData` olarak toplanıyor (kontrolsüz girdiler). Doğrulama hatası action'dan `useActionData` ile dönüyor. React 19'un kendi form Action'ları da (React 19 dersi) aynı fikri çerçeveden bağımsız olarak getiriyor.

## Kod bölme: tembel rotalar

```js
const router = createBrowserRouter([
  { path: "/", Component: Duzen, children: [
    { index: true, Component: Ana },
    { path: "raporlar", lazy: () => import("./sayfalar/Raporlar") },   // modül { Component, loader } export eder
  ]},
]);
```

`lazy` ile ağır sayfaların kodu ancak kullanıcı oraya gittiğinde indirilir: İlk yükleme küçülür. Performans dersindeki kod bölmenin rota seviyesindeki karşılığı.

## Framework modu

React Router 7, aynı rota tanımlarını bir **çerçeve** olarak da sunar (eski adıyla Remix): dosya tabanlı rotalar, sunucu tarafı render (SSR), loader'ların sunucuda çalışması ve tip güvenliği. Bir SPA'yı olduğu gibi başlatıp ihtiyaç doğunca framework moduna geçmek mümkün. Next.js'e alternatif olarak Server Components dersinde tekrar değineceğiz.

> **SPA yayınlarken dikkat:** `createBrowserRouter` gerçek URL'ler (`/servisler/api`) kullanır. Kullanıcı bu adresi doğrudan açtığında ya da sayfayı yenilediğinde istek sunucuya gider ve sunucuda böyle bir dosya yoktur: 404. Sunucunun bilinmeyen yollarda `index.html` döndürmesi gerekir. Linux kursundaki nginx `try_files $uri $uri/ /index.html;` satırı tam olarak bunun için (yayınlama dersi).

## Alıştırma

1. Derse eklemek için: `/servisler/:id` detay sayfasına `/servisler/:id/loglar` ve `/servisler/:id/ayarlar` alt sekmelerini ekle. Sekme menüsü detay sayfasında kalsın, içerik `<Outlet />`'te değişsin.
2. Detay loader'ı bilinmeyen bir kimlikte 404 fırlatsın ve bunu sadece detay sayfasının hata alanında göster, menü çalışmaya devam etsin.

<details><summary>Bir çözüm</summary>

```react
import { createMemoryRouter, RouterProvider, Link, NavLink, Outlet, useLoaderData, useRouteError } from "react-router@7";

const vt = { api: { ad: "siparis-api" }, odeme: { ad: "odeme-api" } };

function Duzen() {
  return <div><nav><Link to="/servisler/api">api</Link> · <Link to="/servisler/odeme">odeme</Link> · <Link to="/servisler/yok">yok</Link></nav><hr /><Outlet /></div>;
}

function Detay() {
  const s = useLoaderData();
  const stil = ({ isActive }) => ({ marginRight: 10, fontWeight: isActive ? 700 : 400 });
  return (
    <div>
      <h3>{s.ad}</h3>
      <NavLink to="." end style={stil}>Özet</NavLink>
      <NavLink to="loglar" style={stil}>Loglar</NavLink>
      <NavLink to="ayarlar" style={stil}>Ayarlar</NavLink>
      <div style={{ marginTop: 8 }}><Outlet /></div>
    </div>
  );
}

function Hata() { const e = useRouteError(); return <p style={{ color: "crimson" }}>{e.status}: {e.data}</p>; }

const router = createMemoryRouter([
  { path: "/", element: <Duzen />, children: [
    { path: "servisler/:id", element: <Detay />, errorElement: <Hata />,
      loader: ({ params }) => { const s = vt[params.id]; if (!s) throw new Response("Servis yok", { status: 404 }); return s; },
      children: [
        { index: true, element: <p>Özet: her şey yolunda.</p> },
        { path: "loglar", element: <p>Son 100 log satırı…</p> },
        { path: "ayarlar", element: <p>Replika: 3</p> },
      ] },
  ] },
], { initialEntries: ["/servisler/api"] });

export default function App() { return <RouterProvider router={router} />; }
```

`errorElement` detay rotasında olduğu için hata sadece o bölümü değiştirir, `Duzen`'deki menü çalışmaya devam eder.

</details>

```quiz
React Router'da `<a href="/servisler">` yerine `<Link to="/servisler">` kullanmanın sebebi?
- Daha kısa yazılır
- [x] Link sayfayı yeniden yüklemeden URL'i değiştirir, uygulama state'i korunur. a etiketi sayfayı baştan yükler
- a etiketi React'te çalışmaz
? SPA'da gezinme istemci tarafında olur.
```

```quiz
Loader ile veri yüklemenin effect ile yüklemeye göre avantajı?
- Daha az kod
- [x] Veri sayfa çizilmeden önce, iç içe rotalarda paralel yüklenir. Yarış koşulları ve şelale istekler önlenir
- Önbellek otomatik olarak sınırsızdır
? Bileşen veriyi hazır alır, eski gezinmeler iptal edilir.
```

```quiz
`createBrowserRouter` ile yayınlanan SPA'da `/servisler/api` sayfası yenilenince 404 alınıyor. Sebep?
- React Router hatası
- [x] Sunucu bu yolda bir dosya arıyor. Bilinmeyen yollarda index.html döndürmesi gerekir (nginx try_files)
- Tarayıcı önbelleği
? İstemci tarafı rotalar sunucunun haberi olmayan yollardır.
```

## Özet

- `createBrowserRouter` (projede) / `createMemoryRouter` (bu sayfada) + `RouterProvider`. Paket: `react-router`.
- İç içe rotalar ve `<Outlet />`, `index`, `:param` + `useParams`, `*`. `Link`/`NavLink` ile gezinme.
- `loader` + `useLoaderData`: sayfa öncesi, paralel, iptal edilebilir veri yükleme. `errorElement` + `useRouteError`. `useNavigation` ile yükleniyor durumu.
- Paylaşılabilir state URL'de: `useSearchParams`.
- `action` + `<Form>`: gönderimden sonra loader'lar otomatik yenilenir. `useActionData` ile doğrulama hataları.
- `lazy` ile rota bazında kod bölme. Yayınlarken `try_files ... /index.html`.
