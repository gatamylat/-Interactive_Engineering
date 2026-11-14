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
const exId = id => document.getElementById(id);
const exStore = 'interactive-engineering:executor-v1';
const exArchiveStore = 'interactive-engineering:executor-projects-v1';
const exArchives=()=>{try{return JSON.parse(localStorage.getItem(exArchiveStore)||'[]')}catch{return []}};
function exArchive(){if(!exJob)return false;const items=exArchives();const name=prompt('Название проекта для сохранения:',exJob.task.slice(0,75));if(!name)return false;items.unshift({id:crypto.randomUUID(),name,created:new Date().toISOString(),job:structuredClone(exJob),assembly:structuredClone(assembly)});localStorage.setItem(exArchiveStore,JSON.stringify(items));exId('exec-status').textContent='Проект сохранён в архиве этого устройства.';exRender();return true}
function exReset(){
  if(exBusy){exId('exec-status').textContent='Сначала приостановите выполнение.';return}
  if(!confirm('Создать полностью новый проект? Будут очищены задача, план, выбранные кирпичики и текущее выполнение. Библиотека и сохранённые проекты останутся.'))return;
  exJob=null;localStorage.removeItem(exStore);assembly=blankAssembly();recipeId=undefined;recipeRev=undefined;reasons={};
  persistDraft();renderAssembly();exId('exec-status').textContent='Новый проект готов. Введите задачу и составьте план.';status('plan-status','');status('package-status','');exRender();$('task').focus();
}
function exRestore(){if(exBusy)return;const items=exArchives();if(!items.length){exId('exec-status').textContent='Сохранённых проектов пока нет.';return}const list=items.map((x,i)=>(i+1)+'. '+x.name+' · '+new Date(x.created).toLocaleDateString('ru-RU')+' · шаг '+(x.job.index+1)).join('\n');const answer=prompt('Введите номер проекта:\n'+list);if(!answer)return;const i=Number(answer)-1;if(!Number.isInteger(i)||!items[i])return;exJob=structuredClone(items[i].job);assembly=structuredClone(items[i].assembly);persistDraft();renderAssembly();exSave();exId('exec-format').value=exJob.format;exId('exec-status').textContent='Проект восстановлен: '+items[i].name;exRender()}

let exJob = null, exBusy = false, exPause = false;
try { exJob = JSON.parse(localStorage.getItem(exStore) || 'null'); } catch {}
function exSave() { localStorage.setItem(exStore, JSON.stringify(exJob)); }
function exParse(raw) {
  const s = raw.replace(/^\s*\x60\x60\x60(?:json)?/i, '').replace(/\x60\x60\x60\s*$/, '').trim();
  try { return JSON.parse(s); } catch { const a=s.indexOf('{'), b=s.lastIndexOf('}'); return JSON.parse(s.slice(a,b+1)); }
}
function exContext() {
  const s=exJob.steps[exJob.index];
  const ids=new Set([...exJob.globalIds,...s.ids]);
  const linked=exJob.materials.filter(m=>ids.has(m.id)).map(m=>({title:m.title,scope:m.scope,check:m.check,text:m.text.slice(0,22000)}));
  return JSON.stringify({
    instruction:'Выполни только текущий шаг. Если шаг требует изменить код, обязательно верни files или patches с реальными изменениями; одних пояснений недостаточно. Если требуемое изменение уже выполнено, верни check с доказательством и no_changes_needed:true.  Сохраняй общую цель. Для нового небольшого файла используй files:[{name,content}]. Для существующих БОЛЬШИХ файлов используй patches:[{name,find,replace}], где find — точный уникальный фрагмент, а replace — новый текст. Никогда не возвращай большой исходный index.html целиком. Можно вернуть files:[] и patches:[]. Не используй CDN. Для документа создавай result.md. Ответ строго JSON {summary,check,next_impulse,files:[{name,content}],patches:[{name,find,replace}]}. Не добавляй markdown.',
    goal:exJob.task,expectedResult:exJob.result,format:exJob.format,
    plan:exJob.steps.map(x=>({title:x.title,result:x.result})),
    completed:exJob.done.map(d=>({summary:d.summary,next_impulse:d.next_impulse})),step:s,materials:linked,files:Object.fromEntries(Object.entries(exJob.files).map(([name,content])=>[name,content.length>20000?content.slice(0,12000)+'\n[...середина опущена...]\n'+content.slice(-5000):content]))
  });
}
function exValidate() {
  const f=exJob.files,errors=[];
  if(exJob.format==='pwa') {
    for(const n of ['index.html','sw.js','manifest.webmanifest'])if(!f[n] && !(n==='manifest.webmanifest'&&f['manifest.json']))errors.push('Нет '+n);
    if(f['manifest.webmanifest']||f['manifest.json'])try {JSON.parse(f['manifest.webmanifest']||f['manifest.json'])}catch{errors.push('Некорректный manifest')}
    if(f['index.html']&&!f['index.html'].includes('serviceWorker'))errors.push('Нет регистрации service worker');
  }
  if(exJob.format==='html'&&!f['index.html'])errors.push('Нет index.html');
  if(exJob.format==='document'&&!f['result.md'])errors.push('Нет result.md');
  return errors;
}
function exRender() {
  const p=exId('exec-progress');p.replaceChildren();
  if(!exJob){p.textContent='Введите задачу, составьте план и нажмите «Начать выполнение плана».';exId('exec-start').hidden=false;exId('exec-run').hidden=true;exId('exec-download').hidden=true;return}
  const status=document.createElement('p');
  status.textContent='Шаг '+Math.min(exJob.index+1,exJob.steps.length)+' из '+exJob.steps.length+(exBusy?' · выполняется':exJob.index===exJob.steps.length?' · завершено':' · пауза');
  p.append(status);
  const ol=document.createElement('ol');
  exJob.steps.forEach((s,i)=>{const li=document.createElement('li');li.textContent=(i<exJob.index?'✓ ':i===exJob.index?'▶ ':'○ ')+s.title;ol.append(li)});
  p.append(ol);
  const files=document.createElement('div');files.append(document.createTextNode('Файлы проекта:'));const names=Object.keys(exJob.files);if(!names.length)files.append(document.createTextNode(' пока нет'));for(const name of names){const b=document.createElement('button');b.type='button';b.textContent='↓ '+name;b.style.cssText='display:block;margin:6px 0;max-width:100%;overflow-wrap:anywhere';b.addEventListener('click',()=>exDownloadFile(name));files.append(b)}p.append(files);
  if(exJob.index===exJob.steps.length){const e=exValidate();if(e.length){const x=document.createElement('p');x.textContent='Требует проверки: '+e.join('; ');p.append(x)}}
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
  summary.textContent='Журнал';pre.style.whiteSpace='pre-wrap';pre.textContent=exJob.done.map((d,i)=>(i+1)+'. '+d.summary+'\nПроверка: '+d.check+'\nДалее: '+d.next_impulse).join('\n\n');
  details.append(summary,pre);p.append(details);
  exId('exec-start').hidden=true;exId('exec-run').hidden=exJob.index===exJob.steps.length&&!exBusy;exId('exec-download').hidden=!Object.keys(exJob.files).length;
  exId('exec-run').disabled=exJob.index===exJob.steps.length&&!exBusy;
  exId('exec-run').textContent=exBusy?'Пауза после шага':'Продолжить выполнение';
  exId('exec-download').disabled=!Object.keys(exJob.files).length;
}
async function exRun(){
  if(exBusy){exPause=true;return}
  if(!exJob||exJob.index>=exJob.steps.length)return;
  const key=get('key-'+exJob.model);
  if(!key){exId('exec-status').textContent='API-ключ не найден в настройках.';return}
  exPause=false;exBusy=true;exRender();
  while(!exPause&&exJob.index<exJob.steps.length){
    try{
      const reply=await askModel(exJob.model,key,[{role:'user',content:exContext()}],fetch,{maxTokens:12000,timeoutMs:180000,requireComplete:true});
      const v=exParse(reply);
      if(typeof v.summary!=='string'||typeof v.check!=='string'||!Array.isArray(v.files))throw Error('Неполный ответ модели');
      const patches=Array.isArray(v.patches)?v.patches:[];
      const staged={...exJob.files};
      for(const p of patches){if(typeof p.name!=='string'||typeof p.find!=='string'||typeof p.replace!=='string'||!p.find)throw Error('Некорректная точечная правка');if(!/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,100}$/.test(p.name)||p.name.includes('..'))throw Error('Недопустимое имя файла');const base=staged[p.name];if(typeof base!=='string')throw Error('Нет файла для правки: '+p.name);const pos=base.indexOf(p.find);if(pos<0||base.indexOf(p.find,pos+1)>=0)throw Error('Фрагмент для правки не найден или неоднозначен: '+p.name);staged[p.name]=base.slice(0,pos)+p.replace+base.slice(pos+p.find.length)}
      for(const f of v.files){
        if(typeof f.name!=='string'||typeof f.content!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,100}$/.test(f.name)||f.name.includes('..'))throw Error('Некорректное имя файла');
      }
      for(const f of v.files)staged[f.name]=f.content;
      if(exJob.format==='pwa' && !v.files.length && !patches.length && v.no_changes_needed!==true && /созда|реализ|подключ|измен|обнов|регистр|кэш|service.worker/i.test(exJob.steps[exJob.index].title+' '+exJob.steps[exJob.index].action))throw Error('Модель не передала изменений файлов. Этот шаг не засчитан. Повторите запрос.');
      exJob.files=staged;
      exJob.done.push({summary:v.summary,check:v.check,next_impulse:String(v.next_impulse||'')});
      exJob.index++;exSave();exRender();
    }catch(e){exPause=true;exId('exec-status').textContent='Остановлено на шаге '+(exJob.index+1)+': '+e.message}
  }
  exBusy=false;exRender();
  if(exJob.index===exJob.steps.length)exId('exec-status').textContent='Выполнение завершено. Скачайте результат и проверьте его.';
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
  const entries=Object.entries(exJob.files);if(!entries.length)return;
  const blob=entries.length===1?new Blob([entries[0][1]],{type:'text/plain;charset=utf-8'}):exZip(exJob.files);
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=entries.length===1?entries[0][0]:'engineering-result.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
exId('exec-start').addEventListener('click',()=>{
  if(exBusy)return;
  if(!assembly.task.trim()||!assembly.result.trim()||!assembly.steps.length||assembly.steps.some(s=>!s.title.trim()||!s.action.trim()||!s.result.trim()||!s.check.trim())){
    exId('exec-status').textContent='Заполните задачу, результат и все поля плана.';return;
  }
  if(exJob&&exJob.index<exJob.steps.length&&!confirm('Заменить предыдущую сессию?'))return;
  const model=exId('model').value;
  if(!get('key-'+model)){exId('exec-status').textContent='Сначала добавьте ключ модели в настройках.';return}
  exJob={task:assembly.task,result:assembly.result,steps:structuredClone(assembly.steps),globalIds:[...assembly.ids],
    materials:structuredClone(materials()),model,format:exId('exec-format').value,index:0,done:[],files:{}};
  if(exJob.format==='pwa'){for(const m of exJob.materials){const name=(m.source||m.title||'').split('/').pop();if(['index.html','sw.js','manifest.json','manifest.webmanifest','README.md'].includes(name)&&m.text)exJob.files[name]=m.text}}
  try{exSave();exId('exec-status').textContent='План зафиксирован. Нажмите «Продолжить выполнение».'}catch(e){exId('exec-status').textContent=e.message}
  exRender();
});
exId('exec-run').addEventListener('click',exRun);
exId('exec-download').addEventListener('click',exDownload);
exId('exec-save').addEventListener('click',exArchive);
exId('exec-reset').addEventListener('click',exReset);
exId('exec-restore').addEventListener('click',exRestore);
exRender();
