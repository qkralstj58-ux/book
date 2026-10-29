'use strict';

const CATEGORIES = ['식비', '교통', '주거', '쇼핑', '여가', '금융', '경조사'];
const CATEGORY_EMOJI = { 식비: '🍴', 교통: '🚌', 주거: '🏠', 쇼핑: '🛍️', 여가: '🎯', 금융: '💳', 경조사: '🎁' };
const INCOME_EMOJI = '💰';
const DEFAULT_CATEGORY = '식비';
const FIXED_DEFAULT_CATEGORIES = ['주거'];
const DEFAULT_METHODS = {
  expense: ['현대카드', '농협카드', '계좌', '현금·기타'],
  income: ['농협계좌', '현금·기타'],
};
const TITLE_PLACEHOLDER = {
  expense: '제목 (예: 점심, 관리비, 헬스)',
  income: '제목 (예: 급여, 환급금)',
};
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const SETTINGS_KEY = 'ledger.settings.v1';

/* ---------- 저장소 (IndexedDB, 실패 시 localStorage) ---------- */

const store = (() => {
  const DB_NAME = 'ledger';
  const STORE = 'records';
  const LS_KEY = 'ledger.records.v1';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('date', 'date');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const os = t.objectStore(STORE);
      const result = fn(os);
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const ls = {
    read() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; } },
    write(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); },
  };
  let useLS = false;

  async function guard(idbFn, lsFn) {
    if (!useLS) {
      try { return await idbFn(); } catch (e) { console.warn('IndexedDB 사용 불가, localStorage로 전환', e); useLS = true; }
    }
    return lsFn();
  }

  return {
    all: () => guard(() => tx('readonly', os => os.getAll()), () => ls.read()),
    put: rec => guard(() => tx('readwrite', os => { os.put(rec); }), () => {
      const list = ls.read().filter(r => r.id !== rec.id);
      list.push(rec);
      ls.write(list);
    }),
    putMany: recs => guard(() => tx('readwrite', os => { recs.forEach(r => os.put(r)); }), () => {
      const ids = new Set(recs.map(r => r.id));
      ls.write(ls.read().filter(r => !ids.has(r.id)).concat(recs));
    }),
    remove: id => guard(() => tx('readwrite', os => { os.delete(id); }), () => {
      ls.write(ls.read().filter(r => r.id !== id));
    }),
  };
})();

/* ---------- 설정 ---------- */

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch {}
  const m = s.methods;
  const list = v => (Array.isArray(v) && v.length ? v : null);
  return {
    // 예전 형식(지출/수입 공용 배열)도 지출 목록으로 이어받음
    methods: {
      expense: list(Array.isArray(m) ? m : m && m.expense) || DEFAULT_METHODS.expense.slice(),
      income: list(m && m.income) || DEFAULT_METHODS.income.slice(),
    },
    lastMethod: s.lastMethod || {},
  };
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

/* ---------- 날짜 유틸 ---------- */

const pad = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const todayKey = () => toKey(new Date());

// 주는 월요일 시작
function weekRange(d) {
  const offset = (d.getDay() + 6) % 7;
  const start = addDays(d, -offset);
  return [toKey(start), toKey(addDays(start, 6))];
}
function monthRange(d) {
  return [toKey(new Date(d.getFullYear(), d.getMonth(), 1)), toKey(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
}
const fmtMD = k => { const d = fromKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };

/* ---------- 숫자 ---------- */

const fmtNum = n => Math.abs(n).toLocaleString('ko-KR');
const won = n => `${n < 0 ? '-' : ''}${fmtNum(n)}원`;

/* ---------- 상태 ---------- */

const settings = loadSettings();
let records = [];
const state = {
  date: todayKey(),
  period: 'day',
  type: 'expense',
  category: DEFAULT_CATEGORY,
  costType: 'variable',
  method: null,
  editingId: null,
  lastSavedId: null,
};

const $ = id => document.getElementById(id);
const el = {
  dateText: $('dateText'), datePicker: $('datePicker'), todayBtn: $('todayBtn'),
  periodSeg: $('periodSeg'), periodLabel: $('periodLabel'),
  sIn: $('sIn'), sOut: $('sOut'), sDiff: $('sDiff'), sFixed: $('sFixed'), sVar: $('sVar'),
  typeSeg: $('typeSeg'), amount: $('amount'), catChips: $('catChips'), costSeg: $('costSeg'),
  title: $('title'), memoToggle: $('memoToggle'), memo: $('memo'),
  methodLabel: $('methodLabel'), methodChips: $('methodChips'), saveBtn: $('saveBtn'),
  editBanner: $('editBanner'), cancelEdit: $('cancelEdit'),
  recordsTitle: $('recordsTitle'), recordsCount: $('recordsCount'), list: $('list'), empty: $('empty'),
  actionSheet: $('actionSheet'), sheetInfo: $('sheetInfo'), sheetEdit: $('sheetEdit'), sheetDelete: $('sheetDelete'),
  settings: $('settings'), methodLists: { expense: $('methodList'), income: $('incomeMethodList') },
  exportBtn: $('exportBtn'), importBtn: $('importBtn'), importFile: $('importFile'), dataInfo: $('dataInfo'),
  toast: $('toast'),
};

/* ---------- 렌더링 ---------- */

function renderDate() {
  const d = fromKey(state.date);
  el.dateText.textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
  el.datePicker.value = state.date;
  el.todayBtn.classList.toggle('is-today', state.date === todayKey());
}

function renderSummary() {
  const d = fromKey(state.date);
  let from, to, label;
  if (state.period === 'day') {
    from = to = state.date;
    label = state.date === todayKey() ? '오늘' : fmtMD(state.date);
  } else if (state.period === 'week') {
    [from, to] = weekRange(d);
    label = `${fmtMD(from)} – ${fmtMD(to)}`;
  } else {
    [from, to] = monthRange(d);
    label = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  }
  let inc = 0, out = 0, fixed = 0, variable = 0;
  for (const r of records) {
    if (r.date < from || r.date > to) continue;
    if (r.type === 'income') inc += r.amount;
    else {
      out += r.amount;
      if (r.costType === 'fixed') fixed += r.amount; else variable += r.amount;
    }
  }
  const diff = inc - out;
  el.periodLabel.textContent = label;
  el.sIn.textContent = won(inc);
  el.sOut.textContent = won(out);
  el.sDiff.textContent = (diff > 0 ? '+' : '') + won(diff);
  el.sDiff.classList.toggle('neg', diff < 0);
  el.sDiff.classList.toggle('income', diff > 0);
  el.sFixed.textContent = won(fixed);
  el.sVar.textContent = won(variable);
  setSeg(el.periodSeg, state.period);
  [el.sIn, el.sOut, el.sDiff].forEach(fitText);
}

// 큰 금액이 칸을 넘으면 글자 크기를 줄여 잘리지 않게 함
function fitText(node) {
  node.style.fontSize = '';
  let size = parseFloat(getComputedStyle(node).fontSize);
  while (node.scrollWidth > node.clientWidth && size > 11) {
    size -= 1;
    node.style.fontSize = size + 'px';
  }
}

function renderList() {
  const items = records
    .filter(r => r.date === state.date)
    .sort((a, b) => b.createdAt - a.createdAt);
  el.recordsTitle.textContent = state.date === todayKey() ? '오늘의 기록' : `${fmtMD(state.date)} 기록`;
  let dayIn = 0, dayOut = 0;
  for (const r of items) if (r.type === 'income') dayIn += r.amount; else dayOut += r.amount;
  el.recordsCount.textContent = items.length
    ? [dayIn && `수입 ${fmtNum(dayIn)}원`, dayOut && `지출 ${fmtNum(dayOut)}원`].filter(Boolean).join(' · ')
    : '';
  el.empty.hidden = items.length > 0;
  el.list.innerHTML = '';
  for (const r of items) {
    const li = document.createElement('li');
    li.dataset.id = r.id;
    const isIn = r.type === 'income';
    const meta = isIn
      ? ['수입', r.method].filter(Boolean).join(' · ')
      : [r.category, r.costType === 'fixed' ? '고정비' : '변동비', r.method].filter(Boolean).join(' · ');
    const t = new Date(r.createdAt);
    li.innerHTML = `
      <div class="r-icon">${isIn ? INCOME_EMOJI : CATEGORY_EMOJI[r.category] || '•'}</div>
      <div class="r-main">
        <div class="r-title"></div>
        <div class="r-meta"></div>
        ${r.memo ? '<div class="r-memo"></div>' : ''}
      </div>
      <div class="r-side">
        <div class="r-time">${pad(t.getHours())}:${pad(t.getMinutes())}</div>
        <div class="r-amt ${isIn ? 'income' : ''}">${isIn ? '+' : '-'}${fmtNum(r.amount)}원</div>
      </div>`;
    li.querySelector('.r-title').textContent = r.title || (isIn ? '수입' : r.category);
    li.querySelector('.r-meta').textContent = meta;
    if (r.memo) li.querySelector('.r-memo').textContent = r.memo;
    if (r.id === state.lastSavedId) li.classList.add('flash');
    el.list.appendChild(li);
  }
  state.lastSavedId = null;
}

function renderForm() {
  document.body.classList.toggle('income-mode', state.type === 'income');
  setSeg(el.typeSeg, state.type);
  setSeg(el.costSeg, state.costType);
  for (const b of el.catChips.children) b.classList.toggle('on', b.dataset.v === state.category);
  el.methodLabel.textContent = state.type === 'income' ? '입금수단' : '결제수단';
  el.title.placeholder = TITLE_PLACEHOLDER[state.type];
  renderMethodChips();
  el.editBanner.hidden = !state.editingId;
  el.saveBtn.textContent = state.editingId ? '수정 완료' : '기록하기';
  updateSaveBtn();
}

function renderMethodChips() {
  const list = settings.methods[state.type];
  if (!list.includes(state.method)) state.method = defaultMethod(state.type);
  el.methodChips.innerHTML = '';
  for (const m of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = m;
    b.textContent = m;
    b.classList.toggle('on', m === state.method);
    el.methodChips.appendChild(b);
  }
}

function render() {
  renderDate();
  renderSummary();
  renderList();
  renderForm();
}

function setSeg(seg, v) {
  for (const b of seg.children) b.classList.toggle('on', b.dataset.v === v);
}

function defaultMethod(type) {
  const list = settings.methods[type];
  const last = settings.lastMethod[type];
  return last && list.includes(last) ? last : list[0];
}

/* ---------- 입력 ---------- */

function getAmount() {
  return Number(el.amount.value.replace(/[^0-9]/g, '')) || 0;
}
function setAmount(n) {
  el.amount.value = n ? n.toLocaleString('ko-KR') : '';
  updateSaveBtn();
}
function updateSaveBtn() {
  el.saveBtn.disabled = getAmount() <= 0;
}

el.amount.addEventListener('input', () => {
  const digits = el.amount.value.replace(/[^0-9]/g, '').replace(/^0+/, '').slice(0, 12);
  el.amount.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
  updateSaveBtn();
});
el.amount.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); el.title.focus(); }
});
el.title.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.title.blur(); }
});

el.typeSeg.addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || v === state.type) return;
  state.type = v;
  state.method = defaultMethod(v);
  renderForm();
});

el.catChips.addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  state.category = v;
  state.costType = FIXED_DEFAULT_CATEGORIES.includes(v) ? 'fixed' : 'variable';
  renderForm();
});

el.costSeg.addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  state.costType = v;
  renderForm();
});

el.methodChips.addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  state.method = v;
  renderMethodChips();
});

el.memoToggle.addEventListener('click', () => {
  const open = el.memo.hidden;
  showMemo(open);
  if (open) el.memo.focus();
});
function showMemo(show) {
  el.memo.hidden = !show;
  el.memoToggle.textContent = show ? '− 메모 닫기' : '+ 메모 추가';
}

function resetForm() {
  state.editingId = null;
  state.category = DEFAULT_CATEGORY;
  state.costType = 'variable';
  setAmount(0);
  el.title.value = '';
  el.memo.value = '';
  showMemo(false);
}

el.saveBtn.addEventListener('click', async () => {
  const amount = getAmount();
  if (amount <= 0) return;
  const now = Date.now();
  const prev = state.editingId ? records.find(r => r.id === state.editingId) : null;
  const rec = {
    id: prev ? prev.id : (crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(36).slice(2)}`),
    type: state.type,
    date: prev ? prev.date : state.date,
    amount,
    category: state.type === 'expense' ? state.category : null,
    costType: state.type === 'expense' ? state.costType : null,
    title: el.title.value.trim(),
    memo: el.memo.value.trim(),
    method: state.method,
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
  };
  try {
    await store.put(rec);
  } catch (e) {
    alert('저장에 실패했습니다: ' + e.message);
    return;
  }
  records = records.filter(r => r.id !== rec.id).concat(rec);
  settings.lastMethod[rec.type] = rec.method;
  saveSettings();
  state.lastSavedId = rec.id;
  const wasEditing = !!prev;
  resetForm();
  el.amount.blur(); el.title.blur(); el.memo.blur();
  render();
  toast(wasEditing ? '수정했습니다' : `${won(amount)} 기록했습니다`);
});

el.cancelEdit.addEventListener('click', () => {
  state.method = defaultMethod(state.type);
  resetForm();
  renderForm();
});

/* ---------- 날짜 이동 ---------- */

function goDate(key) {
  if (!key) return;
  state.date = key;
  if (state.editingId) { resetForm(); }
  render();
}
$('prevDay').addEventListener('click', () => goDate(toKey(addDays(fromKey(state.date), -1))));
$('nextDay').addEventListener('click', () => goDate(toKey(addDays(fromKey(state.date), 1))));
el.todayBtn.addEventListener('click', () => goDate(todayKey()));
el.datePicker.addEventListener('change', () => goDate(el.datePicker.value));
el.datePicker.addEventListener('click', () => {
  try { el.datePicker.showPicker && el.datePicker.showPicker(); } catch {}
});

el.periodSeg.addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  state.period = v;
  renderSummary();
});

/* ---------- 기록 액션 시트 ---------- */

let sheetId = null;
let deleteArmed = false;

el.list.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  const r = records.find(x => x.id === li.dataset.id);
  if (!r) return;
  sheetId = r.id;
  deleteArmed = false;
  el.sheetDelete.textContent = '삭제';
  const isIn = r.type === 'income';
  el.sheetInfo.innerHTML = '<b></b><span></span>';
  el.sheetInfo.querySelector('b').textContent = `${r.title || (isIn ? '수입' : r.category)} ${isIn ? '+' : '-'}${fmtNum(r.amount)}원`;
  el.sheetInfo.querySelector('span').textContent = [fmtMD(r.date), isIn ? '수입' : `${r.category} · ${r.costType === 'fixed' ? '고정비' : '변동비'}`, r.method, r.memo].filter(Boolean).join(' · ');
  openSheet(el.actionSheet);
});

el.sheetEdit.addEventListener('click', () => {
  const r = records.find(x => x.id === sheetId);
  closeSheet(el.actionSheet);
  if (!r) return;
  state.editingId = r.id;
  state.type = r.type;
  state.category = r.category || DEFAULT_CATEGORY;
  state.costType = r.costType || 'variable';
  state.method = r.method;
  if (r.method && !settings.methods[r.type].includes(r.method)) {
    // 삭제된 결제수단이면 목록에 다시 추가해 보존
    settings.methods[r.type].push(r.method);
    saveSettings();
  }
  setAmount(r.amount);
  el.title.value = r.title || '';
  el.memo.value = r.memo || '';
  showMemo(!!r.memo);
  renderForm();
  document.getElementById('entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

el.sheetDelete.addEventListener('click', async () => {
  if (!deleteArmed) {
    deleteArmed = true;
    el.sheetDelete.textContent = '정말 삭제할까요? 한 번 더 누르세요';
    return;
  }
  const id = sheetId;
  closeSheet(el.actionSheet);
  try { await store.remove(id); } catch (e) { alert('삭제에 실패했습니다: ' + e.message); return; }
  records = records.filter(r => r.id !== id);
  if (state.editingId === id) resetForm();
  render();
  toast('삭제했습니다');
});

function openSheet(s) { s.hidden = false; }
function closeSheet(s) { s.hidden = true; }
document.querySelectorAll('.sheet-wrap').forEach(s => {
  s.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(s); });
});

/* ---------- 설정 ---------- */

$('settingsBtn').addEventListener('click', () => {
  renderSettings();
  openSheet(el.settings);
});

function renderSettings() {
  for (const type of ['expense', 'income']) renderMethodList(type);
  el.dataInfo.textContent = `저장된 기록 ${records.length.toLocaleString('ko-KR')}건`;
}

function renderMethodList(type) {
  const list = settings.methods[type];
  const ul = el.methodLists[type];
  ul.innerHTML = '';
  list.forEach((m, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <input type="text" aria-label="이름">
      <button class="mini" data-act="up" aria-label="위로" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="mini del" data-act="del" aria-label="삭제">✕</button>`;
    const input = li.querySelector('input');
    input.value = m;
    input.addEventListener('change', () => renameMethod(type, i, input.value));
    li.querySelector('[data-act=up]').addEventListener('click', () => {
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
      saveSettings(); renderSettings(); renderForm();
    });
    li.querySelector('[data-act=del]').addEventListener('click', () => {
      if (list.length <= 1) { toast('최소 1개가 필요합니다'); return; }
      if (!confirm(`'${m}'을(를) 목록에서 삭제할까요?\n기존 기록은 그대로 유지됩니다.`)) return;
      list.splice(i, 1);
      saveSettings(); renderSettings(); renderForm();
    });
    ul.appendChild(li);
  });
}

async function renameMethod(type, i, name) {
  const list = settings.methods[type];
  name = name.trim();
  const old = list[i];
  if (!name || name === old) { renderSettings(); return; }
  if (list.includes(name)) { toast('이미 있는 이름입니다'); renderSettings(); return; }
  list[i] = name;
  if (settings.lastMethod[type] === old) settings.lastMethod[type] = name;
  if (state.type === type && state.method === old) state.method = name;
  saveSettings();
  // 기존 기록의 결제수단 이름도 함께 변경
  const changed = records.filter(r => r.type === type && r.method === old).map(r => ({ ...r, method: name }));
  if (changed.length) {
    await store.putMany(changed);
    const map = new Map(changed.map(r => [r.id, r]));
    records = records.map(r => map.get(r.id) || r);
  }
  render();
  renderSettings();
}

document.querySelectorAll('.method-add').forEach(form => {
  form.addEventListener('submit', e => {
    e.preventDefault();
    const list = settings.methods[form.dataset.type];
    const input = form.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    if (list.includes(name)) { toast('이미 있는 이름입니다'); return; }
    list.push(name);
    input.value = '';
    saveSettings(); renderSettings(); renderForm();
  });
});

el.exportBtn.addEventListener('click', () => {
  const data = {
    app: 'ledger',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    records: records.slice().sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-backup-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

el.importBtn.addEventListener('click', () => el.importFile.click());
el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files[0];
  el.importFile.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(list)) throw new Error('기록 목록을 찾을 수 없습니다');
    const valid = list.filter(r => r && r.id && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number(r.amount) > 0 && (r.type === 'expense' || r.type === 'income'))
      .map(r => {
        // 예전 버전 백업은 결제수단을 payment 필드에 저장함
        const { payment, ...rest } = r;
        return { ...rest, method: r.method || payment || '', amount: Math.round(Number(r.amount)), createdAt: Number(r.createdAt) || Date.now() };
      });
    if (!confirm(`${valid.length}건의 기록을 가져올까요?\n같은 기록은 덮어쓰고, 나머지는 추가됩니다.`)) return;
    await store.putMany(valid);
    // 가져온 기록에 쓰인 결제수단이 목록에 없으면 추가
    for (const r of valid) {
      const list = settings.methods[r.type];
      if (r.method && !list.includes(r.method)) list.push(r.method);
    }
    saveSettings();
    records = await store.all();
    render();
    renderSettings();
    toast(`${valid.length}건 가져왔습니다`);
  } catch (e) {
    alert('가져오기에 실패했습니다: ' + e.message);
  }
});

/* ---------- 기타 ---------- */

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1600);
}

// 앱이 다시 열렸을 때 날짜가 바뀌었으면 오늘로 맞춤
let lastToday = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const t = todayKey();
  if (t !== lastToday) {
    if (state.date === lastToday && !state.editingId) state.date = t;
    lastToday = t;
    render();
  }
});

function buildCategoryChips() {
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = c;
    b.innerHTML = `<span class="emoji">${CATEGORY_EMOJI[c]}</span>${c}`;
    el.catChips.appendChild(b);
  }
}

async function init() {
  buildCategoryChips();
  state.method = defaultMethod(state.type);
  try { records = await store.all(); } catch (e) { records = []; }
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
