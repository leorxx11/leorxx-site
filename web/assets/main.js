// 入口：登录（通行密钥），画布 / 列表 / 设置 三个视图切换，深浅色
// 地址栏：#desk、#desk/<id>、#library、#library/<id>、#settings；没登录时不管地址是什么都只显示登录页

import { $, $$, api, replay, setUnauthorizedHandler, toast, transition } from './lib.js';
import { createPasskey, explain, getPasskey, supported } from './webauthn.js';
import * as desk from './desk.js';
import * as library from './library.js';
import * as settings from './settings.js';

const views = { desk, library, settings };
const started = new Set();
let current = null;
let authed = false;

function showView(name, animate) {
  document.body.dataset.view = name;
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('#tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === name ? 'page' : 'false'));
  syncTabSlider(animate);
  replay($(`#view-${name}`));
}

// 标签底下那块底色：量出当前标签的位置和宽度，交给 CSS 滑过去
function syncTabSlider(animate = false) {
  const nav = $('#tabs');
  const on = $('#tabs [aria-current="page"]');
  if (!on) return;
  nav.classList.toggle('instant', !animate);
  nav.style.setProperty('--ind-x', `${on.offsetLeft}px`);
  nav.style.setProperty('--ind-w', `${on.offsetWidth}px`);
}
document.fonts?.ready.then(() => syncTabSlider());
window.addEventListener('resize', () => syncTabSlider());

function parseHash() {
  const [raw, arg] = location.hash.slice(1).split('/');
  const name = raw === 'develop' ? 'desk' : raw;
  return name in views ? { name, arg } : { name: 'desk', arg: undefined };
}

function route() {
  if (!authed) return;
  const { name, arg } = parseHash();
  if (!started.has(name)) { started.add(name); views[name].init(); }
  if (name === current) { views[name].enter?.(arg, false); return; }
  const first = current === null;
  const prev = current;
  current = name;
  const update = () => {
    views[prev]?.leave?.();
    showView(name, !first);
    views[name].enter?.(arg, true);
    if (!first && name !== 'desk') scrollTo({ top: 0 });
  };
  if (first) { update(); return; }
  // vt-page：只在切换页面时生效的过渡样式（顶栏不动，内容淡出再浮现），深浅色切换不受影响
  const html = document.documentElement;
  html.classList.add('vt-page');
  transition(update).then(() => html.classList.remove('vt-page'));
}

window.addEventListener('hashchange', route);

// ---------- 登录 ----------
const loginErr = (msg) => { $('#login-err').textContent = msg; };
const TIPS = {
  login: '私人桌面，用通行密钥进入',
  setup: '输入初始化码，在这台设备上绑定通行密钥',
  first: '还没有绑定通行密钥。初始化码在服务器日志里（docker logs darkroom）',
};

// login：已有通行密钥；setup：在新设备上用初始化码绑定；first：一把都还没有，只能用初始化码
function setStep(step) {
  $('#gate-tip').textContent = TIPS[step];
  $('#login-passkey').hidden = step !== 'login';
  $('#setup-form').hidden = step === 'login';
  $('#back-login').hidden = step !== 'setup';
  loginErr('');
  if (step !== 'login') $('#setup-code').focus();
}

function enterApp() {
  // 登录过期后重新进来：画布和列表可能已经变了，下次进入时重新加载
  if (started.size) window.dispatchEvent(new Event('darkroom:changed'));
  authed = true;
  loginErr('');
  route();
}

function showLogin(state) {
  authed = false;
  views[current]?.leave?.();
  current = null;
  showView('login');
  if (!state) return loginErr('连不上服务器，刷新再试试');
  if (!supported()) return loginErr('这个浏览器不支持通行密钥，换个新一点的浏览器吧');
  setStep(state.hasPasskey ? 'login' : 'first');
}

// 先问服务器登录了没有：登录着就直接进，不闪登录页
async function boot() {
  let state = null;
  try { state = await api('/api/auth/state'); } catch {}
  if (state?.authed) enterApp();
  else showLogin(state);
}

// 操作期间按钮禁用，失败时把浏览器的错误翻译成人话
async function busy(btn, work) {
  btn.disabled = true;
  loginErr('');
  try { await work(); } catch (err) { loginErr(explain(err)); } finally { btn.disabled = false; }
}

$('#login-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const options = await api('/api/auth/login/options', { method: 'POST', body: {} });
  const response = await getPasskey(options);
  await api('/api/auth/login/verify', { method: 'POST', body: { response } });
  enterApp();
}));

$('#show-setup').addEventListener('click', () => setStep('setup'));
$('#back-login').addEventListener('click', () => setStep('login'));
$('#setup-code').addEventListener('input', () => loginErr(''));
$('#setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#setup-code').value.trim();
  if (!code) return loginErr('先输入初始化码');
  busy(e.currentTarget.querySelector('[type=submit]'), async () => {
    const options = await api('/api/auth/register/options', { method: 'POST', body: { setupCode: code } });
    const response = await createPasskey(options);
    await api('/api/auth/register/verify', { method: 'POST', body: { response } });
    $('#setup-code').value = '';
    toast('通行密钥已绑定', true);
    enterApp();
  });
});

// 用着用着登录失效了（在别的设备上点了「退出其他设备」等）
setUnauthorizedHandler(() => {
  if (!authed) return;
  authed = false;
  toast('登录已失效，请重新登录');
  boot();
});
window.addEventListener('darkroom:logout', boot);

// ---------- 深浅色：和主页共用 localStorage 里的 theme ----------
const root = document.documentElement;
const SUN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/></svg>';
const MOON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 9.8A5.5 5.5 0 0 1 6.2 2.8a5.5 5.5 0 1 0 7 7Z"/></svg>';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : darkQuery.matches);
function syncThemeButton() {
  const btn = $('#theme');
  btn.innerHTML = isDark() ? SUN : MOON;
  btn.setAttribute('aria-label', isDark() ? '切换到浅色' : '切换到深色');
  window.dispatchEvent(new Event('darkroom:theme'));
}
syncThemeButton();
darkQuery.addEventListener('change', syncThemeButton);
$('#theme').addEventListener('click', () => transition(() => {
  root.classList.add('switching');
  root.dataset.theme = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
  syncThemeButton();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('switching')));
}));

boot();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
