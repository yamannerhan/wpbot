import { WhatsAppStatus } from '@workspace/api-client-react';
import { Activity } from 'lucide-react';
import { Link } from 'wouter';

export function Header({ status }: { status?: WhatsAppStatus }) {
  const isConnected = status?.state === 'connected';
  
  return (
    <header className="border-b border-border/50 bg-card/80 backdrop-blur-md px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center text-primary shadow-[0_0_15px_rgba(37,211,102,0.15)]">
          <Activity className="w-5 h-5" />
        </div>
        <h1 className="font-semibold text-lg tracking-tight hidden sm:block">
          İlan <span className="text-primary font-bold">Toplayıcı</span>
        </h1>
      </div>
      
      <div className="flex items-center gap-3">
        <Link href="/setup" className="text-xs text-muted-foreground hover:text-foreground transition-colors hidden sm:inline">
          Kurulum
        </Link>
        <div className="flex items-center gap-2 text-sm bg-background px-3 py-1.5 rounded-full border border-border shadow-inner">
          <div className={`w-2 h-2 rounded-full shadow-sm ${
            isConnected ? 'bg-primary shadow-[0_0_8px_rgba(37,211,102,0.8)]' : 
            status?.state === 'qr_ready' ? 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.8)]' :
            status?.state === 'connecting' ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]' :
            'bg-destructive shadow-[0_0_8px_rgba(220,38,38,0.8)]'
          }`} />
          <span className="font-medium text-muted-foreground uppercase tracking-wider text-xs">
            {status?.state === 'connected' ? 'Bağlı' : 
             status?.state === 'qr_ready' ? 'QR Okutulacak' : 
             status?.state === 'connecting' ? 'Bağlanıyor...' : 'Bağlantı Yok'}
          </span>
        </div>
      </div>
    </header>
  );
}
