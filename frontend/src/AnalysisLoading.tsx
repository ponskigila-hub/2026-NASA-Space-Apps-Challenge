import { useEffect, useState } from 'react';
import { Orbit } from 'lucide-react';

export default function AnalysisLoading({ title, detail, estimate, compact = false }: {
  title: string;
  detail: string;
  estimate?: { seconds: number; label: string };
  compact?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const percent = estimate ? Math.min(95, Math.floor(elapsed / estimate.seconds * 100)) : undefined;
  return (
    <div className={compact ? 'analysis-loading analysis-loading-compact' : 'analysis-section analysis-loading'}>
      <div role="status">
        <strong><Orbit size={compact ? 18 : 25} aria-hidden="true" /> {title}</strong>
        <p>{detail}</p>
      </div>
      <progress max={100} value={percent} aria-label={estimate ? 'Estimated loading progress' : 'Loading progress'} />
      <div className="analysis-loading-time">
        <span>{estimate ? elapsed >= estimate.seconds ? 'Taking longer than estimated. Still working…' : estimate.label : 'Loading saved results…'}</span>
        {estimate && <span>{elapsed}s elapsed</span>}
      </div>
    </div>
  );
}
