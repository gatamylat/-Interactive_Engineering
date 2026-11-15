// The template and module files remain editable. Only this derived HTML is delivered.
export function buildSingleHtml(files, modules) {
  const template = files['index.html'];
  if (typeof template !== 'string' || !template.trim()) throw Error('Сборка HTML: нет шаблона index.html.');
  if (!Array.isArray(modules) || !modules.length) throw Error('Сборка HTML: укажите модули и маркеры.');

  const comments = new Map();
  // Raw-text elements may contain strings that look like marker comments.
  const tokens = /<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|iframe|noembed|noframes)(?=[\s/>])(?:[^'"<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?[a-z][\w:-]*(?:[^'"<>]|"[^"]*"|'[^']*')*>/gi;
  for (const token of template.matchAll(tokens)) {
    if (!token[0].startsWith('<!--')) continue;
    const positions = comments.get(token[0]) || [];
    positions.push(token.index);
    comments.set(token[0], positions);
  }

  function positions(text) {
    const entries = comments.get(text) || [];
    return {first: entries[0] ?? -1, duplicate: entries.length > 1};
  }

  const usedFiles = new Set();
  const inserts = modules.map(item => {
    const {file, marker} = item || {};
    if (typeof marker !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(marker)) {
      throw Error('Сборка HTML: маркер должен иметь вид ROUTE_JS.');
    }
    const match = typeof file === 'string' && file.match(/\.(js|css)$/i);
    if (!match) throw Error('Сборка HTML: укажите файл .js или .css для ' + marker + '.');
    if (!Object.hasOwn(files, file)) throw Error('Сборка HTML: нет файла ' + file + '.');
    if (usedFiles.has(file)) throw Error('Сборка HTML: файл указан дважды — ' + file + '.');
    usedFiles.add(file);

    const tag = match[1].toLowerCase() === 'js' ? 'script' : 'style';
    const code = files[file];
    if (typeof code !== 'string' || !code.trim()) throw Error('Сборка HTML: пустой файл ' + file + '.');
    if (new RegExp('</' + tag + '(?=[\\s/>]|$)', 'i').test(code)) {
      throw Error('Сборка HTML: ' + file + ' содержит закрывающий тег ' + tag + '. Экранируйте его в исходнике модуля.');
    }

    const slot = '<!-- ' + marker + ' -->';
    const start = '<!-- ' + marker + ':START -->';
    const end = '<!-- ' + marker + ':END -->';
    const single = positions(slot), left = positions(start), right = positions(end);
    if (single.duplicate || left.duplicate || right.duplicate
      || (single.first >= 0 && (left.first >= 0 || right.first >= 0))) {
      throw Error('Сборка HTML: маркер ' + marker + ' встречается несколько раз.');
    }
    const content = '<' + tag + '>\n' + code + '\n</' + tag + '>';
    if (single.first >= 0) return {from: single.first, to: single.first + slot.length, content};
    if (left.first < 0 && right.first < 0) throw Error('Сборка HTML: маркер ' + marker + ' не найден.');
    if (left.first < 0 || right.first < left.first + start.length) {
      throw Error('Сборка HTML: проверьте пару маркеров ' + marker + ':START и ' + marker + ':END.');
    }
    return {from: left.first, to: right.first + end.length, content};
  }).sort((a, b) => a.from - b.from);

  let html = '';
  let cursor = 0;
  for (const {from, to, content} of inserts) {
    if (from < cursor) throw Error('Сборка HTML: блоки вставки пересекаются.');
    html += template.slice(cursor, from) + content;
    cursor = to;
  }
  return html + template.slice(cursor);
}
