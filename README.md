# Eğitim

Okuyarak ilerlenen, telefonda, tablette ve bilgisayarda çalışan kişisel eğitim platformu. Sunucu gerektirmeyen statik bir sitedir ve GitHub Pages'te yayınlanır.

## Yerelde çalıştırma

```powershell
python -m http.server 8123
```

Sonra tarayıcıda `http://localhost:8123` adresini aç.

## Yapı

```text
index.html               uygulama kabuğu
assets/app.js            sayfalar, Markdown, sorular, ilerleme (localStorage)
assets/terminal.js       tarayıcıda Linux (v86 + Buildroot, seri konsol)
assets/linux/            Linux çekirdek görüntüsü
courses/index.json       kurs listesi ("status": "soon" = yakında kartı)
courses/<kurs>/course.json  bölümler ve dersler
courses/<kurs>/<ders-id>.md ders metni
```

## Yeni ders eklemek

1. `courses/<kurs>/` altına `<ders-id>.md` dosyasını ekle. İlk satır `# Başlık` olsun.
2. `course.json` içinde ilgili bölüme `{ "id": "<ders-id>", "title": "...", "minutes": 8 }` ekle.
3. Yeni kurs ise `courses/index.json` listesine ekle. Tarayıcı terminali gerekiyorsa `course.json` içinde `"terminal": true` yap.

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
