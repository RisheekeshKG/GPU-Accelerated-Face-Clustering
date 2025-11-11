import { NavLink } from 'react-router-dom';

export default function Sidebar() {
  const linkBase =
    'block px-4 py-2 rounded-lg hover:bg-primary-50 dark:hover:bg-neutral-800 transition';
  const active = 'bg-primary-100 text-primary-800 dark:bg-neutral-800';
  return (
    <aside className="w-56 border-r border-gray-200 dark:border-gray-800 p-4 gap-2 flex flex-col">
      <div className="mb-3">
        <div className="inline-flex items-center px-2 py-1 rounded-md bg-primary-100 text-primary-800 text-sm">Client</div>
      </div>
      <NavLink to="/app/dashboard" className={({ isActive }) => `${linkBase} ${isActive ? active : ''}`}>
        Dashboard
      </NavLink>
      <NavLink to="/app/create" className={({ isActive }) => `${linkBase} ${isActive ? active : ''}`}>
        Create
      </NavLink>
    </aside>
  );
}


