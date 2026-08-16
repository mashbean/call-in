export const ANONYMOUS_ANIMALS = [
  "Rainbow Pony",
  "Panda",
  "Otter",
  "Red Fox",
  "Snowy Owl",
  "Dolphin",
  "Hedgehog",
  "Capybara",
  "Penguin",
  "Koala",
  "Alpaca",
  "Narwhal",
  "Raccoon",
  "Beaver",
  "Falcon",
  "Sea Turtle",
  "Rabbit",
  "Reindeer",
  "Blue Whale",
  "Crane",
  "Seal",
  "Moose",
  "Badger",
  "Lemur",
] as const;

/**
 * Deterministic label for the nth anonymous participant of an event.
 * The first cycle walks the animal list in order; later cycles append a
 * cycle number so labels stay unique ("Anonymous Panda 2").
 */
export function anonymousLabelFor(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer");
  const animal = ANONYMOUS_ANIMALS[index % ANONYMOUS_ANIMALS.length];
  const cycle = Math.floor(index / ANONYMOUS_ANIMALS.length);
  return cycle === 0 ? `Anonymous ${animal}` : `Anonymous ${animal} ${cycle + 1}`;
}
