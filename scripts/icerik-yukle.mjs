// courses/ klasörünü Supabase Storage'daki özel "dersler" kovasına yükler (var olanların üzerine yazar).
// Gizli anahtar sadece ortam değişkeninden okunur; ASLA dosyaya ya da depoya yazma.
//
//   PowerShell:  $env:SUPABASE_SECRET_KEY = "sb_secret_..."; node scripts/icerik-yukle.mjs
//   Bash:        SUPABASE_SECRET_KEY=sb_secret_... node scripts/icerik-yukle.mjs
//   Seçenekler:  --kuru (sadece listele)  --sil (kovada olup yerelde olmayanları sil)
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.SUPABASE_URL ?? "https://xbtxahgpvzolqnuuavcu.supabase.co";
const ANAHTAR = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const KOVA = "dersler";
const KOK = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "courses");
const kuru = process.argv.includes("--kuru"), sil = process.argv.includes("--sil");

if (!ANAHTAR && !kuru) {
  console.error("SUPABASE_SECRET_KEY ortam değişkeni yok. Panel > Project Settings > API Keys > Secret key.");
  process.exit(1);
}
const basliklar = () => {
  const b = { apikey: ANAHTAR };
  if (ANAHTAR?.startsWith("eyJ")) b.Authorization = `Bearer ${ANAHTAR}`;   // eski service_role JWT
  return b;
};
const TUR = { ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".sql": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };

function dosyalar(dizin, onek = "") {
  return fs.readdirSync(dizin, { withFileTypes: true }).flatMap((g) => {
    const yerel = path.join(dizin, g.name), uzak = onek ? `${onek}/${g.name}` : g.name;
    return g.isDirectory() ? dosyalar(yerel, uzak) : [{ yerel, uzak }];
  });
}

const liste = dosyalar(KOK);
console.log(`${liste.length} dosya bulundu (${KOK})`);
if (kuru) { liste.forEach((d) => console.log("  " + d.uzak)); process.exit(0); }

let tamam = 0, hata = 0;
for (const d of liste) {
  const r = await fetch(`${URL_}/storage/v1/object/${KOVA}/${d.uzak.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { ...basliklar(), "x-upsert": "true", "content-type": TUR[path.extname(d.yerel)] ?? "application/octet-stream", "cache-control": "max-age=60" },
    body: fs.readFileSync(d.yerel),
  });
  if (r.ok) tamam++;
  else { hata++; console.error(`  HATA ${r.status} ${d.uzak}: ${(await r.text()).slice(0, 200)}`); }
}
console.log(`yüklendi: ${tamam}, hata: ${hata}`);

if (sil) {
  // kovadaki bütün nesneleri listele, yerelde olmayanları sil
  const uzaktakiler = [];
  async function listele(onek) {
    const r = await fetch(`${URL_}/storage/v1/object/list/${KOVA}`, {
      method: "POST", headers: { ...basliklar(), "content-type": "application/json" },
      body: JSON.stringify({ prefix: onek, limit: 1000, offset: 0 }),
    });
    for (const o of await r.json()) {
      const tam = onek ? `${onek}/${o.name}` : o.name;
      if (o.id === null) await listele(tam); else uzaktakiler.push(tam);
    }
  }
  await listele("");
  const yereller = new Set(liste.map((d) => d.uzak));
  const fazla = uzaktakiler.filter((u) => !yereller.has(u));
  if (fazla.length) {
    const r = await fetch(`${URL_}/storage/v1/object/${KOVA}`, {
      method: "DELETE", headers: { ...basliklar(), "content-type": "application/json" }, body: JSON.stringify({ prefixes: fazla }),
    });
    console.log(`silinen: ${fazla.length} (${r.status})`);
  } else console.log("silinecek eski dosya yok");
}
process.exit(hata ? 1 : 0);
