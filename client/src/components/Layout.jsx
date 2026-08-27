import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '📊' },
  { to: '/roster', label: 'My Roster', icon: '🏀' },
  { to: '/players', label: 'Players', icon: '👥' },
  { to: '/trades', label: 'AI Trades', icon: '🤖' },
  { to: '/yahoo', label: 'Yahoo Fantasy', icon: 'Y!' },
  { to: '/espn', label: 'ESPN Fantasy', icon: 'E' },
  { to: '/football', label: 'Fantasy Football', icon: '🏈' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 bg-dark-900 border-r border-dark-700 flex flex-col">
        {/* Logo */}
        <div className="p-6 border-b border-dark-700">
          <h1 className="text-xl font-bold">
            <span className="text-primary-400">Fantasy</span>
            <span className="text-accent-orange">Pro</span>
            <span className="text-white">GM</span>
          </h1>
          <p className="text-xs text-dark-400 mt-1">NBA AI Trade Advisor</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
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
        <div className="p-4 border-t border-dark-700">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 bg-primary-600 rounded-full flex items-center justify-center text-sm font-bold">
              {user?.username?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.username}</p>
              <p className="text-xs text-dark-400 truncate">{user?.teamName}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="w-full text-sm text-dark-400 hover:text-red-400 transition-colors text-left">
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
