import React from 'react';
import { capacityColors } from '../styles/theme';

interface CapacityBadgeProps {
  totalSlots: number;
  filledSlots: number;
}

function CapacityBadge({ totalSlots, filledSlots }: CapacityBadgeProps) {
  const remaining = Math.max(0, totalSlots - filledSlots);
  const pct = totalSlots > 0 ? remaining / totalSlots : 1;

  let color: string;
  let bg: string;
  let label: string;

  if (remaining === 0) {
    color = capacityColors.full;
    bg = `${capacityColors.full}18`;
    label = 'Full';
  } else if (pct <= 0.25) {
    color = capacityColors.limited;
    bg = `${capacityColors.limited}18`;
    label = `${remaining} spot${remaining === 1 ? '' : 's'}`;
  } else {
    color = capacityColors.available;
    bg = `${capacityColors.available}18`;
    label = `${remaining} spot${remaining === 1 ? '' : 's'}`;
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: '0.6875rem',
        fontWeight: 500,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        background: bg,
        color,
      }}
    >
      {label}
    </span>
  );
}

export default CapacityBadge;
