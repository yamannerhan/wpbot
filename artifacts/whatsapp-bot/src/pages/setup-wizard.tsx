import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useGetWhatsappStatus,
  useConnectWhatsapp,
  getGetWhatsappStatusQueryKey,
  useGetWhatsappGroups,
  useSaveSelectedGroups,
  getGetSelectedGroupsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Database, Loader2, QrCode, Users, ArrowRight, KeyRound } from 'lucide-react';
import { toast } from 'sonner';

const SETUP_KEY = 'wa_setup_complete';

export function isSetupComplete(): boolean {
  try {
    return localStorage.getItem(SETUP_KEY) === '1';
  } catch {
    return true;
  }
}

export function markSetupComplete(): void {
  try {
    localStorage.setItem(SETUP_KEY, '1');
  } catch {
    // ignore
  }
}

type SetupInfo = {
  ok: boolean;
  database: boolean;
  databaseError: string | null;
  hasDatabaseUrl: boolean;
};

export default function SetupWizard() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(1);
  const [setupInfo, setSetupInfo] = useState<SetupInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [loginMode, setLoginMode] = useState<'qr' | 'code'>('qr');
  const [phone, setPhone] = useState('90');
  const queryClient = useQueryClient();

  const { data: status } = useGetWhatsappStatus({
    query: {
      queryKey: getGetWhatsappStatusQueryKey(),
      refetchInterval: (query) => {
        const state = (query.state.data as { state?: string } | undefined)?.state;
        return state === 'connecting' || state === 'qr_ready' || state === 'pairing_code_ready'
          ? 2000
          : false;
      },
      enabled: step >= 2,
    },
  });

  const connect = useConnectWhatsapp();
  const { data: groups, isFetching: groupsLoading } = useGetWhatsappGroups({
    query: {
      enabled: step === 3 && Boolean(status?.connected),
    },
  });
  const saveGroups = useSaveSelectedGroups();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/setup/status');
        const data = (await res.json()) as SetupInfo;
        if (!cancelled) {
          setSetupInfo(data);
          if (data.database) setStep(2);
        }
      } catch {
        if (!cancelled) {
          setSetupInfo({
            ok: false,
            database: false,
            databaseError: 'API erişilemedi',
            hasDatabaseUrl: false,
          });
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status?.connected && step === 2) {
      setStep(3);
    }
  }, [status?.connected, step]);

  const finish = () => {
    markSetupComplete();
    toast.success('Kurulum tamamlandı');
    setLocation('/');
  };

  const handleQrConnect = () => {
    connect.mutate(
      {},
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
          toast.success('QR kod hazırlanıyor…');
        },
        onError: () => toast.error('Bağlantı başlatılamadı'),
      },
    );
  };

  const handleCodeConnect = () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      toast.error('Ülke kodu ile numara girin (örn. 905321234567)');
      return;
    }
    connect.mutate(
      { data: { phoneNumber: digits } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
          toast.success('Eşleştirme kodu isteniyor…');
        },
        onError: () => toast.error('Kod oluşturulamadı'),
      },
    );
  };

  const toggleGroup = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSaveGroups = () => {
    if (selected.length === 0) {
      toast.error('En az bir grup seçin');
      return;
    }
    saveGroups.mutate(
      { data: { groupIds: selected } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSelectedGroupsQueryKey() });
          finish();
        },
        onError: () => toast.error('Gruplar kaydedilemedi'),
      },
    );
  };

  if (checking) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex items-center justify-center p-4">
      <Card className="w-full max-w-lg border-border/60 bg-card/80 shadow-xl">
        <CardHeader>
          <CardTitle className="text-2xl">Kurulum Sihirbazı</CardTitle>
          <CardDescription>
            3 adımda Railway üzerindeki botu hazırlayın. Ortam değişkenlerini Railway panelinden ayarlayın.
          </CardDescription>
          <div className="flex gap-3 pt-4">
            {[1, 2, 3].map((n) => (
              <div key={n} className="flex items-center gap-1.5 text-sm">
                {step > n ? (
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                ) : (
                  <Circle className={`w-4 h-4 ${step === n ? 'text-primary' : 'text-muted-foreground'}`} />
                )}
                <span className={step === n ? 'text-foreground font-medium' : 'text-muted-foreground'}>
                  {n === 1 ? 'Veritabanı' : n === 2 ? 'WhatsApp' : 'Gruplar'}
                </span>
              </div>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-border p-4">
                <Database className="w-5 h-5 mt-0.5 text-primary" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium">PostgreSQL bağlantısı</p>
                  <p className="text-muted-foreground">
                    Railway → Project → Variables içinde <code className="text-xs">DATABASE_URL</code> olmalı.
                    Postgres eklentisini bağlarsanız otomatik gelir.
                  </p>
                  <p className={setupInfo?.database ? 'text-green-500' : 'text-destructive'}>
                    {setupInfo?.database
                      ? 'Veritabanı bağlantısı başarılı'
                      : `Bağlantı yok: ${setupInfo?.databaseError || 'DATABASE_URL eksik'}`}
                  </p>
                </div>
              </div>
              <Button
                className="w-full"
                disabled={!setupInfo?.database}
                onClick={() => setStep(2)}
              >
                Devam <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/50 border border-border">
                <button
                  type="button"
                  onClick={() => setLoginMode('qr')}
                  className={`rounded-md px-3 py-2 text-sm font-medium ${
                    loginMode === 'qr' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  QR Kod
                </button>
                <button
                  type="button"
                  onClick={() => setLoginMode('code')}
                  className={`rounded-md px-3 py-2 text-sm font-medium ${
                    loginMode === 'code' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  Kod ile Giriş
                </button>
              </div>

              {status?.qrCode && loginMode === 'qr' && (
                <div className="flex justify-center">
                  <img
                    src={status.qrCode}
                    alt="WhatsApp QR"
                    className="w-56 h-56 rounded-lg border border-border bg-white p-2"
                  />
                </div>
              )}

              {status?.pairingCode && (
                <div className="text-center space-y-2 rounded-xl border border-primary/30 bg-primary/10 p-4">
                  <KeyRound className="w-5 h-5 text-primary mx-auto" />
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Eşleştirme Kodu</p>
                  <p className="font-mono text-3xl font-bold tracking-[0.2em] text-primary">
                    {status.pairingCode}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    WhatsApp → Bağlı Cihazlar → Telefon numarası ile bağla
                  </p>
                </div>
              )}

              {status?.connected ? (
                <p className="text-center text-green-500 text-sm font-medium">
                  Bağlandı{status.phone ? `: ${status.phone}` : ''}
                </p>
              ) : loginMode === 'qr' ? (
                <Button
                  className="w-full"
                  onClick={handleQrConnect}
                  disabled={connect.isPending || status?.state === 'connecting' || status?.state === 'qr_ready'}
                >
                  {(connect.isPending || status?.state === 'connecting') && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  <QrCode className="w-4 h-4 mr-2" />
                  {status?.qrCode ? 'QR bekleniyor…' : 'QR Oluştur'}
                </Button>
              ) : (
                <div className="space-y-3">
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="905321234567"
                    inputMode="tel"
                    className="font-mono text-center"
                  />
                  <Button
                    className="w-full"
                    onClick={handleCodeConnect}
                    disabled={
                      connect.isPending ||
                      status?.state === 'connecting' ||
                      status?.state === 'pairing_code_ready'
                    }
                  >
                    {(connect.isPending || status?.state === 'connecting') && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    <KeyRound className="w-4 h-4 mr-2" />
                    {status?.pairingCode ? 'Kod bekleniyor…' : 'Kod Al'}
                  </Button>
                </div>
              )}

              {status?.connected && (
                <Button className="w-full" onClick={() => setStep(3)}>
                  Devam <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-border p-4">
                <Users className="w-5 h-5 mt-0.5 text-primary" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium">İzlenecek grupları seç</p>
                  <p className="text-muted-foreground">
                    Sonra Mesaj Havuzu sekmesinden ilanları çekebilirsiniz.
                  </p>
                </div>
              </div>

              {groupsLoading && (
                <div className="flex justify-center py-6">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              )}

              <div className="max-h-56 overflow-y-auto space-y-2">
                {(groups || []).map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleGroup(g.id)}
                    className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors ${
                      selected.includes(g.id)
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:bg-muted/40'
                    }`}
                  >
                    <span className="font-medium">{g.name}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {g.participantCount} üye
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={finish}>
                  Atla
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleSaveGroups}
                  disabled={saveGroups.isPending}
                >
                  {saveGroups.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Kaydet ve Bitir
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
