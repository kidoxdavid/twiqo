const P: Record<string, string> = {
  chev: 'M9 5l7 7-7 7', help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 114 2c-.8.6-1.5 1-1.5 2M12 17h.01', home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', bag: 'M5 8h14l-1 12H6L5 8zM9 8a3 3 0 016 0', plus: 'M12 5v14M5 12h14',
  truck: 'M2 6h12v10H2zM14 9h4l3 3v4h-7M7 17.5h.01M17 17.5h.01', user: 'M12 4a4 4 0 100 8 4 4 0 000-8zM4 21c0-4 4-6 8-6s8 2 8 6',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4', bell: 'M6 17V11a6 6 0 0112 0v6l2 2H4l2-2zM10 21h4', chat: 'M4 5h16v11H9l-5 4V5z',
  heart: 'M12 20s-8-5-8-11a4.5 4.5 0 018-2.5A4.5 4.5 0 0120 9c0 6-8 11-8 11z', share: 'M21 3L10 14M21 3l-7 18-4-7-7-4 18-7z', save: 'M6 3h12v18l-6-4-6 4V3z',
  more: 'M5 12h.01M12 12h.01M19 12h.01', pin: 'M12 21s7-6 7-11a7 7 0 00-14 0c0 5 7 11 7 11zM12 8a2 2 0 100 4 2 2 0 000-4z',
  img: 'M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zM9 8a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM4 18l5-5 4 4 3-3 4 4', film: 'M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zM10 9l5 3-5 3V9z',
  users: 'M9 5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM2 20c0-3.500 3-5.500 7-5.500s7 2 7 5.500M16 5a3.500 3.500 0 010 7M18 14.500c2.500.6 4 2.200 4 5', cal: 'M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM3 10h18M8 3v4M16 3v4',
  box: 'M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10', route: 'M6 15.5a2.500 2.500 0 100 5 2.500 2.500 0 000-5zM18 3.500a2.500 2.500 0 100 5 2.500 2.500 0 000-5zM8.500 18H15a3 3 0 000-6H9a3 3 0 010-6h6.500', back: 'M15 5l-7 7 7 7',
  filter: 'M4 6h16M7 12h10M10 18h4', flag: 'M5 21V4h12l-2 4 2 4H5', shield: 'M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6l8-3zM8.500 12l2.500 2.500 4.500-5', camera: 'M4 8h3l2-3h6l2 3h3v12H4V8zM12 10a3.500 3.500 0 100 7 3.500 3.500 0 000-7z',
  x: 'M6 6l12 12M18 6L6 18', check: 'M5 12.500l4.500 4.500L19 7', gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2', clip: 'M20 12l-8 8a5 5 0 01-7-7l9-9a3.500 3.500 0 015 5l-9 9a2 2 0 01-3-3l8-8',
};
export function Icon({ name, className = '', fill = false }: { name: string; className?: string; fill?: boolean }) {
  return <svg className={`i ${fill ? 'fill' : ''} ${className}`} viewBox="0 0 24 24" aria-hidden="true"><path d={P[name] ?? ''} /></svg>;
}

export function Ticks({ w = 38, white = false, className = '' }: { w?: number; white?: boolean; className?: string }) {
  return (
    <svg width={w} height={w * 0.714} viewBox="0 0 70 50" className={className} aria-hidden="true" fill="none" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 25L17 37L39 9" stroke={white ? 'rgba(255,255,255,.6)' : '#246BFD'} /><path d="M23 27L35 39L61 9" stroke={white ? '#fff' : '#13B9B0'} />
    </svg>
  );
}
