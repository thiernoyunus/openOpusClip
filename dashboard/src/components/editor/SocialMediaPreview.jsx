import React, { forwardRef } from 'react';
import {
    Home,
    Search,
    Compass,
    MessageCircle,
    Heart,
    Share2,
    Bookmark,
    MoreHorizontal,
    User,
    Music2,
    Play,
    Bell,
    Send,
    Settings,
    Disc3,
    Edit2,
    Camera,
    ChevronDown,
} from 'lucide-react';

/**
 * SocialMediaPreview renders the real platform chrome (TikTok, YouTube Shorts,
 * Instagram Reels) so the editor can see exactly where the platform's UI
 * will overlay on top of their content and position captions / titles inside
 * the safe area.
 *
 * Sizes are calibrated against the actual platforms — not exaggerated.
 * Only the overlays that sit on top of the video are rendered. App-level
 * chrome that lives BELOW or AROUND the player in the host app
 * (TikTok / Instagram bottom navs) is intentionally omitted — the
 * preview is the video player surface, not the full app shell.
 *
 * Renders as a sibling of the Remotion Player inside the boxStyle-constrained
 * container in EditorCanvas, so the chrome tracks the same frame as the video
 * — never resizes it, never resizes the editor.
 *
 * All chrome layers carry pointer-events-none so the editor's click overlays
 * (TrackerOverlay, PanelCropOverlay, CaptionDragOverlay) still receive input
 * through the covered regions.
 */

const CHROME = 'pointer-events-none';

// Rail button matching the side action rails on TikTok / Reels / Shorts.
// `size` controls the icon box; the wrapper reserves a fixed slot so the
// counts / labels line up across rows.
const RailButton = ({ children, label, count, size = 22 }) => (
    <div className="flex flex-col items-center gap-0.5">
        <div className="text-white drop-shadow-md" style={{ width: size + 2, height: size + 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{children}</div>
        {count != null && <span className="text-[10px] font-semibold text-white drop-shadow-md tabular-nums leading-tight">{count}</span>}
        {label && <span className="text-[10px] font-semibold text-white drop-shadow-md leading-tight">{label}</span>}
    </div>
);

// ----------------------------------------------------------------------------
// TikTok overlay
// ----------------------------------------------------------------------------
function TikTokOverlay() {
    return (
        <>
            {/* Right side action rail — bottom-anchored. Real-platform icon size (~22px). */}
            <div className={`absolute right-1.5 bottom-[88px] flex flex-col items-center gap-3 z-10 ${CHROME}`}>
                <div className="relative">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-pink-500 via-red-500 to-yellow-400 p-[2px]">
                        <div className="w-full h-full rounded-full bg-zinc-800 border-2 border-black flex items-center justify-center overflow-hidden">
                            <User size={18} className="text-zinc-400" />
                        </div>
                    </div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-rose-500 text-white flex items-center justify-center text-[11px] font-bold leading-none pointer-events-auto"
                    >
                        +
                    </button>
                </div>

                <RailButton count="124.5K">
                    <Heart size={22} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="2,431">
                    <MessageCircle size={22} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="1,807">
                    <Bookmark size={22} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 size={22} />
                </RailButton>

                {/* Spinning music disc */}
                <div className="mt-1 w-8 h-8 rounded-full bg-zinc-900 border border-white/20 flex items-center justify-center animate-[spin_6s_linear_infinite]">
                    <Disc3 size={18} className="text-zinc-300" />
                </div>
            </div>

            {/* Bottom info — username, caption, music. Sized like real TikTok. */}
            <div className={`absolute left-3 right-14 bottom-3 z-10 text-white drop-shadow-md ${CHROME}`}>
                <div className="text-[11px] font-bold mb-0.5">@opusshorts</div>
                <div className="text-[10px] leading-snug mb-1.5">
                    Make your short look exactly like it will on TikTok 👇
                    <span className="text-cyan-300 ml-1">#viral</span>
                    <span className="text-cyan-300 ml-1">#openshorts</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px]">
                    <Music2 size={11} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>

            {/* Top "Following / For You" tab — slim, no app nav bar above. */}
            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-center pt-1.5 pb-1 text-[10px] font-semibold text-white ${CHROME}`}>
                <span className="opacity-70">Following</span>
                <span className="mx-3 h-3 w-px bg-white/40" />
                <span className="border-b-2 border-white pb-0.5">For You</span>
            </div>
        </>
    );
}

// ----------------------------------------------------------------------------
// YouTube Shorts overlay
// ----------------------------------------------------------------------------
function YouTubeShortsOverlay() {
    return (
        <>
            {/* Top bar — Shorts title + close */}
            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 pt-1.5 pb-1 text-white ${CHROME}`}>
                <div className="flex items-center gap-1.5">
                    <Play size={14} fill="white" className="text-white" />
                    <span className="text-[12px] font-semibold tracking-tight">Shorts</span>
                </div>
                <div className="flex items-center gap-3">
                    <Search size={16} />
                    <Bell size={16} />
                    <Settings size={16} />
                </div>
            </div>

            {/* Right side action rail — bottom-anchored, real Shorts size (~20-22px). */}
            <div className={`absolute right-1.5 bottom-12 flex flex-col items-center gap-3 text-white ${CHROME}`}>
                <RailButton count="48K">
                    <Heart size={20} fill="white" className="text-white" />
                </RailButton>
                <RailButton label="Dislike">
                    <div className="text-white text-[18px] leading-none -scale-100">👎</div>
                </RailButton>
                <RailButton count="1,204">
                    <MessageCircle size={20} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 size={20} />
                </RailButton>
                <RailButton>
                    <Edit2 size={20} />
                </RailButton>
            </div>

            {/* Bottom channel info + description */}
            <div className={`absolute left-3 right-14 bottom-3 z-10 text-white ${CHROME}`}>
                <div className="flex items-center gap-2 mb-1.5">
                    <div className="w-7 h-7 rounded-full bg-zinc-700 border border-white/30 flex items-center justify-center overflow-hidden">
                        <User size={14} className="text-zinc-300" />
                    </div>
                    <div className="text-[11px] font-semibold">@opusshorts</div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="ml-1 h-6 px-3 rounded-full bg-white text-black text-[10px] font-semibold pointer-events-auto"
                    >
                        Subscribe
                    </button>
                </div>
                <div className="text-[10px] leading-snug mb-1 line-clamp-2">
                    See exactly how your Short will look on YouTube. Position captions inside the safe zone 👇
                </div>
                <div className="flex items-center gap-1.5 text-[10px] opacity-90">
                    <Music2 size={10} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>
        </>
    );
}

// ----------------------------------------------------------------------------
// Instagram Reels overlay
// ----------------------------------------------------------------------------
function InstagramReelsOverlay() {
    return (
        <>
            {/* Top bar — Reels title + camera */}
            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 pt-1.5 pb-1 text-white ${CHROME}`}>
                <ChevronDown size={18} />
                <span className="text-[13px] font-semibold tracking-tight">Reels</span>
                <Camera size={18} />
            </div>

            {/* Right side action rail — bottom-anchored, real Reels size (~22-24px). */}
            <div className={`absolute right-1.5 bottom-12 flex flex-col items-center gap-3 text-white ${CHROME}`}>
                <RailButton count="12.4K">
                    <Heart size={22} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="892">
                    <MessageCircle size={22} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Send size={22} className="-rotate-12" />
                </RailButton>
                <RailButton>
                    <div className="w-6 h-6 rounded-full bg-white/10 border border-white flex items-center justify-center text-[11px] font-bold">
                        ♪
                    </div>
                </RailButton>
                <RailButton>
                    <Bookmark size={22} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <MoreHorizontal size={22} />
                </RailButton>
                <div className="mt-1 w-6 h-6 rounded-full bg-zinc-900 border border-white/40 flex items-center justify-center overflow-hidden">
                    <User size={12} className="text-zinc-300" />
                </div>
            </div>

            {/* Bottom info — username, caption, music. Sits just above where
                the app's bottom nav lives in the real app, but we omit that
                nav because it's app chrome, not video chrome. */}
            <div className={`absolute left-3 right-14 bottom-3 z-10 text-white ${CHROME}`}>
                <div className="text-[11px] font-bold mb-0.5">opusshorts</div>
                <div className="text-[10px] leading-snug mb-1 line-clamp-2">
                    See exactly how your Reel will look on Instagram. Reposition captions 👇
                </div>
                <div className="flex items-center gap-1.5 text-[10px] opacity-90">
                    <Music2 size={10} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>
        </>
    );
}

// ----------------------------------------------------------------------------
// Public component — chrome-only, no children. Renders as a sibling of the
// Player inside the boxStyle-constrained container in EditorCanvas, so the
// chrome tracks the video frame exactly and the chrome's z-10 layers can
// never escape it.
// ----------------------------------------------------------------------------
const SocialMediaPreview = forwardRef(function SocialMediaPreview({ platform }) {
    if (platform === 'tiktok') return <TikTokOverlay />;
    if (platform === 'youtube-shorts') return <YouTubeShortsOverlay />;
    if (platform === 'instagram-reels') return <InstagramReelsOverlay />;
    return null;
});

export const PLATFORMS = [
    { id: 'tiktok', label: 'TikTok', short: 'TT' },
    { id: 'youtube-shorts', label: 'YouTube Shorts', short: 'YT' },
    { id: 'instagram-reels', label: 'Instagram Reels', short: 'IG' },
];

export default SocialMediaPreview;
