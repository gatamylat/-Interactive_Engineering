import {acceptanceLimit, askModel, blankAssembly, blankStep, buildPackage, candidates, kinds, managerPrompt, models,
  readPlan, textLimit, validAssembly, validEntry} from './modules/core.js?v=18';
import {change, edit, entries, read} from './modules/library.js';
import {cloudIdentity, connectSync} from './modules/sync.js';
import {executionContext, executionRecord, readExecutionContext} from './modules/execution-context.js?v=18';
import {buildSingleHtml} from './modules/single-html.js?v=18';

const $ = id => document.getElementById(id);
const status = (id, value) => { $(id).textContent = value; };
const prefix = 'interactive-engineering:';
const get = key => localStorage.getItem(prefix + key) ?? '';
const set = (key, value) => localStorage.setItem(prefix + key, value);
let profile = 'local';
let state;
let assembly = blankAssembly();
let reasons = {};
let recipeId;
let recipeRev;
let editing;
let connection;
let connecting = false;
let planning = false;

const exId = $;
const exStore = 'interactive-engineering:executor-v1';
let exJob = null, exBusy = false, exPause = false, exFixing = false;
let exNoticeTimer;
try { exJob = JSON.parse(localStorage.getItem(exStore) || 'null'); } catch {}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, action, className) {
  const element = node('button', label, className);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

const materials = () => state ? entries(state).filter(item => item.kind !== 'recipe') : [];
const byTitle = (a, b) => a.title.localeCompare(b.title, 'ru');
const itemById = id => state?.library[id]?.entry;

function planReady() {
  return !!assembly.task.trim() && !!assembly.result.trim() && assembly.steps.length > 0
    && assembly.steps.every(step => [step.title, step.action, step.result, step.check].every(value => value.trim()));
}

function updatePackage() {
  const ready = planReady();
  if ($('package').closest('details').open) $('package').value = ready ? buildPackage(assembly, materials()) : '';
  $('copy').disabled = !ready;
  $('download').disabled = !ready;
  $('save-recipe').disabled = !state || !assembly.task.trim();
  $('plan').disabled = planning || !state || !assembly.task.trim() || !$('model').value;
  exUpdateControls(ready);
}

function persistDraft() {
  try { set('draft-' + profile, JSON.stringify({assembly, recipeId, recipeRev, reasons})); }
  catch { status('package-status', 'Черновик не удалось сохранить на устройстве. Скопируйте или сохраните сборку.'); }
  updatePackage();
}

function loadDraft() {
  let draft;
  try { draft = JSON.parse(get('draft-' + profile)); } catch { /* An empty draft starts a new assembly. */ }
  assembly = validAssembly(draft?.assembly) ? draft.assembly : blankAssembly();
  recipeId = draft?.recipeId;
  recipeRev = draft?.recipeRev;
  reasons = draft?.reasons ?? {};
  renderAssembly();
}

function toggleId(ids, id, checked) {
  if (checked) {
    if (!ids.includes(id) && ids.length < 100) ids.push(id);
  } else {
    const index = ids.indexOf(id);
    if (index !== -1) ids.splice(index, 1);
  }
}

function renderSelected() {
  const list = $('selected');
  list.replaceChildren();
  const ids = [...new Set([...assembly.ids, ...assembly.steps.flatMap(step => step.ids)])];
  if (!ids.length) list.append(node('p', 'Добавьте материалы вручную или попросите ИИ составить план.'));
  for (const id of ids) {
    const item = itemById(id);
    const card = node('article', '', 'selected-item');
    card.append(node('strong', item?.title ?? 'Материал недоступен'), node('p',
      [kinds[item?.kind], reasons[id] || item?.scope, item?.source].filter(Boolean).join(' · ')));
    const actions = node('div', '', 'row');
    if (item) actions.append(button('Открыть', () => { showLibrary(item.kind); openEditor(item); }));
    actions.append(button('Убрать', () => {
      toggleId(assembly.ids, id, false);
      for (const step of assembly.steps) toggleId(step.ids, id, false);
      delete reasons[id];
      persistDraft();
      renderSelected();
      renderSteps();
    }));
    card.append(actions);
    list.append(card);
  }
}

function stepField(step, key, label, limit, multiline) {
  const wrapper = node('label');
  const caption = node('span', label, 'required-caption');
  const mark = node('span', '*', 'required-mark');
  mark.setAttribute('aria-hidden', 'true');
  caption.append(mark);
  const input = node(multiline ? 'textarea' : 'input');
  input.setAttribute('aria-required', 'true');
  if (multiline) input.rows = 2;
  input.maxLength = limit;
  input.value = step[key];
  input.addEventListener('input', () => { step[key] = input.value; persistDraft(); });
  wrapper.append(caption, input);
  return wrapper;
}

function renderSteps() {
  const list = $('steps');
  list.replaceChildren();
  if (!assembly.steps.length) list.append(node('p', 'Здесь появятся шаги с результатом и проверкой.'));
  const items = new Map(materials().map(item => [item.id, item]));
  const ids = [...new Set([...assembly.ids, ...assembly.steps.flatMap(step => step.ids)])];
  assembly.steps.forEach((step, index) => {
    const card = node('section', '', 'step');
    const head = node('div', '', 'panel-head');
    head.append(node('h3', 'Шаг ' + (index + 1)), button('Удалить шаг', () => {
      assembly.steps.splice(index, 1);
      persistDraft();
      renderSteps();
      renderSelected();
    }));
    const fields = node('div', '', 'step-fields');
    fields.append(stepField(step, 'result', 'Результат шага', 2000, true), stepField(step, 'check', 'Как проверить', 2000, true));
    card.append(head, stepField(step, 'title', 'Название шага', 180, false),
      stepField(step, 'action', 'Что сделать', 4000, true), fields);
    if (ids.length) {
      const links = node('details', '', 'step-materials');
      const summary = node('summary', 'Материалы шага (' + step.ids.length + ')');
      links.append(summary);
      for (const id of ids) {
        const label = node('label');
        const checkbox = node('input');
        checkbox.type = 'checkbox';
        checkbox.checked = step.ids.includes(id);
        checkbox.addEventListener('change', () => {
          toggleId(step.ids, id, checkbox.checked);
          checkbox.checked = step.ids.includes(id);
          summary.textContent = 'Материалы шага (' + step.ids.length + ')';
          persistDraft();
        });
        label.append(checkbox, items.get(id)?.title ?? 'Материал недоступен');
        links.append(label);
      }
      card.append(links);
    }
    list.append(card);
  });
  $('acceptance-plan').hidden = assembly.steps.length === 0;
  const atLimit = assembly.steps.length >= 12;
  $('add-step').disabled = atLimit;
  $('add-step-bottom').disabled = atLimit;
  $('add-step-bottom').hidden = assembly.steps.length === 0;
}

function acceptanceCases() {
  return (assembly.acceptance || []).map(({action, expected}) => ({action: action.trim(), expected: expected.trim()}))
    .filter(item => item.action && item.expected);
}

function renderAcceptanceDraft() {
  const list = $('acceptance-draft');
  list.replaceChildren();
  const cases = assembly.acceptance || [];
  cases.forEach((item, index) => {
    const card = node('div', '', 'step');
    const head = node('div', '', 'panel-head');
    head.append(node('strong', 'Сценарий ' + (index + 1)), button('Убрать', () => {
      cases.splice(index, 1);
      persistDraft();
      renderAcceptanceDraft();
    }));
    card.append(head);
    for (const [key, title] of [['action', 'Что сделать'], ['expected', 'Ожидаемый результат']]) {
      const label = node('label', title);
      const field = node('textarea');
      field.rows = 2;
      field.maxLength = 700;
      field.value = item[key];
      field.addEventListener('input', () => { item[key] = field.value; persistDraft(); });
      label.append(field);
      card.append(label);
    }
    list.append(card);
  });
  $('acceptance-add').disabled = cases.length >= acceptanceLimit;
}

$('acceptance-add').addEventListener('click', () => {
  assembly.acceptance ||= [];
  if (assembly.acceptance.length >= acceptanceLimit) return;
  assembly.acceptance.push({action: '', expected: ''});
  persistDraft();
  renderAcceptanceDraft();
  $('acceptance-draft').lastElementChild.querySelector('textarea').focus();
});

function renderAssembly() {
  $('task').value = assembly.task;
  $('result').value = assembly.result;
  renderSelected();
  renderSteps();
  renderAcceptanceDraft();
  updatePackage();
}

async function refresh() {
  const current = profile;
  const loaded = await read(current);
  const previous = state;
  if (current !== profile) return;
  state = loaded;
  const ids = Object.keys(loaded.library);
  if (previous && ids.length === Object.keys(previous.library).length
      && ids.every(id => loaded.library[id].rev === previous.library[id]?.rev)) return;
  renderLibrary();
  renderSelected();
  renderSteps();
  updatePackage();
}

async function save(update) {
  const target = profile;
  const updated = await change(target, update);
  if (target !== profile) return false;
  state = updated;
  renderLibrary();
  renderSelected();
  renderSteps();
  updatePackage();
  connection?.schedule();
  return true;
}

for (const [input, key] of [['task', 'task'], ['result', 'result']]) {
  $(input).addEventListener('input', () => { assembly[key] = $(input).value; persistDraft(); });
}
function updateModelOptions() {
  const select = $('model');
  const preferred = get('model') === 'deepseek' ? 'deepseek' : 'claude';
  for (const option of select.options) {
    if (!option.value) continue;
    option.disabled = !get('key-' + option.value).trim();
    option.textContent = models[option.value] + (option.disabled ? ' — нет ключа' : '');
  }
  const available = [...select.options].filter(option => option.value && !option.disabled);
  select.value = available.find(option => option.value === preferred)?.value ?? available[0]?.value ?? '';
  $('model-key-hint').hidden = available.length > 0;
}

updateModelOptions();
$('model').addEventListener('change', () => { set('model', $('model').value); updatePackage(); });
function addStep() {
  if (assembly.steps.length >= 12) return;
  assembly.steps.push(blankStep());
  persistDraft();
  renderSteps();
  $('steps').lastElementChild.querySelector('input').focus();
}
$('add-step').addEventListener('click', addStep);
$('add-step-bottom').addEventListener('click', addStep);

$('assembly').addEventListener('submit', async event => {
  event.preventDefault();
  if (planning || !state || !assembly.task.trim() || !$('model').value) return;
  const chosenModel = $('model').value;
  const key = get('key-' + chosenModel);
  if (!key) {
    status('plan-status', 'Сохраните ключ ' + models[chosenModel] + ' в настройках или добавьте шаги вручную.');
    return;
  }
  if (assembly.steps.length && !confirm('Заменить текущие шаги новым планом?')) return;
  const current = profile;
  const original = JSON.stringify(assembly);
  const available = candidates([assembly.task, assembly.result].join(' '), materials(), assembly.ids);
  const prompt = managerPrompt(assembly, available, $('exec-format').value);
  planning = true;
  updatePackage();
  status('plan-status', models[chosenModel] + ' составляет план…');
  try {
    const reply = await askModel(chosenModel, key, [{role: 'user', content: prompt}]);
    if (profile !== current || JSON.stringify(assembly) !== original) {
      status('plan-status', 'Сборка изменилась во время запроса. Составьте план для текущей задачи.');
      return;
    }
    const proposed = readPlan(reply, available);
    assembly.result ||= proposed.result;
    assembly.steps = proposed.steps;
    assembly.acceptance = proposed.acceptance;
    $('acceptance-plan').open = proposed.acceptance.length > 0;
    reasons = proposed.reasons;
    persistDraft();
    renderAssembly();
    status('plan-status', 'План готов. Проверьте шаги и материалы перед передачей.');
  } catch (error) {
    status('plan-status', error instanceof SyntaxError ? 'Модель вернула план в неверном формате. Попробуйте ещё раз.' : error.message);
  } finally {
    planning = false;
    updatePackage();
  }
});

function readyPackage() {
  return buildPackage(assembly, materials());
}

$('package').closest('details').addEventListener('toggle', updatePackage);

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(readyPackage());
    status('package-status', 'Пакет скопирован.');
  } catch {
    const field = $('package');
    field.value = readyPackage();
    field.closest('details').open = true;
    field.focus();
    field.select();
    status('package-status', 'Скопируйте выделенный текст.');
  }
});
$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([readyPackage()], {type: 'text/markdown;charset=utf-8'}));
  const link = node('a');
  link.href = url;
  link.download = 'engineering-package.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('save-recipe').addEventListener('click', async () => {
  const draft = assembly;
  const id = recipeId ?? crypto.randomUUID();
  const entry = {id, kind: 'recipe', title: assembly.task.trim().split('\n')[0].slice(0, 180),
    text: '', source: '', scope: '', check: '', assembly: structuredClone(assembly), reasons: {...reasons}};
  try {
    let copied;
    if (!(await save(s => { copied = edit(s, entry, id, recipeRev ?? null); }))) return;
    if (assembly !== draft) return;
    if (!copied) { recipeId = id; recipeRev = state.library[id].rev; }
    persistDraft();
    status('package-status', copied ? 'Сборка сохранена отдельной копией в «Рецептах».' : 'Сборка сохранена в «Рецептах».');
  } catch (error) { status('package-status', error.message); }
});
$('new-assembly').addEventListener('click', () => {
  if ((assembly.task || assembly.steps.length || assembly.ids.length) && !confirm('Начать новую сборку? Текущий черновик будет заменён.')) return;
  assembly = blankAssembly();
  recipeId = undefined;
  recipeRev = undefined;
  reasons = {};
  persistDraft();
  renderAssembly();
  status('plan-status', '');
  status('package-status', '');
  $('task').focus();
});

for (const [kind, label] of Object.entries(kinds)) {
  $('kind-filter').add(new Option(label, kind));
  if (kind !== 'recipe') $('entry-kind').add(new Option(label, kind));
}

function renderLibrary() {
  const list = $('items');
  list.replaceChildren();
  if (!state) return;
  const kind = $('kind-filter').value;
  const query = $('search').value.trim().toLowerCase();
  const items = entries(state).filter(item => (!kind || item.kind === kind)
    && (!query || [item.title, item.scope, item.source, item.text].some(text => text.toLowerCase().includes(query)))).sort(byTitle);
  $('files').disabled = kind === 'recipe' || kind === 'expectation';
  if (!items.length) list.append(node('p', query ? 'Ничего не найдено.' : 'В этой рубрике пока нет записей.'));
  for (const item of items) {
    const card = node('article', '', 'item');
    card.append(node('strong', item.title), node('p', [kinds[item.kind], item.scope, item.source].filter(Boolean).join(' · ')));
    const actions = node('div', '', 'row');
    if (item.kind === 'recipe') {
      actions.append(button('Открыть сборку', () => loadRecipe(item)), button('Удалить', () => removeEntry(item.id, state.library[item.id]?.rev, item.title), 'danger'));
    } else {
      const picked = assembly.ids.includes(item.id);
      actions.append(button(picked ? 'Убрать из сборки' : 'В сборку', () => {
        toggleId(assembly.ids, item.id, !picked);
        persistDraft();
        renderSelected();
        renderSteps();
        renderLibrary();
      }), button('Открыть', () => openEditor(item)));
    }
    card.append(actions);
    list.append(card);
  }
}

function loadRecipe(item) {
  if ((assembly.task || assembly.steps.length || assembly.ids.length) && !confirm('Открыть сохранённую сборку вместо текущего черновика?')) return;
  assembly = structuredClone(item.assembly);
  recipeId = item.id;
  recipeRev = state.library[item.id].rev;
  reasons = item.reasons ?? {};
  persistDraft();
  renderAssembly();
  $('library').close();
  status('plan-status', '');
  status('package-status', '');
}

function openEditor(item) {
  editing = item ? {id: item.id, rev: state.library[item.id]?.rev, title: item.title} : undefined;
  $('entry-heading').textContent = item ? 'Кирпичик' : 'Новый кирпичик';
  const currentKind = $('kind-filter').value;
  $('entry-kind').value = item?.kind ?? (currentKind && currentKind !== 'recipe' ? currentKind : 'document');
  for (const key of ['title', 'scope', 'source', 'text', 'check']) $('entry-' + key).value = item?.[key] ?? '';
  $('remove-entry').hidden = !item;
  $('catalog').hidden = true;
  $('entry-form').hidden = false;
  status('library-status', '');
  $('library').querySelector('.dialog-panel').scrollTop = $('library').scrollTop = 0;
}

function closeEditor() {
  editing = undefined;
  $('catalog').hidden = false;
  $('entry-form').hidden = true;
}

$('kind-filter').addEventListener('change', renderLibrary);
$('search').addEventListener('input', renderLibrary);
$('new-entry').addEventListener('click', () => openEditor());
$('entry-back').addEventListener('click', closeEditor);
$('entry-form').addEventListener('submit', async event => {
  event.preventDefault();
  const current = editing;
  const entry = {id: current?.id ?? crypto.randomUUID(), kind: $('entry-kind').value};
  for (const key of ['title', 'scope', 'source', 'text', 'check']) entry[key] = $('entry-' + key).value.trim();
  try {
    if (!validEntry(entry) || !(entry.text || entry.source)) throw new Error('Укажите название и добавьте текст или источник. Размер записи — до 200 КБ.');
    if (entry.kind === 'expectation' && !entry.check) throw new Error('Добавьте способ проверить ожидание.');
    let copied;
    if (!(await save(s => { copied = edit(s, entry, entry.id, current?.rev ?? null); }))) return;
    if (editing === current) closeEditor();
    status('library-status', copied ? 'Запись изменилась на другом устройстве. Сохранена отдельная копия.' : 'Кирпичик сохранён.');
  } catch (error) { status('library-status', error.message); }
});

async function removeEntry(id, rev, title) {
  if (!id || !confirm('Удалить «' + title + '»?')) return;
  try {
    if (!(await save(s => {
      if (s.library[id]?.rev !== rev) throw new Error('Запись изменилась. Откройте её заново.');
      edit(s, null, id);
    }))) return;
    if (editing?.id === id) closeEditor();
    status('library-status', 'Запись удалена.');
  } catch (error) { status('library-status', error.message); }
}
$('remove-entry').addEventListener('click', () => {
  if (editing) removeEntry(editing.id, editing.rev, editing.title);
});

$('files').addEventListener('change', async event => {
  const input = event.target;
  const files = Array.from(input.files);
  input.value = '';
  const current = profile;
  const kind = $('kind-filter').value;
  const added = [];
  const skipped = [];
  for (const file of files) {
    try {
      if (file.size > textLimit) throw new Error();
      const text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer()).trim();
      const autoKind = /(?:^|[\\/])SKILL\.md$/i.test(file.name) ? 'skill'
        : /\.(?:js|ts|html|css|py|webmanifest)$/i.test(file.name) ? 'code' : 'document';
      const title = autoKind === 'skill' ? text.match(/^name:[ \t]*([\w-]+)\s*$/m)?.[1] ?? file.name : file.name;
      const entry = {id: crypto.randomUUID(), kind: kind || autoKind, title: title.slice(0, 180),
        text, source: file.name, scope: '', check: ''};
      if (!text || !validEntry(entry)) throw new Error();
      added.push(entry);
    } catch { skipped.push(file.name); }
  }
  if (current !== profile) return;
  try {
    if (added.length && !(await save(s => added.forEach(entry => edit(s, entry))))) return;
    status('library-status', 'Добавлено: ' + added.length + (skipped.length ? '. Пропущено: ' + skipped.join(', ') : '.'));
  } catch (error) { status('library-status', error.message); }
});

const menu = $('menu-toggle');
function closeMenu() { menu.setAttribute('aria-expanded', 'false'); }
menu.addEventListener('click', () => menu.setAttribute('aria-expanded', String(menu.getAttribute('aria-expanded') !== 'true')));
document.addEventListener('click', event => {
  if (!menu.contains(event.target) && !$('navigation').contains(event.target)) closeMenu();
});

function showLibrary(kind = '') {
  closeMenu();
  closeEditor();
  $('search').value = '';
  $('kind-filter').value = kind;
  status('library-status', '');
  renderLibrary();
  if (!$('library').open) $('library').showModal();
}
$('pick').addEventListener('click', () => showLibrary());
document.querySelectorAll('[data-open]').forEach(control => control.addEventListener('click', () => {
  closeMenu();
  if (control.dataset.open === 'library') showLibrary(control.dataset.section);
  else $('settings').showModal();
}));
document.querySelectorAll('[data-close]').forEach(control => control.addEventListener('click', () => control.closest('dialog').close()));
for (const dialog of document.querySelectorAll('dialog')) {
  const outside = event => {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
  dialog.addEventListener('click', event => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menu.focus();
  }
});

for (const name of Object.keys(models)) $('key-' + name).value = get('key-' + name);
$('save-keys').addEventListener('click', () => {
  for (const name of Object.keys(models)) set('key-' + name, $('key-' + name).value.trim());
  status('key-status', 'Ключи сохранены на этом устройстве.');
  updateModelOptions();
  updatePackage();
});
$('generate-code').addEventListener('click', () => {
  $('access-code').value = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  $('access-code').select();
});

async function setProfile(code) {
  if (connecting) return;
  connecting = true;
  $('connect').disabled = true;
  $('disconnect').disabled = true;
  try {
    const next = code ? (await cloudIdentity(code)).profile : 'local';
    const nextState = await read(next);
    connection?.close();
    connection = undefined;
    profile = next;
    state = nextState;
    set('code', code);
    $('access-code').value = code;
    $('disconnect').hidden = !code;
    loadDraft();
    renderLibrary();
    status('plan-status', '');
    status('package-status', '');
    status('sync-status', code ? 'Подключаю синхронизацию…' : 'Локальная библиотека');
    if (code) connection = await connectSync(code, next, message => status('sync-status', message), refresh, () => profile === next);
  } catch {
    status('sync-status', 'Не удалось подключиться. Доступна локальная копия.');
  } finally {
    connecting = false;
    $('connect').disabled = false;
    $('disconnect').disabled = false;
  }
}
$('connect').addEventListener('click', () => {
  const code = $('access-code').value.trim();
  if (/^[A-Za-z0-9_-]{22}$/.test(code)) setProfile(code);
  else status('sync-status', 'Создайте код или вставьте код с другого устройства.');
});
$('disconnect').addEventListener('click', () => setProfile(''));

try {
  await refresh();
  loadDraft();
  const code = get('code');
  if (code) await setProfile(code);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
} catch {
  status('plan-status', 'Не удалось открыть локальное хранилище.');
}


/* Autonomous execution: each request receives the goal, plan, step materials and current files. */
const exArchiveStore = 'interactive-engineering:executor-projects-v1';
if (exJob) exId('exec-format').value = exJob.format;
const exArchives=()=>{try{return JSON.parse(localStorage.getItem(exArchiveStore)||'[]')}catch{return []}};
function exArchive(){if(!exJob)return false;const items=exArchives();const name=prompt('Название проекта для сохранения:',exJob.task.slice(0,75));if(!name)return false;items.unshift({id:crypto.randomUUID(),name,created:new Date().toISOString(),job:structuredClone(exJob),assembly:structuredClone(assembly)});localStorage.setItem(exArchiveStore,JSON.stringify(items));exId('exec-status').textContent='Проект сохранён в архиве этого устройства.';exRender();return true}
function exReset(){
  if(exBusy){exId('exec-status').textContent='Сначала приостановите выполнение.';return}
  if(!confirm('Создать полностью новый проект? Будут очищены задача, план, выбранные кирпичики и текущее выполнение. Библиотека и сохранённые проекты останутся.'))return;
  exNotice('');
  exJob=null;localStorage.removeItem(exStore);assembly=blankAssembly();recipeId=undefined;recipeRev=undefined;reasons={};
  persistDraft();renderAssembly();exId('exec-status').textContent='Новый проект готов. Введите задачу и составьте план.';status('plan-status','');status('package-status','');exRender();$('task').focus();
}
function exRestore(){if(exBusy)return;const items=exArchives();if(!items.length){exId('exec-status').textContent='Сохранённых проектов пока нет.';return}const list=items.map((x,i)=>(i+1)+'. '+x.name+' · '+new Date(x.created).toLocaleDateString('ru-RU')+' · шаг '+(x.job.index+1)).join('\n');const answer=prompt('Введите номер проекта:\n'+list);if(!answer)return;const i=Number(answer)-1;if(!Number.isInteger(i)||!items[i])return;exNotice('');exJob=structuredClone(items[i].job);assembly=structuredClone(items[i].assembly);persistDraft();renderAssembly();exSave();exId('exec-format').value=exJob.format;exId('exec-status').textContent='Проект восстановлен: '+items[i].name;exRender()}

function exNotice(text, temporary = false) {
  clearTimeout(exNoticeTimer);
  status('exec-notice', text);
  if (temporary) exNoticeTimer = setTimeout(() => status('exec-notice', ''), 5500);
}

function exSave(job = exJob) { localStorage.setItem(exStore, JSON.stringify(job)); }
function exParse(raw) {
  const s = raw.replace(/^\s*\x60\x60\x60(?:json)?/i, '').replace(/\x60\x60\x60\s*$/, '').trim();
  try { return JSON.parse(s); } catch { const a=s.indexOf('{'), b=s.lastIndexOf('}'); return JSON.parse(s.slice(a,b+1)); }
}
function exApplyResponse(job, reply) {
  if (typeof reply?.summary !== 'string' || typeof reply.check !== 'string') {
    throw Error('В ответе нужны текстовые поля summary и check.');
  }
  const {files = [], patches = []} = reply;
  const bundling = job.format === 'html' && Object.hasOwn(reply, 'bundle');
  if (!Array.isArray(files) || !Array.isArray(patches)
    || (!Array.isArray(reply.files) && !Array.isArray(reply.patches) && reply.no_changes_needed !== true && !bundling)) {
    throw Error('Верните массив files или patches. Для проверки без изменений укажите no_changes_needed: true.');
  }
  if (bundling && (files.length || patches.length)) {
    throw Error('Для сборки передайте bundle с уже сохранёнными файлами. Правки шаблона или модулей сохраняются на предыдущем шаге.');
  }

  const staged = {...job.files};
  const validName = name => typeof name === 'string'
    && /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,100}$/.test(name) && !name.includes('..');
  for (const patch of patches) {
    if (!validName(patch?.name) || typeof patch.find !== 'string' || !patch.find
      || typeof patch.replace !== 'string') throw Error('Некорректная точечная правка.');
    const {name, find, replace} = patch;
    const base = Object.hasOwn(staged, name) ? staged[name] : undefined;
    if (typeof base !== 'string') throw Error('Нет файла для правки: ' + name);
    const pos = base.indexOf(find);
    const next = pos < 0 ? -1 : base.indexOf(find, pos + 1);
    if (pos < 0 || next >= 0) {
      const reason = pos < 0 ? 'фрагмент отсутствует' : 'несколько совпадений около позиций ' + pos + ' и ' + next;
      throw Error(name + ': ' + reason + '. Начало find: ' + JSON.stringify(find.slice(0, 180))
        + '. Прочитайте актуальный фрагмент и используйте точное уникальное совпадение.');
    }
    staged[name] = base.slice(0, pos) + replace + base.slice(pos + find.length);
  }
  for (const file of files) {
    if (!validName(file?.name) || typeof file.content !== 'string') {
      throw Error('Некорректное имя или содержимое файла.');
    }
    Object.defineProperty(staged, file.name, {value: file.content, enumerable: true, writable: true, configurable: true});
  }
  const step = job.steps[job.index];
  if (job.format === 'pwa' && !files.length && !patches.length && reply.no_changes_needed !== true
    && /созда|реализ|подключ|измен|обнов|регистр|кэш|service.worker/i.test(step.title + ' ' + step.action)) {
    throw Error('Модель не передала изменений файлов. Этот шаг не засчитан.');
  }
  const htmlBundle = bundling ? reply.bundle : job.htmlBundle;
  if (job.format === 'html') {
    if (bundling || htmlBundle) buildSingleHtml(staged, htmlBundle);
    else if (job.singleHtmlAssembly && job.index + 1 === job.steps.length) {
      if (!staged['index.html']?.trim()) throw Error('Сборка HTML: нет итогового index.html.');
      if (Object.keys(staged).some(name => /\.(js|css)$/i.test(name))) {
        throw Error('Сборка HTML: найдены отдельные JS/CSS-файлы. Верните bundle, чтобы вставить их в шаблон.');
      }
    }
  }
  return {files: staged, htmlBundle};
}

function exOutputFiles(job) {
  if (job.format === 'html' && job.htmlBundle) {
    return {'index.html': buildSingleHtml(job.files, job.htmlBundle)};
  }
  if (job.format === 'html' && job.singleHtmlAssembly && job.index === job.steps.length) {
    return {'index.html': job.files['index.html']};
  }
  return job.files;
}

async function exAskStep(job, key) {
  const messages = [{role: 'user', content: JSON.stringify(executionContext(job))}];
  const seen = new Set();
  let repairing = false;
  while (true) {
    const reply = await askModel(job.model, key, messages, fetch,
      {maxTokens:12000, timeoutMs:180000, requireComplete:true});
    let value;
    try {
      try { value = exParse(reply); }
      catch { throw Error('Ответ не удалось прочитать как JSON.'); }
      if (!Array.isArray(value?.read)) return {reply: value, ...exApplyResponse(job, value)};
    } catch (error) {
      if (repairing || exPause || (!exFixing && exPlanChanged())) throw error;
      repairing = true;
      messages.push({role: 'assistant', content: 'Предыдущая попытка оформить результат шага отклонена.'},
        {role: 'user', content: 'Исправьте ответ: ' + error.message
          + ' Файлы предыдущей попытки не применены. Верните весь результат текущего шага в указанном формате.'});
      continue;
    }
    const excerpts = JSON.stringify(readExecutionContext(job, value.read));
    if (seen.size === 4 || seen.has(excerpts)) {
      throw Error('Модель не завершила шаг после чтения фрагментов. Уточните в плане, какой участок нужен, или повторите шаг.');
    }
    seen.add(excerpts);
    messages.push({role: 'assistant', content: JSON.stringify({read: value.read})},
      {role: 'user', content: JSON.stringify({excerpts})});
  }
}
function exValidate() {
  const f=exJob.files,errors=[];
  if(exJob.format==='pwa') {
    for(const n of ['index.html','sw.js','manifest.webmanifest'])if(!f[n] && !(n==='manifest.webmanifest'&&f['manifest.json']))errors.push('Нет '+n);
    if(f['manifest.webmanifest']||f['manifest.json'])try {JSON.parse(f['manifest.webmanifest']||f['manifest.json'])}catch{errors.push('Некорректный manifest')}
    if(f['index.html']&&!f['index.html'].includes('serviceWorker'))errors.push('Нет регистрации service worker');
  }
  if (exJob.format === 'html') {
    try {
      if (!exOutputFiles(exJob)['index.html']?.trim()) errors.push('Нет index.html');
    } catch (error) { errors.push(error.message); }
  }
  if(exJob.format==='document'&&!f['result.md'])errors.push('Нет result.md');
  return errors;
}
function exPlanChanged() {
  if (!exJob) return false;
  const planFields = steps => steps.map(({title, action, result, check, ids}) =>
    [title, action, result, check, ids]);
  return exJob.task !== assembly.task || exJob.result !== assembly.result
    || JSON.stringify(exJob.globalIds) !== JSON.stringify(assembly.ids)
    || JSON.stringify(planFields(exJob.steps)) !== JSON.stringify(planFields(assembly.steps))
    || JSON.stringify(exJob.acceptance || []) !== JSON.stringify(acceptanceCases());
}

function exUpdateControls(ready = planReady()) {
  const changed = exPlanChanged();
  const start = exId('exec-start');
  start.hidden = !!exJob && (!changed || exBusy);
  start.disabled = planning || (changed && !ready);
  start.textContent = exJob ? 'Запустить повторно' : 'Согласовать план';
  const run = exId('exec-run');
  run.hidden = exFixing || (!exBusy && (!exJob || changed || exJob.index >= exJob.steps.length));
  run.textContent = exBusy ? 'Пауза после шага' : 'Выполнить план';
  exId('exec-plan-changed').hidden = !changed;
}

function saveAcceptance(job, review) {
  const next = {...job, review};
  try { exSave(next); }
  catch (error) {
    status('exec-status', 'Не удалось сохранить приёмку: ' + error.message);
    return false;
  }
  exJob = next;
  return true;
}

function renderAcceptanceResult() {
  const panel = $('acceptance-result');
  panel.replaceChildren();
  panel.hidden = !exJob || exJob.index < exJob.steps.length;
  if (panel.hidden) return;

  const scenarios = exJob.acceptance || [];
  const review = exJob.review || {};
  const results = review.results || [];
  const canReview = scenarios.length > 0 && exValidate().length === 0;
  const passed = canReview && scenarios.every((_, index) => results[index]?.outcome === 'passed');
  const failed = results.some(item => item?.outcome === 'failed');
  let heading = 'Выполнение завершено';
  if (review.skipped) heading = 'Завершено без приёмки';
  else if (passed) heading = 'Принято';
  else if (failed) heading = 'Есть замечания';
  else if (canReview) heading = 'Готово к приёмке';
  const title = node('h3', heading);
  title.setAttribute('role', 'status');
  panel.append(title);
  if (review.skipped) {
    if (canReview) panel.append(button('Вернуться к приёмке', () => {
      if (saveAcceptance(exJob, {...review, skipped: false})) renderAcceptanceResult();
    }));
    return;
  }
  if (canReview) {
    scenarios.forEach(({action, expected}, index) => {
      const result = results[index] || {};
      const card = node('div', '', 'step');
      const caption = result.outcome === 'passed' ? 'Прошло' : result.outcome === 'failed' ? 'Не прошло' : 'Не проверено';
      card.append(node('strong', (index + 1) + '. ' + action), node('p', 'Ожидается — ' + expected), node('p', caption));
      const actions = node('div', '', 'row');
      function mark(outcome) {
        const updated = [...(exJob.review?.results || [])];
        updated[index] = {...updated[index], outcome};
        if (saveAcceptance(exJob, {results: updated})) renderAcceptanceResult();
      }
      for (const [label, outcome] of [['Прошло', 'passed'], ['Не прошло', 'failed']]) {
        const control = button(label, () => mark(outcome));
        control.disabled = exBusy || result.outcome === outcome;
        actions.append(control);
      }
      card.append(actions);
      if (result.outcome === 'failed') {
        const label = node('label', 'Что произошло');
        const note = node('textarea');
        note.rows = 2;
        note.maxLength = 1000;
        note.value = result.note || '';
        note.disabled = exBusy;
        note.addEventListener('input', () => {
          const updated = [...(exJob.review?.results || [])];
          updated[index] = {...updated[index], note: note.value};
          saveAcceptance(exJob, {results: updated});
        });
        label.append(note);
        card.append(label);
      }
      panel.append(card);
    });
  }
  if (passed) return;
  const actions = node('div', '', 'row');
  if (canReview && failed) {
    const fix = button('Исправить замечания', exRepairAcceptance, 'primary');
    fix.disabled = exBusy;
    actions.append(fix);
  }
  const skip = button('Завершить без приёмки', () => {
    if (saveAcceptance(exJob, {...exJob.review, skipped: true})) renderAcceptanceResult();
  });
  skip.disabled = exBusy;
  actions.append(skip);
  panel.append(actions);
}

async function exRepairAcceptance() {
  if (exBusy || !exJob || exJob.review?.skipped) return;
  const original = exJob;
  const feedback = (original.acceptance || []).flatMap((scenario, index) => {
    const result = original.review?.results?.[index];
    return result?.outcome === 'failed' ? [{...scenario, observed: result.note || ''}] : [];
  });
  if (!feedback.length) return;
  const key = get('key-' + original.model);
  if (!key) {
    status('exec-status', 'API-ключ не найден в настройках.');
    return;
  }

  const repair = {title: 'Доработка по приёмке',
    action: 'Исправьте только указанные замечания в текущих файлах.',
    result: 'Исправленные файлы проекта.',
    check: 'Сверьте правки с непройденными сценариями и сохраните остальное поведение.',
    ids: []};
  const job = {...original, steps: [...original.steps, repair], repairFeedback: feedback};
  exBusy = exFixing = true;
  exPause = false;
  status('exec-status', '');
  exNotice('План выполняется');
  exRender();
  try {
    const {reply, files, htmlBundle} = await exAskStep(job, key);
    const record = executionRecord(reply, original.files, files);
    if (record.check_status === 'failed') throw Error('Модель сообщила, что проверка не пройдена. ' + record.check);
    const next = {...original, files, htmlBundle, review: {results: []}, done: [...original.done, record]};
    if (!record.changed_files.length && exOutputFiles(original)['index.html'] === exOutputFiles(next)['index.html']) {
      throw Error('Модель не вернула изменений в файлах.');
    }
    exSave(next);
    exJob = next;
    status('exec-status', 'Исправления сохранены. Проверьте сценарии на обновлённых файлах.');
  } catch (error) {
    status('exec-status', 'Доработка не завершена: ' + error.message);
  } finally {
    exBusy = exFixing = false;
    if (exJob === original) exNotice('Остановлено', true);
    else exNotice('');
    exRender();
  }
}

function exRender() {
  exUpdateControls();
  const p = exId('exec-progress');
  const journalOpen = $('execution-journal')?.open;
  p.replaceChildren();
  renderAcceptanceResult();
  if(!exJob){p.textContent='Введите задачу, составьте план и нажмите «Согласовать план».';exId('exec-download').hidden=true;return}
  const stepProgress = 'Шаг ' + Math.min(exJob.index + 1, exJob.steps.length) + ' из ' + exJob.steps.length;
  const progress = node('p');
  if (exBusy) {
    progress.className = 'execution-progress';
    const spinner = node('span', '', 'execution-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    progress.append(spinner, node('span', exFixing ? 'Исправляю замечания приёмки' : 'План выполняется · ' + stepProgress));
  } else {
    progress.textContent = stepProgress + (exJob.index === exJob.steps.length ? ' · завершено' : ' · пауза');
  }
  p.append(progress);
  const ol=document.createElement('ol');
  exJob.steps.forEach((s,i)=>{const li=document.createElement('li');li.textContent=(i<exJob.index?'✓ ':i===exJob.index?'▶ ':'○ ')+s.title;ol.append(li)});
  p.append(ol);
  const names=Object.keys(exJob.files);if(names.length){const files=document.createElement('details');const heading=document.createElement('summary');heading.textContent='Отдельные файлы ('+names.length+')';files.append(heading);const info=document.createElement('p');info.textContent='Основной результат можно скачать кнопкой ниже.';files.append(info);for(const name of names){const b=document.createElement('button');b.type='button';b.textContent='↓ '+(name === 'index.html' && exJob.htmlBundle ? 'Шаблон index.html' : name);b.style.cssText='display:block;margin:6px 0;max-width:100%;overflow-wrap:anywhere';b.addEventListener('click',()=>exDownloadFile(name));files.append(b)}p.append(files)}
  if(exJob.index===exJob.steps.length){const e=exValidate();if(e.length){const x=document.createElement('p');x.textContent='Требует проверки: '+e.join('; ');p.append(x)}}
  const journal = node('div', '', 'journal');
  const details = node('details');
  details.id = 'execution-journal';
  details.open = !!journalOpen;
  const summary = node('summary', 'Журнал');
  const pre = node('pre');
  const checkLabels = {passed: 'пройдена по отчёту модели', not_run: 'не выполнена или не подтверждена'};
  pre.textContent = exJob.done.map((record, index) => [
    (index + 1) + '. ' + record.summary,
    'Проверка (' + (checkLabels[record.check_status] || 'прежняя запись без статуса') + '): ' + record.check,
    record.changed_files?.length && 'Изменены: ' + record.changed_files.join(', '),
    record.decisions?.length && 'Решения: ' + record.decisions.join(' · '),
    record.open_items?.length && 'Открытые вопросы: ' + record.open_items.join(' · '),
    record.next_impulse && 'Далее: ' + record.next_impulse,
  ].filter(Boolean).join('\n')).join('\n\n');
  const copy = button('Копировать', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      copy.textContent = 'Скопировано';
    } catch {
      details.open = true;
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copy.textContent = 'Текст выделен';
    }
  }, 'journal-copy');
  copy.setAttribute('aria-label', 'Копировать журнал');
  copy.disabled = !pre.textContent;
  details.append(summary, pre);
  journal.append(details, copy);
  p.append(journal);
  const download = exId('exec-download');
  download.hidden = download.disabled = !names.length;
  download.textContent = exJob.format === 'html' && exJob.index < exJob.steps.length
    ? 'Скачать черновик' : 'Скачать файлы';
}
async function exRun(){
  if(exBusy){exPause=true;return}
  if(!exJob||exJob.index>=exJob.steps.length||exPlanChanged())return;
  const key=get('key-'+exJob.model);
  if(!key){exId('exec-status').textContent='API-ключ не найден в настройках.';return}
  exPause=false;exBusy=true;
  exId('exec-status').textContent = '';
  exNotice('План выполняется');
  exRender();
  while(!exPause&&!exPlanChanged()&&exJob.index<exJob.steps.length){
    try{
      const {reply: v, files: staged, htmlBundle} = await exAskStep(exJob, key);
      const record = executionRecord(v, exJob.files, staged);
      if (exJob.format === 'html' && Object.hasOwn(v, 'bundle')) {
        record.changed_files = [...new Set([...record.changed_files, 'index.html'])];
      }
      if (record.check_status === 'failed') throw Error('Проверка шага по отчёту модели не пройдена. ' + record.check);
      const next = {...exJob, files: staged, htmlBundle, done: [...exJob.done, record], index: exJob.index + 1};
      exSave(next);
      exJob = next;
      exRender();
    }catch(e){exPause=true;exId('exec-status').textContent='Остановлено на шаге '+(exJob.index+1)+': '+e.message}
  }
  exBusy = false;
  if (exJob.index < exJob.steps.length) exNotice('Остановлено', true);
  else exNotice('');
  exRender();
}
function exCrc(data){let c=-1;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c&1?(c>>>1)^0xedb88320:c>>>1}return(c^-1)>>>0}
function exZip(files){
  const u16=n=>[n&255,(n>>>8)&255],u32=n=>[n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255];
  const enc=new TextEncoder(),parts=[],central=[];let offset=0;
  for(const [name,content] of Object.entries(files)){
    const n=enc.encode(name),d=enc.encode(content),size=d.length,crc=exCrc(d);
    const local=new Uint8Array([...u32(0x04034b50),...u16(20),...u16(0x800),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(size),...u32(size),...u16(n.length),...u16(0),...n]);
    parts.push(local,d);
    central.push(new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(0x800),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(size),...u32(size),...u16(n.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset),...n]));
    offset+=local.length+d.length;
  }
  const len=central.reduce((s,x)=>s+x.length,0);
  return new Blob([...parts,...central,new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(central.length),...u16(central.length),...u32(len),...u32(offset),...u16(0)])],{type:'application/zip'});
}
function exDownloadFile(name){if(!exJob||typeof exJob.files[name]!=='string')return;const blob=new Blob([exJob.files[name]],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name.split('/').pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
function exDownload(){
  if(!exJob)return;
  let entries;
  try { entries = Object.entries(exOutputFiles(exJob)); }
  catch (error) { status('exec-status', error.message); return; }
  if (!entries.length) return;
  const blob=entries.length===1?new Blob([entries[0][1]],{type:'text/plain;charset=utf-8'}):exZip(exJob.files);
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=entries.length===1?entries[0][0]:'engineering-result.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
exId('exec-start').addEventListener('click',()=>{
  if(exBusy||planning||(exJob&&!exPlanChanged()))return;
  if(!planReady()){
    if (assembly.task.trim()) $('working-plan').open = true;
    exId('exec-status').textContent='Заполните задачу, результат и все поля плана.';return;
  }
  const model=exId('model').value;
  if(!get('key-'+model)){exId('exec-status').textContent='Сначала добавьте ключ модели в настройках.';return}
  const restarting = !!exJob;
  if (restarting && (exJob.index || Object.keys(exJob.files).length)
    && !confirm('Запустить изменённый план с первого шага? Текущий прогресс и файлы этой сессии будут заменены.')) return;
  const materialIds = new Set([...assembly.ids, ...assembly.steps.flatMap(step => step.ids)]);
  const job={task:assembly.task,result:assembly.result,steps:structuredClone(assembly.steps),globalIds:[...assembly.ids],
    acceptance: acceptanceCases(),
    materials:structuredClone(materials().filter(item => materialIds.has(item.id))),model,format:exId('exec-format').value,index:0,done:[],files:{}};
  if (job.format === 'html') job.singleHtmlAssembly = true;
  if(job.format==='pwa'){for(const m of job.materials){const name=(m.source||m.title||'').split('/').pop();if(['index.html','sw.js','manifest.json','manifest.webmanifest','README.md'].includes(name)&&m.text)job.files[name]=m.text}}
  try { exSave(job); }
  catch(e) { exId('exec-status').textContent=e.message; return; }
  exJob = job;
  exNotice('');
  exId('exec-status').textContent = restarting ? 'Выполнение обновлённого плана…'
    : 'План согласован. Нажмите «Выполнить план».';
  if (restarting) void exRun();
  else exRender();
});
exId('exec-run').addEventListener('click',exRun);
exId('exec-download').addEventListener('click',exDownload);
exId('exec-save').addEventListener('click',exArchive);
exId('exec-reset').addEventListener('click',exReset);
exId('exec-reset-top').addEventListener('click',exReset);
exId('exec-restore').addEventListener('click',exRestore);
exRender();
