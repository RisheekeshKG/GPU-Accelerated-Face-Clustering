import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Auth from './pages/Auth.tsx';
import Dashboard from './pages/Dashboard.tsx';
import CreateProject from './pages/CreateProject.tsx';
import ProjectEditor from './pages/ProjectEditor.tsx';
import CustomerProject from './pages/CustomerProject.tsx';
import NotFound from './pages/NotFound.tsx';
import AppShell from './pages/AppShell.tsx';
import FaceSearch from './pages/FaceSearch.tsx'; // ✅ import this
import { loadStore } from './utils/storage';

function Protected({ children }: { children: React.ReactElement }) {
  const location = useLocation();
  const store = loadStore();
  const uid = store.sessions.currentUserId;
  if (!uid) return <Navigate to="/" replace state={{ from: location }} />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Auth />} />

      <Route
        path="/app"
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="create" element={<CreateProject />} />
        <Route path="project/:slug" element={<ProjectEditor />} />

        {/* ✅ Add Face Search page */}
        <Route path="face-search" element={<FaceSearch />} />

      </Route>

      <Route path="/project/:slug" element={<CustomerProject />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
