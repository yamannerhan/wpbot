import { WhatsAppStatus, useConnectWhatsapp, useDisconnectWhatsapp, getGetWhatsappStatusQueryKey } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, QrCode, Smartphone, WifiOff } from 'lucide-react';
import { toast } from 'sonner';

export function ConnectionTab({ status }: { status?: WhatsAppStatus }) {
  const queryClient = useQueryClient();
  const connect = useConnectWhatsapp();
  const disconnect = useDisconnectWhatsapp();

  const handleConnect = () => {
    connect.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
        toast.success("Bağlantı başlatıldı");
      },
      onError: () => toast.error("Bağlantı başlatılamadı")
    });
  };

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
        toast.info("Bağlantı kesildi");
      },
      onError: () => toast.error("Bağlantı kesilemedi")
    });
  };

  if (!status) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-12 animate-in fade-in zoom-in-95 duration-300">
      <Card className="border-border/60 bg-card/60 backdrop-blur shadow-2xl relative overflow-hidden">
        {status.state === 'connected' && (
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary to-transparent" />
        )}
        <CardHeader className="text-center pb-2 pt-8">
          <CardTitle className="text-2xl font-bold font-sans">WhatsApp Bağlantısı</CardTitle>
          <CardDescription className="text-muted-foreground mt-2">
            Sistem ile WhatsApp arasındaki bağlantıyı yönetin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center pt-8 pb-10 px-8 min-h-[300px] justify-center">
          
          {(status.state === 'disconnected' || !status.state) && (
            <div className="flex flex-col items-center space-y-6 w-full animate-in fade-in slide-in-from-bottom-4">
              <div className="w-24 h-24 rounded-full bg-muted/50 flex items-center justify-center border border-border">
                <WifiOff className="w-10 h-10 text-muted-foreground opacity-50" />
              </div>
              <p className="text-center text-sm text-muted-foreground max-w-[280px]">
                Mesaj toplayabilmek için cihazınızı bağlamanız gerekmektedir.
              </p>
              <Button 
                onClick={handleConnect} 
                disabled={connect.isPending}
                size="lg" 
                className="w-full font-medium shadow-lg hover:shadow-primary/20 transition-all text-primary-foreground bg-primary hover:bg-primary/90"
              >
                {connect.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <QrCode className="mr-2 h-5 w-5" />}
                Bağlantı Başlat
              </Button>
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
            </div>
          )}

          {status.state === 'qr_ready' && status.qrCode && (
            <div className="flex flex-col items-center space-y-6 w-full animate-in fade-in slide-in-from-bottom-4">
              <div className="p-3 bg-white rounded-xl shadow-xl border-4 border-muted relative group">
                <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg pointer-events-none" />
                <img src={status.qrCode} alt="WhatsApp QR Code" className="w-56 h-56 object-contain" />
              </div>
              <div className="bg-muted/40 p-4 rounded-lg w-full text-left border border-border/50">
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside font-medium">
                  <li>WhatsApp'ı açın</li>
                  <li><strong>Cihazları Bağla</strong> menüsüne girin</li>
                  <li>QR Kodu taratın</li>
                </ol>
              </div>
            </div>
          )}

          {status.state === 'connected' && (
            <div className="flex flex-col items-center space-y-6 w-full animate-in fade-in slide-in-from-bottom-4">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl" />
                <div className="w-24 h-24 rounded-full bg-card border border-primary/30 flex items-center justify-center relative z-10 shadow-[0_0_20px_rgba(37,211,102,0.1)]">
                  <Smartphone className="w-10 h-10 text-primary drop-shadow-[0_0_8px_rgba(37,211,102,0.5)]" />
                </div>
              </div>
              
              <div className="text-center space-y-1.5 w-full p-5 bg-background rounded-xl border border-border/60 shadow-inner">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Bağlı Hesap</p>
                <p className="font-bold text-xl text-foreground">{status.pushName || 'Kullanıcı'}</p>
                <p className="text-sm text-primary font-mono bg-primary/10 inline-block px-2 py-0.5 rounded">{status.phone || 'Numara gizli'}</p>
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
          
        </CardContent>
      </Card>
    </div>
  );
}
