# Test: Vitest, Testing Library ve Playwright

Bir React uygulamasında test yazmanın amacı kapsama yüzdesi değil, **deploy ederken korkmamak**: Bağımlılıkları güncellediğinde, bir bileşeni yeniden yazdığında ya da React sürümünü yükselttiğinde kullanıcının gerçekten kullandığı akışların hâlâ çalıştığını bilmek. Bu ders üç katmanı ele alır: saf mantık için birim testleri, bileşenler için Testing Library, gerçek tarayıcıda uçtan uca akışlar için Playwright.

## Ne test edilir: kupa, piramit değil

Klasik "test piramidi" (çok birim, az uçtan uca) arayüz kodu için pek uymaz. Frontend için daha kullanışlı model **test kupası**dır:

- **Statik analiz** (TypeScript, ESLint): en ucuz katman, yazım ve tip hatalarını bedavaya yakalar.
- **Birim testleri:** saf fonksiyonlar, reducer'lar, formatlayıcılar, doğrulama şemaları. Hızlı ve kesin.
- **Entegrasyon testleri (en büyük katman):** bir bileşeni çocuklarıyla, gerçek state ve olaylarla render edip kullanıcının gördüğünü ve yaptığını test etmek. Ağ sahte olur.
- **Uçtan uca (E2E):** gerçek tarayıcı, gerçek (ya da staging) backend, kritik akışlar: giriş, ödeme, deploy başlatma. Yavaş ve kırılgan, o yüzden az sayıda.

Temel ilke Testing Library'nin mottosu: **Testlerin, yazılımın kullanıldığı şekle ne kadar benzerse, sana o kadar çok güven verir.** State'in içindeki değeri, hangi hook'un çağrıldığını, bileşenin kaç kez render edildiğini test etme; bunlar uygulama detayıdır ve refaktör ettiğinde test hiçbir şey bozulmadığı halde kırılır. Ekranda ne yazdığını ve kullanıcı bir şeye tıklayınca ne olduğunu test et.

## Kurulum: Vitest

Vite projesinde Vitest aynı yapılandırmayı (alias'lar, eklentiler) kullanır, ayrı bir Babel/Jest kurulumu gerekmez:

```bash
npm i -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

```ts
// vite.config.ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
  },
});
```

```ts
// src/test/setup.ts
import "@testing-library/jest-dom/vitest";    // toBeInTheDocument, toBeDisabled...
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(() => cleanup());
```

```json
// package.json
"scripts": {
  "test": "vitest",
  "test:ci": "vitest run --coverage",
  "typecheck": "tsc --noEmit"
}
```

`vitest` izleme modunda çalışır ve sadece değişen dosyalarla ilgili testleri tekrar koşar.

## Birim testleri

```ts
// src/lib/bicim.ts
export function boyutBicimle(bayt: number): string {
  if (bayt < 1024) return `${bayt} B`;
  const birimler = ["KiB", "MiB", "GiB", "TiB"];
  let i = -1;
  do { bayt /= 1024; i++; } while (bayt >= 1024 && i < birimler.length - 1);
  return `${bayt.toFixed(1)} ${birimler[i]}`;
}
```

```ts
// src/lib/bicim.test.ts
import { describe, it, expect } from "vitest";
import { boyutBicimle } from "./bicim";

describe("boyutBicimle", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [5 * 1024 ** 3, "5.0 GiB"],
  ])("%i bayt → %s", (girdi, beklenen) => {
    expect(boyutBicimle(girdi)).toBe(beklenen);
  });
});
```

`it.each` sınır değerleri (0, 1023, 1024) tek tek test etmeyi ucuzlatır. Reducer'lar ve Zod şemaları da aynı şekilde, React olmadan test edilir.

## Bileşen testleri: Testing Library

Aşağıdaki oyun alanı, gerçek bir test dosyasının yapacağını tarayıcıda yapar: Bileşeni render eder, `user-event` ile kullanıcı gibi davranır ve ekranı sorgular. Mini bir `test`/`expect` yardımcısı Vitest'in yerini tutuyor:

```react
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";

// Oyun alanı React'in üretim derlemesini kullanıyor ve orada act() yok. Bu yüzden
// @testing-library/react'in render/cleanup'ını burada küçük bir eşdeğerle taklit ediyoruz.
let kok: ReturnType<typeof createRoot> | null = null;
let kap: HTMLDivElement | null = null;
function render(ui: React.ReactNode) {
  kap = document.createElement("div");
  document.body.appendChild(kap);
  kok = createRoot(kap);
  flushSync(() => kok!.render(ui));
}
function cleanup() { kok?.unmount(); kap?.remove(); kok = null; kap = null; }

// --- test edilen bileşen ---
function SilmeOnayi({ kaynak, onSil }: { kaynak: string; onSil: (ad: string) => Promise<void> }) {
  const [girdi, setGirdi] = useState("");
  const [durum, setDurum] = useState<"bos" | "siliniyor" | "hata">("bos");
  async function sil() {
    setDurum("siliniyor");
    try { await onSil(kaynak); setDurum("bos"); } catch { setDurum("hata"); }
  }
  return (
    <div>
      <label htmlFor="onay">Onaylamak için <b>{kaynak}</b> yaz</label>
      <input id="onay" value={girdi} onChange={(e) => setGirdi(e.target.value)} />
      <button disabled={girdi !== kaynak || durum === "siliniyor"} onClick={sil}>
        {durum === "siliniyor" ? "Siliniyor…" : "Sil"}
      </button>
      {durum === "hata" && <p role="alert">Silinemedi, tekrar dene.</p>}
    </div>
  );
}

// --- mini test koşucusu (gerçek projede Vitest) ---
const testler: [string, () => Promise<void>][] = [];
const test = (ad: string, fn: () => Promise<void>) => testler.push([ad, fn]);
function expect(gercek: any) {
  return {
    toBe: (b: any) => { if (gercek !== b) throw new Error(`beklenen ${b}, gelen ${gercek}`); },
    toBeTruthy: () => { if (!gercek) throw new Error("değer yok"); },
  };
}

// --- testler ---
test("isim yazılana kadar Sil butonu pasif", async () => {
  const user = userEvent.setup();
  render(<SilmeOnayi kaynak="db-prod" onSil={async () => {}} />);
  const buton = screen.getByRole("button", { name: "Sil" });
  expect((buton as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText(/onaylamak için/i), "db-pro");
  expect((buton as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText(/onaylamak için/i), "d");
  expect((buton as HTMLButtonElement).disabled).toBe(false);
});

test("onaylanınca onSil kaynak adıyla çağrılır", async () => {
  const user = userEvent.setup();
  const cagrilar: string[] = [];
  render(<SilmeOnayi kaynak="db-prod" onSil={async (ad) => { cagrilar.push(ad); }} />);
  await user.type(screen.getByRole("textbox"), "db-prod");
  await user.click(screen.getByRole("button", { name: "Sil" }));
  expect(cagrilar.join()).toBe("db-prod");
});

test("hata olursa uyarı gösterilir", async () => {
  const user = userEvent.setup();
  render(<SilmeOnayi kaynak="db-prod" onSil={() => Promise.reject(new Error("403"))} />);
  await user.type(screen.getByRole("textbox"), "db-prod");
  await user.click(screen.getByRole("button", { name: "Sil" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Silinemedi, tekrar dene.");
});

export default function App() {
  const [sonuclar, setSonuclar] = useState<string[] | null>(null);
  async function kos() {
    const s: string[] = [];
    for (const [ad, fn] of testler) {
      try { await fn(); s.push(`✔ ${ad}`); } catch (e: any) { s.push(`✘ ${ad}: ${e.message}`); }
      cleanup();
    }
    setSonuclar(s);
  }
  return (
    <div>
      <button onClick={kos}>Testleri koş</button>
      <pre>{sonuclar?.join("\n")}</pre>
    </div>
  );
}
```

"Testleri koş"a bas, üçü de geçmeli. Sonra bileşende küçük bir hata yap (örneğin `disabled` koşulundan `girdi !== kaynak`'ı kaldır ya da hata mesajını değiştir) ve tekrar çalıştır.

Gerçek projede `render` ve `cleanup` doğrudan `@testing-library/react`'ten gelir ve React güncellemelerini `act()` ile sarar. Aynı testler şöyle görünür:

```tsx
// src/components/SilmeOnayi.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SilmeOnayi } from "./SilmeOnayi";

describe("SilmeOnayi", () => {
  it("onaylanınca onSil kaynak adıyla çağrılır", async () => {
    const user = userEvent.setup();
    const onSil = vi.fn().mockResolvedValue(undefined);
    render(<SilmeOnayi kaynak="db-prod" onSil={onSil} />);

    await user.type(screen.getByLabelText(/onaylamak için/i), "db-prod");
    await user.click(screen.getByRole("button", { name: "Sil" }));

    expect(onSil).toHaveBeenCalledWith("db-prod");
  });

  it("isim yazılana kadar Sil pasif", async () => {
    render(<SilmeOnayi kaynak="db-prod" onSil={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Sil" })).toBeDisabled();
  });
});
```

### Sorgu seçimi

Sorgular, kullanıcının ve ekran okuyucunun sayfayı nasıl gördüğünü yansıtır. Öncelik sırası:

1. `getByRole("button", { name: "Sil" })`: neredeyse her şey için ilk tercih. Erişilebilirlik ağacını kullanır, bu yüzden bir buton `<div onClick>` ise test seni uyarır.
2. `getByLabelText`: form alanları.
3. `getByText`: etkileşimsiz metin.
4. `getByTestId`: son çare, başka yol yoksa.

Varyantlar: `getBy*` bulamazsa hemen hata fırlatır; `queryBy*` `null` döner (bir şeyin **olmadığını** test etmek için: `expect(screen.queryByRole("alert")).not.toBeInTheDocument()`); `findBy*` bir Promise döner ve öğe görünene kadar bekler (asenkron sonuçlar için).

`fireEvent.change` yerine `user-event` kullan: Gerçek bir kullanıcı gibi odaklanır, her tuşu ayrı basar, `keydown`/`input`/`keyup` olaylarını sırasıyla tetikler.

### Ağı sahtelemek: MSW

Veri çeken bileşenleri test ederken `fetch`'i ya da TanStack Query'yi mock'lamak yerine **ağ seviyesinde** sahtele. Mock Service Worker (MSW), testlerde (Node'da) ve tarayıcıda geliştirme sırasında aynı tanımları kullanır:

```ts
// src/test/sunucu.ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/api/podlar", () => HttpResponse.json([{ ad: "api-1", hazir: true }, { ad: "api-2", hazir: false }])),
];
export const sunucu = setupServer(...handlers);
```

```ts
// setup.ts'e ekle
import { beforeAll, afterAll, afterEach } from "vitest";
import { sunucu } from "./sunucu";
beforeAll(() => sunucu.listen({ onUnhandledRequest: "error" }));
afterEach(() => sunucu.resetHandlers());
afterAll(() => sunucu.close());
```

```tsx
it("API hata dönerse hata mesajı gösterir", async () => {
  sunucu.use(http.get("/api/podlar", () => new HttpResponse(null, { status: 500 })));
  renderWithClient(<PodListesi />);     // QueryClientProvider ile saran yardımcı, retry: false
  expect(await screen.findByRole("alert")).toHaveTextContent(/yüklenemedi/i);
});
```

TanStack Query testlerinde her test için **yeni** bir `QueryClient` oluştur ve `retry: false` ver; yoksa testler önbelleği paylaşır ve hata testleri yeniden denemeler yüzünden zaman aşımına uğrar.

## Uçtan uca: Playwright

Playwright gerçek tarayıcıları (Chromium, Firefox, WebKit) sürer. Bileşen testlerinde sahte olan her şeyi (routing, gerçek API, kimlik doğrulama, CSS, tarayıcı farkları) kapsar.

```bash
npm init playwright@latest        # tarayıcıları ve örnek yapılandırmayı kurar
npx playwright test               # başsız çalıştır
npx playwright test --ui          # zaman yolculuklu arayüz modu
npx playwright codegen localhost:5173    # tıkladıklarından test kodu üretir
```

```ts
// e2e/deploy.spec.ts
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/giris");
  await page.getByLabel("E-posta").fill(process.env.E2E_KULLANICI!);
  await page.getByLabel("Parola").fill(process.env.E2E_PAROLA!);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).toHaveURL("/panel");
});

test("staging'e deploy başlatılır ve durum güncellenir", async ({ page }) => {
  await page.getByRole("link", { name: "Deploy'lar" }).click();
  await page.getByRole("button", { name: "Yeni deploy" }).click();
  await page.getByLabel("Ortam").selectOption("staging");
  await page.getByLabel("Sürüm").fill("v2.4.1");
  await page.getByRole("button", { name: "Başlat" }).click();

  const satir = page.getByRole("row", { name: /v2\.4\.1/ });
  await expect(satir).toContainText("Çalışıyor");
  await expect(satir).toContainText("Başarılı", { timeout: 60_000 });
});
```

Playwright'ın `expect`'i **otomatik bekler**: `toContainText` koşul sağlanana ya da zaman aşımı dolana kadar tekrar dener. `waitForTimeout(3000)` gibi sabit beklemeler yazma, kırılgan testlerin bir numaralı sebebidir.

```ts
// playwright.config.ts (önemli kısımlar)
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:4173",
    trace: "on-first-retry",          // başarısız olanların izi: DOM, ağ, konsol
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobil", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.BASE_URL ? undefined : { command: "npm run build && npm run preview", port: 4173 },
});
```

`webServer` yerelde ve CI'da üretim build'ini başlatır. `BASE_URL` verilirse doğrudan staging ortamına karşı koşar; bu, deploy'dan sonra bir **duman testi** (smoke test) olarak çok değerlidir. Kırılan bir CI çalışmasının trace dosyasını `npx playwright show-trace trace.zip` ile açıp her adımda DOM'un nasıl olduğunu görebilirsin.

## CI'da hepsi bir arada

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npx eslint .
      - run: npm run test:ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test --project=chromium
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
```

Sıralama bilinçli: En hızlı ve en ucuz kontroller (tip, lint) önce çalışır ve başarısız olursa pahalı E2E adımına hiç gelinmez.

## Alıştırma

Oyun alanındaki `SilmeOnayi` için iki test daha ekle:

1. Silme sürerken buton "Siliniyor…" yazar ve pasiftir.
2. Hata uyarısı ilk başta görünmez.

<details><summary>Bir çözüm</summary>

Testleri oyun alanındaki `// --- testler ---` bölümüne ekle:

```tsx
test("silme sürerken buton pasif ve 'Siliniyor…' yazar", async () => {
  const user = userEvent.setup();
  let bitir!: () => void;
  render(<SilmeOnayi kaynak="x" onSil={() => new Promise<void>((r) => { bitir = r; })} />);
  await user.type(screen.getByRole("textbox"), "x");
  await user.click(screen.getByRole("button", { name: "Sil" }));
  const buton = screen.getByRole("button", { name: "Siliniyor…" }) as HTMLButtonElement;
  expect(buton.disabled).toBe(true);
  bitir();
  expect((await screen.findByRole("button", { name: "Sil" })).textContent).toBe("Sil");
});

test("uyarı başta görünmez", async () => {
  render(<SilmeOnayi kaynak="x" onSil={async () => {}} />);
  expect(screen.queryByRole("alert")).toBe(null);
});
```

İlk testte Promise'i dışarıdan kontrol ederek (`bitir`) ara durumu yakaladık: Gerçek bir ağ isteğinin "yolda" olduğu anı test etmenin güvenilir yolu budur. İkincide `queryBy` kullandık çünkü `getBy` bulamayınca hata fırlatırdı.

</details>

```quiz
Bir bileşen testinde butonu bulmak için ilk tercih hangisi olmalı?
- `container.querySelector(".btn-sil")`
- `getByTestId("sil")`
- [x] `getByRole("button", { name: "Sil" })`
? Rol tabanlı sorgular kullanıcının ve ekran okuyucunun gördüğünü yansıtır, erişilebilirlik hatalarını da yakalar.
```

```quiz
Bir öğenin ekranda OLMADIĞINI doğrulamak için hangi sorgu kullanılır?
- getByText
- [x] queryByText (bulamazsa null döner)
- findByText
? getBy bulamayınca hata fırlatır, findBy bekleyip zaman aşımında hata verir.
```

```quiz
Playwright testinde bir işlemin bitmesini beklemek için en doğru yol?
- `page.waitForTimeout(5000)`
- [x] Otomatik bekleyen bir doğrulama: `await expect(satir).toContainText("Başarılı")`
- Döngü içinde sayfayı yenilemek
? Sabit beklemeler hem yavaş hem kırılgandır.
```

## Özet

- Kupa modeli: statik analiz + birim + **çoğunlukla entegrasyon** + az sayıda E2E. Uygulama detaylarını değil, kullanıcının gördüğünü test et.
- Vitest, Vite yapılandırmasını kullanır. jsdom + Testing Library + user-event + jest-dom.
- Sorgu önceliği: role → label → text → testId. `getBy` / `queryBy` / `findBy` farkı.
- Ağı MSW ile sahtele. Her testte yeni QueryClient, `retry: false`.
- Playwright: otomatik bekleyen doğrulamalar, trace, mobil cihaz projeleri, `BASE_URL` ile staging'e karşı duman testi.
- CI'da ucuzdan pahalıya: tip → lint → birim/entegrasyon → E2E.
