import { useEffect, useRef, useState } from "react";

// Below this many pixels of pointer movement, a pointerdown is still treated as a
// plain click (focus + type), not a scrub — otherwise every click-to-type would also
// nudge the value by a stray sub-pixel drag.
const SCRUB_THRESHOLD = 3;

/** A numeric input that shows an external (store-driven) value, but doesn't fight the
 * user while they're actively typing — it only re-syncs from `value` while unfocused,
 * and commits on blur/Enter rather than on every keystroke. Also doubles as a
 * click-and-drag "scrub" control (hold the pointer down and move it vertically to
 * ramp the value up/down), the same interaction Blender/Figma-style numeric fields use. */
export function NumberField({
  value,
  onCommit,
  onCommitStart,
  onCommitEnd,
  step = 1,
  precision = 2,
  className,
  style,
  disabled,
}: {
  value: number;
  onCommit: (value: number) => void;
  /** Fires once per edit gesture (typed-and-blurred, or a whole scrub drag), right
   * before the first `onCommit` call — the natural place to push one undo point. */
  onCommitStart?: () => void;
  /** Fires once when the gesture ends (blur, or releasing a scrub drag) — the natural
   * place for a slower, exact final settle after `onCommit`'s fast live preview. */
  onCommitEnd?: () => void;
  step?: number;
  precision?: number;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => value.toFixed(precision));
  const focused = useRef(false);
  const startedGesture = useRef(false);
  const scrub = useRef<{ startY: number; startValue: number; dragging: boolean; pointerId: number } | null>(null);

  useEffect(() => {
    if (!focused.current) setText(value.toFixed(precision));
  }, [value, precision]);

  function commitOnce(next: number) {
    if (!startedGesture.current) {
      startedGesture.current = true;
      onCommitStart?.();
    }
    onCommit(next);
  }

  return (
    <input
      type="number"
      step={step}
      value={text}
      onFocus={() => {
        focused.current = true;
        startedGesture.current = false;
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        const parsed = Number(text);
        if (Number.isFinite(parsed)) {
          commitOnce(parsed);
          onCommitEnd?.();
        } else {
          setText(value.toFixed(precision));
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        startedGesture.current = false;
        scrub.current = { startY: e.clientY, startValue: value, dragging: false, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = scrub.current;
        if (!s || s.pointerId !== e.pointerId) return;
        const dy = s.startY - e.clientY; // up = increase, down = decrease
        if (!s.dragging) {
          if (Math.abs(dy) < SCRUB_THRESHOLD) return;
          s.dragging = true;
          e.currentTarget.blur(); // scrubbing shouldn't also place a text cursor
        }
        const sensitivity = e.shiftKey ? step * 0.02 : step * 0.2; // Shift = fine control
        const next = s.startValue + dy * sensitivity;
        setText(next.toFixed(precision));
        commitOnce(next);
      }}
      onPointerUp={(e) => {
        const s = scrub.current;
        scrub.current = null;
        if (s?.dragging) {
          e.preventDefault(); // swallow the click-to-focus that would otherwise follow
          onCommitEnd?.();
        }
      }}
      disabled={disabled}
      className={className}
      style={{ ...style, cursor: disabled ? "not-allowed" : "ns-resize", opacity: disabled ? 0.5 : 1 }}
    />
  );
}
