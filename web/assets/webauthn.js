// 浏览器端通行密钥：把服务器给的 JSON 参数转成 WebAuthn 需要的二进制，再把结果转回 JSON

const toBuf = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const toB64url = (buf) => {
  let bin = '';
  for (const byte of new Uint8Array(buf)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const mapCreds = (list = []) => list.map((c) => ({ ...c, id: toBuf(c.id) }));

export const supported = () => !!window.PublicKeyCredential;

// 把浏览器抛出的错误翻译成人话
export function explain(err) {
  if (err?.name === 'NotAllowedError') return '已取消，或者超时了';
  if (err?.name === 'InvalidStateError') return '这台设备上已经有一把了';
  if (err?.name === 'SecurityError') return '当前网址不能使用通行密钥';
  return err?.message || '通行密钥出错了';
}

export async function createPasskey(options) {
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBuf(options.challenge),
      user: { ...options.user, id: toBuf(options.user.id) },
      excludeCredentials: mapCreds(options.excludeCredentials),
    },
  });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
  };
}

export async function getPasskey(options) {
  const cred = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBuf(options.challenge),
      allowCredentials: mapCreds(options.allowCredentials),
    },
  });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle ? toB64url(r.userHandle) : undefined,
    },
  };
}
