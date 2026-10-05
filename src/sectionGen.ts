import type { SectionDef } from "./types.js";

export function generateSectionsMarkdown(sections: SectionDef[] | undefined, level = 2): string {
  const generated = sections?.filter((s) => s.presence !== "Optional");
  if (!generated || generated.length === 0) return "";
  const blocks = generated.map((section) => {
    const heading = `${"#".repeat(level)} ${section.name}`;
    const nested = generateSectionsMarkdown(section.sections, level + 1);
    return nested ? `${heading}\n\n${nested}` : heading;
  });
  return blocks.join("\n\n");
}

export function flattenSectionNames(sections: SectionDef[] | undefined): string[] {
  if (!sections) return [];
  const names: string[] = [];
  for (const s of sections) {
    names.push(s.name);
    names.push(...flattenSectionNames(s.sections));
  }
  return names;
}
