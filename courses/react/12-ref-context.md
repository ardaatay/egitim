# useRef ve Context

Bu derste React'in iki "kaçış ve kısayol" aracını görüyoruz. **useRef**, render'ı tetiklemeyen bir hafıza kutusu ve DOM elemanlarına doğrudan erişim sağlar. **Context**, veriyi props zincirinden geçirmeden ağacın derinliklerine ulaştırır. İkisi de güçlü, ama ikisi de yanlış kullanıldığında React'in veri akışını bulanıklaştırır.

## useRef: render'ı tetiklemeyen değer

`useRef(baslangic)` bir `{ current: baslangic }` nesnesi döndürür. Bu nesne render'lar arasında **aynı kalır** ve `current`'ı değiştirmek render **tetiklemez**.

| | state | ref |
|---|---|---|
| Değişince render olur mu? | Evet | **Hayır** |
| Değer render sırasında okunabilir mi? | Evet (anlık görüntü) | Okunmamalı (değişiklik ekrana yansımaz) |
| Değiştirme | `set` ile, sonraki render'da | `ref.current = x`, hemen |
| Kullanım | Ekranda görünen veri | Zamanlayıcı kimlikleri, önceki değerler, DOM elemanları, harici nesneler |

```react
import { useState, useRef } from "react";

export default function App() {
  const [baslangic, setBaslangic] = useState(null);
  const [simdi, setSimdi] = useState(null);
  const zamanlayici = useRef(null);          // interval kimliği: ekranda gösterilmiyor, render gerekmiyor
  const tiklama = useRef(0);                 // sayılıyor ama gösterilmiyor

  function basla() {
    setBaslangic(Date.now());
    setSimdi(Date.now());
    clearInterval(zamanlayici.current);
    zamanlayici.current = setInterval(() => setSimdi(Date.now()), 10);
  }
  function dur() {
    clearInterval(zamanlayici.current);
    tiklama.current += 1;
    console.log("durdurma sayısı (ref):", tiklama.current);
  }
  const gecen = baslangic && simdi ? ((simdi - baslangic) / 1000).toFixed(2) : "0.00";

  return (
    <div>
      <h2>{gecen} sn</h2>
      <button onClick={basla}>Başlat</button>
      <button onClick={dur}>Durdur</button>
    </div>
  );
}
```

Zamanlayıcı kimliğini state'te tutsaydık, onu kaydetmek gereksiz bir render tetiklerdi. Normal bir değişkende tutsaydık her render'da sıfırlanırdı ve `dur` onu bulamazdı. Ref tam bu iş için.

> **Render sırasında ref okuma ya da yazma.** `ref.current` render'da okunursa değeri ekranla tutarsız olabilir (değişince render olmadığı için). Ref'leri olay işleyicilerinde ve effect'lerde kullan. İstisna: Yavaş başlatılan bir nesneyi ilk render'da bir kez oluşturmak (`if (ref.current === null) ref.current = new Pahali()`).

## useRef: DOM elemanlarına erişim

Bazen DOM'a doğrudan dokunmak gerekir: odaklama, kaydırma, ölçüm, video oynatma, React dışı bir kütüphaneyi (harita, grafik) bir elemana bağlama.

```react
import { useRef, useState } from "react";

export default function App() {
  const girdi = useRef(null);
  const liste = useRef(null);
  const [kayitlar, setKayitlar] = useState(Array.from({ length: 30 }, (_, i) => `log satırı ${i + 1}`));

  function ekle() {
    setKayitlar((k) => [...k, `yeni satır ${k.length + 1}`]);
    // DOM henüz güncellenmedi; bir sonraki karede en alta kaydır
    requestAnimationFrame(() => liste.current.scrollTo({ top: liste.current.scrollHeight, behavior: "smooth" }));
  }

  return (
    <div>
      <input ref={girdi} placeholder="Ara" />
      <button onClick={() => girdi.current.focus()}>Aramaya odaklan</button>
      <button onClick={ekle}>Satır ekle ve en alta kaydır</button>
      <div ref={liste} style={{ height: 110, overflow: "auto", border: "1px solid #94a3b8", marginTop: 8, padding: 4, fontFamily: "monospace", fontSize: 13 }}>
        {kayitlar.map((k) => <div key={k}>{k}</div>)}
      </div>
    </div>
  );
}
```

`ref={girdi}` ile React, commit sırasında DOM elemanını `girdi.current`'a koyar (ve eleman kaldırılınca `null` yapar).

### Ref'i bir bileşene vermek

Kendi bileşenlerinin içindeki DOM elemanına ebeveynin erişmesi için **React 19'dan beri `ref` sıradan bir prop** olarak verilir:

```react
import { useRef } from "react";

function AramaKutusu({ ref, ...props }) {        // React 19: ref artık bir prop
  return <input ref={ref} {...props} style={{ padding: 6, borderRadius: 6, border: "1px solid #94a3b8" }} />;
}

export default function App() {
  const arama = useRef(null);
  return (
    <div>
      <AramaKutusu ref={arama} placeholder="Servis ara" />
      <button onClick={() => { arama.current.focus(); arama.current.select(); }}>Odaklan</button>
    </div>
  );
}
```

React 18 ve öncesinde bunun için bileşenin `forwardRef` ile sarılması gerekiyordu. Eski kodlarda bolca göreceksin. React 19'da `forwardRef` hâlâ çalışıyor ama artık gerekmiyor.

Ref'ler kapsüllemeyi deler: Ebeveyn çocuğun iç yapısına bağımlı hâle gelir. Ölçülü kullan: Odaklama, kaydırma, ölçüm gibi gerçekten imperatif işler için. Veri iletmek için props yeterlidir.

## Context: props zincirini atlamak

Bir değerin (tema, oturum açmış kullanıcı, dil, yetkiler) ağacın pek çok yerinde gerekli olduğu durumlarda, onu her ara bileşenden props olarak geçirmek (**prop drilling**) yorucu ve kırılgandır. Context, bir değeri bir **sağlayıcı** (provider) altındaki bütün bileşenlere erişilebilir yapar.

```react
import { createContext, useContext, useState } from "react";

const TemaContext = createContext("acik");                     // 1. oluştur (varsayılan değerle)

function Kart({ baslik, children }) {
  const tema = useContext(TemaContext);                       // 3. kullan (ne kadar derinde olursa olsun)
  const stil = tema === "koyu"
    ? { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155" }
    : { background: "#ffffff", color: "#0f172a", border: "1px solid #cbd5e1" };
  return <div style={{ ...stil, padding: 12, borderRadius: 10, marginTop: 8 }}><b>{baslik}</b><div>{children}</div></div>;
}

function Panel() {                                             // ara bileşen temayı bilmiyor bile
  return (
    <div>
      <Kart baslik="Küme">3 node hazır</Kart>
      <Kart baslik="Uyarılar">Yok</Kart>
    </div>
  );
}

export default function App() {
  const [tema, setTema] = useState("acik");
  return (
    <TemaContext value={tema}>                                {/* 2. sağla */}
      <button onClick={() => setTema(tema === "acik" ? "koyu" : "acik")}>Tema: {tema}</button>
      <Panel />
    </TemaContext>
  );
}
```

React 19'da sağlayıcı doğrudan `<TemaContext value={...}>` olarak yazılır. Eski kodlarda `<TemaContext.Provider value={...}>` göreceksin, ikisi aynı.

Kurallar:

- `useContext`, ağaçta **en yakın** sağlayıcının değerini okur. Hiç sağlayıcı yoksa `createContext`'e verilen varsayılan değeri.
- Sağlayıcının `value`'su değişince, o context'i okuyan **bütün** bileşenler render olur.

### Context + reducer: uygulama genelinde state

Önceki dersteki `useReducer` ile birleşince, küçük ve orta uygulamalar için harici kütüphanesiz bir state yönetimi elde edilir:

```react
import { createContext, useContext, useReducer } from "react";

const SepetContext = createContext(null);
const SepetDispatchContext = createContext(null);

function reducer(sepet, e) {
  switch (e.tur) {
    case "ekle": return sepet.some((s) => s.id === e.urun.id)
      ? sepet.map((s) => (s.id === e.urun.id ? { ...s, adet: s.adet + 1 } : s))
      : [...sepet, { ...e.urun, adet: 1 }];
    case "sil": return sepet.filter((s) => s.id !== e.id);
    default: return sepet;
  }
}

function SepetProvider({ children }) {
  const [sepet, dispatch] = useReducer(reducer, []);
  return (
    <SepetContext value={sepet}>
      <SepetDispatchContext value={dispatch}>{children}</SepetDispatchContext>
    </SepetContext>
  );
}

// Özel hook'lar: kullananlar context'in kendisini bilmek zorunda değil
function useSepet() {
  const s = useContext(SepetContext);
  if (s === null) throw new Error("useSepet, SepetProvider içinde kullanılmalı");
  return s;
}
function useSepetDispatch() { return useContext(SepetDispatchContext); }

const urunler = [{ id: 1, ad: "Klavye" }, { id: 2, ad: "Fare" }];

function UrunListesi() {
  const dispatch = useSepetDispatch();
  console.log("UrunListesi render");
  return urunler.map((u) => <button key={u.id} onClick={() => dispatch({ tur: "ekle", urun: u })}>{u.ad} ekle</button>);
}

function SepetOzeti() {
  const sepet = useSepet();
  const adet = sepet.reduce((t, s) => t + s.adet, 0);
  return <p>🛒 {adet} ürün: {sepet.map((s) => `${s.ad}×${s.adet}`).join(", ") || "boş"}</p>;
}

export default function App() {
  return (
    <SepetProvider>
      <SepetOzeti />
      <UrunListesi />
    </SepetProvider>
  );
}
```

Üç ayrıntı:

1. **Değer ve dispatch ayrı context'lerde**: `dispatch` hiç değişmez. Sadece eylem gönderen bileşenler (`UrunListesi`) sepet değişince render olmaz. Konsolda "UrunListesi render" sadece bir kez görünür.
2. **Özel hook'lar** (`useSepet`) context'i kapsüller ve sağlayıcı unutulduğunda anlaşılır bir hata verir.
3. **Sağlayıcı bileşeni** (`SepetProvider`) state mantığını uygulamanın geri kalanından ayırır.

### Context ne zaman kullanılmaz?

- **Sık değişen ve çok yerde okunan** değerler için (fare konumu, her tuşta değişen bir form): Her değişiklikte bütün okuyucular render olur. Bunun için Zustand, Jotai, Redux Toolkit gibi **seçici** (selector) destekleyen kütüphaneler daha uygundur: bileşen sadece ilgilendiği parça değişince render olur.
- **İki-üç seviyelik** prop geçişi için: Bu prop drilling değil, açık bir veri akışı. Önce kompozisyonu dene: Ara bileşenlere veri yerine **`children`** vermek, veriyi gerektiği yere doğrudan ulaştırır.
- **Sunucu verisi** için (kullanıcı listesi, ürünler): Önbellek, yeniden doğrulama ve yükleniyor durumlarıyla TanStack Query daha doğru araç (ilerideki ders).

Tipik doğru kullanımlar: tema, dil/yerelleştirme, oturum açmış kullanıcı ve yetkileri, bir bileşen kütüphanesinin iç durumu (bir `Tabs` bileşeninin aktif sekmesi), yönlendirici.

## Alıştırma

1. Bir **bildirim sistemi** yaz: `BildirimProvider`, `useBildirim()` hook'u ve `goster(mesaj)` fonksiyonu. Bildirimler sağ altta görünsün ve 3 saniye sonra kendiliğinden kaybolsun. Ağacın farklı yerlerindeki iki butondan bildirim gönder.
2. Bildirimin kaybolma zamanlayıcılarını nerede tutarsın: state mi, ref mi?

<details><summary>Bir çözüm</summary>

```react
import { createContext, useContext, useState, useRef, useCallback } from "react";

const BildirimContext = createContext(null);

function BildirimProvider({ children }) {
  const [liste, setListe] = useState([]);
  const sira = useRef(0);
  const goster = useCallback((mesaj) => {
    const id = ++sira.current;
    setListe((l) => [...l, { id, mesaj }]);
    setTimeout(() => setListe((l) => l.filter((b) => b.id !== id)), 3000);
  }, []);
  return (
    <BildirimContext value={goster}>
      {children}
      <div style={{ position: "fixed", right: 12, bottom: 12, display: "grid", gap: 6 }}>
        {liste.map((b) => <div key={b.id} style={{ background: "#0f172a", color: "white", padding: "8px 12px", borderRadius: 8 }}>{b.mesaj}</div>)}
      </div>
    </BildirimContext>
  );
}

function useBildirim() {
  const g = useContext(BildirimContext);
  if (!g) throw new Error("useBildirim, BildirimProvider içinde kullanılmalı");
  return g;
}

function KaydetButonu() {
  const goster = useBildirim();
  return <button onClick={() => goster("Kaydedildi")}>Kaydet</button>;
}

function DeployButonu() {
  const goster = useBildirim();
  return <button onClick={() => goster("Deploy başladı: sha-4f9c2e1")}>Deploy</button>;
}

export default function App() {
  return (
    <BildirimProvider>
      <section><h4>Ayarlar</h4><KaydetButonu /></section>
      <section><h4>Dağıtım</h4><DeployButonu /></section>
    </BildirimProvider>
  );
}
```

2: Bu çözümde zamanlayıcıları hiç saklamadık, her biri bitince kendi bildirimini siliyor. Bildirimleri elle kapatma ya da Provider kaldırılınca zamanlayıcıları temizleme gerekseydi, kimlikleri bir **ref**'te (`useRef(new Map())`) tutardık: Ekranda gösterilmiyorlar, değişmeleri render gerektirmiyor. `useCallback`, `goster` fonksiyonunun her render'da yeni bir referans olmasını engelliyor. Böylece context değeri sabit kalıyor ve sadece buton bileşenleri gereksiz yere render olmuyor (performans dersinde ayrıntılı).

</details>

```quiz
Bir değeri render'lar arasında saklaman gerekiyor ama değişmesi ekranı etkilemiyor (örneğin bir interval kimliği). Ne kullanırsın?
- useState
- [x] useRef
- Bileşen içinde let değişken
? Ref render'lar arasında korunur ve değişmesi render tetiklemez. Normal değişken her render'da sıfırlanır.
```

```quiz
React 19'da kendi bileşeninin içindeki input'a ebeveynin ref vermesi için ne gerekir?
- Bileşeni forwardRef ile sarmak zorunlu
- [x] `ref`'i sıradan bir prop olarak alıp input'a vermek yeterli
- Mümkün değil
? React 19'dan beri ref fonksiyon bileşenlerinde bir prop'tur. forwardRef eski sürümler içindir.
```

```quiz
Context değeri her değiştiğinde ne olur?
- Sadece en yakın çocuk render olur
- [x] O context'i okuyan bütün bileşenler render olur
- Hiçbir şey, context sadece ilk değeri verir
? Sık değişen değerler için seçici destekleyen state kütüphaneleri daha uygundur.
```

## Özet

- `useRef`: render'lar arası, değişince render tetiklemeyen `{ current }`. Zamanlayıcılar, önceki değerler, harici nesneler. Render sırasında okuma.
- DOM erişimi: `ref={x}`, `x.current.focus()`. React 19'da `ref` bir prop, `forwardRef` gereksiz.
- Context: `createContext` → `<Ctx value>` → `useContext`. En yakın sağlayıcı. Değer değişince bütün okuyucular render olur.
- Context + reducer: değer ve dispatch ayrı context'lerde, özel hook'larla kapsülle.
- Sık değişen değerler, sunucu verisi ve sığ prop geçişleri için context'ten önce başka araçları düşün.
