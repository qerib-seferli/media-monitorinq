const KEY = 'mm-theme';
export function initTheme(){
  const saved = localStorage.getItem(KEY) || 'dark';
  document.documentElement.dataset.theme = saved;
}
export function toggleTheme(){
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(KEY,next);
}
initTheme();
