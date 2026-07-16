import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { 
  WhatsAppStatus, 
  useGetWhatsappGroups, 
  useGetSelectedGroups, 
  useSaveSelectedGroups,
  getGetSelectedGroupsQueryKey,
  getGetWhatsappGroupsQueryKey
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Loader2, Search, Users, AlertCircle, Save, CheckSquare, Radio } from 'lucide-react';
import { toast } from 'sonner';

export function GroupsTab({ status }: { status?: WhatsAppStatus }) {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: groups, isLoading: groupsLoading } = useGetWhatsappGroups({
    query: { 
      queryKey: getGetWhatsappGroupsQueryKey(),
      enabled: !!status?.connected 
    }
  });
  
  const { data: selectedGroups, isLoading: selectedLoading } = useGetSelectedGroups({
    query: { 
      queryKey: getGetSelectedGroupsQueryKey(),
      enabled: !!status?.connected 
    }
  });

  const saveMutation = useSaveSelectedGroups();

  useEffect(() => {
    if (selectedGroups?.groupIds) {
      setSelectedIds(new Set(selectedGroups.groupIds));
    }
  }, [selectedGroups]);

  const toggleGroup = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleAll = (select: boolean) => {
    if (!groups) return;
    if (select) {
      const filtered = groups.filter(g => g.name.toLowerCase().includes(searchTerm.toLowerCase()));
      const newSelected = new Set(selectedIds);
      filtered.forEach(g => newSelected.add(g.id));
      setSelectedIds(newSelected);
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSave = () => {
    saveMutation.mutate({ data: { groupIds: Array.from(selectedIds) } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSelectedGroupsQueryKey() });
        toast.success("Grup ve kanal seçimleri kaydedildi");
      },
      onError: () => toast.error("Kaydetme işlemi başarısız oldu")
    });
  };

  if (!status?.connected) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[50vh] text-muted-foreground space-y-6">
        <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center">
          <AlertCircle className="w-10 h-10 opacity-50" />
        </div>
        <p className="text-xl font-medium">Önce WhatsApp'a bağlanın</p>
        <p className="text-sm text-center max-w-sm">Grup ve kanalları görüntülemek için aktif bir WhatsApp bağlantısı gereklidir.</p>
      </div>
    );
  }

  if (groupsLoading || selectedLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[50vh] space-y-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-muted-foreground animate-pulse">Gruplar ve kanallar yükleniyor...</p>
      </div>
    );
  }

  const filteredGroups = groups?.filter(g => 
    g.name.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  const filteredGroupsOnly = filteredGroups.filter(g => g.type === 'group');
  const filteredChannels = filteredGroups.filter(g => g.type === 'channel');

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-160px)] animate-in fade-in duration-300">
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between bg-card/80 backdrop-blur p-4 rounded-xl border border-border shadow-sm shrink-0">
        <div className="relative w-full md:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Grup veya kanal ara..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 bg-background border-border/50 focus-visible:ring-primary/50"
          />
        </div>
        
        <div className="flex gap-2 w-full md:w-auto">
          <Button variant="secondary" onClick={() => toggleAll(true)} className="flex-1 md:flex-none h-10">
            <CheckSquare className="w-4 h-4 mr-2" />
            Tümünü Seç
          </Button>
          <Button variant="ghost" onClick={() => toggleAll(false)} className="flex-1 md:flex-none h-10">
            Temizle
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={saveMutation.isPending}
            className="flex-1 md:flex-none gap-2 bg-primary hover:bg-primary/90 text-primary-foreground h-10 px-6 font-semibold"
          >
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Kaydet ({selectedIds.size})
          </Button>
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground border border-dashed border-border rounded-xl bg-card/30">
          <Search className="w-12 h-12 mb-4 opacity-20" />
          <p>Arama kriterine uygun sonuç bulunamadı.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-6">
          {filteredGroupsOnly.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3 px-1">
                <Users className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Gruplar ({filteredGroupsOnly.length})
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {filteredGroupsOnly.map((group) => {
                  const isSelected = selectedIds.has(group.id);
                  return (
                    <Card
                      key={group.id}
                      className={`cursor-pointer transition-all duration-200 overflow-hidden group hover:-translate-y-0.5 hover:shadow-md ${
                        isSelected
                          ? 'border-primary bg-primary/5 shadow-[0_0_10px_rgba(37,211,102,0.1)]'
                          : 'border-border/50 bg-card hover:border-primary/30'
                      }`}
                      onClick={() => toggleGroup(group.id)}
                    >
                      <div className="p-4 flex gap-4 items-start">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleGroup(group.id)}
                          onClick={(e) => e.stopPropagation()}
                          className={`mt-1 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground ${isSelected ? 'border-primary' : 'border-muted-foreground/40'}`}
                        />
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-sm leading-tight line-clamp-2 text-foreground/90 group-hover:text-foreground">
                            {group.name}
                          </h3>
                          <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground font-medium">
                            <Users className="w-3.5 h-3.5" />
                            <span>{group.participantCount || '?'} üye</span>
                          </div>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {filteredChannels.length > 0 ? (
            <div>
              <div className="flex items-center gap-2 mb-3 px-1">
                <Radio className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Kanallar ({filteredChannels.length})
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {filteredChannels.map((channel) => {
                  const isSelected = selectedIds.has(channel.id);
                  return (
                    <Card
                      key={channel.id}
                      className={`cursor-pointer transition-all duration-200 overflow-hidden group hover:-translate-y-0.5 hover:shadow-md ${
                        isSelected
                          ? 'border-primary bg-primary/5 shadow-[0_0_10px_rgba(37,211,102,0.1)]'
                          : 'border-border/50 bg-card hover:border-primary/30'
                      }`}
                      onClick={() => toggleGroup(channel.id)}
                    >
                      <div className="p-4 flex gap-4 items-start">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleGroup(channel.id)}
                          onClick={(e) => e.stopPropagation()}
                          className={`mt-1 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground ${isSelected ? 'border-primary' : 'border-muted-foreground/40'}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] uppercase tracking-wide font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                              Kanal
                            </span>
                          </div>
                          <h3 className="font-semibold text-sm leading-tight line-clamp-2 text-foreground/90 group-hover:text-foreground">
                            {channel.name}
                          </h3>
                          <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground font-medium">
                            <Radio className="w-3.5 h-3.5" />
                            <span>{channel.participantCount ? `${channel.participantCount.toLocaleString('tr')} abone` : 'Kanal'}</span>
                          </div>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-card/30 px-4 py-6 text-center text-sm text-muted-foreground">
              Abone olunan WhatsApp kanalı bulunamadı. Telefonda kanala abone
              olduktan sonra sayfayı yenileyin; &quot;Tümünü Seç&quot; grup + kanal
              seçer.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
