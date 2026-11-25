// Tarayıcıda canlı React oyun alanı.
// Kod Babel ile (JSX + TypeScript) dönüştürülür, React 19 esm.sh üzerinden
// import map ile yüklenir ve sandbox'lı bir iframe içinde çalıştırılır.
(function () {
  const BABEL = "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js";
  const REACT_VER = "19.0.0";
  const IMPORT_MAP = {
    imports: {
      "react": `https://esm.sh/react@${REACT_VER}`,
      "react/": `https://esm.sh/react@${REACT_VER}/`,
      "react-dom": `https://esm.sh/react-dom@${REACT_VER}`,
      "react-dom/": `https://esm.sh/react-dom@${REACT_VER}/`,
    },
  };
  let babelYukleniyor = null;
  let sayac = 0;

  function babelYukle() {
    if (window.Babel) return Promise.resolve();
    if (!babelYukleniyor) {
      babelYukleniyor = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = BABEL; s.onload = res; s.onerror = () => rej(new Error("Babel yüklenemedi (internet bağlantısını kontrol et)"));
        document.head.appendChild(s);
      });
    }
    return babelYukleniyor;
  }

  // "zustand" gibi çıplak paket adlarını esm.sh adresine çevir (React tek kopya kalsın diye external)
  function paketleriCozumle(kod) {
    return kod.replace(/(from\s+|import\s*\(\s*|import\s+)(["'])([^"'.\/][^"']*)\2/g, (tam, on, tirnak, ad) => {
      if (/^(react|react-dom)(\/|$)/.test(ad) || /^https?:/.test(ad)) return tam;
      return `${on}${tirnak}https://esm.sh/${ad}${ad.includes("?") ? "&" : "?"}external=react,react-dom${tirnak}`;
    });
  }

  function donustur(kaynak) {
    let kod = window.Babel.transform(kaynak, {
      filename: "App.tsx",
      presets: [
        ["typescript", { isTSX: true, allExtensions: true }],
        ["react", { runtime: "automatic" }],
      ],
    }).code;
    kod = paketleriCozumle(kod);
    // export default'u yakalanabilir bir değişkene çevir
    if (/export\s+default\s+/.test(kod)) kod = kod.replace(/export\s+default\s+/, "const __Varsayilan = ");
    else kod += "\nconst __Varsayilan = typeof App !== 'undefined' ? App : null;";
    kod += `
;(async () => {
  try {
    const { createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    if (__Varsayilan) createRoot(document.getElementById("root")).render(createElement(__Varsayilan));
  } catch (e) { console.error(e && e.message ? e.message : String(e)); }
})();`;
    return kod;
  }

  function sayfa(id, kod, karanlik) {
    const guvenliKod = kod.replace(/<\/script/gi, "<\\/script");
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: ${karanlik ? "dark" : "light"}; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 12px; font-size: 15px; line-height: 1.5;
         background: ${karanlik ? "#0b1120" : "#ffffff"}; color: ${karanlik ? "#e5e7eb" : "#0f172a"}; }
  button { font: inherit; padding: 4px 10px; margin: 2px; cursor: pointer; }
  input, select, textarea { font: inherit; padding: 4px 6px; }
</style>
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<script>
  (function () {
    var ID = ${JSON.stringify(id)};
    function metin(x) { try { return typeof x === "object" && x !== null ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } }
    function gonder(tur, args) { parent.postMessage({ __pg: ID, tur: tur, args: Array.prototype.map.call(args, metin) }, "*"); }
    ["log", "info", "warn", "error"].forEach(function (k) {
      var eski = console[k];
      console[k] = function () { gonder(k, arguments); eski.apply(console, arguments); };
    });
    window.addEventListener("error", function (e) { gonder("error", [e.message]); });
    window.addEventListener("unhandledrejection", function (e) { gonder("error", [String(e.reason && e.reason.message || e.reason)]); });
  })();
</script>
</head><body><div id="root"></div>
<script type="module">
${guvenliKod}
</script>
</body></html>`;
  }

  function karanlikMi() {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }

  async function calistir(kutu) {
    const kaynak = kutu.querySelector("textarea").value;
    const iframe = kutu.querySelector("iframe");
    const konsol = kutu.querySelector(".pg-konsol");
    const durum = kutu.querySelector(".pg-durum");
    const id = "pg" + (++sayac);
    kutu.dataset.id = id;
    konsol.textContent = "";
    konsol.hidden = true;
    durum.textContent = window.Babel ? "çalışıyor…" : "derleyici yükleniyor (ilk seferde ~1 MB)…";
    try {
      await babelYukle();
      const kod = donustur(kaynak);
      iframe.srcdoc = sayfa(id, kod, karanlikMi());
      durum.textContent = "";
    } catch (e) {
      durum.textContent = "";
      konsolaYaz(kutu, "error", [e.message]);
    }
  }

  function konsolaYaz(kutu, tur, args) {
    const konsol = kutu.querySelector(".pg-konsol");
    konsol.hidden = false;
    const satir = document.createElement("div");
    satir.className = "pg-" + tur;
    satir.textContent = (tur === "error" ? "✖ " : tur === "warn" ? "⚠ " : "› ") + args.join(" ");
    konsol.appendChild(satir);
    while (konsol.childElementCount > 200) konsol.firstElementChild.remove();
    konsol.scrollTop = konsol.scrollHeight;
  }

  window.addEventListener("message", (e) => {
    const v = e.data;
    if (!v || !v.__pg) return;
    const kutu = document.querySelector(`.playground[data-id="${v.__pg}"]`);
    if (kutu) konsolaYaz(kutu, v.tur, v.args);
  });

  // Ders sayfası çizildikten sonra çağrılır
  function baglan(kok) {
    kok.querySelectorAll(".playground").forEach((kutu) => {
      if (kutu.dataset.bagli) return;
      kutu.dataset.bagli = "1";
      const ta = kutu.querySelector("textarea");
      const ilk = ta.value;
      const yukseklik = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 4, 560) + "px"; };
      yukseklik();
      ta.addEventListener("input", yukseklik);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          const s = ta.selectionStart, b = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(b);
          ta.selectionStart = ta.selectionEnd = s + 2;
        } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault(); calistir(kutu);
        }
      });
      kutu.querySelector('[data-pg="calistir"]').addEventListener("click", () => calistir(kutu));
      kutu.querySelector('[data-pg="sifirla"]').addEventListener("click", () => { ta.value = ilk; yukseklik(); calistir(kutu); });
      kutu.querySelector('[data-pg="kopyala"]').addEventListener("click", (e) => {
        navigator.clipboard?.writeText(ta.value).then(() => { e.target.textContent = "Kopyalandı"; setTimeout(() => (e.target.textContent = "Kopyala"), 1200); });
      });
    });
  }

  window.ReactPlayground = { baglan, calistir };
})();
