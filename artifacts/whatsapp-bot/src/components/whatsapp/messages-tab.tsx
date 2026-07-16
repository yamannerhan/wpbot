import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useGetMessageStats, 
  useGetMessages, 
  useFetchMessages, 
  useClearMessages,
  getGetMessagesQueryKey,
  getGetMessageStatsQueryKey,
  WhatsAppMessage
} from '@workspace/api-client-react';
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
} from "@/components/ui/alert-dialog";
import { Loader2, Search, History, Trash2, MessageSquare, Clock, Users, Hash, RefreshCcw } from 'lucide-react';
import { toast } from 'sonner';

export function MessagesTab() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimeout = useRef<NodeJS.Timeout>(null);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setDebouncedSearch(e.target.value);
    }, 500);
  };

  const { data: stats } = useGetMessageStats({
    query: { 
      queryKey: getGetMessageStatsQueryKey(),
      refetchInterval: 30000 
    }
  });

  const { data: messagesPage, isLoading: messagesLoading, refetch: refetchMessages, isRefetching } = useGetMessages({
    search: debouncedSearch || undefined,
    limit: 100
  });

  const fetchHistory = useFetchMessages();
  const clearPool = useClearMessages();

  const handleFetchHistory = () => {
    fetchHistory.mutate(undefined, {
      onSuccess: (data) => {
        const msg =
          (data as { message?: string })?.message ||
          "Geçmiş mesajları çekme işlemi başlatıldı.";
        toast.success(msg);
        // History arrives async — refresh a few times
        const refresh = () => {
          queryClient.invalidateQueries({ queryKey: getGetMessageStatsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
        };
        refresh();
        setTimeout(refresh, 3000);
        setTimeout(refresh, 8000);
      },
      onError: () => toast.error("İşlem başlatılamadı. Grup seçili ve WhatsApp bağlı mı?"),
    });
  };

  const handleClearPool = () => {
    clearPool.mutate(undefined, {
      onSuccess: (data) => {
        const msg =
          (data as { message?: string })?.message ||
          "Havuz sıfırlandı — 15 gün yeniden taranıyor.";
        toast.success(msg);
        const refresh = () => {
          queryClient.invalidateQueries({ queryKey: getGetMessageStatsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMessagesQueryKey() });
        };
        refresh();
        setTimeout(refresh, 3000);
        setTimeout(refresh, 8000);
      },
      onError: () => toast.error("Havuz sıfırlanamadı."),
    });
  };

  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return new Intl.DateTimeFormat('tr-TR', { 
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' 
      }).format(date);
    } catch {
      return isoString;
    }
  };

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-160px)] animate-in fade-in duration-300">
      {/* Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 shrink-0">
        <Card className="bg-card/80 backdrop-blur border-border/50 p-4 shadow-sm flex flex-col justify-center relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-primary/10 rounded-full blur-xl group-hover:bg-primary/20 transition-colors" />
          <div className="flex items-center gap-2 mb-2">
            <Hash className="w-4 h-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Toplam Mesaj</p>
          </div>
          <p className="text-3xl font-bold text-primary font-mono">{stats?.total || 0}</p>
        </Card>
        
        <Card className="bg-card/80 backdrop-blur border-border/50 p-4 shadow-sm flex flex-col justify-center relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-blue-500/10 rounded-full blur-xl group-hover:bg-blue-500/20 transition-colors" />
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Dinlenen Grup</p>
          </div>
          <p className="text-3xl font-bold font-mono">
            {stats?.selectedGroupCount ?? stats?.groups?.length ?? 0}
          </p>
        </Card>
        
        <Card className="bg-card/80 backdrop-blur border-border/50 p-4 shadow-sm flex flex-col justify-center">
          <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider mb-2">Durum</p>
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full shadow-sm ${stats?.listening ? 'bg-primary shadow-[0_0_8px_rgba(37,211,102,0.8)] animate-pulse' : 'bg-muted-foreground'}`} />
            <span className="font-semibold text-lg">{stats?.listening ? 'Aktif Dinleme' : 'Beklemede'}</span>
          </div>
        </Card>
        
        <Card className="bg-card/80 backdrop-blur border-border/50 p-4 shadow-sm flex flex-col justify-center">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Sonraki Kontrol</p>
          </div>
          <p className="text-lg font-medium font-mono text-muted-foreground">
            {stats?.nextFetchAt ? formatTime(stats.nextFetchAt) : '-- : --'}
          </p>
        </Card>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col md:flex-row gap-4 justify-between bg-card/80 backdrop-blur p-3 rounded-xl border border-border shadow-sm shrink-0">
        <div className="relative w-full md:w-[400px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Mesaj içeriği, gönderen veya grup ara..." 
            value={searchTerm}
            onChange={handleSearchChange}
            className="pl-9 bg-background border-border/50 focus-visible:ring-primary/50"
          />
        </div>
        <div className="flex gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0">
          <Button 
            variant="outline" 
            size="icon"
            onClick={() => refetchMessages()}
            disabled={isRefetching}
            className="shrink-0 bg-background hover:text-primary hover:border-primary/50"
            title="Yenile"
          >
            <RefreshCcw className={`w-4 h-4 ${isRefetching ? 'animate-spin' : ''}`} />
          </Button>
          
          <Button 
            variant="outline" 
            onClick={handleFetchHistory}
            disabled={fetchHistory.isPending}
            className="gap-2 bg-background whitespace-nowrap"
          >
            {fetchHistory.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
            Geçmiş Tara (max 15 gün)
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-2 whitespace-nowrap bg-destructive/90 hover:bg-destructive text-destructive-foreground">
                <Trash2 className="w-4 h-4" />
                Sıfırla + 15 Gün Tara
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="bg-card border-border">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-xl">Havuzu sıfırla?</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground text-base">
                  Havuz temizlenir ve son 15 gün yeniden taranır. Aynı içerikli ilanlar tekrar havuza alınabilir (fabrika sıfırlaması).
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="mt-4">
                <AlertDialogCancel className="bg-background">İptal</AlertDialogCancel>
                <AlertDialogAction onClick={handleClearPool} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Evet, Sıfırla ve Tara
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Message List */}
      <Card className="flex-1 border-border/60 overflow-hidden flex flex-col bg-background/50 shadow-inner rounded-xl relative">
        {messagesLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center space-y-4">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-muted-foreground animate-pulse">Mesajlar yükleniyor...</p>
          </div>
        ) : !messagesPage?.messages?.length ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <MessageSquare className="w-16 h-16 opacity-10 mb-6" />
            <p className="text-lg">Havuzda henüz mesaj bulunmuyor.</p>
            <p className="text-sm mt-2 opacity-70 max-w-md text-center">
              Gruplar sekmesinden grup seçin. Yeni gelen mesajlar otomatik kaydolur.
              İlk mesajdan sonra &quot;Geçmiş Çek&quot; ile daha fazla çekebilirsiniz.
            </p>
            {debouncedSearch && <p className="text-sm mt-2 opacity-70">Arama kriterlerinizi değiştirerek tekrar deneyin.</p>}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3 md:p-5 space-y-3 custom-scrollbar">
            {messagesPage.messages.map((msg: WhatsAppMessage) => (
              <div 
                key={msg.id} 
                className="bg-card rounded-xl p-4 md:p-5 border border-border/80 hover:border-primary/40 transition-colors shadow-sm relative group flex flex-col gap-3"
              >
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2 sm:gap-4">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 shrink-0 font-medium px-2 py-0.5 rounded-md">
                      {msg.groupName}
                    </Badge>
                    <span className="text-sm font-semibold text-foreground/80 truncate flex items-center gap-1.5" title={msg.sender}>
                      {msg.sender}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground shrink-0 bg-muted/50 px-2 py-1 rounded-md">
                    <Clock className="w-3.5 h-3.5" />
                    {formatTime(msg.timestamp)}
                  </div>
                </div>
                
                <div className="text-sm md:text-base text-foreground/90 whitespace-pre-wrap leading-relaxed font-sans mt-1">
                  {msg.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
