// Applies the saved theme before first paint. Kept as a separate file so the
// Content-Security-Policy can stay `script-src 'self'` (no inline scripts).
(function () {
  try {
    var saved = localStorage.getItem('hearer.theme');
    var mode = saved === 'light' || saved === 'dark' ? saved : 'system';
    var dark =
      mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
