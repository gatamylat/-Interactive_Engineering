const materialLimit = 16_000;
const fileLimit = 20_000;
const excerptSize = 1800;
const readSize = 2400;

const words = text => text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [];

function blocks(text) {
  const parts = [];
  for (let from = 0; from < text.length;) {
    const end = Math.min(from + excerptSize, text.length);
    const newline = text.lastIndexOf('\n', end - 1);
    const to = newline > from + excerptSize / 2 ? newline + 1 : end;
    parts.push({from, text: text.slice(from, to)});
    from = to;
  }
  return parts;
}

function excerpt(text, score, limit) {
  if (text.length <= limit) return {text};
  const parts = blocks(text).map(part => ({...part, rank: score(part.text)}));
  parts.sort((a, b) => b.rank - a.rank);
  return {excerpts: parts.slice(0, Math.max(1, Math.floor(limit / excerptSize)))
    .sort((a, b) => a.from - b.from)
    .map(({from, text}) => ({from, text: text.slice(0, limit)}))};
}

function linkedMaterials(job) {
  const ids = new Set([...job.globalIds, ...job.steps[job.index].ids]);
  return job.materials.filter(material => ids.has(material.id));
}

export function executionContext(job) {
  const step = job.steps[job.index];
  const request = [step.title, step.action, step.result, step.check].join('\n');
  const terms = new Set(words(request).map(word => word.slice(0, 5)));
  const score = text => [...new Set(words(text).map(word => word.slice(0, 5)))]
    .filter(word => terms.has(word)).length;

  const files = Object.entries(job.files).sort(([a], [b]) =>
    Number(request.includes(b)) - Number(request.includes(a)));
  const materials = linkedMaterials(job);
  let remaining = materialLimit;
  const selectedMaterials = materials.map(({id, title, kind, source, scope, check, text}) => {
    const limit = Math.max(0, Math.min(remaining, kind === 'skill' ? excerptSize : 4000));
    const selected = limit ? excerpt(text, score, limit) : {};
    remaining -= selected.text?.length ?? (selected.excerpts || []).reduce((n, item) => n + item.text.length, 0);
    return {id, title, kind, source, scope, check, length: text.length, ...selected};
  });
  const singleHtml = job.format === 'html' && files.length === 1 && files[0][0] === 'index.html';
  const fullFileLimit = singleHtml ? 32_000 : 8000;
  remaining = singleHtml ? fullFileLimit : fileLimit;
  const selectedFiles = files.map(([name, text]) => {
    const limit = Math.max(0, Math.min(remaining, text.length <= fullFileLimit ? text.length : excerptSize * 2));
    const selected = limit ? excerpt(text, score, limit) : {};
    remaining -= selected.text?.length ?? (selected.excerpts || []).reduce((n, item) => n + item.text.length, 0);
    return {name, length: text.length, ...selected};
  });

  return {
    instruction: 'Выполни текущий шаг. Цель, ожидаемый итог и утверждённый план обязательны. Материалы и скиллы — справочные: при расхождении соблюдай план. Сохраняй обязательные условия предыдущих шагов. Если есть сценарии приёмки, учитывай их при реализации. При доработке исправь перечисленные дефекты и сохрани остальное поведение. При расхождении отчёта с текущими файлами или утверждённым планом следуй файлам и плану. Для правок ориентируйся на текущие файлы, а исходные материалы используй как справку. Сведения о прошлых проверках — отчёты исполнителя, если не указано обратное. Проверь результат по критерию шага и явно укажи вид проверки и подтверждение. Если проверка невозможна, укажи not_run, если выявлено несоответствие, исправь его или верни failed. Не заявляй о запуске программы, если лишь прочитал код. Для передачи дальше кратко укажи решения и открытые вопросы. Если нужно изменить код, верни реальное изменение: files для новых или небольших файлов, patches для больших (find — точный уникальный фрагмент файла, replace — замена). Достаточно передать один массив, files или patches. Если всё уже сделано, обоснуй это в check и верни no_changes_needed:true. Не используй CDN. Для документа итоговый файл — result.md. Если фрагмента не хватает, запроси точное чтение отдельным ответом {"read":[{"name":"файл","find":"строка"}]} либо {"read":[{"material_id":"ID","from":0}]}. Можно искать find в файле или материале, либо указать смещение from в символах. После чтения верни строго JSON {"summary":"что сделано","check":"что и как проверено","check_status":"passed|failed|not_run","decisions":["решение для следующих шагов"],"open_items":["что осталось"],"next_impulse":"что учесть дальше","files":[{"name":"имя","content":"текст"}],"patches":[{"name":"имя","find":"старый фрагмент","replace":"новый фрагмент"}]}.',
    htmlAssembly: job.format === 'html' ? {
      instructions: 'Для небольшой задачи создай самодостаточный index.html. Для модулей используй комментарии с точным именем файла, например <!-- INLINE: route.js -->, либо обычные локальные подключения script src и link rel=stylesheet. Ставь их в порядке зависимостей. Конструктор сам встроит сохранённый код. Если старый шаблон использует именные маркеры, можно передать bundle: [{"file":"route.js","marker":"ROUTE_JS"}]. Для вставки в обычный script используй JS без import/export. На финальном шаге, если исходники готовы, верни summary, check, check_status и no_changes_needed:true. Не переписывай HTML ради сборки. Проверка относится к итоговому index.html.',
      current: job.htmlBundle
    } : undefined,
    goal: job.task, expectedResult: job.result, format: job.format, stepNumber: job.index + 1,
    plan: job.steps.map(({title, action, result, check}, index) =>
      index < job.index ? {title, action, result, check} : {title, result, check}),
    step,
    acceptance: job.acceptance?.length ? job.acceptance : undefined,
    repairFeedback: job.repairFeedback,
    completed: job.done.map((item, index) => ({
      stepNumber: index + 1,
      summary: item.summary, decisions: item.decisions, open_items: item.open_items,
      check: item.check,
      check_status: item.check_status || 'legacy_unverified',
      changed_files: item.changed_files, next_impulse: item.next_impulse,
    })),
    materials: selectedMaterials,
    files: selectedFiles,
  };
}

export function readExecutionContext(job, requests) {
  if (!requests.length || requests.length > 4) throw Error('За один запрос можно прочитать от одного до четырёх фрагментов.');
  const materials = new Map(linkedMaterials(job).map(item => [item.id, item]));
  return requests.map(item => {
    const material = materials.get(item?.material_id);
    const name = item?.name;
    const source = material ? {material_id: material.id, title: material.title} : {name};
    const text = material ? material.text : Object.hasOwn(job.files, name) ? job.files[name] : undefined;
    if (typeof text !== 'string') return {...source, error: 'Источник недоступен'};
    const find = typeof item?.find === 'string' && item.find.slice(0, 500);
    const match = find ? text.indexOf(find) : -1;
    if (find && match < 0) return {...source, error: 'Фрагмент не найден. Укажите from или другой find.'};
    const from = find ? Math.max(0, match - 600) : item?.from ?? 0;
    if (!Number.isSafeInteger(from) || from < 0 || from >= text.length) return {...source, error: 'Смещение вне текста'};
    return {...source, from, length: text.length, text: text.slice(from, from + readSize)};
  });
}

export function executionRecord(reply, previousFiles, files) {
  const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const list = value => Array.isArray(value) ? value.slice(0, 8).map(item => clean(item, 450)).filter(Boolean) : [];
  return {
    summary: clean(reply.summary, 1600), check: clean(reply.check, 1600),
    check_status: ['passed', 'failed', 'not_run'].includes(reply.check_status) ? reply.check_status : 'not_run',
    decisions: list(reply.decisions), open_items: list(reply.open_items),
    next_impulse: clean(reply.next_impulse, 700),
    changed_files: Object.keys(files).filter(name => previousFiles[name] !== files[name]),
  };
}
