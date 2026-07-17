import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Loader2, History, Trash2, ExternalLink, Clock, Radio } from 'lucide-react';
import { toast } from 'sonner';

const DEFAULT_URL =
  'https://www.sahibinden.com/koruma-guvenlik-guvenlik-gorevlisi-is-ilanlari';

type Status = {
  listening: boolean;
  url: string;
  lastFetchAt: string | null;
  nextFetchAt: string | null;
  total: number;
  lastAdded: number;
  lastError: string | null;
  hasProxy?: boolean;
  hasCookies?: boolean;
};

type Msg = {
  id: number;
  messageId: string;
  groupName: string;
  content: string;
  sender: string;
  timestamp: string;
};

function apiBase() {
  return '/api';
}

function formatAt(iso: string | null) {
  if (!iso) return '--';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function SahibindenTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [cookies, setCookies] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const refresh = async () => {
    try {
      const [sRes, mRes] = await Promise.all([
        fetch(`${apiBase()}/sahibinden/status`),
        fetch(`${apiBase()}/sahibinden/messages?limit=100`),
      ]);
      const s = await sRes.json();
      const m = await mRes.json();
      setStatus(s);
      if (s?.url) setUrl(s.url);
      setMessages(m?.messages || []);
    } catch {
      toast.error('Sahibinden durumu alınamadı');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, []);

  const saveUrl = async () => {
    await fetch(`${apiBase()}/sahibinden/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    toast.success('Sahibinden linki kaydedildi');
    refresh();
  };

  const saveCookies = async () => {
    await fetch(`${apiBase()}/sahibinden/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });
    toast.success('Cookie kaydedildi');
    refresh();
  };

  const scan = async (deep: boolean) => {
    setScanning(true);
    try {
      const res = await fetch(`${apiBase()}/sahibinden/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deep }),
      });
      const data = await res.json();
      if (String(data.message || '').includes('hata') || String(data.message || '').includes('engelledi')) {
        toast.error(data.message || 'Tarama başarısız');
      } else {
        toast.success(data.message || 'Tarama bitti');
      }
      await refresh();
    } catch {
      toast.error('Tarama başarısız');
    } finally {
      setScanning(false);
    }
  };

  const clearPool = async () => {
    const res = await fetch(`${apiBase()}/sahibinden/messages`, { method: 'DELETE' });
    const data = await res.json();
    toast.success(data.message || 'Temizlendi');
    refresh();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-160px)] animate-in fade-in duration-300">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
        <Card className="p-4 border-border/50">
          <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider mb-2">
            Toplam İlan
          </p>
          <p className="text-3xl font-bold text-primary font-mono">{status?.total ?? 0}</p>
        </Card>
        <Card className="p-4 border-border/50">
          <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider mb-2">
            Durum
          </p>
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                status?.listening ? 'bg-primary animate-pulse' : 'bg-muted-foreground'
              }`}
            />
            <span className="font-semibold">
              {status?.listening ? 'Dinlemede (30 dk)' : 'Kapalı'}
            </span>
          </div>
        </Card>
        <Card className="p-4 border-border/50">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">
              Son Tarama
            </p>
          </div>
          <p className="text-sm font-mono">{formatAt(status?.lastFetchAt ?? null)}</p>
        </Card>
        <Card className="p-4 border-border/50">
          <div className="flex items-center gap-2 mb-2">
            <Radio className="w-4 h-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">
              Sonraki
            </p>
          </div>
          <p className="text-sm font-mono">{formatAt(status?.nextFetchAt ?? null)}</p>
        </Card>
      </div>

      <Card className="p-4 border-border/50 space-y-3 shrink-0">
        <p className="text-sm text-muted-foreground">
          Sahibinden Railway (sunucu) IP&apos;lerini bot diye engeller. Siteye insan gibi
          (Chrome header + cookie + anasayfa ısınma) gidilir; yine 403 olursa ev IP&apos;si
          veya residential proxy gerekir.
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant={status?.hasProxy ? 'default' : 'secondary'}>
            Proxy: {status?.hasProxy ? 'açık' : 'yok'}
          </Badge>
          <Badge variant={status?.hasCookies ? 'default' : 'secondary'}>
            Cookie: {status?.hasCookies ? 'var' : 'yok'}
          </Badge>
        </div>
        <div className="flex flex-col md:flex-row gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={DEFAULT_URL}
            className="flex-1"
          />
          <Button variant="secondary" onClick={saveUrl}>
            Linki Kaydet
          </Button>
        </div>
        <div className="space-y-2">
          <Textarea
            value={cookies}
            onChange={(e) => setCookies(e.target.value)}
            placeholder="Chrome cookie (isteğe bağlı): F12 → Application → Cookies → sahibinden.com satırlarını name=value; name2=value2 olarak yapıştır"
            className="min-h-[72px] text-xs font-mono"
          />
          <Button variant="outline" size="sm" onClick={saveCookies}>
            Cookie Kaydet
          </Button>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">403 / bağlanmıyor — ne yapmalısın?</p>
          <p>
            Sahibinden, Railway ve Node isteklerini bot diye keser. En sağlam yol:
            kendi bilgisayarındaki Chrome ile köprü:
          </p>
          <p className="font-mono text-foreground break-all">
            $env:SAHIBINDEN_API=&quot;https://wphot-production-cf99.up.railway.app&quot;
            <br />
            pnpm sahibinden:bridge
          </p>
          <p>
            Alternatif: Railway Variables&apos;a Türk residential proxy:{' '}
            <code className="text-foreground">SAHIBINDEN_PROXY</code>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => scan(true)} disabled={scanning} className="gap-2">
            {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
            Yeniden Tara (15 gün)
          </Button>
          <Button variant="outline" onClick={() => scan(false)} disabled={scanning}>
            Hızlı Tara
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-2">
                <Trash2 className="w-4 h-4" />
                Havuzu Temizle
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Sahibinden havuzunu temizle?</AlertDialogTitle>
                <AlertDialogDescription>
                  Sadece Sahibinden ilanları silinir. Sonra Yeniden Tara ile max 15 gün
                  geri çekilir; dinleme yeni ilanları almaya devam eder.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>İptal</AlertDialogCancel>
                <AlertDialogAction onClick={clearPool}>Evet, Temizle</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {status?.lastError && (
          <p className="text-sm text-destructive whitespace-pre-wrap">{status.lastError}</p>
        )}
      </Card>

      <Card className="flex-1 overflow-hidden flex flex-col border-border/60">
        <div className="flex-1 overflow-y-auto p-3 md:p-5 space-y-3">
          {messages.length === 0 ? (
            <div className="text-center text-muted-foreground py-16">
              <p>Henüz Sahibinden ilanı yok.</p>
              <p className="text-sm mt-2 opacity-70">
                Proxy / cookie / yerel köprü ile tarama yapın.
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className="bg-card rounded-xl p-4 border border-border/80 space-y-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-orange-500/15 text-orange-600 border-orange-500/30">
                    Sahibinden
                  </Badge>
                  <span className="text-sm font-semibold truncate">{msg.sender}</span>
                  <span className="text-xs font-mono text-muted-foreground ml-auto">
                    {formatAt(msg.timestamp)}
                  </span>
                </div>
                <pre className="text-sm whitespace-pre-wrap font-sans text-foreground/90">
                  {msg.content}
                </pre>
                {/https?:\/\/\S+sahibinden\.com\S+/i.test(msg.content) && (
                  <a
                    href={msg.content.match(/https?:\/\/\S+sahibinden\.com\S+/i)?.[0]}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    İlanı aç
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
