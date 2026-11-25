# State, olaylar, listeler ve koşullu çizim

Props dışarıdan gelir ve değişmez. Ama arayüzlerin çoğu zamanla değişir: Bir sayaç artar, bir form doldurulur, bir liste filtrelenir. React'te bir bileşenin **kendi hafızası** state'tir ve state değişince bileşen yeniden render olur. Bu derste state'in en çok şaşırtan özelliğini (bir **anlık görüntü** olmasını), olayları, listeleri ve `key`'in neden önemli olduğunu göreceğiz.

## useState

```react
import { useState } from "react";

export default function App() {
  const [sayi, setSayi] = useState(0);
  console.log("render, sayi =", sayi);
  return (
    <div>
      <p>Sayaç: {sayi}</p>
      <button onClick={() => setSayi(sayi + 1)}>+1</button>
      <button onClick={() => setSayi(0)}>Sıfırla</button>
    </div>
  );
}
```

`useState(0)` iki şey döndürür: o render'daki **değer** ve onu güncelleyen **fonksiyon**. `setSayi` çağrıldığında:

1. React yeni değeri saklar.
2. Bileşeni **yeniden render** etmek için sıraya koyar.
3. Bir sonraki render'da `useState` yeni değeri döndürür.

Neden sıradan bir değişken yetmez?

```react
export default function App() {
  let sayi = 0;
  return (
    <div>
      <p>Sayaç: {sayi}</p>
      <button onClick={() => { sayi = sayi + 1; console.log("değişken:", sayi); }}>+1</button>
    </div>
  );
}
```

Konsolda değişken artıyor ama ekran değişmiyor: Değişkeni değiştirmek render tetiklemez. Render olsaydı da `let sayi = 0` satırı tekrar çalışıp sıfırlardı. State, render'lar arasında **React tarafından saklanan** ve değişince render tetikleyen değerdir.

### Hook kuralları

`use` ile başlayan fonksiyonlar (hook'lar) iki kurala uyar:

1. Sadece **bileşenin ya da başka bir hook'un en üst seviyesinde** çağrılır: `if`, döngü ya da iç fonksiyon içinde değil.
2. Sadece React bileşenlerinden ve hook'lardan çağrılır.

Sebep: React, bir bileşenin hook'larını **çağrılma sırasına** göre tanır. Bir `if` yüzünden bir render'da `useState` atlanırsa sıra kayar ve değerler karışır.

## State bir anlık görüntüdür

React'in en önemli ve en çok şaşırtan davranışı:

```react
import { useState } from "react";

export default function App() {
  const [sayi, setSayi] = useState(0);
  function ucArtir() {
    setSayi(sayi + 1);
    setSayi(sayi + 1);
    setSayi(sayi + 1);
    console.log("hemen sonra sayi:", sayi);
  }
  return (
    <div>
      <p>Sayaç: {sayi}</p>
      <button onClick={ucArtir}>+3 (olması gereken)</button>
    </div>
  );
}
```

Butona basınca sayı 3 değil **1** artıyor, ve konsoldaki değer hâlâ eski. Çünkü:

- `sayi`, o render'a ait **sabit** bir değerdir (bir fotoğraf). Olay işleyicisi o render'da oluşturuldu ve o render'ın `sayi`'sini görür.
- `setSayi(sayi + 1)` üç kez `setSayi(0 + 1)` demektir.
- `setSayi` değişkeni **değiştirmez**, bir sonraki render için istek bırakır.

Önceki değere göre güncellemek için **güncelleme fonksiyonu** ver:

```react
import { useState } from "react";

export default function App() {
  const [sayi, setSayi] = useState(0);
  function ucArtir() {
    setSayi((s) => s + 1);
    setSayi((s) => s + 1);
    setSayi((s) => s + 1);
  }
  return (
    <div>
      <p>Sayaç: {sayi}</p>
      <button onClick={ucArtir}>+3</button>
    </div>
  );
}
```

React güncelleme fonksiyonlarını sıraya koyar ve her birine bir öncekinin sonucunu verir: 0 → 1 → 2 → 3. Kural: **Yeni state önceki state'ten hesaplanıyorsa güncelleme fonksiyonu kullan.**

### Toplu güncelleme (batching)

Yukarıdaki üç `setSayi` çağrısı **tek bir render** üretti. React, bir olay işleyicisindeki bütün state güncellemelerini toplar ve sonunda bir kez render eder. React 18'den beri bu, `setTimeout`, `fetch` sonrası ve diğer asenkron kodlarda da geçerli.

## Nesne ve dizi state'i: değiştirme, yenisini koy

State'teki nesne ve dizileri **yerinde değiştirme** (mutate etme). React, değişikliği referansın değişmesinden anlar: Aynı nesneyi değiştirip `set` ile geri verirsen React "değişiklik yok" diyebilir.

```react
import { useState } from "react";

export default function App() {
  const [ayar, setAyar] = useState({ replika: 2, imaj: "api:1.0", etiketler: ["web"] });

  function yanlis() {
    ayar.replika = ayar.replika + 1;     // YANLIŞ: aynı nesneyi değiştiriyor
    setAyar(ayar);                        // aynı referans: React render etmeyebilir
    console.log("yanlış yoldan replika:", ayar.replika);
  }
  function dogru() {
    setAyar({ ...ayar, replika: ayar.replika + 1 });                 // yeni nesne
  }
  function etiketEkle() {
    setAyar({ ...ayar, etiketler: [...ayar.etiketler, "v" + ayar.etiketler.length] });   // yeni dizi
  }
  function etiketSil(silinecek) {
    setAyar({ ...ayar, etiketler: ayar.etiketler.filter((e) => e !== silinecek) });
  }

  return (
    <div>
      <pre>{JSON.stringify(ayar, null, 2)}</pre>
      <button onClick={yanlis}>Yanlış +1</button>
      <button onClick={dogru}>Doğru +1</button>
      <button onClick={etiketEkle}>Etiket ekle</button>
      {ayar.etiketler.map((e) => <button key={e} onClick={() => etiketSil(e)}>✕ {e}</button>)}
    </div>
  );
}
```

"Yanlış +1" konsolda artıyor ama ekran değişmiyor. Sonra "Doğru +1"e basınca, değiştirilmiş eski nesne üzerinden hesaplandığı için birden fazla atlıyor: Yerinde değiştirme hataları böyle tutarsız sonuçlar üretir.

| İşlem | Yerinde değiştiren (kullanma) | Yeni dizi döndüren (kullan) |
|---|---|---|
| Ekleme | `push`, `unshift` | `[...dizi, x]`, `[x, ...dizi]` |
| Silme | `splice`, `pop` | `filter` |
| Değiştirme | `dizi[i] = x` | `map` |
| Sıralama | `sort`, `reverse` | `toSorted()`, `toReversed()` ya da `[...dizi].sort()` |

İç içe derin nesnelerde yayma (spread) zahmetli olur. **Immer** kütüphanesi (ya da `useImmer`) yerinde değiştiriyormuş gibi yazıp arka planda yeni nesne üretmeyi sağlar.

## Olaylar

```react
import { useState } from "react";

export default function App() {
  const [metin, setMetin] = useState("");
  const [gonderilen, setGonderilen] = useState([]);

  function gonder(e) {
    e.preventDefault();                      // formun sayfayı yenilemesini engelle
    if (!metin.trim()) return;
    setGonderilen((g) => [...g, metin.trim()]);
    setMetin("");
  }

  return (
    <form onSubmit={gonder}>
      <input
        value={metin}
        onChange={(e) => setMetin(e.target.value)}
        placeholder="Bir not yaz, Enter'a bas"
      />
      <button type="submit" disabled={!metin.trim()}>Ekle</button>
      <p>{metin.length} karakter</p>
      <ul>{gonderilen.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </form>
  );
}
```

- Olay işleyicileri props olarak verilir: `onClick`, `onChange`, `onSubmit`, `onKeyDown`... **Fonksiyonun kendisi** verilir (`onClick={gonder}`), çağrısı değil (`onClick={gonder()}` render sırasında çalışır ve sonucunu verir).
- Olay nesnesi tarayıcının olayını saran bir **sentetik olay**dır: `e.target`, `e.preventDefault()`, `e.stopPropagation()` her tarayıcıda aynı çalışır.
- **Kontrollü girdi**: `value={metin}` + `onChange`. Girdinin değeri her zaman state'ten gelir, state tek doğruluk kaynağıdır. Böylece doğrulama, biçimlendirme ve sıfırlama kolaylaşır.

## Listeler ve key

Listeler `map` ile çizilir ve her elemana **benzersiz ve kalıcı** bir `key` verilir. React, render'lar arasında hangi elemanın hangisi olduğunu `key` ile eşleştirir. Yanlış key'in sonucunu görelim:

```react
import { useState } from "react";

function Satir({ ad }) {
  return (
    <li>
      {ad} — not: <input placeholder={`${ad} için not`} />
    </li>
  );
}

export default function App() {
  const [liste, setListe] = useState([
    { id: "a", ad: "siparis-api" },
    { id: "b", ad: "odeme-api" },
    { id: "c", ad: "katalog" },
  ]);
  const basaEkle = () => setListe((l) => [{ id: String(Date.now()), ad: "yeni-servis-" + l.length }, ...l]);
  return (
    <div>
      <button onClick={basaEkle}>Başa ekle</button>
      <h4>key = dizi sırası (YANLIŞ)</h4>
      <ul>{liste.map((s, i) => <Satir key={i} ad={s.ad} />)}</ul>
      <h4>key = id (DOĞRU)</h4>
      <ul>{liste.map((s) => <Satir key={s.id} ad={s.ad} />)}</ul>
    </div>
  );
}
```

Her iki listede de "siparis-api" satırının kutusuna bir şey yaz, sonra **Başa ekle**'ye bas. Üst listede yazdığın metin **yanlış satıra** kaydı: React `key={0}` olan elemanı "aynı eleman" sandı ve DOM'daki input'unu korudu, sadece adı değiştirdi. Alt listede metin doğru satırla birlikte aşağı kaydı.

Kurallar:

- `key`, kardeşler arasında benzersiz olmalı ve **render'lar arasında değişmemeli**: veritabanı kimliği, benzersiz bir ad.
- Dizi sırasını (`index`) key olarak kullanma (liste hiç değişmiyorsa ve sıralanmıyorsa zararsız, ama alışkanlık edinme).
- Render sırasında `Math.random()` ya da `crypto.randomUUID()` ile key üretme: Her render'da her şey "yeni" sayılır, bütün alt ağaç sıfırlanır.

`key`'in bir başka kullanımı: Bir bileşenin state'ini **bilerek sıfırlamak**. `<Profil key={kullaniciId} />` yazarsan kullanıcı değişince React eski Profil'i atar ve yenisini sıfırdan oluşturur.

## Koşullu çizim

```react
import { useState } from "react";

function Durum({ yukleniyor, hata, veri }) {
  if (yukleniyor) return <p>Yükleniyor…</p>;               // erken dönüş
  if (hata) return <p style={{ color: "crimson" }}>Hata: {hata}</p>;
  return (
    <div>
      {veri.length === 0 ? <p>Kayıt yok.</p> : <ul>{veri.map((v) => <li key={v}>{v}</li>)}</ul>}
      {veri.length > 2 && <p><small>{veri.length} kayıt</small></p>}
    </div>
  );
}

export default function App() {
  const [durum, setDurum] = useState("veri");
  const ornek = { yukleniyor: { yukleniyor: true }, hata: { hata: "zaman aşımı" }, bos: { veri: [] }, veri: { veri: ["a", "b", "c"] } };
  return (
    <div>
      {Object.keys(ornek).map((k) => <button key={k} onClick={() => setDurum(k)} disabled={durum === k}>{k}</button>)}
      <Durum yukleniyor={false} hata={null} veri={[]} {...ornek[durum]} />
    </div>
  );
}
```

Üç araç: **erken dönüş** (`if (...) return`), **üçlü ifade** (`a ? <X/> : <Y/>`) ve **mantıksal VE** (`kosul && <X/>`). Önceki dersteki `0 &&` tuzağını hatırla.

## Alıştırma

Küçük bir yapılacaklar listesi yaz:

1. Kontrollü bir input ve "Ekle" butonu. Her görev `{ id, metin, bitti }` nesnesi.
2. Her görevin yanında bir onay kutusu (`bitti`'yi değiştirir) ve silme butonu. Bitmiş görevlerin üstü çizili olsun.
3. Üstte "3 görevden 1'i bitti" özeti ve "Bitenleri temizle" butonu.
4. Hiç görev yoksa "Liste boş" yazsın.

```react
import { useState } from "react";

export default function App() {
  return <div>Burayı doldur</div>;
}
```

<details><summary>Bir çözüm</summary>

```react
import { useState } from "react";

export default function App() {
  const [gorevler, setGorevler] = useState([
    { id: 1, metin: "PDB ekle", bitti: true },
    { id: 2, metin: "HPA hedefini ayarla", bitti: false },
  ]);
  const [metin, setMetin] = useState("");

  function ekle(e) {
    e.preventDefault();
    if (!metin.trim()) return;
    setGorevler((g) => [...g, { id: Date.now(), metin: metin.trim(), bitti: false }]);
    setMetin("");
  }
  const degistir = (id) => setGorevler((g) => g.map((x) => (x.id === id ? { ...x, bitti: !x.bitti } : x)));
  const sil = (id) => setGorevler((g) => g.filter((x) => x.id !== id));
  const temizle = () => setGorevler((g) => g.filter((x) => !x.bitti));
  const biten = gorevler.filter((g) => g.bitti).length;

  return (
    <div>
      <form onSubmit={ekle}>
        <input value={metin} onChange={(e) => setMetin(e.target.value)} placeholder="Yeni görev" />
        <button disabled={!metin.trim()}>Ekle</button>
      </form>
      <p>{gorevler.length} görevden {biten}'i bitti {biten > 0 && <button onClick={temizle}>Bitenleri temizle</button>}</p>
      {gorevler.length === 0 ? <p>Liste boş.</p> : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {gorevler.map((g) => (
            <li key={g.id}>
              <label style={{ textDecoration: g.bitti ? "line-through" : "none" }}>
                <input type="checkbox" checked={g.bitti} onChange={() => degistir(g.id)} /> {g.metin}
              </label>
              <button onClick={() => sil(g.id)} style={{ marginLeft: 8 }}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`biten` sayısını ayrı bir state'te tutmadık, her render'da `gorevler`'den **türettik**. Türetilebilen bir değeri state'e koymak, iki state'in birbirinden kopmasına yol açar. Bir sonraki bölümün ilk konusu.

</details>

```quiz
`setSayi(sayi + 1)` satırını aynı olay işleyicisinde üç kez çağırdın. Sayı kaç artar?
- 3
- [x] 1
- 0
? `sayi` o render'ın sabit değeridir. Önceki değere göre güncellemek için `setSayi(s => s + 1)`.
```

```quiz
State'teki bir dizinin sonuna eleman eklemenin doğru yolu?
- `liste.push(x); setListe(liste)`
- [x] `setListe([...liste, x])` (ya da `setListe(l => [...l, x])`)
- `liste[liste.length] = x`
? Yerinde değiştirme referansı değiştirmez ve React değişikliği kaçırabilir.
```

```quiz
Sıralaması değişebilen bir listede `key={index}` kullanmanın sonucu?
- Daha hızlı render
- [x] React elemanları yanlış eşleştirir: girdi değerleri ve state yanlış satırlarda kalabilir
- Hiçbir fark olmaz
? key, render'lar arasında aynı veriyi temsil eden kalıcı bir kimlik olmalı.
```

```quiz
`onClick={sil(id)}` yazmanın sorunu?
- Söz dizimi hatası
- [x] `sil` render sırasında hemen çağrılır, tıklamada değil
- Hiçbir sorun yok
? Fonksiyonun kendisi verilmeli: `onClick={() => sil(id)}`.
```

## Özet

- `useState` render'lar arası hafıza. `set` render'ı sıraya koyar, değişkeni değiştirmez.
- Hook'lar sadece en üst seviyede, koşulsuz çağrılır.
- State bir anlık görüntüdür. Önceki değerden hesaplarken güncelleme fonksiyonu: `set(s => ...)`. Güncellemeler toplanır (batching).
- Nesne ve dizileri yerinde değiştirme: yayma, `map`, `filter`, `toSorted`.
- Olay işleyicilerine fonksiyonun kendisini ver. Kontrollü girdiler: `value` + `onChange`.
- Listelerde kalıcı ve benzersiz `key`. `key` ile state'i bilerek sıfırlama.
- Koşullu çizim: erken dönüş, üçlü ifade, `&&` (sayılarla dikkat). Türetilebilen değeri state'e koyma.
