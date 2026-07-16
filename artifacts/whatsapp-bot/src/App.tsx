import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import SetupWizard, { isSetupComplete } from '@/pages/setup-wizard';
import { Route, Switch, Router as WouterRouter, Redirect } from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function HomeRedirect() {
  if (!isSetupComplete()) {
    return <Redirect to="/setup" />;
  }
  return <Dashboard />;
}

function Router() {
  return (
    <Switch>
      <Route path="/setup" component={SetupWizard} />
      <Route path="/" component={HomeRedirect} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster theme="dark" position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
