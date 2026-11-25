# Bileşenler, props, children ve kompozisyon

React uygulaması, birbirinin içine yerleştirilmiş bileşenlerden oluşan bir **ağaçtır**. Veri bu ağaçta yukarıdan aşağıya **props** ile akar. Bu derste bileşenlere veri vermeyi, `children` ile iç içe yapılar kurmayı ve büyük arayüzleri küçük, yeniden kullanılabilir parçalara bölmenin yollarını göreceğiz.

## Props

Props, bir bileşene dışarıdan verilen argümanlardır: HTML özniteliklerine benzer şekilde yazılır, bileşen onları tek bir nesne olarak alır.

```react
function Rozet({ metin, renk = "#0284c7" }) {
  return (
    <span style={{ background: renk, color: "white", padding: "2px 8px", borderRadius: 99, fontSize: 13, marginRight: 6 }}>
      {metin}
    </span>
  );
}

function ServisKarti({ ad, surum, durum, replika }) {
  const renk = durum === "saglikli" ? "#16a34a" : durum === "uyari" ? "#ca8a04" : "#dc2626";
  return (
    <div style={{ border: "1px solid #cbd5e1", borderRadius: 10, padding: 12, marginBottom: 8 }}>
      <b>{ad}</b> <Rozet metin={surum} /> <Rozet metin={durum} renk={renk} />
      <div>Replika: {replika}</div>
    </div>
  );
}

export default function App() {
  return (
    <div>
      <ServisKarti ad="siparis-api" surum="1.4.2" durum="saglikli" replika={3} />
      <ServisKarti ad="odeme-api" surum="2.0.0" durum="uyari" replika={2} />
      <ServisKarti ad="rapor" surum="0.9.1" durum="hata" replika={0} />
    </div>
  );
}
```

- Props bir nesne olarak gelir. Parametrede **yapı bozma** (destructuring) ile alanlara ayırmak yaygın kalıp: `function ServisKarti({ ad, surum })`.
- **Varsayılan değer**: `renk = "#0284c7"`.
- Metin dışındaki değerler (sayı, boolean, nesne, fonksiyon) süslü parantezle verilir: `replika={3}`. `replika="3"` metin olurdu.

### Props salt okunurdur

Bir bileşen kendi props'unu **değiştirmez**. Props, ebeveynin o render'daki anlık görüntüsüdür: Değişmesi gerekiyorsa ebeveyn yeni değerle tekrar render eder. Bileşenin kendi zamanla değişen verisi için **state** kullanılır (bir sonraki ders). Önceki dersteki "saf bileşen" kuralının bir parçası.

### Props aktarma

Bir bileşen aldığı props'ları olduğu gibi alt bileşene ya da bir HTML elemanına aktarabilir:

```react
function Buton({ varyant = "birincil", ...geriKalan }) {
  const stil = varyant === "birincil"
    ? { background: "#0284c7", color: "white", border: "none" }
    : { background: "white", color: "#0f172a", border: "1px solid #cbd5e1" };
  return <button style={{ ...stil, padding: "6px 14px", borderRadius: 8, marginRight: 6 }} {...geriKalan} />;
}

export default function App() {
  return (
    <div>
      <Buton onClick={() => alert("Kaydedildi")}>Kaydet</Buton>
      <Buton varyant="ikincil" disabled title="Henüz değil">İptal</Buton>
    </div>
  );
}
```

`...geriKalan` ile `onClick`, `disabled`, `title`, `children` gibi bütün diğer props'lar `<button>`'a aktarıldı. Bileşen kütüphanelerinin temel kalıbı. Ölçülü kullan: Her şeyi körü körüne aktarmak, bir bileşenin hangi props'ları gerçekten kullandığını belirsizleştirir.

## children

Bir bileşenin açılış ve kapanış etiketleri arasına yazılan her şey `children` prop'u olarak gelir. Böylece içeriği bilmeyen **kapsayıcı** bileşenler yazılır:

```react
function Panel({ baslik, children, alt }) {
  return (
    <section style={{ border: "1px solid #cbd5e1", borderRadius: 12, overflow: "hidden", marginBottom: 12 }}>
      <header style={{ background: "#0f172a", color: "white", padding: "8px 12px", fontWeight: 600 }}>{baslik}</header>
      <div style={{ padding: 12 }}>{children}</div>
      {alt && <footer style={{ borderTop: "1px solid #e2e8f0", padding: "6px 12px", fontSize: 13 }}>{alt}</footer>}
    </section>
  );
}

export default function App() {
  return (
    <>
      <Panel baslik="Küme durumu" alt={<span>Son güncelleme: az önce</span>}>
        <p>3 node hazır, 42 Pod çalışıyor.</p>
        <progress value={70} max={100} /> CPU %70
      </Panel>
      <Panel baslik="Uyarılar">
        <ul><li>odeme-api: 5xx oranı yüksek</li></ul>
      </Panel>
    </>
  );
}
```

`alt` prop'una da JSX verdik: JSX bir değerdir, her prop'a verilebilir. Birden fazla "delik" gereken düzenler (başlık, gövde, alt) için adlı props'lar, tek bir içerik alanı için `children` kullanılır.

## Kompozisyon

React'te kod paylaşmanın birincil yolu kalıtım değil, **bileşenleri birleştirmektir**. Büyük bir ekranı tasarlarken:

1. Arayüzü kutulara böl. Her kutu bir bileşen adayı.
2. Bir bileşen tek bir işten sorumlu olsun. Çok büyüyorsa alt bileşenlere böl.
3. Veriyi en üstten aşağıya props ile akıt.

```react
const servisler = [
  { ad: "siparis-api", takim: "odeme", replika: 3, hazir: 3 },
  { ad: "odeme-api", takim: "odeme", replika: 2, hazir: 1 },
  { ad: "katalog", takim: "magaza", replika: 4, hazir: 4 },
];

function DurumNoktasi({ tamam }) {
  return <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: tamam ? "#16a34a" : "#dc2626", marginRight: 6 }} />;
}

function ServisSatiri({ servis }) {
  const tamam = servis.hazir === servis.replika;
  return (
    <tr>
      <td><DurumNoktasi tamam={tamam} />{servis.ad}</td>
      <td>{servis.takim}</td>
      <td>{servis.hazir}/{servis.replika}</td>
    </tr>
  );
}

function ServisTablosu({ servisler }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead><tr><th align="left">Servis</th><th align="left">Takım</th><th align="left">Hazır</th></tr></thead>
      <tbody>
        {servisler.map((s) => <ServisSatiri key={s.ad} servis={s} />)}
      </tbody>
    </table>
  );
}

function Ozet({ servisler }) {
  const sorunlu = servisler.filter((s) => s.hazir < s.replika).length;
  return <p>{servisler.length} servis, <b>{sorunlu}</b> tanesinde eksik replika.</p>;
}

export default function App() {
  return (
    <div>
      <Ozet servisler={servisler} />
      <ServisTablosu servisler={servisler} />
    </div>
  );
}
```

`Ozet` ve `ServisTablosu` aynı veriyi alıp farklı biçimlerde gösteriyor. Veri tek yerde (en üstte) duruyor, bileşenler sadece onu nasıl göstereceklerini biliyor. `map` içindeki `key` prop'u bir sonraki derste.

### Bileşen tanımlarını iç içe yazma

```jsx
function Liste() {
  function Satir() { return <li>...</li>; }   // YANLIŞ: her render'da YENİ bir bileşen türü
  return <ul><Satir /></ul>;
}
```

Bir bileşeni başka bir bileşenin **içinde tanımlamak**, her render'da yeni bir fonksiyon (yani yeni bir bileşen türü) üretir. React her seferinde eski alt ağacı atıp yenisini oluşturur: Alt bileşenin state'i her render'da sıfırlanır ve performans düşer. Bileşenleri her zaman dosyanın en üst seviyesinde tanımla.

## Dosya düzeni ve export

Gerçek projede her anlamlı bileşen kendi dosyasında:

```text
src/
├── components/
│   ├── Buton.tsx           export function Buton(...)
│   └── Panel.tsx
├── features/servisler/
│   ├── ServisTablosu.tsx
│   └── ServisSatiri.tsx
└── App.tsx                 import { ServisTablosu } from "./features/servisler/ServisTablosu"
```

Adlı export'lar (`export function Buton`) yeniden adlandırmaları ve IDE'nin otomatik import'unu daha tutarlı yapar. Bu sayfadaki bloklarda önizlemenin hangi bileşeni çizeceğini bilmesi için kök bileşen `export default` ile veriliyor.

## Alıştırma

Aşağıdaki veriyle bir "Pod listesi" yaz:

1. Her Pod için bir `PodKarti` bileşeni: ad, durum ve yeniden başlama sayısı.
2. Durum `Running` değilse kartın kenarlığı kırmızı olsun. Yeniden başlama 3'ten fazlaysa "⚠" göster.
3. Kartları saran, başlığı props'tan, içeriği `children`'dan gelen bir `Bolum` bileşeni.

```react
const podlar = [
  { ad: "api-7c9d-x2", durum: "Running", restart: 0 },
  { ad: "api-7c9d-k8", durum: "CrashLoopBackOff", restart: 12 },
  { ad: "worker-5f4-a1", durum: "Running", restart: 4 },
];

export default function App() {
  return <div>Burayı doldur</div>;
}
```

<details><summary>Bir çözüm</summary>

```react
const podlar = [
  { ad: "api-7c9d-x2", durum: "Running", restart: 0 },
  { ad: "api-7c9d-k8", durum: "CrashLoopBackOff", restart: 12 },
  { ad: "worker-5f4-a1", durum: "Running", restart: 4 },
];

function Bolum({ baslik, children }) {
  return (
    <section>
      <h3 style={{ marginBottom: 8 }}>{baslik}</h3>
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </section>
  );
}

function PodKarti({ pod }) {
  const sorunlu = pod.durum !== "Running";
  return (
    <div style={{ border: `2px solid ${sorunlu ? "#dc2626" : "#cbd5e1"}`, borderRadius: 10, padding: 10 }}>
      <code>{pod.ad}</code> · {pod.durum} · yeniden başlama: {pod.restart} {pod.restart > 3 && "⚠"}
    </div>
  );
}

export default function App() {
  return (
    <Bolum baslik={`Pod'lar (${podlar.length})`}>
      {podlar.map((p) => <PodKarti key={p.ad} pod={p} />)}
    </Bolum>
  );
}
```

</details>

```quiz
Bir bileşen aldığı bir prop'un değerini değiştirmek istiyor. Doğru yaklaşım?
- `props.x = yeniDeger` yazmak
- [x] Props'u değiştirmemek. Değer bileşenin kendisine aitse state'e almak, ebeveyne aitse ebeveynin güncellemesini sağlamak
- `Object.assign(props, ...)` kullanmak
? Props salt okunurdur ve ebeveynin o render'daki anlık görüntüsüdür.
```

```quiz
`<Panel>İçerik</Panel>` yazdığında "İçerik" Panel bileşenine nasıl ulaşır?
- `props.content` olarak
- [x] `props.children` olarak
- Ulaşmaz
? Açılış ve kapanış etiketleri arasındaki her şey children prop'udur.
```

```quiz
Bir bileşeni başka bir bileşenin fonksiyon gövdesi içinde tanımlamanın sorunu nedir?
- Söz dizimi hatasıdır
- [x] Her render'da yeni bir bileşen türü oluşur, alt bileşenin state'i sıfırlanır ve performans düşer
- Hiçbir sorunu yoktur
? Bileşenler modülün en üst seviyesinde tanımlanmalı.
```

## Özet

- Props: bileşenin argümanları, tek bir nesne. Yapı bozma, varsayılan değerler, `{...geriKalan}` ile aktarma.
- Props salt okunurdur. Zamanla değişen ve bileşene ait veri için state.
- `children` ve JSX alan props'lar ile kapsayıcı bileşenler.
- Kompozisyon: Arayüzü tek sorumluluklu bileşenlere böl, veriyi yukarıdan aşağıya akıt.
- Bileşenleri iç içe tanımlama. Her anlamlı bileşen kendi dosyasında, adlı export ile.
