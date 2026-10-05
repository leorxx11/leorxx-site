// 入口：进门（通行密钥）+ 冲洗台 / 底片库 / 设置 三个页面的切换

import { $, $$, api, setUnauthorizedHandler, toast } from './lib.js';
import { createPasskey, explain, getPasskey, supported } from './webauthn.js';
import * as develop from './develop.js';
import * as library from './library.js';
import * as settings from './settings.js';

const views = { develop, library, settings };
const started = new Set();
let authed = false;

const showView = (name) => $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });

function route() {
  if (!authed) return;
  const hash = location.hash.slice(1);
  const name = hash in views ? hash : 'develop';
  showView(name);
  $$('#tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === name ? 'page' : 'false'));
  if (!started.has(name)) { started.add(name); views[name].init(); }
  views[name].enter?.();
}

function enterApp() {
  authed = true;
  document.body.classList.add('in-app');
  $('#tabs').hidden = false;
  $('#login-err').textContent = '';
  route();
}

// ---------- 进门 ----------
const err = (msg) => { $('#login-err').textContent = msg; };

function showSetup(firstTime) {
  $('#login-passkey').hidden = true;
  $('#setup-form').hidden = false;
  $('#back-login').hidden = firstTime;
  $('#setup-code').focus();
}

async function showLogin() {
  authed = false;
  document.body.classList.remove('in-app');
  $('#tabs').hidden = true;
  showView('login');
  err('');
  if (!supported()) { err('这个浏览器不支持通行密钥，换个新一点的浏览器吧'); return; }
  let state;
  try { state = await api('/api/auth/state'); } catch { err('连不上服务器'); return; }
  if (state.authed) return enterApp();
  if (state.hasPasskey) {
    $('#login-passkey').hidden = false;
    $('#setup-form').hidden = true;
  } else {
    showSetup(true);
  }
}

$('#login-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; err('');
  try {
    const options = await api('/api/auth/login/options', { method: 'POST', body: {} });
    const response = await getPasskey(options);
    await api('/api/auth/login/verify', { method: 'POST', body: { response } });
    enterApp();
  } catch (e2) {
    err(explain(e2));
  } finally {
    btn.disabled = false;
  }
});

$('#show-setup').addEventListener('click', () => showSetup(false));
$('#back-login button').addEventListener('click', () => {
  $('#setup-form').hidden = true;
  $('#login-passkey').hidden = false;
  err('');
});
$('#setup-code').addEventListener('input', () => err(''));

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#setup-code').value.trim();
  if (!code) { err('先输入初始化码'); return; }
  const btn = e.currentTarget.querySelector('button[type=submit]');
  btn.disabled = true; err('');
  try {
    const options = await api('/api/auth/register/options', { method: 'POST', body: { setupCode: code } });
    const response = await createPasskey(options);
    await api('/api/auth/register/verify', { method: 'POST', body: { response } });
    $('#setup-code').value = '';
    toast('通行密钥已绑定');
    enterApp();
  } catch (e2) {
    err(explain(e2));
  } finally {
    btn.disabled = false;
  }
});

setUnauthorizedHandler(() => {
  if (!authed) return;
  toast('登录过期了，请重新进门');
  showLogin();
});
window.addEventListener('darkroom:logout', showLogin);
window.addEventListener('hashchange', route);

showLogin();
