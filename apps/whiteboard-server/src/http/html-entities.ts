// Minimal HTML entity decoder for unfurled page metadata. Decoding happens in
// a single pass so an escaped entity is never double-decoded: in "&amp;lt;" the
// regex consumes "&amp;" and emits "&", and the remaining "lt;" is plain text —
// the correct result is the literal "&lt;", never "<". (A chained per-entity
// replace() that handles &amp; first gets this wrong.)

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  deg: "°",
  plusmn: "±",
  para: "¶",
  sect: "§",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  divide: "÷",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  agrave: "à",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  Uuml: "Ü",
  Ouml: "Ö",
  Auml: "Ä",
  szlig: "ß",
  ccedil: "ç",
  ntilde: "ñ",
  atilde: "ã",
  otilde: "õ",
};

const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g;

function safeFromCodePoint(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return "";
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return "";
  if (cp >= 0xd800 && cp <= 0xdfff) return "";
  return String.fromCodePoint(cp);
}

export function decodeHtmlEntities(str: string): string {
  return str.replace(ENTITY_RE, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return safeFromCodePoint(parseInt(dec, 10));
    if (hex !== undefined) return safeFromCodePoint(parseInt(hex, 16));
    return (name !== undefined ? NAMED_ENTITIES[name] : undefined) ?? match;
  });
}
