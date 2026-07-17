import { Link } from 'wouter';
import { MessagesTab } from '@/components/whatsapp/messages-tab';
import { Header } from '@/components/layout/header';
import { useGetWhatsappStatus, getGetWhatsappStatusQueryKey } from '@workspace/api-client-react';

/** Ayrı Medya Havuzu sayfası — bot / bookmark için sabit link: /medya */
export default function MediaPoolPage() {
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
        <div className="w-full justify-start border-b border-border/50 mb-6 flex gap-2 sm:gap-6 overflow-x-auto shrink-0">
          <Link
            href="/"
            className="rounded-none border-b-2 border-transparent px-2 sm:px-4 py-3 text-muted-foreground hover:text-foreground transition-all whitespace-nowrap text-sm font-medium"
          >
            Ana Panel
          </Link>
          <span className="rounded-none border-b-2 border-primary px-2 sm:px-4 py-3 text-primary whitespace-nowrap text-sm font-medium">
            Medya Havuzu
          </span>
        </div>
        <MessagesTab pool="media" />
      </main>
    </div>
  );
}
