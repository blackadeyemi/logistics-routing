import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ProgressBar } from './components/ui';
import { DriverApp } from './driver/DriverApp';
import { AdminLayout } from './layouts/AdminLayout';
import { StaffAuthProvider } from './lib/auth';
import { Dashboard } from './pages/Dashboard';
import { Drivers } from './pages/Drivers';
import { Knowledge } from './pages/Knowledge';
import { Login } from './pages/Login';
import { Optimize } from './pages/Optimize';
import { OrderDetail } from './pages/OrderDetail';
import { Orders } from './pages/Orders';
import { RoutePlanner } from './pages/RoutePlanner';
import { RoutesPage } from './pages/Routes';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';
import { Vehicles } from './pages/Vehicles';

export function App() {
  return (
    <BrowserRouter>
      <ProgressBar />
      <Routes>
        <Route path="/driver/*" element={<DriverApp />} />
        <Route path="*" element={
          <StaffAuthProvider>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<AdminLayout />}>
                <Route index element={<Dashboard />} />
                <Route path="orders" element={<Orders />} />
                <Route path="orders/:id" element={<OrderDetail />} />
                <Route path="routes" element={<RoutesPage />} />
                <Route path="routes/optimize" element={<Optimize />} />
                <Route path="routes/:id" element={<RoutePlanner />} />
                <Route path="knowledge" element={<Knowledge />} />
                <Route path="drivers" element={<Drivers />} />
                <Route path="vehicles" element={<Vehicles />} />
                <Route path="users" element={<Users />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </StaffAuthProvider>
        } />
      </Routes>
    </BrowserRouter>
  );
}
