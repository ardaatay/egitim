// Üyelik (Supabase Auth), korumalı ders içeriği (Supabase Storage) ve cihazlar arası ilerleme.
// İlerlemede her ders için { d: tamamlandı mı, t: değişiklik zamanı } tutulur; birleştirmede son değişiklik
// kazanır, böylece bir cihazda kaldırılan "tamamlandı" işareti öbür cihazdan geri gelmez.
(function () {
  // Publishable anahtar tarayıcıda kullanılmak üzere tasarlanmıştır; erişimi RLS ve depolama kuralları sınırlar.
  const SUPABASE_URL = "https://xbtxahgpvzolqnuuavcu.supabase.co";
  const SUPABASE_ANAHTAR = "sb_publishable_qmGvfU9cYBhZnKBuyceyhg_Oot10wZ_";
  const KOVA = "dersler";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANAHTAR, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const oku = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
  const yaz = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const olay = (ad, detail) => window.dispatchEvent(new CustomEvent(ad, { detail }));

  // ---------- oturum ----------
  let kullanici = null;
  const hazir = sb.auth.getSession().then(({ data }) => {
    kullanici = data.session?.user ?? null;
    // Giriş bağlantısından dönüşte adres çubuğundaki belirteçleri temizle (hash yönlendiricisiyle çakışmasın)
    if (/access_token=|refresh_token=|error_description=/.test(location.hash)) history.replaceState(null, "", location.pathname + "#/");
    if (kullanici) baslat();
    return kullanici;
  });
  sb.auth.onAuthStateChange((tur, oturum) => {
    if (tur === "INITIAL_SESSION") return;               // açılıştaki oturumu getSession() zaten işliyor
    const onceki = kullanici?.id;
    kullanici = oturum?.user ?? null;
    if (kullanici && kullanici.id !== onceki) { baslat(); olay("oturum-degisti"); }
    if (!kullanici && onceki) { icerikOnbellegi.clear(); olay("oturum-degisti"); }
  });

  function hataMesaji(e) {
    const m = (e?.message || String(e)).toLowerCase();
    if (m.includes("signups not allowed") || m.includes("not found") || m.includes("user not found")) return "Bu e-posta adresi davetli değil. Davet için yöneticiye başvur.";
    if (m.includes("rate limit") || m.includes("security purposes")) return "Çok sık istek gönderildi. Birkaç dakika sonra tekrar dene.";
    if (m.includes("expired") || m.includes("invalid")) return "Kod geçersiz ya da süresi dolmuş. Yeni bir kod iste.";
    return e?.message || "Beklenmeyen bir hata oluştu.";
  }

  window.Uyelik = {
    hazir,
    kullanici: () => kullanici,
    async girisKoduGonder(eposta) {
      const { error } = await sb.auth.signInWithOtp({
        email: eposta.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },   // sadece davetliler
      });
      if (error) throw new Error(hataMesaji(error));
    },
    async koduDogrula(eposta, kod) {
      const { error } = await sb.auth.verifyOtp({ email: eposta.trim(), token: kod.trim(), type: "email" });
      if (error) throw new Error(hataMesaji(error));
    },
    async cikis() {
      await senkronize().catch(() => {});
      await sb.auth.signOut();
    },
  };

  // ---------- korumalı içerik ----------
  const icerikOnbellegi = new Map();
  window.Icerik = {
    async metin(yol) {                                   // yol: "docker/course.json" gibi (kovaya göre)
      if (icerikOnbellegi.has(yol)) return icerikOnbellegi.get(yol);
      if (!kullanici) { const e = new Error("Giriş gerekli"); e.girisGerekli = true; throw e; }
      const { data, error } = await sb.storage.from(KOVA).download(yol);
      if (error) {
        const e = new Error(error.message?.includes("not found") || error.statusCode === "404" ? `${yol} bulunamadı` : `${yol} okunamadı: ${error.message}`);
        throw e;
      }
      const t = await data.text();
      icerikOnbellegi.set(yol, t);
      return t;
    },
  };

  // ---------- ilerleme (kullanıcıya özel yerel kayıt + Supabase tablosu) ----------
  const anahtar = () => (kullanici ? `egitim.ilerleme.${kullanici.id}` : "egitim.ilerleme.misafir");
  function veri() {
    let v = oku(anahtar(), null);
    if (!v) {
      v = { dersler: {}, son: null };
      // Üyelik öncesi bu tarayıcıda tutulan ilerlemeyi, burada ilk giriş yapan kullanıcıya bir kez taşı
      const eski = oku("egitim.done", null);
      if (kullanici && eski) {
        for (const k of eski) v.dersler[k] = { d: true, t: 1 };
        const son = oku("egitim.last", null);
        if (son) v.son = { ...son, t: 1 };
        yaz("egitim.done", null); yaz("egitim.last", null);
      }
      yaz(anahtar(), v);
    }
    return v;
  }
  function birlestir(a, b) {
    const s = { dersler: { ...(a.dersler || {}) }, son: a.son || null };
    for (const [k, x] of Object.entries(b.dersler || {})) if (!s.dersler[k] || x.t > s.dersler[k].t) s.dersler[k] = x;
    if (b.son && (!s.son || b.son.t > s.son.t)) s.son = b.son;
    return s;
  }
  const esit = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  let durum = { tur: "kapali", mesaj: "" };
  const durumYaz = (tur, mesaj) => { durum = { tur, mesaj }; olay("senkron-durum", durum); };

  let suren = null;
  function senkronize() {
    if (!kullanici) return Promise.resolve(false);
    if (suren) return suren;
    const uid = kullanici.id;
    suren = (async () => {
      durumYaz("calisiyor", "Senkronize ediliyor…");
      try {
        const { data, error } = await sb.from("ilerleme").select("veri").eq("user_id", uid).maybeSingle();
        if (error) throw error;
        const uzak = data?.veri ?? { dersler: {}, son: null };
        const yerel = veri();
        const birlesik = birlestir(yerel, uzak);
        const yerelDegisti = !esit(birlesik, yerel);
        if (yerelDegisti) yaz(anahtar(), birlesik);
        if (!data || !esit(birlesik, birlestir(uzak, {}))) {
          const { error: e2 } = await sb.from("ilerleme").upsert({ user_id: uid, veri: birlesik, guncelleme: new Date().toISOString() });
          if (e2) throw e2;
        }
        durumYaz("tamam", "Senkronize: " + new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }));
        if (yerelDegisti) olay("ilerleme-degisti");
        return yerelDegisti;
      } catch (e) {
        durumYaz("hata", "İlerleme kaydedilemedi: " + (e.message || e));
        return false;
      } finally { suren = null; }
    })();
    return suren;
  }

  let zamanlayici = null;
  const sonraGonder = () => { clearTimeout(zamanlayici); zamanlayici = setTimeout(senkronize, 1500); };
  function baslat() { setTimeout(senkronize, 0); }

  window.Ilerleme = {
    tamamlananlar() { return new Set(Object.entries(veri().dersler).filter(([, x]) => x.d).map(([k]) => k)); },
    isaretle(k, tamam) { const v = veri(); v.dersler[k] = { d: !!tamam, t: Date.now() }; yaz(anahtar(), v); sonraGonder(); },
    sonDers() { return veri().son; },
    sonDersYaz(son) {
      const v = veri();
      if (v.son && v.son.course === son.course && v.son.lesson === son.lesson) return;
      v.son = { ...son, t: Date.now() }; yaz(anahtar(), v); sonraGonder();
    },
    durum: () => durum,
    senkronize,
  };

  // Sekmeye dönüldüğünde çek; sekmeden çıkılırken bekleyen değişikliği hemen gönder
  document.addEventListener("visibilitychange", () => {
    if (!kullanici) return;
    if (document.visibilityState === "visible") senkronize();
    else if (zamanlayici) { clearTimeout(zamanlayici); zamanlayici = null; senkronize(); }
  });
})();
