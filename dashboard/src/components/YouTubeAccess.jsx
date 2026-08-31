import React from 'react';
import { CheckCircle2, Loader2, LogIn, LogOut, Shield, Youtube } from 'lucide-react';

export default function YouTubeAccess({ available, signedIn, busy, error, onSignIn, onSignOut }) {
  const statusLabel = signedIn === null ? 'Checking…' : signedIn ? 'Connected' : 'Not connected';

  return (
    <div className="glass-panel p-6 mt-8">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Youtube size={19} className="text-red-400" /> YouTube access
          </h2>
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
            Most videos work without this. If YouTube asks you to sign in, connect once here.
            The session stays on this computer and is used only for YouTube downloads.
          </p>
        </div>
        <span className={`shrink-0 text-[10px] px-2 py-1 rounded-full border uppercase tracking-wider flex items-center gap-1.5 ${
          signedIn ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-zinc-400 bg-zinc-500/10 border-white/10'
        }`} aria-live="polite">
          {signedIn && <CheckCircle2 size={12} />}
          {statusLabel}
        </span>
      </div>

      {!available && (
        <p className="text-xs text-zinc-500 mb-4">
          YouTube sign-in is available in the desktop app.
        </p>
      )}
      {error && <p className="text-sm text-red-400 mb-4" role="alert">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSignIn}
          disabled={!available || busy || signedIn === null}
          className="btn-primary py-2 px-4 text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
          {busy ? 'YouTube sign-in in progress…' : signedIn ? 'Reconnect YouTube' : 'Sign in to YouTube'}
        </button>
        {signedIn && (
          <button
            type="button"
            onClick={onSignOut}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-edge text-sm text-muted hover:text-fg hover:bg-white/5 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <LogOut size={15} /> Sign out
          </button>
        )}
      </div>

      <p className="text-[11px] text-zinc-500 mt-4 flex items-center gap-1.5">
        <Shield size={12} /> Your YouTube session is kept locally and is never sent to our server.
      </p>
    </div>
  );
}
