# Sunucu verisi: TanStack Query

Bir uygulamadaki state'in iki türü vardır ve çok farklı sorunları vardır:

| | İstemci state'i | Sunucu state'i |
|---|---|---|
| Örnek | Açık menü, form girdisi, seçili sekme | Kullanıcı listesi, siparişler, ürünler |
| Sahibi | Tarayıcı | **Sunucu**: tarayıcıdaki sadece bir kopya |
| Güncellik | Her zaman güncel | Başka biri değiştirebilir, **eskiyebilir** |
| Sorunlar | — | Önbellek, yükleniyor/hata, yeniden deneme, arka planda yenileme, aynı isteğin tekrarını önleme, değişiklikten sonra geçersizleştirme, sayfalama, iyimser güncelleme |

Effect dersinde ve özel hook dersinde yazdığımız `useVeri`, bu sorunların sadece ilk birkaçını çözüyordu. **TanStack Query** (eski adıyla React Query) sunucu state'ini yönetmek için yazılmış bir kütüphane: bir **önbellek** ve onun etrafında hook'lar.

```bash
npm install @tanstack/react-query
```

Örneklerde, gecikmeli cevap veren ve değişiklikleri bellekte tutan sahte bir API kullanacağız. Böylece önbelleği ve güncellemeleri ağdan bağımsız olarak net görebiliriz.

## İlk sorgu

```react
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query@5";
import { useState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
let istekSayisi = 0;
const api = {
  async servisler() {
    istekSayisi++;
    console.log("SUNUCUYA İSTEK #" + istekSayisi);
    await bekle(800);
    return [{ id: 1, ad: "siparis-api", replika: 3 }, { id: 2, ad: "odeme-api", replika: 2 }];
  },
};

const queryClient = new QueryClient();

function ServisListesi() {
  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: ["servisler"],              // önbellek anahtarı
    queryFn: api.servisler,               // veriyi getiren fonksiyon (Promise döndürür)
  });
  if (isPending) return <p>Yükleniyor…</p>;
  if (isError) return <p>Hata: {error.message}</p>;
  return (
    <div>
      <ul>{data.map((s) => <li key={s.id}>{s.ad} ({s.replika})</li>)}</ul>
      {isFetching && <small>arka planda güncelleniyor…</small>}
    </div>
  );
}

export default function App() {
  const [goster, setGoster] = useState(true);
  return (
    <QueryClientProvider client={queryClient}>
      <button onClick={() => setGoster(!goster)}>{goster ? "Listeyi kaldır" : "Listeyi göster"}</button>
      {goster && <ServisListesi />}
      {goster && <ServisListesi />}
    </QueryClientProvider>
  );
}
```

İzle:

1. İki bileşen aynı veriyi istedi ama **tek bir istek** atıldı: Aynı `queryKey`'li eşzamanlı istekler birleştirilir.
2. Listeyi kaldırıp tekrar göster: Veri **anında** önbellekten geldi, arka planda bir istek daha atıldı ("arka planda güncelleniyor"). Bu, **stale-while-revalidate** modeli: Önce elindekini göster, sonra sessizce tazele.

## Önbellek: staleTime ve gcTime

İki ayar bu davranışı belirler:

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `staleTime` | `0` | Veri ne kadar süre **taze** sayılır. Taze veri için arka planda istek atılmaz |
| `gcTime` | 5 dakika | Hiçbir bileşen kullanmayan veri önbellekte ne kadar tutulur |

`staleTime: 0` olduğu için yukarıda her gösterişte yeniden istek atıldı. Az değişen veriler için:

```js
useQuery({ queryKey: ["servisler"], queryFn: api.servisler, staleTime: 30_000 });   // 30 sn boyunca taze
```

Veri **eski** (stale) olduğunda şu durumlarda otomatik tazelenir: Bileşen yeniden eklendiğinde, pencere tekrar odaklandığında (`refetchOnWindowFocus`), ağ bağlantısı geri geldiğinde. Bunlar, kullanıcının sekmeye döndüğünde güncel veriyi görmesini sağlayan varsayılan davranışlar. Başarısız istekler varsayılan olarak 3 kez, artan aralıklarla yeniden denenir.

## Sorgu anahtarları ve parametreler

`queryKey` bir dizidir ve sorgunun **bütün girdilerini** içermelidir: Anahtar değişince yeni bir sorgu olur ve her anahtarın önbelleği ayrıdır.

```react
import { QueryClient, QueryClientProvider, useQuery, keepPreviousData } from "@tanstack/react-query@5";
import { useState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const tum = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, ad: `servis-${i + 1}`, takim: i % 2 ? "odeme" : "magaza" }));

async function getirSayfa(takim, sayfa) {
  console.log("istek:", takim, "sayfa", sayfa);
  await bekle(600);
  const f = tum.filter((s) => takim === "hepsi" || s.takim === takim);
  return { ogeler: f.slice((sayfa - 1) * 5, sayfa * 5), toplamSayfa: Math.ceil(f.length / 5) };
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });

function Liste() {
  const [takim, setTakim] = useState("hepsi");
  const [sayfa, setSayfa] = useState(1);
  const { data, isPending, isPlaceholderData, isFetching } = useQuery({
    queryKey: ["servisler", { takim, sayfa }],
    queryFn: () => getirSayfa(takim, sayfa),
    placeholderData: keepPreviousData,            // yeni sayfa gelene kadar öncekini göster
  });
  if (isPending) return <p>Yükleniyor…</p>;
  return (
    <div style={{ opacity: isPlaceholderData ? 0.5 : 1 }}>
      <select value={takim} onChange={(e) => { setTakim(e.target.value); setSayfa(1); }}>
        <option>hepsi</option><option>odeme</option><option>magaza</option>
      </select> {isFetching && <small>yükleniyor…</small>}
      <ul>{data.ogeler.map((s) => <li key={s.id}>{s.ad} · {s.takim}</li>)}</ul>
      <button disabled={sayfa === 1} onClick={() => setSayfa(sayfa - 1)}>‹</button>
      <span> {sayfa}/{data.toplamSayfa} </span>
      <button disabled={sayfa >= data.toplamSayfa} onClick={() => setSayfa(sayfa + 1)}>›</button>
    </div>
  );
}

export default function App() {
  return <QueryClientProvider client={queryClient}><Liste /></QueryClientProvider>;
}
```

Sayfalar arasında gidip gel: Bir kez yüklenen sayfalar 60 saniye boyunca istek atmadan anında geliyor (konsolu izle). `keepPreviousData` ile sayfa değişirken liste boşalmıyor, eskisi soluk görünüyor.

Anahtarları hiyerarşik tasarla: `["servisler"]`, `["servisler", { takim, sayfa }]`, `["servisler", id]`, `["servisler", id, "loglar"]`. Böylece geçersizleştirme (aşağıda) bir öneke göre yapılabilir.

## Değişiklikler: useMutation ve geçersizleştirme

Veri değiştiren işlemler (POST, PUT, DELETE) `useMutation` ile yapılır. Değişiklikten sonra ilgili sorguları **geçersiz kılmak**, onların yeniden çekilmesini sağlar:

```react
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from "@tanstack/react-query@5";
import { useState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
let vt = [{ id: 1, metin: "PDB ekle", bitti: false }, { id: 2, metin: "HPA ayarla", bitti: true }];
const api = {
  async liste() { await bekle(400); console.log("GET /gorevler"); return vt.map((g) => ({ ...g })); },
  async ekle(metin) {
    await bekle(800);
    if (metin.toLowerCase().includes("hata")) throw new Error("Sunucu reddetti");
    const yeni = { id: Date.now(), metin, bitti: false }; vt = [...vt, yeni]; return yeni;
  },
  async degistir(id) { await bekle(800); vt = vt.map((g) => (g.id === id ? { ...g, bitti: !g.bitti } : g)); },
};

const queryClient = new QueryClient();

function Gorevler() {
  const qc = useQueryClient();
  const [metin, setMetin] = useState("");
  const { data = [], isFetching } = useQuery({ queryKey: ["gorevler"], queryFn: api.liste });

  const ekle = useMutation({
    mutationFn: api.ekle,
    onSuccess: () => {
      setMetin("");
      qc.invalidateQueries({ queryKey: ["gorevler"] });     // listeyi yeniden çek
    },
  });

  // İyimser güncelleme: sunucuyu beklemeden ekranı değiştir, hata olursa geri al
  const degistir = useMutation({
    mutationFn: api.degistir,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["gorevler"] });
      const onceki = qc.getQueryData(["gorevler"]);
      qc.setQueryData(["gorevler"], (eski) => eski.map((g) => (g.id === id ? { ...g, bitti: !g.bitti } : g)));
      return { onceki };
    },
    onError: (_hata, _id, baglam) => qc.setQueryData(["gorevler"], baglam.onceki),
    onSettled: () => qc.invalidateQueries({ queryKey: ["gorevler"] }),
  });

  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); ekle.mutate(metin); }}>
        <input value={metin} onChange={(e) => setMetin(e.target.value)} placeholder='Görev ("hata" içerirse sunucu reddeder)' style={{ width: 260 }} />
        <button disabled={ekle.isPending || !metin.trim()}>{ekle.isPending ? "Ekleniyor…" : "Ekle"}</button>
      </form>
      {ekle.isError && <p style={{ color: "crimson" }}>{ekle.error.message}</p>}
      <ul>
        {data.map((g) => (
          <li key={g.id}>
            <label style={{ textDecoration: g.bitti ? "line-through" : "none" }}>
              <input type="checkbox" checked={g.bitti} onChange={() => degistir.mutate(g.id)} /> {g.metin}
            </label>
          </li>
        ))}
      </ul>
      {isFetching && <small>senkronize ediliyor…</small>}
    </div>
  );
}

export default function App() {
  return <QueryClientProvider client={queryClient}><Gorevler /></QueryClientProvider>;
}
```

- **Ekleme** sunucunun cevabını bekliyor, sonra `invalidateQueries` ile listeyi tazeliyor. "hata" yazınca hata mesajı çıkıyor ve liste değişmiyor.
- **Onay kutusu iyimser güncelleme** kullanıyor: Tık anında ekran değişiyor (800 ms beklemeden), sunucu hata verirse önceki hâle dönülüyor (`onError`), her durumda sonunda sunucuyla senkronize ediliyor (`onSettled`). Kullanıcı için anında tepki veren arayüzler böyle kurulur. React 19'un `useOptimistic` hook'u da aynı fikrin çerçeveden bağımsız hâli.

## Diğer önemli özellikler

| Özellik | Ne için |
|---|---|
| `useInfiniteQuery` | "Daha fazla yükle" ve sonsuz kaydırma |
| `enabled: false` / `enabled: !!id` | Bağımlı sorgular: önceki veri gelene kadar bekle |
| `select` | Önbellekteki veriden bir parça ya da dönüştürülmüş hâlini seç (bileşen sadece o parça değişince render olur) |
| `qc.prefetchQuery` | Kullanıcı bağlantının üstüne gelince veriyi önceden yükle |
| `useSuspenseQuery` | Yükleniyor durumunu Suspense'e bırak (Suspense dersi) |
| **React Query DevTools** | Önbellekteki her sorguyu, durumunu ve verisini görsel olarak incele |

### React Router loader'larıyla birlikte

Önceki dersteki loader'lar "sayfa açılırken veriyi getir" sorusunu, TanStack Query "veriyi önbellekte tut ve taze tut" sorusunu çözer. Birlikte kullanılabilirler: Loader `queryClient.ensureQueryData(...)` ile veriyi önbelleğe koyar (yoksa getirir), bileşen aynı anahtarla `useQuery` kullanarak önbellekten okur ve arka plan tazelemelerinden yararlanır.

## Sunucu state'i ve istemci state'i ayrı tut

TanStack Query sunucu verisinin **tek kaynağı** olunca, global state kütüphanelerine (Redux, Zustand) kalan iş çok azalır: Genelde birkaç istemci tercihi (tema, kenar çubuğu açık mı, sepet taslağı). Sunucudan gelen veriyi bir de Redux'a kopyalamak, state tasarımı dersindeki "iki kaynak birbirinden kopar" sorununu yeniden yaratır.

## Alıştırma

Derse dahil sahte API'yi kullanarak:

1. `["servis", id]` anahtarlı bir detay sorgusu yaz. Listede bir servise tıklayınca detay panelde görünsün. Aynı servise ikinci kez tıklayınca istek atılmasın (`staleTime`).
2. Detay panelinde "Replika +1" butonu: `useMutation` ile sunucuyu güncellesin, sonra hem detay hem liste sorgusunu geçersizleştirsin.

<details><summary>Bir çözüm</summary>

```react
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from "@tanstack/react-query@5";
import { useState } from "react";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
let vt = { 1: { id: 1, ad: "siparis-api", replika: 3 }, 2: { id: 2, ad: "odeme-api", replika: 2 } };
const api = {
  async liste() { await bekle(400); console.log("GET /servisler"); return Object.values(vt); },
  async detay(id) { await bekle(600); console.log("GET /servisler/" + id); return { ...vt[id] }; },
  async olcekle(id) { await bekle(600); vt[id] = { ...vt[id], replika: vt[id].replika + 1 }; },
};
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });

function Detay({ id }) {
  const qc = useQueryClient();
  const { data, isPending } = useQuery({ queryKey: ["servis", id], queryFn: () => api.detay(id) });
  const olcekle = useMutation({
    mutationFn: () => api.olcekle(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servis", id] });
      qc.invalidateQueries({ queryKey: ["servisler"] });
    },
  });
  if (isPending) return <p>Detay yükleniyor…</p>;
  return <p><b>{data.ad}</b>: {data.replika} replika <button disabled={olcekle.isPending} onClick={() => olcekle.mutate()}>Replika +1</button></p>;
}

function Uygulama() {
  const [secili, setSecili] = useState(null);
  const { data = [] } = useQuery({ queryKey: ["servisler"], queryFn: api.liste });
  return (
    <div>
      {data.map((s) => <button key={s.id} onClick={() => setSecili(s.id)}>{s.ad} ({s.replika})</button>)}
      {secili && <Detay id={secili} />}
    </div>
  );
}

export default function App() { return <QueryClientProvider client={queryClient}><Uygulama /></QueryClientProvider>; }
```

</details>

```quiz
İki farklı bileşen aynı anda `useQuery({ queryKey: ["servisler"], ... })` çağırıyor. Kaç istek atılır?
- İki
- [x] Bir: aynı anahtarlı eşzamanlı sorgular birleştirilir ve önbellek paylaşılır
- Hiç
? Önbellek anahtarı sorgunun kimliğidir.
```

```quiz
Bir görev ekledikten sonra listenin güncel hâlini göstermenin TanStack Query'deki standart yolu?
- Sayfayı yenilemek
- Listeyi bir useEffect ile tekrar çekmek
- [x] Mutation'ın `onSuccess`'inde `invalidateQueries({ queryKey: ["gorevler"] })`
? Geçersizleştirilen sorgular kullanılıyorsa hemen yeniden çekilir.
```

```quiz
`staleTime: 0` (varsayılan) ne anlama gelir?
- Veri hiç önbelleğe alınmaz
- [x] Veri hemen "eski" sayılır: önbellekten gösterilir ama bileşen yeniden eklenince ya da pencere odaklanınca arka planda tazelenir
- Her render'da istek atılır
? Önbellekte tutma süresini gcTime belirler. staleTime sadece tazelik süresidir.
```

## Özet

- Sunucu state'i istemci state'inden farklıdır: önbellek, tazelik, tekrar deneme, geçersizleştirme gerektirir.
- `useQuery({ queryKey, queryFn })`: istek birleştirme, önbellek, stale-while-revalidate, otomatik tazeleme ve tekrar deneme.
- `staleTime` (tazelik) ve `gcTime` (önbellekte tutma). Anahtar sorgunun bütün girdilerini içerir, hiyerarşik tasarla.
- `keepPreviousData` ile kesintisiz sayfalama.
- `useMutation` + `invalidateQueries`. İyimser güncelleme: `onMutate` (anlık değiştir), `onError` (geri al), `onSettled` (senkronize et).
- Sunucu verisini global state kütüphanelerine kopyalama.
