// Keep the source files editable. Only this derived HTML is delivered.
const moduleFile = /\.(?:js|css)$/i;
const markerName = /^[A-Z][A-Z0-9_]{0,63}$/;
const openingTag = /^<([a-z]+)(?=[\s/>])((?:[^'"<>]|"[^"]*"|'[^']*')*)>/i;
const htmlTokens = /<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|iframe|noembed|noframes)(?=[\s/>])(?:[^'"<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?[a-z][\w:-]*(?:[^'"<>]|"[^"]*"|'[^']*')*>/gi;

function scanTemplate(template) {
  const comments = new Map();
  const references = [];
  const inline = {script: new Set(), style: new Set()};
  for (const token of template.matchAll(htmlTokens)) {
    const text = token[0];
    const range = {from: token.index, to: token.index + text.length};
    if (text.startsWith('<!--')) {
      const key = text.slice(4, -3).trim();
      const matches = comments.get(key) || [];
      matches.push(range);
      comments.set(key, matches);
      continue;
    }
    const opening = text.match(openingTag);
    const tag = opening?.[1].toLowerCase();
    if (tag !== 'script' && tag !== 'style' && tag !== 'link') continue;
    const attrs = new Map();
    for (const attr of opening[2].matchAll(/([^\s="'<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const key = attr[1].toLowerCase();
      if (!attrs.has(key)) attrs.set(key, attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    if (tag === 'link' && !/(^|\s)stylesheet(\s|$)/i.test(attrs.get('rel') || '')) continue;
    const source = attrs.get(tag === 'script' ? 'src' : 'href');
    if (source !== undefined && tag !== 'style') {
      references.push({...range, tag, source, attrs});
    } else if (tag !== 'link') {
      const type = (attrs.get('type') || '').toLowerCase().trim();
      const executable = tag === 'style' ? !type || type === 'text/css'
        : !type || ['module', 'text/javascript', 'application/javascript'].includes(type);
      if (executable) inline[tag].add(text.slice(opening[0].length).replace(/<\/(?:script|style)\s*>$/i, '').trim());
    }
  }
  return {comments, references, inline};
}

function commentSlot(comments, key) {
  const single = comments.get(key) || [];
  const left = comments.get(key + ':START') || [];
  const right = comments.get(key + ':END') || [];
  if (single.length + Number(!!left.length || !!right.length) > 1 || left.length > 1 || right.length > 1) {
    throw Error('Сборка HTML: маркер ' + key + ' встречается несколько раз.');
  }
  if (single.length) return single[0];
  if (!left.length && !right.length) return undefined;
  if (!left.length || !right.length || left[0].to > right[0].from) {
    throw Error('Сборка HTML: проверьте пару маркеров ' + key + ':START и ' + key + ':END.');
  }
  return {from: left[0].from, to: right[0].to};
}

function inlineModule(files, file, attributes = '') {
  if (typeof file !== 'string' || !moduleFile.test(file) || !Object.hasOwn(files, file)) {
    throw Error('Сборка HTML: нет сохранённого JS/CSS-файла ' + file + '.');
  }
  const tag = /\.js$/i.test(file) ? 'script' : 'style';
  const code = files[file];
  if (typeof code !== 'string' || !code.trim()) throw Error('Сборка HTML: пустой файл ' + file + '.');
  if (new RegExp('</' + tag + '(?=[\\s/>]|$)', 'i').test(code)) {
    throw Error('Сборка HTML: ' + file + ' содержит закрывающий тег ' + tag + '.');
  }
  return '<' + tag + attributes + '>\n' + code + '\n</' + tag + '>';
}

function refAttributes({tag, source, attrs}) {
  const preserve = tag === 'script' ? ['type', 'id', 'nonce', 'nomodule'] : ['media', 'id', 'nonce', 'title'];
  const discard = tag === 'script' ? ['src', 'integrity', 'crossorigin', 'referrerpolicy', 'fetchpriority']
    : ['href', 'rel', 'integrity', 'crossorigin', 'referrerpolicy', 'fetchpriority', 'type'];
  if ([...attrs.keys()].some(key => !preserve.includes(key) && !discard.includes(key))) {
    throw Error('Сборка HTML: особые атрибуты подключения ' + source + '. Используйте маркер в шаблоне.');
  }
  if (tag === 'script' && !['', 'module', 'text/javascript', 'application/javascript'].includes((attrs.get('type') || '').toLowerCase().trim())) {
    throw Error('Сборка HTML: неизвестный тип скрипта ' + source + '.');
  }
  if (tag === 'link' && attrs.get('rel').trim().toLowerCase() !== 'stylesheet') {
    throw Error('Сборка HTML: особый тип подключения стилей ' + source + '.');
  }
  return preserve.filter(key => attrs.has(key)).map(key => ' ' + key + '="' +
    attrs.get(key).replace(/"/g, '&quot;') + '"').join('');
}

function assemble(files, template, locations, modules) {
  const {comments, references, inline} = locations;
  const inserts = [];
  const usedFiles = new Set();
  function insert(file, range, attributes) {
    if (usedFiles.has(file)) throw Error('Сборка HTML: файл подключён несколько раз — ' + file + '.');
    inserts.push({...range, content: inlineModule(files, file, attributes)});
    usedFiles.add(file);
  }

  if (modules !== undefined) {
    if (!Array.isArray(modules) || !modules.length) throw Error('Сборка HTML: укажите модули и маркеры.');
    for (const {file, marker} of modules.map(item => item || {})) {
      if (typeof marker !== 'string' || !markerName.test(marker)) throw Error('Сборка HTML: неверное имя маркера.');
      const range = commentSlot(comments, marker);
      if (!range) throw Error('Сборка HTML: маркер ' + marker + ' не найден.');
      insert(file, range);
    }
  }

  for (const [key] of comments) {
    const named = key.match(/^INLINE:\s*([a-zA-Z0-9_./-]+\.(?:js|css))$/i);
    if (named) {
      const range = commentSlot(comments, key);
      insert(named[1], range);
    }
  }
  const covered = inserts.slice();
  for (const ref of references) {
    if (covered.some(range => range.from <= ref.from && range.to >= ref.to)) continue;
    if (/^data:/i.test(ref.source)) continue;
    const file = ref.source.trim().split(/[?#]/, 1)[0].replace(/^\.\/+/, '');
    const extensionMatches = ref.tag === 'script' ? /\.js$/i.test(file) : /\.css$/i.test(file);
    if (!extensionMatches || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(file) || !Object.hasOwn(files, file)) {
      throw Error('Сборка HTML: не удалось встроить подключение ' + (ref.source || 'без пути') + '.');
    }
    insert(file, ref, refAttributes(ref));
  }

  if (modules === undefined) {
    for (const [file, code] of Object.entries(files)) {
      if (!moduleFile.test(file) || usedFiles.has(file)) continue;
      const tag = /\.js$/i.test(file) ? 'script' : 'style';
      if (typeof code === 'string' && code.trim() && inline[tag].has(code.trim())) continue;
      throw Error('Сборка HTML: для ' + file + ' нет однозначного подключения в index.html.');
    }
  }

  let html = '';
  let cursor = 0;
  for (const {from, to, content} of inserts.sort((a, b) => a.from - b.from)) {
    if (from < cursor) throw Error('Сборка HTML: блоки вставки пересекаются.');
    html += template.slice(cursor, from) + content;
    cursor = to;
  }
  return html + template.slice(cursor);
}

export function buildSingleHtml(files, modules) {
  const template = files['index.html'];
  if (typeof template !== 'string' || !template.trim()) throw Error('Сборка HTML: нет шаблона index.html.');
  const locations = scanTemplate(template);
  if (modules === undefined) return assemble(files, template, locations);
  try {
    return assemble(files, template, locations, modules);
  } catch (error) {
    try { return assemble(files, template, locations); }
    catch (fallbackError) { throw Error(error.message + ' ' + fallbackError.message); }
  }
}
