# React 19: Actions, useActionState, useOptimistic, use

React 19 (Aralık 2024), React 18'deki eşzamanlı render altyapısının üzerine, günlük işleri basitleştiren bir dizi API getirdi. Ortak tema: **asenkron işlemler** (form gönderme, veri değiştirme) için bekleme durumunu, hataları, iyimser güncellemeleri ve form sıfırlamayı React'in kendisi yönetsin. Bu derste bu API'leri, önceki derslerde elle yazdığımız kalıplarla karşılaştırarak göreceğiz.

## Önce: elle yazılan asenkron işlem

```jsx
function Yeniden({ servis }) {
  const [bekliyor, setBekliyor] = useState(false);
  const [hata, setHata] = useState(null);
  async function tikla() {
    setBekliyor(true); setHata(null);
    try { await yenidenBaslat(servis); }
    catch (e) { setHata(e.message); }
    finally { setBekliyor(false); }
  }
  ...
}
```

Her asenkron işlem için aynı üç state ve aynı `try/finally` kalıbı. React 19 bunu **Action** kavramıyla soyutlar.

## Action: transition içindeki asenkron fonksiyon

React 18'de `startTransition` sadece senkron güncellemeleri "acil olmayan" olarak işaretleyebiliyordu. React 19'da **asenkron fonksiyonlar** da verilebilir. Böyle bir fonksiyona **Action** denir ve React, Action çalıştığı sürece `isPending`'i otomatik olarak `true` tutar:

```react
import { useState, useTransition } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
async function yenidenBaslat(servis) {
  await bekle(1200);
  if (servis === "odeme") throw new Error("odeme-api: kilit alınamadı");
  return new Date().toLocaleTimeString();
}

function Servis({ ad }) {
  const [isPending, startTransition] = useTransition();
  const [sonuc, setSonuc] = useState(null);
  const [hata, setHata] = useState(null);
  return (
    <p>
      <b>{ad}</b>{" "}
      <button disabled={isPending} onClick={() => startTransition(async () => {
        setHata(null);
        try {
          const zaman = await yenidenBaslat(ad);
          startTransition(() => setSonuc(zaman));      // await sonrası güncellemeler de transition içinde
        } catch (e) { setHata(e.message); }
      })}>
        {isPending ? "Yeniden başlatılıyor…" : "↻ Yeniden başlat"}
      </button>
      {sonuc && <small> son: {sonuc}</small>}
      {hata && <small style={{ color: "crimson" }}> {hata}</small>}
    </p>
  );
}

export default function App() {
  return <div><Servis ad="api" /><Servis ad="odeme" /></div>;
}
```

`bekliyor` state'i yok: `isPending` Action süresince otomatik. (`await`'ten sonraki `set` çağrılarını tekrar `startTransition` içine almak şimdilik gerekli bir ayrıntı: React henüz `await` sonrası bağlamı izleyemiyor.)

## Form Action'ları: `<form action={fn}>`

React 19'da `<form>`'un `action` prop'una bir **fonksiyon** verilebilir. Form gönderilince React fonksiyonu `FormData` ile, bir transition içinde çağırır ve başarılı olunca kontrolsüz alanları **otomatik sıfırlar**:

```react
import { useState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [notlar, setNotlar] = useState(["PDB ekle"]);
  async function ekle(formData) {
    const metin = formData.get("metin");
    await bekle(800);
    setNotlar((n) => [...n, metin]);
  }
  return (
    <div>
      <form action={ekle}>
        <input name="metin" placeholder="Not" required />
        <button>Ekle</button>
      </form>
      <ul>{notlar.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </div>
  );
}
```

`useState` ile kontrollü bir input yok, `onSubmit`/`preventDefault` yok, gönderimden sonra input kendiliğinden boşaldı. React Router dersindeki `<Form>` ve action'ların fikri, artık React'in kendisinde.

## useActionState: sonuç ve bekleme durumu

Bir form Action'ının **sonucunu** (başarı mesajı, doğrulama hataları) ve bekleme durumunu tek hook'ta toplar:

```react
import { useActionState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

async function deployEt(oncekiDurum, formData) {
  const surum = String(formData.get("surum") ?? "").trim();
  const ortam = formData.get("ortam");
  await bekle(1000);
  if (!/^(sha-[0-9a-f]{7}|\d+\.\d+\.\d+)$/.test(surum)) {
    return { ...oncekiDurum, hata: "Sürüm sha-xxxxxxx ya da 1.2.3 biçiminde olmalı", surum };
  }
  return { hata: null, surum: "", gecmis: [`${surum} → ${ortam} (${new Date().toLocaleTimeString()})`, ...oncekiDurum.gecmis] };
}

export default function App() {
  const [durum, formAction, isPending] = useActionState(deployEt, { hata: null, surum: "", gecmis: [] });
  return (
    <div>
      <form action={formAction}>
        <input name="surum" defaultValue={durum.surum} placeholder="sha-4f9c2e1" key={durum.gecmis.length} />
        <select name="ortam"><option>staging</option><option>uretim</option></select>
        <button disabled={isPending}>{isPending ? "Deploy ediliyor…" : "Deploy et"}</button>
      </form>
      {durum.hata && <p style={{ color: "crimson" }}>{durum.hata}</p>}
      <ul>{durum.gecmis.map((g) => <li key={g}>{g}</li>)}</ul>
    </div>
  );
}
```

- Action fonksiyonu `(öncekiDurum, formData) => yeniDurum`: Önceki dersteki reducer gibi, ama asenkron.
- Hatalı girdide kullanıcının yazdığını kaybetmemek için `defaultValue={durum.surum}`. Başarıda input'un yeniden oluşup boşalması için `key` (key ile sıfırlama).
- Server Components ile kullanıldığında (son ders) aynı form **JavaScript yüklenmeden önce** de çalışır (progressive enhancement).

## useFormStatus: formun içinden bekleme durumu

Formun içindeki bir alt bileşenin (ortak bir `GonderButonu` gibi) üst formun gönderilip gönderilmediğini props almadan öğrenmesi için:

```react
import { useFormStatus } from "react-dom";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

function GonderButonu({ children }) {
  const { pending, data } = useFormStatus();         // en yakın üst <form>'un durumu
  return <button disabled={pending}>{pending ? `Gönderiliyor: ${data?.get("ad")}…` : children}</button>;
}

export default function App() {
  return (
    <form action={async (fd) => { await bekle(1200); console.log("kaydedildi:", fd.get("ad")); }}>
      <input name="ad" placeholder="Servis adı" required />
      <GonderButonu>Kaydet</GonderButonu>
    </form>
  );
}
```

`useFormStatus` `react-dom`'dan gelir ve sadece bir `<form>`'un **içinde** render edilen bileşenlerde çalışır. Tasarım sistemi bileşenleri için ideal.

## useOptimistic: anında tepki

TanStack Query dersindeki iyimser güncellemeyi React'in kendisiyle yapmak:

```react
import { useState, useOptimistic, startTransition } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
async function sunucuyaGonder(metin) {
  await bekle(1500);
  if (metin.includes("hata")) throw new Error("reddedildi");
  return { id: Date.now(), metin };
}

export default function App() {
  const [mesajlar, setMesajlar] = useState([{ id: 1, metin: "Deploy başladı" }]);
  const [iyimser, iyimserEkle] = useOptimistic(mesajlar, (liste, yeni) => [...liste, { ...yeni, bekliyor: true }]);
  const [hata, setHata] = useState(null);

  async function gonder(formData) {
    const metin = String(formData.get("metin"));
    setHata(null);
    iyimserEkle({ id: "gecici", metin });              // anında göster
    try {
      const kayit = await sunucuyaGonder(metin);
      startTransition(() => setMesajlar((m) => [...m, kayit]));   // gerçek veri gelince
    } catch (e) {
      setHata(`"${metin}" gönderilemedi`);             // Action bitince iyimser değer kendiliğinden kaybolur
    }
  }

  return (
    <div>
      <ul>{iyimser.map((m) => <li key={m.id} style={{ opacity: m.bekliyor ? 0.5 : 1 }}>{m.metin} {m.bekliyor && <small>(gönderiliyor)</small>}</li>)}</ul>
      <form action={gonder}>
        <input name="metin" placeholder='Mesaj ("hata" içerirse başarısız olur)' style={{ width: 260 }} required />
        <button>Gönder</button>
      </form>
      {hata && <p style={{ color: "crimson" }}>{hata}</p>}
    </div>
  );
}
```

`useOptimistic`, bir Action **çalıştığı sürece** gösterilecek geçici bir değer üretir. Action bitince (başarılı ya da başarısız) React iyimser değeri atar ve gerçek state'e döner: Başarıda gerçek kayıt eklenmiş olur, hatada mesaj kaybolur. Elle "geri alma" kodu yazmak gerekmez.

## use: Promise ve context okumak

`use`, render sırasında bir **Promise**'in sonucunu ya da bir context'i okur. Diğer hook'lardan farkı: Koşullu çağrılabilir (`if` içinde).

```react
import { use, Suspense, useState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const onbellek = new Map();
function servisGetir(id) {                       // aynı id için AYNI Promise'i döndür
  if (!onbellek.has(id)) onbellek.set(id, bekle(900).then(() => ({ id, ad: `servis-${id}`, replika: id * 2 })));
  return onbellek.get(id);
}

function Detay({ promise }) {
  const servis = use(promise);                    // hazır değilse en yakın Suspense'i askıya alır
  return <p><b>{servis.ad}</b>: {servis.replika} replika</p>;
}

export default function App() {
  const [id, setId] = useState(1);
  return (
    <div>
      {[1, 2, 3].map((x) => <button key={x} onClick={() => setId(x)}>Servis {x}</button>)}
      <Suspense fallback={<p>Yükleniyor…</p>}>
        <Detay promise={servisGetir(id)} />
      </Suspense>
    </div>
  );
}
```

Önemli bir kural: **Promise render sırasında oluşturulmamalı** (her render'da yeni bir Promise → sonsuz askıya alma). Promise'ler bir önbellekten, bir kütüphaneden (TanStack Query'nin `useSuspenseQuery`'si), bir loader'dan ya da Server Components'ten gelir. Yukarıdaki `onbellek` bu yüzden var. `use` ve Suspense'in birlikte nasıl çalıştığını bir sonraki derste ayrıntılı göreceğiz.

`use(Context)` de `useContext(Context)` gibi çalışır, ama bir `if`'in içinde çağrılabilir.

## Diğer React 19 yenilikleri

| Yenilik | Önceki ders |
|---|---|
| `ref` bir prop, `forwardRef` gereksiz | useRef ve Context |
| `<Context value>` doğrudan sağlayıcı | useRef ve Context |
| Bileşenlerde `<title>`, `<meta>`, `<link>` yazılabilir, React onları `<head>`'e taşır | Ayrı kütüphane (react-helmet) gerekmez |
| Ref'lerde temizlik fonksiyonu: `ref={(el) => { ...; return () => ... }}` | |
| Daha iyi hidrasyon hata mesajları, özel elemanlar (Web Components) için tam destek | |
| React Compiler (ayrı paket, React 19 ile kararlı) | Performans |

```react
export default function App() {
  return (
    <article>
      <title>Sipariş #42 · Panel</title>
      <meta name="description" content="Sipariş ayrıntıları" />
      <h3>Sipariş #42</h3>
      <p>Belgenin başlığı bileşenin içinden ayarlandı (kendi projende sekme başlığında görünür).</p>
    </article>
  );
}
```

## React 18'den yükseltme

React 19, uzun süredir kullanımdan kaldırılmış birkaç API'yi sildi: `ReactDOM.render` (yerine `createRoot`), fonksiyon bileşenlerinde `propTypes` ve `defaultProps` (yerine TypeScript ve varsayılan parametreler), eski context API'si, metin ref'leri. Resmî kodemod'lar (`npx codemod@latest react/19/migration-recipe`) değişikliklerin çoğunu otomatik yapar. Önce 18.3'e geçmek, 19'da kaldırılacak her şey için uyarı verir.

## Alıştırma

React 19 API'leriyle bir "yorum ekle" formu yaz:

1. `useActionState`: Boş yorum ya da 3 karakterden kısa yorum hata mesajı versin, sunucu 800 ms gecikmeyle kaydetsin.
2. `useOptimistic`: Yorum gönderilirken listede soluk görünsün.
3. Gönder butonu ayrı bir bileşen olsun ve `useFormStatus` ile durumunu kendisi bilsin.

<details><summary>Bir çözüm</summary>

```react
import { useActionState, useOptimistic } from "react";
import { useFormStatus } from "react-dom";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

function Buton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>{pending ? "Gönderiliyor…" : "Yorum yap"}</button>;
}

export default function App() {
  const [durum, formAction] = useActionState(async (onceki, fd) => {
    const metin = String(fd.get("metin") ?? "").trim();
    if (metin.length < 3) return { ...onceki, hata: "En az 3 karakter yaz" };
    iyimserEkle(metin);
    await bekle(800);
    return { hata: null, yorumlar: [...onceki.yorumlar, metin] };
  }, { hata: null, yorumlar: ["İlk yorum"] });
  const [gorunen, iyimserEkle] = useOptimistic(durum.yorumlar, (liste, yeni) => [...liste, yeni + " ⏳"]);

  return (
    <div>
      <ul>{gorunen.map((y, i) => <li key={i} style={{ opacity: y.endsWith("⏳") ? 0.5 : 1 }}>{y}</li>)}</ul>
      <form action={formAction}>
        <input name="metin" placeholder="Yorum" key={durum.yorumlar.length} />
        <Buton />
      </form>
      {durum.hata && <p style={{ color: "crimson" }}>{durum.hata}</p>}
    </div>
  );
}
```

`iyimserEkle` Action fonksiyonunun içinden çağrılıyor: `useOptimistic` güncellemeleri bir Action ya da transition içinde yapılmalıdır. Fonksiyon bileşenin içinde tanımlandığı için `iyimserEkle`'ye erişebiliyor.

</details>

```quiz
React 19'da `<form action={fn}>` ile form gönderildiğinde ne olur?
- Sayfa yeniden yüklenir
- [x] fn, FormData ile bir transition içinde çağrılır, bitince kontrolsüz alanlar otomatik sıfırlanır
- fn sadece sunucuda çalışır
? Bekleme durumu useActionState ya da useFormStatus ile okunur.
```

```quiz
`useOptimistic` ile gösterilen geçici değer ne zaman kaybolur?
- Elle temizlenene kadar kalır
- [x] Onu başlatan Action ya da transition bittiğinde: başarıda gerçek state, hatada eski state görünür
- 5 saniye sonra
? Hata durumunda elle geri alma kodu gerekmez.
```

```quiz
`use(promise)` kullanırken Promise neden render sırasında oluşturulmamalı?
- use sadece string kabul eder
- [x] Her render yeni bir Promise üretir, bileşen sürekli askıya alınır. Promise bir önbellekten, kütüphaneden ya da sunucudan gelmeli
- Performans farkı yok, sorun değil
? Aynı veri için aynı Promise nesnesi döndürülmeli.
```

## Özet

- Action = transition içindeki asenkron fonksiyon. `useTransition` ile `isPending` otomatik.
- `<form action={fn}>`: FormData, otomatik sıfırlama, preventDefault yok.
- `useActionState(fn, ilk)`: `(önceki, formData) => yeni` ile sonuç ve hatalar + `isPending`.
- `useFormStatus` (react-dom): formun içinden bekleme durumu.
- `useOptimistic`: Action süresince geçici değer, sonunda otomatik geri dönüş.
- `use(promise)` + Suspense, `use(context)` koşullu. Promise'ler render'da oluşturulmaz.
- `ref` prop, `<Context value>`, belge meta etiketleri. Yükseltme için 18.3 ve kodemod'lar.
