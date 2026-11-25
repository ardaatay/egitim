# Server Components ve Next.js App Router

Şimdiye kadar yazdığın her bileşen **tarayıcıda** çalıştı: Kod indirildi, çalıştırıldı, veri `fetch` ile API'den çekildi. React Server Components (RSC) bu modeli genişletir: Bazı bileşenler **yalnızca sunucuda** çalışır, veritabanına doğrudan erişir ve tarayıcıya JavaScript olarak değil, **render edilmiş sonuç** olarak gider. React ekibinin önerdiği çerçeve kurulumlarının (Next.js App Router, React Router v7 framework modu ile deneysel olarak) temeli budur.

> **Dikkat:** Server Components bir paketleyici ve sunucu entegrasyonu gerektirir, bu sayfadaki oyun alanında çalıştırılamaz. Bu derste örnekleri kendi makinende `npx create-next-app@latest` ile oluşturacağın bir projede dene. Oyun alanı sadece istemci tarafı kavramları göstermek için kullanılıyor.

## İki tür bileşen

| | Server Component (varsayılan) | Client Component (`"use client"`) |
|---|---|---|
| Nerede çalışır | Sadece sunucuda (build ya da istek anında) | Sunucuda ön render + tarayıcıda hydrate |
| JS paketine girer mi | Hayır | Evet |
| `async` olabilir mi | Evet, `await` doğrudan kullanılır | Hayır |
| State, effect, olaylar | Yok (`useState`, `onClick` yok) | Var |
| Gizli bilgiler (DB şifresi, API anahtarı) | Güvenle kullanılır | Asla |
| Tarayıcı API'leri (`window`, `localStorage`) | Yok | Var (effect içinde) |

App Router'da `app/` altındaki her bileşen **varsayılan olarak Server Component**'tir. Etkileşim gereken yerde dosyanın en üstüne `"use client"` yazarsın. Bu yönerge bir **sınır** çizer: O dosya ve onun import ettiği her şey istemci paketine girer.

```tsx
// app/sunucular/page.tsx: Server Component
import { db } from "@/lib/db";
import { YenidenBaslatButonu } from "./YenidenBaslatButonu";

export default async function SunucularSayfasi() {
  const sunucular = await db.query("select id, ad, durum, cpu from sunucular order by ad");
  return (
    <table>
      <tbody>
        {sunucular.map((s) => (
          <tr key={s.id}>
            <td>{s.ad}</td><td>{s.durum}</td><td>%{s.cpu}</td>
            <td><YenidenBaslatButonu id={s.id} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

```tsx
// app/sunucular/YenidenBaslatButonu.tsx: Client Component
"use client";
import { useTransition } from "react";
import { yenidenBaslat } from "./actions";

export function YenidenBaslatButonu({ id }: { id: number }) {
  const [isPending, startTransition] = useTransition();
  return (
    <button disabled={isPending} onClick={() => startTransition(() => yenidenBaslat(id))}>
      {isPending ? "Başlatılıyor…" : "Yeniden başlat"}
    </button>
  );
}
```

Burada `useEffect` yok, yükleniyor state'i yok, API uç noktası yok, `db` modülü tarayıcıya hiç gitmiyor. Tablonun HTML'i sunucuda üretiliyor. Tarayıcıya giden JS sadece küçük butonun kodu.

## Sınırın kuralları

1. **Server → Client props serileştirilebilir olmalı.** String, sayı, dizi, düz nesne, `Date`, Promise, JSX ve Server Action'lar geçer. Sıradan fonksiyonlar, sınıf örnekleri geçmez.
2. **Client Component, Server Component'i import edemez** ama `children` (ya da başka bir JSX prop) olarak alabilir:

```tsx
// Kenar çubuğu açılıp kapanan istemci kabuğu, içi sunucu verisi
<AcilirPanel>          {/* "use client" */}
  <SonDeploylar />     {/* Server Component, async, DB'den okur */}
</AcilirPanel>
```

3. **`"use client"` bir dosyayı işaretler, bileşeni değil.** Sınırı ağacın olabildiğince **aşağısına** (yapraklara) koy. Bütün sayfayı istemci yapmak RSC'nin bütün kazancını siler.
4. Gizli bilgiye dokunan modülleri `import "server-only"` ile işaretle: Yanlışlıkla bir istemci dosyasından import edilirse build hata verir.

## Veri çekme ve akış (streaming)

Server Component'ler `async` olduğu için veri çekme düz bir `await`'tir. Yavaş bir parçanın bütün sayfayı bekletmemesi için bir önceki dersteki Suspense burada da geçerli: Sunucu, hazır olan HTML'i hemen gönderir, yavaş parçalar hazır oldukça aynı yanıtın içinde **akış** olarak gelir.

```tsx
// app/panel/page.tsx
import { Suspense } from "react";

export default function Panel() {
  return (
    <>
      <KumeOzeti />                                       {/* hızlı, hemen gelir */}
      <Suspense fallback={<p>Maliyet raporu hazırlanıyor…</p>}>
        <MaliyetRaporu />                                 {/* 3 sn süren sorgu */}
      </Suspense>
    </>
  );
}

async function MaliyetRaporu() {
  const rapor = await fetch("https://faturalama.internal/rapor", { next: { revalidate: 300 } }).then((r) => r.json());
  return <pre>{JSON.stringify(rapor, null, 2)}</pre>;
}
```

App Router'da dosya kuralları bunu otomatikleştirir: Bir klasördeki `loading.tsx` o rotanın Suspense fallback'i, `error.tsx` (bir `"use client"` bileşeni) hata sınırı, `not-found.tsx` 404 sayfasıdır. `layout.tsx` gezinmeler arasında korunur, yeniden render edilmez.

Bağımsız istekleri **paralel** başlat, sıralı `await` şelalesi kurma:

```tsx
// Kötü: 3 istek art arda (toplam süre = toplam)
const kullanici = await getKullanici(id);
const projeler = await getProjeler(id);
// İyi: aynı anda başlar (toplam süre = en yavaşı)
const [kullanici2, projeler2] = await Promise.all([getKullanici(id), getProjeler(id)]);
```

Bir Server Component bir Promise'i **await etmeden** bir Client Component'e prop olarak verebilir. İstemci tarafı bunu `use(promise)` ile okur ve Suspense ile bekler. Böylece veri sunucuda erken başlar ama etkileşimli arayüz beklemez.

### Önbellekleme

Next.js'te önbellek davranışı sürümler arasında çok değişti, o yüzden kendi sürümünün belgelerine bak. Kavramsal olarak üç katman var:

- **İstek içi tekilleştirme:** Aynı render içinde aynı veriyi isteyen birden çok bileşen için React'in `cache()` fonksiyonu: `const getKullanici = cache(async (id) => db.kullanici(id))`.
- **Veri önbelleği:** `fetch(url, { next: { revalidate: 60 } })` ya da `"use cache"` yönergesi (Next 15+ ile gelen yeni model) sonucu istekler arasında saklar.
- **Tam rota önbelleği:** Dinamik veri kullanmayan sayfalar build anında statik HTML'e dönüşür. `cookies()`, `headers()` ya da `searchParams` kullanmak sayfayı dinamik yapar.

Bir değişiklikten sonra önbelleği tazelemek için `revalidatePath("/sunucular")` ya da `revalidateTag("sunucular")` kullanılır.

## Server Actions: `"use server"`

React 19 dersindeki `<form action={fn}>` burada asıl gücüne kavuşur: Fonksiyon **sunucuda** çalışır, ama istemciden normal bir fonksiyon gibi çağrılır. Arkada React bir POST uç noktası oluşturur.

```ts
// app/sunucular/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { oturum } from "@/lib/auth";

const Sema = z.object({ ad: z.string().min(3).regex(/^[a-z0-9-]+$/), bolge: z.enum(["ist", "fra", "ams"]) });

export async function sunucuEkle(onceki: unknown, formData: FormData) {
  const kullanici = await oturum();
  if (!kullanici?.roller.includes("admin")) return { hata: "Yetkiniz yok" };

  const sonuc = Sema.safeParse(Object.fromEntries(formData));
  if (!sonuc.success) return { hata: sonuc.error.issues[0].message };

  await db.query("insert into sunucular (ad, bolge) values ($1, $2)", [sonuc.data.ad, sonuc.data.bolge]);
  revalidatePath("/sunucular");
  return { hata: null };
}

export async function yenidenBaslat(id: number) {
  const kullanici = await oturum();
  if (!kullanici) throw new Error("Oturum yok");
  await fetch(`https://orkestrator.internal/sunucular/${id}/restart`, { method: "POST" });
  revalidatePath("/sunucular");
}
```

```tsx
// app/sunucular/YeniSunucu.tsx
"use client";
import { useActionState } from "react";
import { sunucuEkle } from "./actions";

export function YeniSunucu() {
  const [durum, eylem, isPending] = useActionState(sunucuEkle, { hata: null });
  return (
    <form action={eylem}>
      <input name="ad" placeholder="web-04" />
      <select name="bolge"><option value="ist">İstanbul</option><option value="fra">Frankfurt</option></select>
      <button disabled={isPending}>Ekle</button>
      {durum.hata && <p role="alert">{durum.hata}</p>}
    </form>
  );
}
```

Bu form JavaScript yüklenmeden önce bile çalışır (progressive enhancement): Tarayıcı düz bir form POST'u yapar, sunucu sonucu render edip döner.

> **Dikkat:** Her Server Action **halka açık bir HTTP uç noktasıdır.** Butonun sadece adminlere gösterilmesi bir güvenlik önlemi değildir: Biri uç noktayı doğrudan çağırabilir. Her action'ın içinde **kimlik doğrulama, yetki kontrolü ve girdi doğrulaması** yap, tıpkı bir REST handler'ında yaptığın gibi. Argümanlara (özellikle `id` gibi değerlere) güvenme, kullanıcının o kaynağa erişimi olup olmadığını kontrol et.

## Ne zaman RSC, ne zaman SPA?

RSC her proje için doğru seçim değil. Kabaca:

- **RSC/Next.js mantıklı:** İçerik ağırlıklı, SEO önemli, ilk yükleme hızı kritik sayfalar (pazarlama sitesi, e-ticaret, blog, dokümantasyon); backend'e yakın, veriyi doğrudan okuyan iç araçlar; Node çalıştırabileceğin bir sunucu ortamın varsa.
- **Vite SPA mantıklı:** Giriş arkasındaki yoğun etkileşimli paneller (SEO yok), zaten ayrı bir API'n (Go, Java, .NET) varsa, statik hosting (nginx, S3, GitHub Pages) yeterliyse, operasyonel basitlik önemliyse. Sonraki derslerde yayınlayacağımız uygulama bu türde.

Operasyon tarafında fark büyük: SPA bir klasör statik dosyadır, nginx'e kopyalarsın. Next.js uygulaması **çalışan bir Node süreci**dir: bellek ve CPU limiti, health check, yatay ölçekleme, log toplama, önbellek paylaşımı (birden fazla replika varsa) gerektirir. Next.js'in `output: "standalone"` ayarı, Docker imajını küçük tutmak için sadece gereken `node_modules`'u kopyalar.

## Alıştırma

Aşağıdaki bileşen ağacında `"use client"` sınırlarını nereye koyardın? Hangi bileşenler sunucuda kalabilir?

```
Sayfa (sipariş detayı)
├── Baslik (sipariş no, tarih)
├── MusteriKarti (DB'den müşteri)
├── UrunListesi (DB'den kalemler)
│   └── AdetSecici (+/- butonları, anlık toplam)
├── NotEkleFormu (metin kutusu, gönder)
└── DurumZamanCizelgesi (DB'den olaylar, "daha fazla göster" butonu)
```

<details><summary>Bir çözüm</summary>

- **Sunucuda kalır:** Sayfa, Baslik, MusteriKarti, UrunListesi, DurumZamanCizelgesi'nin veri okuyan kısmı. Hepsi `async` olabilir ve veriyi doğrudan çeker. Bağımsız oldukları için her biri kendi Suspense sınırında akış olarak gelebilir.
- **`"use client"`:** `AdetSecici` (state ve olaylar). `UrunListesi` sunucuda kalır, her satırda küçük `AdetSecici`'yi render eder. Anlık toplam bu bileşenler arasında paylaşılıyorsa, sadece toplamı ve seçicileri saran küçük bir istemci bileşeni (`SepetDuzenleyici`) yap.
- **`NotEkleFormu`:** Bir Server Action ile düz bir `<form action>` olarak sunucuda bile kalabilir. Bekleme durumu ya da hata mesajı istiyorsan `useActionState` için istemci bileşeni yap. Action içinde kullanıcının bu siparişe erişimi olduğunu kontrol et.
- **`DurumZamanCizelgesi`:** İlk 5 olay sunucuda render edilir, "daha fazla göster" ise küçük bir istemci bileşeni. İlk olayları `children` olarak alabilir ya da kalanları bir Server Action ile çekebilir.

</details>

```quiz
`app/` altında `"use client"` yazmadığın bir bileşende `useState` kullanırsan ne olur?
- Normal çalışır
- [x] Hata alırsın: varsayılan olarak Server Component'tir, state ve effect kullanamaz
- Otomatik istemci bileşenine dönüşür
? `"use client"` sınırı açıkça belirtilmelidir.
```

```quiz
Bir Server Action sadece admin rolüne sahip kullanıcılara gösterilen bir butondan çağrılıyor. Action içinde yetki kontrolü gerekli mi?
- Hayır, buton zaten gizli
- [x] Evet: her Server Action halka açık bir POST uç noktasıdır, doğrudan çağrılabilir
- Sadece üretimde
? Arayüzde gizlemek yetkilendirme değildir.
```

```quiz
Bir Client Component bir Server Component'i nasıl içerebilir?
- `import` ederek
- [x] Server Component'ten `children` ya da başka bir JSX prop'u olarak alarak
- İçerdiği hiçbir şekilde mümkün değil
? İstemci dosyasının import ettiği her şey istemci paketine girer; children olarak verilen JSX ise sunucuda render edilmiş olarak gelir.
```

## Özet

- Server Components: sadece sunucuda çalışır, `async`, JS paketine girmez, gizli bilgilere ve DB'ye güvenle erişir. State ve olaylar yok.
- `"use client"` bir dosya sınırıdır: yapraklara yakın koy. Props serileştirilebilir olmalı, Server Component'ler `children` olarak geçirilir.
- Suspense ile streaming; `loading.tsx` ve `error.tsx` rota seviyesinde. Bağımsız istekleri `Promise.all` ile paralel başlat.
- `"use server"`: Server Actions formlardan ve istemciden çağrılır. Her biri halka açık bir uç noktadır: kimlik, yetki, doğrulama.
- Next.js çalışan bir Node servisidir (operasyon maliyeti). İç paneller ve ayrı API'ler için Vite SPA çoğu zaman daha basit.
