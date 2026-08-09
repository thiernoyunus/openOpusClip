import React, { forwardRef } from 'react';
import {
    Home,
    Search,
    Compass,
    Plus,
    MessageCircle,
    Heart,
    Share2,
    Bookmark,
    MoreHorizontal,
    User,
    Music2,
    Play,
    ChevronDown,
    Bell,
    Send,
    Settings,
    Disc3,
    Edit2,
    Camera,
} from 'lucide-react';

/**
 * SocialMediaPreview wraps the exported video inside the real platform chrome
 * (TikTok, YouTube Shorts, Instagram Reels) so the editor can see exactly
 * where the platform's UI will overlay on top of their content and position
 * captions / titles inside the safe area.
 *
 * Each overlay is a "ghost" — pure CSS, no assets — so it scales with the
 * preview and never touches the export. The exported video is the same
 * 9:16 the user already composed; the chrome here is preview-only.
 *
 * The platform prop is one of: 'tiktok' | 'youtube-shorts' | 'instagram-reels' | null.
 * `null` === no overlay (editor preview, identical to before this feature).
 */

const SAFE_PADDING = 'max(env(safe-area-inset-top), 12px)';

// Tiny reusable icon button matching the side action rails on TikTok / Reels / Shorts.
const RailButton = ({ children, label, count, size = 28 }) => (
    <div className="flex flex-col items-center gap-1">
        <div className="text-white drop-shadow-md" style={{ width: size, height: size }}>{children}</div>
        {label && <span className="text-[10px] font-semibold text-white drop-shadow-md">{label}</span>}
        {count != null && (
            <span className="text-[10px] font-semibold text-white drop-shadow-md tabular-nums">{count}</span>
        )}
    </div>
);

// ----------------------------------------------------------------------------
// TikTok overlay
// ----------------------------------------------------------------------------
function TikTokOverlay({ children }) {
    return (
        <div className="relative w-full h-full bg-black overflow-hidden rounded-xl">
            {/* The video fills the frame — TikTok is full-bleed 9:16 */}
            <div className="absolute inset-0">{children}</div>

            {/* Right side action rail */}
            <div className="absolute right-2 bottom-24 flex flex-col items-center gap-4 z-10">
                <div className="relative">
                    <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-pink-500 via-red-500 to-yellow-400 p-[2px]">
                        <div className="w-full h-full rounded-full bg-zinc-800 border-2 border-black flex items-center justify-center overflow-hidden">
                            <User size={22} className="text-zinc-400" />
                        </div>
                    </div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-rose-500 text-white flex items-center justify-center text-[14px] font-bold leading-none"
                    >
                        +
                    </button>
                </div>

                <RailButton count="124.5K">
                    <Heart size={28} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="2,431">
                    <MessageCircle size={28} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="1,807">
                    <Bookmark size={28} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 size={28} />
                </RailButton>

                {/* Spinning music disc */}
                <div className="mt-1 w-10 h-10 rounded-full bg-zinc-900 border border-white/20 flex items-center justify-center animate-[spin_6s_linear_infinite]">
                    <Disc3 size={22} className="text-zinc-300" />
                </div>
            </div>

            {/* Bottom info area — username, caption, music */}
            <div className="absolute left-3 right-16 bottom-16 z-10 text-white drop-shadow-md">
                <div className="text-[13px] font-bold mb-1">@opusshorts</div>
                <div className="text-[12px] leading-snug mb-2">
                    Make your short look exactly like it will on TikTok 👇
                    <span className="text-cyan-300 ml-1">#viral</span>
                    <span className="text-cyan-300 ml-1">#openshorts</span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                    <Music2 size={12} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>

            {/* Top status bar */}
            <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-center pt-2 pb-1 text-[11px] font-semibold text-white">
                <span className="opacity-70">Following</span>
                <span className="mx-3 h-3 w-px bg-white/40" />
                <span className="border-b-2 border-white pb-0.5">For You</span>
            </div>

            {/* Bottom nav bar */}
            <div className="absolute left-0 right-0 bottom-0 z-10 bg-black/70 backdrop-blur-sm border-t border-white/10 flex items-center justify-around pt-2 pb-3 text-white">
                <div className="flex flex-col items-center gap-0.5">
                    <Home size={20} fill="white" />
                    <span className="text-[10px]">Home</span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                    <Search size={20} />
                    <span className="text-[10px]">Friends</span>
                </div>
                <div className="flex flex-col items-center -mt-1">
                    <div className="w-10 h-7 rounded-md bg-white flex items-center justify-center">
                        <Plus size={20} className="text-rose-500" strokeWidth={3} />
                    </div>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                    <MessageCircle size={20} />
                    <span className="text-[10px]">Inbox</span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                    <User size={20} />
                    <span className="text-[10px]">Profile</span>
                </div>
            </div>
        </div>
    );
}

// ----------------------------------------------------------------------------
// YouTube Shorts overlay
// ----------------------------------------------------------------------------
function YouTubeShortsOverlay({ children }) {
    return (
        <div className="relative w-full h-full bg-black overflow-hidden rounded-xl">
            {/* The video is offset to leave room for the right-rail action bar (real Shorts) */}
            <div className="absolute inset-y-0 left-0 right-[68px]">{children}</div>

            {/* Top bar — Shorts title + close */}
            <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 pt-2 pb-1 text-white">
                <div className="flex items-center gap-1.5">
                    <Play size={16} fill="white" className="text-white" />
                    <span className="text-[13px] font-semibold tracking-tight">Shorts</span>
                </div>
                <div className="flex items-center gap-3">
                    <Search size={18} />
                    <Bell size={18} />
                    <Settings size={18} />
                </div>
            </div>

            {/* Right side action rail */}
            <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-4 text-white">
                <RailButton count="48K">
                    <Heart size={26} fill="white" className="text-white" />
                </RailButton>
                <RailButton label="Dislike">
                    <div className="text-white text-[22px] leading-none -scale-100">👎</div>
                </RailButton>
                <RailButton count="1,204">
                    <MessageCircle size={26} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 size={26} />
                </RailButton>
                <RailButton>
                    <Edit2 size={26} />
                </RailButton>
            </div>

            {/* Bottom channel info + description */}
            <div className="absolute left-3 right-16 bottom-3 z-10 text-white">
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-full bg-zinc-700 border border-white/30 flex items-center justify-center overflow-hidden">
                        <User size={16} className="text-zinc-300" />
                    </div>
                    <div className="text-[12px] font-semibold">@opusshorts</div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="ml-1 h-7 px-3 rounded-full bg-white text-black text-[11px] font-semibold"
                    >
                        Subscribe
                    </button>
                </div>
                <div className="text-[11px] leading-snug mb-1.5 line-clamp-2">
                    See exactly how your Short will look on YouTube. Position captions inside the safe zone 👇
                </div>
                <div className="flex items-center gap-1.5 text-[10px] opacity-90">
                    <Music2 size={11} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>
        </div>
    );
}

// ----------------------------------------------------------------------------
// Instagram Reels overlay
// ----------------------------------------------------------------------------
function InstagramReelsOverlay({ children }) {
    return (
        <div className="relative w-full h-full bg-black overflow-hidden rounded-xl">
            {/* The video is offset to leave room for the right-rail action bar (real Reels) */}
            <div className="absolute inset-y-0 left-0 right-[64px]">{children}</div>

            {/* Top bar — Reels title + camera */}
            <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 pt-2 pb-1 text-white">
                <ChevronDown size={22} />
                <span className="text-[15px] font-semibold tracking-tight">Reels</span>
                <Camera size={20} />
            </div>

            {/* Right side action rail */}
            <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-4 text-white">
                <RailButton count="12.4K">
                    <Heart size={26} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="892">
                    <MessageCircle size={26} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Send size={26} className="-rotate-12" />
                </RailButton>
                <RailButton>
                    <div className="w-7 h-7 rounded-full bg-white/10 border border-white flex items-center justify-center text-[12px] font-bold">
                        ♪
                    </div>
                </RailButton>
                <RailButton>
                    <Bookmark size={26} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <MoreHorizontal size={26} />
                </RailButton>
                <div className="mt-1 w-7 h-7 rounded-full bg-zinc-900 border border-white/40 flex items-center justify-center overflow-hidden">
                    <User size={14} className="text-zinc-300" />
                </div>
            </div>

            {/* Bottom info — username, caption, music */}
            <div className="absolute left-3 right-16 bottom-12 z-10 text-white">
                <div className="text-[12px] font-bold mb-1">opusshorts</div>
                <div className="text-[11px] leading-snug mb-1.5 line-clamp-2">
                    See exactly how your Reel will look on Instagram Reposition captions 👇
                </div>
                <div className="flex items-center gap-1.5 text-[10px] opacity-90">
                    <Music2 size={11} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>

            {/* Bottom nav bar */}
            <div className="absolute left-0 right-0 bottom-0 z-10 bg-black/70 backdrop-blur-sm border-t border-white/10 flex items-center justify-around pt-2 pb-3 text-white">
                <div className="flex flex-col items-center gap-0.5">
                    <Home size={20} />
                    <span className="text-[10px]">Home</span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                    <Search size={20} />
                    <span className="text-[10px]">Search</span>
                </div>
                <div className="flex flex-col items-center -mt-1">
                    <div className="w-7 h-7">
                        <svg viewBox="0 0 24 24" fill="none" className="w-full h-full">
                            <rect x="2" y="2" width="9" height="9" rx="1" stroke="white" strokeWidth="1.7" />
                            <rect x="13" y="2" width="9" height="9" rx="1" stroke="white" strokeWidth="1.7" />
                            <rect x="2" y="13" width="9" height="9" rx="1" stroke="white" strokeWidth="1.7" />
                            <rect x="13" y="13" width="9" height="9" rx="3" stroke="white" strokeWidth="1.7" />
                        </svg>
                    </div>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                    <Compass size={20} />
                    <span className="text-[10px]">Shop</span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600 p-[1.5px]">
                        <div className="w-full h-full rounded-full bg-black flex items-center justify-center">
                            <User size={11} className="text-white" />
                        </div>
                    </div>
                    <span className="text-[10px]">Profile</span>
                </div>
            </div>
        </div>
    );
}

// ----------------------------------------------------------------------------
// Public component
// ----------------------------------------------------------------------------
const SocialMediaPreview = forwardRef(function SocialMediaPreview(
    { platform, children },
    _ref
) {
    if (!platform) {
        // No overlay — just render the video canvas as before
        return children;
    }

    if (platform === 'tiktok') return <TikTokOverlay>{children}</TikTokOverlay>;
    if (platform === 'youtube-shorts') return <YouTubeShortsOverlay>{children}</YouTubeShortsOverlay>;
    if (platform === 'instagram-reels') return <InstagramReelsOverlay>{children}</InstagramReelsOverlay>;

    return children;
});

export const PLATFORMS = [
    { id: 'tiktok', label: 'TikTok', short: 'TT' },
    { id: 'youtube-shorts', label: 'YouTube Shorts', short: 'YT' },
    { id: 'instagram-reels', label: 'Instagram Reels', short: 'IG' },
];

export default SocialMediaPreview;
