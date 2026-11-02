export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress-track w-full">
      <div className="progress-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  )
}
