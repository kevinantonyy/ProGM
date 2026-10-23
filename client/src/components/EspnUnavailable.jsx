import { Link } from 'react-router-dom';

/** Shown in place of any ESPN-backed screen or control, so nothing on the page looks usable and then fails. */
export default function EspnUnavailable({ title = 'ESPN', message, compact = false }) {
  return (
    <section className={compact ? 'rounded-lg border border-dark-600 bg-dark-900 p-4' : 'card max-w-2xl'} role="note" data-testid="espn-unavailable">
      <h2 className={compact ? 'font-semibold text-dark-50' : 'text-2xl font-bold'}>{title} is not available</h2>
      <p className={`mt-2 leading-6 text-dark-300 ${compact ? 'text-xs' : 'text-sm'}`}>{message}</p>
      {!compact && <div className="mt-4"><Link to="/basketball" className="btn-primary">Open Fantasy Basketball (Yahoo)</Link></div>}
    </section>
  );
}
