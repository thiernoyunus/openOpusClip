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

function ClipCard({ platform, poster, cardRef }) {
  const { Icon, label, score, bg } = platform;
  return (
    // Outer wrapper: NO overflow-hidden, so the platform circle can spill past
    // the top edge without being clipped. Media clipping lives on the inner div.
    <div
      ref={cardRef}
      className="showcase-card relative w-[120px] sm:w-[140px] shrink-0"
    >
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

export default function ClipShowcase({ onLaunchApp }) {
  const rootRef = useRef(null);
  const videoRef = useRef(null);
  const sourceRef = useRef(null);
  const barRef = useRef(null);
  const cardRefs = useRef([]);

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();

      // ── Motion path: self-running loop on desktop, video allowed everywhere ──
      // Only build the timeline at >=1024px. Below that we keep it cheap and show
      // the static final layout (CSS), but the video may still play if motion is ok.
      mm.add(
        {
          isDesktop: '(min-width: 1024px)',
          reduceMotion: '(prefers-reduced-motion: reduce)',
        },
        (context) => {
          const { isDesktop, reduceMotion } = context.conditions;

          // Video: play only when motion is welcome. Reduced-motion → poster only.
          if (!reduceMotion && videoRef.current) videoRef.current.play().catch(() => {});

          // No loop timeline for reduced-motion or non-desktop: render static final
          // state (cards + badges already visible via base CSS — nothing to do).
          if (reduceMotion || !isDesktop) return;

          const cards = cardRefs.current.filter(Boolean);
          const badges = rootRef.current.querySelectorAll('.showcase-badge');
          const shimmer = rootRef.current.querySelector('.showcase-shimmer');

          // 1. One-time intro: source card + input bar drift in, then STAY PUT.
          //    Kept outside the loop so the hero video never blinks on repeat.
          gsap.fromTo(
            [sourceRef.current, barRef.current],
            { y: -30, opacity: 0 },
            { y: 0, opacity: 1, ease: 'power3.out', duration: 0.6, stagger: 0.12 }
          );

          // Repeating cycle: shimmer -> clips deal out -> badges -> fade out.
          const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2, delay: 0.7 });

          // 2. Processing beat — shimmer sweeps the bar + a gentle button pulse.
          tl.fromTo(
            shimmer,
            { xPercent: -120, opacity: 0.9 },
            { xPercent: 120, ease: 'power1.inOut', duration: 1.0 },
            0
          );
          tl.to('.showcase-cta', { scale: 1.05, duration: 0.35, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 0.1);

          // 3. Six clips deal out below, staggered + alternating tilt.
          tl.fromTo(
            cards,
            { opacity: 0, scale: 0.7, y: 50 },
            {
              opacity: 1, scale: 1, y: 0,
              rotate: (i) => (i % 2 === 0 ? -3 : 3),
              ease: 'power3.out', duration: 0.5, stagger: 0.07,
            },
            0.9
          );
          // Then platform + score badges pop.
          tl.fromTo(
            badges,
            { scale: 0, opacity: 0 },
            { scale: 1, opacity: 1, ease: 'back.out(1.7)', duration: 0.35, stagger: 0.03 },
            1.5
          );

          // 4. Hold, then clips + badges fade down/out quickly. Source stays put.
          tl.to([cards, badges], {
            opacity: 0, y: 30, duration: 0.4, ease: 'power1.in', stagger: 0.02,
          }, '+=2');

          // Pause the loop + video when offscreen; resume when visible.
          ScrollTrigger.create({
            trigger: rootRef.current,
            start: 'top bottom',
            end: 'bottom top',
            onToggle: (self) => {
              const v = videoRef.current;
              if (self.isActive) {
                tl.play();
                if (v) v.play().catch(() => {});
              } else {
                tl.pause();
                if (v) v.pause();
              }
            },
          });
        }
      );
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={rootRef} className="relative min-h-[80vh] flex flex-col items-center justify-center px-6 py-16 overflow-hidden">
      {/* dark radial stage glow */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.10),transparent_60%)]" />

      {/* source 16:9 video */}
      <div ref={sourceRef} className="showcase-source relative w-full max-w-[560px] aspect-video rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/50">
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
      <div ref={barRef} className="relative z-10 mt-6">
        <button
          onClick={onLaunchApp}
          className="showcase-cta relative flex items-center gap-3 bg-black/60 backdrop-blur border border-white/10 rounded-full pl-4 pr-2 py-2 hover:border-primary/40 transition-colors group overflow-hidden"
        >
          {/* shimmer sweep for the "processing" beat */}
          <span className="showcase-shimmer pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/15 to-transparent opacity-0" />
          <Link2 size={16} className="text-zinc-500" />
          <span className="text-sm text-zinc-400">Drop a long video and…</span>
          <span className="flex items-center gap-1.5 bg-white text-black text-sm font-semibold rounded-full px-4 py-1.5 group-hover:bg-primary group-hover:text-white transition-colors">
            Get clips <ArrowRight size={15} />
          </span>
        </button>
      </div>

      {/* generated 9:16 clips */}
      <div className="relative z-0 mt-10 flex flex-nowrap lg:flex-wrap items-start justify-start lg:justify-center gap-3 sm:gap-4 max-w-5xl w-full overflow-x-auto lg:overflow-visible snap-x snap-mandatory pb-2 px-1">
        {PLATFORMS.map((p, i) => (
          <div key={p.label} className="snap-center pt-3">
            <ClipCard
              platform={p}
              poster={`/landing/clip-${i + 1}.jpg`}
              cardRef={(el) => (cardRefs.current[i] = el)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
