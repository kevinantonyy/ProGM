export default function LoadingState({ label = 'Loading your league…' }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="loading-mark" aria-hidden="true" />
        <span className="text-sm font-semibold text-dark-300">{label}</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => <span key={item} className="skeleton-block h-16" />)}
      </div>
    </div>
  );
}
