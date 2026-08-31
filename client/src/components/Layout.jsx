import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/football', label: 'Fantasy Football', icon: 'football' },
  { to: '/basketball', label: 'Fantasy Basketball', icon: 'basketball' },
  { to: '/sync', label: 'Sync Your League', icon: 'sync' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

function NavIcon({ name }) {
  const paths = {
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7"/></>,
    football: <><path d="M6.2 17.8c-3.1-3.1-2.8-8.4.7-11.9s8.8-3.8 11.9-.7 2.8 8.4-.7 11.9-8.8 3.8-11.9.7Z"/><path d="m8 16 8-8M9.5 10.5l4 4M11 9l4 4"/></>,
    basketball: <><circle cx="12" cy="12" r="9"/><path d="M3.3 9h17.4M3.3 15h17.4M9 3.3c2.5 2.4 3.7 5.3 3.7 8.7S11.5 18.3 9 20.7M15 3.3c-2.5 2.4-3.7 5.3-3.7 8.7s1.2 6.3 3.7 8.7"/></>,
    sync: <><path d="M20 7h-7a4 4 0 0 0-4 4v1"/><path d="m17 4 3 3-3 3M4 17h7a4 4 0 0 0 4-4v-1"/><path d="m7 20-3-3 3-3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };
  return <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="app-shell flex min-h-screen flex-col bg-dark-950 md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full shrink-0 flex-col border-b border-dark-700 bg-dark-900 md:min-h-screen md:w-60 md:border-b-0 md:border-r">
        {/* Logo */}
        <div className="flex items-center justify-between border-b border-dark-700 px-4 py-3 md:block md:px-5 md:py-5">
          <h1 className="text-xl font-extrabold tracking-tight">
            <span className="text-primary-400">Pro</span>
            <span className="text-dark-50">GM</span>
          </h1>
          <p className="mt-1 hidden text-xs text-dark-400 md:block">Your personalized fantasy front office</p><button onClick={handleLogout} className="text-xs text-dark-400 hover:text-red-400 md:hidden">Sign Out</button>
        </div>

        {/* Navigation */}
        <nav className="flex flex-1 gap-1 overflow-x-auto p-2 md:block md:space-y-1 md:p-3">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold transition-colors md:gap-3 ${
                  isActive
                    ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                    : 'border-transparent text-dark-300 hover:border-dark-700 hover:bg-dark-800 hover:text-dark-50'
                }`
              }
            >
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* User section */}
        <div className="hidden border-t border-dark-700 p-2 md:block md:p-4">
          <div className="mb-3 hidden items-center gap-3 md:flex">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-primary-500/40 bg-primary-500/10 text-sm font-bold text-primary-400">
              {user?.username?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.username}</p>
              <p className="text-xs text-dark-400 truncate">{user?.teamName}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="w-full text-center text-xs text-dark-400 transition-colors hover:text-red-400 md:text-left md:text-sm">
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1600px] p-4 md:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
