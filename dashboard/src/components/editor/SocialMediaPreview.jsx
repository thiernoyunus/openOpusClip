import React, { forwardRef } from 'react';
import {
    MessageCircle,
    Heart,
    Share2,
    Bookmark,
    MoreHorizontal,
    User,
    Music2,
    Play,
    Send,
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
 * Sizes / positions are calibrated against the actual 1080 × 1920 short-form
 * video canvas using the platforms' published safe-zone specs:
 *
 *   TikTok          right rail at x ≈ 940 (~13%)  | icons 48-56px | avatar 64-72px
 *   YouTube Shorts  right action column in rightmost 120-200px | top safe y < 240, bottom y > 1540
 *   Instagram Reels right edge of icons at x ≈ 1010 (~6.5%) | icons 42-52px | music disc y ~1480-1580
 *
 * All chrome uses percentage units so it scales with the preview frame
 * (which is a scaled box around the same 9:16 content). Only overlays that
 * sit ON TOP of the video are rendered — app-level chrome BELOW the video
 * (TikTok / Instagram bottom navs) is intentionally omitted, because those
 * live in the host app below the player, not on top of the video.
 *
 * Every chrome layer is pointer-events-none so the editor's click overlays
 * (TrackerOverlay, PanelCropOverlay, CaptionDragOverlay) still receive input
 * through the covered regions.
 */

const CHROME = 'pointer-events-none';

// Side rail button. Icon is sized by the caller via inline width/height
// styles. Counts / labels below match the platform's own typography (~10-11px).
const RailButton = ({ children, label, count }) => (
    <div className="flex flex-col items-center gap-[2px]">
        <div className="drop-shadow-md text-white">{children}</div>
        {count != null && (
            <span className="text-[10px] font-semibold text-white drop-shadow-md tabular-nums leading-none">
                {count}
            </span>
        )}
        {label && (
            <span className="text-[10px] font-semibold text-white drop-shadow-md leading-none">
                {label}
            </span>
        )}
    </div>
);

// ----------------------------------------------------------------------------
// TikTok overlay — reference canvas 1080 × 1920
// Right rail at x ≈ 940 (~13% from right edge), icons ~48-56px (~4.8%),
// profile circle ~68px (~6.3%), music disc ~64px.
// ----------------------------------------------------------------------------
function TikTokOverlay() {
    return (
        <>
            {/* Right side action rail — bottom-anchored. */}
            <div
                className={`absolute right-[3%] bottom-[18%] flex flex-col items-center gap-[3.5%] z-10 ${CHROME}`}
                style={{ width: '14%' }}
            >
                {/* Profile circle + follow + */}
                <div className="relative" style={{ width: '6.5%', aspectRatio: '1 / 1' }}>
                    <div className="w-full h-full rounded-full bg-gradient-to-tr from-pink-500 via-red-500 to-yellow-400 p-[6%]">
                        <div className="w-full h-full rounded-full bg-zinc-800 border-[6%] border-black flex items-center justify-center overflow-hidden">
                            <User style={{ width: '55%', height: '55%' }} className="text-zinc-400" />
                        </div>
                    </div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="absolute -bottom-[15%] left-1/2 -translate-x-1/2 rounded-full bg-rose-500 text-white flex items-center justify-center font-bold leading-none pointer-events-auto"
                        style={{ width: '60%', aspectRatio: '1 / 1', fontSize: '10px' }}
                    >
                        +
                    </button>
                </div>

                <RailButton count="124.5K">
                    <Heart style={{ width: '4.8%', height: '4.8%', minWidth: '34px', minHeight: '34px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="2,431">
                    <MessageCircle style={{ width: '4.8%', height: '4.8%', minWidth: '34px', minHeight: '34px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="1,807">
                    <Bookmark style={{ width: '4.8%', height: '4.8%', minWidth: '34px', minHeight: '34px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 style={{ width: '4.8%', height: '4.8%', minWidth: '34px', minHeight: '34px' }} className="text-white" />
                </RailButton>

                {/* Spinning music disc */}
                <div
                    className="rounded-full bg-zinc-900 border border-white/20 flex items-center justify-center animate-[spin_6s_linear_infinite] mt-[6%]"
                    style={{ width: '5.5%', height: '5.5%', minWidth: '40px', minHeight: '40px' }}
                >
                    <Disc3 style={{ width: '70%', height: '70%' }} className="text-zinc-300" />
                </div>
            </div>

            {/* Bottom info — username, caption, music. */}
            <div
                className={`absolute left-[3%] right-[18%] bottom-[3%] z-10 text-white drop-shadow-md ${CHROME}`}
            >
                <div className="font-bold mb-[0.4%] text-[12px] leading-tight">@opusshorts</div>
                <div className="leading-snug mb-[1%] text-[11px]">
                    Make your short look exactly like it will on TikTok 👇
                    <span className="text-cyan-300 ml-1">#viral</span>
                    <span className="text-cyan-300 ml-1">#openshorts</span>
                </div>
                <div className="flex items-center gap-[1.5%] text-[11px] leading-tight">
                    <Music2 style={{ width: '11px', height: '11px', minWidth: '11px', minHeight: '11px' }} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>

            {/* Top "Following / For You" tab — slim header. */}
            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-center pt-[1%] pb-[0.5%] text-[11px] font-semibold text-white ${CHROME}`}>
                <span className="opacity-70">Following</span>
                <span className="mx-[3%] h-3 w-px bg-white/40" />
                <span className="border-b-2 border-white pb-0.5">For You</span>
            </div>
        </>
    );
}

// ----------------------------------------------------------------------------
// YouTube Shorts overlay — reference canvas 1080 × 1920
// Right action button column in rightmost 120-200px. Top safe area y < 240,
// bottom safe area y > 1540.
// ----------------------------------------------------------------------------
function YouTubeShortsOverlay() {
    return (
        <>
            {/* Top bar — Shorts title + close */}
            <div
                className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-[3%] pt-[1.5%] pb-[0.5%] text-white ${CHROME}`}
            >
                <div className="flex items-center gap-[1.5%]">
                    <Play style={{ width: '16px', height: '16px', minWidth: '16px', minHeight: '16px' }} fill="white" className="text-white" />
                    <span className="text-[13px] font-semibold tracking-tight">Shorts</span>
                </div>
                <div className="flex items-center gap-[3%]">
                    <SearchGlyph />
                    <BellGlyph />
                    <SettingsGlyph />
                </div>
            </div>

            {/* Right side action rail — bottom-anchored. Real Shorts ~56-64px icons. */}
            <div className={`absolute right-[2.5%] bottom-[8%] flex flex-col items-center gap-[3.5%] text-white ${CHROME}`}>
                <RailButton count="48K">
                    <Heart style={{ width: '5.5%', height: '5.5%', minWidth: '40px', minHeight: '40px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton label="Dislike">
                    <div className="text-white text-[22px] leading-none -scale-100 drop-shadow-md">👎</div>
                </RailButton>
                <RailButton count="1,204">
                    <MessageCircle style={{ width: '5.5%', height: '5.5%', minWidth: '40px', minHeight: '40px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 style={{ width: '5.5%', height: '5.5%', minWidth: '40px', minHeight: '40px' }} className="text-white" />
                </RailButton>
                <RailButton>
                    <Edit2 style={{ width: '5.5%', height: '5.5%', minWidth: '40px', minHeight: '40px' }} className="text-white" />
                </RailButton>
            </div>

            {/* Bottom channel info + description */}
            <div className={`absolute left-[3%] right-[18%] bottom-[2.5%] z-10 text-white ${CHROME}`}>
                <div className="flex items-center gap-[2%] mb-[1.5%]">
                    <div className="rounded-full bg-zinc-700 border border-white/30 flex items-center justify-center overflow-hidden" style={{ width: '36px', height: '36px' }}>
                        <User style={{ width: '18px', height: '18px' }} className="text-zinc-300" />
                    </div>
                    <div className="text-[12px] font-semibold">@opusshorts</div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="ml-[1.5%] rounded-full bg-white text-black text-[10px] font-semibold pointer-events-auto"
                        style={{ height: '24px', padding: '0 12px' }}
                    >
                        Subscribe
                    </button>
                </div>
                <div className="text-[11px] leading-snug mb-[0.6%] line-clamp-2">
                    See exactly how your Short will look on YouTube. Position captions inside the safe zone 👇
                </div>
                <div className="flex items-center gap-[1.5%] text-[10px] opacity-90 leading-tight">
                    <Music2 style={{ width: '11px', height: '11px', minWidth: '11px', minHeight: '11px' }} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>
        </>
    );
}

// Tiny inline SVG glyphs for the YouTube top bar — fixed ~17px to match
// the top bar's other icons.
const SearchGlyph = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white" style={{ width: '17px', height: '17px' }}>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" x2="16.65" y1="21" y2="16.65" />
    </svg>
);
const BellGlyph = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white" style={{ width: '17px', height: '17px' }}>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
);
const SettingsGlyph = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white" style={{ width: '17px', height: '17px' }}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
);

// ----------------------------------------------------------------------------
// Instagram Reels overlay — reference canvas 1080 × 1920
// Right edge of icon artwork at x ≈ 1010 (~6.5%). Icons ~42-52px (~4.5%).
// Music disc at y ~1480-1580. Bottom safe area y > 1540.
// ----------------------------------------------------------------------------
function InstagramReelsOverlay() {
    return (
        <>
            {/* Top bar — Reels title + camera. */}
            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-[3%] pt-[1.5%] pb-[0.5%] text-white ${CHROME}`}>
                <ChevronDown style={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }} />
                <span className="text-[14px] font-semibold tracking-tight">Reels</span>
                <Camera style={{ width: '18px', height: '18px', minWidth: '18px', minHeight: '18px' }} />
            </div>

            {/* Right side action rail — real Reels icons ~48px (~4.5%). */}
            <div className={`absolute right-[2.5%] bottom-[8%] flex flex-col items-center gap-[3.5%] text-white ${CHROME}`}>
                <RailButton count="12.4K">
                    <Heart style={{ width: '4.5%', height: '4.5%', minWidth: '32px', minHeight: '32px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="892">
                    <MessageCircle style={{ width: '4.5%', height: '4.5%', minWidth: '32px', minHeight: '32px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Send style={{ width: '4.5%', height: '4.5%', minWidth: '32px', minHeight: '32px', transform: 'rotate(-12deg)' }} className="text-white" />
                </RailButton>
                <RailButton>
                    <div className="rounded-full bg-white/10 border border-white flex items-center justify-center font-bold" style={{ width: '28px', height: '28px', fontSize: '11px' }}>♪</div>
                </RailButton>
                <RailButton>
                    <Bookmark style={{ width: '4.5%', height: '4.5%', minWidth: '32px', minHeight: '32px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <MoreHorizontal style={{ width: '4.5%', height: '4.5%', minWidth: '32px', minHeight: '32px' }} className="text-white" />
                </RailButton>
                {/* Profile disc at very bottom of rail. */}
                <div className="mt-[6%] rounded-full bg-zinc-900 border border-white/40 flex items-center justify-center overflow-hidden" style={{ width: '28px', height: '28px' }}>
                    <User style={{ width: '14px', height: '14px' }} className="text-zinc-300" />
                </div>
            </div>

            {/* Bottom info — username, caption, music. Above the app's bottom
                nav; we don't render that nav (app shell, not video chrome). */}
            <div className={`absolute left-[3%] right-[16%] bottom-[2.5%] z-10 text-white ${CHROME}`}>
                <div className="font-bold mb-[0.4%] text-[12px] leading-tight">opusshorts</div>
                <div className="text-[11px] leading-snug mb-[0.6%] line-clamp-2">
                    See exactly how your Reel will look on Instagram. Reposition captions 👇
                </div>
                <div className="flex items-center gap-[1.5%] text-[10px] opacity-90 leading-tight">
                    <Music2 style={{ width: '11px', height: '11px', minWidth: '11px', minHeight: '11px' }} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>
        </>
    );
}

// ----------------------------------------------------------------------------
// Public component — chrome-only, no children. Renders as a sibling of the
// Player inside the boxStyle-constrained container in EditorCanvas.
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
