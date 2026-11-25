# Kendi hook'larını yazmak

Önceki derslerde aynı kalıpları tekrar tekrar yazdık: pencere genişliğini izleyen bir effect, yarış koşuluna karşı korumalı bir veri çekme, `localStorage` ile senkronize bir state. **Özel hook**'lar bu mantığı bir fonksiyona çıkarıp bileşenler arasında paylaşmayı sağlar. React'te davranış paylaşmanın birincil yolu budur.

## Özel hook nedir?

Adı `use` ile başlayan ve içinde başka hook'lar çağıran sıradan bir fonksiyon:

```react
import { useState, useEffect } from "react";

function useGenislik() {
  const [genislik, setGenislik] = useState(window.innerWidth);
  useEffect(() => {
    const boyut = () => setGenislik(window.innerWidth);
    window.addEventListener("resize", boyut);
    return () => window.removeEventListener("resize", boyut);
  }, []);
  return genislik;
}

function Baslik() {
  const g = useGenislik();
  return <h3>{g < 500 ? "Kısa başlık" : "Uzun ve açıklayıcı bir başlık"}</h3>;
}

function Bilgi() {
  const g = useGenislik();
  return <p>Genişlik: {g}px</p>;
}

export default function App() {
  return <div><Baslik /><Bilgi /><small>Önizlemeyi sağ alt köşesinden yeniden boyutlandır.</small></div>;
}
```

Önemli: Özel hook'lar **state'i değil, state'li mantığı** paylaşır. `Baslik` ve `Bilgi` aynı hook'u çağırıyor, ama her birinin **kendi** `genislik` state'i ve **kendi** olay dinleyicisi var. Hook'u çağırmak, içindeki kodu o bileşenin içine yazmakla aynıdır. Aynı state'i paylaşmak için state'i yukarı taşıma ya da Context gerekir.

`use` öneki bir zorunluluktur: React'in lint kuralları ve derleyicisi, hook kurallarını (sadece en üst seviyede çağırma) bu önekten tanır. Hook çağırmayan bir yardımcı fonksiyona `use` öneki verme.

## Örnek 1: localStorage ile kalıcı state

```react
import { useState, useEffect } from "react";

function useKaliciState(anahtar, baslangic) {
  const [deger, setDeger] = useState(() => {          // tembel başlatma: sadece ilk render'da
    try {
      const kayitli = localStorage.getItem(anahtar);
      return kayitli !== null ? JSON.parse(kayitli) : baslangic;
    } catch { return baslangic; }
  });
  useEffect(() => {
    try { localStorage.setItem(anahtar, JSON.stringify(deger)); } catch {}
  }, [anahtar, deger]);
  return [deger, setDeger];
}

export default function App() {
  const [tema, setTema] = useKaliciState("tema", "acik");
  const [notlar, setNotlar] = useKaliciState("notlar", "");
  return (
    <div>
      <button onClick={() => setTema(tema === "acik" ? "koyu" : "acik")}>Tema: {tema}</button>
      <textarea value={notlar} onChange={(e) => setNotlar(e.target.value)} rows={3} style={{ display: "block", width: "100%", marginTop: 8 }} placeholder="Bir not yaz, sonra ▶ Çalıştır'a tekrar bas" />
    </div>
  );
}
```

(Önizleme güvenlik nedeniyle izole bir çerçevede çalıştığı için tarayıcı `localStorage`'a izin vermeyebilir. O durumda `try/catch` sayesinde hook sessizce normal bir state gibi davranır. Kendi projende değerler sayfa yenilense de kalır.)

- **Tembel başlatma** (`useState(() => ...)`): `localStorage` okuması her render'da değil, sadece ilk render'da çalışır.
- Hook, `useState` ile **aynı arayüzü** (`[deger, setDeger]`) döndürüyor: Kullanan bileşen için hiçbir fark yok, sadece değerler kalıcı.

## Örnek 2: veri çekme hook'u

Önceki dersteki yarış koşulu korumalı veri çekmeyi bir hook'a çıkaralım:

```react
import { useState, useEffect } from "react";

function useVeri(url) {
  const [durum, setDurum] = useState({ tur: "yukleniyor" });
  useEffect(() => {
    const kontrol = new AbortController();
    setDurum({ tur: "yukleniyor" });
    fetch(url, { signal: kontrol.signal })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((veri) => setDurum({ tur: "basarili", veri }))
      .catch((e) => { if (e.name !== "AbortError") setDurum({ tur: "hata", mesaj: e.message }); });
    return () => kontrol.abort();
  }, [url]);
  return durum;
}

function Kullanici({ id }) {
  const d = useVeri(`https://jsonplaceholder.typicode.com/users/${id}`);
  if (d.tur === "yukleniyor") return <p>Yükleniyor…</p>;
  if (d.tur === "hata") return <p style={{ color: "crimson" }}>Hata: {d.mesaj}</p>;
  return <p><b>{d.veri.name}</b> · {d.veri.email} · {d.veri.company.name}</p>;
}

export default function App() {
  const [id, setId] = useState(1);
  return (
    <div>
      {[1, 2, 3, 99].map((x) => <button key={x} onClick={() => setId(x)} disabled={id === x}>Kullanıcı {x}</button>)}
      <Kullanici id={id} />
    </div>
  );
}
```

(Örnek, herkese açık bir test API'si olan JSONPlaceholder'ı kullanıyor. 99 numaralı kullanıcı yok, hata durumunu görmek için.)

Bileşen artık **ne** istediğini söylüyor (`useVeri(url)`), **nasıl** alınacağıyla uğraşmıyor. State'in tek bir `durum` nesnesi olması (state tasarımı dersindeki "çelişkili state'lerden kaçın" ilkesi), bileşenin her durumu açıkça ele almasını kolaylaştırıyor. Bu hook'un önbellek, yeniden deneme ve arka planda yenileme gibi eksikleri, TanStack Query dersinde çözülecek.

## Örnek 3: girdiyi geciktirmek (debounce)

Arama kutusuna her tuşta istek atmak yerine, kullanıcı yazmayı bırakınca atmak:

```react
import { useState, useEffect } from "react";

function useGecikmeli(deger, ms = 400) {
  const [gecikmeli, setGecikmeli] = useState(deger);
  useEffect(() => {
    const id = setTimeout(() => setGecikmeli(deger), ms);
    return () => clearTimeout(id);              // yeni tuşta önceki zamanlayıcı iptal
  }, [deger, ms]);
  return gecikmeli;
}

const servisler = ["siparis-api", "odeme-api", "katalog", "kargo-takip", "kullanici-api", "bildirim", "rapor-uretici", "arama"];

export default function App() {
  const [arama, setArama] = useState("");
  const gecikmeli = useGecikmeli(arama, 500);
  const sonuc = servisler.filter((s) => s.includes(gecikmeli.toLowerCase()));
  useEffect(() => { if (gecikmeli) console.log("API isteği atılır:", gecikmeli); }, [gecikmeli]);
  return (
    <div>
      <input value={arama} onChange={(e) => setArama(e.target.value)} placeholder="Servis ara (hızlı yaz)" />
      <p><small>yazılan: "{arama}" · aranan: "{gecikmeli}"</small></p>
      <ul>{sonuc.map((s) => <li key={s}>{s}</li>)}</ul>
    </div>
  );
}
```

Hızlı yaz: Konsolda her harf için değil, yazmayı bıraktığında bir kez "API isteği" görünür. Bütün mekanizma, effect'in **temizlik** fonksiyonunun önceki zamanlayıcıyı iptal etmesine dayanıyor.

## Örnek 4: bir önceki değer ve dışarı tıklama

```react
import { useState, useEffect, useRef } from "react";

function useOncekiDeger(deger) {
  const ref = useRef();
  useEffect(() => { ref.current = deger; }, [deger]);
  return ref.current;                 // render sırasında: bir önceki commit'teki değer
}

function useDisariTiklama(ref, isleyici) {
  useEffect(() => {
    function dinle(e) {
      if (ref.current && !ref.current.contains(e.target)) isleyici(e);
    }
    document.addEventListener("mousedown", dinle);
    return () => document.removeEventListener("mousedown", dinle);
  }, [ref, isleyici]);
}

export default function App() {
  const [fiyat, setFiyat] = useState(100);
  const onceki = useOncekiDeger(fiyat);
  const [acik, setAcik] = useState(false);
  const menu = useRef(null);
  useDisariTiklama(menu, () => setAcik(false));

  return (
    <div>
      <p>Fiyat: {fiyat} ₺ {onceki !== undefined && onceki !== fiyat && (fiyat > onceki ? "▲" : "▼")} (önceki: {onceki ?? "-"})</p>
      <button onClick={() => setFiyat(fiyat + 10)}>+10</button>
      <button onClick={() => setFiyat(fiyat - 10)}>−10</button>
      <div ref={menu} style={{ display: "inline-block", position: "relative", marginLeft: 12 }}>
        <button onClick={() => setAcik(!acik)}>Menü ▾</button>
        {acik && (
          <ul style={{ position: "absolute", margin: 0, padding: 8, listStyle: "none", background: "#f1f5f9", color: "#0f172a", border: "1px solid #94a3b8", borderRadius: 6 }}>
            <li>Profil</li><li>Ayarlar</li><li>Çıkış</li>
          </ul>
        )}
      </div>
      <p><small>Menüyü açıp dışarı bir yere tıkla.</small></p>
    </div>
  );
}
```

`useDisariTiklama`'ya her render'da yeni bir ok fonksiyonu veriyoruz, bu yüzden effect her render'da yeniden abone oluyor. Burada zararsız. Ama pahalı bir aboneliği olan hook'larda, hook'u kullananların `useCallback` kullanmasını ya da hook'un en son işleyiciyi bir ref'te tutmasını beklemek gerekir. React'in yeni `useEffectEvent` API'si tam bu sorun için tasarlanıyor.

## İyi bir özel hook

- **Tek bir amaca** odaklanır ve adı bu amacı söyler: `useGenislik`, `useVeri`, `useGecikmeli`. `useMount` ya da `useEffectOnce` gibi yaşam döngüsünü saran hook'lar genelde yanlış zihinsel modelin işaretidir: Effect'ler yaşam döngüsü olayları değil, senkronizasyondur.
- **React'in kendi hook'larına benzer bir arayüz** sunar: `[deger, setDeger]` ya da tek bir durum nesnesi.
- **Effect'leri gizler**: Bileşen kodunda `useEffect` ne kadar azsa, kod o kadar okunur. Effect'lerin çoğu bir özel hook'un içinde yaşamalıdır.
- **Hazır kütüphaneleri değerlendir**: `usehooks-ts`, `@uidotdev/usehooks`, `react-use` gibi kütüphanelerde bunların test edilmiş sürümleri var. Veri çekme için TanStack Query, formlar için React Hook Form zaten birer hook kütüphanesidir.

## Alıştırma

1. `useAcikKapali(baslangic = false)` adında bir hook yaz: `[acik, ac, kapat, degistir]` döndürsün. Bir "detayları göster" bölümünde kullan.
2. `useSayac(baslangic, adim)` hook'u: `{ deger, artir, azalt, sifirla }` döndürsün. Değer 0'ın altına düşmesin.
3. İki farklı bileşende `useSayac` kullan. Sayaçlar birbirini etkiliyor mu? Neden?

<details><summary>Bir çözüm</summary>

```react
import { useState, useCallback } from "react";

function useAcikKapali(baslangic = false) {
  const [acik, setAcik] = useState(baslangic);
  const ac = useCallback(() => setAcik(true), []);
  const kapat = useCallback(() => setAcik(false), []);
  const degistir = useCallback(() => setAcik((a) => !a), []);
  return [acik, ac, kapat, degistir];
}

function useSayac(baslangic = 0, adim = 1) {
  const [deger, setDeger] = useState(baslangic);
  return {
    deger,
    artir: () => setDeger((d) => d + adim),
    azalt: () => setDeger((d) => Math.max(0, d - adim)),
    sifirla: () => setDeger(baslangic),
  };
}

function Detay() {
  const [acik, , , degistir] = useAcikKapali();
  return <div><button onClick={degistir}>{acik ? "Gizle" : "Detayları göster"}</button>{acik && <p>Replika: 3, imaj: api:1.4.2</p>}</div>;
}

function SayacKutusu({ ad, adim }) {
  const s = useSayac(0, adim);
  return <p>{ad}: {s.deger} <button onClick={s.azalt}>−</button><button onClick={s.artir}>+</button><button onClick={s.sifirla}>↺</button></p>;
}

export default function App() {
  return <div><Detay /><SayacKutusu ad="Replika" adim={1} /><SayacKutusu ad="CPU (m)" adim={100} /></div>;
}
```

3: Birbirini etkilemezler. Her bileşen hook'u kendi içinde çağırır ve kendi `useState`'ine sahip olur. Özel hook'lar mantığı paylaşır, state'i değil.

</details>

```quiz
İki bileşen aynı `useSayac()` özel hook'unu çağırıyor. Sayaç değerleri hakkında hangisi doğru?
- Aynı değeri paylaşırlar
- [x] Her bileşenin kendi bağımsız state'i olur
- Sadece ilk çağıran state'e sahip olur
? Özel hook state'li mantığı paylaşır. Aynı state'i paylaşmak için yukarı taşıma ya da Context gerekir.
```

```quiz
Bir fonksiyonun adı neden `use` ile başlamalıdır?
- Sadece gelenek
- [x] React'in lint kuralları ve derleyicisi hook kurallarını bu önekten tanır. İçinde hook çağıran fonksiyonlar `use` ile başlamalı
- Performans için
? Hook çağırmayan yardımcı fonksiyonlara `use` öneki verilmez.
```

```quiz
Arama kutusunda her tuşta API isteği atılmasını engellemek için kullanılan kalıp?
- useRef ile sayaç
- [x] Değeri gecikmeli bir state'e yansıtan, temizlikte zamanlayıcıyı iptal eden bir effect (debounce)
- useMemo
? Her yeni tuş bir önceki zamanlayıcıyı temizler, sadece son değer gecikmeden sonra yayılır.
```

## Özet

- Özel hook = `use` ile başlayan, içinde hook çağıran fonksiyon. Mantığı paylaşır, state'i değil.
- Effect'leri özel hook'lara saklamak bileşenleri okunur yapar.
- Örnekler: `useGenislik` (abonelik), `useKaliciState` (tembel başlatma + senkronizasyon), `useVeri` (iptal edilebilir istek, durum nesnesi), `useGecikmeli` (debounce), `useOncekiDeger`, `useDisariTiklama`.
- İyi hook: tek amaç, React benzeri arayüz, yaşam döngüsü değil senkronizasyon. Hazır kütüphaneleri de değerlendir.
