// Shared pieces for the Sonder redesign boards: tokens, icons and the row, group and shell builders.
// Every builder returns literal, inline-styled markup, so each written .dc.html stays a plain hand-editable file.

export const c = {
  ground: '#101510', surface: '#182117', raised: '#26331f', line: '#3c4934',
  text: '#e6eadf', muted: '#a9b59d', danger: '#f2a79a', ok: '#a9d6a0',
};
export const acc = '{{accent}}';
export const sans = "'DM Sans', sans-serif";
const fBody = "'DM Sans', system-ui, sans-serif";
const fHead = "'Manrope', sans-serif";

export const st = {
  title: `margin: 0; font-family: ${fHead}; font-weight: 700; font-size: 28px; line-height: 34px`,
  heading: `margin: 0; font-family: ${fHead}; font-weight: 700; font-size: 20px; line-height: 26px`,
  body: 'font-size: 16px; line-height: 22px',
  label: 'font-size: 14px; line-height: 20px; font-weight: 500',
  sub: `font-size: 14px; line-height: 20px; color: ${c.muted}`,
  note: `margin: 0; font-size: 12px; line-height: 16px; color: ${c.muted}`,
  caption: `margin: 0; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: ${c.muted}`,
  clip: 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis',
};

export const I = {
  back: '<path d="M15 6l-6 6 6 6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  audio: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h3v6H6a2 2 0 0 1-2-2zM20 14h-3v6h1a2 2 0 0 0 2-2z"/>',
  ebook: '<path d="M12 6v14M12 6C10 4.500 7 4 4 4v14c3 0 6 .5 8 2M12 6c2-1.500 5-2 8-2v14c-3 0-6 .5-8 2"/>',
  sync: '<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1"/><path d="M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"/>',
  device: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.500h2"/>',
  library: '<path d="M5 4v16M10 4v16M15 6l4 14"/>',
  discover: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  settings: '<path d="M4 7h9M19 7h1M4 17h3M13 17h7"/><circle cx="16" cy="7" r="2.5"/><circle cx="10" cy="17" r="2.5"/>',
  heart: '<path d="M12 20s-7-4.400-7-10a4 4 0 0 1 7-2.600A4 4 0 0 1 19 10c0 5.600-7 10-7 10z"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  bookmark: '<path d="M7 4h10v16l-5-4-5 4z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  moon: '<path d="M20 14.500A8 8 0 1 1 9.500 4a6.500 6.500 0 0 0 10.500 10.500z"/>',
  target: '<circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
};

/** An inline icon. `label` makes it meaningful (role="img"); without it the icon is decoration. */
export function svg(inner, size = 20, o = {}) {
  const a11y = o.label ? `role="img" aria-label="${o.label}"` : 'aria-hidden="true"';
  const paint = o.fill
    ? `fill="${o.fill}"`
    : `fill="none" stroke="${o.stroke ?? 'currentColor'}" stroke-width="${o.sw ?? 2}" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg ${a11y} width="${size}" height="${size}" viewBox="0 0 24 24" ${paint}>${inner}</svg>`;
}

export const books = {
  anti: { t: 'There Is No Antimemetics Division', ct: 'There Is No Anti&shy;memetics Division', a: 'qntm', col: '#3f5a4a' },
  snow: { t: 'Snow Crash', a: 'Neal Stephenson', col: '#2f4858' },
  matter: { t: 'Matter', a: 'Iain M. Banks', col: '#6b4a3a' },
  dorian: { t: 'The Picture of Dorian Gray', a: 'Oscar Wilde', col: '#5a4b6b' },
  feral: { t: 'Feral Gods', a: '[AUTHOR]', col: '#5f5230' },
  frank: { t: 'Frankenstein', a: 'Mary Shelley', col: '#4a3f3a' },
};

/** A cover block; `fs` (font size) adds the title as its label, 0 leaves it plain. */
export function cover(b, size, fs = 0) {
  const text = fs
    ? `; padding: ${size >= 96 ? 12 : 8}px; box-sizing: border-box; font-family: ${fHead}; font-weight: 700; font-size: ${fs}px; line-height: ${fs + 3}px`
    : '';
  return `<span style="width: ${size}px; height: ${size}px; flex: none; border-radius: 8px; background: ${b.col}${text}; display: block">${fs ? b.ct ?? b.t : ''}</span>`;
}

export const bar = (pct) =>
  `<span aria-hidden="true" style="display: block; height: 4px; border-radius: 999px; background: ${c.line}"><span style="display: block; width: ${pct}%; height: 4px; border-radius: 999px; background: ${acc}"></span></span>`;

export const dot = (label) =>
  `<span role="img" aria-label="${label}" style="width: 8px; height: 8px; flex: none; border-radius: 999px; background: ${acc}; display: block"></span>`;

export function toggle(on, label) {
  return on
    ? `<button type="button" aria-pressed="true" aria-label="${label}" style="width: 52px; height: 32px; flex: none; border: 0; border-radius: 999px; background: ${acc}; padding: 4px; display: flex; justify-content: flex-end"><span style="width: 24px; height: 24px; border-radius: 999px; background: ${c.ground}"></span></button>`
    : `<button type="button" aria-pressed="false" aria-label="${label}" style="width: 52px; height: 32px; flex: none; border: 0; border-radius: 999px; background: ${c.line}; padding: 4px; display: flex; justify-content: flex-start"><span style="width: 24px; height: 24px; border-radius: 999px; background: ${c.text}"></span></button>`;
}

/** A 44-high button. kind: primary | secondary | quiet. With `href` it is a link drawn as the button. */
export function btn(kind, label, o = {}) {
  const bg = kind === 'primary' ? acc : kind === 'secondary' ? c.raised : 'transparent';
  const color = kind === 'primary' ? c.ground : o.off ? c.muted : c.text;
  const weight = kind === 'primary' ? 600 : 500;
  const size = `${o.full ? 'width: 100%; ' : ''}${o.grow ? 'flex: 1; min-width: 0' : 'flex: none'}`;
  const box = `height: 44px; ${size}; box-sizing: border-box; padding: 0 ${o.tight ? 12 : 16}px; border-radius: 8px; background: ${bg}; color: ${color}${o.off ? '; opacity: 0.6' : ''}`;
  const lay = 'display: flex; align-items: center; justify-content: center; gap: 8px';
  const inner = `${o.icon ?? ''}${label}`;
  const aria = o.aria ? ` aria-label="${o.aria}"` : '';
  if (o.href)
    return `<a href="${o.href}"${aria} style="${box}; font-size: 14px; line-height: 20px; font-weight: ${weight}; text-decoration: none; ${lay}">${inner}</a>`;
  return `<button type="button"${aria}${o.off ? ' aria-disabled="true"' : ''} style="${box}; border: 0; font: ${weight} 14px/20px ${sans}; ${lay}">${inner}</button>`;
}

/** A 44 by 44 raised icon control. */
export function square(icon, label, o = {}) {
  const style = `width: 44px; height: 44px; flex: none; border-radius: 8px; background: ${o.quiet ? 'transparent' : c.raised}; color: ${o.color ?? (o.quiet ? c.muted : c.text)}; display: flex; align-items: center; justify-content: center`;
  if (o.href) return `<a href="${o.href}" aria-label="${label}" style="${style}">${icon}</a>`;
  const pressed = o.pressed == null ? '' : ` aria-pressed="${o.pressed}"`;
  return `<button type="button"${pressed} aria-label="${label}" style="${style}; border: 0">${icon}</button>`;
}

/**
 * An info mark after an entry's name. A tap opens the explanation under the entry; one is open at a time.
 * The bubble and its pointer are placed against the nearest positioned ancestor: the row, caption or header.
 * `rise` pulls the mark's box in vertically so a 16-high caption line keeps its height; `drop` is how far under the
 * ancestor's lower edge the bubble starts (rows tuck it in by 4, a caption or a name on its own line pushes it down).
 */
export function tip(about, text, o = {}) {
  const left = o.left ?? 16;
  const drop = o.drop ?? -4;
  const mark = `<summary aria-label="About ${about}" style="width: 44px; height: 44px; margin: -11px -12px; list-style: none; color: ${c.muted}; cursor: pointer; display: flex; align-items: center; justify-content: center">${svg(I.info, 20)}</summary>`;
  const pointer = `<span aria-hidden="true" style="position: absolute; z-index: 3; top: calc(100% + ${drop - 6}px); margin-left: 4px; width: 12px; height: 12px; border-radius: 2px; background: ${c.text}; transform: rotate(45deg); display: block"></span>`;
  const bubble = `<span role="tooltip" style="position: absolute; z-index: 3; top: calc(100% + ${drop}px); left: ${left}px; width: ${o.width ?? 300}px; max-width: calc(100% - ${2 * left}px); box-sizing: border-box; padding: 12px; border-radius: 8px; background: ${c.text}; color: ${c.ground}; font-size: 14px; line-height: 20px; font-weight: 400; letter-spacing: 0; text-transform: none; white-space: normal; display: block">${text}</span>`;
  return `<details name="tip"${o.open ? ' open="open"' : ''} style="width: 20px; height: 22px; flex: none${o.rise ? `; margin: -${o.rise}px 0` : ''}">${mark}${pointer}${bubble}</details>`;
}

/** A row whose name carries a tooltip. The name and the right edge are the link or button; the mark sits between. */
function tipRow(r, last) {
  const two = r.sub != null || r.below != null;
  const s = ['position: relative', `min-height: ${r.h ?? (two ? 64 : 52)}px`, 'box-sizing: border-box', `padding: ${two ? '10px' : '0'} 16px`];
  if (!last) s.push(`border-bottom: 1px solid ${c.line}`);
  s.push(`color: ${r.danger ? c.danger : r.dim ? c.muted : c.text}`, 'font-size: 16px', 'line-height: 22px', 'display: flex', 'align-items: center', 'gap: 12px');
  const plain = 'border: 0; padding: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer';
  const name = r.href
    ? `<a href="${r.href}" style="min-width: 0; color: inherit; text-decoration: none; ${st.clip}">${r.label}</a>`
    : r.btn
      ? `<button type="button" style="min-width: 0; ${plain}; ${st.clip}">${r.label}</button>`
      : `<span style="min-width: 0; ${st.clip}">${r.label}</span>`;
  const line = `<div style="min-width: 0; display: flex; align-items: center; gap: 4px">${name}${tip(r.label, r.tip, { open: r.tipOpen })}</div>`;
  const sub = r.sub == null ? '' : `<div style="font-size: 14px; line-height: 20px; color: ${r.subColor ?? c.muted}; ${r.wrap ? '' : st.clip}">${r.sub}</div>`;
  const below = r.below == null ? '' : `<div style="padding-top: 6px">${r.below}</div>`;
  const text = `<div style="flex: 1; min-width: 0; display: flex; flex-direction: column">${line}${sub}${below}</div>`;

  const right = [];
  if (r.value != null) right.push(`<span style="font-size: 14px; line-height: 20px; font-weight: 500; color: ${r.valueColor ?? c.muted}; white-space: nowrap">${r.value}</span>`);
  if (r.right) right.push(r.right);
  if (r.chev) right.push(svg(I.chev, 16, { stroke: c.muted }));
  const lay = 'flex: none; align-self: stretch; display: flex; align-items: center; gap: 8px';
  const opens = r.value != null || r.chev;
  const rightHtml = !right.length
    ? ''
    : r.href && opens
      ? `<a href="${r.href}" aria-label="${r.label}" style="${lay}; color: inherit; text-decoration: none">${right.join('')}</a>`
      : r.btn && opens
        ? `<button type="button" aria-label="${r.label}" style="${lay}; ${plain}">${right.join('')}</button>`
        : `<div style="${lay}">${right.join('')}</div>`;
  return `<div style="${s.join('; ')}">${r.lead ?? ''}${text}${rightHtml}</div>`;
}

/** The leading 20 px icon slot of a row. */
export const lead = (icon, color = c.muted) =>
  `<span style="width: 20px; height: 20px; flex: none; color: ${color}; display: flex">${svg(icon)}</span>`;

/**
 * One row of a group card. label left, value or control right, 16 inset.
 * One line is 52 high; with `sub` (a status line) or `below` (a bar) it is 64 or more.
 */
export function row(r, last = true) {
  if (r.tip) return tipRow(r, last);
  const tag = r.href ? 'a' : r.btn ? 'button' : 'div';
  const two = r.sub != null || r.below != null;
  const s = [];
  if (tag === 'button') s.push('width: 100%');
  s.push(`min-height: ${r.h ?? (two ? 64 : 52)}px`, 'box-sizing: border-box', `padding: ${two ? '10px' : '0'} 16px`);
  if (tag === 'button') s.push('border: 0');
  if (!last) s.push(`border-bottom: 1px solid ${c.line}`);
  s.push(`background: ${r.sel ? c.raised : 'transparent'}`, `color: ${r.danger ? c.danger : r.dim ? c.muted : c.text}`);
  if (tag === 'a') s.push('text-decoration: none');
  if (tag === 'button') s.push(`font: 400 16px/22px ${sans}`, 'text-align: left');
  else s.push('font-size: 16px', 'line-height: 22px');
  s.push('display: flex', 'align-items: center', 'gap: 12px');

  const labelStyle = `${r.strong ? 'font-weight: 500; ' : ''}${st.clip}`;
  const sub = r.sub == null ? '' : `<span style="font-size: 14px; line-height: 20px; color: ${r.subColor ?? c.muted}; ${r.wrap ? '' : st.clip}">${r.sub}</span>`;
  const below = r.below == null ? '' : `<span style="display: block; padding-top: 6px">${r.below}</span>`;
  const text = `<span style="flex: 1; min-width: 0; display: flex; flex-direction: column"><span style="${labelStyle}">${r.label}</span>${sub}${below}</span>`;

  const right = [];
  if (r.value != null) right.push(`<span style="font-size: 14px; line-height: 20px; font-weight: 500; color: ${r.valueColor ?? c.muted}; white-space: nowrap">${r.value}</span>`);
  if (r.right) right.push(r.right);
  if (r.chev) right.push(svg(I.chev, 16, { stroke: c.muted }));
  const rightHtml = right.length ? `<span style="flex: none; display: flex; align-items: center; gap: 8px">${right.join('')}</span>` : '';

  const attrs = tag === 'a' ? ` href="${r.href}"` : tag === 'button' ? ` type="button"${r.pressed == null ? '' : ` aria-pressed="${r.pressed}"`}` : '';
  return `<${tag}${attrs} style="${s.join('; ')}">${r.lead ?? ''}${text}${rightHtml}</${tag}>`;
}

export const rows = (list) => list.map((r, i) => row(r, i === list.length - 1)).join('\n');

/**
 * A captioned group: caption line, then a surface card holding `inner`. `side` sits at the caption's right edge,
 * `tip` adds a tooltip to the caption. A card with a tooltip inside it does not clip, so the bubble can leave it.
 */
export function group(caption, inner, o = {}) {
  const side = o.side ? `<span style="font-weight: 500; letter-spacing: 0; text-transform: none">${o.side}</span>` : '';
  const sideNote = o.side ? `<span style="margin-left: auto; font-size: 12px; line-height: 16px; font-weight: 500; color: ${c.muted}">${o.side}</span>` : '';
  const cap = !caption
    ? ''
    : o.tip
      ? `<div style="position: relative; padding: 0 16px; display: flex; align-items: center; gap: 4px"><h2 style="${st.caption}">${caption}</h2>${tip(caption.split(' · ')[0], o.tip, { open: o.tipOpen, rise: 3, drop: 6 })}${sideNote}</div>\n`
      : `<h2 style="${st.caption}; padding: 0 16px${o.side ? '; display: flex; justify-content: space-between; gap: 12px' : ''}">${o.side ? `<span>${caption}</span>` : caption}${side}</h2>\n`;
  const note = o.note ? `\n<p style="${st.note}; padding: 0 16px">${o.note}</p>` : '';
  const clip = inner.includes('<details') ? '' : '; overflow: hidden';
  return `<div style="flex: none; display: flex; flex-direction: column; gap: 8px">
${cap}<div style="border-radius: 14px; background: ${c.surface}${clip}">
${inner}
</div>${note}
</div>`;
}

/** A book with its work in progress: cover, title, then one status line per format. */
export function bookRow(r, last = true) {
  const lines = r.lines
    .map((l) => {
      const icon = l.icons ? l.icons.map(([shape, what]) => svg(shape, 16, { label: what })).join('') : l.icon ? svg(l.icon, 16, { label: l.what }) : '';
      const line = `<span style="display: flex; align-items: center; gap: 6px; font-size: 14px; line-height: 20px; color: ${l.danger ? c.danger : c.muted}">${icon}<span style="${st.clip}">${l.text}</span></span>`;
      return l.bar == null ? line : `${line}<span style="display: block; padding: 6px 0 2px">${bar(l.bar)}</span>`;
    })
    .join('');
  const num = r.num == null ? '' : `<span style="width: 20px; flex: none; text-align: right; font-size: 14px; line-height: 20px; font-weight: 500; color: ${c.muted}">${r.num}</span>`;
  const main = `${num}${r.cover ?? cover(r.book, 40)}<span style="flex: 1; min-width: 0; display: flex; flex-direction: column"><span style="font-size: 16px; line-height: 22px; font-weight: 500; ${st.clip}">${r.book.t}</span>${lines}</span>`;
  const right = [];
  if (r.value) right.push(`<span style="font-size: 12px; line-height: 16px; color: ${c.muted}; white-space: nowrap">${r.value}</span>`);
  if (r.chev) right.push(svg(I.chev, 16, { stroke: c.muted }));
  const edge = `min-height: ${r.compact ? 56 : 64}px; box-sizing: border-box; padding: ${r.compact ? 6 : 12}px 16px; ${last ? '' : `border-bottom: 1px solid ${c.line}; `}background: ${r.sel ? c.raised : 'transparent'}`;
  const link = `color: ${r.dim ? c.muted : c.text}; text-decoration: none; display: flex; align-items: center; gap: 12px`;
  if (r.action && !r.href)
    return `<div style="${edge}; display: flex; align-items: center; gap: 12px"><span style="flex: 1; min-width: 0; ${link}">${main}</span>${r.action}</div>`;
  if (r.action)
    return `<div style="${edge}; display: flex; align-items: center; gap: 12px"><a href="${r.href}" style="flex: 1; min-width: 0; ${link}">${main}</a>${r.action}</div>`;
  const rightHtml = right.length ? `<span style="flex: none; display: flex; align-items: center; gap: 8px">${right.join('')}</span>` : '';
  return `<a href="${r.href}" style="${edge}; ${link}">${main}${rightHtml}</a>`;
}

export const bookRows = (list) => list.map((r, i) => bookRow(r, i === list.length - 1)).join('\n');

/** Three covers behind one another: a series. */
export function stackCover(colors) {
  const [front, middle, back] = colors;
  const block = (color, left, top, size, radius) => `<span style="position: absolute; left: ${left}px; top: ${top}px; width: ${size}px; height: ${size}px; border-radius: ${radius}px; background: ${color}; display: block"></span>`;
  return `<span style="width: 52px; height: 40px; flex: none; position: relative; display: block">${block(back, 20, 4, 32, 6)}${block(middle, 10, 2, 36, 7)}${block(front, 0, 0, 40, 8)}</span>`;
}

/** One step of a process: done, now (with its bar) or next. */
export function step(state, label, value = '', pct = null) {
  const slot = 'width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center';
  const mark =
    state === 'done'
      ? `<span style="${slot}">${svg(I.check, 20, { stroke: c.ok, sw: 2.5, label: 'Done' })}</span>`
      : state === 'now'
        ? `<span role="img" aria-label="Running" style="${slot}"><span style="width: 10px; height: 10px; border-radius: 999px; background: ${acc}; display: block"></span></span>`
        : `<span role="img" aria-label="Not started" style="${slot}"><span style="width: 10px; height: 10px; box-sizing: border-box; border: 2px solid ${c.muted}; border-radius: 999px; display: block"></span></span>`;
  const color = state === 'next' ? c.muted : c.text;
  const text = `<span style="flex: 1; min-width: 0; display: flex; flex-direction: column"><span style="${state === 'now' ? 'font-weight: 500; ' : ''}${st.clip}">${label}</span>${pct == null ? '' : `<span style="display: block; padding-top: 6px">${bar(pct)}</span>`}</span>`;
  const val = value ? `<span style="flex: none; font-size: 14px; line-height: 20px; font-weight: 500; color: ${state === 'now' ? c.text : c.muted}; white-space: nowrap">${value}</span>` : '';
  return `<div style="min-height: 36px; box-sizing: border-box; padding: ${pct == null ? '0' : '8px'} 16px; color: ${color}; font-size: 16px; line-height: 22px; display: flex; align-items: center; gap: 12px">${mark}${text}${val}</div>`;
}

/** A segmented control whose segments are links to sibling boards. */
export function segments(label, items, current) {
  const seg = ([text, href], i) =>
    i === current
      ? `<a href="${href}" aria-current="page" style="flex: 1; border-radius: 6px; background: ${c.ground}; color: ${c.text}; font-size: 14px; line-height: 20px; font-weight: 600; text-decoration: none; display: flex; align-items: center; justify-content: center">${text}</a>`
      : `<a href="${href}" style="flex: 1; border-radius: 6px; color: ${c.muted}; font-size: 14px; line-height: 20px; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center">${text}</a>`;
  return `<div role="group" aria-label="${label}" style="height: 44px; flex: none; box-sizing: border-box; padding: 4px; border-radius: 8px; background: ${c.raised}; display: flex">
${items.map(seg).join('\n')}
</div>`;
}

export const topHeader = (title, right = '') =>
  `<header style="height: 44px; flex: none; display: flex; align-items: center; justify-content: space-between">
<h1 style="${st.title}">${title}</h1>${right ? `\n<div style="display: flex; gap: 8px">${right}</div>` : ''}
</header>`;

/** Back button and title, then the book the page belongs to. */
export const backHeader = (href, backLabel, title, context = '', o = {}) =>
  `<header style="${o.tip ? 'position: relative; ' : ''}height: 44px; flex: none; display: flex; align-items: center; gap: 12px">
${square(svg(I.back), backLabel, { href })}
${o.tip ? `<div style="min-width: 0; display: flex; align-items: center; gap: 6px"><h1 style="${st.title}">${title}</h1>${tip(title, o.tip, { left: 0 })}</div>` : `<h1 style="${st.title}">${title}</h1>`}
</header>${context ? `\n<p style="margin: -8px 0 0; flex: none; ${st.sub}; ${st.clip}">${context}</p>` : ''}`;

const miniPlayer = `<a href="NowPlaying.dc.html" aria-label="Open now playing" style="height: 64px; flex: none; box-sizing: border-box; padding: 0 16px; background: #182117; border-top: 1px solid #3c4934; display: flex; align-items: center; gap: 12px; color: #e6eadf; text-decoration: none">
<div style="width: 40px; height: 40px; flex: none; border-radius: 8px; background: #3f5a4a"></div>
<div style="flex: 1; min-width: 0"><div style="font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">There Is No Antimemetics Division</div><div style="font-size: 12px; line-height: 16px; color: #a9b59d">Chapter 7</div></div>
<span style="width: 44px; height: 44px; flex: none; border-radius: 999px; background: #26331f; display: flex; align-items: center; justify-content: center"><svg role="img" aria-label="Paused" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg></span>
</a>`;

const places = [
  ['library', 'Library', I.library, 'Library.dc.html', 'DesktopLibrary.dc.html'],
  ['discover', 'Discover', I.discover, 'Library.dc.html', 'DesktopLibrary.dc.html'],
  ['activity', 'Activity', I.activity, 'Activity.dc.html', 'DesktopActivity.dc.html'],
  ['settings', 'Settings', I.settings, 'Settings.dc.html', 'DesktopSettings.dc.html'],
];

/** The phone tab bar: four places, with the attention dot on Activity. */
export function tabBar(current) {
  const tab = ([id, label, icon, href]) => {
    const on = id === current;
    const mark = id === 'activity'
      ? `<span style="position: relative; display: flex">${svg(icon, 22, on ? { stroke: acc } : {})}<span role="img" aria-label="Needs attention" style="position: absolute; top: -2px; right: -6px; width: 8px; height: 8px; border-radius: 999px; background: ${acc}"></span></span>`
      : svg(icon, 22, on ? { stroke: acc } : {});
    return on
      ? `<a href="${href}" aria-current="page" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #e6eadf; text-decoration: none; font-size: 12px; line-height: 16px; font-weight: 600">${mark}${label}</a>`
      : `<a href="${href}" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #a9b59d; text-decoration: none; font-size: 12px; line-height: 16px; font-weight: 500">${mark}${label}</a>`;
  };
  return `<nav aria-label="Main" style="height: 64px; flex: none; box-sizing: border-box; background: #182117; border-top: 1px solid #3c4934; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr))">
${places.map(tab).join('\n')}
</nav>`;
}

/** The desktop rail: the same four places. */
export function rail(current) {
  const item = ([id, label, icon, , href]) => {
    const on = id === current;
    const mark = id === 'activity' ? `<span role="img" aria-label="Needs attention" style="margin-left: auto; width: 8px; height: 8px; border-radius: 999px; background: ${acc}"></span>` : '';
    return on
      ? `<a href="${href}" aria-current="page" style="height: 44px; padding: 0 12px; border-radius: 8px; background: #26331f; color: #e6eadf; text-decoration: none; font-size: 14px; line-height: 20px; font-weight: 600; display: flex; align-items: center; gap: 12px">${svg(icon, 20, { stroke: acc })}${label}${mark}</a>`
      : `<a href="${href}" style="height: 44px; padding: 0 12px; border-radius: 8px; color: #a9b59d; text-decoration: none; font-size: 14px; line-height: 20px; font-weight: 500; display: flex; align-items: center; gap: 12px">${svg(icon, 20)}${label}${mark}</a>`;
  };
  return `<nav aria-label="Main" style="flex: 1 1 220px; max-width: 100%; box-sizing: border-box; padding: 32px 16px; background: #182117; display: flex; flex-direction: column; gap: 24px">
<div style="padding: 0 12px; font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 20px; line-height: 26px">Sonder</div>
<div style="display: flex; flex-direction: column; gap: 4px">
${places.map(item).join('\n')}
</div>
</nav>`;
}

/** A phone screen inside the app: content, mini player, tab bar. */
export function phone(body, nav) {
  return `<div style="width: 390px; height: 844px; box-sizing: border-box; background: ${c.ground}; color: ${c.text}; font-family: ${fBody}; display: flex; flex-direction: column">

<div style="flex: 1; min-height: 0; overflow: hidden; padding: 16px 16px 0; display: flex; flex-direction: column; gap: 16px">
${body}
</div>

${miniPlayer}

${tabBar(nav)}
</div>`;
}

/** A full-screen phone sheet: no player, no tab bar. */
export function sheet(body) {
  return `<div style="width: 390px; height: 844px; box-sizing: border-box; padding: 16px; background: ${c.ground}; color: ${c.text}; font-family: ${fBody}; display: flex; flex-direction: column; gap: 16px">
${body}
</div>`;
}

/** A desktop page: rail, then the main column. `minH` is the board's height. */
export function desktop(current, body, minH = 800) {
  return `<div style="min-height: ${minH}px; box-sizing: border-box; background: ${c.ground}; color: ${c.text}; font-family: ${fBody}; display: flex; flex-wrap: wrap">

${rail(current)}

<main style="flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 32px; display: flex; flex-direction: column; gap: 24px">
${body}
</main>
</div>`;
}

/** The whole .dc.html file around a board's root element. */
export function page(title, w, h, root, fonts = 'DM+Sans:wght@400;500;600&family=Manrope:wght@600;700') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family=${fonts}&display=swap" rel="stylesheet">
<style>
body{margin:0}
a{color:#dd8966}a:hover{color:#f0a586}
</style>
</helmet>
${root}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"accent":{"editor":"color","default":"#dd8966","options":["#dd8966","#e0b060","#8fb8a0","#9db4e8"]},"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
renderVals() {
return { accent: this.props.accent ?? '#dd8966' };
}
}
</script>
</body>
</html>
`;
}
