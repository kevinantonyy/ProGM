import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { to: '/football', label: 'Fantasy Football', icon: '🏈' },
  { to: '/basketball', label: 'Fantasy Basketball', icon: '🏀' },
  { to: '/sync', label: 'Sync Your League', icon: '🔗' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full shrink-0 flex-col border-b border-dark-700 bg-dark-900 md:min-h-screen md:w-64 md:border-b-0 md:border-r">
        {/* Logo */}
        <div className="border-b border-dark-700 px-4 py-3 md:p-6">
          <h1 className="text-xl font-bold">
            <span className="text-accent-orange">Pro</span>
            <span className="text-white">GM</span>
          </h1>
          <p className="mt-1 hidden text-xs text-dark-400 md:block">Your personalized fantasy front office</p>
        </div>

        {/* Navigation */}
        <nav className="flex flex-1 gap-2 overflow-x-auto p-2 md:block md:space-y-1 md:p-4">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors md:gap-3 md:px-4 md:py-3 ${
                  isActive
                    ? 'bg-primary-600/20 text-primary-400 border border-primary-500/30'
                    : 'text-dark-300 hover:bg-dark-800 hover:text-white'
                }`
              }
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* User section */}
        <div className="border-t border-dark-700 p-2 md:p-4">
          <div className="mb-3 hidden items-center gap-3 md:flex">
            <div className="w-8 h-8 bg-primary-600 rounded-full flex items-center justify-center text-sm font-bold">
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
        <div className="mx-auto max-w-[1600px] p-4 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
