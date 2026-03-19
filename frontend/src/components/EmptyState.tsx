import React from 'react';
import { colors } from '../styles/theme';

interface EmptyStateProps {
  variant?: 'river' | 'calendar' | 'fishing' | 'general';
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

const illustrations: Record<string, React.FC> = {
  river: () => (
    <svg width="64" height="48" viewBox="0 0 64 48" fill="none" style={{ opacity: 0.3 }}>
      <path d="M4 32 Q16 20 32 26 Q48 32 60 22" stroke={colors.slate[400]} strokeWidth="2" strokeLinecap="round" />
      <path d="M4 38 Q16 28 32 32 Q48 36 60 28" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      <path d="M8 20 L18 6 L28 20" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M24 20 L38 4 L52 20" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="52" cy="10" r="5" stroke={colors.slate[400]} strokeWidth="1.5" />
    </svg>
  ),
  calendar: () => (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ opacity: 0.3 }}>
      <rect x="6" y="10" width="36" height="32" rx="4" stroke={colors.slate[400]} strokeWidth="1.5" />
      <path d="M6 20 H42" stroke={colors.slate[400]} strokeWidth="1.5" />
      <path d="M16 6 V14" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M32 6 V14" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="24" cy="30" r="3" stroke={colors.slate[400]} strokeWidth="1.5" />
    </svg>
  ),
  fishing: () => (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ opacity: 0.3 }}>
      <path d="M8 40 L40 8" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M40 8 Q42 16 36 24 Q30 32 32 38" stroke={colors.slate[400]} strokeWidth="1" strokeLinecap="round" strokeDasharray="3 3" />
      <path d="M32 38 Q34 42 30 44 Q26 42 28 38" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="14" cy="34" r="4" stroke={colors.slate[400]} strokeWidth="1.5" />
    </svg>
  ),
  general: () => (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ opacity: 0.3 }}>
      <circle cx="24" cy="24" r="16" stroke={colors.slate[400]} strokeWidth="1.5" />
      <path d="M24 16 V24 L30 28" stroke={colors.slate[400]} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

function EmptyState({
  variant = 'general',
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  const Illustration = illustrations[variant] || illustrations.general;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2.25rem 1.25rem',
        textAlign: 'center',
      }}
    >
      <Illustration />
      <p style={{ margin: '1rem 0 0', fontSize: 15, fontWeight: 500, color: colors.slate[600] }}>{title}</p>
      {description && (
        <p
          style={{
            margin: '0.3rem 0 0',
            maxWidth: 320,
            fontSize: 13,
            color: colors.slate[400],
            fontFamily: '"Libre Baskerville", Georgia, serif',
            fontStyle: 'italic',
          }}
        >
          {description}
        </p>
      )}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          style={{
            marginTop: '1rem',
            background: colors.forest[600],
            color: 'white',
            border: 'none',
            padding: '8px 20px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export default EmptyState;
