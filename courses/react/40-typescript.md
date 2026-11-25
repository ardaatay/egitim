# React ile TypeScript

Gerçek projelerde React neredeyse her zaman TypeScript ile yazılır. Bunun sebebi "tip güvenliği" sloganı değil, **değişiklik yapmanın maliyeti**: Bir prop'un adını değiştirdiğinde, bir API yanıtına alan eklendiğinde ya da bir state'in şekli değiştiğinde derleyici seni etkilenen her yere götürür. Bu ders React'e özgü kalıplara odaklanır; TypeScript'in temellerini (tipler, arayüzler, generic'ler, union'lar) bildiğini varsayar.

> **Dikkat:** Oyun alanı TypeScript sözdizimini kabul eder ama tipleri **kontrol etmez** (Babel sadece tipleri siler). Tip hatalarını görmek için kendi projende `npx tsc --noEmit` ya da editörünü kullan. Vite de geliştirme sırasında tip kontrolü yapmaz, bu yüzden CI'da `tsc --noEmit` adımı şarttır.

## Kurulum

```bash
npm create vite@latest panel -- --template react-ts
cd panel && npm install
npx tsc --noEmit          # tip kontrolü
```

`tsconfig.json`'da en önemli ayarlar: `"strict": true` (kapatma), `"noUncheckedIndexedAccess": true` (`dizi[i]` tipini `T | undefined` yapar, sık rastlanan bir hata sınıfını yakalar), `"jsx": "react-jsx"`.

## Props tipleri

```tsx
type Durum = "calisiyor" | "durdu" | "hata";

type SunucuKartiProps = {
  ad: string;
  durum: Durum;
  cpu?: number;                              // isteğe bağlı
  etiketler: readonly string[];
  onYenidenBaslat: (ad: string) => void;
  children?: React.ReactNode;                // JSX, string, sayı, null, dizi...
};

function SunucuKarti({ ad, durum, cpu = 0, etiketler, onYenidenBaslat, children }: SunucuKartiProps) {
  return (
    <section>
      <h3>{ad} <small>{durum}</small></h3>
      <p>CPU %{cpu}</p>
      <p>{etiketler.join(", ")}</p>
      {durum === "hata" && <button onClick={() => onYenidenBaslat(ad)}>Yeniden başlat</button>}
      {children}
    </section>
  );
}
```

`React.FC` kullanma: Eskiden `children`'ı otomatik eklediği için önerilirdi, artık eklemiyor ve generic bileşenlerle iyi çalışmıyor. Fonksiyon parametresini tiplemek yeterli.

`string` yerine **literal union** (`"calisiyor" | "durdu" | "hata"`) kullanmak, React'te TypeScript'in en değerli kullanımlarından biridir: Yanlış yazılmış bir durum derleme hatası olur, `switch` ile tüm durumları kapsayıp kapsamadığını derleyici kontrol eder.

### Yerel bir HTML elemanını sarmak

Kendi `Buton` bileşenin, yerel `<button>`'ın bütün özelliklerini (`type`, `disabled`, `aria-*`, `onClick`) kabul etmeli:

```tsx
type ButonProps = React.ComponentProps<"button"> & {
  varyant?: "birincil" | "tehlike";
};

function Buton({ varyant = "birincil", className, ...rest }: ButonProps) {
  return <button className={`btn btn-${varyant} ${className ?? ""}`} {...rest} />;
}

// <Buton type="submit" disabled={isPending} aria-label="Kaydet" onClick={...} />
```

React 19'da `ref` artık sıradan bir prop'tur, `forwardRef`'e gerek yok: `ComponentProps<"button">` zaten `ref`'i içerir.

## State, ref ve olaylar

```tsx
const [sayac, setSayac] = useState(0);                         // number: çıkarım yeterli
const [kullanici, setKullanici] = useState<Kullanici | null>(null);   // başlangıç null: tip belirt
const [secili, setSecili] = useState<Set<string>>(() => new Set());

const inputRef = useRef<HTMLInputElement>(null);               // DOM ref'i
const zamanlayici = useRef<number | undefined>(undefined);     // değişken kutusu

function degisti(e: React.ChangeEvent<HTMLInputElement>) { setAd(e.target.value); }
function gonderildi(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); }
function tuslandi(e: React.KeyboardEvent) { if (e.key === "Escape") kapat(); }
```

Olay tipini hatırlamak zorunda değilsin: İşleyiciyi önce satır içinde yaz (`onChange={(e) => ...}`), editörde `e`'nin üzerine gel, gösterilen tipi kopyala.

## Ayrımlı union'larla state modellemek

State tasarımı dersindeki "imkânsız durumları imkânsız kıl" ilkesinin TypeScript karşılığı budur. Birbirinden bağımsız `yukleniyor`, `hata`, `veri` alanları yerine:

```react
type Istek<T> =
  | { durum: "bos" }
  | { durum: "yukleniyor" }
  | { durum: "hata"; hata: string }
  | { durum: "basarili"; veri: T };

type Deploy = { id: number; surum: string; ortam: "staging" | "production" };

import { useState } from "react";

function DeployListesi({ istek }: { istek: Istek<Deploy[]> }) {
  switch (istek.durum) {
    case "bos": return <p>Henüz sorgu yapılmadı.</p>;
    case "yukleniyor": return <p>Yükleniyor…</p>;
    case "hata": return <p style={{ color: "#dc2626" }}>{istek.hata}</p>;          // burada `hata` var
    case "basarili": return <ul>{istek.veri.map((d) => <li key={d.id}>{d.surum} → {d.ortam}</li>)}</ul>;  // burada `veri` var
    default: { const _kontrol: never = istek; return _kontrol; }                     // yeni durum eklenirse derleme hatası
  }
}

export default function App() {
  const [istek, setIstek] = useState<Istek<Deploy[]>>({ durum: "bos" });
  async function yukle(basarili: boolean) {
    setIstek({ durum: "yukleniyor" });
    await new Promise((r) => setTimeout(r, 600));
    setIstek(basarili
      ? { durum: "basarili", veri: [{ id: 1, surum: "v2.4.0", ortam: "staging" }, { id: 2, surum: "v2.3.1", ortam: "production" }] }
      : { durum: "hata", hata: "API 502 döndü" });
  }
  return (
    <div>
      <button onClick={() => yukle(true)}>Başarılı yükle</button>{" "}
      <button onClick={() => yukle(false)}>Hatalı yükle</button>
      <DeployListesi istek={istek} />
    </div>
  );
}
```

`istek.durum === "hata"` dalında TypeScript `istek.hata`'nın var olduğunu bilir, `istek.veri`'ye erişmeye çalışırsan hata verir. `never` kontrolü, union'a yeni bir durum eklediğinde bunu işlemeyi unuttuğun her `switch`'i derleme hatasına çevirir.

Aynı kalıp reducer action'ları için de geçerli:

```tsx
type Eylem =
  | { tip: "ekle"; metin: string }
  | { tip: "sil"; id: number }
  | { tip: "temizle" };

function reducer(state: Gorev[], eylem: Eylem): Gorev[] {
  switch (eylem.tip) {
    case "ekle": return [...state, { id: Date.now(), metin: eylem.metin, bitti: false }];
    case "sil": return state.filter((g) => g.id !== eylem.id);
    case "temizle": return [];
  }
}
// dispatch({ tip: "sil", metin: "x" })  → hata: 'sil' eylemi id ister
```

## Generic bileşenler

Bir tablo ya da seçim listesi, içindeki öğenin tipini bilmeden yazılmalı ama kullanıldığı yerde tipi korumalı:

```react
import { useState } from "react";

type Kolon<T> = { baslik: string; hucre: (satir: T) => React.ReactNode };

function Tablo<T extends { id: string | number }>({ satirlar, kolonlar, onSec }: {
  satirlar: T[];
  kolonlar: Kolon<T>[];
  onSec?: (satir: T) => void;
}) {
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <thead><tr>{kolonlar.map((k) => <th key={k.baslik} style={{ textAlign: "left", padding: 4 }}>{k.baslik}</th>)}</tr></thead>
      <tbody>
        {satirlar.map((s) => (
          <tr key={s.id} onClick={() => onSec?.(s)} style={{ cursor: "pointer" }}>
            {kolonlar.map((k) => <td key={k.baslik} style={{ padding: 4 }}>{k.hucre(s)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Pod = { id: string; ad: string; yeniden: number; hazir: boolean };
const podlar: Pod[] = [
  { id: "a", ad: "api-7d9f-x2", yeniden: 0, hazir: true },
  { id: "b", ad: "api-7d9f-k8", yeniden: 5, hazir: false },
];

export default function App() {
  const [secili, setSecili] = useState<Pod | null>(null);
  return (
    <div>
      <Tablo
        satirlar={podlar}
        kolonlar={[
          { baslik: "Pod", hucre: (p) => p.ad },                    // p: Pod, otomatik
          { baslik: "Restart", hucre: (p) => p.yeniden },
          { baslik: "Hazır", hucre: (p) => (p.hazir ? "✔" : "✖") },
        ]}
        onSec={setSecili}
      />
      <p>Seçili: {secili?.ad ?? "yok"}</p>
    </div>
  );
}
```

`hucre: (p) => p.ad` yazarken `p`'nin `Pod` olduğunu TypeScript `satirlar`'dan çıkarır, `p.adı` yazarsan hata verir.

## Context ve özel hook'lar

```tsx
type Oturum = { kullanici: { ad: string; roller: string[] }; cikis: () => void };
const OturumContext = createContext<Oturum | null>(null);

export function useOturum() {
  const deger = useContext(OturumContext);
  if (!deger) throw new Error("useOturum, <OturumSaglayici> içinde kullanılmalı");
  return deger;                     // tipi Oturum: çağıran null kontrolü yapmaz
}
```

Özel bir hook tuple döndürüyorsa `as const` ekle, yoksa TypeScript bunu karışık bir dizi olarak çıkarır:

```tsx
function useAcKapa(baslangic = false) {
  const [acik, setAcik] = useState(baslangic);
  const degistir = useCallback(() => setAcik((a) => !a), []);
  return [acik, degistir] as const;          // readonly [boolean, () => void]
}
```

## API sınırında tip güvenliği

TypeScript tipleri derleme anında **silinir**: `fetch(...).then(r => r.json() as Promise<Deploy[]>)` bir **yalandır**, sunucu başka bir şey dönerse hiçbir şey seni uyarmaz ve hata çok uzaktaki bir bileşende ortaya çıkar. Dış dünyadan gelen veriyi (API yanıtları, `localStorage`, URL parametreleri) **çalışma anında** doğrula. Formlar dersindeki Zod burada da işe yarar, şema hem doğrulayıcı hem tip kaynağıdır:

```react
import { z } from "zod";

const DeploySema = z.object({
  id: z.number(),
  surum: z.string().regex(/^v\d+\.\d+\.\d+$/),
  ortam: z.enum(["staging", "production"]),
  tarih: z.coerce.date(),                     // ISO string → Date
});
type Deploy = z.infer<typeof DeploySema>;     // tipi elle yazmaya gerek yok

const yanitlar = [
  [{ id: 1, surum: "v2.4.0", ortam: "staging", tarih: "2026-11-20T10:00:00Z" }],
  [{ id: 2, surum: "2.4", ortam: "prod", tarih: "dün" }],
];

export default function App() {
  return (
    <div>
      {yanitlar.map((y, i) => {
        const sonuc = z.array(DeploySema).safeParse(y);
        return (
          <pre key={i} style={{ whiteSpace: "pre-wrap" }}>
            {sonuc.success
              ? `geçerli: ${sonuc.data[0].surum} @ ${sonuc.data[0].tarih.toLocaleDateString("tr-TR")}`
              : "geçersiz:\n" + sonuc.error.issues.map((h) => `  ${h.path.join(".")}: ${h.message}`).join("\n")}
          </pre>
        );
      })}
    </div>
  );
}
```

Büyük projelerde tipler elle yazılmaz: Backend bir OpenAPI şeması yayınlıyorsa `openapi-typescript` ya da `orval` ile istemci ve tipler üretilir; GraphQL için `graphql-codegen`. Böylece backend bir alanı değiştirdiğinde frontend'in derlemesi kırılır, üretimdeki kullanıcının ekranı değil.

## Alıştırma

Bir `Secici` bileşeni yaz: `secenekler: T[]`, `etiket: (s: T) => string`, `deger: T | null`, `onChange: (s: T) => void` alsın. Sunucu listesiyle (`{ id, ad, bolge }`) kullan ve seçilen sunucunun bölgesini göster.

<details><summary>Bir çözüm</summary>

```react
import { useState } from "react";

function Secici<T extends { id: string | number }>({ secenekler, etiket, deger, onChange }: {
  secenekler: T[];
  etiket: (s: T) => string;
  deger: T | null;
  onChange: (s: T) => void;
}) {
  return (
    <select
      value={deger?.id ?? ""}
      onChange={(e) => {
        const s = secenekler.find((x) => String(x.id) === e.target.value);
        if (s) onChange(s);
      }}
    >
      <option value="" disabled>Seç…</option>
      {secenekler.map((s) => <option key={s.id} value={s.id}>{etiket(s)}</option>)}
    </select>
  );
}

type Sunucu = { id: number; ad: string; bolge: "ist" | "fra" };
const sunucular: Sunucu[] = [{ id: 1, ad: "web-01", bolge: "ist" }, { id: 2, ad: "db-01", bolge: "fra" }];

export default function App() {
  const [secili, setSecili] = useState<Sunucu | null>(null);
  return (
    <div>
      <Secici secenekler={sunucular} etiket={(s) => s.ad} deger={secili} onChange={setSecili} />
      <p>Bölge: {secili?.bolge ?? "-"}</p>
    </div>
  );
}
```

`<select>`'in değeri her zaman string'dir, bu yüzden `find` ile `String(x.id)` karşılaştırması yapılıyor. `onChange={setSecili}` doğrudan çalışıyor çünkü tipler (`(s: Sunucu) => void`) uyuşuyor.

</details>

```quiz
`fetch(url).then(r => r.json() as Promise<Kullanici>)` neden tehlikelidir?
- Yavaştır
- [x] `as` çalışma anında hiçbir şey doğrulamaz: yanlış şekilli veri sessizce içeri girer
- TypeScript buna izin vermez
? Dış veriyi Zod gibi bir şema ile çalışma anında doğrula, tipi şemadan çıkar.
```

```quiz
State'i `{ yukleniyor: boolean; hata?: string; veri?: T }` yerine ayrımlı union olarak modellemenin faydası?
- Daha az kod
- [x] İmkânsız durumlar (hem yükleniyor hem hata) temsil edilemez, her dalda doğru alanlar garanti edilir
- Daha hızlı render
? `never` kontrolüyle yeni bir durum eklendiğinde işlenmeyen yerler derleme hatası olur.
```

```quiz
Vite geliştirme sunucusu tip hatası olan kodu çalıştırır mı?
- Hayır, derleme durur
- [x] Evet: Vite tipleri sadece siler, kontrol için `tsc --noEmit` (CI'da) gerekir
- Sadece üretim build'inde durur
? Editör ve CI'daki tsc adımı tip kontrolünün asıl yeridir.
```

## Özet

- `strict` açık, `noUncheckedIndexedAccess` önerilir. Vite tip kontrolü yapmaz, CI'da `tsc --noEmit`.
- Props'u düz tiple, `React.FC` gerekmez. Yerel eleman sarmak için `ComponentProps<"button">`. React 19'da `ref` sıradan bir prop.
- `useState<T | null>(null)`, `useRef<HTMLInputElement>(null)`, olay tiplerini editörden öğren.
- Ayrımlı union + `never` kontrolü: istek durumları ve reducer action'ları için.
- Generic bileşenler (`Tablo<T>`) tipi kullanım yerinde korur.
- Dış veri sınırında çalışma anı doğrulaması (Zod), tipler şemadan (`z.infer`) ya da OpenAPI'den üretilir.
