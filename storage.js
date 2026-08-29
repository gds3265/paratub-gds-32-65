const DB_KEY = 'audit-bovin-v10-core';
const DRAFT_KEY = 'audit-bovin-v10-draft';

export function createEmptyDatabase() {
  return { schemaVersion: 1, farms: [], visits: [], updatedAt: new Date().toISOString() };
}

export function loadDatabase() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return createEmptyDatabase();
    const parsed = JSON.parse(raw);
    return { ...createEmptyDatabase(), ...parsed };
  } catch (error) {
    console.error('Impossible de charger la base locale', error);
    return createEmptyDatabase();
  }
}

export function saveDatabase(db) {
  db.updatedAt = new Date().toISOString();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  window.dispatchEvent(new CustomEvent('audit-bovin-db-saved', { detail: { updatedAt: db.updatedAt } }));
}

export function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
  catch { return null; }
}

export function saveDraft(draft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
}

export function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

export function replaceDatabase(nextDb) {
  const normalized = { ...createEmptyDatabase(), ...nextDb, updatedAt: new Date().toISOString() };
  localStorage.setItem(DB_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent('audit-bovin-db-saved', { detail: { updatedAt: normalized.updatedAt } }));
  return normalized;
}
