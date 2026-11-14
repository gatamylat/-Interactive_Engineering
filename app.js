import {askModel, blankAssembly, blankStep, buildPackage, candidates, kinds, managerPrompt, models,
  readPlan, textLimit, validAssembly, validEntry} from './modules/core.js';
import {change, edit, entries, read} from './modules/library.js';
import {cloudIdentity, connectSync} from './modules/sync.js';

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

function updatePackage() {
  const ready = !!assembly.task.trim() && !!assembly.result.trim() && assembly.steps.length > 0
    && assembly.steps.every(step => [step.title, step.action, step.result, step.check].every(value => value.trim()));
  if ($('package').closest('details').open) $('package').value = ready ? buildPackage(assembly, materials()) : '';
  $('copy').disabled = !ready;
  $('download').disabled = !ready;
  $('save-recipe').disabled = !state || !assembly.task.trim();
  $('plan').disabled = planning || !state || !assembly.task.trim();
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
  const wrapper = node('label', label);
  const input = node(multiline ? 'textarea' : 'input');
  if (multiline) input.rows = 2;
  input.maxLength = limit;
  input.value = step[key];
  input.addEventListener('input', () => { step[key] = input.value; persistDraft(); });
  wrapper.append(input);
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
  $('add-step').disabled = assembly.steps.length >= 12;
}

function renderAssembly() {
  $('task').value = assembly.task;
  $('result').value = assembly.result;
  renderSelected();
  renderSteps();
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
$('model').value = get('model') === 'deepseek' ? 'deepseek' : 'claude';
$('model').addEventListener('change', () => { set('model', $('model').value); updatePackage(); });
$('add-step').addEventListener('click', () => {
  if (assembly.steps.length >= 12) return;
  assembly.steps.push(blankStep());
  persistDraft();
  renderSteps();
  $('steps').lastElementChild.querySelector('input').focus();
});

$('assembly').addEventListener('submit', async event => {
  event.preventDefault();
  if (planning || !state || !assembly.task.trim()) return;
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
  const prompt = managerPrompt(assembly, available);
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
  $('library').scrollTop = 0;
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
