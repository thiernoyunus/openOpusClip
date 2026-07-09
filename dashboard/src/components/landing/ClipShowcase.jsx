import React, { useLayoutEffect, useRef } from 'react';
import { Youtube, Instagram, Linkedin, Facebook, Link2, ArrowRight } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const TikTokIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743l-.002-.001.002.001a2.895 2.895 0 0 1 3.183-4.51v-3.5a6.329 6.329 0 0 0-5.394 10.692 6.33 6.33 0 0 0 10.857-4.424V8.687a8.182 8.182 0 0 0 4.773 1.526V6.79a4.831 4.831 0 0 1-1.003-.104z" />
  </svg>
);

const XIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

// Real scores from the "In Pursuit of Knowledge" job (result.json clip 1-6).
const PLATFORMS = [
  { Icon: Youtube, label: 'YouTube', score: 95, bg: '#FF0000' },
  { Icon: Instagram, label: 'Instagram', score: 90, bg: '#E1306C' },
  { Icon: Linkedin, label: 'LinkedIn', score: 88, bg: '#0A66C2' },
  { Icon: TikTokIcon, label: 'TikTok', score: 85, bg: '#111111' },
  { Icon: Facebook, label: 'Facebook', score: 82, bg: '#1877F2' },
  { Icon: XIcon, label: 'X', score: 80, bg: '#111111' },
];

// A single 9:16 clip card. `cardRef`/`badgeClass` let the desktop storyboard
// grab the animated pieces; on mobile they're plain (marquee/grid) cards.
function ClipCard({ platform, poster, cardRef, className = '' }) {
  const { Icon, label, score, bg } = platform;
  return (
    // Outer wrapper: NO overflow-hidden, so the platform circle can spill past
    // the top edge without being clipped. Media clipping lives on the inner div.
    <div ref={cardRef} className={`showcase-card relative w-[96px] sm:w-[120px] lg:w-[140px] shrink-0 ${className}`}>
      <div
        className="rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-xl shadow-black/40 bg-surface"
        style={{ aspectRatio: '9 / 16' }}
      >
        <img src={poster} alt={`Vertical clip for ${label}`} loading="lazy" className="w-full h-full object-cover" />
        {/* virality score, bottom-left — stays inside the media */}
        <div className="showcase-badge absolute bottom-2 left-2 bg-black/70 backdrop-blur rounded-lg px-2 py-1 leading-none">
          <div className="text-[8px] font-semibold tracking-widest text-zinc-400">SCORE</div>
          <div className="text-lg font-extrabold text-[#3DD68C]">{score}</div>
        </div>
      </div>
      {/* platform icon, overlapping the top edge (on the un-clipped outer div) */}
      <div
        className="showcase-badge absolute -top-3 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full flex items-center justify-center text-white ring-2 ring-background"
        style={{ backgroundColor: bg }}
      >
        <Icon size={16} />
      </div>
    </div>
  );
}

// The input-pill mock. Shared by desktop + mobile so the CTA is identical.
function InputPill({ onLaunchApp, barRef, iconRef }) {
  return (
    <div ref={barRef} className="relative z-10">
      <button
        onClick={onLaunchApp}
        className="showcase-cta relative flex items-center gap-3 bg-black/60 backdrop-blur border border-white/10 rounded-full pl-4 pr-2 py-2 hover:border-primary/40 transition-colors group overflow-hidden"
      >
        {/* shimmer sweep for the "processing" beat */}
        <span className="showcase-shimmer pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/15 to-transparent opacity-0" />
        <Link2 ref={iconRef} size={16} className="text-zinc-500" />
        <span className="text-sm text-zinc-400">Drop a long video and…</span>
        <span className="flex items-center gap-1.5 bg-white text-black text-sm font-semibold rounded-full px-4 py-1.5 group-hover:bg-primary group-hover:text-white transition-colors">
          Get clips <ArrowRight size={15} />
        </span>
      </button>
    </div>
  );
}

export default function ClipShowcase({ onLaunchApp }) {
  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const videoRef = useRef(null);
  const sourceRef = useRef(null);
  const barRef = useRef(null);
  const iconRef = useRef(null);
  const taglineRef = useRef(null);
  const cardRefs = useRef([]);

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();

      // Move an element's center onto a target element's center. Measured at
      // refresh (invalidateOnRefresh) so resize keeps the travel correct.
      const centerDelta = (el, target) => {
        const a = el.getBoundingClientRect();
        const b = target.getBoundingClientRect();
        return {
          x: b.left + b.width / 2 - (a.left + a.width / 2),
          y: b.top + b.height / 2 - (a.top + a.height / 2),
        };
      };

      // ── Motion welcome (ALL widths): pinned scroll-scrubbed storyboard ──────
      // Runs on mobile too — the per-card centerDelta() targets wherever each
      // card sits in the responsive layout (3×2 grid on phones, 1 row on lg),
      // so the same "video → bar → clips" effect plays at every width.
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const cards = cardRefs.current.filter(Boolean);
        const badges = stageRef.current.querySelectorAll('.showcase-badge');
        const shimmer = stageRef.current.querySelector('.showcase-shimmer');

        // Play the hero video only while the section is on screen. Separate,
        // NON-pinning ScrollTrigger so it never fights the pinned timeline.
        const v = videoRef.current;
        if (v) v.play().catch(() => {});
        ScrollTrigger.create({
          trigger: rootRef.current,
          start: 'top bottom',
          end: 'bottom top',
          onToggle: (self) => {
            if (!v) return;
            if (self.isActive) v.play().catch(() => {});
            else v.pause();
          },
        });

        const tl = gsap.timeline({
          defaults: { ease: 'power2.inOut' },
          scrollTrigger: {
            trigger: rootRef.current,
            start: 'top top',
            end: '+=220%',
            scrub: 0.8,
            pin: stageRef.current, // pin the wrapper; animate its children only
            invalidateOnRefresh: true,
            // Sits above FeatureRail on the page → must refresh first (lower number).
            refreshPriority: 0,
          },
        });

        // a. Video card gets sucked INTO the pill's link icon (shrink + travel),
        //    fading to 0 only at the very end of the trip. (0 → 0.35)
        tl.to(sourceRef.current, {
          x: () => centerDelta(sourceRef.current, iconRef.current).x,
          y: () => centerDelta(sourceRef.current, iconRef.current).y,
          scale: 0.18,
          ease: 'power2.in',
          duration: 0.35,
        }, 0);
        tl.to(sourceRef.current, { opacity: 0, ease: 'power1.in', duration: 0.09 }, 0.26);
        // Pill reacts: nudges bigger and a shimmer sweeps it once (scroll-tied).
        tl.to(barRef.current, { scale: 1.04, ease: 'power2.out', duration: 0.35 }, 0);
        tl.fromTo(shimmer,
          { xPercent: -130, opacity: 0 },
          { xPercent: 130, opacity: 0.9, ease: 'power1.inOut', duration: 0.3 }, 0.05);
        tl.to(shimmer, { opacity: 0, duration: 0.06 }, 0.32);

        // b. Six clips fan OUT of the pill into their row. (0.35 → 0.75)
        tl.fromTo(cards,
          {
            x: (i, el) => centerDelta(el, iconRef.current).x,
            y: (i, el) => centerDelta(el, iconRef.current).y,
            scale: 0.3,
            opacity: 0,
            rotate: 0,
          },
          {
            x: 0,
            y: 0,
            scale: 1,
            opacity: 1,
            rotate: (i) => (i % 2 === 0 ? -3 : 3),
            ease: 'power3.out',
            duration: 0.4,
            stagger: 0.06,
          }, 0.35);
        // Badges pop in the tail.
        tl.fromTo(badges,
          { scale: 0, opacity: 0 },
          { scale: 1, opacity: 1, ease: 'back.out(1.7)', duration: 0.3, stagger: 0.03 }, 0.62);

        // c. Settle + tagline. (0.78 → 1)
        tl.fromTo(taglineRef.current,
          { opacity: 0, y: 12 },
          { opacity: 1, y: 0, ease: 'power2.out', duration: 0.22 }, 0.78);
      });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={rootRef} className="relative overflow-x-hidden">
      {/* ── Storyboard stage (pinned + scrubbed) at ALL widths. Hidden for reduced-motion. ── */}
      <div
        ref={stageRef}
        className="motion-reduce:hidden flex relative min-h-screen flex-col items-center justify-center px-6 overflow-hidden"
      >
        {/* dark radial stage glow — subtle ScrollSmoother parallax */}
        <div
          data-speed="0.9"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.10),transparent_60%)]"
        />

        {/* source 16:9 video */}
        <div
          ref={sourceRef}
          className="showcase-source relative w-full max-w-[340px] sm:max-w-[480px] lg:max-w-[560px] aspect-video rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/50"
        >
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            src="/landing/source-loop.mp4"
            poster="/landing/source-poster.jpg"
            muted
            playsInline
            loop
            preload="metadata"
          />
        </div>

        {/* input bar mock — the primary CTA */}
        <div className="mt-6">
          <InputPill onLaunchApp={onLaunchApp} barRef={barRef} iconRef={iconRef} />
        </div>

        {/* generated 9:16 clips — 3×2 grid on phones, single row on desktop */}
        <div className="relative z-0 mt-8 lg:mt-10 grid grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-4 place-items-center max-w-md lg:max-w-5xl w-full">
          {PLATFORMS.map((p, i) => (
            <div key={p.label} className="pt-3">
              <ClipCard
                platform={p}
                poster={`/landing/clip-${i + 1}.jpg`}
                cardRef={(el) => (cardRefs.current[i] = el)}
              />
            </div>
          ))}
        </div>

        {/* settle tagline */}
        <p ref={taglineRef} className="mt-8 text-sm text-zinc-500 text-center">
          One upload in, a whole feed of scored clips out.
        </p>
      </div>

      {/* ── Reduced-motion fallback (any width) — static pill + 3×2 grid ── */}
      <div className="hidden motion-reduce:flex flex-col items-center gap-8 px-6 py-16">
        <InputPill onLaunchApp={onLaunchApp} />
        <div className="grid grid-cols-3 gap-3 place-items-center max-w-md mx-auto">
          {PLATFORMS.map((p, i) => (
            <div key={`g-${p.label}`} className="pt-3">
              <ClipCard platform={p} poster={`/landing/clip-${i + 1}.jpg`} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
