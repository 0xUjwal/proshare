import type { ReactNode } from 'react'

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#6d5cff" />
        <path d="M10 22V10h6a4 4 0 0 1 0 8h-3v4z" fill="white" />
      </svg>
      <span className="text-xl font-bold tracking-tight">ProShare</span>
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-mesh min-h-full flex flex-col">
      <header className="w-full max-w-4xl mx-auto px-5 pt-6 flex items-center justify-between">
        <a href="#/"><Logo /></a>
        <span className="pill pill-ok hidden sm:inline-block">no servers &middot; no accounts &middot; no tracking</span>
      </header>
      <main className="flex-1 w-full max-w-4xl mx-auto px-5 py-8 flex flex-col">{children}</main>
      <footer className="w-full max-w-4xl mx-auto px-5 pb-6 text-xs text-[--color-mut] leading-relaxed">
        Files move directly between browsers, end-to-end encrypted. Nothing is uploaded or stored anywhere.
      </footer>
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 sm:p-6 ${className}`}>{children}</div>
}
