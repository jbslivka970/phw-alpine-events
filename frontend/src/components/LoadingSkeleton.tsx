interface LoadingSkeletonProps {
  lines?: number;
  compact?: boolean;
}

function LoadingSkeleton({ lines = 3, compact = false }: LoadingSkeletonProps) {
  const lineCount = Math.max(1, lines);
  const className = compact ? 'phw-skeleton phw-skeleton--compact' : 'phw-skeleton';

  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: lineCount }).map((_, index) => (
        <span
          key={index}
          className={`phw-skeleton__line${index === lineCount - 1 ? ' phw-skeleton__line--short' : ''}`}
        />
      ))}
    </div>
  );
}

export default LoadingSkeleton;
