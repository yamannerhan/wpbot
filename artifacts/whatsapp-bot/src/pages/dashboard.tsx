import { Link } from 'wouter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConnectionTab } from '@/components/whatsapp/connection-tab';
import { GroupsTab } from '@/components/whatsapp/groups-tab';
import { MessagesTab } from '@/components/whatsapp/messages-tab';
import { SahibindenTab } from '@/components/whatsapp/sahibinden-tab';
import { Header } from '@/components/layout/header';
import { useGetWhatsappStatus, getGetWhatsappStatusQueryKey } from '@workspace/api-client-react';

const tabTriggerClass =
  'rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 sm:px-4 py-3 data-[state=active]:text-primary transition-all whitespace-nowrap';

const linkTabClass =
  'inline-flex items-center justify-center rounded-none border-b-2 border-transparent px-2 sm:px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground transition-all whitespace-nowrap';

export default function Dashboard() {
  const { data: status } = useGetWhatsappStatus({
    query: {
      queryKey: getGetWhatsappStatusQueryKey(),
      refetchInterval: (query) => {
        const state = (query.state.data as { state?: string } | undefined)?.state;
        return state === 'connecting' || state === 'qr_ready' || state === 'pairing_code_ready'
          ? 2000
          : state === 'connected'
            ? 10000
            : false;
      },
    },
  });

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col font-sans">
      <Header status={status} />
      <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">
        <Tabs defaultValue="messages" className="w-full h-full flex flex-col">
          <TabsList className="w-full justify-start border-b border-border/50 bg-transparent rounded-none p-0 h-auto mb-6 gap-2 sm:gap-6 overflow-x-auto shrink-0">
            <TabsTrigger value="connection" className={tabTriggerClass}>
              Bağlantı
            </TabsTrigger>
            <TabsTrigger
              value="groups"
              disabled={!status?.connected}
              className={`${tabTriggerClass} disabled:opacity-30 disabled:cursor-not-allowed`}
            >
              Gruplar & Kanallar
            </TabsTrigger>
            <TabsTrigger value="messages" className={tabTriggerClass}>
              Mesaj Havuzu
            </TabsTrigger>
            <Link href="/medya" className={linkTabClass} title="Ayrı sayfa — bot için /medya">
              Medya Havuzu
            </Link>
            <TabsTrigger value="sahibinden" className={tabTriggerClass}>
              Sahibinden
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 min-h-0">
            <TabsContent value="connection" className="mt-0 outline-none h-full">
              <ConnectionTab status={status} />
            </TabsContent>

            <TabsContent value="groups" className="mt-0 outline-none h-full">
              <GroupsTab status={status} />
            </TabsContent>

            <TabsContent value="messages" className="mt-0 outline-none h-full">
              <MessagesTab pool="text" />
            </TabsContent>

            <TabsContent value="sahibinden" className="mt-0 outline-none h-full">
              <SahibindenTab />
            </TabsContent>
          </div>
        </Tabs>
      </main>
    </div>
  );
}
