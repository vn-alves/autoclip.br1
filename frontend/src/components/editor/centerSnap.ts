/** Screen-pixel hysteresis keeps the center magnetic without trapping the drag. */
export function snapToCenter(
  position: number,
  centerPosition: number,
  wasSnapped: boolean,
  screenScale = 1,
): { position: number; snapped: boolean } {
  const threshold = wasSnapped ? 12 : 6
  const snapped = Math.abs(position - centerPosition) * screenScale <= threshold
  return { position: snapped ? centerPosition : position, snapped }
}