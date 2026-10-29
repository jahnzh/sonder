import JSZip from "jszip";
export async function readerFixture(
  options: { language?: string; script?: boolean; cover?: boolean; variant?: "svg-root" | "iframe-root" | "nav-root" | "no-head" | "head-late" | "text-before-head" | "template-root" | "svg-asset" } = {},
) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">sonder-reader-test</dc:identifier><dc:title>Alice Reader Test</dc:title><dc:creator>Lewis Carroll</dc:creator><dc:language>${options.language || "en"}</dc:language><meta property="dcterms:modified">2026-10-26T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
  );
  if (options.variant === "svg-asset") {
    // A manifest SVG that carries script, reached from an image, a link and an image map in chapter one.
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    zip.file(
      "OEBPS/content.opf",
      opf.replace(
        "<manifest>",
        '<manifest><item id="payload" href="payload.svg" media-type="image/svg+xml"/><item id="mismatch" href="ext.png?.html" media-type="image/png"/>',
      ),
    );
    // Looks like a png before the "?", but the last dot segment is html: epub.js would type its blob text/html.
    zip.file("OEBPS/ext.png?.html", `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>try{parent.__epubScriptExecuted=true}catch(e){}</script></body></html>`);
    zip.file(
      "OEBPS/payload.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>try{parent.__epubScriptExecuted=true}catch(e){}try{frameElement.removeAttribute("sandbox")}catch(e){}</script><rect width="20" height="20" fill="red"/></svg>`,
    );
  }
  if (options.cover) {
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    zip.file(
      "OEBPS/content.opf",
      opf
        .replace(
          "<manifest>",
          '<manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
        )
        .replace("<spine>", '<spine><itemref idref="cover"/>'),
    );
    zip.file(
      "OEBPS/cover.xhtml",
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Image cover</title></head><body><svg xmlns="http://www.w3.org/2000/svg"><rect width="400" height="600" fill="blue"/></svg></body></html>',
    );
  }
  zip.file(
    "OEBPS/nav.xhtml",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">Down the Rabbit-Hole</a></li><li><a href="two.xhtml">The Pool of Tears</a></li></ol></nav></body></html>',
  );
  for (const [index, href, title] of [
    [0, "one.xhtml", "Down the Rabbit-Hole"],
    [1, "two.xhtml", "The Pool of Tears"],
  ] as const) {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) =>
        `<p id="p${i}">${i === 0 ? (index === 0 ? "Alice was beginning to get very tired of sitting by her sister on the bank." : "This is the beginning of the second chapter by the pool of tears.") : `Passage ${i + 1} tells another part of Alice’s story.`} The curious rabbit carried a watch and hurried past the trees. Alice followed the little creature through the garden and wondered what would happen next.</p>`,
    ).join("");
    // Malformed first sections: a root that is not <html>, and a section without a <head>. Each tries to
    // remove the frame's own sandbox, which only works if the content ran.
    const payload = "parent.__epubScriptExecuted=true;frameElement.removeAttribute('sandbox')";
    const variants: Record<string, string> = {
      "svg-root": `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="${payload}"><script>${payload}</script></svg>`,
      "iframe-root": `<?xml version="1.0"?><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;parent.parent.__epubScriptExecuted=true&lt;/script&gt;"/>`,
      "nav-root": `<?xml version="1.0"?><nav xmlns="http://www.w3.org/1999/xhtml"><img src="missing.png" alt="" onerror="${payload}"/></nav>`,
      "template-root": `<?xml version="1.0"?><template xmlns="http://www.w3.org/1999/xhtml"><img src="/leak.png" alt="" onerror="${payload}"/></template>`,
      // Content before <head>: the HTML parser moves the head, CSP meta included, into <body> unless it is first.
      "head-late": `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><img src="/leak.png" srcset="/leak-srcset.png 1x" alt="" onerror="${payload}"/><head><title>Late head</title></head><body><p id="p0">Alice was beginning to get very tired of sitting by her sister on the bank.</p><style>p{background:url(/leak-css.png)}</style></body></html>`,
      // A single non-whitespace character before <head> is enough to move the head into <body> as well, even
      // though the head is still the first element. `root.firstElementChild !== head` misses this one.
      "text-before-head": `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">x<head><title>Text head</title></head><body><p id="p0">Alice was beginning to get very tired of sitting by her sister on the bank.</p><img src="/leak.png" srcset="/leak-srcset.png 1x" alt="" onerror="${payload}"/><style>p{background:url(/leak-css.png)}</style></body></html>`,
      "no-head": `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p id="p0">Alice was beginning to get very tired of sitting by her sister on the bank.</p><img src="/leak.png" alt="" onerror="${payload}"/><style>p{background:url(/leak-css.png)}</style></body></html>`,
    };
    if (options.variant && variants[options.variant] && index === 0) {
      zip.file(`OEBPS/${href}`, variants[options.variant]);
      continue;
    }
    zip.file(
      `OEBPS/${href}`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1>${paragraphs}${options.variant === "svg-asset" && index === 0 ? '<img id="svg-image" src="payload.svg" alt="Payload"/><a id="svg-link" href="payload.svg">Payload link</a><a id="ext-link" href="ext.png?.html">Mismatch link</a><map name="m"><area id="svg-area" shape="rect" coords="0,0,20,20" href="payload.svg" alt="Payload area"/></map>' : ""}${options.script ? '<script>parent.__epubScriptExecuted=true</script><iframe srcdoc="&lt;script&gt;parent.parent.__epubScriptExecuted=true&lt;/script&gt;"></iframe><img src="missing.png" alt="" onerror="parent.__epubScriptExecuted=true"/><p onclick="parent.__epubScriptExecuted=true">Inline handler</p><a href="javascript:void(parent.__epubScriptExecuted=true)">Script link</a><svg xmlns="http://www.w3.org/2000/svg" onload="parent.__epubScriptExecuted=true"><script>parent.__epubScriptExecuted=true</script></svg>' : ""}</body></html>`,
    );
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
