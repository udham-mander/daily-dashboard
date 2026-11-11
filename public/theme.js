// Loaded synchronously in <head>: applies the saved theme before first paint.
try {
  const theme = localStorage.getItem("dd-theme");
  if (theme && theme !== "auto") document.documentElement.dataset.theme = theme;
} catch { /* storage unavailable: follow the OS */ }
