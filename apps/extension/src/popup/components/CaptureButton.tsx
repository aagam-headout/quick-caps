const Spinner = () => (
  <svg
    viewBox="0 0 16 16"
    aria-hidden="true"
    className="pc-spin h-[13px] w-[13px]"
  >
    <circle
      cx="8"
      cy="8"
      r="6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray="30 12"
      opacity="0.9"
    />
  </svg>
);

const Download = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[13px] w-[13px]">
    <path
      d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3 12.5h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function CaptureButton({
  running,
  onClick,
}: {
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      className="flex w-full items-center justify-center gap-[7px] rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-[9px] text-[13px] font-medium text-white transition-all duration-[var(--duration-fast)] hover:bg-[var(--accent-hover)] active:scale-[0.985] disabled:cursor-default disabled:opacity-70 disabled:active:scale-100"
    >
      {running ? <Spinner /> : <Download />}
      {running ? 'Capturing…' : 'Capture page'}
    </button>
  );
}
