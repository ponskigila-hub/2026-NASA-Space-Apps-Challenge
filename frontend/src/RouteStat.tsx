import { useId, useState, type ReactNode } from 'react';

export default function RouteStat({ label, icon, children, description }: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  description: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  return <div className="route-stat" data-open={open} data-dismissed={dismissed}
    onMouseLeave={() => setDismissed(false)}>
    <button type="button" aria-describedby={id} aria-expanded={open}
      onClick={() => { setDismissed(open); setOpen(!open); }}
      onBlur={() => { setOpen(false); setDismissed(false); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); setDismissed(true); }
      }}>
      <span>{icon} {label}</span>
      <strong>{children}</strong>
    </button>
    <p id={id} className="route-stat-tooltip" role="tooltip">{description}</p>
  </div>;
}
