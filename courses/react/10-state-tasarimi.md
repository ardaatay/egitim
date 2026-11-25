# State tasarımı: yukarı taşıma, türetme, useReducer

React hatalarının büyük kısmı yanlış yerde ya da gereğinden fazla tutulan state'ten çıkar: iki state birbirinden kopar, aynı veri iki yerde farklı değerler taşır, kardeş bileşenler birbirinin durumunu bilemez. Bu derste state'i **nereye** ve **hangi biçimde** koyacağına karar vermenin ilkelerini, bileşenler arasında state paylaşmayı ve karmaşık güncellemeler için `useReducer`'ı göreceğiz.

## İlke 1: Türetilebilen şeyi state'e koyma

Bir değer props'tan ya da başka bir state'ten **hesaplanabiliyorsa**, onu state'te tutma: her render'da hesapla.

```react
import { useState } from "react";

const urunler = [
  { id: 1, ad: "Klavye", fiyat: 1200, kategori: "aksesuar" },
  { id: 2, ad: "Monitör", fiyat: 6500, kategori: "ekran" },
  { id: 3, ad: "Fare", fiyat: 450, kategori: "aksesuar" },
  { id: 4, ad: "Dizüstü", fiyat: 42000, kategori: "bilgisayar" },
];

export default function App() {
  const [arama, setArama] = useState("");
  const [kategori, setKategori] = useState("hepsi");

  // TÜRETİLMİŞ: state değil, her render'da hesaplanıyor
  const sonuc = urunler.filter((u) =>
    (kategori === "hepsi" || u.kategori === kategori) &&
    u.ad.toLowerCase().includes(arama.toLowerCase())
  );
  const toplam = sonuc.reduce((t, u) => t + u.fiyat, 0);

  return (
    <div>
      <input value={arama} onChange={(e) => setArama(e.target.value)} placeholder="Ara" />
      <select value={kategori} onChange={(e) => setKategori(e.target.value)}>
        {["hepsi", "aksesuar", "ekran", "bilgisayar"].map((k) => <option key={k}>{k}</option>)}
      </select>
      <ul>{sonuc.map((u) => <li key={u.id}>{u.ad}: {u.fiyat.toLocaleString("tr-TR")} ₺</li>)}</ul>
      <p>{sonuc.length} ürün, toplam {toplam.toLocaleString("tr-TR")} ₺</p>
    </div>
  );
}
```

Yanlış yol: `const [sonuc, setSonuc] = useState(...)` ve arama her değiştiğinde `setSonuc` çağırmak (ya da bir effect'le senkronize etmek). İki state arasında kopma riski, fazladan render ve fazladan kod. Hesaplama gerçekten pahalıysa çözüm state değil `useMemo` (performans dersi).

## İlke 2: Çelişkili state'lerden kaçın

```js
// Kötü: aynı anda hem yukleniyor hem hata true olabilir mi? Kod buna izin veriyor.
const [yukleniyor, setYukleniyor] = useState(false);
const [hata, setHata] = useState(null);
const [veri, setVeri] = useState(null);

// İyi: tek bir durum alanı, sadece geçerli birleşimler mümkün
const [durum, setDurum] = useState({ tur: "bos" });
// { tur: "yukleniyor" } | { tur: "hata", mesaj } | { tur: "basarili", veri }
```

Birlikte değişen ya da birbirini dışlayan state'leri tek bir yapıda topla. TypeScript'te bu bir **ayrık birleşim** (discriminated union) tipi olur ve derleyici geçersiz durumları yakalar (TypeScript dersi).

## İlke 3: Kimlik sakla, kopya değil

```react
import { useState } from "react";

const sunucular = [
  { id: "a", ad: "web-1", cpu: 40 },
  { id: "b", ad: "web-2", cpu: 85 },
  { id: "c", ad: "db-1", cpu: 60 },
];

export default function App() {
  const [liste, setListe] = useState(sunucular);
  const [seciliId, setSeciliId] = useState("a");          // nesnenin KENDİSİ değil, kimliği
  const secili = liste.find((s) => s.id === seciliId);      // türetilmiş

  const yuku = () => setListe((l) => l.map((s) => (s.id === seciliId ? { ...s, cpu: Math.min(100, s.cpu + 10) } : s)));

  return (
    <div>
      {liste.map((s) => (
        <button key={s.id} onClick={() => setSeciliId(s.id)} style={{ fontWeight: s.id === seciliId ? 700 : 400 }}>
          {s.ad} ({s.cpu}%)
        </button>
      ))}
      <p>Seçili: <b>{secili.ad}</b>, CPU %{secili.cpu} <button onClick={yuku}>+10</button></p>
    </div>
  );
}
```

`setSecili(sunucuNesnesi)` yazsaydık, listedeki nesne güncellendiğinde seçili kopya eski kalırdı ("+10" listede görünür, detayda görünmezdi). Kimliği sakla, nesneyi türet.

## State'i yukarı taşımak

İki kardeş bileşenin aynı veriyi görmesi ya da birinin değişikliğinin diğerini etkilemesi gerekiyorsa, state'i **ortak ebeveyne** taşı ve aşağıya props ile ver. Değiştirme yetkisini de bir fonksiyon prop'u olarak ver.

```react
import { useState } from "react";

function Filtre({ deger, degistir }) {
  return (
    <div>
      {["hepsi", "hata", "uyari"].map((f) => (
        <label key={f} style={{ marginRight: 10 }}>
          <input type="radio" checked={deger === f} onChange={() => degistir(f)} /> {f}
        </label>
      ))}
    </div>
  );
}

function LogListesi({ loglar }) {
  return <ul>{loglar.map((l) => <li key={l.id}><b>{l.seviye}</b> {l.mesaj}</li>)}</ul>;
}

function Sayac({ loglar }) {
  return <p>{loglar.length} kayıt gösteriliyor</p>;
}

const tumLoglar = [
  { id: 1, seviye: "bilgi", mesaj: "istek işlendi" },
  { id: 2, seviye: "hata", mesaj: "veritabanı zaman aşımı" },
  { id: 3, seviye: "uyari", mesaj: "yavaş sorgu" },
  { id: 4, seviye: "hata", mesaj: "ödeme servisi yanıt vermedi" },
];

export default function App() {
  const [filtre, setFiltre] = useState("hepsi");           // ortak ebeveynde
  const gorunen = filtre === "hepsi" ? tumLoglar : tumLoglar.filter((l) => l.seviye === filtre);
  return (
    <div>
      <Filtre deger={filtre} degistir={setFiltre} />
      <Sayac loglar={gorunen} />
      <LogListesi loglar={gorunen} />
    </div>
  );
}
```

`Filtre` artık **kontrollü bir bileşen**: Kendi state'i yok, değeri ve değiştirme fonksiyonu dışarıdan geliyor. Veri tek yerde, akış tek yönlü: yukarıdan aşağıya props, aşağıdan yukarıya fonksiyon çağrıları.

State'i **ne kadar yukarı** taşımalı? Ona ihtiyaç duyan bütün bileşenlerin **en yakın ortak atasına** kadar. Gereğinden yukarı taşımak (her şeyi en üste koymak), her değişiklikte büyük alt ağaçların render olmasına ve bileşenlerin birbirine bağımlı hâle gelmesine yol açar. Çok uzak bileşenlerin paylaşması gereken state için Context (bir sonraki ders) ya da bir state kütüphanesi.

## State ağaçtaki konuma bağlıdır

React state'i bileşen fonksiyonunda değil, **ağaçtaki konumda** saklar. Aynı konumda aynı tür bileşen kaldıkça state korunur:

```react
import { useState } from "react";

function Sayac({ etiket }) {
  const [n, setN] = useState(0);
  return <p>{etiket}: {n} <button onClick={() => setN(n + 1)}>+1</button></p>;
}

export default function App() {
  const [kim, setKim] = useState("Ayşe");
  return (
    <div>
      <button onClick={() => setKim(kim === "Ayşe" ? "Mehmet" : "Ayşe")}>Kişiyi değiştir</button>
      <h4>Aynı konum (state taşınır, YANLIŞ)</h4>
      <Sayac etiket={kim} />
      <h4>key ile ayrılmış (her kişinin kendi sayacı sıfırdan)</h4>
      <Sayac key={kim} etiket={kim} />
    </div>
  );
}
```

Üst sayacı artırıp kişiyi değiştir: sayı yeni kişiye "geçti". Alttaki `key={kim}` sayesinde kişi değişince React eski bileşeni atıp yenisini oluşturdu. Önceki dersteki `key` ile sıfırlama.

## useReducer

Bir bileşenin state güncellemeleri çoğalıp karmaşıklaştığında (birden fazla olay aynı state'in farklı parçalarını değiştiriyor), güncelleme mantığını bileşenden ayırıp tek bir **reducer** fonksiyonunda toplamak okunurluğu artırır:

```text
(şimdiki state, eylem) => yeni state
```

```react
import { useReducer, useState } from "react";

const baslangic = { sepet: [], kupon: null };

function sepetReducer(state, eylem) {
  switch (eylem.tur) {
    case "ekle": {
      const var_ = state.sepet.find((s) => s.id === eylem.urun.id);
      const sepet = var_
        ? state.sepet.map((s) => (s.id === eylem.urun.id ? { ...s, adet: s.adet + 1 } : s))
        : [...state.sepet, { ...eylem.urun, adet: 1 }];
      return { ...state, sepet };
    }
    case "azalt":
      return {
        ...state,
        sepet: state.sepet
          .map((s) => (s.id === eylem.id ? { ...s, adet: s.adet - 1 } : s))
          .filter((s) => s.adet > 0),
      };
    case "kupon":
      return { ...state, kupon: eylem.kod === "INDIRIM10" ? { kod: eylem.kod, oran: 0.1 } : null };
    case "temizle":
      return baslangic;
    default:
      throw new Error("bilinmeyen eylem: " + eylem.tur);
  }
}

const urunler = [{ id: 1, ad: "Klavye", fiyat: 1200 }, { id: 2, ad: "Fare", fiyat: 450 }];

export default function App() {
  const [state, dispatch] = useReducer(sepetReducer, baslangic);
  const [kod, setKod] = useState("");
  const ara = state.sepet.reduce((t, s) => t + s.fiyat * s.adet, 0);
  const toplam = state.kupon ? ara * (1 - state.kupon.oran) : ara;

  return (
    <div>
      {urunler.map((u) => <button key={u.id} onClick={() => dispatch({ tur: "ekle", urun: u })}>{u.ad} ekle</button>)}
      <ul>
        {state.sepet.map((s) => (
          <li key={s.id}>{s.ad} × {s.adet} <button onClick={() => dispatch({ tur: "azalt", id: s.id })}>−</button></li>
        ))}
      </ul>
      <input value={kod} onChange={(e) => setKod(e.target.value)} placeholder="Kupon (INDIRIM10)" />
      <button onClick={() => dispatch({ tur: "kupon", kod })}>Uygula</button>
      <p>Toplam: {toplam.toLocaleString("tr-TR")} ₺ {state.kupon && `(${state.kupon.kod} uygulandı)`}</p>
      <button onClick={() => dispatch({ tur: "temizle" })}>Sepeti boşalt</button>
    </div>
  );
}
```

Faydaları:

- **Ne olduğu** (eylem: "ekle", "azalt") ile **nasıl olduğu** (reducer) ayrılır. Olay işleyicileri kısa ve anlamlı.
- Reducer **saf bir fonksiyondur**: React'ten bağımsız olarak test edilebilir (`expect(sepetReducer(s, {tur:"ekle"...})).toEqual(...)`).
- Bütün geçişler tek yerde: Hata ayıklarken eylemleri loglamak yeterli. Redux'un temel fikri budur.

`useState` mi `useReducer` mı? Birkaç bağımsız basit değer için `useState`. Birbirine bağlı alanlar ve çok sayıda güncelleme türü için `useReducer`. Biri diğerinin üzerine kurulmuştur, istediğin zaman geçebilirsin.

## Alıştırma

Bir "deploy onay" formu yaz. State'i doğru tasarlamaya dikkat et:

1. Ortam seçimi (`staging`/`uretim`) ve sürüm metni.
2. Üretim seçiliyse bir "Onaylıyorum" onay kutusu görünsün. Deploy butonu sadece sürüm doluysa ve (üretimse) onay verilmişse etkin olsun.
3. "Deploy et"e basınca durum `gonderiliyor` olsun, 1 saniye sonra `basarili`. Bu sırada form alanları devre dışı kalsın.
4. Ortam değişince onay kutusu sıfırlansın.

```react
import { useState } from "react";

export default function App() {
  return <div>Burayı doldur</div>;
}
```

<details><summary>Bir çözüm</summary>

```react
import { useReducer } from "react";

const ilk = { ortam: "staging", surum: "", onay: false, durum: "duzenleniyor" };

function reducer(s, e) {
  switch (e.tur) {
    case "ortam": return { ...s, ortam: e.deger, onay: false };
    case "surum": return { ...s, surum: e.deger };
    case "onay": return { ...s, onay: e.deger };
    case "gonder": return { ...s, durum: "gonderiliyor" };
    case "bitti": return { ...s, durum: "basarili" };
    case "yeni": return ilk;
    default: return s;
  }
}

export default function App() {
  const [s, dispatch] = useReducer(reducer, ilk);
  const kilitli = s.durum !== "duzenleniyor";
  const gecerli = s.surum.trim() !== "" && (s.ortam === "staging" || s.onay);   // türetilmiş

  function gonder(e) {
    e.preventDefault();
    dispatch({ tur: "gonder" });
    setTimeout(() => dispatch({ tur: "bitti" }), 1000);
  }

  if (s.durum === "basarili")
    return <p>✅ {s.surum} → {s.ortam} deploy edildi. <button onClick={() => dispatch({ tur: "yeni" })}>Yeni</button></p>;

  return (
    <form onSubmit={gonder}>
      <fieldset disabled={kilitli} style={{ border: 0, padding: 0 }}>
        <select value={s.ortam} onChange={(e) => dispatch({ tur: "ortam", deger: e.target.value })}>
          <option value="staging">staging</option>
          <option value="uretim">üretim</option>
        </select>
        <input value={s.surum} onChange={(e) => dispatch({ tur: "surum", deger: e.target.value })} placeholder="sha-4f9c2e1" />
        {s.ortam === "uretim" && (
          <label><input type="checkbox" checked={s.onay} onChange={(e) => dispatch({ tur: "onay", deger: e.target.checked })} /> Onaylıyorum</label>
        )}
        <button disabled={!gecerli}>{s.durum === "gonderiliyor" ? "Gönderiliyor…" : "Deploy et"}</button>
      </fieldset>
    </form>
  );
}
```

`gecerli` state değil, türetilmiş. Ortam değişince onayın sıfırlanması reducer'daki tek bir satır: Bu tür "bir alan değişince başka bir alanı da etkileyen" kurallar reducer'da toplandığında gözden kaçmaz. `<fieldset disabled>` içindeki bütün alanları tek seferde devre dışı bırakır.

</details>

```quiz
Bir listeyi ve arama metnini state'te tutuyorsun. Filtrelenmiş listeyi nerede tutmalısın?
- Ayrı bir state'te, arama değişince güncelleyerek
- Bir useEffect ile senkronize ederek
- [x] Hiçbir yerde: her render'da listeden ve arama metninden hesaplayarak
? Türetilebilen değerleri state'e koymak kopma riski ve fazladan render yaratır.
```

```quiz
İki kardeş bileşenin aynı seçimi paylaşması gerekiyor. Ne yaparsın?
- Her birine kendi state'ini verip senkronize ederim
- [x] State'i en yakın ortak ebeveyne taşıyıp props ile değeri ve değiştirme fonksiyonunu veririm
- Global bir değişken kullanırım
? Tek doğruluk kaynağı, tek yönlü veri akışı.
```

```quiz
`useReducer`'daki reducer fonksiyonu için hangisi doğrudur?
- İçinde API isteği atılabilir
- State'i yerinde değiştirip döndürmelidir
- [x] Saf olmalı: aynı state ve eylemle her zaman aynı yeni state'i döndürür, yan etki yapmaz
? Yan etkiler olay işleyicilerinde ya da effect'lerde. Reducer React'ten bağımsız test edilebilir.
```

## Özet

- Türetilebileni state'e koyma, her render'da hesapla.
- Çelişkili boolean'lar yerine tek bir durum alanı. Nesne değil kimlik sakla.
- Paylaşılan state'i en yakın ortak ebeveyne taşı. Değer ve değiştirici props olarak aşağı iner (kontrollü bileşen).
- State ağaçtaki konuma bağlıdır. `key` ile ayır ya da sıfırla.
- `useReducer`: `(state, eylem) => yeni state`. Karmaşık, birbirine bağlı güncellemeler için. Saf ve test edilebilir.
