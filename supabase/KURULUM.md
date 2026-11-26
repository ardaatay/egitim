# Üyelik kurulumu (Supabase)

Site GitHub Pages'te kalır; giriş, ilerleme ve ders içerikleri Supabase'te tutulur.
Proje: `https://xbtxahgpvzolqnuuavcu.supabase.co`

## 1. Veritabanı ve depolama

Panel > **SQL Editor** > New query > [`sema.sql`](sema.sql) dosyasının tamamını yapıştır > **Run**.
Bu adım `ilerleme` tablosunu (her kullanıcı sadece kendi satırını görür) ve özel `dersler` kovasını
(sadece giriş yapmış kullanıcılar okur) oluşturur. Tekrar çalıştırmak zararsızdır.

## 2. Kimlik doğrulama ayarları

Panel > **Authentication**:

1. **Sign In / Providers** > "Allow new users to sign up" **kapalı** (kayıt sadece davetle).
   E-posta sağlayıcısı açık kalsın.
2. **URL Configuration**:
   - Site URL: `https://ardaatay.github.io/egitim/`
   - Redirect URLs: `https://ardaatay.github.io/egitim/**` ve yerel deneme için `http://localhost:8123/**`
3. **Emails > Templates > Magic Link**: Gövdeye kodu da ekle, böylece e-postayı telefonda okuyup kodu
   bilgisayara yazmak mümkün olur. Örneğin bağlantının altına:
   `<p>Giriş kodun: <strong>{{ .Token }}</strong></p>`
4. **E-posta gönderimi**: Supabase'in yerleşik e-posta hizmeti saatte birkaç e-postayla sınırlıdır ve
   yalnızca proje ekibindeki adreslere gönderim yapar. Başka kişilere davet ve giriş e-postası gidebilmesi için
   **Emails > SMTP Settings**'ten kendi SMTP sağlayıcını bağla (örneğin Resend ya da Brevo'nun ücretsiz katmanı).

## 3. Ders içeriğini yükle

Panel > **Project Settings > API Keys** > **Secret key** (`sb_secret_...`). Bu anahtar tam yetkilidir:
kimseyle paylaşma, dosyaya ya da depoya yazma. Sadece kendi terminalinde ortam değişkeni olarak kullan:

```powershell
$env:SUPABASE_SECRET_KEY = "sb_secret_..."; node scripts/icerik-yukle.mjs; Remove-Item Env:SUPABASE_SECRET_KEY
```

Ders ekleyip değiştirdikçe aynı komutu tekrar çalıştır. Kovada olup artık yerelde olmayan dosyaları da silmek için
`--sil`, sadece listelemek için `--kuru` ekle.

## 4. Kullanıcı davet etme

Panel > **Authentication > Users > Add user > Send invitation** ile e-posta adresini gir.
Davet edilen kişi e-postadaki bağlantıyla ilk girişini yapar; sonraki girişlerde sitede e-postasını yazıp
gelen bağlantı ya da kodla girer. Kullanıcıyı engellemek ya da silmek aynı ekrandan yapılır;
silinen kullanıcının ilerleme kaydı da otomatik silinir.

## 5. Herkese açık içeriği kaldırma (son adım)

Dersler bugün `courses/` klasöründe ve GitHub Pages'te herkese açık. Yukarıdaki adımlar çalıştıktan ve
girişi doğruladıktan sonra `courses/` bu depodan çıkarılıp private bir içerik deposuna taşınacak.
Daha önce yayımlanmış içerik geçmişte, klonlarda ve önbelleklerde kalabilir; bundan sonra eklenenler korumalıdır.
