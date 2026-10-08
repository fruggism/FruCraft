/*
 * Coordinates typed — or pasted — by a player.
 *
 * Nobody types "812" in one box and "-344" in another: they copy them out of
 * the game. So the X field accepts what the game gives them: a /tp command,
 * the three numbers of F3, or "x, z" from a note. Three numbers are X Y Z,
 * two are X Z; anything else is not coordinates.
 */

const NUMBER = /[-−]?\d+(?:[.,]\d+)?/g;

/** `{ x, z }` from pasted text, or null when it holds neither 2 nor 3 numbers. */
export function parseCoords(text) {
  if (text == null) return null;
  // "~" (relative) and commands like /tp @s are noise around the numbers.
  const raw = String(text).replace(/@\w+/g, ' ').replace(/,\s+/g, ' ');
  const nums = (raw.match(NUMBER) || [])
    .map((n) => Number(n.replace('−', '-').replace(',', '.')))
    .filter(Number.isFinite);
  if (nums.length === 3) return { x: Math.round(nums[0]), y: Math.round(nums[1]), z: Math.round(nums[2]) };
  if (nums.length === 2) return { x: Math.round(nums[0]), z: Math.round(nums[1]) };
  return null;
}
