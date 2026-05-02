import Link from "next/link";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: "📊" },
  { href: "/admin/trades", label: "Trades", icon: "💹" },
  { href: "/admin/journal", label: "Journal", icon: "📓" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0">
        <div className="flex flex-col flex-grow bg-gray-900 pt-5 pb-4 overflow-y-auto">
          <div className="flex items-center flex-shrink-0 px-4">
            <span className="text-xl font-bold text-white tracking-tight">
              🐕 Project Krypto
            </span>
          </div>
          <p className="px-4 mt-1 text-xs text-gray-400">
            Autonomous Trading Agent
          </p>
          <nav className="mt-8 flex-1 px-3 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-300 rounded-lg hover:bg-gray-800 hover:text-white transition-colors"
              >
                <span>{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </aside>

      {/* Mobile nav */}
      <div className="md:hidden bg-gray-900 w-full fixed top-0 z-10 flex items-center gap-4 px-4 py-3">
        <span className="text-lg font-bold text-white">🐕 Project Krypto</span>
        <nav className="flex gap-3 ml-auto">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-xs text-gray-300 hover:text-white"
            >
              {item.icon} {item.label}
            </Link>
          ))}
        </nav>
      </div>

      {/* Main content */}
      <main className="md:pl-64 flex-1">
        <div className="pt-16 md:pt-0 p-6 lg:p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
