# Notekori

A clean, personal note-storage web app hosted at **notekori.app** via GitHub Pages.

## Features

- **Login system** – Username + password authentication with persistent session (localStorage). On first visit a one-time account-setup screen lets you choose your credentials.
- **Semester folders** – Organise courses into semester folders; expand/collapse each semester in the sidebar.
- **Course management** – Add, rename, and delete courses. Courses can live inside a semester or as standalone "loose" courses.
- **Note gallery** – Click a course to open its note gallery. Upload multiple image files at once, view them in a responsive grid, rename or delete individual notes, and drag-and-drop to reorder pages.
- **Lightbox viewer** – Click any note thumbnail for a full-screen view with keyboard navigation (← → Escape).
- **Fully offline / client-side** – All data (including note images as base64) is stored in `localStorage`. No server required, compatible with GitHub Pages.

## Usage

1. Open `https://notekori.app` (or your GitHub Pages URL).
2. On first load, create your username and password.
3. Use the **Manage ▾** button in the sidebar to add semesters and courses.
4. Click a course name to open its note gallery.
5. Use **Upload Notes** to add image files (PNG, JPG, etc.).
6. Drag note cards to reorder pages; use the pencil icon to rename or the bin icon to delete.
7. Click **Logout** in the top-right to end your session.

## File Structure

```
index.html   – App shell + login overlay
styles.css   – Responsive CSS (CSS variables, flex, grid)
app.js       – SPA logic: auth, course/semester CRUD, note gallery
CNAME        – Custom domain (notekori.app)
```

## Technical notes

- **No build step required** – plain HTML/CSS/JS.
- Passwords are hashed client-side with the Web Crypto API (SHA-256) before being stored in `localStorage`.
- Note images are stored as base64 data-URLs; browser `localStorage` is typically limited to ~5 MB, so very large collections should be managed in smaller batches.
- Drag-and-drop reordering uses the native HTML5 Drag and Drop API.