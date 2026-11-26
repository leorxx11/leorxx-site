// 在页面渲染前套用深浅色，和主页共用 localStorage 里的 theme（页面的 CSP 不允许内联脚本，所以单独一个文件）
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
