import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { LayoutShell } from "@/components/layout-shell";
import { Loader2 } from "lucide-react";
import { useSystemStatus } from "@/hooks/use-system-status";
import { ApiGate } from "@/components/api-gate";
import { isSetupGateDismissed, resetSetupGate } from "@/lib/setup-gate";

import Login from "@/pages/login";
import CommandCenter from "@/pages/command-center";
import AssetDetail from "@/pages/asset-detail";
import Dashboard from "@/pages/dashboard";
import EquipmentList from "@/pages/equipment-list";
import RentalsList from "@/pages/rentals-list";
import NotFound from "@/pages/not-found";
import MaintenanceLog from "./pages/maintenance-log";
import JobSitesList from '@/pages/job-sites-list';
import VendorsList from '@/pages/vendors-list';
import PredictiveMaintenanceDashboard from '@/pages/predictive-maintenance-dashboard';
import MLPerformanceDashboard from "./pages/ml-dashboard";
import MaintenanceCostReport from "@/pages/maintenance-cost-report";
import SetupPage from "@/pages/setup";


// Protected Route Wrapper — also redirects to /setup when system is empty
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  const { data: systemStatus, isLoading: statusLoading } = useSystemStatus();

  if (isLoading || (user && statusLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  // Send first-time visitors to setup, unless they chose Start Fresh there.
  // Without that exemption the choice is unreachable: it means "I will add my
  // own equipment", and seeded is equipmentCount > 0, so the guard bounces
  // them back to the page they just left.
  if (systemStatus && !systemStatus.seeded && !isSetupGateDismissed()) {
    return <Redirect to="/setup" />;
  }

  // Once data exists the choice has served its purpose. Clearing it means a
  // later reset shows setup again rather than skipping it forever.
  if (systemStatus?.seeded) resetSetupGate();

  return (
    <LayoutShell>
      <Component />
    </LayoutShell>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/setup" component={SetupPage} />

      {/* Protected Routes */}
      <Route path="/">
        <ProtectedRoute component={CommandCenter} />
      </Route>
      <Route path="/financial">
        <ProtectedRoute component={Dashboard} />
      </Route>
      <Route path="/assets/:id">
        <ProtectedRoute component={AssetDetail} />
      </Route>
      <Route path="/equipment">
        <ProtectedRoute component={EquipmentList} />
      </Route>
      <Route path="/rentals">
        <ProtectedRoute component={RentalsList} />
      </Route>
      <Route path="/maintenance">
        <ProtectedRoute component={MaintenanceLog} />
      </Route>
      <Route path="/job-sites">
        <ProtectedRoute component={JobSitesList} />
      </Route> 
      <Route path="/vendors">
        <ProtectedRoute component={VendorsList} />
      </Route>
      <Route path="/predictive-maintenance">
        <ProtectedRoute component={PredictiveMaintenanceDashboard} />
      </Route>
      <Route path="/ml-performance">
        <ProtectedRoute component={MLPerformanceDashboard} />
      </Route>
      <Route path="/maintenance-costs">
        <ProtectedRoute component={MaintenanceCostReport} />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Outside AuthProvider on purpose: the session lookup is itself an
          API call, so it must not fire until the API has answered. */}
      <ApiGate>
        <AuthProvider>
          <Router />
          <Toaster />
        </AuthProvider>
      </ApiGate>
    </QueryClientProvider>
  );
}

export default App;
