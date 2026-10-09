import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { SaveError } from '@/components/Save';
import { cn } from '@/lib/utils';
import { Dashboard } from '@/pages/Dashboard';
import { Library } from '@/pages/Library';
import { Settings } from '@/pages/Settings';
import { Encounter } from '@/pages/Encounter';

// Tiny hash router: #/ (dashboard), #/library, #/settings, #/encounter/:id
const useRoute = () => {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
};

const TABS = [
  { href: '#/', label: 'Dashboard', match: (r: string) => r === '/' || r.startsWith('/encounter') },
  { href: '#/library', label: 'Library', match: (r: string) => r.startsWith('/library') },
  { href: '#/settings', label: 'Settings', match: (r: string) => r.startsWith('/settings') },
];

export function App() {
  const route = useRoute();
  const announcement = useStore((s) => s.announcement);
  const enc = /^\/encounter\/([^/]+)/.exec(route);
  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-8 border-b border-border bg-card px-4">
        <span className="label py-4 text-foreground">▮ Encounter</span>
        <nav aria-label="Main" className="flex gap-6">
          {TABS.map((t) => {
            const active = t.match(route);
            return (
              <a
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn('inline-flex min-h-11 items-center border-b-2 text-xs uppercase tracking-[0.14em]', active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
              >
                {t.label}
              </a>
            );
          })}
        </nav>
      </header>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
      <main className="mx-auto max-w-[1600px] p-4">
        {enc && <div className="mb-4 flex flex-col gap-2 empty:hidden"><SaveError /></div>}
        {enc ? <Encounter key={enc[1]} id={enc[1]} /> : route.startsWith('/library') ? <Library /> : route.startsWith('/settings') ? <Settings /> : <Dashboard />}
      </main>
    </div>
  );
}
