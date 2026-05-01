/**
 * Notekori – app.js
 * Single-page note-storage application.
 * All data is persisted in localStorage under the key "notekori_data".
 */

/* =====================================================================
   STORAGE HELPERS
   ===================================================================== */

const STORAGE_KEY = 'notekori_data';

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Data shape:
 * {
 *   user: { username: string, passwordHash: string },
 *   session: { loggedIn: boolean },
 *   semesters: [{ id, name, courses: [{ id, name, notes: [{ id, name, dataUrl }] }] }],
 *   looseCourses: [{ id, name, notes: [...] }]
 * }
 */
function defaultData() {
  return {
    user: null,
    session: { loggedIn: false },
    semesters: [],
    looseCourses: [],
  };
}

/* =====================================================================
   CRYPTO HELPERS
   ===================================================================== */

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/* =====================================================================
   ID GENERATOR
   ===================================================================== */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* =====================================================================
   STATE
   ===================================================================== */

let state = loadData() || defaultData();
let activeCourseId = null;   // currently viewed course id
let activeSemesterId = null; // 'loose' or a semester id

/* =====================================================================
   DOM REFERENCES
   ===================================================================== */

const $ = id => document.getElementById(id);

// Overlays / app shell
const loginOverlay = $('loginOverlay');
const appEl        = $('app');
const setupForm    = $('setupForm');
const loginForm    = $('loginForm');
const setupError   = $('setupError');
const loginError   = $('loginError');

// Navbar
const navUsername  = $('navUsername');
const logoutBtn    = $('logoutBtn');
const sidebarToggle= $('sidebarToggle');

// Sidebar
const sidebar      = $('sidebar');
const manageToggle = $('manageToggle');
const manageToolbar= $('manageToolbar');
const addSemBtn    = $('addSemesterBtn');
const addCourseBtn = $('addCourseBtn');
const courseTree   = $('courseTree');

// Note panel
const emptyState   = $('emptyState');
const courseView   = $('courseView');
const courseViewTitle = $('courseViewTitle');
const courseNoteCount = $('courseNoteCount');
const noteGallery  = $('noteGallery');
const galleryEmpty = $('galleryEmpty');
const noteUpload   = $('noteUpload');

// Modals
const inputModal        = $('inputModal');
const inputModalTitle   = $('inputModalTitle');
const inputModalLabel   = $('inputModalLabel');
const inputModalField   = $('inputModalField');
const inputModalCancel  = $('inputModalCancel');
const inputModalConfirm = $('inputModalConfirm');

const confirmModal        = $('confirmModal');
const confirmModalTitle   = $('confirmModalTitle');
const confirmModalMessage = $('confirmModalMessage');
const confirmModalCancel  = $('confirmModalCancel');
const confirmModalConfirm = $('confirmModalConfirm');

// Lightbox
const lightbox      = $('lightbox');
const lightboxOverlay = $('lightboxOverlay');
const lightboxImg   = $('lightboxImg');
const lightboxClose = $('lightboxClose');
const lightboxPrev  = $('lightboxPrev');
const lightboxNext  = $('lightboxNext');
const lightboxIndex = $('lightboxIndex');
const lightboxName  = $('lightboxName');
let lightboxNotes   = [];
let lightboxCurrent = 0;

/* =====================================================================
   MODAL HELPERS (Promise-based)
   ===================================================================== */

function showInputModal({ title, label, defaultValue = '', placeholder = '' }) {
  return new Promise(resolve => {
    inputModalTitle.textContent  = title;
    inputModalLabel.textContent  = label;
    inputModalField.value        = defaultValue;
    inputModalField.placeholder  = placeholder;
    inputModal.classList.remove('hidden');
    inputModalField.focus();

    function cleanup(result) {
      inputModal.classList.add('hidden');
      inputModalConfirm.removeEventListener('click', onConfirm);
      inputModalCancel.removeEventListener('click', onCancel);
      inputModalField.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onConfirm() { cleanup(inputModalField.value.trim()); }
    function onCancel()  { cleanup(null); }
    function onKey(e) { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }

    inputModalConfirm.addEventListener('click', onConfirm);
    inputModalCancel.addEventListener('click', onCancel);
    inputModalField.addEventListener('keydown', onKey);
  });
}

function showConfirmModal({ title, message, confirmLabel = 'Delete' }) {
  return new Promise(resolve => {
    confirmModalTitle.textContent   = title;
    confirmModalMessage.textContent = message;
    confirmModalConfirm.textContent = confirmLabel;
    confirmModal.classList.remove('hidden');

    function cleanup(result) {
      confirmModal.classList.add('hidden');
      confirmModalConfirm.removeEventListener('click', onConfirm);
      confirmModalCancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel()  { cleanup(false); }

    confirmModalConfirm.addEventListener('click', onConfirm);
    confirmModalCancel.addEventListener('click', onCancel);
  });
}

/* =====================================================================
   AUTH
   ===================================================================== */

async function initAuth() {
  if (!state.user) {
    // First run – show setup form
    setupForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
    loginOverlay.classList.remove('hidden');
    appEl.classList.add('hidden');
  } else if (state.session && state.session.loggedIn) {
    showApp();
  } else {
    loginForm.classList.remove('hidden');
    setupForm.classList.add('hidden');
    loginOverlay.classList.remove('hidden');
    appEl.classList.add('hidden');
  }
}

setupForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('setupUser').value.trim();
  const password = $('setupPass').value;
  const confirm  = $('setupPassConfirm').value;

  setupError.classList.add('hidden');

  if (!username) { showSetupError('Please enter a username.'); return; }
  if (password.length < 4) { showSetupError('Password must be at least 4 characters.'); return; }
  if (password !== confirm) { showSetupError('Passwords do not match.'); return; }

  const hash = await hashPassword(password);
  state.user = { username, passwordHash: hash };
  state.session = { loggedIn: true };
  saveData(state);
  showApp();
});

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;

  loginError.classList.add('hidden');

  if (!state.user) { showLoginError('No account found. Please refresh.'); return; }
  if (username !== state.user.username) { showLoginError('Incorrect username or password.'); return; }

  const hash = await hashPassword(password);
  if (hash !== state.user.passwordHash) { showLoginError('Incorrect username or password.'); return; }

  state.session = { loggedIn: true };
  saveData(state);
  showApp();
});

logoutBtn.addEventListener('click', () => {
  state.session = { loggedIn: false };
  saveData(state);
  activeCourseId = null;
  activeSemesterId = null;
  $('loginUser').value = '';
  $('loginPass').value = '';
  loginError.classList.add('hidden');
  loginForm.classList.remove('hidden');
  setupForm.classList.add('hidden');
  appEl.classList.add('hidden');
  loginOverlay.classList.remove('hidden');
});

function showApp() {
  loginOverlay.classList.add('hidden');
  appEl.classList.remove('hidden');
  navUsername.textContent = state.user ? state.user.username : '';
  renderTree();
  renderNotePanel();
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove('hidden');
}
function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

/* =====================================================================
   SIDEBAR TOGGLE
   ===================================================================== */

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

/* =====================================================================
   MANAGE TOOLBAR
   ===================================================================== */

manageToggle.addEventListener('click', () => {
  const open = !manageToolbar.classList.contains('hidden');
  manageToolbar.classList.toggle('hidden', open);
  manageToggle.textContent = open ? 'Manage ▾' : 'Manage ▴';
});

/* =====================================================================
   SEMESTER CRUD
   ===================================================================== */

addSemBtn.addEventListener('click', async () => {
  const name = await showInputModal({
    title: 'New Semester',
    label: 'Semester name',
    placeholder: 'e.g. Spring 2024',
  });
  if (!name) return;
  state.semesters.push({ id: uid(), name, courses: [] });
  saveData(state);
  renderTree();
});

async function renameSemester(semId) {
  const sem = state.semesters.find(s => s.id === semId);
  if (!sem) return;
  const name = await showInputModal({
    title: 'Rename Semester',
    label: 'Semester name',
    defaultValue: sem.name,
  });
  if (!name || name === sem.name) return;
  sem.name = name;
  saveData(state);
  renderTree();
}

async function deleteSemester(semId) {
  const sem = state.semesters.find(s => s.id === semId);
  if (!sem) return;
  const ok = await showConfirmModal({
    title: 'Delete Semester',
    message: `Delete "${sem.name}" and all its courses and notes? This cannot be undone.`,
  });
  if (!ok) return;
  state.semesters = state.semesters.filter(s => s.id !== semId);
  if (activeSemesterId === semId) {
    activeSemesterId = null;
    activeCourseId   = null;
    renderNotePanel();
  }
  saveData(state);
  renderTree();
}

/* =====================================================================
   COURSE CRUD
   ===================================================================== */

addCourseBtn.addEventListener('click', async () => {
  // Ask where to add (semester or loose)
  const target = await pickTarget();
  if (target === null) return;

  const name = await showInputModal({
    title: 'New Course',
    label: 'Course name',
    placeholder: 'e.g. Introduction to Physics',
  });
  if (!name) return;

  const course = { id: uid(), name, notes: [] };
  if (target === 'loose') {
    state.looseCourses.push(course);
  } else {
    const sem = state.semesters.find(s => s.id === target);
    if (sem) sem.courses.push(course);
  }
  saveData(state);
  renderTree();
});

/**
 * Simple target picker: shows a confirm-style modal listing semesters.
 * Returns 'loose', a semester id, or null on cancel.
 */
function pickTarget() {
  return new Promise(resolve => {
    // Build a small selection list
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>Add Course To…</h3>
        <div id="targetList" style="display:flex;flex-direction:column;gap:.35rem;margin-bottom:1rem;max-height:220px;overflow-y:auto;"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="targetCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const list = backdrop.querySelector('#targetList');

    // Loose option
    const looseBtn = document.createElement('button');
    looseBtn.className = 'btn btn-outline btn-sm';
    looseBtn.textContent = '📂 No Semester (Loose)';
    looseBtn.addEventListener('click', () => { document.body.removeChild(backdrop); resolve('loose'); });
    list.appendChild(looseBtn);

    state.semesters.forEach(sem => {
      const b = document.createElement('button');
      b.className = 'btn btn-outline btn-sm';
      b.textContent = `📁 ${sem.name}`;
      b.addEventListener('click', () => { document.body.removeChild(backdrop); resolve(sem.id); });
      list.appendChild(b);
    });

    backdrop.querySelector('#targetCancel').addEventListener('click', () => {
      document.body.removeChild(backdrop);
      resolve(null);
    });
  });
}

async function renameCourse(courseId, semId) {
  const course = findCourse(courseId);
  if (!course) return;
  const name = await showInputModal({
    title: 'Rename Course',
    label: 'Course name',
    defaultValue: course.name,
  });
  if (!name || name === course.name) return;
  course.name = name;
  saveData(state);
  renderTree();
  if (activeCourseId === courseId) {
    courseViewTitle.textContent = name;
  }
}

async function deleteCourse(courseId) {
  const course = findCourse(courseId);
  if (!course) return;
  const ok = await showConfirmModal({
    title: 'Delete Course',
    message: `Delete "${course.name}" and all its notes? This cannot be undone.`,
  });
  if (!ok) return;

  // Remove from semesters
  state.semesters.forEach(sem => {
    sem.courses = sem.courses.filter(c => c.id !== courseId);
  });
  state.looseCourses = state.looseCourses.filter(c => c.id !== courseId);

  if (activeCourseId === courseId) {
    activeCourseId   = null;
    activeSemesterId = null;
    renderNotePanel();
  }
  saveData(state);
  renderTree();
}

/* Add course directly inside a semester via the ＋ button */
async function addCourseToSemester(semId) {
  const name = await showInputModal({
    title: 'New Course',
    label: 'Course name',
    placeholder: 'e.g. Introduction to Physics',
  });
  if (!name) return;
  const sem = state.semesters.find(s => s.id === semId);
  if (!sem) return;
  sem.courses.push({ id: uid(), name, notes: [] });
  saveData(state);
  renderTree();
}

/* =====================================================================
   FIND HELPERS
   ===================================================================== */

function findCourse(courseId) {
  for (const sem of state.semesters) {
    const c = sem.courses.find(c => c.id === courseId);
    if (c) return c;
  }
  return state.looseCourses.find(c => c.id === courseId) || null;
}

/* =====================================================================
   RENDER SIDEBAR TREE
   ===================================================================== */

// Track open/closed semesters
const openSemesters = new Set();

function renderTree() {
  courseTree.innerHTML = '';

  // Semesters
  state.semesters.forEach(sem => {
    const item = document.createElement('div');
    item.className = 'semester-item' + (openSemesters.has(sem.id) ? ' open' : '');
    item.dataset.semId = sem.id;

    const header = document.createElement('div');
    header.className = 'semester-header';
    header.innerHTML = `
      <span class="semester-chevron">▶</span>
      <span class="semester-name" title="${escHtml(sem.name)}">📁 ${escHtml(sem.name)}</span>
      <span class="tree-item-actions">
        <button class="tree-action-btn add-course-in-sem" title="Add course" data-sem="${sem.id}">＋</button>
        <button class="tree-action-btn rename-sem" title="Rename" data-sem="${sem.id}">✎</button>
        <button class="tree-action-btn del delete-sem" title="Delete" data-sem="${sem.id}">🗑</button>
      </span>`;

    header.addEventListener('click', e => {
      if (e.target.closest('.tree-item-actions')) return;
      item.classList.toggle('open');
      if (item.classList.contains('open')) openSemesters.add(sem.id);
      else openSemesters.delete(sem.id);
    });

    header.querySelector('.add-course-in-sem').addEventListener('click', e => {
      e.stopPropagation();
      addCourseToSemester(sem.id);
    });
    header.querySelector('.rename-sem').addEventListener('click', e => {
      e.stopPropagation();
      renameSemester(sem.id);
    });
    header.querySelector('.delete-sem').addEventListener('click', e => {
      e.stopPropagation();
      deleteSemester(sem.id);
    });

    const coursesEl = document.createElement('div');
    coursesEl.className = 'semester-courses';
    sem.courses.forEach(course => {
      coursesEl.appendChild(buildCourseRow(course, sem.id));
    });

    item.appendChild(header);
    item.appendChild(coursesEl);
    courseTree.appendChild(item);
  });

  // Loose courses (no semester)
  if (state.looseCourses.length > 0) {
    const loose = document.createElement('div');
    loose.className = 'loose-courses';
    state.looseCourses.forEach(course => {
      loose.appendChild(buildCourseRow(course, 'loose'));
    });
    courseTree.appendChild(loose);
  }
}

function buildCourseRow(course, semId) {
  const row = document.createElement('div');
  row.className = 'course-row' + (activeCourseId === course.id ? ' active' : '');
  row.dataset.courseId = course.id;
  row.innerHTML = `
    <span class="course-icon">📄</span>
    <span class="course-name" title="${escHtml(course.name)}">${escHtml(course.name)}</span>
    <span class="tree-item-actions">
      <button class="tree-action-btn rename-course" title="Rename" data-course="${course.id}" data-sem="${semId}">✎</button>
      <button class="tree-action-btn del delete-course" title="Delete" data-course="${course.id}">🗑</button>
    </span>`;

  row.addEventListener('click', e => {
    if (e.target.closest('.tree-item-actions')) return;
    selectCourse(course.id, semId);
  });
  row.querySelector('.rename-course').addEventListener('click', e => {
    e.stopPropagation();
    renameCourse(course.id, semId);
  });
  row.querySelector('.delete-course').addEventListener('click', e => {
    e.stopPropagation();
    deleteCourse(course.id);
  });

  return row;
}

/* =====================================================================
   RENDER NOTE PANEL
   ===================================================================== */

function renderNotePanel() {
  if (!activeCourseId) {
    emptyState.classList.remove('hidden');
    courseView.classList.add('hidden');
    return;
  }

  const course = findCourse(activeCourseId);
  if (!course) {
    activeCourseId = null;
    emptyState.classList.remove('hidden');
    courseView.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  courseView.classList.remove('hidden');

  courseViewTitle.textContent = course.name;
  courseNoteCount.textContent = course.notes.length === 0
    ? 'No notes yet'
    : `${course.notes.length} note${course.notes.length !== 1 ? 's' : ''}`;

  renderGallery(course);
}

function renderGallery(course) {
  noteGallery.innerHTML = '';

  if (course.notes.length === 0) {
    galleryEmpty.classList.remove('hidden');
    return;
  }
  galleryEmpty.classList.add('hidden');

  course.notes.forEach((note, idx) => {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.draggable = true;
    card.dataset.noteId = note.id;
    card.dataset.idx = idx;

    const img = document.createElement('img');
    img.className = 'note-thumb';
    img.src = note.dataUrl;
    img.alt = note.name;
    img.loading = 'lazy';

    const footer = document.createElement('div');
    footer.className = 'note-card-footer';
    footer.innerHTML = `
      <span class="note-card-name" title="${escHtml(note.name)}">${escHtml(note.name)}</span>
      <span class="note-card-actions">
        <button class="note-card-btn rename-note" title="Rename note" data-note="${note.id}">✎</button>
        <button class="note-card-btn del delete-note" title="Delete note" data-note="${note.id}">🗑</button>
      </span>`;

    card.appendChild(img);
    card.appendChild(footer);

    // Click image -> open lightbox
    img.addEventListener('click', () => openLightbox(course.notes, idx));

    footer.querySelector('.rename-note').addEventListener('click', e => {
      e.stopPropagation();
      renameNote(note.id);
    });
    footer.querySelector('.delete-note').addEventListener('click', e => {
      e.stopPropagation();
      deleteNote(note.id);
    });

    // Drag-to-reorder
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragover',  onDragOver);
    card.addEventListener('drop',      onDrop);
    card.addEventListener('dragend',   onDragEnd);

    noteGallery.appendChild(card);
  });
}

/* =====================================================================
   SELECT COURSE
   ===================================================================== */

function selectCourse(courseId, semId) {
  activeCourseId   = courseId;
  activeSemesterId = semId;

  // Update active class in tree
  document.querySelectorAll('.course-row').forEach(r => {
    r.classList.toggle('active', r.dataset.courseId === courseId);
  });

  // On mobile, collapse sidebar after selecting
  if (window.innerWidth <= 640) {
    sidebar.classList.add('collapsed');
  }

  renderNotePanel();
}

/* =====================================================================
   NOTE UPLOAD
   ===================================================================== */

noteUpload.addEventListener('change', async () => {
  const files = Array.from(noteUpload.files);
  if (!files.length || !activeCourseId) return;

  const course = findCourse(activeCourseId);
  if (!course) return;

  for (const file of files) {
    const dataUrl = await readFileAsDataURL(file);
    const name = file.name.replace(/\.[^/.]+$/, '') || `Note ${Date.now()}`;
    course.notes.push({ id: uid(), name, dataUrl });
  }

  saveData(state);
  // Reset file input so same file can be uploaded again if needed
  noteUpload.value = '';
  renderNotePanel();
});

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/* =====================================================================
   NOTE CRUD
   ===================================================================== */

async function renameNote(noteId) {
  const course = findCourse(activeCourseId);
  if (!course) return;
  const note = course.notes.find(n => n.id === noteId);
  if (!note) return;

  const name = await showInputModal({
    title: 'Rename Note',
    label: 'Note name',
    defaultValue: note.name,
  });
  if (!name || name === note.name) return;
  note.name = name;
  saveData(state);
  renderNotePanel();
}

async function deleteNote(noteId) {
  const course = findCourse(activeCourseId);
  if (!course) return;
  const note = course.notes.find(n => n.id === noteId);
  if (!note) return;

  const ok = await showConfirmModal({
    title: 'Delete Note',
    message: `Delete "${note.name}"? This cannot be undone.`,
  });
  if (!ok) return;
  course.notes = course.notes.filter(n => n.id !== noteId);
  saveData(state);
  renderNotePanel();
}

/* =====================================================================
   DRAG-TO-REORDER
   ===================================================================== */

let dragSrcIdx = null;

function onDragStart(e) {
  dragSrcIdx = parseInt(this.dataset.idx, 10);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over'));
  this.classList.add('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const targetIdx = parseInt(this.dataset.idx, 10);
  if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;

  const course = findCourse(activeCourseId);
  if (!course) return;

  const notes = course.notes;
  const [moved] = notes.splice(dragSrcIdx, 1);
  notes.splice(targetIdx, 0, moved);

  saveData(state);
  renderGallery(course);
}

function onDragEnd() {
  dragSrcIdx = null;
  document.querySelectorAll('.note-card').forEach(c => {
    c.classList.remove('dragging', 'drag-over');
  });
}

/* =====================================================================
   LIGHTBOX
   ===================================================================== */

function openLightbox(notes, idx) {
  lightboxNotes   = notes;
  lightboxCurrent = idx;
  updateLightbox();
  lightbox.classList.remove('hidden');
  document.addEventListener('keydown', lightboxKeyHandler);
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  document.removeEventListener('keydown', lightboxKeyHandler);
}

function updateLightbox() {
  const note = lightboxNotes[lightboxCurrent];
  lightboxImg.src  = note.dataUrl;
  lightboxImg.alt  = note.name;
  lightboxIndex.textContent = `${lightboxCurrent + 1} / ${lightboxNotes.length}`;
  lightboxName.textContent  = note.name;
  const atStart = lightboxCurrent === 0;
  const atEnd   = lightboxCurrent === lightboxNotes.length - 1;
  lightboxPrev.disabled = atStart;
  lightboxNext.disabled = atEnd;
  lightboxPrev.setAttribute('aria-disabled', String(atStart));
  lightboxNext.setAttribute('aria-disabled', String(atEnd));
}

function lightboxKeyHandler(e) {
  if (e.key === 'Escape')     closeLightbox();
  if (e.key === 'ArrowLeft')  moveLightbox(-1);
  if (e.key === 'ArrowRight') moveLightbox(1);
}

function moveLightbox(dir) {
  const next = lightboxCurrent + dir;
  if (next < 0 || next >= lightboxNotes.length) return;
  lightboxCurrent = next;
  updateLightbox();
}

lightboxClose.addEventListener('click', closeLightbox);
lightboxOverlay.addEventListener('click', closeLightbox);
lightboxPrev.addEventListener('click', () => moveLightbox(-1));
lightboxNext.addEventListener('click', () => moveLightbox(1));

/* =====================================================================
   ESCAPE HTML
   ===================================================================== */

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* =====================================================================
   CLOSE MODALS ON BACKDROP CLICK
   ===================================================================== */

inputModal.addEventListener('click', e => {
  if (e.target === inputModal) inputModalCancel.click();
});
confirmModal.addEventListener('click', e => {
  if (e.target === confirmModal) confirmModalCancel.click();
});

/* =====================================================================
   BOOT
   ===================================================================== */

initAuth();
