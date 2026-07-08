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
    <div
      ref={cardRef}
      className="showcase-card relative w-[120px] sm:w-[140px] shrink-0 rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-xl shadow-black/40 bg-surface"
      style={{ aspectRatio: '9 / 16' }}
    >
      <img src={poster} alt={`Vertical clip for ${label}`} loading="lazy" className="w-full h-full object-cover" />
      {/* platform icon, overlapping the top edge */}
      <div
        className="showcase-badge absolute -top-3 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full flex items-center justify-center text-white ring-2 ring-background"
        style={{ backgroundColor: bg }}
      >
        <Icon size={16} />
      </div>
      {/* virality score, bottom-left */}
      <div className="showcase-badge absolute bottom-2 left-2 bg-black/70 backdrop-blur rounded-lg px-2 py-1 leading-none">
        <div className="text-[8px] font-semibold tracking-widest text-zinc-400">SCORE</div>
        <div className="text-lg font-extrabold text-[#3DD68C]">{score}</div>
      </div>
    </div>
  );
}

export default function ClipShowcase({ onLaunchApp }) {
  const stageRef = useRef(null);
  const videoRef = useRef(null);
  const sourceRef = useRef(null);
  const cardRefs = useRef([]);

  useLayoutEffect(() => {
    // Autoplay only when motion is welcome. Under prefers-reduced-motion the
    // matchMedia branch below never runs (nothing would pause the loop), so we
    // simply never start it — reduced-motion users see the static poster frame.
    const allowMotion = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
    if (allowMotion && videoRef.current) videoRef.current.play().catch(() => {});

    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();
      // Only pin + scrub at >=1024px when motion is welcome. Below that (phones AND
      // tablets) fall through to the static CSS layout — six cards need ~900px in
      // one row, so tablets must reflow-wrap, not pin (a pinned h-screen stage
      // would clip the wrapped second row). Breakpoint MUST match the lg: classes.
      mm.add('(min-width: 1024px) and (prefers-reduced-motion: no-preference)', () => {
        const cards = cardRefs.current.filter(Boolean);
        const badges = stageRef.current.querySelectorAll('.showcase-badge');

        // collapsed start: cards tucked below/behind, badges hidden
        gsap.set(cards, { opacity: 0, scale: 0.75, yPercent: 40 });
        gsap.set(badges, { scale: 0, opacity: 0 });

        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: stageRef.current,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 1,
            pin: '.showcase-stage',
            onToggle: (self) => {
              const v = videoRef.current;
              if (!v) return;
              if (self.isActive) v.play().catch(() => {});
              else v.pause();
            },
          },
        });

        // Phase A — source shrinks & rises, making room for the clips.
        tl.to(sourceRef.current, { scale: 0.62, yPercent: -14, ease: 'power2.inOut', duration: 0.35 }, 0);
        // Phase B — clips stream out of the machine.
        tl.to(cards, {
          opacity: 1, scale: 1, yPercent: 0,
          rotate: (i) => (i - 2.5) * 1.6,
          ease: 'power3.out', duration: 0.5,
          stagger: 0.06,
        }, 0.28);
        // Phase C — score badges + platform icons pop in.
        tl.to(badges, {
          scale: 1, opacity: 1, ease: 'back.out(1.7)', duration: 0.3, stagger: 0.03,
        }, 0.7);
        tl.to('.showcase-tagline', { opacity: 1, y: 0, duration: 0.3 }, 0.82);
      });
    }, stageRef);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={stageRef} className="relative motion-safe:lg:h-[300vh]">
      <div className="showcase-stage motion-safe:lg:sticky motion-safe:lg:top-0 motion-safe:lg:h-screen flex flex-col items-center justify-center px-6 py-16 motion-safe:lg:py-8 overflow-hidden">
        {/* dark radial stage glow */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.10),transparent_60%)]" />

        {/* source 16:9 video */}
        {/* aspect-video keeps the 16:9 shape; on the pinned desktop layout the
            source is sized by VIEWPORT HEIGHT (h-auto → h-[38vh] w-auto) so the
            whole composition fits short 1366x768 / 1024x768 screens without the
            h-screen stage clipping the settled cards/tagline. */}
        <div ref={sourceRef} className="showcase-source relative w-full max-w-[680px] aspect-video motion-safe:lg:w-auto motion-safe:lg:max-w-none motion-safe:lg:h-[38vh] motion-safe:lg:max-h-[400px] rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/50">
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
        <button
          onClick={onLaunchApp}
          className="relative z-10 mt-6 flex items-center gap-3 bg-black/60 backdrop-blur border border-white/10 rounded-full pl-4 pr-2 py-2 hover:border-primary/40 transition-colors group"
        >
          <Link2 size={16} className="text-zinc-500" />
          <span className="text-sm text-zinc-400">Drop a long video and…</span>
          <span className="flex items-center gap-1.5 bg-white text-black text-sm font-semibold rounded-full px-4 py-1.5 group-hover:bg-primary group-hover:text-white transition-colors">
            Get clips <ArrowRight size={15} />
          </span>
        </button>

        {/* generated 9:16 clips */}
        <div className="relative z-0 mt-8 flex flex-wrap items-start justify-center gap-3 sm:gap-4 max-w-5xl">
          {PLATFORMS.map((p, i) => (
            <ClipCard
              key={p.label}
              platform={p}
              poster={`/landing/clip-${i + 1}.jpg`}
              cardRef={(el) => (cardRefs.current[i] = el)}
            />
          ))}
        </div>

        <p className="showcase-tagline mt-8 text-center text-zinc-400 motion-safe:lg:opacity-0 motion-safe:lg:translate-y-3">
          One long video. <span className="text-white font-semibold">15 scored, captioned, vertical clips.</span>
        </p>
      </div>
    </section>
  );
}
