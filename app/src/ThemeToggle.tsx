/**
 * Sun in cream, moon in dark. Switching rotates the rays away while a shadow
 * slides across the disc to leave a crescent. Stroke only, like the other icons.
 */
export function ThemeToggle(props: { theme: "cream" | "dark"; onToggle: () => void }) {
  const dark = props.theme === "dark";
  return (
    <button
      type="button"
      className="icon-btn ghost theme-toggle"
      data-dark={dark}
      aria-label={dark ? "Switch to the cream theme" : "Switch to the dark theme"}
      title={dark ? "Switch to cream" : "Switch to dark"}
      onClick={props.onToggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <mask id="theme-moon-mask">
          <rect x="0" y="0" width="24" height="24" fill="white" />
          <circle className="theme-shadow" cx="24" cy="4" r="7" fill="black" />
        </mask>
        <circle className="theme-disc" cx="12" cy="12" r="5" mask="url(#theme-moon-mask)" />
        <g className="theme-rays">
          {Array.from({ length: 8 }, (_, index) => {
            const angle = (index * Math.PI) / 4;
            const [x1, y1, x2, y2] = [8.5, 10.5].flatMap((radius) => [12 + Math.cos(angle) * radius, 12 + Math.sin(angle) * radius]);
            return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>
      </svg>
    </button>
  );
}
