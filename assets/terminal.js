// Tarayıcı içinde çalışan küçük bir Linux (v86 x86 öykünücüsü + Buildroot çekirdeği).
// Seri konsol (ttyS0) üzerinden konuşur; ekran yerine metin tabanlı bir terminal gösterir.
(function () {
  const V86_VER = "0.5.476";
  const CFG = {
    lib: `https://cdn.jsdelivr.net/npm/v86@${V86_VER}/build/libv86.js`,
    wasm: `https://cdn.jsdelivr.net/npm/v86@${V86_VER}/build/v86.wasm`,
    bios: "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin",
    vgabios: "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin",
    kernel: "assets/linux/buildroot-bzimage68.bin", // Linux 6.8 + BusyBox (v86 projesinin hazır görüntüsü)
  };

  const $ = (id) => document.getElementById(id);
  const panel = $("terminal"), out = $("termOut"), form = $("termForm"), input = $("termInput"), status = $("termStatus");

  let emulator = null, booting = false, ready = false;
  const queue = [];          // hazır olmadan gönderilen komutlar
  const history = []; let histPos = 0;
  let buffer = "";           // ekrana basılan metin
  let pendingEsc = "";       // yarım kalan ANSI kaçış dizisi

  function setStatus(text, ok) { status.textContent = text; status.classList.toggle("ready", !!ok); }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("yüklenemedi: " + src));
      document.head.appendChild(s);
    });
  }

  // Paneldeki genişliğe kaç karakter sığıyor? (ls gibi komutlar sütunları buna göre dizer)
  function cols() {
    const probe = document.createElement("span");
    probe.textContent = "0000000000";
    out.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 10;
    probe.remove();
    const cs = getComputedStyle(out);
    const inner = out.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return Math.max(30, Math.min(200, Math.floor(inner / (w || 8)) - 1));
  }

  // Ekranı her baytta değil, karede bir güncelle
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return; renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.textContent = buffer;
      if (atBottom) out.scrollTop = out.scrollHeight;
    });
  }

  // Seri porttan gelen ham metni sade metne çevir: ANSI renk/imleç kodlarını at, \b ve \r'yi işle.
  function write(chunk) {
    let s = pendingEsc + chunk; pendingEsc = "";
    const m = s.match(/\x1b(\[[0-9;?]*)?$/); // sonda yarım kaçış dizisi kaldıysa sakla
    if (m) { pendingEsc = m[0]; s = s.slice(0, -m[0].length); }
    // "clear": ekranı silme dizisi (\e[2J ya da \e[H ardından \e[J) geldiyse öncesini at
    const cl = Math.max(s.lastIndexOf("\x1b[2J"), s.lastIndexOf("\x1b[J"));
    if (cl >= 0) { buffer = ""; s = s.slice(cl).replace(/^\x1b\[2?J/, ""); }
    s = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\x1b[=>78]/g, "");
    for (const ch of s) {
      if (ch === "\b") buffer = buffer.slice(0, -1);
      else if (ch === "\r" || ch === "\x07") continue;
      else buffer += ch;
    }
    if (buffer.length > 60000) buffer = buffer.slice(-40000);
    scheduleRender();

    if (!ready && /login:\s*$/.test(buffer)) {
      emulator.serial0_send("root\n");
    }
    if (!ready && /[#%$] $/.test(buffer)) {
      ready = true; setStatus("hazır", true);
      // Daha okunur bir istem ve geniş satırlar
      emulator.serial0_send(`export PS1='\\w # '; stty cols ${cols()} rows 40 2>/dev/null; cd ~; clear\n`);
      setTimeout(() => { while (queue.length) raw(queue.shift()); }, 300);
    }
  }

  async function boot() {
    if (emulator || booting) return;
    booting = true; ready = false; buffer = ""; out.textContent = "";
    setStatus("yükleniyor…");
    write("Linux başlatılıyor. İlk açılışta ~10 MB indirilir, 10-30 saniye sürebilir.\n\n");
    try {
      if (!window.V86) await loadScript(CFG.lib);
      emulator = new window.V86({
        wasm_path: CFG.wasm,
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        bios: { url: CFG.bios },
        vga_bios: { url: CFG.vgabios },
        bzimage: { url: CFG.kernel, async: false },
        cmdline: "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0",
        filesystem: {}, // /mnt altında boş bir paylaşımlı klasör (açılıştaki mount hatasını da önler)
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
      });
      const dec = new TextDecoder("utf-8");
      emulator.add_listener("serial0-output-byte", (b) => write(dec.decode(new Uint8Array([b]), { stream: true })));
      emulator.add_listener("download-progress", (e) => {
        if (e.total) setStatus(`indiriliyor %${Math.round((e.loaded / e.total) * 100)}`);
      });
      emulator.add_listener("emulator-started", () => setStatus("açılıyor…"));
      const me = emulator;
      setTimeout(() => {
        if (emulator === me && !ready) {
          setStatus("yanıt yok");
          write("\n\nLinux 90 saniyede açılmadı. İnternet bağlantını kontrol edip ↻ ile yeniden dene.\n");
        }
      }, 90000);
    } catch (err) {
      setStatus("hata");
      write("\nTerminal başlatılamadı: " + err.message + "\nİnternet bağlantını kontrol edip ↻ ile tekrar dene.\n");
      emulator = null;
    } finally { booting = false; }
  }

  const enc = new TextEncoder();
  const raw = (text) => emulator.serial_send_bytes(0, enc.encode(text)); // Türkçe karakterler için UTF-8

  function send(text) {
    if (ready) raw(text); else { queue.push(text); boot(); }
  }

  function open() { panel.hidden = false; boot(); setTimeout(() => input.focus({ preventScroll: true }), 50); }
  function close() { panel.hidden = true; }

  async function reset() {
    if (emulator) { try { await emulator.destroy(); } catch (_) {} emulator = null; }
    queue.length = 0; boot();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const cmd = input.value;
    if (cmd.trim()) { history.push(cmd); }
    histPos = history.length;
    input.value = "";
    send(cmd + "\n");
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { e.preventDefault(); prev(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); histPos = Math.min(history.length, histPos + 1); input.value = history[histPos] || ""; }
    else if (e.key === "Tab") { e.preventDefault(); tab(); }
    else if (e.key === "c" && e.ctrlKey && input.selectionStart === input.selectionEnd) { e.preventDefault(); send("\x03"); }
  });

  function prev() { if (!history.length) return; histPos = Math.max(0, histPos - 1); input.value = history[histPos]; }
  // Tab: yazılanı kabuğa gönderip tamamlat, sonra satırı kabuktan geri silmek yerine input'u boşalt.
  function tab() {
    const v = input.value; if (!v) return;
    input.value = ""; send(v + "\t");
  }

  form.querySelectorAll(".key").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.key;
    if (k === "tab") tab(); else if (k === "ctrlc") send("\x03"); else if (k === "up") prev();
    input.focus({ preventScroll: true });
  }));

  $("termClose").addEventListener("click", close);
  $("termReset").addEventListener("click", reset);
  $("termSize").addEventListener("click", () => panel.classList.toggle("big"));
  out.addEventListener("click", () => { if (!getSelection().toString()) input.focus({ preventScroll: true }); });

  window.LinuxTerminal = {
    open, close,
    run(cmd) { open(); send(cmd.replace(/\n+$/, "") + "\n"); },
  };
})();
