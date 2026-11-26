// Eğitim platformu: kurs listesi -> kurs sayfası -> ders sayfası.
// İçerik courses/ klasöründeki JSON ve Markdown dosyalarından okunur.
(function () {
  const app = document.getElementById("app");
  const crumbs = document.getElementById("crumbs");
  const termBtn = document.getElementById("termBtn");
  const cache = {};

  // ---------- küçük yardımcılar ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };
  // İlerleme ve içerik assets/sync.js'teki Supabase modülünden gelir
  const doneSet = () => window.Ilerleme.tamamlananlar();
  const setDone = (key, on) => window.Ilerleme.isaretle(key, on);

  async function fetchText(url) {
    if (url.startsWith("courses/")) return window.Icerik.metin(url.slice("courses/".length));   // korumalı kova
    if (cache[url]) return cache[url];
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(url + " bulunamadı (" + r.status + ")");
    return (cache[url] = await r.text());
  }
  const fetchJSON = async (url) => JSON.parse(await fetchText(url));

  const flatLessons = (course) => course.chapters.flatMap((ch) => ch.lessons.map((l) => ({ ...l, chapter: ch.title })));
  const minutes = (md) => Math.max(1, Math.round(md.split(/\s+/).length / 180));

  // ---------- tema ----------
  const themeBtn = document.getElementById("themeBtn");
  function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
  applyTheme(store.get("egitim.theme", null));
  themeBtn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark"; applyTheme(next); store.set("egitim.theme", next);
  });

  termBtn.addEventListener("click", () => window.LinuxTerminal.open());

  // ---------- Markdown ----------
  // Özel kod blokları:
  //   ```terminal   -> "Terminalde çalıştır" düğmeli komut
  //   ```quiz       -> çoktan seçmeli soru (aşağıdaki biçim)
  //   ```lab        -> dış laboratuvar bağlantısı: 1. satır başlık, 2. satır URL, kalan açıklama
  // Alıntı "> **Dikkat:**" ile başlıyorsa uyarı rengiyle gösterilir.
  function renderMarkdown(md) {
    const renderer = new marked.Renderer();
    renderer.code = (code, info) => {
      const lang = (info || "").trim().split(/\s+/)[0];
      if (lang === "quiz") return quizHTML(code);
      if (lang === "react") return playgroundHTML(code);
      if (lang === "lab") return labHTML(code);
      const isTerm = lang === "terminal";
      const hlLang = isTerm ? "bash" : lang;
      let body;
      try { body = hlLang && hljs.getLanguage(hlLang) ? hljs.highlight(code, { language: hlLang }).value : esc(code); }
      catch (_) { body = esc(code); }
      return `<div class="code" data-code="${esc(code)}">
        <div class="code-tools"><span class="lang">${esc(isTerm ? "terminal" : lang || "metin")}</span>
          <button type="button" data-act="copy">Kopyala</button>
          ${isTerm ? '<button type="button" class="run" data-act="run">▶ Terminalde çalıştır</button>' : ""}
        </div><pre><code class="hljs">${body}</code></pre></div>`;
    };
    renderer.blockquote = (quote) => {
      const warn = /^<p><strong>(Dikkat|Uyarı)/.test(quote.trim());
      return `<blockquote${warn ? ' class="warn"' : ""}>${quote}</blockquote>`;
    };
    return marked.parse(md, { renderer, gfm: true });
  }

  // Quiz biçimi:
  //   Soru metni
  //   - yanlış seçenek
  //   - [x] doğru seçenek
  //   ? açıklama (isteğe bağlı)
  //   ya da JSON: { "question": "...", "options": ["...", "..."], "answer": 1, "explanation": "..." }
  function quizHTML(src) {
    if (src.trim().startsWith("{")) {
      try {
        const j = JSON.parse(src);
        return `<div class="quiz" data-why="${esc(j.explanation || "")}"><div class="q">${marked.parseInline(j.question || "")}</div>
          ${(j.options || []).map((o, i) => `<button type="button" class="opt" data-right="${i === j.answer ? 1 : 0}">${marked.parseInline(o)}</button>`).join("")}
          <div class="why" hidden></div></div>`;
      } catch (_) { /* geçersiz JSON: aşağıdaki satır biçimiyle dene */ }
    }
    const lines = src.split("\n").map((l) => l.trim()).filter(Boolean);
    const q = [], opts = []; let why = "";
    for (const l of lines) {
      if (l.startsWith("- ")) { const right = /^- \[x\]\s*/i.test(l); opts.push({ right, text: l.replace(/^- (\[x\]\s*)?/i, "") }); }
      else if (l.startsWith("? ")) why = l.slice(2);
      else q.push(l);
    }
    return `<div class="quiz" data-why="${esc(why)}"><div class="q">${marked.parseInline(q.join(" "))}</div>
      ${opts.map((o) => `<button type="button" class="opt" data-right="${o.right ? 1 : 0}">${marked.parseInline(o.text)}</button>`).join("")}
      <div class="why" hidden></div></div>`;
  }

  // ```react bloğu: düzenlenebilir kod + canlı önizleme (assets/playground.js)
  function playgroundHTML(code) {
    const bos = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;color:#64748b;margin:12px;font-size:14px">▶ Çalıştır'a bas (ya da kodda Ctrl+Enter)</body>`;
    return `<div class="playground">
      <div class="pg-ust"><span class="lang">react · düzenlenebilir</span><span class="pg-durum"></span>
        <button type="button" data-pg="sifirla" title="İlk hâline döndür">↺ Sıfırla</button>
        <button type="button" data-pg="kopyala">Kopyala</button>
        <button type="button" class="run" data-pg="calistir">▶ Çalıştır</button></div>
      <textarea spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="React kodu">${esc(code.replace(/\n$/, ""))}</textarea>
      <div class="pg-onizleme-baslik">Önizleme</div>
      <iframe sandbox="allow-scripts allow-forms allow-modals" title="Önizleme" srcdoc="${esc(bos)}"></iframe>
      <div class="pg-konsol" hidden></div>
    </div>`;
  }

  // lab: 1. satır başlık, 2. satır URL, kalan açıklama; ya da JSON { "title": "...", "steps": ["...", "..."] }
  function labHTML(src) {
    if (src.trim().startsWith("{")) {
      try {
        const j = JSON.parse(src);
        return `<div class="lab"><span class="emoji">🧪</span><div><strong>${esc(j.title || "Uygulama")}</strong>
          <ol class="lab-adim">${(j.steps || []).map((s) => `<li>${marked.parseInline(s)}</li>`).join("")}</ol></div></div>`;
      } catch (_) { /* satır biçimiyle dene */ }
    }
    const [title, url, ...rest] = src.split("\n");
    return `<div class="lab"><span class="emoji">🧪</span><div><a href="${esc(url.trim())}" target="_blank" rel="noopener">${esc(title.trim())} ↗</a>
      <div>${marked.parseInline(rest.join(" "))}</div></div></div>`;
  }

  // Ders içindeki düğmeler
  app.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const codeBox = b.closest(".code");
    if (codeBox && b.dataset.act === "copy") {
      navigator.clipboard?.writeText(codeBox.dataset.code).then(() => { b.textContent = "Kopyalandı"; setTimeout(() => (b.textContent = "Kopyala"), 1200); });
    }
    if (codeBox && b.dataset.act === "run") window.LinuxTerminal.run(codeBox.dataset.code);
    if (b.classList.contains("opt")) {
      const quiz = b.closest(".quiz"); if (quiz.dataset.answered) return;
      quiz.dataset.answered = "1";
      const right = b.dataset.right === "1";
      b.classList.add(right ? "right" : "wrong");
      quiz.querySelectorAll('.opt[data-right="1"]').forEach((o) => o.classList.add("right"));
      const why = quiz.querySelector(".why");
      why.innerHTML = (right ? "✅ Doğru. " : "❌ Olmadı. ") + marked.parseInline(quiz.dataset.why || "");
      why.hidden = false;
    }
  });

  // ---------- sol menü (içindekiler + ilerleme) ----------
  const tocBtn = document.getElementById("tocBtn");
  const scrim = document.getElementById("scrim");
  const closeToc = () => { document.body.classList.remove("toc-open"); scrim.hidden = true; };
  tocBtn.addEventListener("click", () => {
    const open = !document.body.classList.contains("toc-open");
    document.body.classList.toggle("toc-open", open); scrim.hidden = !open;
  });
  scrim.addEventListener("click", closeToc);

  function sidebarHTML(id, course, currentId) {
    const done = doneSet();
    const ready = flatLessons(course).filter((l) => !l.draft);
    const fin = ready.filter((l) => done.has(id + "/" + l.id)).length;
    const pct = ready.length ? Math.round((fin / ready.length) * 100) : 0;
    let n = 0;
    const chapters = course.chapters.map((ch) => {
      const chReady = ch.lessons.filter((l) => !l.draft);
      const chDone = chReady.filter((l) => done.has(id + "/" + l.id)).length;
      const items = ch.lessons.map((l) => {
        n++;
        const d = done.has(id + "/" + l.id);
        const cls = [l.id === currentId ? "current" : "", d ? "done" : "", l.draft ? "draft" : ""].join(" ").trim();
        const mark = `<span class="mark">${d ? "✓" : n}</span>`;
        return l.draft
          ? `<li class="${cls}"><span class="item">${mark}<span>${esc(l.title)}</span><small>yakında</small></span></li>`
          : `<li class="${cls}"><a class="item" href="#/${esc(id)}/${esc(l.id)}">${mark}<span>${esc(l.title)}</span></a></li>`;
      }).join("");
      const open = ch.lessons.some((l) => l.id === currentId) || !currentId || ch.open;
      return `<details class="side-ch" ${open ? "open" : ""}><summary><span>${esc(ch.title)}</span>
        <small>${chReady.length ? `${chDone}/${chReady.length}` : "yakında"}</small></summary><ul>${items}</ul></details>`;
    }).join("");
    return `<aside class="side" id="side"><a class="side-title" href="#/${esc(id)}">${course.icon || ""} ${esc(course.title)}</a>
      <div class="side-progress"><div class="bar"><span style="width:${pct}%"></span></div><small>%${pct} · ${fin}/${ready.length} ders</small></div>
      <nav>${chapters}</nav></aside>`;
  }

  const withSidebar = (id, course, currentId, content) =>
    `<div class="layout">${sidebarHTML(id, course, currentId)}<div class="content">${content}</div></div>`;

  // ---------- sayfalar ----------
  function setCrumbs(parts) {
    crumbs.innerHTML = parts.map((p) => (p.href ? `<a href="${p.href}">${esc(p.text)}</a>` : esc(p.text))).join(" / ");
  }

  async function homePage() {
    setCrumbs([]);
    const courses = await fetchJSON("courses/index.json");
    const done = doneSet();
    const last = window.Ilerleme.sonDers();
    let cont = "";
    if (last) {
      cont = `<a class="continue" href="#/${esc(last.course)}/${esc(last.lesson)}"><span style="font-size:26px">📖</span>
        <span><small>Kaldığın yerden devam et</small><strong>${esc(last.title)}</strong></span></a>`;
    }
    const cards = await Promise.all(courses.map(async (c) => {
      if (c.status === "soon") {
        return `<div class="card soon"><span class="emoji">${c.icon}</span><h2>${esc(c.title)}</h2><p>${esc(c.description)}</p><span class="badge">yakında</span></div>`;
      }
      let total = 0, finished = 0;
      try {
        const course = await fetchJSON(`courses/${c.id}/course.json`);
        const ls = flatLessons(course).filter((l) => !l.draft); total = ls.length; finished = ls.filter((l) => done.has(c.id + "/" + l.id)).length;
      } catch (_) {}
      const pct = total ? Math.round((finished / total) * 100) : 0;
      return `<a class="card" href="#/${esc(c.id)}"><span class="emoji">${c.icon}</span><h2>${esc(c.title)}</h2><p>${esc(c.description)}</p>
        <div class="bar"><span style="width:${pct}%"></span></div><small style="color:var(--muted)">${finished}/${total} ders</small></a>`;
    }));
    app.innerHTML = `<div class="wide"><section class="hero"><h1>Ne öğreniyoruz bugün?</h1>
      <p>Okuyarak ilerle, komutları hemen yanındaki terminalde dene.</p></section>${cont}<div class="grid">${cards.join("")}</div></div>`;
  }

  async function coursePage(id) {
    const course = await fetchJSON(`courses/${id}/course.json`);
    setCrumbs([{ text: "Kurslar", href: "#/" }, { text: course.title }]);
    const done = doneSet();
    const all = flatLessons(course).filter((l) => !l.draft);
    const started = all.some((l) => done.has(id + "/" + l.id));
    const firstOpen = all.find((l) => !done.has(id + "/" + l.id)) || all[0];
    const chapters = course.chapters.map((ch) => {
      const ready = ch.lessons.filter((l) => !l.draft);
      const fin = ready.filter((l) => done.has(id + "/" + l.id)).length;
      return `<section class="chapter-card"><h2>${esc(ch.title)}</h2>${ch.summary ? `<p>${esc(ch.summary)}</p>` : ""}
        <small>${ready.length ? `${fin}/${ready.length} ders tamamlandı` : "yakında"}${ch.lessons.length > ready.length && ready.length ? ` · ${ch.lessons.length - ready.length} ders yolda` : ""}</small></section>`;
    }).join("");
    const content = `<div class="wrap"><div class="course-head"><span style="font-size:34px">${course.icon || ""}</span><h1>${esc(course.title)}</h1>
      <p>${esc(course.description || "")}</p>
      ${firstOpen ? `<a class="btn primary" href="#/${esc(id)}/${esc(firstOpen.id)}">${started ? "Devam et" : "Başla"}: ${esc(firstOpen.title)} →</a>` : ""}</div>
      ${course.intro ? `<div class="prose" style="margin-top:20px">${renderMarkdown(course.intro)}</div>` : ""}
      <div class="chapters">${chapters}</div></div>`;
    app.innerHTML = withSidebar(id, course, null, content);
    termBtn.hidden = !course.terminal;
    tocBtn.hidden = false;
  }

  async function lessonPage(id, lessonId) {
    const course = await fetchJSON(`courses/${id}/course.json`);
    const all = flatLessons(course).filter((l) => !l.draft);
    const i = all.findIndex((l) => l.id === lessonId);
    if (i < 0) throw new Error("Ders bulunamadı");
    const lesson = all[i], prev = all[i - 1], next = all[i + 1];
    const md = await fetchText(`courses/${id}/${lesson.file || lesson.id + ".md"}`);
    const key = id + "/" + lesson.id;
    setCrumbs([{ text: "Kurslar", href: "#/" }, { text: course.title, href: "#/" + id }, { text: lesson.title }]);
    window.Ilerleme.sonDersYaz({ course: id, lesson: lesson.id, title: course.title + " · " + lesson.title });
    const body = md.replace(/\r\n/g, "\n").replace(/^#[ \t]+[^\n]*\n/, ""); // başlığı biz basıyoruz
    const isDone = doneSet().has(key);
    app.innerHTML = withSidebar(id, course, lesson.id, `<article class="wrap lesson"><span class="badge">${esc(lesson.chapter)}</span>
      <h1>${esc(lesson.title)}</h1><div class="sub">Ders ${i + 1}/${all.length} · yaklaşık ${minutes(md)} dk okuma</div>
      <div class="prose">${renderMarkdown(body)}</div>
      <div class="lesson-foot">
        ${prev ? `<a class="btn" href="#/${esc(id)}/${esc(prev.id)}">← Önceki</a>` : ""}
        <button class="btn ${isDone ? "ok" : ""}" id="doneBtn" type="button">${isDone ? "✓ Tamamlandı" : "Tamamladım"}</button>
        ${next ? `<a class="btn primary next" href="#/${esc(id)}/${esc(next.id)}" id="nextBtn">Sonraki: ${esc(next.title)} →</a>`
               : `<a class="btn primary next" href="#/${esc(id)}">Kursa dön</a>`}
      </div></article>`);
    document.getElementById("doneBtn").addEventListener("click", (e) => {
      const now = !doneSet().has(key); setDone(key, now);
      e.currentTarget.classList.toggle("ok", now); e.currentTarget.textContent = now ? "✓ Tamamlandı" : "Tamamladım";
      document.getElementById("side").outerHTML = sidebarHTML(id, course, lesson.id);
    });
    const nb = document.getElementById("nextBtn");
    if (nb) nb.addEventListener("click", () => setDone(key, true)); // sonrakine geçmek = bitirdim
    termBtn.hidden = !course.terminal;
    tocBtn.hidden = false;
    window.ReactPlayground?.baglan(app);
    document.querySelector(".side .current")?.scrollIntoView({ block: "center" });
  }

  // ---------- üyelik: giriş sayfası ve kullanıcı menüsü ----------
  function loginPage() {
    setCrumbs([]);
    app.innerHTML = `<div class="wrap giris"><section class="hero"><h1>Giriş yap</h1>
      <p>Dersler sadece üyelere açık. Üyelik davetle verilir: Davet edildiğin e-posta adresini yaz, sana bir giriş bağlantısı ve kod gönderelim.</p></section>
      <form class="giris-form" id="girisForm">
        <label for="girisEposta">E-posta</label>
        <input id="girisEposta" type="email" autocomplete="email" required placeholder="ad@ornek.com">
        <button class="btn primary" type="submit">Giriş bağlantısı gönder</button>
      </form>
      <form class="giris-form" id="kodForm" hidden>
        <p>E-postana bir giriş bağlantısı gönderdik. Bağlantıyı aynı tarayıcıda açabilir ya da e-postadaki 6 haneli kodu buraya yazabilirsin. E-postayı başka bir cihazda (örneğin telefonda) okuyorsan kod daha pratik.</p>
        <label for="girisKod">Kod</label>
        <input id="girisKod" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8" required placeholder="123456">
        <button class="btn primary" type="submit">Giriş yap</button>
        <button class="btn" type="button" id="girisGeri">Farklı bir e-posta</button>
      </form>
      <p class="giris-mesaj" id="girisMesaj" role="status"></p></div>`;
    const mesaj = (t, hata) => { const m = document.getElementById("girisMesaj"); m.textContent = t; m.classList.toggle("hata", !!hata); };
    const f1 = document.getElementById("girisForm"), f2 = document.getElementById("kodForm");
    let eposta = "";
    f1.addEventListener("submit", async (e) => {
      e.preventDefault(); eposta = document.getElementById("girisEposta").value;
      const b = f1.querySelector("button"); b.disabled = true; mesaj("Gönderiliyor…");
      try { await window.Uyelik.girisKoduGonder(eposta); f1.hidden = true; f2.hidden = false; mesaj(""); document.getElementById("girisKod").focus(); }
      catch (err) { mesaj(err.message, true); }
      finally { b.disabled = false; }
    });
    f2.addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = f2.querySelector("button[type=submit]"); b.disabled = true; mesaj("Doğrulanıyor…");
      try { await window.Uyelik.koduDogrula(eposta, document.getElementById("girisKod").value); }   // oturum-degisti olayı yönlendirir
      catch (err) { mesaj(err.message, true); b.disabled = false; }
    });
    document.getElementById("girisGeri").addEventListener("click", () => { f2.hidden = true; f1.hidden = false; mesaj(""); });
  }

  const uyeBtn = document.getElementById("uyeBtn");
  const uyeMenu = document.getElementById("uyeMenu");
  function uyeArayuzu() {
    const k = window.Uyelik.kullanici();
    uyeBtn.hidden = !k;
    if (!k) { uyeMenu.hidden = true; return; }
    uyeBtn.textContent = (k.email || "?")[0].toUpperCase();
    uyeBtn.title = k.email;
    document.getElementById("uyeEposta").textContent = k.email;
  }
  function durumGoster(d) {
    const el = document.getElementById("uyeDurum"); if (el) { el.textContent = d.mesaj; el.classList.toggle("hata", d.tur === "hata"); }
    uyeBtn.classList.toggle("hata", d.tur === "hata");
  }
  uyeBtn.addEventListener("click", () => { uyeMenu.hidden = !uyeMenu.hidden; durumGoster(window.Ilerleme.durum()); });
  document.addEventListener("click", (e) => { if (!uyeMenu.hidden && !e.target.closest("#uyeMenu, #uyeBtn")) uyeMenu.hidden = true; });
  document.getElementById("uyeCikis").addEventListener("click", async () => { uyeMenu.hidden = true; await window.Uyelik.cikis(); });
  window.addEventListener("senkron-durum", (e) => durumGoster(e.detail));
  window.addEventListener("oturum-degisti", () => { uyeArayuzu(); route(); });

  // Başka bir cihazdan gelen ilerleme: sayfayı kaydırmadan sadece ilerleme göstergelerini yenile
  window.addEventListener("ilerleme-degisti", async () => {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (parts.length === 0) return homePage();
      const course = await fetchJSON(`courses/${parts[0]}/course.json`);
      const side = document.getElementById("side");
      if (side) side.outerHTML = sidebarHTML(parts[0], course, parts[1] || null);
      const db = document.getElementById("doneBtn");
      if (db && parts[1]) {
        const d = doneSet().has(parts[0] + "/" + parts[1]);
        db.classList.toggle("ok", d); db.textContent = d ? "✓ Tamamlandı" : "Tamamladım";
      }
    } catch (_) {}
  });

  async function route() {
    termBtn.hidden = true; tocBtn.hidden = true; closeToc();
    await window.Uyelik.hazir;            // giriş bağlantısındaki #access_token=... önce işlenip temizlenmeli
    if (/access_token=|refresh_token=|error_description=/.test(location.hash)) history.replaceState(null, "", location.pathname + "#/");
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    uyeArayuzu();
    if (!window.Uyelik.kullanici()) { loginPage(); window.scrollTo(0, 0); return; }
    try {
      if (parts.length === 0) await homePage();
      else if (parts.length === 1) await coursePage(parts[0]);
      else await lessonPage(parts[0], parts[1]);
    } catch (err) {
      if (err.girisGerekli) { loginPage(); return; }
      app.innerHTML = `<div class="wrap empty"><p>Sayfa açılamadı: ${esc(err.message)}</p><p><a href="#/">Ana sayfaya dön</a></p></div>`;
    }
    window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
  }

  window.addEventListener("hashchange", route);
  route();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
