import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'MCP Probe Dashboard',
  description: 'Interactive testing dashboard for MCP servers',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-background text-foreground`}>
        <nav className="sticky top-0 z-50 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-4">
            <Link href="/" className="flex items-center gap-2 font-bold text-zinc-100">
              <span className="rounded bg-blue-600 px-1.5 py-0.5 text-xs font-black tracking-wider text-white">MCP</span>
              <span>Probe</span>
            </Link>
            <div className="flex gap-6 text-sm">
              <NavLink href="/">Dashboard</NavLink>
              <NavLink href="/servers">Servers</NavLink>
              <NavLink href="/runs">Runs</NavLink>
            </div>
          </div>
        </nav>
        <main className="mx-auto max-w-6xl px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-zinc-400 transition-colors hover:text-zinc-100">
      {children}
    </Link>
  );
}
