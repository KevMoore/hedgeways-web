/**
 * Cute farmer portraits drawn as inline SVG — one per livestock kit. Each
 * farmer has a distinct look (hat, hair, palette) tied to their critter.
 * Returns a self-contained SVG string sized to fit a square container.
 */
type FarmerId = "rosie" | "jack" | "molly" | "billy";

interface FarmerDef {
  bg: string; // disc behind the portrait
  skin: string;
  hair: string;
  hat: string;
  hatBand: string;
  shirt: string;
  /** SVG inserted INSIDE the 64x64 viewBox, on top of skin/face. */
  extras: string;
}

const FARMERS: Record<FarmerId, FarmerDef> = {
  // Rosie — pig farmer: rosy-cheeked, red bandana, pigtails
  rosie: {
    bg: "#fde0dd",
    skin: "#f3c69a",
    hair: "#6e3a1c",
    hat: "#d83a3a",
    hatBand: "#8a1f1f",
    shirt: "#e74c3c",
    extras: `
      <!-- pigtails -->
      <ellipse cx="14" cy="40" rx="5" ry="9" fill="#6e3a1c"/>
      <ellipse cx="50" cy="40" rx="5" ry="9" fill="#6e3a1c"/>
      <!-- bandana (replaces hat brim) -->
      <path d="M14 24 Q32 14 50 24 L50 30 Q32 22 14 30 Z" fill="#d83a3a" stroke="#0c1a12" stroke-width="1.4"/>
      <circle cx="22" cy="26" r="1.4" fill="#fff"/>
      <circle cx="32" cy="22" r="1.4" fill="#fff"/>
      <circle cx="42" cy="26" r="1.4" fill="#fff"/>
      <!-- rosy cheeks -->
      <circle cx="22" cy="38" r="3" fill="#f08aa0" opacity="0.7"/>
      <circle cx="42" cy="38" r="3" fill="#f08aa0" opacity="0.7"/>
    `,
  },
  // Jack — cow farmer: tall straw hat, blue overalls, freckles
  jack: {
    bg: "#dde0ff",
    skin: "#e8b58a",
    hair: "#3a2818",
    hat: "#d9b46a",
    hatBand: "#6b4a26",
    shirt: "#3b5fb8",
    extras: `
      <!-- straw hat -->
      <ellipse cx="32" cy="22" rx="22" ry="4" fill="#d9b46a" stroke="#0c1a12" stroke-width="1.4"/>
      <path d="M22 22 Q32 8 42 22 Z" fill="#d9b46a" stroke="#0c1a12" stroke-width="1.4"/>
      <path d="M22 21 Q32 19 42 21" stroke="#6b4a26" stroke-width="2" fill="none"/>
      <!-- freckles -->
      <circle cx="26" cy="38" r="0.8" fill="#8a5a2a"/>
      <circle cx="29" cy="40" r="0.8" fill="#8a5a2a"/>
      <circle cx="35" cy="40" r="0.8" fill="#8a5a2a"/>
      <circle cx="38" cy="38" r="0.8" fill="#8a5a2a"/>
    `,
  },
  // Molly — sheep farmer: grey-curly hair, green knit beanie
  molly: {
    bg: "#d6f0e6",
    skin: "#e8c5a0",
    hair: "#b5b5b5",
    hat: "#3c9a6a",
    hatBand: "#226b46",
    shirt: "#2c8a64",
    extras: `
      <!-- grey curly bun visible at sides -->
      <circle cx="13" cy="34" r="4" fill="#b5b5b5"/>
      <circle cx="51" cy="34" r="4" fill="#b5b5b5"/>
      <circle cx="11" cy="38" r="3.5" fill="#b5b5b5"/>
      <circle cx="53" cy="38" r="3.5" fill="#b5b5b5"/>
      <!-- green knit beanie -->
      <path d="M16 24 Q32 8 48 24 L48 30 Q32 24 16 30 Z" fill="#3c9a6a" stroke="#0c1a12" stroke-width="1.4"/>
      <path d="M16 28 Q32 26 48 28" stroke="#226b46" stroke-width="1.4" fill="none"/>
      <!-- little pom-pom -->
      <circle cx="32" cy="11" r="3" fill="#e8c5a0" stroke="#0c1a12" stroke-width="1"/>
      <!-- glasses hint -->
      <circle cx="24" cy="40" r="3.5" fill="none" stroke="#0c1a12" stroke-width="1"/>
      <circle cx="40" cy="40" r="3.5" fill="none" stroke="#0c1a12" stroke-width="1"/>
      <line x1="27.5" y1="40" x2="36.5" y2="40" stroke="#0c1a12" stroke-width="1"/>
    `,
  },
  // Billy — chicken farmer: ginger hair, brown felt hat
  billy: {
    bg: "#fde9d2",
    skin: "#f3c69a",
    hair: "#d4742a",
    hat: "#6b3f1d",
    hatBand: "#3a2010",
    shirt: "#e0852b",
    extras: `
      <!-- ginger hair tufts -->
      <path d="M14 28 Q18 18 24 22" stroke="#d4742a" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M50 28 Q46 18 40 22" stroke="#d4742a" stroke-width="3" fill="none" stroke-linecap="round"/>
      <!-- floppy brown hat -->
      <ellipse cx="32" cy="22" rx="20" ry="3.5" fill="#6b3f1d" stroke="#0c1a12" stroke-width="1.4"/>
      <path d="M22 22 Q32 9 42 22 Z" fill="#6b3f1d" stroke="#0c1a12" stroke-width="1.4"/>
      <rect x="22" y="20" width="20" height="2.5" fill="#3a2010"/>
      <!-- single feather tucked in the hatband -->
      <path d="M40 14 Q46 8 50 12 Q44 12 40 18 Z" fill="#fff" stroke="#0c1a12" stroke-width="0.8"/>
      <!-- big grin -->
      <path d="M26 46 Q32 50 38 46" stroke="#0c1a12" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    `,
  },
};

/** Full 64x64 farmer portrait SVG. */
export function farmerSvg(id: string, size = 64): string {
  const f = FARMERS[id as FarmerId];
  if (!f) return "";
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
      <circle cx="32" cy="32" r="30" fill="${f.bg}"/>
      <!-- shirt collar peeking -->
      <path d="M14 54 Q32 48 50 54 L50 64 L14 64 Z" fill="${f.shirt}" stroke="#0c1a12" stroke-width="1.4"/>
      <!-- face -->
      <circle cx="32" cy="38" r="14" fill="${f.skin}" stroke="#0c1a12" stroke-width="1.4"/>
      <!-- eyes -->
      <circle cx="26" cy="38" r="1.6" fill="#0c1a12"/>
      <circle cx="38" cy="38" r="1.6" fill="#0c1a12"/>
      <!-- mouth -->
      <path d="M28 44 Q32 47 36 44" stroke="#0c1a12" stroke-width="1.4" fill="none" stroke-linecap="round"/>
      ${f.extras}
    </svg>`.trim();
}

export const FARMER_IDS: FarmerId[] = ["rosie", "jack", "molly", "billy"];
