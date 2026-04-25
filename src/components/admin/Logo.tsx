// This file is referenced by admin.components.graphics.Logo
// Use your brand logo here — it appears in the Payload nav sidebar

export function Logo() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '0 4px',
    }}>
      <svg width="28" height="28" viewBox="0 0 28 28">
        {/* Replace with your SVG logo mark */}
        <rect width="28" height="28" rx="6" fill="#6366F1" />
        <text x="14" y="20" textAnchor="middle"
          fill="white" fontSize="14" fontWeight="bold">M</text>
      </svg>
      <span style={{
        fontFamily: 'var(--font-body)',
        fontWeight: 700, fontSize: 16,
        color: '#E2E8F0',
        letterSpacing: '-0.01em',
      }}>
        MyStore
      </span>
    </div>
  )
}

// Small icon version (shown in collapsed nav)
export function Icon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#6366F1" />
      <text x="14" y="20" textAnchor="middle"
        fill="white" fontSize="14" fontWeight="bold">M</text>
    </svg>
  )
}