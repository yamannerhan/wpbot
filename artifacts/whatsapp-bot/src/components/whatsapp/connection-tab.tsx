import { useState } from 'react';
import { WhatsAppStatus, useConnectWhatsapp, useDisconnectWhatsapp, getGetWhatsappStatusQueryKey } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, QrCode, Smartphone, WifiOff, KeyRound, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

type LoginMode = 'qr' | 'code';

export function ConnectionTab({ status }: { status?: WhatsAppStatus }) {
  const queryClient = useQueryClient();
  const connect = useConnectWhatsapp();
  const disconnect = useDisconnectWhatsapp();
  const [mode, setMode] = useState<LoginMode>('qr');
  const [phone, setPhone] = useState('90');
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const refreshStatus = () => {
    queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
  };

  const handleQrConnect = () => {
    connect.mutate(
      { data: {} },
      {
        onSuccess: () => {
          refreshStatus();
          toast.success('QR kod hazırlanıyor…');
        },
        onError: () => toast.error('Bağlantı başlatılamadı'),
      },
    );
  };

  const handleCodeConnect = () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 11 || digits.length > 15) {
      toast.error('Ülke kodu ile numarayı girin (örn. 905321234567)');
      return;
    }
    if (!digits.startsWith('90') && digits.length === 10) {
      toast.error('Başına 90 ekleyin (örn. 905321234567)');
      return;
    }
    connect.mutate(
      { data: { phoneNumber: digits } },
      {
        onSuccess: () => {
          refreshStatus();
          toast.success('Eşleştirme kodu isteniyor…');
        },
        onError: () => toast.error('Kod oluşturulamadı'),
      },
    );
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await fetch('/api/whatsapp/cancel', { method: 'POST' });
      refreshStatus();
      toast.info('İptal edildi');
    } catch {
      toast.error('İptal edilemedi');
    } finally {
      setCancelling(false);
    }
  };

  const handleDisconnect = () => {
    disconnect.mutate(
      {},
      {
        onSuccess: () => {
          refreshStatus();
          toast.info('Bağlantı kesildi');
        },
        onError: () => toast.error('Bağlantı kesilemedi'),
      },
    );
  };

  const copyCode = async () => {
    if (!status?.pairingCode) return;
    try {
      await navigator.clipboard.writeText(status.pairingCode.replace(/-/g, ''));
      setCopied(true);
      toast.success('Kod kopyalandı');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Kopyalanamadı');
    }
  };

  if (!status) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isIdle = status.state === 'disconnected' || !status.state;
  const isBusy =
    status.state === 'connecting' ||
    status.state === 'qr_ready' ||
    status.state === 'pairing_code_ready';

  return (
    <div className="max-w-md mx-auto mt-12 animate-in fade-in zoom-in-95 duration-300">
      <Card className="border-border/60 bg-card/60 backdrop-blur shadow-2xl relative overflow-hidden">
        {status.state === 'connected' && (
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary to-transparent" />
        )}
        <CardHeader className="text-center pb-2 pt-8">
          <CardTitle className="text-2xl font-bold font-sans">WhatsApp Bağlantısı</CardTitle>
          <CardDescription className="text-muted-foreground mt-2">
            QR kod veya telefon kodu ile bağlanın.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center pt-6 pb-10 px-8 min-h-[300px] justify-center">

          {isIdle && (
            <div className="flex flex-col items-center space-y-5 w-full animate-in fade-in slide-in-from-bottom-4">
              <div className="w-24 h-24 rounded-full bg-muted/50 flex items-center justify-center border border-border">
                <WifiOff className="w-10 h-10 text-muted-foreground opacity-50" />
              </div>

              <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/50 border border-border w-full">
                <button
                  type="button"
                  onClick={() => setMode('qr')}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    mode === 'qr'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  QR Kod
                </button>
                <button
                  type="button"
                  onClick={() => setMode('code')}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    mode === 'code'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Kod ile Giriş
                </button>
              </div>

              {mode === 'qr' ? (
                <>
                  <p className="text-center text-sm text-muted-foreground max-w-[280px]">
                    Telefondaki WhatsApp ile QR kodu okutarak bağlanın.
                  </p>
                  <Button
                    onClick={handleQrConnect}
                    disabled={connect.isPending}
                    size="lg"
                    className="w-full font-medium shadow-lg text-primary-foreground bg-primary hover:bg-primary/90"
                  >
                    {connect.isPending ? (
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    ) : (
                      <QrCode className="mr-2 h-5 w-5" />
                    )}
                    QR ile Bağlan
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-center text-sm text-muted-foreground max-w-[300px]">
                    Numaranızı ülke koduyla yazın. Çıkan 8 haneli kodu telefona girin.
                  </p>
                  <div className="w-full space-y-2">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Telefon (ülke kodu ile)
                    </label>
                    <Input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="905321234567"
                      inputMode="tel"
                      className="font-mono text-center text-lg tracking-wide bg-background"
                    />
                    <p className="text-xs text-muted-foreground text-center">
                      Örnek: 905321234567 — başta 0 olmasın
                    </p>
                  </div>
                  <Button
                    onClick={handleCodeConnect}
                    disabled={connect.isPending}
                    size="lg"
                    className="w-full font-medium shadow-lg text-primary-foreground bg-primary hover:bg-primary/90"
                  >
                    {connect.isPending ? (
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    ) : (
                      <KeyRound className="mr-2 h-5 w-5" />
                    )}
                    Kod Al
                  </Button>
                </>
              )}
            </div>
          )}

          {status.state === 'connecting' && (
            <div className="flex flex-col items-center space-y-6 w-full animate-in fade-in zoom-in">
              <div className="relative w-24 h-24 flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
                <Smartphone className="w-8 h-8 text-primary opacity-80" />
              </div>
              <p className="text-center font-medium animate-pulse text-primary tracking-wide">
                Bağlanıyor...
              </p>
              <Button variant="outline" onClick={handleCancel} disabled={cancelling} className="w-full">
                {cancelling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                İptal
              </Button>
            </div>
          )}

          {status.state === 'qr_ready' && status.qrCode && (
            <div className="flex flex-col items-center space-y-6 w-full animate-in fade-in slide-in-from-bottom-4">
              <div className="p-3 bg-white rounded-xl shadow-xl border-4 border-muted">
                <img src={status.qrCode} alt="WhatsApp QR Code" className="w-56 h-56 object-contain" />
              </div>
              <div className="bg-muted/40 p-4 rounded-lg w-full text-left border border-border/50">
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside font-medium">
                  <li>WhatsApp&apos;ı açın</li>
                  <li><strong>Bağlı Cihazlar</strong> menüsüne girin</li>
                  <li>QR Kodu taratın</li>
                </ol>
              </div>
              <Button variant="outline" onClick={handleCancel} disabled={cancelling} className="w-full text-sm">
                {cancelling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                İptal
              </Button>
            </div>
          )}

          {status.state === 'qr_ready' && !status.qrCode && (
            <div className="flex flex-col items-center space-y-4 w-full">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">QR hazırlanıyor…</p>
              <Button variant="outline" onClick={handleCancel} disabled={cancelling} className="w-full">
                İptal
              </Button>
            </div>
          )}

          {status.state === 'pairing_code_ready' && status.pairingCode && (
            <div className="flex flex-col items-center space-y-6 w-full animate-in fade-in slide-in-from-bottom-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                <KeyRound className="w-7 h-7 text-primary" />
              </div>
              <div className="text-center space-y-2 w-full">
                <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                  Eşleştirme Kodu
                </p>
                <button
                  type="button"
                  onClick={copyCode}
                  className="w-full group relative rounded-xl border border-primary/30 bg-primary/10 px-4 py-5 hover:bg-primary/15 transition-colors"
                >
                  <span className="font-mono text-3xl font-bold tracking-[0.2em] text-primary">
                    {status.pairingCode}
                  </span>
                  <span className="absolute right-3 top-3 text-muted-foreground opacity-60 group-hover:opacity-100">
                    {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
                  </span>
                </button>
                <p className="text-xs text-amber-500">Kod ~1 dk geçerli — hemen girin</p>
              </div>
              <div className="bg-muted/40 p-4 rounded-lg w-full text-left border border-border/50">
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside font-medium">
                  <li>WhatsApp → <strong>Bağlı Cihazlar</strong></li>
                  <li><strong>Cihaz bağla</strong></li>
                  <li><strong>Telefon numarası ile bağla</strong></li>
                  <li>Yukarıdaki kodu girin (tire ile veya tiresiz)</li>
                </ol>
              </div>
              <Button variant="outline" onClick={handleCancel} disabled={cancelling} className="w-full text-sm">
                {cancelling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                İptal / Yeniden Dene
              </Button>
            </div>
          )}

          {status.state === 'connected' && (
            <div className="flex flex-col items-center space-y-6 w-full animate-in fade-in slide-in-from-bottom-4">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl" />
                <div className="w-24 h-24 rounded-full bg-card border border-primary/30 flex items-center justify-center relative z-10">
                  <Smartphone className="w-10 h-10 text-primary" />
                </div>
              </div>

              <div className="text-center space-y-1.5 w-full p-5 bg-background rounded-xl border border-border/60 shadow-inner">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Bağlı Hesap</p>
                <p className="font-bold text-xl text-foreground">{status.pushName || 'Kullanıcı'}</p>
                <p className="text-sm text-primary font-mono bg-primary/10 inline-block px-2 py-0.5 rounded">
                  {status.phone || 'Numara gizli'}
                </p>
              </div>

              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnect.isPending}
                className="w-full mt-4 text-destructive hover:bg-destructive hover:text-destructive-foreground hover:border-destructive transition-colors"
              >
                {disconnect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Bağlantıyı Kes
              </Button>
            </div>
          )}

          {isBusy && (
            <p className="sr-only">login-in-progress</p>
          )}

        </CardContent>
      </Card>
    </div>
  );
}
