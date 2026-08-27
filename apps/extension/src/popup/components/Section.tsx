type Props = {
  title: string;
  /** Collapsed by default, for things most captures do not need to touch. */
  collapsible?: boolean;
  summary?: string;
  children: React.ReactNode;
};

const Chevron = () => (
  <svg
    viewBox="0 0 12 12"
    aria-hidden="true"
    className="pc-chevron h-[10px] w-[10px] shrink-0 text-[var(--text-secondary)]"
  >
    <path
      d="M4.5 2.5 8 6l-3.5 3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function Section({ title, collapsible, summary, children }: Props) {
  if (!collapsible) {
    return (
      <section>
        <h2 className="pb-[6px] text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)]">
          {title}
        </h2>
        {children}
      </section>
    );
  }

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-[6px] rounded-[var(--radius-control)] py-[3px] text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
        <Chevron />
        {title}
        {summary ? (
          <span className="ml-auto normal-case tracking-normal text-[var(--text-secondary)]">
            {summary}
          </span>
        ) : null}
      </summary>
      <div className="pc-collapse">
        <div className="pt-[4px]">{children}</div>
      </div>
    </details>
  );
}
