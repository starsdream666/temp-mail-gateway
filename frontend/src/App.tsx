import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Upstreams } from './pages/Upstreams';
import { ApiKeys } from './pages/ApiKeys';
import { Mailboxes } from './pages/Mailboxes';
import { Domains } from './pages/Domains';
import { Health } from './pages/Health';
import { ApiDocs } from './pages/ApiDocs';
import { Settings } from './pages/Settings';

export const App: React.FC = () => {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* 登录页 */}
            <Route path="/login" element={<Login />} />

            {/* 管理后台受保护路由 */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/upstreams" replace />} />
              <Route path="upstreams" element={<Upstreams />} />
              <Route path="keys" element={<ApiKeys />} />
              <Route path="mailboxes" element={<Mailboxes />} />
              <Route path="domains" element={<Domains />} />
              <Route path="health" element={<Health />} />
              <Route path="api-docs" element={<ApiDocs />} />
              <Route path="settings" element={<Settings />} />
            </Route>

            {/* 未知路由重定向 */}
            <Route path="*" element={<Navigate to="/upstreams" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
};

export default App;
