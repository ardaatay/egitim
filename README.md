# Eğitim

Okuyarak ilerlenen, telefonda, tablette ve bilgisayarda çalışan eğitim platformu. Uygulama kabuğu GitHub Pages'te statik olarak yayınlanır; üyelik, ilerleme ve ders içerikleri Supabase'tedir. Üyelik davetle verilir.

## Yerelde çalıştırma

```powershell
python -m http.server 8123
```

Sonra tarayıcıda `http://localhost:8123` adresini aç. Dersler yerelde de Supabase'ten okunur, bu yüzden giriş yapman gerekir (Supabase'te Redirect URLs listesinde `http://localhost:8123/**` olmalı).

## Yapı

```text
index.html               uygulama kabuğu
assets/app.js            sayfalar, Markdown, sorular, giriş sayfası
assets/sync.js           üyelik (Supabase Auth), korumalı içerik (Storage), ilerleme senkronizasyonu
assets/terminal.js       tarayıcıda Linux (v86 + Buildroot, seri konsol)
assets/linux/            Linux çekirdek görüntüsü
supabase/sema.sql        ilerleme tablosu, RLS ve depolama kuralları
supabase/KURULUM.md      Supabase kurulumu ve kullanıcı davet etme
```

Ders içerikleri bu depoda değil: private `egitim-icerik` deposunda yazılır ve Supabase Storage'daki özel
`dersler` kovasına yüklenir. Kovayı sadece davetle giriş yapmış kullanıcılar okuyabilir. Ders ekleme ve
yayınlama adımları o deponun README dosyasındadır.

## Ders içinde özel bloklar

````markdown
```terminal
ls -la
```
````
"Terminalde çalıştır" düğmesi olan komut.

````markdown
```quiz
Soru metni
- yanlış seçenek
- [x] doğru seçenek
? Cevaptan sonra gösterilecek açıklama
```
````

````markdown
```lab
Killercoda: Docker temelleri
https://killercoda.com/...
Gerçek bir Docker ortamında dene.
```
````
Dış laboratuvar bağlantısı.

````markdown
```react
import { useState } from "react";
export default function App() { ... }
```
````
Canlı React oyun alanı (assets/playground.js): düzenlenebilir kod + önizleme + konsol. React 19 esm.sh'tan, JSX/TypeScript Babel ile tarayıcıda derlenir, `export default` bileşen çizilir, çıplak paket importları (`zustand` gibi) esm.sh'a yönlendirilir.

- `> **Dikkat:** ...` ile başlayan alıntılar sarı uyarı kutusu olur.
- `<details><summary>Cevaplar</summary> ... </details>` gizlenebilir cevaplar içindir.
