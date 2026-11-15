import { useEffect, useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowDownRight, Crosshair } from 'lucide-react';
import { presets, type Analysis } from './analysisApi';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function Takeaway({ children }: { children: React.ReactNode }) {
  return <div className="mission-takeaway"><strong>Mission takeaway</strong><p>{children}</p></div>;
}

export function NumberMeaning({ children }: { children: React.ReactNode }) {
  return <small className="number-meaning">{children}</small>;
}

export function gradeMeaning(degrees: number) {
  return `At that angle, elevation changes about ${Math.round(Math.tan(degrees * Math.PI / 180) * 100)} m per 100 m of horizontal travel.`;
}

const sections = [
  ['analysis-title', 'Terrain'],
  ['earth-title', 'Earth matches'],
  ['analogy-title', 'Field testing'],
  ['evidence-quality-title', 'Evidence'],
  ['lighting-title', 'Lighting'],
  ['minerals-title', 'Minerals'],
] as const;

export function MissionHeader({ result, ranking }: {
  result: Analysis; ranking: boolean;
}) {
  const hero = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const [currentSection, setCurrentSection] = useState<string>();
  const best = ranking ? undefined : result.candidates.find(site => site.rank === 1);

  useEffect(() => {
    const bar = nav.current;
    if (!bar) return;
    let frame = 0;
    const update = () => {
      const boundary = bar.getBoundingClientRect().bottom + 48;
      const current = sections.filter(([id]) => {
        const heading = document.getElementById(id);
        return heading && heading.getBoundingClientRect().top <= boundary;
      }).at(-1);
      setCurrentSection(current?.[0]);
    };
    function scheduleUpdate() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    }
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(bar);
    if (bar.parentElement) observer.observe(bar.parentElement);
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', scheduleUpdate);
    };
  }, [result.id, ranking]);

  useEffect(() => {
    const bar = nav.current;
    const link = bar?.querySelector('[aria-current="location"]');
    if (!bar || !link) return;
    const bounds = bar.getBoundingClientRect();
    const active = link.getBoundingClientRect();
    if (active.left < bounds.left) bar.scrollLeft += active.left - bounds.left - 8;
    else if (active.right > bounds.right) bar.scrollLeft += active.right - bounds.right + 8;
  }, [currentSection]);

  useGSAP(() => {
    const motion = gsap.matchMedia();
    motion.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.mission-hero-image', { scale: .96, opacity: .55 }, {
        scale: 1, opacity: 1, duration: .6, ease: 'power2.out',
        scrollTrigger: { trigger: hero.current, start: 'top 92%', once: true },
      });
    });
    return () => motion.revert();
  }, { scope: hero });
  return <>
    <nav ref={nav} className="mission-nav" aria-label="Analysis sections">
      <div className="mission-jumps">
        {(ranking ? sections.slice(0, 2) : sections).map(([id, label]) =>
          <a key={id} href={`#${id}`} aria-current={currentSection === id ? 'location' : undefined}>{label}</a>)}
      </div>
    </nav>
    <section ref={hero} className="mission-hero" aria-labelledby="mission-heading">
      <div className="mission-result" aria-live="polite">
        <p className="mission-result-label">Top Earth match</p>
        <h2 id="mission-heading">{ranking ? 'Ranking Earth sites…' : best?.name ?? 'No ranked Earth site yet'}</h2>
        {best && <p className="mission-result-location">{best.location}</p>}
        <dl className="mission-objective">
          <Crosshair size={22} aria-hidden="true" />
          <div><dt>Mission objective</dt><dd>{presets[result.preset]}</dd></div>
        </dl>
        <p className="mission-reading-guide">Start with the lunar route, pick an Earth match, then check when to test cameras and whether rock measurements are available.</p>
        <a href="#earth-title" className="primary-button">Explore Earth matches <ArrowDownRight size={18} /></a>
      </div>
      <div className="mission-hero-media"><img className="mission-hero-image"
        src={import.meta.env.BASE_URL + (result.lunarRegion?.relief ?? 'terrain/hadley-wac.webp')}
        alt={`Map of ${result.lunarRegion?.name ?? 'Hadley–Apennine'}`} />
        <span>{result.lunarRegion?.name ?? 'Hadley–Apennine'} · {result.lunarRegion?.relief ? 'NASA SLDEM2015' : 'NASA LROC'}</span>
      </div>
    </section>
  </>;
}
