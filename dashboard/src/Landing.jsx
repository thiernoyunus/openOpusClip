import React, { useLayoutEffect, useRef } from 'react';
import { Github, ArrowRight, ChevronDown, Upload, Sparkles, Send, Captions, Clapperboard, Languages, CalendarDays } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import ClipShowcase from './components/landing/ClipShowcase';

gsap.registerPlugin(ScrollTrigger);

const FAQItem = ({ question, answer, isOpen, onClick }) => (
  <div className="border border-white/10 rounded-xl overflow-hidden">
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-white/5 transition-colors"
    >
      <span className="text-white font-medium pr-4">{question}</span>
      <ChevronDown size={18} className={`text-zinc-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
    </button>
    {isOpen && (
      <div className="px-6 pb-5">
        <p className="faq-answer text-zinc-400 text-sm leading-relaxed">{answer}</p>
      </div>
    )}
  </div>
);

// ── Feature-rail panel visuals ────────────────────────────────────────────────

const ScoreboardVisual = () => (
  <div className="w-full max-w-sm bg-black/40 rounded-2xl ring-1 ring-white/10 p-5 space-y-3">
    {[
      ['The Quran: Your Most Powerful Weapon', 95],
      ['Modern Muslims: Entitled or Hardworking?', 90],
      ['Wives: Ice Cream or Righteous Children?', 88],
      ['Social Media & The Fitna of Women', 85],
    ].map(([title, score]) => (
      <div key={title} className="flex items-center justify-between gap-3">
        <span className="text-sm text-zinc-300 truncate">{title}</span>
        <span className="shrink-0 text-sm font-extrabold text-[#3DD68C] bg-[#3DD68C]/10 rounded-full px-2.5 py-0.5">{score}</span>
      </div>
    ))}
  </div>
);

const CaptionVisual = () => (
  <div className="relative w-[200px] rounded-[2rem] ring-4 ring-white/10 overflow-hidden shadow-2xl shadow-black/50" style={{ aspectRatio: '9 / 16' }}>
    <img src="/landing/clip-1.jpg" alt="Clip with word-level captions" loading="lazy" className="w-full h-full object-cover" />
  </div>
);

const DeckVisual = () => (
  <div className="relative w-[180px] h-[300px]">
    {['/landing/clip-2.jpg', '/landing/clip-3.jpg', '/landing/clip-4.jpg'].map((src, i) => (
      <img
        key={src}
        src={src}
        alt="Trailer clip"
        loading="lazy"
        className="absolute top-0 left-1/2 w-[150px] rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 object-cover"
        style={{
          aspectRatio: '9 / 16',
          transform: `translateX(-50%) translateX(${(i - 1) * 34}px) translateY(${i * 14}px) rotate(${(i - 1) * 5}deg)`,
          zIndex: 3 - i,
        }}
      />
    ))}
  </div>
);

const LangVisual = () => (
  <div className="flex flex-wrap gap-2.5 max-w-sm justify-center">
    {['العربية', 'Español', 'Français', '中文', 'Deutsch', 'हिन्दी', 'Português', '日本語', '+30 more'].map((l) => (
      <span key={l} className="text-sm text-zinc-200 bg-white/5 ring-1 ring-white/10 rounded-full px-3.5 py-1.5">{l}</span>
    ))}
  </div>
);

const CalendarVisual = () => {
  const events = { 1: ['#FF0000'], 3: ['#E1306C'], 5: ['#111111'] };
  return (
    <div className="w-full max-w-sm bg-black/40 rounded-2xl ring-1 ring-white/10 p-4">
      <div className="grid grid-cols-7 gap-1.5">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={i} className="text-center text-[10px] font-semibold text-zinc-500 pb-1">{d}</div>
        ))}
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="aspect-square rounded-lg bg-white/[0.03] ring-1 ring-white/5 p-1 flex flex-col gap-1">
            {(events[i] || []).map((c, j) => (
              <span key={j} className="h-1.5 rounded-full w-full" style={{ backgroundColor: c }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

const PANELS = [
  {
    icon: Sparkles,
    eyebrow: 'Scored, not guessed',
    title: 'AI clipping & virality scores',
    body: 'Gemini reads the full transcript and finds the moments worth posting. Every clip gets a 0–100 score so you post the winners first.',
    Visual: ScoreboardVisual,
  },
  {
    icon: Captions,
    eyebrow: 'Word-level timing',
    title: 'Animated captions',
    body: 'Auto-transcribed captions burned in with a per-word highlight. Pick a template and an accent color — the words land on the beat.',
    Visual: CaptionVisual,
  },
  {
    icon: Clapperboard,
    eyebrow: 'One episode, one hook',
    title: 'Podcast Trailer mode',
    body: 'Turn a full episode into a Diary-of-a-CEO-style cold open — hook, story, cliffhanger, stitched into one vertical trailer.',
    Visual: DeckVisual,
  },
  {
    icon: Languages,
    eyebrow: '30+ languages',
    title: 'Translate & dub',
    body: 'ElevenLabs dubbing keeps the original voice while switching the language, then re-captions in the target tongue.',
    Visual: LangVisual,
  },
  {
    icon: CalendarDays,
    eyebrow: 'Post without leaving',
    title: 'Schedule & publish',
    body: 'A built-in calendar and scheduler post straight to TikTok, Reels, and Shorts. Queue a week in one sitting.',
    Visual: CalendarVisual,
  },
];

function FeatureRail() {
  const rootRef = useRef(null);
  const trackRef = useRef(null);

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      // Horizontal scroll only at >=1024px with motion welcome. Otherwise the
      // panels stack vertically (base flex-col) — no pin, cheap on mobile.
      const mm = gsap.matchMedia();
      mm.add('(min-width: 1024px) and (prefers-reduced-motion: no-preference)', () => {
        const track = trackRef.current;
        const amount = track.scrollWidth - window.innerWidth;
        gsap.to(track, {
          x: -amount,
          ease: 'none',
          scrollTrigger: {
            trigger: rootRef.current,
            start: 'top top',
            end: () => '+=' + track.scrollWidth,
            scrub: 1,
            pin: true,
            invalidateOnRefresh: true,
          },
        });
      });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <section id="features" ref={rootRef} className="relative lg:h-screen lg:overflow-hidden">
      <div
        ref={trackRef}
        className="flex flex-col lg:flex-row lg:h-screen lg:flex-nowrap"
      >
        {PANELS.map(({ icon: Icon, eyebrow, title, body, Visual }) => (
          <div
            key={title}
            className="flex-shrink-0 w-full lg:w-screen lg:h-screen flex items-center justify-center px-6 py-16 lg:py-0"
          >
            <div className="max-w-6xl w-full grid lg:grid-cols-2 gap-12 items-center">
              <div className="flex justify-center order-first lg:order-none">
                <Visual />
              </div>
              <div className="max-w-md">
                <div className="inline-flex items-center gap-2 text-primary text-xs font-semibold uppercase tracking-widest mb-4">
                  <Icon size={16} />
                  {eyebrow}
                </div>
                <h3 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">{title}</h3>
                <p className="text-zinc-400 leading-relaxed">{body}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Landing({ onLaunchApp }) {
  const [openFaq, setOpenFaq] = React.useState(null);

  const steps = [
    { icon: Upload, title: 'Upload', description: 'Drop a long video — a podcast, webinar, or livestream you own.' },
    { icon: Sparkles, title: 'AI does the work', description: 'It finds the best moments, reframes them to 9:16, and burns in captions.' },
    { icon: Send, title: 'Export or schedule', description: 'Download your clips or post them straight to TikTok, Reels, and Shorts.' },
  ];

  const faqs = [
    {
      question: 'What is OpenShorts?',
      answer: 'A free, open-source AI clip generator. It turns long videos — podcasts, webinars, livestreams — into scored, captioned vertical clips ready for TikTok, Reels, and Shorts.',
    },
    {
      question: 'Is it really free?',
      answer: 'Yes. OpenShorts is 100% free and open source with no watermarks or limits. You bring your own API keys, which have generous free tiers.',
    },
    {
      question: 'How does it compare to Opus Clip?',
      answer: 'Same core idea — AI moment detection and vertical reframing — but self-hosted and free instead of $15–228/month. Your videos stay on your machine, and you also get dubbing, trailer mode, and a built-in scheduler.',
    },
    {
      question: 'What do I need to run it?',
      answer: 'Docker on any Mac, Linux, or Windows machine, plus a free Google Gemini API key. ElevenLabs and a social key are optional add-ons.',
    },
  ];

  return (
    <div className="min-h-screen bg-background text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo-openshorts.png" alt="OpenShorts logo" className="w-8 h-8" />
            <span className="text-lg font-bold">OpenShorts</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a>
            <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/mutonby/openshorts"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              <Github size={18} />
              <span>GitHub</span>
            </a>
            <button
              onClick={onLaunchApp}
              className="bg-primary hover:bg-blue-600 text-white px-5 py-2 rounded-xl text-sm font-medium transition-all active:scale-[0.98] shadow-lg shadow-primary/20"
            >
              Launch App
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-36 pb-8 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary mb-6">
            Free &amp; Open-Source AI Clip Generator
          </p>
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05] mb-6">
            One long video.
            <br />
            A week of viral clips.
          </h1>
          <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto leading-relaxed">
            OpenShorts turns long videos into scored, captioned vertical clips — free, on your own machine.
          </p>
        </div>
      </section>

      {/* Autoplay showcase */}
      <ClipShowcase onLaunchApp={onLaunchApp} />

      {/* A. Feature rail — horizontal scroll on desktop */}
      <FeatureRail />

      {/* B. How it works */}
      <section id="how-it-works" className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-center mb-14">How it works</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {steps.map(({ icon: Icon, title, description }, i) => (
              <div key={title} className="bg-surface/50 ring-1 ring-white/10 rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center text-primary">
                    <Icon size={18} />
                  </div>
                  <span className="text-xs font-semibold text-zinc-500">STEP {i + 1}</span>
                </div>
                <h3 className="text-lg font-semibold text-white mb-1">{title}</h3>
                <p className="text-zinc-400 text-sm leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* C. Open source strip */}
      <section className="py-12 px-6">
        <div className="max-w-5xl mx-auto bg-surface/60 ring-1 ring-white/10 rounded-2xl px-8 py-12 text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-3">Self-hosted. Private. $0.</h2>
          <p className="text-zinc-400 max-w-xl mx-auto mb-8">
            Your videos never leave your machine — bring your own free API keys and run the whole stack yourself.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onLaunchApp}
              className="flex items-center gap-2 bg-primary hover:bg-blue-600 text-white px-7 py-3 rounded-xl font-medium transition-all active:scale-[0.98] shadow-lg shadow-primary/20"
            >
              Launch App <ArrowRight size={18} />
            </button>
            <a
              href="https://github.com/mutonby/openshorts"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-white/5 ring-1 ring-white/10 text-white px-7 py-3 rounded-xl font-medium transition-all hover:bg-white/10"
            >
              <Github size={18} /> Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* D. FAQ */}
      <section id="faq" className="py-24 px-6">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-center mb-14">Frequently asked questions</h2>
          <div className="space-y-3">
            {faqs.map((faq, i) => (
              <FAQItem
                key={i}
                question={faq.question}
                answer={faq.answer}
                isOpen={openFaq === i}
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
              />
            ))}
          </div>
        </div>
      </section>

      {/* E. Final CTA */}
      <section className="py-20 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">Turn your next long video into clips</h2>
          <p className="text-zinc-400 mb-8 max-w-xl mx-auto">No sign-up, no credit card, no watermarks.</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onLaunchApp}
              className="flex items-center gap-2 bg-primary hover:bg-blue-600 text-white px-8 py-3.5 rounded-xl font-medium transition-all active:scale-[0.98] shadow-lg shadow-primary/20 text-lg"
            >
              Launch OpenShorts <ArrowRight size={20} />
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src="/logo-openshorts.png" alt="OpenShorts" className="w-6 h-6" />
            <span className="text-sm text-zinc-400">OpenShorts — Free Open Source Clip Generator</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <a href="https://github.com/mutonby/openshorts" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
            <a href="#legal" className="hover:text-white transition-colors">Terms &amp; Privacy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
