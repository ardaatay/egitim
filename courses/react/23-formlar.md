# Formlar ve doğrulama: React Hook Form ve Zod

Formlar, arayüz geliştirmenin en çok emek isteyen kısmıdır: her alan için değer, dokunuldu mu, hata mesajı, gönderiliyor durumu, sunucu hataları, dinamik alanlar, erişilebilirlik. State dersindeki kontrollü girdilerle her şeyi elle yazmak mümkün ama büyük formlarda hem kod hem performans sorun olur (her tuşta bütün form render olur). Bu derste önce kontrollü ve kontrolsüz girdi farkını, sonra yaygın ikiliyi göreceğiz: **React Hook Form** (form state'i) ve **Zod** (şema ile doğrulama ve tipler).

```bash
npm install react-hook-form zod @hookform/resolvers
```

## Kontrollü ve kontrolsüz girdiler

| | Kontrollü | Kontrolsüz |
|---|---|---|
| Değerin kaynağı | React state (`value` + `onChange`) | DOM'un kendisi (`defaultValue`, gerektiğinde ref ile okunur) |
| Her tuşta render | Evet | Hayır |
| Anlık doğrulama, biçimlendirme, bağımlı alanlar | Kolay | Zor (elle) |
| Kullanım | Az sayıda alan, anlık tepki gereken alanlar | Büyük formlar, sadece gönderimde okunan değerler |

React Hook Form ikisinin en iyi yanlarını birleştirir: Alanlar varsayılan olarak **kontrolsüzdür** (ref ile kaydedilir, tuş başına render yok), ama form state'i (hatalar, dokunulmuş alanlar, gönderim durumu) bir hook üzerinden **izlenebilir**.

## Zod ile şema

Önce formun beklediği veriyi bir **şema** olarak tanımla. Zod şeması hem çalışma zamanında doğrulama yapar hem de TypeScript tipini üretir:

```react
import { z } from "zod@3";

const DeploySema = z.object({
  servis: z.string().min(1, "Servis seçilmeli"),
  surum: z.string().regex(/^(sha-[0-9a-f]{7}|\d+\.\d+\.\d+)$/, "sha-xxxxxxx ya da 1.2.3 biçiminde olmalı"),
  replika: z.coerce.number().int().min(1, "En az 1").max(20, "En fazla 20"),
  ortam: z.enum(["staging", "uretim"]),
  aciklama: z.string().max(200).optional(),
});

const ornekler = [
  { servis: "api", surum: "1.4.2", replika: "3", ortam: "staging" },
  { servis: "", surum: "son", replika: "0", ortam: "test" },
];

export default function App() {
  return (
    <div>
      {ornekler.map((o, i) => {
        const sonuc = DeploySema.safeParse(o);
        return (
          <pre key={i} style={{ background: sonuc.success ? "#dcfce7" : "#fee2e2", color: "#0f172a", padding: 8, fontSize: 12 }}>
            {sonuc.success
              ? "GEÇERLİ: " + JSON.stringify(sonuc.data)
              : "HATALAR:\n" + sonuc.error.issues.map((h) => `- ${h.path.join(".")}: ${h.message}`).join("\n")}
          </pre>
        );
      })}
    </div>
  );
}
```

- `safeParse` istisna fırlatmadan `{ success, data | error }` döndürür. `parse` hatada istisna fırlatır.
- `z.coerce.number()`: Formdan metin olarak gelen `"3"`'ü sayıya çevirir.
- Aynı şema sunucuda da (Node API'si) kullanılabilir: **İstemci doğrulaması kullanıcı deneyimi içindir, güvenlik için değil.** Sunucu her girdiyi kendisi doğrulamalıdır (Linux kursundaki deploy betiğinin argüman doğrulaması gibi).
- TypeScript'te `type Deploy = z.infer<typeof DeploySema>` ile tip elde edilir: Şema ve tip asla birbirinden kopmaz.

> Zod 4 sürümü yayınlandı ve hız, hata mesajları gibi konularda iyileştirmeler getirdi. Temel API (`z.object`, `z.string().min()`, `safeParse`) aynı. Bu derste yaygınlığı nedeniyle 3.x kullanıyoruz.

## React Hook Form

```react
import { useForm } from "react-hook-form@7";
import { z } from "zod@3";
import { zodResolver } from "@hookform/resolvers@3/zod";

const Sema = z.object({
  servis: z.string().min(1, "Servis seçilmeli"),
  surum: z.string().regex(/^(sha-[0-9a-f]{7}|\d+\.\d+\.\d+)$/, "sha-xxxxxxx ya da 1.2.3 biçiminde olmalı"),
  replika: z.coerce.number().int().min(1, "En az 1").max(20, "En fazla 20"),
  ortam: z.enum(["staging", "uretim"]),
  onay: z.boolean(),
}).refine((v) => v.ortam !== "uretim" || v.onay, { message: "Üretim için onay gerekli", path: ["onay"] });

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
let renderSayisi = 0;

function Alan({ etiket, hata, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{etiket}</label>
      {children}
      {hata && <div role="alert" style={{ color: "crimson", fontSize: 13 }}>{hata.message}</div>}
    </div>
  );
}

export default function App() {
  const { register, handleSubmit, watch, reset, formState: { errors, isSubmitting, isSubmitSuccessful } } = useForm({
    resolver: zodResolver(Sema),
    defaultValues: { servis: "", surum: "", replika: 2, ortam: "staging", onay: false },
    mode: "onTouched",                  // alandan çıkınca doğrula, sonra her değişiklikte
  });
  const ortam = watch("ortam");         // sadece bu alanı izle (koşullu alan için)
  renderSayisi++;

  async function gonder(veri) {
    await bekle(1000);
    console.log("sunucuya gönderildi:", veri);
    reset();
  }

  return (
    <form onSubmit={handleSubmit(gonder)} noValidate>
      <p><small>Form {renderSayisi} kez render oldu (her tuşta değil!)</small></p>
      <Alan etiket="Servis" hata={errors.servis}>
        <select {...register("servis")}>
          <option value="">Seç…</option><option value="api">siparis-api</option><option value="odeme">odeme-api</option>
        </select>
      </Alan>
      <Alan etiket="Sürüm" hata={errors.surum}>
        <input {...register("surum")} placeholder="sha-4f9c2e1" aria-invalid={!!errors.surum} />
      </Alan>
      <Alan etiket="Replika" hata={errors.replika}>
        <input type="number" {...register("replika")} style={{ width: 70 }} />
      </Alan>
      <Alan etiket="Ortam" hata={errors.ortam}>
        <label><input type="radio" value="staging" {...register("ortam")} /> staging</label>{" "}
        <label><input type="radio" value="uretim" {...register("ortam")} /> üretim</label>
      </Alan>
      {ortam === "uretim" && (
        <Alan hata={errors.onay}>
          <label><input type="checkbox" {...register("onay")} /> Üretime deploy ettiğimin farkındayım</label>
        </Alan>
      )}
      <button disabled={isSubmitting}>{isSubmitting ? "Gönderiliyor…" : "Deploy et"}</button>
      {isSubmitSuccessful && <p>✅ Gönderildi (konsola bak)</p>}
    </form>
  );
}
```

Hızlıca yazarken render sayısının artmadığına dikkat et: Alanlar kontrolsüz. Sadece doğrulama sonucu değiştiğinde ya da `watch` ile izlenen alan değiştiğinde render oluyor.

| API | Görevi |
|---|---|
| `register("ad")` | Alanı forma kaydeder. `name`, `ref`, `onChange`, `onBlur` döndürür, `{...}` ile yayılır |
| `handleSubmit(fn)` | Doğrulama başarılıysa `fn(veri)`'yi çağırır, değilse hataları doldurur ve ilk hatalı alana odaklanır |
| `formState` | `errors`, `isSubmitting`, `isDirty`, `isValid`, `touchedFields`, `isSubmitSuccessful` |
| `watch("ad")` | Bir alanın değerini izle (sadece o değişince render) |
| `reset(degerler?)` | Formu sıfırla ya da yeni değerlerle doldur (düzenleme formları için sunucudan gelen veriyle) |
| `setError("ad", { message })` | Elle hata koy: **sunucu tarafı doğrulama hataları** için |
| `mode` | Ne zaman doğrulanacağı: `onSubmit` (varsayılan), `onTouched`, `onBlur`, `onChange` |

- **Çapraz alan kuralı** (`refine`): "Üretimse onay zorunlu" kuralı şemada, hata `onay` alanına bağlandı.
- `noValidate`: Tarayıcının kendi doğrulama balonlarını kapatır, mesajlar tutarlı olur.
- Erişilebilirlik: Hata mesajlarında `role="alert"`, alanlarda `aria-invalid`. Ekran okuyucular hatayı duyurur.

## Sunucu hataları

Bazı hatalar sadece sunucuda anlaşılır ("bu sürüm registry'de yok", "bu ad zaten kullanılıyor"):

```react
import { useForm } from "react-hook-form@7";

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
async function sunucuyaKaydet({ ad }) {
  await bekle(700);
  if (["api", "odeme", "katalog"].includes(ad.trim().toLowerCase())) {
    const e = new Error("dogrulama"); e.alanlar = { ad: "Bu servis adı zaten var" }; throw e;
  }
  if (ad.includes("!")) throw new Error("Sunucu hatası (500)");
  return { id: Date.now(), ad };
}

export default function App() {
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm({ defaultValues: { ad: "" } });
  async function gonder(veri) {
    try {
      const sonuc = await sunucuyaKaydet(veri);
      console.log("oluşturuldu:", sonuc);
    } catch (e) {
      if (e.alanlar) Object.entries(e.alanlar).forEach(([alan, mesaj]) => setError(alan, { message: mesaj }));
      else setError("root.sunucu", { message: e.message });
    }
  }
  return (
    <form onSubmit={handleSubmit(gonder)}>
      <input {...register("ad", { required: "Ad gerekli" })} placeholder='Servis adı ("api" var, "!" 500 verir)' style={{ width: 280 }} />
      <button disabled={isSubmitting}>Oluştur</button>
      {errors.ad && <p style={{ color: "crimson" }}>{errors.ad.message}</p>}
      {errors.root?.sunucu && <p style={{ color: "crimson" }}>⚠ {errors.root.sunucu.message}</p>}
    </form>
  );
}
```

Alana özgü hatalar alanın altında, genel hatalar (`root.*`) formun üstünde. Bu örnekte Zod yerine `register`'ın yerleşik kurallarını (`required`, `minLength`, `pattern`, `validate`) kullandık: Küçük formlar için yeterli.

## Dinamik alanlar

Kullanıcının satır ekleyip sildiği listeler (ortam değişkenleri, etiketler, sipariş kalemleri) için `useFieldArray`:

```react
import { useForm, useFieldArray } from "react-hook-form@7";

export default function App() {
  const { register, control, handleSubmit } = useForm({
    defaultValues: { degiskenler: [{ ad: "LOG_LEVEL", deger: "info" }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "degiskenler" });
  return (
    <form onSubmit={handleSubmit((v) => console.log(JSON.stringify(v.degiskenler)))}>
      {fields.map((f, i) => (
        <div key={f.id} style={{ marginBottom: 4 }}>
          <input {...register(`degiskenler.${i}.ad`, { required: true })} placeholder="AD" style={{ width: 120 }} />
          {" = "}
          <input {...register(`degiskenler.${i}.deger`)} placeholder="değer" style={{ width: 140 }} />
          <button type="button" onClick={() => remove(i)}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => append({ ad: "", deger: "" })}>+ Değişken</button>{" "}
      <button>Kaydet</button>
    </form>
  );
}
```

`key={f.id}`: `useFieldArray`'in ürettiği kalıcı kimlik. `key={i}` kullanırsan satır silindiğinde değerler yanlış satırlarda kalır (state dersindeki key tuzağı).

## Dış kontrollü bileşenler

Tarih seçici, zengin metin editörü ya da bir UI kütüphanesinin `<Select>`'i gibi `ref` kabul etmeyen kontrollü bileşenler için `Controller` (ya da `useController`) kullanılır: Bileşene `value` ve `onChange` verir, form state'ine bağlar.

## React 19 form Action'ları

React 19, `<form action={fonksiyon}>` ve `useActionState` ile çerçeveden bağımsız, sunucu fonksiyonlarıyla da çalışan bir form modeli getirdi (bir sonraki bölüm). Yaklaşımlar birbirini dışlamaz: Basit formlar için React'in kendisi yeterli, karmaşık istemci tarafı doğrulama ve dinamik alanlar için React Hook Form.

## Alıştırma

Bir "kullanıcı davet et" formu yaz:

1. Alanlar: e-posta (geçerli e-posta), rol (`gelistirici`, `izleyici`, `yonetici`), takımlar (en az bir takım seçili, çoklu onay kutusu).
2. Rol `yonetici` ise "Gerekçe" alanı görünsün ve en az 20 karakter olsun.
3. Gönderimde sahte bir API'ye gönder. E-posta `@ornek.com` ile bitmiyorsa sunucu "Sadece şirket e-postası" hatasını e-posta alanına döndürsün.

<details><summary>Bir çözüm</summary>

```react
import { useForm } from "react-hook-form@7";
import { z } from "zod@3";
import { zodResolver } from "@hookform/resolvers@3/zod";

const Sema = z.object({
  eposta: z.string().email("Geçerli bir e-posta gir"),
  rol: z.enum(["gelistirici", "izleyici", "yonetici"]),
  takimlar: z.array(z.string()).min(1, "En az bir takım seç"),
  gerekce: z.string().optional(),
}).refine((v) => v.rol !== "yonetici" || (v.gerekce ?? "").trim().length >= 20, { message: "Yönetici için en az 20 karakter gerekçe", path: ["gerekce"] });

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const { register, handleSubmit, watch, setError, formState: { errors, isSubmitting, isSubmitSuccessful } } = useForm({
    resolver: zodResolver(Sema), defaultValues: { eposta: "", rol: "gelistirici", takimlar: [], gerekce: "" },
  });
  const rol = watch("rol");
  async function gonder(v) {
    await bekle(600);
    if (!v.eposta.endsWith("@ornek.com")) { setError("eposta", { message: "Sadece şirket e-postası (@ornek.com)" }); return; }
    console.log("davet gönderildi:", v);
  }
  const hata = (h) => h && <div style={{ color: "crimson", fontSize: 13 }}>{h.message}</div>;
  return (
    <form onSubmit={handleSubmit(gonder)} noValidate>
      <input {...register("eposta")} placeholder="ad@ornek.com" />{hata(errors.eposta)}
      <select {...register("rol")}><option value="gelistirici">geliştirici</option><option value="izleyici">izleyici</option><option value="yonetici">yönetici</option></select>
      <div>{["odeme", "magaza", "platform"].map((t) => <label key={t} style={{ marginRight: 8 }}><input type="checkbox" value={t} {...register("takimlar")} /> {t}</label>)}</div>
      {hata(errors.takimlar)}
      {rol === "yonetici" && <><textarea {...register("gerekce")} placeholder="Neden yönetici?" rows={2} style={{ width: "100%" }} />{hata(errors.gerekce)}</>}
      <button disabled={isSubmitting}>{isSubmitting ? "Gönderiliyor…" : "Davet et"}</button>
      {isSubmitSuccessful && !errors.eposta && <p>✅ Davet gönderildi</p>}
    </form>
  );
}
```

Aynı `name`'e sahip birden fazla onay kutusu, React Hook Form'da seçili değerlerin dizisini üretir.

</details>

```quiz
React Hook Form'un büyük formlarda kontrollü girdilere göre performans avantajı nereden gelir?
- Sanal DOM kullanmaz
- [x] Alanlar varsayılan olarak kontrolsüzdür: değerler DOM'da tutulur, her tuşta bütün form render olmaz
- Web Worker'da çalışır
? Sadece izlenen değerler ve doğrulama sonuçları render tetikler.
```

```quiz
İstemcide Zod ile doğrulama yaptın. Sunucuda tekrar doğrulamak gerekir mi?
- Hayır, istemci doğrulaması yeterli
- [x] Evet: istemci doğrulaması kullanıcı deneyimi içindir, istekler istemci atlanarak doğrudan gönderilebilir
- Sadece üretimde
? Aynı Zod şeması sunucuda da kullanılabilir.
```

```quiz
"Bu ad zaten kullanılıyor" gibi sunucudan dönen bir hatayı ilgili alanın altında göstermek için?
- Sayfayı yeniden yüklemek
- [x] `setError("ad", { message })`
- Şemaya sabit bir kural eklemek
? Genel (alana bağlı olmayan) hatalar için `root.*` anahtarları kullanılır.
```

## Özet

- Kontrollü (state'te) ve kontrolsüz (DOM'da) girdiler. Büyük formlarda kontrolsüz + izleme performanslı.
- Zod: şema = doğrulama + tip (`z.infer`). `safeParse`, `coerce`, `refine` ile çapraz alan kuralları. Sunucuda da doğrula.
- React Hook Form: `register`, `handleSubmit`, `formState`, `watch`, `reset`, `setError` (sunucu hataları), `useFieldArray` (dinamik satırlar, `key={f.id}`), `Controller` (dış bileşenler).
- Erişilebilirlik: `role="alert"`, `aria-invalid`, `noValidate` ile tutarlı mesajlar.
