import styles from "./liquid-background.module.css";

/**
 * Abstract liquid-flow color animation.
 *
 * Decorative-only background of slowly drifting, blurred color fields. Pure CSS
 * (no client JS, animates transform/opacity only) so it composites on the GPU
 * and adds no hydration cost. Render it as the first child of a
 * `position: relative; overflow: hidden` container and keep foreground content
 * at a higher stacking context.
 */
export function LiquidBackground() {
  return (
    <div className={styles.root} aria-hidden="true">
      <div className={`${styles.blob} ${styles.coral}`} />
      <div className={`${styles.blob} ${styles.amber}`} />
      <div className={`${styles.blob} ${styles.azure}`} />
      <div className={`${styles.blob} ${styles.violet}`} />
      <div className={styles.grain} />
    </div>
  );
}
