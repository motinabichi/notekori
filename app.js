/**
 * Notekori – app.js
 * Firebase Auth + Firestore backend.
 */

/* =====================================================================
   CONSTANTS
   ===================================================================== */

const TERMS = [
  { id: 'midterm', name: 'Midterm' },
  { id: 'final',   name: 'Final'   }
];

/* =====================================================================
   UTILITIES
   ===================================================================== */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function shareUrl(username, semName, courseName, termName, code) {
  const parts = [username, semName, courseName, termName]
    .filter(Boolean)
    .map(s => encodeURIComponent(s.toLowerCase().replace(/\s+/g, '-')));
  return location.origin + '/#/share/' + parts.join('/') + '/' + code;
}

async function compressImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 1200;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const r = Math.min(maxDim / width, maxDim / height);
          width  = Math.round(width  * r);
          height = Math.round(height * r);
        }
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        let q = 0.82, dataUrl;
        do { dataUrl = canvas.toDataURL('image/jpeg', q); q -= 0.08; }
        while (dataUrl.length > 700000 && q > 0.2);
        resolve(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function friendlyAuthError(err) {
  const map = {
    'auth/user-not-found':        'No account found with this email.',
    'auth/wrong-password':         'Incorrect password.',
    'auth/invalid-email':          'Invalid email address.',
    'auth/email-already-in-use':   'Email is already in use.',
    'auth/weak-password':          'Password is too weak (min 6 chars).',
    'auth/too-many-requests':      'Too many attempts. Please try again later.',
    'auth/invalid-credential':     'Invalid credentials. Please check and try again.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/requires-recent-login':  'Please log out and log back in, then try again.',
  };
  return map[err.code] || err.message || 'An unexpected error occurred.';
}

/* =====================================================================
   FIREBASE SETUP
   ===================================================================== */

let auth, db;
let firebaseReady = false;

try {
  if (typeof firebaseConfig !== 'undefined' &&
      firebaseConfig.apiKey &&
      firebaseConfig.apiKey !== 'YOUR_API_KEY') {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db   = firebase.firestore();
    firebaseReady = true;
  }
} catch (e) {
  console.error('Firebase init error:', e);
}

/* =====================================================================
   STATE
   ===================================================================== */

let currentUser      = null;
let userData         = null;   // { username, semesters, looseCourses, shareLinks }
let activeCourseId   = null;
let activeTermId     = null;   // 'midterm' | 'final'
let activeSemesterId = null;   // semester id | 'loose'
let currentNotes     = [];
let currentCourseName   = '';
let currentTermName     = '';
let currentSemesterName = '';
let pdfNotes            = [];
let lightboxNotes       = [];
let lightboxCurrent     = 0;
let lightboxIsShared    = false;
let dragSrcIndex        = null;
let saveUserDataTimer   = null;
const openSemesters     = new Set();
const openCourses       = new Set();

/* =====================================================================
   DOM HELPER
   ===================================================================== */

const $ = id => document.getElementById(id);
const showEl = id => $(id).classList.remove('hidden');
const hideEl = id => $(id).classList.add('hidden');

/* =====================================================================
   ROUTING
   ===================================================================== */

function getHashPath() {
  return location.hash.replace(/^#/, '');
}

function isShareRoute() {
  return getHashPath().startsWith('/share/');
}

function parseShareCode() {
  const segments = getHashPath().split('/').filter(Boolean);
  // Last segment is always the code
  return segments[segments.length - 1] || null;
}

/* =====================================================================
   INIT
   ===================================================================== */

window.addEventListener('load', () => {
  if (!firebaseReady) {
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;' +
      'font-family:sans-serif;padding:2rem;text-align:center;background:#f5f6fa;">' +
      '<div><h2 style="font-size:1.5rem;">⚠️ Firebase not configured</h2>' +
      '<p style="color:#666;margin-top:.75rem;">Edit <code>firebase-config.js</code> with your ' +
      'Firebase project credentials to get started.</p></div></div>';
    return;
  }

  if (isShareRoute()) {
    showSharedView();
    return;
  }

  auth.onAuthStateChanged(user => {
    if (user) {
      currentUser = user;
      initApp();
    } else {
      currentUser = null;
      userData    = null;
      showAuthUI();
    }
  });
});

/* =====================================================================
   AUTH UI
   ===================================================================== */

function showAuthUI() {
  hideEl('app');
  hideEl('sharedView');
  showEl('loginOverlay');
  showAuthForm('loginForm');
}

function showAuthForm(formId) {
  ['loginForm', 'setupForm', 'forgotForm'].forEach(id => {
    if (id === formId) showEl(id); else hideEl(id);
  });
}

$('showSignupBtn') .addEventListener('click', () => showAuthForm('setupForm'));
$('showLoginBtn')  .addEventListener('click', () => showAuthForm('loginForm'));
$('showForgotBtn') .addEventListener('click', () => showAuthForm('forgotForm'));
$('backToLoginBtn').addEventListener('click', () => showAuthForm('loginForm'));

/* ── Sign In ── */
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input    = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const errEl    = $('loginError');
  hideEl('loginError');

  if (!input || !password) {
    setFormError(errEl, 'Please fill in all fields.'); return;
  }

  let email = input;
  if (!input.includes('@')) {
    // Username lookup
    try {
      const snap = await db.collection('usernames').doc(input.toLowerCase()).get();
      if (!snap.exists) { setFormError(errEl, 'Username not found.'); return; }
      email = snap.data().email;
    } catch (err) {
      setFormError(errEl, 'Error looking up username. Please try again.'); return;
    }
  }

  try {
    await auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged fires → initApp()
  } catch (err) {
    setFormError(errEl, friendlyAuthError(err));
  }
});

/* ── Sign Up ── */
$('setupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('setupUser').value.trim().toLowerCase();
  const email    = $('setupEmail').value.trim();
  const password = $('setupPass').value;
  const confirm  = $('setupPassConfirm').value;
  const errEl    = $('setupError');
  hideEl('setupError');

  if (!username) { setFormError(errEl, 'Please enter a username.'); return; }
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    setFormError(errEl, 'Username: 3–20 characters, letters/numbers/underscore only.'); return;
  }
  if (!email)           { setFormError(errEl, 'Please enter an email.'); return; }
  if (password.length < 6) { setFormError(errEl, 'Password must be at least 6 characters.'); return; }
  if (password !== confirm) { setFormError(errEl, 'Passwords do not match.'); return; }

  try {
    const usernameSnap = await db.collection('usernames').doc(username).get();
    if (usernameSnap.exists) { setFormError(errEl, 'That username is already taken.'); return; }

    const cred = await auth.createUserWithEmailAndPassword(email, password);
    const newUid = cred.user.uid;

    const newUserData = { username, semesters: [], looseCourses: [], shareLinks: {} };
    await db.collection('users').doc(newUid).set(newUserData);
    await db.collection('usernames').doc(username).set({ uid: newUid, email });
    // onAuthStateChanged fires
  } catch (err) {
    setFormError(errEl, friendlyAuthError(err));
  }
});

/* ── Forgot Password ── */
$('forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('forgotEmail').value.trim();
  hideEl('forgotError');
  hideEl('forgotSuccess');

  if (!email) { setFormError($('forgotError'), 'Please enter your email.'); return; }

  try {
    await auth.sendPasswordResetEmail(email);
    $('forgotSuccess').textContent = 'Reset email sent! Check your inbox.';
    showEl('forgotSuccess');
  } catch (err) {
    setFormError($('forgotError'), friendlyAuthError(err));
  }
});

function setFormError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

/* =====================================================================
   APP INIT
   ===================================================================== */

async function initApp() {
  try {
    await loadUserData();
    hideEl('loginOverlay');
    hideEl('sharedView');
    showEl('app');
    $('navUsername').textContent = userData.username || currentUser.email;
    renderTree();
    showEmptyState();
  } catch (err) {
    console.error('App init failed:', err);
    auth.signOut();
  }
}

async function loadUserData() {
  const snap = await db.collection('users').doc(currentUser.uid).get();
  if (snap.exists) {
    userData = snap.data();
    if (!userData.semesters)   userData.semesters   = [];
    if (!userData.looseCourses) userData.looseCourses = [];
    if (!userData.shareLinks)  userData.shareLinks  = {};
  } else {
    userData = { username: '', semesters: [], looseCourses: [], shareLinks: {} };
  }
}

function debouncedSaveUserData() {
  clearTimeout(saveUserDataTimer);
  saveUserDataTimer = setTimeout(saveUserDataNow, 800);
}

async function saveUserDataNow() {
  if (!currentUser || !userData) return;
  try {
    await db.collection('users').doc(currentUser.uid).set(userData);
  } catch (err) {
    console.error('Save user data failed:', err);
  }
}

/* =====================================================================
   LOGOUT
   ===================================================================== */

$('logoutBtn').addEventListener('click', async () => {
  await saveUserDataNow();
  activeCourseId   = null;
  activeTermId     = null;
  activeSemesterId = null;
  currentNotes     = [];
  openSemesters.clear();
  openCourses.clear();
  $('loginUser').value = '';
  $('loginPass').value = '';
  hideEl('loginError');
  await auth.signOut();
  // onAuthStateChanged fires → showAuthUI()
});

/* =====================================================================
   SIDEBAR TOGGLE
   ===================================================================== */

$('sidebarToggle').addEventListener('click', () => {
  $('sidebar').classList.toggle('collapsed');
});

/* =====================================================================
   MANAGE TOOLBAR
   ===================================================================== */

$('manageToggle').addEventListener('click', () => {
  const open = !$('manageToolbar').classList.contains('hidden');
  $('manageToolbar').classList.toggle('hidden', open);
  $('manageToggle').textContent = open ? 'Manage ▾' : 'Manage ▴';
});

/* =====================================================================
   SEMESTER CRUD
   ===================================================================== */

$('addSemesterBtn').addEventListener('click', async () => {
  const name = await showInputModal({
    title: 'New Semester', label: 'Semester name', placeholder: 'e.g. Spring 2024'
  });
  if (!name) return;
  userData.semesters.push({ id: uid(), name, courses: [] });
  debouncedSaveUserData();
  renderTree();
});

async function renameSemester(semId) {
  const sem = userData.semesters.find(s => s.id === semId);
  if (!sem) return;
  const name = await showInputModal({
    title: 'Rename Semester', label: 'Semester name', defaultValue: sem.name
  });
  if (!name || name === sem.name) return;
  sem.name = name;
  debouncedSaveUserData();
  renderTree();
  if (activeSemesterId === semId) updateCourseViewTitle();
}

async function deleteSemester(semId) {
  const sem = userData.semesters.find(s => s.id === semId);
  if (!sem) return;
  const ok = await showConfirmModal({
    title: 'Delete Semester',
    message: `Delete "${sem.name}" and all its courses and notes? This cannot be undone.`
  });
  if (!ok) return;
  for (const course of sem.courses) {
    for (const term of TERMS) await deleteTermNotes(course.id, term.id);
  }
  userData.semesters = userData.semesters.filter(s => s.id !== semId);
  if (activeSemesterId === semId) {
    activeCourseId = null; activeTermId = null; activeSemesterId = null;
    showEmptyState();
  }
  debouncedSaveUserData();
  renderTree();
}

/* =====================================================================
   COURSE CRUD
   ===================================================================== */

$('addCourseBtn').addEventListener('click', async () => {
  const target = await pickTarget();
  if (target === null) return;
  const name = await showInputModal({
    title: 'New Course', label: 'Course name', placeholder: 'e.g. Introduction to Physics'
  });
  if (!name) return;
  const course = { id: uid(), name };
  if (target === 'loose') {
    userData.looseCourses.push(course);
  } else {
    const sem = userData.semesters.find(s => s.id === target);
    if (sem) sem.courses.push(course);
  }
  debouncedSaveUserData();
  renderTree();
});

async function addCourseToSemester(semId) {
  const name = await showInputModal({
    title: 'New Course', label: 'Course name', placeholder: 'e.g. Introduction to Physics'
  });
  if (!name) return;
  const sem = userData.semesters.find(s => s.id === semId);
  if (!sem) return;
  sem.courses.push({ id: uid(), name });
  debouncedSaveUserData();
  renderTree();
}

async function renameCourse(courseId) {
  const course = findCourse(courseId);
  if (!course) return;
  const name = await showInputModal({
    title: 'Rename Course', label: 'Course name', defaultValue: course.name
  });
  if (!name || name === course.name) return;
  course.name = name;
  debouncedSaveUserData();
  renderTree();
  if (activeCourseId === courseId) {
    currentCourseName = name;
    updateCourseViewTitle();
  }
}

async function deleteCourse(courseId) {
  const course = findCourse(courseId);
  if (!course) return;
  const ok = await showConfirmModal({
    title: 'Delete Course',
    message: `Delete "${course.name}" and all its notes? This cannot be undone.`
  });
  if (!ok) return;
  for (const term of TERMS) await deleteTermNotes(courseId, term.id);
  userData.semesters.forEach(sem => {
    sem.courses = sem.courses.filter(c => c.id !== courseId);
  });
  userData.looseCourses = userData.looseCourses.filter(c => c.id !== courseId);
  if (activeCourseId === courseId) {
    activeCourseId = null; activeTermId = null; activeSemesterId = null;
    showEmptyState();
  }
  debouncedSaveUserData();
  renderTree();
}

async function deleteTermNotes(courseId, termId) {
  try {
    const snap = await db.collection('users').doc(currentUser.uid).collection('notes')
      .where('courseId', '==', courseId)
      .where('termId',   '==', termId)
      .get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  } catch (err) {
    console.error('deleteTermNotes failed:', err);
  }
}

/* =====================================================================
   FIND HELPERS
   ===================================================================== */

function findCourse(courseId) {
  for (const sem of userData.semesters) {
    const c = sem.courses.find(c => c.id === courseId);
    if (c) return c;
  }
  return userData.looseCourses.find(c => c.id === courseId) || null;
}

/* =====================================================================
   PICK TARGET
   ===================================================================== */

function pickTarget() {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal">' +
        '<h3>Add Course To\u2026</h3>' +
        '<div id="targetList" style="display:flex;flex-direction:column;gap:.35rem;margin-bottom:1rem;max-height:220px;overflow-y:auto;"></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" id="targetCancel">Cancel</button></div>' +
      '</div>';
    document.body.appendChild(backdrop);
    const list = backdrop.querySelector('#targetList');

    const looseBtn = document.createElement('button');
    looseBtn.className = 'btn btn-outline btn-sm';
    looseBtn.textContent = '📂 No Semester (Loose)';
    looseBtn.addEventListener('click', () => { document.body.removeChild(backdrop); resolve('loose'); });
    list.appendChild(looseBtn);

    userData.semesters.forEach(sem => {
      const b = document.createElement('button');
      b.className = 'btn btn-outline btn-sm';
      b.textContent = '📁 ' + sem.name;
      b.addEventListener('click', () => { document.body.removeChild(backdrop); resolve(sem.id); });
      list.appendChild(b);
    });
    backdrop.querySelector('#targetCancel').addEventListener('click', () => {
      document.body.removeChild(backdrop); resolve(null);
    });
  });
}

/* =====================================================================
   RENDER SIDEBAR TREE
   ===================================================================== */

function renderTree() {
  const tree = $('courseTree');
  tree.innerHTML = '';

  userData.semesters.forEach(sem => {
    const item = document.createElement('div');
    item.className = 'semester-item' + (openSemesters.has(sem.id) ? ' open' : '');

    const header = document.createElement('div');
    header.className = 'semester-header';
    header.innerHTML =
      '<span class="semester-chevron">\u25b6</span>' +
      '<span class="semester-name" title="' + escHtml(sem.name) + '">\ud83d\udcc1 ' + escHtml(sem.name) + '</span>' +
      '<span class="tree-item-actions">' +
        '<button class="tree-action-btn" title="Add course">+</button>' +
        '<button class="tree-action-btn" title="Rename">\u270e</button>' +
        '<button class="tree-action-btn del" title="Delete">\u2715</button>' +
      '</span>';

    const btns = header.querySelectorAll('.tree-action-btn');
    btns[0].addEventListener('click', e => { e.stopPropagation(); addCourseToSemester(sem.id); });
    btns[1].addEventListener('click', e => { e.stopPropagation(); renameSemester(sem.id); });
    btns[2].addEventListener('click', e => { e.stopPropagation(); deleteSemester(sem.id); });

    header.addEventListener('click', e => {
      if (e.target.closest('.tree-item-actions')) return;
      item.classList.toggle('open');
      if (item.classList.contains('open')) openSemesters.add(sem.id);
      else openSemesters.delete(sem.id);
    });

    const coursesEl = document.createElement('div');
    coursesEl.className = 'semester-courses';
    sem.courses.forEach(course => coursesEl.appendChild(buildCourseEntry(course, sem.id, sem.name)));

    item.appendChild(header);
    item.appendChild(coursesEl);
    tree.appendChild(item);
  });

  if (userData.looseCourses.length > 0) {
    const loose = document.createElement('div');
    loose.className = 'loose-courses';
    if (userData.semesters.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'loose-sep';
      sep.textContent = 'Other Courses';
      loose.appendChild(sep);
    }
    userData.looseCourses.forEach(course => loose.appendChild(buildCourseEntry(course, 'loose', '')));
    tree.appendChild(loose);
  }
}

function buildCourseEntry(course, semId, semesterName) {
  const wrapper = document.createElement('div');
  wrapper.className = 'course-wrapper' + (openCourses.has(course.id) ? ' course-open' : '');

  const row = document.createElement('div');
  row.className = 'course-row';
  row.innerHTML =
    '<span class="course-icon">\ud83d\udcd2</span>' +
    '<span class="course-name" title="' + escHtml(course.name) + '">' + escHtml(course.name) + '</span>' +
    '<span class="tree-item-actions">' +
      '<button class="tree-action-btn" title="Rename">\u270e</button>' +
      '<button class="tree-action-btn del" title="Delete">\u2715</button>' +
    '</span>';

  const btns = row.querySelectorAll('.tree-action-btn');
  btns[0].addEventListener('click', e => { e.stopPropagation(); renameCourse(course.id); });
  btns[1].addEventListener('click', e => { e.stopPropagation(); deleteCourse(course.id); });

  row.addEventListener('click', e => {
    if (e.target.closest('.tree-item-actions')) return;
    wrapper.classList.toggle('course-open');
    if (wrapper.classList.contains('course-open')) openCourses.add(course.id);
    else openCourses.delete(course.id);
  });

  const termList = document.createElement('div');
  termList.className = 'term-list';
  TERMS.forEach(term => {
    const isActive = activeCourseId === course.id && activeTermId === term.id;
    const tr = document.createElement('div');
    tr.className = 'term-row' + (isActive ? ' active' : '');
    tr.innerHTML =
      '<span class="term-icon">\ud83d\udcc4</span>' +
      '<span class="term-name">' + escHtml(term.name) + '</span>';
    tr.addEventListener('click', e => {
      e.stopPropagation();
      selectTerm(course.id, term.id, semId, course.name, term.name, semesterName);
      if (window.innerWidth <= 640) $('sidebar').classList.add('collapsed');
    });
    termList.appendChild(tr);
  });

  wrapper.appendChild(row);
  wrapper.appendChild(termList);
  return wrapper;
}

/* =====================================================================
   SELECT TERM & LOAD NOTES
   ===================================================================== */

async function selectTerm(courseId, termId, semId, courseName, termName, semesterName) {
  activeCourseId      = courseId;
  activeTermId        = termId;
  activeSemesterId    = semId;
  currentCourseName   = courseName;
  currentTermName     = termName;
  currentSemesterName = semesterName;

  openCourses.add(courseId);
  renderTree();

  hideEl('emptyState');
  hideEl('courseView');
  showEl('loadingState');

  try {
    const snap = await db.collection('users').doc(currentUser.uid).collection('notes')
      .where('courseId', '==', courseId)
      .where('termId',   '==', termId)
      .get();

    currentNotes = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    hideEl('loadingState');
    showCourseView();
  } catch (err) {
    console.error('Load notes failed:', err);
    hideEl('loadingState');
    showEmptyState();
  }
}

function showEmptyState() {
  hideEl('courseView');
  hideEl('loadingState');
  showEl('emptyState');
}

function showCourseView() {
  hideEl('emptyState');
  showEl('courseView');
  updateCourseViewTitle();
  renderGallery(currentNotes);
}

function updateCourseViewTitle() {
  $('courseViewTitle').textContent = currentCourseName + ' \u2013 ' + currentTermName;
  const n = currentNotes.length;
  $('courseNoteCount').textContent = n + ' note' + (n !== 1 ? 's' : '');
}

/* =====================================================================
   NOTE UPLOAD
   ===================================================================== */

$('noteUpload').addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  if (!files.length || !activeCourseId || !activeTermId) return;
  e.target.value = '';

  const startOrder = currentNotes.length;
  const batch      = db.batch();
  const newNotes   = [];

  for (let i = 0; i < files.length; i++) {
    const file    = files[i];
    const dataUrl = await compressImage(file);
    const noteId  = uid();
    const note    = {
      courseId: activeCourseId,
      termId:   activeTermId,
      name:     file.name,
      dataUrl,
      order:    startOrder + i
    };
    const ref = db.collection('users').doc(currentUser.uid).collection('notes').doc(noteId);
    batch.set(ref, note);
    newNotes.push({ id: noteId, ...note });
  }

  await batch.commit();
  currentNotes.push(...newNotes);
  updateCourseViewTitle();
  renderGallery(currentNotes);
});

/* =====================================================================
   GALLERY
   ===================================================================== */

function renderGallery(notes) {
  const gallery = $('noteGallery');
  gallery.innerHTML = '';

  if (notes.length === 0) {
    gallery.style.display = 'none';
    showEl('galleryEmpty');
    return;
  }
  hideEl('galleryEmpty');
  gallery.style.display = '';

  notes.forEach((note, idx) => gallery.appendChild(buildNoteCard(note, idx)));
}

function buildNoteCard(note, idx) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card.dataset.noteId = note.id;
  card.dataset.idx    = idx;
  card.draggable      = true;

  const img = document.createElement('img');
  img.className  = 'note-thumb';
  img.src        = note.dataUrl;
  img.alt        = note.name;
  img.title      = note.name;
  img.loading    = 'lazy';
  img.addEventListener('click', () => openLightbox(idx));

  const footer = document.createElement('div');
  footer.className = 'note-card-footer';
  footer.innerHTML =
    '<span class="note-card-name">Page ' + (idx + 1) + '</span>' +
    '<span class="note-card-actions">' +
      '<button class="note-card-btn del" title="Delete note">\ud83d\uddd1</button>' +
    '</span>';
  footer.querySelector('.del').addEventListener('click', e => {
    e.stopPropagation();
    deleteNote(note.id);
  });

  card.appendChild(img);
  card.appendChild(footer);

  // Drag-and-drop
  card.addEventListener('dragstart', e => {
    dragSrcIndex = idx;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });
  card.addEventListener('drop', async e => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (dragSrcIndex === null || dragSrcIndex === idx) return;
    await reorderNotes(dragSrcIndex, idx);
    dragSrcIndex = null;
  });

  return card;
}

/* =====================================================================
   REORDER
   ===================================================================== */

async function reorderNotes(fromIdx, toIdx) {
  const notes = [...currentNotes];
  const [moved] = notes.splice(fromIdx, 1);
  notes.splice(toIdx, 0, moved);
  notes.forEach((n, i) => { n.order = i; });
  currentNotes = notes;

  try {
    const batch = db.batch();
    notes.forEach(n => {
      const ref = db.collection('users').doc(currentUser.uid).collection('notes').doc(n.id);
      batch.update(ref, { order: n.order });
    });
    await batch.commit();
  } catch (err) {
    console.error('Reorder failed:', err);
  }
  renderGallery(currentNotes);
}

/* =====================================================================
   DELETE NOTE
   ===================================================================== */

async function deleteNote(noteId) {
  const ok = await showConfirmModal({
    title: 'Delete Note', message: 'Delete this note? This cannot be undone.'
  });
  if (!ok) return;
  try {
    await db.collection('users').doc(currentUser.uid).collection('notes').doc(noteId).delete();
    currentNotes = currentNotes.filter(n => n.id !== noteId);
    currentNotes.forEach((n, i) => { n.order = i; });
    if (currentNotes.length > 0) {
      const batch = db.batch();
      currentNotes.forEach(n => {
        const ref = db.collection('users').doc(currentUser.uid).collection('notes').doc(n.id);
        batch.update(ref, { order: n.order });
      });
      await batch.commit();
    }
    updateCourseViewTitle();
    renderGallery(currentNotes);
  } catch (err) {
    console.error('Delete note failed:', err);
  }
}

/* =====================================================================
   LIGHTBOX
   ===================================================================== */

function openLightbox(idx, notes, isShared) {
  lightboxNotes    = notes || currentNotes;
  lightboxCurrent  = idx;
  lightboxIsShared = !!isShared;
  updateLightbox();
  showEl('lightbox');
  document.body.style.overflow = 'hidden';
  if (lightboxIsShared) {
    $('lightboxReplaceLabel').style.display = 'none';
  } else {
    $('lightboxReplaceLabel').style.display = '';
  }
}

function closeLightbox() {
  hideEl('lightbox');
  document.body.style.overflow = '';
}

function updateLightbox() {
  const note = lightboxNotes[lightboxCurrent];
  if (!note) return;
  $('lightboxImg').src   = note.dataUrl;
  $('lightboxImg').title = note.name;
  $('lightboxIndex').textContent = 'Page ' + (lightboxCurrent + 1) + ' of ' + lightboxNotes.length;
  $('lightboxName').textContent  = note.name;
  $('lightboxPrev').disabled = lightboxCurrent === 0;
  $('lightboxNext').disabled = lightboxCurrent === lightboxNotes.length - 1;
}

$('lightboxClose').addEventListener('click', closeLightbox);
$('lightboxOverlay').addEventListener('click', closeLightbox);
$('lightboxPrev').addEventListener('click', () => {
  if (lightboxCurrent > 0) { lightboxCurrent--; updateLightbox(); }
});
$('lightboxNext').addEventListener('click', () => {
  if (lightboxCurrent < lightboxNotes.length - 1) { lightboxCurrent++; updateLightbox(); }
});
document.addEventListener('keydown', e => {
  if ($('lightbox').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft'  && lightboxCurrent > 0)                       { lightboxCurrent--; updateLightbox(); }
  if (e.key === 'ArrowRight' && lightboxCurrent < lightboxNotes.length - 1){ lightboxCurrent++; updateLightbox(); }
  if (e.key === 'Escape') closeLightbox();
});

/* ── Replace This Image ── */
$('lightboxReplaceInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || lightboxIsShared) return;
  e.target.value = '';
  const note = lightboxNotes[lightboxCurrent];
  if (!note) return;
  try {
    const dataUrl = await compressImage(file);
    await db.collection('users').doc(currentUser.uid).collection('notes').doc(note.id).update({ dataUrl });
    note.dataUrl = dataUrl;
    const ni = currentNotes.findIndex(n => n.id === note.id);
    if (ni >= 0) currentNotes[ni].dataUrl = dataUrl;
    $('lightboxImg').src = dataUrl;
    renderGallery(currentNotes);
  } catch (err) {
    console.error('Replace image failed:', err);
    alert('Failed to replace image. Please try again.');
  }
});

/* =====================================================================
   PDF EXPORT
   ===================================================================== */

$('exportPdfBtn').addEventListener('click', () => {
  if (currentNotes.length === 0) { alert('No notes to export.'); return; }
  openPdfModal(currentNotes);
});

function openPdfModal(notes) {
  pdfNotes = notes;
  document.querySelector('input[name="pdfMode"][value="all"]').checked = true;
  hideEl('pdfPagePicker');
  showEl('pdfModal');
}

document.querySelectorAll('input[name="pdfMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (radio.value === 'selected') {
      showEl('pdfPagePicker');
      buildPdfPageGrid();
    } else {
      hideEl('pdfPagePicker');
    }
  });
});

function buildPdfPageGrid() {
  const grid = $('pdfPageGrid');
  grid.innerHTML = '';
  pdfNotes.forEach((note, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'pdf-page-thumb selected';
    thumb.dataset.idx = idx;
    thumb.innerHTML =
      '<img src="' + note.dataUrl + '" alt="Page ' + (idx + 1) + '" />' +
      '<span>Page ' + (idx + 1) + '</span>';
    thumb.addEventListener('click', () => thumb.classList.toggle('selected'));
    grid.appendChild(thumb);
  });
}

$('pdfModalCancel').addEventListener('click', () => hideEl('pdfModal'));

$('pdfModalExport').addEventListener('click', async () => {
  const mode = document.querySelector('input[name="pdfMode"]:checked').value;
  const sizeMode = document.querySelector('input[name="pdfSize"]:checked').value; 
  
  let notesToExport = pdfNotes;
  if (mode === 'selected') {
    const selected = Array.from($('pdfPageGrid').querySelectorAll('.pdf-page-thumb.selected'))
      .map(el => parseInt(el.dataset.idx, 10))
      .sort((a, b) => a - b);
    notesToExport = selected.map(i => pdfNotes[i]);
  }
  if (notesToExport.length === 0) { alert('No pages selected.'); return; }
  hideEl('pdfModal');
  const filename = [currentCourseName, currentTermName].filter(Boolean).join(' - ') || 'notes';
  await exportToPDF(notesToExport, filename, sizeMode); 
});

async function exportToPDF(notes, filename, sizeMode) {
  const { jsPDF } = window.jspdf;
  let pdf;

  for (let i = 0; i < notes.length; i++) {
    const img = new Image();
    img.src = notes[i].dataUrl;
    await new Promise(r => { img.onload = r; if (img.complete) r(); });

    const pxToMm = 0.264583;
    const imgWidthMm = img.width * pxToMm;
    const imgHeightMm = img.height * pxToMm;

    let format;
    let orientation;

    if (sizeMode === 'original') {
      // Provide exact absolute dimensions. 
      // We MUST use 'p' here so jsPDF doesn't accidentally flip our custom dimensions.
      format = [imgWidthMm, imgHeightMm];
      orientation = 'p'; 
    } else {
      // For A4 and Letter, check if image is wide or tall to rotate the paper nicely
      format = sizeMode === 'a4' ? 'a4' : 'letter';
      orientation = imgWidthMm > imgHeightMm ? 'l' : 'p';
    }

    if (i === 0) {
      pdf = new jsPDF(orientation, 'mm', format);
    } else {
      pdf.addPage(format, orientation);
    }

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    if (sizeMode === 'original') {
      // Draw edge-to-edge
      pdf.addImage(notes[i].dataUrl, 'JPEG', 0, 0, pageWidth, pageHeight);
    } else {
      // Center on A4/Letter
      const ratio = Math.min(pageWidth / imgWidthMm, pageHeight / imgHeightMm);
      const w = imgWidthMm * ratio;
      const h = imgHeightMm * ratio;
      const x = (pageWidth - w) / 2;
      const y = (pageHeight - h) / 2;
      pdf.addImage(notes[i].dataUrl, 'JPEG', x, y, w, h);
    }
  }
  
  pdf.save(filename + '.pdf');
}
/* =====================================================================
   SHARE SYSTEM
   ===================================================================== */

$('shareBtn').addEventListener('click', openShareModal);

async function openShareModal() {
  if (!activeCourseId || !activeTermId) return;
  const shareKey    = activeCourseId + '_' + activeTermId;
  const existingCode = userData.shareLinks && userData.shareLinks[shareKey];

  $('shareModalTitle').textContent = 'Share: ' + currentCourseName + ' \u2013 ' + currentTermName;
  hideEl('shareMsg');
  hideEl('shareCopyMsg');

  if (existingCode) {
    showEl('shareExistingSection');
    hideEl('shareNewSection');
    showEl('revokeShareBtn');
    hideEl('generateShareBtn');
    $('shareLinkText').value = shareUrl(
      userData.username, currentSemesterName, currentCourseName, currentTermName, existingCode
    );
  } else {
    hideEl('shareExistingSection');
    showEl('shareNewSection');
    hideEl('revokeShareBtn');
    showEl('generateShareBtn');
  }
  showEl('shareModal');
}

$('shareModalClose').addEventListener('click', () => hideEl('shareModal'));

$('copyShareLinkBtn').addEventListener('click', async () => {
  const url = $('shareLinkText').value;
  try {
    await navigator.clipboard.writeText(url);
    setMsg($('shareCopyMsg'), 'Link copied!', true);
    setTimeout(() => hideEl('shareCopyMsg'), 2500);
  } catch (err) {
    $('shareLinkText').select();
  }
});

$('generateShareBtn').addEventListener('click', async () => {
  const shareKey = activeCourseId + '_' + activeTermId;
  const code     = genCode();
  setMsg($('shareMsg'), 'Generating share link\u2026', true);
  try {
    await db.collection('publicShares').doc(code).set({
      userId:       currentUser.uid,
      username:     userData.username,
      semesterName: currentSemesterName,
      courseName:   currentCourseName,
      termName:     currentTermName,
      courseId:     activeCourseId,
      termId:       activeTermId,
      enabled:      true,
      createdAt:    firebase.firestore.FieldValue.serverTimestamp()
    });
    // Snapshot notes
    const batch = db.batch();
    currentNotes.forEach(note => {
      const ref = db.collection('sharedNotes').doc(code + '_' + note.id);
      batch.set(ref, { dataUrl: note.dataUrl, name: note.name, order: note.order, code });
    });
    await batch.commit();

    if (!userData.shareLinks) userData.shareLinks = {};
    userData.shareLinks[shareKey] = code;
    await saveUserDataNow();

    const url = shareUrl(userData.username, currentSemesterName, currentCourseName, currentTermName, code);
    $('shareLinkText').value = url;
    showEl('shareExistingSection');
    hideEl('shareNewSection');
    showEl('revokeShareBtn');
    hideEl('generateShareBtn');
    setMsg($('shareMsg'), 'Share link created!', true);
  } catch (err) {
    console.error('Generate share failed:', err);
    setMsg($('shareMsg'), 'Failed to create share link. Please try again.', false);
  }
});

$('revokeShareBtn').addEventListener('click', async () => {
  const shareKey = activeCourseId + '_' + activeTermId;
  const code     = userData.shareLinks && userData.shareLinks[shareKey];
  if (!code) return;
  const ok = await showConfirmModal({
    title: 'Revoke Share',
    message: 'Revoke this share link? It will no longer be accessible to anyone.'
  });
  if (!ok) return;
  try {
    await db.collection('publicShares').doc(code).update({ enabled: false });
    const snap = await db.collection('sharedNotes').where('code', '==', code).get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    delete userData.shareLinks[shareKey];
    await saveUserDataNow();
    hideEl('shareModal');
  } catch (err) {
    console.error('Revoke share failed:', err);
    alert('Failed to revoke share. Please try again.');
  }
});

/* =====================================================================
   ACCOUNT SETTINGS
   ===================================================================== */

$('settingsBtn').addEventListener('click', () => {
  $('settingsUsername').value     = userData.username || '';
  $('settingsNewEmail').value     = currentUser.email || '';
  $('settingsEmailCurrPass').value = '';
  $('settingsCurrPass').value     = '';
  $('settingsNewPass').value      = '';
  $('settingsConfirmPass').value  = '';
  hideEl('settingsEmailMsg');
  hideEl('settingsPassMsg');
  showEl('settingsModal');
});

$('settingsCloseBtn').addEventListener('click', () => hideEl('settingsModal'));

$('settingsUpdateEmailBtn').addEventListener('click', async () => {
  const newEmail = $('settingsNewEmail').value.trim();
  const currPass = $('settingsEmailCurrPass').value;
  hideEl('settingsEmailMsg');
  if (!newEmail || !currPass) {
    setMsg($('settingsEmailMsg'), 'Please fill in all fields.', false); return;
  }
  try {
    const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, currPass);
    await currentUser.reauthenticateWithCredential(cred);
    await currentUser.updateEmail(newEmail);
    if (userData.username) {
      await db.collection('usernames').doc(userData.username).update({ email: newEmail });
    }
    setMsg($('settingsEmailMsg'), 'Email updated successfully!', true);
    $('settingsEmailCurrPass').value = '';
  } catch (err) {
    setMsg($('settingsEmailMsg'), friendlyAuthError(err), false);
  }
});

$('settingsUpdatePassBtn').addEventListener('click', async () => {
  const currPass    = $('settingsCurrPass').value;
  const newPass     = $('settingsNewPass').value;
  const confirmPass = $('settingsConfirmPass').value;
  hideEl('settingsPassMsg');
  if (!currPass || !newPass || !confirmPass) {
    setMsg($('settingsPassMsg'), 'Please fill in all fields.', false); return;
  }
  if (newPass.length < 6) {
    setMsg($('settingsPassMsg'), 'New password must be at least 6 characters.', false); return;
  }
  if (newPass !== confirmPass) {
    setMsg($('settingsPassMsg'), 'Passwords do not match.', false); return;
  }
  try {
    const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, currPass);
    await currentUser.reauthenticateWithCredential(cred);
    await currentUser.updatePassword(newPass);
    setMsg($('settingsPassMsg'), 'Password updated successfully!', true);
    $('settingsCurrPass').value = '';
    $('settingsNewPass').value  = '';
    $('settingsConfirmPass').value = '';
  } catch (err) {
    setMsg($('settingsPassMsg'), friendlyAuthError(err), false);
  }
});

function setMsg(el, msg, success) {
  el.textContent = msg;
  el.className   = 'form-msg' + (success ? ' form-success' : ' form-error');
  el.classList.remove('hidden');
}

/* =====================================================================
   SHARED PUBLIC VIEW
   ===================================================================== */

async function showSharedView() {
  hideEl('loginOverlay');
  hideEl('app');
  showEl('sharedView');

  const code = parseShareCode();
  if (!code) {
    hideEl('sharedLoading');
    showEl('sharedError');
    $('sharedErrorMsg').textContent = 'Invalid share link.';
    return;
  }

  showEl('sharedLoading');
  hideEl('sharedGallery');
  hideEl('sharedEmpty');
  hideEl('sharedError');

  try {
    const shareDoc = await db.collection('publicShares').doc(code).get();
    if (!shareDoc.exists || !shareDoc.data().enabled) {
      hideEl('sharedLoading');
      showEl('sharedError');
      $('sharedErrorMsg').textContent = 'This share link is no longer available.';
      return;
    }
    const shareData = shareDoc.data();
    $('sharedCourseTitle').textContent = shareData.courseName || '';
    $('sharedTermBadge').textContent   = shareData.termName   || '';
    $('sharedByLine').textContent      = shareData.username ? 'by ' + shareData.username : '';

    const notesSnap = await db.collection('sharedNotes').where('code', '==', code).get();
    const notes = notesSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    hideEl('sharedLoading');
    if (notes.length === 0) { showEl('sharedEmpty'); return; }

    const gallery = $('sharedGallery');
    gallery.innerHTML = '';
    showEl('sharedGallery');

    notes.forEach((note, idx) => {
      const card = document.createElement('div');
      card.className = 'note-card';
      card.innerHTML =
        '<img class="note-thumb" src="' + note.dataUrl + '" alt="' + escHtml(note.name) +
        '" loading="lazy" title="' + escHtml(note.name) + '" />' +
        '<div class="note-card-footer">' +
          '<span class="note-card-name">Page ' + (idx + 1) + '</span>' +
        '</div>';
      card.querySelector('img').addEventListener('click', () => openLightbox(idx, notes, true));
      gallery.appendChild(card);
    });

    // PDF export from shared view
    $('sharedExportPdfBtn').addEventListener('click', () => {
      pdfNotes = notes;
      document.querySelector('input[name="pdfMode"][value="all"]').checked = true;
      hideEl('pdfPagePicker');
      // Override filenames for shared view
      currentCourseName = shareData.courseName || 'Notes';
      currentTermName   = shareData.termName   || '';
      showEl('pdfModal');
    });

  } catch (err) {
    console.error('Shared view error:', err);
    hideEl('sharedLoading');
    showEl('sharedError');
    $('sharedErrorMsg').textContent = 'Failed to load shared notes.';
  }
}

/* =====================================================================
   MODAL HELPERS (Promise-based)
   ===================================================================== */

function showInputModal({ title, label, defaultValue = '', placeholder = '' }) {
  return new Promise(resolve => {
    $('inputModalTitle').textContent   = title;
    $('inputModalLabel').textContent   = label;
    $('inputModalField').value         = defaultValue;
    $('inputModalField').placeholder   = placeholder;
    showEl('inputModal');
    $('inputModalField').focus();

    function cleanup(result) {
      hideEl('inputModal');
      $('inputModalConfirm').removeEventListener('click', onConfirm);
      $('inputModalCancel').removeEventListener('click', onCancel);
      $('inputModalField').removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onConfirm() { cleanup($('inputModalField').value.trim()); }
    function onCancel()  { cleanup(null); }
    function onKey(e)    {
      if (e.key === 'Enter')  onConfirm();
      if (e.key === 'Escape') onCancel();
    }
    $('inputModalConfirm').addEventListener('click', onConfirm);
    $('inputModalCancel').addEventListener('click', onCancel);
    $('inputModalField').addEventListener('keydown', onKey);
  });
}

function showConfirmModal({ title, message, confirmLabel = 'Delete' }) {
  return new Promise(resolve => {
    $('confirmModalTitle').textContent   = title;
    $('confirmModalMessage').textContent = message;
    $('confirmModalConfirm').textContent = confirmLabel;
    showEl('confirmModal');

    function cleanup(result) {
      hideEl('confirmModal');
      $('confirmModalConfirm').removeEventListener('click', onConfirm);
      $('confirmModalCancel').removeEventListener('click', onCancel);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel()  { cleanup(false); }
    $('confirmModalConfirm').addEventListener('click', onConfirm);
    $('confirmModalCancel').addEventListener('click', onCancel);
  });
}

/* =====================================================================
   MODAL BACKDROP CLOSE
   ===================================================================== */

$('inputModal').addEventListener('click', e => {
  if (e.target === $('inputModal')) $('inputModalCancel').click();
});
$('confirmModal').addEventListener('click', e => {
  if (e.target === $('confirmModal')) $('confirmModalCancel').click();
});
$('settingsModal').addEventListener('click', e => {
  if (e.target === $('settingsModal')) hideEl('settingsModal');
});
$('pdfModal').addEventListener('click', e => {
  if (e.target === $('pdfModal')) hideEl('pdfModal');
});
$('shareModal').addEventListener('click', e => {
  if (e.target === $('shareModal')) hideEl('shareModal');
});
