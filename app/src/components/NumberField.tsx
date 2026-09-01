import { useEffect, useRef, useState } from "react";

/** A numeric input that shows an external (store-driven) value, but doesn't fight the
 * user while they're actively typing — it only re-syncs from `value` while unfocused,
 * and commits on blur/Enter rather than on every keystroke. */
export function NumberField({
  value,
  onCommit,
  step = 1,
  precision = 2,
  className,
  style,
}: {
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  precision?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [text, setText] = useState(() => value.toFixed(precision));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value.toFixed(precision));
  }, [value, precision]);

  function commit() {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setText(value.toFixed(precision));
  }

  return (
    <input
      type="number"
      step={step}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={className}
      style={style}
    />
  );
}
