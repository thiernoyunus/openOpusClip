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
 * Sizes are calibrated against the user's Pencil mockup
 * (gmeet.pen — TikTok / YouTube / Instagram feed mockups, 280 × 560 reference
 * frame). The pencil data shows the exact right-rail inset and icon sizes
 * the user wants to match:
 *
 *   TikTok          rail at x=237 (right edge 43px = 15.4% from frame edge)
 *                   y=278 (49.6%) | profile 32×32 | icons 20×20 (7.1%)
 *   YouTube Shorts  rail at x=240 (right edge 40px = 14.3%)
 *                   y=293 (52.3%) | icons 20×20 | avatar 28×28
 *   Instagram Reels rail at x=243 (right edge 37px = 13.2%)
 *                   y=298 (53.2%) | icons 20×20 | avatar 28×28
 *
 * Only over-video chrome is rendered. App-level chrome BELOW the video
 * (TikTok / Instagram bottom navs) is intentionally omitted — those live
 * in the host app, not on top of the video.
 *
 * Every chrome layer is pointer-events-none so the editor's click overlays
 * (TrackerOverlay, PanelCropOverlay, CaptionDragOverlay) still receive input
 * through the covered regions.
 */

const CHROME = 'pointer-events-none';

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
// TikTok overlay — pencil reference 280 × 560
// RightIcons group at x=237, y=278 (right edge 43px = 15.4%).
// Profile 32×32, icons 20×20 (7.1%). TikTok wordmark at bottom-right.
// ----------------------------------------------------------------------------
function TikTokOverlay() {
    return (
        <>
            <div
                className={`absolute right-[15%] top-[49%] flex flex-col items-center gap-[3%] z-10 ${CHROME}`}
            >
                <div className="relative" style={{ width: '32px', height: '32px' }}>
                    <div className="w-full h-full rounded-full bg-gradient-to-tr from-pink-500 via-red-500 to-yellow-400 p-[2px]">
                        <div className="w-full h-full rounded-full bg-zinc-800 border-[2px] border-black flex items-center justify-center overflow-hidden">
                            <User style={{ width: '16px', height: '16px' }} className="text-zinc-400" />
                        </div>
                    </div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-rose-500 text-white flex items-center justify-center font-bold leading-none pointer-events-auto"
                        style={{ width: '12px', height: '12px', fontSize: '9px' }}
                    >
                        +
                    </button>
                </div>

                <RailButton count="124.5K">
                    <Heart style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="2,431">
                    <MessageCircle style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="1,807">
                    <Bookmark style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 style={{ width: '20px', height: '20px' }} className="text-white" />
                </RailButton>
            </div>

            <div
                className={`absolute left-[2%] right-[20%] bottom-[2%] z-10 text-white drop-shadow-md ${CHROME}`}
            >
                <div className="font-bold text-[12px] leading-tight mb-0.5">@opusshorts</div>
                <div className="leading-snug mb-1 text-[10px]">
                    Make your short look exactly like it will on TikTok 👇
                    <span className="text-cyan-300 ml-1">#viral</span>
                    <span className="text-cyan-300 ml-1">#openshorts</span>
                </div>
                <div className="flex items-center gap-[4px] text-[10px] leading-tight">
                    <Music2 style={{ width: '10px', height: '10px' }} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>

            <div className={`absolute bottom-[3%] right-[3%] z-10 ${CHROME}`}>
                <svg viewBox="0 0 24 24" fill="white" style={{ width: '18px', height: '18px' }}>
                    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.1z" />
                </svg>
            </div>

            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-center pt-[1%] pb-[0.5%] text-[11px] font-semibold text-white ${CHROME}`}>
                <span className="opacity-70">Following</span>
                <span className="mx-[3%] h-3 w-px bg-white/40" />
                <span className="border-b-2 border-white pb-0.5">For You</span>
            </div>
        </>
    );
}

// ----------------------------------------------------------------------------
// YouTube Shorts overlay — pencil reference 280 × 560
// RightIcons at x=240, y=293 (right edge 40px = 14.3%). Icons 20×20.
// Avatar 28×28, YTBtn (Subscribe) 26×18 at bottom.
// ----------------------------------------------------------------------------
function YouTubeShortsOverlay() {
    return (
        <>
            <div
                className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-[3%] pt-[1.5%] pb-[0.5%] text-white ${CHROME}`}
            >
                <div className="flex items-center gap-[4px]">
                    <Play style={{ width: '14px', height: '14px' }} fill="white" className="text-white" />
                    <span className="text-[12px] font-semibold tracking-tight">Shorts</span>
                </div>
                <div className="flex items-center gap-[3%]">
                    <SearchGlyph />
                    <BellGlyph />
                </div>
            </div>

            <div className={`absolute right-[14%] top-[52%] flex flex-col items-center gap-[3%] text-white ${CHROME}`}>
                <RailButton count="48K">
                    <Heart style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton label="Dislike">
                    <div className="text-white text-[18px] leading-none -scale-100 drop-shadow-md">👎</div>
                </RailButton>
                <RailButton count="1,204">
                    <MessageCircle style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Share2 style={{ width: '20px', height: '20px' }} className="text-white" />
                </RailButton>
                <RailButton>
                    <Edit2 style={{ width: '20px', height: '20px' }} className="text-white" />
                </RailButton>
            </div>

            <div className={`absolute left-[3%] right-[20%] bottom-[2%] z-10 text-white ${CHROME}`}>
                <div className="flex items-center gap-[6px] mb-[4px]">
                    <div className="rounded-full bg-zinc-700 border border-white/30 flex items-center justify-center overflow-hidden" style={{ width: '28px', height: '28px' }}>
                        <User style={{ width: '14px', height: '14px' }} className="text-zinc-300" />
                    </div>
                    <div className="text-[11px] font-semibold">@opusshorts</div>
                    <button
                        type="button"
                        tabIndex={-1}
                        className="rounded-full bg-white text-black text-[10px] font-semibold pointer-events-auto"
                        style={{ height: '20px', padding: '0 8px' }}
                    >
                        Subscribe
                    </button>
                </div>
                <div className="text-[10px] leading-snug mb-[2px] line-clamp-2">
                    See exactly how your Short will look on YouTube. Position captions inside the safe zone 👇
                </div>
                <div className="flex items-center gap-[4px] text-[10px] opacity-90 leading-tight">
                    <Music2 style={{ width: '10px', height: '10px' }} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>
        </>
    );
}

const SearchGlyph = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white" style={{ width: '16px', height: '16px' }}>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" x2="16.65" y1="21" y2="16.65" />
    </svg>
);
const BellGlyph = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white" style={{ width: '16px', height: '16px' }}>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
);

// ----------------------------------------------------------------------------
// instagram Reels overlay — pencil reference 280 × 560
// RightIcons at x=243, y=298 (right edge 37px = 13.2%). Icons 20×20.
// Avatar 28×28, IGBtn 24×24 at bottom-right.
// ----------------------------------------------------------------------------
function InstagramReelsOverlay() {
    return (
        <>
            <div className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-[3%] pt-[1.5%] pb-[0.5%] text-white ${CHROME}`}>
                <ChevronDown style={{ width: '16px', height: '16px' }} />
                <span className="text-[12px] font-semibold tracking-tight">Reels</span>
                <Camera style={{ width: '16px', height: '16px' }} />
            </div>

            <div className={`absolute right-[13%] top-[53%] flex flex-col items-center gap-[3%] text-white ${CHROME}`}>
                <RailButton count="12.4K">
                    <Heart style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton count="892">
                    <MessageCircle style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <Send style={{ width: '20px', height: '20px', transform: 'rotate(-12deg)' }} className="text-white" />
                </RailButton>
                <RailButton>
                    <div className="rounded-full bg-white/10 border border-white flex items-center justify-center font-bold" style={{ width: '20px', height: '20px', fontSize: '10px' }}>♪</div>
                </RailButton>
                <RailButton>
                    <Bookmark style={{ width: '20px', height: '20px' }} fill="white" className="text-white" />
                </RailButton>
                <RailButton>
                    <MoreHorizontal style={{ width: '20px', height: '20px' }} className="text-white" />
                </RailButton>
            </div>

            <div className={`absolute left-[3%] right-[18%] bottom-[2%] z-10 text-white ${CHROME}`}>
                <div className="flex items-center gap-[4px] mb-[2px]">
                    <div className="rounded-full bg-zinc-900 border border-white/40 flex items-center justify-center overflow-hidden" style={{ width: '28px', height: '28px' }}>
                        <User style={{ width: '14px', height: '14px' }} className="text-zinc-300" />
                    </div>
                    <div className="text-[11px] font-bold">opusshorts</div>
                </div>
                <div className="text-[10px] leading-snug mb-[2px] line-clamp-2">
                    See exactly how your Reel will look on Instagram. Reposition captions 👇
                </div>
                <div className="flex items-center gap-[4px] text-[10px] opacity-90 leading-tight">
                    <Music2 style={{ width: '10px', height: '10px' }} />
                    <span className="truncate">original sound — opusshorts</span>
                </div>
            </div>

            <div className={`absolute bottom-[3%] right-[3%] z-10 ${CHROME}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}>
                    <rect x="2" y="2" width="20" height="20" rx="5" />
                    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
                </svg>
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
