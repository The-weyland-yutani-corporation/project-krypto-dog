import Link from "next/link";
import { Activity, BookOpen, LayoutDashboard, LogOut } from "lucide-react";

const navItems = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/trades", label: "Trades", icon: Activity },
  { href: "/admin/journal", label: "Journal", icon: BookOpen },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden md:fixed md:inset-y-0 md:flex md:w-72 md:flex-col">
        <div className="flex flex-grow flex-col overflow-y-auto border-r border-border bg-card/80 px-4 py-5">
          <div className="flex items-center flex-shrink-0 px-4">
            <span className="text-xl font-semibold tracking-tight text-foreground">
              🐕 Project Krypto
            </span>
          </div>
          <p className="px-4 mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Paper trading console
          </p>
          <nav className="mt-8 flex-1 px-3 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
          </nav>
          <form action="/api/auth/logout" method="post" className="px-3">
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="fixed top-0 z-10 flex w-full items-center gap-4 border-b border-border bg-card/95 px-4 py-3 backdrop-blur md:hidden">
        <span className="text-lg font-semibold text-foreground">🐕 Project Krypto</span>
        <nav className="flex gap-3 ml-auto">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          ))}
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </form>
        </nav>
      </div>

      <main className="flex-1 md:pl-72">
        <div className="mx-auto max-w-7xl p-6 pt-20 md:pt-8 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
