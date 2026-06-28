import React from 'react'
import type { FreshnessScore } from '../types/protocol'

interface Props {
  score: FreshnessScore
  size?: number
}

function Lock({ filled, size = 11 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 14 / 12)} viewBox="0 0 12 14" fill="none">
      <path
        d="M2.5 5.5V4a3.5 3.5 0 017 0v1.5"
        stroke={filled ? '#e3c485' : 'rgba(255,255,255,0.11)'}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <rect
        x="1"
        y="5.5"
        width="10"
        height="7.5"
        rx="1.5"
        fill={filled ? '#d6b06a' : 'none'}
        stroke={filled ? 'none' : 'rgba(255,255,255,0.11)'}
        strokeWidth="1"
      />
      {filled && (
        <circle cx="6" cy="9.25" r="1.4" fill="rgba(0,0,0,0.3)" />
      )}
    </svg>
  )
}

export default React.memo(function FreshnessLock({ score, size }: Props) {
  return (
    <div className="flex items-center gap-0.5" title={`Freshness: ${score}/5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Lock key={i} filled={i < score} size={size} />
      ))}
    </div>
  )
})
