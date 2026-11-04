import { Permission } from '@hearer/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Search, Upload } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { useAuth } from '../api/auth.ts';
import { Card } from '../components/ui.tsx';

export function HomePage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const name = user?.displayName ?? user?.username ?? '';

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const q = query.trim();
    void navigate({ to: '/search', search: q ? { q } : {} });
  };

  return (
    <div className="mx-auto max-w-2xl pt-4 sm:pt-12">
      <p className="text-sm font-medium text-accent">Welcome back, {name}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        What do you want to hear?
      </h1>
      <p className="mt-3 text-muted">
        Search for an artist, album or song. If it is not in the library yet, request it.
      </p>

      <form onSubmit={submit} role="search" className="mt-8">
        <label htmlFor="home-search" className="sr-only">
          Search music
        </label>
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-1.5 shadow-card focus-within:border-accent">
          <Search className="ml-3 size-5 shrink-0 text-muted" aria-hidden />
          <input
            id="home-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Artist, album or song"
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted/70"
          />
          <button
            type="submit"
            className="min-h-11 rounded-xl bg-accent px-5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Search
          </button>
        </div>
      </form>

      {hasPermission([Permission.UPLOAD, Permission.MANAGE_UPLOADS], 'or') && (
        <Link to="/upload" className="mt-8 block">
          <Card className="flex items-center gap-4 p-4 transition-colors hover:border-accent">
            <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
              <Upload className="size-5" aria-hidden />
            </span>
            <span>
              <span className="block font-medium">Upload music you own</span>
              <span className="block text-sm text-muted">
                Add files to the library; they are tagged and filed for you.
              </span>
            </span>
          </Card>
        </Link>
      )}
    </div>
  );
}
