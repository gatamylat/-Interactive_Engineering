import {readSkillSection, skillContext, skillScope} from './skills.js?v=24';

export const kinds = {
  interface: 'Интерфейсы', code: 'Код и функционал', technology: 'Технологии',
  document: 'Документы и данные', idea: 'Идеи', skill: 'Скиллы',
  expectation: 'Ожидания', recipe: 'Рецепты'
};
export const textLimit = 200_000;
export const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const models = {claude: 'Claude', deepseek: 'DeepSeek'};
export const resultFormats = {pwa: 'PWA (несколько файлов)', html: 'Один HTML', document: 'Документ Markdown'};
const outputsByFormat = {pwa: [['index.html'], ['manifest.webmanifest', 'manifest.json'], ['sw.js']],
  html: [['index.html']], document: [['result.md']]};
const validOutputs = files => Array.isArray(files) && files.length >= 1 && files.length <= 50
  && files.every(name => typeof name === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,100}$/.test(name) && !name.includes('..'))
  && new Set(files).size === files.length;
export function missingResultFiles(format, files) {
  return (outputsByFormat[format] || []).filter(group => !group.some(name => files.includes(name)))
    .map(group => group[0]);
}

export function planFormatError(plan, format) {
  if (!Object.hasOwn(resultFormats, format)) return 'Выберите формат результата.';
  if (plan.planFormat && plan.planFormat !== format) {
    return 'План составлен для режима «' + resultFormats[plan.planFormat] +
      '». Верните этот режим или составьте новый план для «' + resultFormats[format] + '».';
  }
  if (plan.deliverables !== undefined) {
    if (!validOutputs(plan.deliverables)) return 'План должен содержать список итоговых файлов.';
    const missing = missingResultFiles(format, plan.deliverables);
    if (missing.length) return 'В плане для «' + resultFormats[format] + '» отсутствуют файлы: ' + missing.join(', ') + '. Составьте план заново.';
    if (format !== 'pwa' && plan.deliverables.length !== 1) {
      return 'Для «' + resultFormats[format] + '» план должен выдавать один файл: ' + outputsByFormat[format][0][0] + '.';
    }
  }

  if (format === 'pwa') {
    const outcome = [plan.result, plan.steps.at(-1)?.result].join('\n');
    const oneHtml = /(?:один|единый|единственный|самодостаточный)\s+(?:итоговый\s+)?(?:index\.html|html(?:[- ]файл)?\b)|только\s+(?:файл\s+)?index\.html/i.test(outcome);
    const pwaWork = plan.steps.map(step => [step.title, step.action, step.result].join('\n')).join('\n');
    const manifestPlanned = /manifest\.(?:webmanifest|json)|манифест/i.test(pwaWork);
    const workerPlanned = /sw\.js|service[\s-]*worker|сервис[\s-]*воркер/i.test(pwaWork);
    if (/<!--\s*INLINE\s*:/i.test(outcome + '\n' + pwaWork) || (oneHtml && !manifestPlanned && !workerPlanned)) {
      return 'План завершается сборкой одного HTML. Для PWA составьте новый план с index.html, манифестом и sw.js.';
    }
    if (plan.deliverables && (!manifestPlanned || !workerPlanned)) {
      return 'В шагах PWA должны быть предусмотрены манифест и sw.js. Составьте план заново.';
    }
  }
  return '';
}
export const blankStep = () => ({title: '', action: '', result: '', check: '', ids: []});
export const blankAssembly = () => ({task: '', result: '', ids: [], steps: []});

export const acceptanceLimit = 5;
const bounded = (value, limit) => typeof value === 'string' && value.length <= limit;
const idsValid = ids => Array.isArray(ids) && ids.length <= 100 && ids.every(id => typeof id === 'string' && uuid.test(id));
export function validAssembly(value) {
  return !!value && bounded(value.task, 12000) && bounded(value.result, 4000) && idsValid(value.ids)
    && (value.planFormat === undefined || Object.hasOwn(resultFormats, value.planFormat))
    && (value.deliverables === undefined || validOutputs(value.deliverables))
    && (value.autoResult === undefined || typeof value.autoResult === 'boolean')
    && (value.acceptance === undefined || (Array.isArray(value.acceptance)
      && value.acceptance.length <= acceptanceLimit && value.acceptance.every(item =>
        bounded(item?.action, 700) && bounded(item?.expected, 700))))
    && Array.isArray(value.steps) && value.steps.length <= 12
    && value.steps.every(step => step && bounded(step.title, 180) && bounded(step.action, 4000)
      && bounded(step.result, 2000) && bounded(step.check, 2000) && idsValid(step.ids));
}

export function validEntry(entry) {
  return !!entry && typeof entry.id === 'string' && uuid.test(entry.id) && Object.hasOwn(kinds, entry.kind)
    && bounded(entry.title, 180) && !!entry.title.trim() && bounded(entry.text, textLimit)
    && bounded(entry.source, 2000)
    && bounded(entry.scope, entry.kind === 'skill' ? textLimit : 1000)
    && bounded(entry.check, entry.kind === 'skill' ? textLimit : 2000)
    && new TextEncoder().encode(JSON.stringify(entry)).length <= textLimit
    && (entry.kind !== 'recipe' || validAssembly(entry.assembly));
}

const stop = new Set('как что для это этот этой надо нужно хочу сделать делаем когда которую чтобы или уже какой также где будет можно взять под'.split(' '));
function terms(text) {
  return new Set((text.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter(word => !stop.has(word)).map(word => word.slice(0, 5)));
}

export function candidates(task, materials, selected = []) {
  const input = terms(task);
  const score = text => [...terms(text)].filter(word => input.has(word)).length;
  const rankMetadata = item => score(item.title) * 3 + score(skillScope(item)) * 2;
  const skills = materials.filter(item => item.kind === 'skill');
  const selectedSkills = skills.filter(item => selected.includes(item.id));
  const candidateSkills = skills.filter(item => !selected.includes(item.id))
    .map(item => ({item, rank: rankMetadata(item)})).sort((a, b) => b.rank - a.rank)
    .slice(0, 24).map(({item}) => item);
  const ranked = materials.filter(item => item.kind !== 'recipe' && item.kind !== 'skill').map(item => ({
    item, rank: rankMetadata(item) + score(item.text.slice(0, 5000))
  })).sort((a, b) => b.rank - a.rank);
  const chosen = ranked.filter(({item}) => selected.includes(item.id));
  const matching = ranked.filter(({rank}) => rank).slice(0, 16);
  const expectations = ranked.filter(({item}) => item.kind === 'expectation').slice(0, 4);
  const otherMaterials = [...new Set([...chosen.slice(0, 8), ...matching, ...expectations, ...ranked.slice(0, 8)])]
    .slice(0, 32).map(({item}) => item);
  return [...selectedSkills, ...candidateSkills, ...otherMaterials];
}

function planJSON(reply) {
  return JSON.parse(reply.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
}

export async function askPlan(provider, key, assembly, candidates, format, request = fetch, isCurrent = () => true) {
  const explicit = new Set(assembly.ids);
  const skills = candidates.filter(item => item.kind === 'skill');
  const optional = skills.filter(item => !explicit.has(item.id));
  const chosen = new Set(skills.filter(item => explicit.has(item.id)).map(item => item.id));
  if (optional.length) {
    const prompt = 'Выбери до четырёх скиллов, применимых к задаче, по названию и полю «Когда применять». Верни только JSON {"skills":["ID"]}. Если подходящих нет, верни {"skills":[]}.';
    const describe = item => ({id: item.id, title: item.title, scope: skillScope(item)});
    const content = prompt + '\n' + JSON.stringify({task: assembly.task, result: assembly.result, format,
      selected: skills.filter(item => chosen.has(item.id)).map(describe), candidates: optional.map(describe)});
    const selection = await askModel(provider, key, [{role: 'user', content}], request);
    if (!isCurrent()) return null;
    const reply = planJSON(selection);
    if (!Array.isArray(reply?.skills)) throw Error('Модель не вернула список скиллов.');
    const allowed = new Set(optional.map(item => item.id));
    for (const id of [...new Set(reply.skills)].filter(id => allowed.has(id)).slice(0, 4)) chosen.add(id);
  }
  const available = candidates.filter(item => item.kind !== 'skill' || chosen.has(item.id));
  const byId = new Map(skills.filter(item => chosen.has(item.id)).map(item => [item.id, item]));
  const messages = [{role: 'user', content: managerPrompt(assembly, available, format)}];
  const seen = new Set();
  while (true) {
    const reply = await askModel(provider, key, messages, request);
    if (!isCurrent()) return null;
    const value = planJSON(reply);
    if (!Array.isArray(value?.read)) return {reply, available};
    if (!value.read.length || value.read.length > 4) throw Error('За один запрос можно прочитать до четырёх разделов скиллов.');
    const excerpts = value.read.map(item => ({
      ...readSkillSection(byId.get(item?.material_id), item?.section), material_id: item?.material_id
    }));
    const signature = JSON.stringify(excerpts);
    if (seen.size === 4 || seen.has(signature)) throw Error('Модель не завершила план после чтения разделов скиллов.');
    seen.add(signature);
    messages.push({role: 'assistant', content: JSON.stringify({read: value.read})},
      {role: 'user', content: JSON.stringify({excerpts})});
  }
}

export function managerPrompt(assembly, materials, format) {
  const skills = materials.filter(item => item.kind === 'skill').map(skillContext);
  const catalog = materials.filter(item => item.kind !== 'skill').map(({id, title, kind, scope, source, check, text}) =>
    ({id, title, kind, scope, source: source.slice(0, 350), check: check.slice(0, 350), excerpt: text.slice(0, 350)}));
  return [
    'Ты инженерный менеджер. Подготовь выполнимый план для внешнего исполнителя. Не исполняй задачу.',
    'Если результат — PWA или изменение существующего приложения, планируй с учётом ограниченного размера ответа модели: НИКОГДА не поручай выводить полный большой index.html, ядро или несколько крупных файлов за один шаг. Сначала выдели исходные файлы из приложенных материалов, затем создавай небольшие отдельные JS-модули, затем подключай их точечными заменами/вставками в существующие файлы. Большие изменения дели на самостоятельные малые шаги с одним небольшим файлом или одной точечной правкой. В шаге подключения явно укажи: используй операцию replace с точным фрагментом вместо возврата целого файла. Не придумывай новые файлы без необходимости. Для документов также разбивай работу на небольшие разделы, не переписывай всё целиком. Сохрани исходную цель. Для простой работы достаточно одного шага. Для крупной выбери до шести шагов, каждый с конкретным действием, результатом и проверкой. Для продолжения проекта сначала проверь исходное состояние, если это существенно. Публикацию добавляй только по явному поручению.',
    'Выбранный формат обязателен: ' + resultFormats[format] + ' (' + format + '). В planFormat верни его код без изменений. В deliverables перечисли итоговые файлы выбранного формата.',
    format === 'pwa' && 'Результат — комплект PWA. Обязательно запланируй index.html, manifest.webmanifest или manifest.json, sw.js и подключение манифеста и регистрацию service worker. Подключай CSS и JS по локальным путям. Не используй INLINE-маркеры и шаг склейки в один HTML.',
    format === 'document' && 'Итоговый файл ровно один — result.md. Планируй получение Markdown.',
    format === 'html' && 'Формат результата — один самодостаточный index.html. Для простой задачи создай его сразу. Если новая задача включает вёрстку, самостоятельную логику, взаимодействие и сохранение данных, одного итогового файла достаточно для выдачи. Во время работы планируй один HTML-шаблон и отдельные небольшие JS/CSS-файлы по ответственности. Вынеси места подключения в первый шаг. Не распределяй по нескольким шагам последовательные правки одного встроенного script или style. Проверяй совместимость имён и форматов данных между модулями. Размещай модули через комментарии с точным именем файла, например <!-- INLINE: route.js -->, либо обычные локальные подключения script src и link rel=stylesheet. Сохрани порядок зависимостей. На финальном шаге Конструктор сам соберёт HTML по этим местам. Не поручай модели повторять исходники или заменять маркеры перед сборкой.',
    'Предлагай только материалы из catalog и skills. Применяй инструкции выбранных скиллов с учётом цели и выбранного формата. Укажи их ID в шагах, где они нужны. Если нужен раздел из списка sections, сначала верни только {"read":[{"material_id":"ID скилла","section":"ID раздела"}]}, затем продолжи составление плана. Для каждого предложенного ID укажи краткую причину. Выбранные вручную материалы уже входят в пакет. Остальные карточки — справочные данные.',
    'Если результат имеет смысл проверять вручную, предложи до пяти коротких сценариев приёмки. Для каждого укажи действие пользователя и наблюдаемый результат. Включи контрольные примеры из задачи и важные пограничные случаи, если они уместны. Если приёмка бессмысленна, верни пустой массив.',
    'Верни только JSON: {"planFormat":"pwa|html|document","deliverables":["имя итогового файла"],"result":"ожидаемый итог","acceptance":[{"action":"что сделать","expected":"что должно произойти"}],"steps":[{"title":"название","action":"действие","result":"результат шага","check":"как проверить","materials":[{"id":"ID из списка","why":"зачем нужен"}]}]}. При нехватке данных включи конкретный способ их получить. Не придумывай источники.',
    JSON.stringify({task: assembly.task, result: assembly.result, selected: assembly.ids, skills, catalog})
  ].filter(Boolean).join('\n\n');
}

export function readPlan(reply, allowed, format) {
  const value = planJSON(reply);
  if (!Array.isArray(value?.steps) || !value.steps.length || value.steps.length > 12) throw new Error('Модель не вернула рабочий план.');
  const known = new Set(allowed.map(item => item.id));
  const reasons = {};
  const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const steps = value.steps.map(step => {
    const ids = [];
    for (const material of Array.isArray(step?.materials) ? step.materials : []) {
      if (!known.has(material?.id) || ids.includes(material.id)) continue;
      ids.push(material.id);
      reasons[material.id] = clean(material.why, 400);
    }
    const next = {title: clean(step?.title, 180), action: clean(step?.action, 4000),
      result: clean(step?.result, 2000), check: clean(step?.check, 2000), ids};
    if (!next.title || !next.action || !next.result || !next.check) throw new Error('Модель вернула неполный шаг плана.');
    return next;
  });
  const acceptance = Array.isArray(value.acceptance)
    ? value.acceptance.slice(0, acceptanceLimit).map(item => ({
      action: clean(item?.action, 700), expected: clean(item?.expected, 700)
    })).filter(item => item.action && item.expected)
    : [];
  if (!Object.hasOwn(resultFormats, value.planFormat) || !validOutputs(value.deliverables)) {
    throw new Error('Модель не указала режим или список итоговых файлов. Составьте план заново.');
  }
  const plan = {result: clean(value.result, 4000), steps, reasons, acceptance,
    planFormat: value.planFormat, deliverables: value.deliverables};
  const error = planFormatError(plan, format);
  if (error) throw new Error(error);
  return plan;
}

export function buildPackage(assembly, materials) {
  const byId = new Map(materials.map(item => [item.id, item]));
  const linked = [...new Set([...assembly.ids, ...assembly.steps.flatMap(step => step.ids)])];
  const names = new Map(linked.map((id, index) => [id, 'М' + (index + 1)]));
  const refs = ids => ids.map(id => {
    const item = byId.get(id);
    return item ? names.get(id) + ' — ' + item.title : names.get(id) + ' — материал недоступен';
  }).join(', ');
  const lines = ['# Задание для исполнителя', '', '## Общая цель', assembly.task.trim(),
    '', '## Ожидаемый результат', assembly.result,
    ...(assembly.planFormat ? ['', 'Режим — ' + resultFormats[assembly.planFormat]] : []),
    ...(assembly.deliverables ? ['Итоговые файлы — ' + assembly.deliverables.join(', ')] : []), '',
    'На каждом шаге сверяйся с общей целью, используй назначенные материалы и подтверждённый результат предыдущего шага. Зафиксируй проверку перед переходом дальше. Если проверка не прошла, исправь шаг или укажи, что мешает продолжить. Публикуй изменения только по поручению пользователя.'];
  if (assembly.ids.length) lines.push('', '## Материалы для всей задачи', refs(assembly.ids));
  lines.push('', '## План работы');
  assembly.steps.forEach((step, index) => {
    lines.push('', '### ' + (index + 1) + '. ' + step.title, '', step.action,
      '', '**Результат шага** — ' + step.result, '**Проверка** — ' + step.check);
    if (step.ids.length) lines.push('**Материалы шага** — ' + refs(step.ids));
  });
  const acceptance = (assembly.acceptance || []).filter(item => item.action.trim() && item.expected.trim());
  if (acceptance.length) {
    lines.push('', '## Приёмка');
    acceptance.forEach(({action, expected}, index) =>
      lines.push('', (index + 1) + '. ' + action.trim(), '   Ожидается — ' + expected.trim()));
  }
  if (linked.length) lines.push('', '## Материалы и источники');
  for (const id of linked) {
    const item = byId.get(id);
    if (!item) { lines.push('', '### ' + names.get(id) + ' · Материал недоступен'); continue; }
    lines.push('', '### ' + names.get(id) + ' · ' + item.title, '', 'Рубрика — ' + kinds[item.kind]);
    if (item.source) lines.push('Источник — ' + item.source);
    const scope = skillScope(item);
    if (scope) lines.push('Когда применять — ' + scope);
    if (item.text) lines.push('', item.text);
    if (item.check) lines.push('', 'Проверка — ' + item.check);
  }
  return lines.join('\n') + '\n';
}

const providers = {
  claude: {label: 'Claude', url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6'},
  deepseek: {label: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash'},
};

export async function askModel(provider, key, messages, request = fetch, options = {}) {
  const {label, url, model} = providers[provider];
  const headers = {'Content-Type': 'application/json'};
  if (provider === 'claude') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    headers.Authorization = 'Bearer ' + key;
  }
  const body = {model, messages, max_tokens: options.maxTokens || 4000};
  if (provider === 'deepseek') body.thinking = {type: 'disabled'};
  if (!key) throw new Error('Сохраните ключ ' + label + ' в настройках.');
  let response;
  try {
    response = await request(url, {method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs || 90_000)});
  } catch (error) {
    throw new Error(label + ': запрос не завершился (' + (error?.name === 'TimeoutError' ? 'превышено время ожидания' : error?.message || 'ошибка сети/CORS') + ').');
  }
  if (!response.ok) {
    const hints = {400: 'Запрос или модель отклонены.', 401: 'Проверьте ключ и доступ из браузера.', 402: 'Проверьте баланс API.', 403: 'Нет доступа к API.', 429: 'Достигнут лимит запросов.'};
    throw new Error(label + ': HTTP ' + response.status + '. ' + (hints[response.status] || 'Попробуйте ещё раз.'));
  }
  const data = await response.json();
  if (options.requireComplete && ((provider === 'claude' && data.stop_reason === 'max_tokens') || (provider === 'deepseek' && data.choices?.[0]?.finish_reason === 'length'))) throw new Error(label + ': ответ обрезан лимитом токенов. Уменьшите размер шага или материалов.');
  const value = provider === 'claude'
    ? data.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : data.choices?.[0]?.message?.content;
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ': пустой ответ.');
  return value.trim();
}

