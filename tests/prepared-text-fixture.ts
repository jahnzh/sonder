// EPUBs for the prepared-text tests: chapters given as body markup, plus any other files of the archive.
import JSZip from "jszip";

export type PreparedFixture = {
  /** Body markup per chapter file, in reading order. A value that starts with "<html" or "<?xml" is the whole file. */
  chapters: Record<string, string>;
  /** Other archive entries, by their path under OEBPS/. */
  files?: Record<string, string | Buffer>;
  /** The EPUB 3 contents document's `<nav>` markup; it is in the manifest and, with `navInSpine`, in the spine. */
  nav?: string;
  navInSpine?: boolean;
  /** An NCX's `<navMap>` markup. */
  ncx?: string;
  language?: string;
};

const types: Record<string, string> = { css: "text/css", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", js: "text/javascript" };

export async function preparedFixture(fixture: PreparedFixture): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const names = Object.keys(fixture.chapters);
  const items = names.map((name, index) => `<item id="c${index}" href="${name}" media-type="application/xhtml+xml"/>`);
  const spine = names.map((_name, index) => `<itemref idref="c${index}"/>`);
  for (const [index, name] of Object.keys(fixture.files || {}).entries()) {
    const type = types[name.split(".").pop()!.toLowerCase()] || "application/octet-stream";
    items.push(`<item id="f${index}" href="${name}" media-type="${type}"/>`);
  }
  if (fixture.nav) {
    items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    if (fixture.navInSpine) spine.unshift('<itemref idref="nav"/>');
    zip.file("OEBPS/nav.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>${fixture.nav}</body></html>`);
  }
  if (fixture.ncx) {
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    zip.file("OEBPS/toc.ncx", `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">${fixture.ncx}</ncx>`);
  }
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">prepared-text-test</dc:identifier><dc:title>Prepared</dc:title><dc:creator>Test</dc:creator><dc:language>${fixture.language || "en"}</dc:language></metadata><manifest>${items.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
  );
  for (const [name, body] of Object.entries(fixture.chapters))
    zip.file(
      `OEBPS/${name}`,
      /^<(html|\?xml)/.test(body) ? body : `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${name}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`,
    );
  for (const [name, data] of Object.entries(fixture.files || {})) zip.file(`OEBPS/${name}`, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A 2×3 PNG: enough of a header for its size to be read. */
export const tinyPng = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000020000000308060000007d0b6c6e0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

/**
 * Hostile chapters from the review of #809: each is one way a browser's parser and the server's could read a book
 * differently (raw-text elements, comments, CDATA, foreign content, repeated and namespaced attributes, entities in
 * addresses, broken nesting, tables, names that shadow a page's globals). The unit tests prepare each one; the browser
 * test puts the prepared parts into a page.
 */
const X = '<img src=x onerror=alert(1)>';
export const hostileCases: Record<string, string> = {
  noscript1: `<noscript><p title="</noscript>${X}">ns text.</p></noscript>`,
  noscript2: `<p>a<noscript>&lt;/noscript&gt;&lt;img src=x onerror=alert(1)&gt;</noscript>b</p>`,
  style_in_p: `<p>s<style>${X}</style>t</p><p><style></style>${X}</p>`,
  style_attr_close: `<p title="</style>${X}">u.</p><style>p[title="</style>${X}"]{}</style><p>after style.</p>`,
  rawtext: `<xmp>${X}</xmp><textarea>${X}</textarea><title>${X}</title><plaintext>${X}`,
  rawtext2: `<p>one.</p><noembed>${X}</noembed><noframes>${X}</noframes><listing>${X}</listing><iframe>${X}</iframe><p>two.</p>`,
  textarea_break: `<textarea></textarea>${X}<p>z.</p><textarea><p></textarea>${X}</p></textarea>`,
  template: `<template>${X}<script>alert(1)</script><p>tpl.</p></template>`,
  comments: `<p>c1.</p><!-- -->${X}<!-- x --><!-->${X}--><!--->${X}--><!-- --!>${X}--><!-- <p>in comment.</p> --><p>c2.</p>`,
  comment_unclosed: `<p>d1.</p><!-- ${X} <p>d2.</p>`,
  cdata: `<p>e1 <![CDATA[${X}<script>alert(1)</script>]]> e2.</p><![CDATA[</p>${X}]]>`,
  pi: `<?xml-stylesheet href="https://evil.example/x.css"?><p>f1.</p><?php ${X} ?><? ${X} ?><p>f2.</p>`,
  doctype: `<!DOCTYPE html [<!ENTITY x "${X}">]><p>g &x; g.</p><!ENTITY y SYSTEM "file:///etc/passwd">`,
  svg1: `<svg><style><![CDATA[</style>${X}]]></style><foreignObject><p>fo.</p>${X}</foreignObject><title>${X}</title><desc>${X}</desc><image href="pic.png" onerror="alert(1)"/><image xlink:href="https://evil.example/a.png"/><use href="https://evil.example/x.svg#a"/></svg><p>after svg.</p>`,
  svg_prefixed: `<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script><svg:image xlink:href="pic.png"/><svg:a xlink:href="javascript:alert(1)"><svg:text>pref text.</svg:text></svg:a></svg:svg><x:script>alert(2)</x:script><x:style>${X}</x:style><h:img src="pic.png" onerror="alert(1)"/>`,
  math1: `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;"></mglyph></table></mtext></math><math><annotation-xml encoding="text/html">${X}<p>ax.</p></annotation-xml><mi xlink:href="javascript:alert(1)">mi.</mi></math>`,
  math2: `<math><mi><style>${X}</style></mi><ms><p>ms.</p></ms></math><form><math><mtext></form><form><mglyph><style></math>${X}`,
  dup_attr: `<p lang="en" lang='x" onmouseover="alert(1)' id="a" id='b"><script>' class="c" class='"><i>'>dup.</p><a href="https://ok.example/" href="javascript:alert(1)">dl.</a><a href="javascript:alert(1)" href="https://ok.example/">dl2.</a><img src="pic.png" src="https://evil.example/x.png" alt="a" alt='"onerror="alert(1)'/>`,
  ns_attr: `<p xml:lang='en" onclick="alert(1)' xml:id="x" xlink:href="javascript:alert(1)" xmlns:on="x" on:click="alert(1)">ns.</p><a xlink:href="javascript:alert(1)" href="#x">nl.</a><img xlink:href="https://evil.example/x.png"/><img href="javascript:alert(1)"/>`,
  entity_href: `<p><a href="&#106;avascript:alert(1)">h1.</a><a href="jav&#x09;ascript:alert(1)">h2.</a><a href="&#1;javascript:alert(1)">h3.</a><a href="javascript&colon;alert(1)">h4.</a><a href="https://x.example/&quot; onmouseover=&quot;alert(1)">h5.</a><a href="https://x.example/&#34;&#62;&#60;img src=x onerror=alert(1)&#62;">h6.</a><a href="  https://x.example/a b">h7.</a><a href="https:javascript:alert(1)">h8.</a><a href="HTTPS://X.example">h9.</a><a href="mailto:a@b.example?subject=&lt;script&gt;">h10.</a><a href="http://x.example/\njavascript:alert(1)">h11.</a><a href="https://x.example/?a=1&amp;b=2">h12.</a><a href="\tjavascript:alert(1)">h13.</a><a href="feed:javascript:alert(1)">h14.</a><a href="blob:https://x/1">h15.</a><a href="file:///etc/passwd">h16.</a><a href="\\\\evil.example\\x">h17.</a><a href="/\\evil.example/x">h18.</a><a href="https://user:pw@evil.example/">h19.</a></p>`,
  entity_src: `<p><img src="&#104;ttps://evil.example/a.png"/><img src="\\\\evil.example\\a.png"/><img src="/\\evil.example/a.png"/><img src="pic.png?x=&quot;&gt;&lt;script&gt;"/><img src="pic.png#&quot; onerror=&quot;alert(1)"/><img src="PIC.PNG" alt="&#34;&#62;${'<script>alert(1)</script>'}"/><img src="pic.png" srcset="https://evil.example/1.png 1x, https://evil.example/2.png 2x" sizes="1px" usemap="#m" longdesc="javascript:alert(1)" lowsrc="https://evil.example/l.png" dynsrc="x" style="background:url(https://evil.example/s.png)"/><picture><source srcset="https://evil.example/s.png"/><img src="pic.png"/></picture><input type="image" src="https://evil.example/i.png"/><body background="https://evil.example/b.png"><image src="https://evil.example/i2.png"/><image src="pic.png"/></p>`,
  nesting: `<p>n1<p>n2<div>n3</p></div></p><a href="https://a.example">a1<a href="https://b.example">a2</a>a3</a><table><tr><td><table><p>t1</table><img src="pic.png"/><b><p>bp</b>after</p><table><a href="https://c.example"><td>x</td></a></table><table>loose<tr>row text<td>cell</td></tr></table><table><caption><table><tr><td>inner</td></tr></table></caption></table><h1>h<h2>hh</h2></h1><li>l1<li>l2</li></li><select><option><p>opt.</p></option></select><button><button>bb.</button></button><p><span><div>deep block.</div></span></p><i><b><p>ib.</i></b></p>`,
  tables: `<table><tbody><tr><td>A.</td><form><td>B.</td></form></tr></tbody><tr><p>stray.</p></tr><colgroup><col span="2"/><p>cg.</p></colgroup><caption><table><tr><td>${X}</td></tr></table></caption></table><table><tr><td colspan="2&quot; onclick=&quot;alert(1)" rowspan="1e3">cs.</td><th colspan="3">th.</th></tr></table><table><thead><td>no row.</td></thead></table><td>lone td.</td><tr><td>lone tr.</td></tr><caption>lone caption.</caption>`,
  clobber: `<a name="location">k1.</a><a id="document" name="cookie">k2.</a><form id="forms" name="body"><input name="innerHTML" id="attributes"/></form><img name="getElementById" id="root" src="pic.png"/><p id="root">k3.</p><p id="app">k4.</p><iframe name="top"></iframe><embed name="self"/><object id="fetch"></object><p id="__proto__">k5.</p><p id="constructor">k6.</p>`,
  attrname: `<p class=x/onclick=alert(1)>an1.</p><p "onclick=alert(1)">an2.</p><p onclick=alert(1)//>an3.</p><p/onclick=alert(1)>an4.</p><img/src=pic.png/onerror=alert(1)><p =onclick=alert(1)>an5.</p><p lang=en\u0000 title=\`x\` data-s="9:9" data-part="7" data-id='"><i>' data-sentence="1:1" contenteditable autofocus onfocus=alert(1) tabindex=1 is="x-y" slot=a part=b draggable=true hidden popover inert dir=rtl accesskey=x>an6.</p>`,
  tagname: `<p<img src=x onerror=alert(1)>>tn1.</p><ImG SRC="pic.png" OnErRoR="alert(1)"><sCrIpT>alert(1)</ScRiPt><div:script>alert(2)</div:script><script:p>sp.</script:p><p:script>alert(3)</p:script><x:p onclick="alert(1)">xp.</x:p><em/><span/>tn2.<br clear="all" onclick="alert(1)"><BR/><hr onclick="alert(1)" noshade>`,
  script_variants: `<script type="text/plain">${X}</script><script><!--</script>${X}--></script><p>sv1.</p><script>"</script>${X}"</script><script/>${X}<p>sv2.</p><script src="x.js"/><p>sv3.</p></script>`,
  text_chars: `<p>nul\u0000x &#0; &#x80; &#xD800; &#x10FFFF; \r\n cr \r lone &lt;img src=x onerror=alert(1)&gt; a < b <3 <<i>it</i> &amp;lt;script&amp;gt; &ampersand; &lt &gt &notit; &#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;   ­ ﻿.</p>`,
  pre: `<pre>${X}<script>alert(1)</script></pre><pre>\n\nline</pre><pre><p>pp.</p></pre><pre></pre><pre>&lt;/pre&gt;${X}</pre><p>after pre.</p>`,
  lists: `<ol start="5&quot; onclick=&quot;x" type="a" reversed><li value="3" onclick="x">li.</li></ol><ol start="-1"><li>neg.</li></ol><ol start="1e2"><li>exp.</li></ol><ol start="0x10"><li>hex.</li></ol><ol start=" 7 "><li>sp.</li></ol>`,
  base_meta: `<base href="https://evil.example/"/><meta http-equiv="refresh" content="0;url=https://evil.example"/><link rel="stylesheet" href="https://evil.example/x.css"/><link rel="preload" as="image" href="https://evil.example/p.png"/><p>bm <a href="rel.xhtml">rel</a> <a href="#frag&quot;&gt;&lt;i&gt;">frag</a>.</p><p id="frag&quot;&gt;&lt;i&gt;">target.</p>`,
  media: `<video src="https://evil.example/v.mp4" poster="https://evil.example/p.jpg" autoplay onloadstart="alert(1)"><source src="https://evil.example/v2.mp4"/><track src="https://evil.example/t.vtt"/>vid.</video><audio src="https://evil.example/a.mp3" autoplay></audio><object data="https://evil.example/o"><param name="movie" value="https://evil.example/m"/>obj.</object><embed src="https://evil.example/e"/><applet code="x">app.</applet><frameset><frame src="https://evil.example/f"/></frameset><portal src="https://evil.example/p"></portal><fencedframe src="https://evil.example/ff"></fencedframe>`,
  details: `<details open ontoggle="alert(1)"><summary>sum.</summary>det.</details><dialog open>dlg.</dialog><marquee onstart="alert(1)">mq.</marquee><body onload="alert(1)"><p onpointerenter="alert(1)" onanimationstart="alert(1)" style="animation-name:x">ev.</p><keygen autofocus onfocus="alert(1)"/><isindex action="javascript:alert(1)"/>`,
  lang: `<p lang="en\n">l1.</p><p lang="en-US">l2.</p><p lang='en" x="'>l3.</p><p xml:lang="fr">l4.</p>`,
  hints: `<p style="text-align:center&quot; onclick=&quot;x" class="c x&quot;&gt;&lt;script&gt; t-hide t-nav part-row app">hc.</p><p class="evil">cls.</p><p align='center"><script>'>al.</p><p epub:type='pagebreak" onclick="x' role="pagebreak">pb.</p><span style="display:none">hidden words.</span>`,
};
/** The other files of a book made of `hostileCases`: a picture the chapters show and a stylesheet that reaches out. */
export const hostileFiles = {
  "pic.png": tinyPng,
  "style.css": `.c{text-align:center} .evil{font-style:italic;background:url(https://evil.example/css.png)} .x\"\>{font-weight:bold} @import url(https://evil.example/i.css);`,
};
