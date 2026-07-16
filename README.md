# WhatsApp İlan Toplayıcı

WhatsApp gruplarından ilan toplayan bot. Railway üzerinde çalışacak şekilde hazırlanmıştır.

## GitHub → Railway (3 adım)

1. Bu klasörü (`yeni bot`) GitHub’a yükleyin.
2. [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo** → bu repo’yu seçin.
3. Railway’de **PostgreSQL** ekleyin (Add → Database → PostgreSQL). `DATABASE_URL` otomatik bağlanır.

Deploy bitince açılan URL’de **Kurulum Sihirbazı** çıkar:
- Veritabanı kontrolü
- WhatsApp QR bağlantısı
- İzlenecek grup seçimi

## Railway ayarları (isteğe bağlı)

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL` | Postgres (eklenti ile otomatik) |
| `PORT` | Railway verir, dokunmayın |
| `NODE_ENV` | `production` |
| `WHATSAPP_AUTH_DIR` | Oturum klasörü (Volume önerilir) |

### Volume (önemli)

WhatsApp oturumunun silinmemesi için Railway’de Volume ekleyin:
- Mount path: `/data`
- Variable: `WHATSAPP_AUTH_DIR=/data/whatsapp-auth`

## Yerel geliştirme

```bash
pnpm install
# .env dosyasına DATABASE_URL yazın
pnpm run db:push
pnpm run dev:api    # API :8080
pnpm run dev:web    # Frontend :5173
```

## Komutlar

| Komut | Ne yapar |
|---|---|
| `pnpm run build:prod` | Frontend + API build |
| `pnpm run start:prod` | DB şema push + sunucu |
| `pnpm run db:push` | Drizzle şema güncelle |
