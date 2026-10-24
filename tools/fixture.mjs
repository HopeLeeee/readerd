import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import fs from "node:fs/promises";
export async function createFixture(path) {
  const pdf = await PDFDocument.create(),
    serif = await pdf.embedFont(StandardFonts.TimesRoman),
    bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const first = pdf.addPage([595, 842]);
  function line(
    page,
    text,
    x,
    y,
    size = 11,
    font = serif,
    color = rgb(0.15, 0.18, 0.16),
  ) {
    page.drawText(text, { x, y, size, font, color });
  }
  line(first, "RESEARCH ARTICLE", 55, 788, 9, bold, rgb(0.35, 0.5, 0.39));
  line(first, "Microbial metabolism and", 55, 745, 27, bold);
  line(first, "the next question", 55, 713, 27, bold);
  line(
    first,
    "A. Reader, B. Researcher  |  ReaderD interaction specimen",
    55,
    681,
    10,
  );
  line(first, "Abstract", 55, 637, 15, bold);
  const paragraph = [
    "Microbial metabolism connects dietary nutrients to host physiology.",
    "A quiet reading environment supports sustained attention and discovery.",
    "Nicotinamide metabolism offers a useful example for this reader [1, 2-4].",
    "The following text is selectable. Highlight meaningful observations.",
    "Study pathways, annotate evidence, and follow references with care.",
  ];
  paragraph.forEach((t, i) => line(first, t, 55, 611 - i * 19));
  line(first, "1 Introduction", 55, 474, 15, bold);
  for (let i = 0; i < 12; i++)
    line(
      first,
      i % 2
        ? "Scientific reading benefits from precise references and visible evidence."
        : "Enzymes and microbial communities influence metabolic pathways.",
      55,
      448 - i * 19,
    );
  line(first, "1", 292, 30, 9);
  const second = pdf.addPage([595, 842]);
  line(second, "2 Results", 55, 785, 16, bold);
  for (let i = 0; i < 21; i++)
    line(
      second,
      i % 2
        ? "Microbial metabolites represent a connection between diet and physiology."
        : "The evidence should be interpreted in the context of experimental conditions.",
      55,
      752 - i * 24,
    );
  line(second, "3 Discussion", 55, 200, 16, bold);
  line(
    second,
    "A good next paper is found among the references you have just read.",
    55,
    175,
  );
  line(second, "2", 292, 30, 9);
  const third = pdf.addPage([595, 842]);
  line(third, "References", 55, 785, 17, bold);
  const refs = [
    [
      "Smith A.",
      "Nicotinamide metabolism in the microbiome.",
      "Nature. 2024; 1:1-9.",
      "10.1000/test1",
    ],
    [
      "Jones B.",
      "Microbial enzymes and host physiology.",
      "Cell. 2023; 2:10-19.",
      "10.1000/test2",
    ],
    [
      "Chen C.",
      "NAD pathways in intestinal bacteria.",
      "Science. 2025; 3:20-29.",
      "10.1000/test3",
    ],
    [
      "Wang D.",
      "Metabolite exchange in microbial communities.",
      "Nature Metabolism. 2022; 4:30-39.",
      "10.1000/test4",
    ],
  ];
  refs.forEach((r, i) => {
    let y = 745 - i * 108;
    line(third, `[${i + 1}] ${r[0]} ${r[1]}`, 55, y);
    line(third, `${r[2]} doi: ${r[3]}`, 72, y - 20);
  });
  line(third, "3", 292, 30, 9);
  pdf.setTitle("Microbial metabolism and the next question");
  pdf.setAuthor("ReaderD test fixture");
  await fs.mkdir(new URL("../test-results/", import.meta.url), {
    recursive: true,
  });
  await fs.writeFile(path, await pdf.save());
}
