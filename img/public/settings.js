// 设置：通行密钥、登录会话、用量

import { $, api, fmtBig, fmtTime, toast } from './lib.js';
import { createPasskey, explain } from './webauthn.js';

const R2_FREE_BYTES = 10 * 1024 ** 3;

export function init() {
  $('#add-passkey').addEventListener('click', addPasskey);
  $('#logout-others').addEventListener('click', async () => {
    try {
      const r = await api('/api/auth/logout', { method: 'POST', body: { others: true } });
      toast(r.removed ? `已让其他 ${r.removed} 台设备退出` : '没有其他设备登录着');
      load();
    } catch (err) { toast(err.message); }
  });
  $('#logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
    window.dispatchEvent(new Event('darkroom:logout'));
  });
  $('#passkeys').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-delete]');
    if (!b || !confirm(`删掉「${b.dataset.name}」这把通行密钥？那台设备就不能再进门了。`)) return;
    try {
      await api(`/api/passkeys/${encodeURIComponent(b.dataset.delete)}`, { method: 'DELETE' });
      toast('已删除');
      load();
    } catch (err) { toast(err.message); }
  });
}

export function enter() { load(); }

async function load() {
  try {
    const [{ passkeys, sessions }, st] = await Promise.all([api('/api/passkeys'), api('/api/stats')]);
    const list = $('#passkeys');
    list.innerHTML = '';
    for (const p of passkeys) {
      const li = document.createElement('li');
      li.innerHTML = `<b></b><small></small><span class="spacer"></span>`;
      li.querySelector('b').textContent = p.name || '通行密钥';
      li.querySelector('small').textContent = `添加于 ${fmtTime(p.created_at)}${p.last_used_at ? ` · 最近使用 ${fmtTime(p.last_used_at)}` : ''}`;
      if (passkeys.length > 1) {
        const del = Object.assign(document.createElement('button'), { type: 'button', className: 'link danger', textContent: '删除' });
        del.dataset.delete = p.id;
        del.dataset.name = p.name || '通行密钥';
        li.append(del);
      }
      list.append(li);
    }
    $('#session-count').textContent = `现在有 ${sessions} 处登录着。`;

    const pct = Math.min(100, (st.bytes + st.trashBytes) / R2_FREE_BYTES * 100);
    $('#usage').innerHTML = `
      <div>${st.count} 张底片 · ${fmtBig(st.bytes)}${st.trashCount ? ` · 废纸篓 ${st.trashCount} 张 ${fmtBig(st.trashBytes)}` : ''}</div>
      <div class="bar"><i style="width:${pct.toFixed(2)}%"></i></div>
      <small>R2 免费额度 10 GB，已用 ${pct < 0.01 ? '不到 0.01' : pct.toFixed(2)}%（不含缩略图）</small>`;
  } catch (err) {
    toast(err.message);
  }
}

async function addPasskey() {
  try {
    const options = await api('/api/auth/register/options', { method: 'POST', body: {} });
    const response = await createPasskey(options);
    await api('/api/auth/register/verify', { method: 'POST', body: { response } });
    toast('通行密钥已添加');
    load();
  } catch (err) {
    toast(explain(err));
  }
}
