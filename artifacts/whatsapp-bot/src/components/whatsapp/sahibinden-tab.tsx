import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Loader2, History, Trash2, ExternalLink, Clock, Radio, LogIn } from 'lucide-react';
import { toast } from 'sonner';

const DEFAULT_URL =
  'https://www.sahibinden.com/koruma-guvenlik-guvenlik-gorevlisi-is-ilanlari';
const DEFAULT_LOGIN =
  'https://secure.sahibinden.com/giris?return_url=https%3A%2F%2Fwww.sahibinden.com%2Fkoruma-guvenlik-guvenlik-gorevlisi-is-ilanlari';

type Status = {
  listening: boolean;
  url: string;
  lastFetchAt: string | null;
  nextFetchAt: string | null;
  total: number;
  lastAdded: number;
  lastError: string | null;
  loggedIn?: boolean;
  loginUrl?: string;
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
  const [loading, setLoading] = useState(true);

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
      toast.error('Durum alınamadı');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  const saveUrl = async () => {
    await fetch(`${apiBase()}/sahibinden/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    toast.success('Link kaydedildi');
    refresh();
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
            Oturum
          </p>
          <Badge variant={status?.loggedIn ? 'default' : 'destructive'}>
            {status?.loggedIn ? 'Kayıtlı' : 'Yok'}
          </Badge>
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
              Dinleme
            </p>
          </div>
          <p className="text-sm font-semibold">
            {status?.listening ? '30 dk (PC)' : 'Kapalı'}
          </p>
        </Card>
      </div>

      <Card className="p-4 border-border/50 space-y-4 shrink-0">
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
          <p className="font-semibold flex items-center gap-2">
            <LogIn className="w-4 h-4" />
            Nasıl çalışır?
          </p>
          <ol className="text-sm text-muted-foreground list-decimal pl-5 space-y-1">
            <li>
              Projede <code className="text-foreground">Sahibinden-Giris.cmd</code> çift tıkla
            </li>
            <li>Açılan Chrome&apos;da <strong>Google ile giriş</strong> yap</li>
            <li>
              Güvenlik görevlisi <strong>ilan listesini görünce</strong> siyah pencerede{' '}
              <strong>Enter</strong>&apos;a bas
            </li>
            <li>İlanlar buraya düşer; sonrası PC açıkken 30 dk&apos;da bir otomatik</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Not: Railway sunucu IP&apos;si ilan listesini göremez. Çekim senin bilgisayarındaki
            girişli Chrome oturumuyla yapılır; panelde sadece sonuç görünür.
          </p>
          <Button asChild variant="secondary" size="sm">
            <a href={status?.loginUrl || DEFAULT_LOGIN} target="_blank" rel="noreferrer">
              Giriş sayfasını tarayıcıda aç
            </a>
          </Button>
        </div>

        <div className="flex flex-col md:flex-row gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1" />
          <Button variant="secondary" onClick={saveUrl}>
            Linki Kaydet
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={refresh} className="gap-2">
            <History className="w-4 h-4" />
            Listeyi Yenile
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
                <AlertDialogTitle>Temizle?</AlertDialogTitle>
                <AlertDialogDescription>
                  Sahibinden ilanları silinir. Tekrar çekmek için Sahibinden-Giris.cmd veya
                  otomatik görev gerekir.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>İptal</AlertDialogCancel>
                <AlertDialogAction onClick={clearPool}>Evet</AlertDialogAction>
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
              <p>Henüz ilan yok.</p>
              <p className="text-sm mt-2">Sahibinden-Giris.cmd → Google giriş → Enter</p>
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
