import { Outlet, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { loadStore, saveStore } from '../utils/storage';

export default function AppShell() {
  const nav = useNavigate();
  function logout() {
    const store = loadStore();
    delete store.sessions.currentUserId;
    saveStore(store);
    nav('/', { replace: true });
  }
  return (
    <div className="min-h-screen grid grid-cols-[14rem_1fr]">
      <div className="border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <Sidebar />
        <div className="mt-auto p-4">
          <button className="text-sm underline" onClick={logout}>Logout</button>
        </div>
      </div>
      <main className="p-0">
        <div className="border-b border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/60 backdrop-blur">
          <div className="container-app px-4 py-3 flex items-center justify-between">
            <div className="text-lg font-semibold">Album</div>
          </div>
        </div>
        <div className="container-app px-4 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}


