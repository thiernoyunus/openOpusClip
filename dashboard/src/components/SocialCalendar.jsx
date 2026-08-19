import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, ChevronLeft, ChevronRight, RotateCcw, Loader2, X, Trash2, Clock, ExternalLink, Instagram, Youtube, Video, Globe, AlertCircle, Eye, Heart, MessageCircle, Share2, TrendingUp, Users } from 'lucide-react';
import { getApiUrl } from '../config';

const PlatformIcon = ({ platform, size = 13 }) => {
  if (platform === 'tiktok') return <Video size={size} className="text-cyan-400" />;
  if (platform === 'instagram') return <Instagram size={size} className="text-pink-400" />;
  if (platform === 'youtube') return <Youtube size={size} className="text-red-400" />;
  return <Globe size={size} className="text-zinc-400" />;
};

const STATUS_STYLES = {
  scheduled: 'bg-purple-500/15 border-purple-500/30 text-purple-300',
  published: 'bg-green-500/15 border-green-500/30 text-green-300',
  failed: 'bg-red-500/15 border-red-500/30 text-red-300',
  draft: 'bg-zinc-500/15 border-zinc-500/30 text-zinc-400',
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtNum = (n) => {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

export default function SocialCalendar({ zernioKey, accounts = [], onGoToSettings }) {
  const [view, setView] = useState('calendar'); // 'calendar' | 'analytics'
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPost, setSelectedPost] = useState(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [busy, setBusy] = useState(false);

  // Analytics state
  const [statsAccountId, setStatsAccountId] = useState('all');
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState(null);

  const headers = { 'X-Zernio-Key': zernioKey };

  const monthBounds = (d) => {
    const from = new Date(d.getFullYear(), d.getMonth(), 1);
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const iso = (x) => x.toISOString().slice(0, 10);
    return { dateFrom: iso(from), dateTo: iso(to) };
  };

  const fetchPosts = useCallback(async () => {
    if (!zernioKey) return;
    setLoading(true);
    setError(null);
    try {
      const { dateFrom, dateTo } = monthBounds(cursor);
      const res = await fetch(getApiUrl(`/api/social/posts?dateFrom=${dateFrom}&dateTo=${dateTo}&limit=100`), { headers });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPosts(Array.isArray(data) ? data : data.posts || []);
    } catch (e) {
      setError(`Could not load posts: ${e.message}`);
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [zernioKey, cursor]);

  useEffect(() => { if (view === 'calendar') fetchPosts(); }, [fetchPosts, view]);

  const fetchStats = useCallback(async () => {
    if (!zernioKey) return;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const qs = statsAccountId !== 'all' ? `?accountId=${statsAccountId}` : '';
      const res = await fetch(getApiUrl(`/api/social/analytics${qs}`), { headers });
      if (!res.ok) throw new Error(await res.text());
      setStats(await res.json());
    } catch (e) {
      setStatsError(`Could not load analytics: ${e.message}`);
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, [zernioKey, statsAccountId]);

  useEffect(() => { if (view === 'analytics') fetchStats(); }, [fetchStats, view]);

  const handleReschedule = async () => {
    if (!selectedPost || !rescheduleDate) return;
    setBusy(true);
    try {
      const res = await fetch(getApiUrl(`/api/social/posts/${selectedPost._id}`), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduledFor: new Date(rescheduleDate).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSelectedPost(null);
      fetchPosts();
    } catch (e) {
      alert(`Reschedule failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedPost) return;
    if (!window.confirm('Delete this scheduled post?')) return;
    setBusy(true);
    try {
      const res = await fetch(getApiUrl(`/api/social/posts/${selectedPost._id}`), { method: 'DELETE', headers });
      if (!res.ok) throw new Error(await res.text());
      setSelectedPost(null);
      fetchPosts();
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!zernioKey) {
    return (
      <div data-tour="calendar-page" className="h-full flex flex-col items-center justify-center gap-4 text-center p-8">
        <Calendar size={40} className="text-zinc-600" />
        <div>
          <h2 className="text-lg font-semibold text-fg mb-1">Connect Zernio to use the calendar</h2>
          <p className="text-sm text-muted max-w-sm">Add your Zernio API key to schedule posts, see them on a calendar, and track how each account performs.</p>
        </div>
        <button onClick={onGoToSettings} className="btn-primary py-2 px-5 text-sm">Go to Settings</button>
      </div>
    );
  }

  // --- Calendar grid data ---
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const today = new Date();
  const postsByDay = {};
  posts.forEach((p) => {
    const when = p.scheduledFor || p.publishedAt || p.createdAt;
    if (!when) return;
    const d = new Date(when);
    if (d.getFullYear() !== year || d.getMonth() !== month) return;
    (postsByDay[d.getDate()] = postsByDay[d.getDate()] || []).push(p);
  });

  // --- Analytics data (defensive: Zernio returns a paginated post list, possibly with an overview block) ---
  const statPosts = stats
    ? (Array.isArray(stats) ? stats
      : Array.isArray(stats.posts) ? stats.posts
      : Array.isArray(stats.data) ? stats.data
      : Array.isArray(stats.analytics) ? stats.analytics
      : [])
    : [];
  const overview = stats?.overview || null;
  const sum = (key) => statPosts.reduce((acc, p) => acc + (Number(p.analytics?.[key]) || 0), 0);
  const totals = overview || {
    views: sum('views'), likes: sum('likes'), comments: sum('comments'),
    shares: sum('shares'), impressions: sum('impressions'), reach: sum('reach'),
  };
  const avgEngagement = overview?.engagementRate ?? (statPosts.length
    ? statPosts.reduce((acc, p) => acc + (Number(p.analytics?.engagementRate) || 0), 0) / statPosts.length
    : null);

  const STAT_TILES = [
    { label: 'Views', key: 'views', icon: Eye },
    { label: 'Likes', key: 'likes', icon: Heart },
    { label: 'Comments', key: 'comments', icon: MessageCircle },
    { label: 'Shares', key: 'shares', icon: Share2 },
    { label: 'Impressions', key: 'impressions', icon: TrendingUp },
    { label: 'Reach', key: 'reach', icon: Users },
  ];

  return (
    <div data-tour="calendar-page" className="h-full overflow-y-auto custom-scrollbar animate-[fadeIn_0.3s_ease-out]">
      <div className="max-w-5xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-fg">Calendar</h1>
            <div data-tour="calendar-schedule" className="flex items-center rounded-lg border border-edge overflow-hidden text-xs">
              <button onClick={() => setView('calendar')} className={`px-3 py-1.5 transition-colors ${view === 'calendar' ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg'}`}>Schedule</button>
              <button onClick={() => setView('analytics')} className={`px-3 py-1.5 border-l border-edge transition-colors ${view === 'analytics' ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg'}`}>Analytics</button>
            </div>
          </div>
          <button
            onClick={() => (view === 'calendar' ? fetchPosts() : fetchStats())}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-fg border border-edge hover:bg-white/5 px-2.5 py-1.5 rounded-lg transition-colors"
          >
            <RotateCcw size={13} /> Refresh
          </button>
        </div>

        {view === 'calendar' && (
          <>
            {/* Month nav */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <button onClick={() => setCursor(new Date(year, month - 1, 1))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"><ChevronLeft size={16} /></button>
                <span className="text-sm font-semibold text-fg min-w-[140px] text-center">{MONTH_NAMES[month]} {year}</span>
                <button onClick={() => setCursor(new Date(year, month + 1, 1))} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"><ChevronRight size={16} /></button>
              </div>
              <button onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))} className="text-xs text-muted hover:text-fg transition-colors">Today</button>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 text-red-300 text-xs rounded-lg flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
              </div>
            )}

            {/* Grid */}
            <div className="grid grid-cols-7 gap-px bg-edge rounded-xl overflow-hidden border border-edge">
              {DAY_NAMES.map((d) => (
                <div key={d} className="bg-surface2 px-2 py-1.5 text-[10px] font-bold text-muted uppercase tracking-wider text-center">{d}</div>
              ))}
              {cells.map((day, i) => {
                const isToday = day && year === today.getFullYear() && month === today.getMonth() && day === today.getDate();
                return (
                  <div key={i} className="bg-background min-h-[96px] p-1.5">
                    {day && (
                      <>
                        <div className={`text-[11px] mb-1 w-5 h-5 flex items-center justify-center rounded-full ${isToday ? 'bg-primary text-white font-bold' : 'text-muted'}`}>{day}</div>
                        <div className="space-y-1">
                          {(postsByDay[day] || []).map((p) => {
                            const when = new Date(p.scheduledFor || p.publishedAt || p.createdAt);
                            const platform = p.platforms?.[0]?.platform;
                            return (
                              <button
                                key={p._id}
                                onClick={() => { setSelectedPost(p); setRescheduleDate(''); }}
                                className={`w-full text-left px-1.5 py-1 rounded border text-[10px] leading-tight truncate flex items-center gap-1 hover:brightness-125 transition-all ${STATUS_STYLES[p.status] || STATUS_STYLES.draft}`}
                                title="Open scheduled post"
                              >
                                <PlatformIcon platform={platform} size={10} />
                                <span className="truncate">{when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} <span className="ph-mask">{p.title || p.content || 'Post'}</span></span>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {loading && (
              <div className="flex items-center justify-center gap-2 text-muted text-xs py-6">
                <Loader2 size={14} className="animate-spin" /> Loading posts...
              </div>
            )}
            {!loading && posts.length === 0 && !error && (
              <p className="text-center text-xs text-muted py-6">No posts scheduled this month. Use the Share button on a clip to schedule one.</p>
            )}
          </>
        )}

        {view === 'analytics' && (
          <>
            {/* Account filter */}
            <div className="flex flex-wrap gap-2 mb-5">
              <button
                onClick={() => setStatsAccountId('all')}
                className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${statsAccountId === 'all' ? 'bg-surface2 border-white/20 text-fg' : 'border-edge text-muted hover:text-fg'}`}
              >
                All accounts
              </button>
              {accounts.map((acc) => (
                <button
                  key={acc.id}
                  onClick={() => setStatsAccountId(acc.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${statsAccountId === acc.id ? 'bg-surface2 border-white/20 text-fg' : 'border-edge text-muted hover:text-fg'}`}
                >
                  <PlatformIcon platform={acc.platform} size={12} /> <span className="ph-mask">{acc.displayName || acc.username}</span>
                </button>
              ))}
            </div>

            {statsError && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 text-red-300 text-xs rounded-lg flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" /> {statsError}
              </div>
            )}

            {statsLoading ? (
              <div className="flex items-center justify-center gap-2 text-muted text-xs py-16">
                <Loader2 size={14} className="animate-spin" /> Loading analytics...
              </div>
            ) : (
              <>
                {/* Stat tiles (last 90 days — Zernio's default window) */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
                  {STAT_TILES.map(({ label, key, icon: Icon }) => (
                    <div key={key} className="glass-panel p-4">
                      <div className="flex items-center gap-1.5 text-[11px] text-muted mb-1"><Icon size={12} /> {label}</div>
                      <div className="text-xl font-bold text-fg tabular-nums">{fmtNum(totals[key])}</div>
                    </div>
                  ))}
                </div>
                {avgEngagement != null && (
                  <div className="glass-panel p-4 mb-6 flex items-center justify-between">
                    <span className="text-xs text-muted">Average engagement rate</span>
                    <span className="text-lg font-bold text-green-400 tabular-nums">{(Number(avgEngagement)).toFixed(2)}%</span>
                  </div>
                )}

                {/* Per-post table */}
                <h3 className="text-sm font-semibold text-fg mb-2">Posts (last 90 days)</h3>
                {statPosts.length === 0 ? (
                  <p className="text-xs text-muted py-4">No published posts with analytics yet. Stats appear here after your first posts go live.</p>
                ) : (
                  <div className="border border-edge rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-surface2 text-muted text-left">
                          <th className="px-3 py-2 font-medium">Post</th>
                          <th className="px-3 py-2 font-medium">Platform</th>
                          <th className="px-3 py-2 font-medium text-right">Views</th>
                          <th className="px-3 py-2 font-medium text-right">Likes</th>
                          <th className="px-3 py-2 font-medium text-right">Comments</th>
                          <th className="px-3 py-2 font-medium text-right">Eng. %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statPosts.map((p, i) => (
                          <tr key={p.postId || i} className="border-t border-edge text-fg">
                            <td className="ph-mask px-3 py-2 max-w-[240px] truncate">{p.content || p.title || '—'}</td>
                            <td className="px-3 py-2"><span className="flex items-center gap-1.5 capitalize"><PlatformIcon platform={p.platform} size={11} /> {p.platform || '—'}</span></td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtNum(p.analytics?.views)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtNum(p.analytics?.likes)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtNum(p.analytics?.comments)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{p.analytics?.engagementRate != null ? `${Number(p.analytics.engagementRate).toFixed(1)}%` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Post detail modal */}
      {selectedPost && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]" onClick={() => setSelectedPost(null)}>
          <div className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-md shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setSelectedPost(null)} className="absolute top-4 right-4 text-zinc-500 hover:text-white"><X size={20} /></button>

            <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide mb-3 ${STATUS_STYLES[selectedPost.status] || STATUS_STYLES.draft}`}>
              {selectedPost.status}
            </div>
            <h3 className="ph-mask text-base font-bold text-white mb-1">{selectedPost.title || 'Post'}</h3>
            {selectedPost.content && <p className="ph-mask text-xs text-zinc-400 mb-3 line-clamp-4">{selectedPost.content}</p>}

            <div className="flex items-center gap-2 text-xs text-zinc-400 mb-4">
              <Clock size={13} />
              {new Date(selectedPost.scheduledFor || selectedPost.publishedAt || selectedPost.createdAt).toLocaleString()}
              <span className="flex items-center gap-1.5 ml-auto">
                {(selectedPost.platforms || []).map((pl, i) => <PlatformIcon key={i} platform={pl.platform} />)}
              </span>
            </div>

            {selectedPost.status === 'scheduled' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Reschedule to</label>
                  <input
                    type="datetime-local"
                    value={rescheduleDate}
                    onChange={(e) => setRescheduleDate(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-purple-500/50 [color-scheme:dark]"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleReschedule}
                    disabled={busy || !rescheduleDate}
                    className="flex-1 py-2.5 bg-primary hover:bg-primary/90 disabled:opacity-40 rounded-lg text-white text-sm font-semibold transition-all flex items-center justify-center gap-2"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />} Reschedule
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={busy}
                    className="py-2.5 px-4 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 text-sm font-semibold transition-all flex items-center justify-center gap-2"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            )}

            {selectedPost.status === 'published' && selectedPost.platformPostUrl && (
              <a
                href={selectedPost.platformPostUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2.5 bg-white/5 hover:bg-white/10 border border-edge rounded-lg text-sm text-fg transition-colors"
              >
                <ExternalLink size={14} /> View post
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
