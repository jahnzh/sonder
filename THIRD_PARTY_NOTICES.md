The HTML parsers in `server/sources/annas-archive-parse.ts` and `server/sources/libgen-parse.ts` are adapted from [Vaka](https://github.com/vaka-hq/mobile), retrieved 2026-10-26, under its MIT license. Vaka is an independent project; Sonder is not affiliated with it.

MIT License

Copyright (c) 2026 Isak

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The eight illustrated covers and Sonder mark in this repository are original SVG illustrations. Demo recordings are from LibriVox via the Internet Archive. The included Alice chapter is read by Kara Shallenberg. Recording identifiers and chapter URLs are in `server/catalog.json`. Public-domain status may differ by jurisdiction.

## EPUB reader and local alignment

- [EPUB.js 0.3.93](https://github.com/futurepress/epub.js): BSD-2-Clause. Its XML fallback is overridden to `@xmldom/xmldom` 0.9.12. The browser uses its native DOM parser.
- [DOMPurify](https://github.com/cure53/DOMPurify): Apache-2.0 or MPL-2.0; used to sanitize EPUB documents. [JSZip](https://github.com/Stuk/jszip): MIT or GPL-3.0; used under MIT. [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser): MIT.
- [aeneas 1.7.3](https://github.com/readbeyond/aeneas): AGPL-3.0. The unmodified distribution and license are included in the worker image. The worker source and Dockerfile are in this repository's `worker/` directory. It uses eSpeak (GPL-3.0) and FFmpeg from Debian; their package notices remain in the image.
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and [CTranslate2](https://github.com/OpenNMT/CTranslate2): MIT. The multilingual tiny model is converted from [OpenAI Whisper](https://github.com/openai/whisper), whose code and weights are MIT licensed. Pinned weights are stored on the configured media drive.
- [ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner), commit `64293cc6d711e57666c4a8b098e9fd93b381fd88`: CC-BY-NC-4.0. It is only in the separate comparison image and is not used by the production worker.

Dependency license files remain in their installed packages. No downloaded book content is relicensed by this project.
