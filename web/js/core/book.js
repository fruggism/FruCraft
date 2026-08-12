/*
 * Export archive documents as Minecraft written books.
 *
 * A written book holds up to 100 pages; each page is a JSON text component
 * stored as a string inside the item's SNBT. Two command flavours are
 * produced because the item format changed in 1.20.5:
 *   - 1.20.5+ : /give @p written_book[written_book_content={...}]
 *   - <=1.20.4: /give @p written_book{title:...,author:...,pages:[...]}
 */

export const MAX_PAGES = 100;
// A book page shows ~14 lines of ~19 characters in the default font. Staying
// near that keeps pages from overflowing their visible area in game.
export const MAX_PAGE_CHARS = 255;

/** Escape a string for use inside an SNBT double-quoted string. */
export function snbtString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escape a JSON payload for use inside an SNBT single-quoted string. */
export function snbtSingleQuoted(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Split plain text into book pages, breaking on whitespace so words stay
 * intact. Blank lines are preserved as paragraph breaks.
 */
export function paginate(text, maxChars = MAX_PAGE_CHARS) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return [''];

  const pages = [];
  let page = '';

  const flush = () => {
    if (page.length) { pages.push(page); page = ''; }
  };

  // Work paragraph by paragraph so explicit line breaks survive.
  const paragraphs = normalized.split(/\n/);
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    const isLast = p === paragraphs.length - 1;

    if (para === '') {
      if (page.length + 1 <= maxChars) page += '\n';
      else { flush(); }
      continue;
    }

    const words = para.split(/\s+/).filter(Boolean);
    for (const word of words) {
      const sep = page.length === 0 || page.endsWith('\n') ? '' : ' ';
      if (page.length + sep.length + word.length <= maxChars) {
        page += sep + word;
        continue;
      }
      flush();
      // A single word longer than a page has to be cut, but that only
      // happens for pathological input.
      if (word.length > maxChars) {
        for (let i = 0; i < word.length; i += maxChars) {
          const piece = word.slice(i, i + maxChars);
          if (piece.length === maxChars) pages.push(piece);
          else page = piece;
        }
      } else {
        page = word;
      }
    }
    if (!isLast) {
      if (page.length + 1 <= maxChars) page += '\n';
      else flush();
    }
  }
  flush();

  const trimmed = pages.map((p) => p.replace(/\n+$/, '')).filter((p, i, arr) => p.length > 0 || arr.length === 1);
  const result = trimmed.length ? trimmed : [''];
  return result.slice(0, MAX_PAGES);
}

/** Build the `pages:[...]` SNBT fragment shared by both command flavours. */
export function pagesFragment(pages) {
  const encoded = (pages.length ? pages : ['']).slice(0, MAX_PAGES).map((p) => {
    const json = JSON.stringify({ text: String(p) });
    return snbtSingleQuoted(json);
  });
  return `[${encoded.join(',')}]`;
}

/** Legacy (<= 1.20.4) give command. */
export function buildGiveCommand({ title, author, pages }) {
  const t = snbtString(title || 'Senza titolo');
  const a = snbtString(author || 'Anonimo');
  return `/give @p written_book{title:${t},author:${a},pages:${pagesFragment(pages || [])}} 1`;
}

/** Modern (1.20.5+) component-based give command. */
export function buildGiveCommandModern({ title, author, pages }) {
  const t = snbtString(title || 'Senza titolo');
  const a = snbtString(author || 'Anonimo');
  return `/give @p written_book[written_book_content={title:${t},author:${a},pages:${pagesFragment(pages || [])}}] 1`;
}

/**
 * Full export for one archive document: paginated text plus both command
 * flavours and a ready-to-drop .mcfunction body (commands there carry no
 * leading slash).
 */
export function exportDocument({ title, author, body, maxChars }) {
  const pages = paginate(body, maxChars || MAX_PAGE_CHARS);
  const command = buildGiveCommand({ title, author, pages });
  const commandModern = buildGiveCommandModern({ title, author, pages });
  return {
    title: title || 'Senza titolo',
    author: author || 'Anonimo',
    pages,
    pageCount: pages.length,
    truncated: paginate(body, maxChars || MAX_PAGE_CHARS).length >= MAX_PAGES,
    command,
    commandModern,
    mcfunction: [
      `# ${title || 'Senza titolo'} — generato da Cube-Atlas`,
      commandModern.replace(/^\//, ''),
    ].join('\n'),
    mcfunctionLegacy: [
      `# ${title || 'Senza titolo'} — generato da Cube-Atlas (<=1.20.4)`,
      command.replace(/^\//, ''),
    ].join('\n'),
  };
}
