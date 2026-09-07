'use client';

import { createElement, useEffect, useRef } from 'react';

/** Copy titan-mascot.js beside this file. No React wrapper is needed for plain HTML. */
export default function Titan({ mood = 'calm', width = 360, paused = false, tracking = true }) {
  const ref = useRef(null);
  useEffect(() => {
    let active = true;
    import('./titan-mascot.js').then(() => {
      if (!active || !ref.current) return;
      ref.current.setMood(mood);
    });
    return () => { active = false; };
  }, [mood]);

  return createElement('titan-mascot', {
    ref,
    mood,
    ...(paused ? { paused: '' } : {}),
    tracking: tracking ? 'on' : 'off',
    style: { width, maxWidth: '100%' }
  });
}
