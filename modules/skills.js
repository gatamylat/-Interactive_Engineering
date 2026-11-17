const fullSkillSize = 6000;
const verificationHeading = /^(?:как проверить|проверка(?: результата| качества| работы)?|самопроверка|чек[- ]лист проверки|критерии при[её]мки|сценарии проверки|verification|validation|(?:quality )?checks?|testing|tests|acceptance (?:criteria|tests))$/iu;
const referenceHeading = /^(?:примеры|приложени[ея]|справка|справочные материалы|дополнительные материалы|ссылки|частые вопросы|examples?|appendix|appendices|references?|resources|further reading|faq)(?:\s|:|$)/iu;
const instructionHeading = /^(?:правила|ограничения|требования|обязательные правила|правила работы|rules|constraints|requirements|guardrails)(?:\s|:|$)/iu;
const mandatory = /(?:обязательн|неприкосновенн|запрещ|никогда|всегда|не допуска|\b(?:must|never|always|required|mandatory)\b|\bdo not\b)/iu;

function frontMatter(original) {
  const text = original.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const header = text.match(/^---[ \t]*\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\n|$)/m);
  if (!header || header.index !== 0) return {body: text, fields: new Map()};
  const fields = new Map();
  let active;
  for (const line of header[1].split('\n')) {
    const match = line.match(/^([\w-]+):[ \t]*(.*)$/);
    if (match) {
      active = [match[2]];
      fields.set(match[1], active);
    } else if (active && (/^[ \t]/.test(line) || line === '')) {
      active.push(line);
    } else if (!line.startsWith('#')) {
      active = undefined;
    }
  }
  return {body: text.slice(header[0].length), fields};
}

function scalar(lines) {
  if (!lines) return '';
  const [first, ...rest] = lines;
  if (/^[>|](?:[+-]?[1-9]?|[1-9][+-]?)(?:\s*(?:#.*)?)$/.test(first)) return rest.join('\n').trim();
  const value = lines.join('\n').trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); }
    catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return lines.map(line => line.replace(/\s+#.*$/, '')).join('\n').trim();
}

function markdownSections(body) {
  const lines = body.split('\n');
  const sections = [{id: 'intro', title: '', level: 0, lines: []}];
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^\s{0,3}(```+|~~~+)(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      sections.at(-1).lines.push(line);
      continue;
    }
    if (marker) {
      fence = marker[1];
      sections.at(-1).lines.push(line);
      continue;
    }
    const atx = line.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    const setext = /^\S/.test(line) && lines[i + 1]?.match(/^[ \t]{0,3}(=+|-+)[ \t]*$/);
    if (atx || setext) {
      const title = atx ? atx[2].trim() : line.trim();
      const level = atx ? atx[1].length : setext[1][0] === '=' ? 1 : 2;
      const section = {id: 's' + sections.length, title, level, lines: [line]};
      if (setext && !atx) section.lines.push(lines[++i]);
      sections.push(section);
    } else {
      sections.at(-1).lines.push(line);
    }
  }
  return sections.map(({lines, ...section}) => ({...section, text: lines.join('\n').trim()}));
}

const headingName = title => title.replace(/^[\d.]+[.)]?\s+/, '').replace(/[:.!]+$/, '').trim();
const singleLine = text => text.replace(/\s+/g, ' ').trim();

export function skillScope(item) {
  return item.scope?.trim() || (item.kind === 'skill'
    ? singleLine(scalar(frontMatter(item.text).fields.get('description'))) : '');
}

export function skillMetadata(text) {
  const {body, fields} = frontMatter(text);
  const sections = markdownSections(body);
  const verification = [];
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    if (!verificationHeading.test(headingName(section.title))) continue;
    let end = i + 1;
    while (end < sections.length && sections[end].level > section.level) end++;
    const headingLines = /^ {0,3}#{1,6}[ \t]/.test(section.text) ? 1 : 2;
    verification.push(section.text.split('\n').slice(headingLines).join('\n').trim(),
      ...sections.slice(i + 1, end).map(child => child.text));
    i = end - 1;
  }
  const title = scalar(fields.get('name')) || text.match(/^name:[ \t]*([\w-]+)[ \t\r]*$/m)?.[1] || '';
  return {title: singleLine(title), scope: singleLine(scalar(fields.get('description'))),
    check: verification.filter(Boolean).join('\n\n')};
}

function skillContent(text) {
  const {body} = frontMatter(text);
  if (text.length <= fullSkillSize) return {instruction: text, references: []};
  const main = [];
  const references = [];
  const parents = [];
  for (const section of markdownSections(body)) {
    while (parents.length && parents.at(-1).level >= section.level) parents.pop();
    const title = headingName(section.title);
    const appendix = referenceHeading.test(title) || !!parents.at(-1)?.appendix;
    const supplemental = appendix && !verificationHeading.test(title) && !instructionHeading.test(title)
      && !mandatory.test(section.text);
    if (section.text) (supplemental ? references : main).push(section);
    parents.push({level: section.level, appendix: supplemental || (appendix && !section.title)});
  }
  return {instruction: main.map(section => section.text).join('\n\n'), references};
}

export function skillContext(item) {
  const {instruction, references} = skillContent(item.text);
  return {id: item.id, title: item.title, scope: skillScope(item), source: item.source, check: item.check,
    instruction, sections: references.length ? references.map(({id, title}) => ({id, title})) : undefined};
}

export function readSkillSection(item, sectionId) {
  const result = {material_id: item?.id, section: sectionId};
  if (item?.kind !== 'skill' || typeof sectionId !== 'string') return {...result, error: 'Раздел скилла недоступен.'};
  const section = skillContent(item.text).references.find(section => section.id === sectionId);
  return section ? {...result, title: section.title, text: section.text} : {...result, error: 'Раздел скилла недоступен.'};
}
